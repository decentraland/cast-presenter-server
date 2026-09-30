// Command cast-sidecar publishes the pre-encoded presentation tracks of one
// cast-presenter-server session, driven by JSON lines on stdin.
package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"sync/atomic"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/ipc"
	"github.com/decentraland/cast-presenter-server/sidecar/internal/room"
)

type Room interface {
	Metadata() string
	RemoteCount() int
	PublishData(payload []byte) error
	SetMetadata(metadata string) error
	Disconnect()
}

type ConnectFunc func(url, token, presentationID string, ev room.Events) (Room, error)

func main() {
	os.Exit(run(os.Stdin, os.Stdout, connectRoom))
}

func connectRoom(url, token, presentationID string, ev room.Events) (Room, error) {
	r, err := room.Connect(url, token, presentationID, ev)
	if err != nil {
		return nil, err
	}
	return r, nil
}

type session struct {
	out          *ipc.Writer
	lost         chan string
	shuttingDown atomic.Bool
	gate         sync.Mutex
	ready        bool
}

func run(stdin io.Reader, stdout io.Writer, connect ConnectFunc) int {
	log.SetOutput(os.Stderr)
	out := ipc.NewWriter(stdout)

	cmds := make(chan ipc.Command)
	readDone := make(chan error, 1)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		readDone <- ipc.ReadLoop(stdin, func(cmd ipc.Command) bool {
			select {
			case cmds <- cmd:
				return true
			case <-stop:
				return false
			}
		})
	}()

	var initCmd ipc.Command
	select {
	case initCmd = <-cmds:
	case err := <-readDone:
		return exitCode(err)
	}
	if initCmd.Type != "init" {
		_ = out.Error(initCmd.ID, "bad-command", "first command must be init")
		return 1
	}

	s := &session{out: out, lost: make(chan string, 1)}
	rm, err := connect(initCmd.URL, initCmd.Token, initCmd.PresentationID, s.events())
	if err != nil {
		msg := room.Redact(err.Error())
		log.Printf("connect: %s", msg)
		_ = out.Error(0, connectErrorCode(err), msg)
		return 1
	}
	s.open(rm)

	for {
		select {
		case cmd := <-cmds:
			if s.handle(rm, cmd) {
				return 0
			}
		case err := <-readDone:
			s.shutdown(rm)
			return exitCode(err)
		case reason := <-s.lost:
			log.Printf("room lost: %s", reason)
			_ = out.Send(ipc.Event{Type: "disconnected", Reason: reason})
			return 1
		}
	}
}

func exitCode(readErr error) int {
	if readErr != nil {
		log.Printf("stdin: %v", readErr)
		return 1
	}
	return 0
}

func connectErrorCode(err error) string {
	if errors.Is(err, room.ErrPublish) {
		return "publish-failed"
	}
	return "connect-failed"
}

func (s *session) events() room.Events {
	return room.Events{
		OnData: func(identity string, payload []byte) {
			s.emit(ipc.Event{Type: "dataReceived", Identity: identity, PayloadBase64: base64.StdEncoding.EncodeToString(payload)})
		},
		OnRoomMetadata: func(metadata string) {
			s.emit(ipc.Event{Type: "roomMetadata", Metadata: metadata})
		},
		OnParticipantCount: func(count int) {
			s.emit(ipc.Event{Type: "participantCount", Count: &count})
		},
		OnDisconnected: func(reason string) {
			if s.shuttingDown.Load() {
				return
			}
			select {
			case s.lost <- reason:
			default:
			}
		},
	}
}

func (s *session) emit(ev ipc.Event) {
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.ready {
		_ = s.out.Send(ev)
	}
}

func (s *session) open(rm Room) {
	s.gate.Lock()
	defer s.gate.Unlock()
	count := rm.RemoteCount()
	_ = s.out.Send(ipc.Event{Type: "ready", RoomMetadata: rm.Metadata(), ParticipantCount: &count})
	s.ready = true
}

func (s *session) shutdown(rm Room) {
	s.shuttingDown.Store(true)
	rm.Disconnect()
}

func (s *session) handle(rm Room, cmd ipc.Command) (done bool) {
	switch cmd.Type {
	case "publishData":
		payload, err := base64.StdEncoding.DecodeString(cmd.PayloadBase64)
		if err == nil {
			err = rm.PublishData(payload)
		}
		s.reply(cmd.ID, "publish-failed", err)
	case "updateMetadata":
		s.reply(cmd.ID, "publish-failed", rm.SetMetadata(cmd.Metadata))
	case "play", "pause", "resume", "stop":
		_ = s.out.Error(cmd.ID, "play-failed", "playback not implemented")
	case "shutdown":
		_ = s.out.Ack(cmd.ID)
		s.shutdown(rm)
		return true
	default:
		_ = s.out.Error(cmd.ID, "bad-command", fmt.Sprintf("unknown command %q", cmd.Type))
	}
	return false
}

func (s *session) reply(id int64, code string, err error) {
	if err != nil {
		_ = s.out.Error(id, code, room.Redact(err.Error()))
		return
	}
	_ = s.out.Ack(id)
}
