package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/room"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

const initLine = `{"type":"init","url":"wss://lk.example","token":"tok-example123","presentationId":"p1"}`

type fakeRoom struct {
	mu          sync.Mutex
	ev          room.Events
	metadata    string
	count       int
	published   [][]byte
	metadataSet []string
	disconnects int
	publishErr  error
	setErr      error
	onDisc      func(ev room.Events)
	onConnect   func(ev room.Events)
}

func (f *fakeRoom) Metadata() string { return f.metadata }
func (f *fakeRoom) RemoteCount() int { return f.count }

func (f *fakeRoom) VideoTrack() *lksdk.LocalSampleTrack {
	return unboundTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000})
}

func (f *fakeRoom) AudioTrack() *lksdk.LocalSampleTrack {
	return unboundTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2})
}

func unboundTrack(codec webrtc.RTPCodecCapability) *lksdk.LocalSampleTrack {
	track, err := lksdk.NewLocalSampleTrack(codec)
	if err != nil {
		panic(err)
	}
	return track
}

func (f *fakeRoom) PublishData(b []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.published = append(f.published, b)
	return f.publishErr
}

func (f *fakeRoom) SetMetadata(m string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.metadataSet = append(f.metadataSet, m)
	return f.setErr
}

func (f *fakeRoom) Disconnect() {
	f.mu.Lock()
	f.disconnects++
	f.mu.Unlock()
	if f.onDisc != nil {
		f.onDisc(f.ev)
	}
}

func (f *fakeRoom) disconnectCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.disconnects
}

type connectCall struct {
	url, token, presentationID string
}

func fakeConnect(f *fakeRoom, err error, calls *[]connectCall) ConnectFunc {
	return func(url, token, presentationID string, ev room.Events) (Room, error) {
		if calls != nil {
			*calls = append(*calls, connectCall{url, token, presentationID})
		}
		if err != nil {
			return nil, err
		}
		f.ev = ev
		if f.onConnect != nil {
			f.onConnect(ev)
		}
		return f, nil
	}
}

func decodeLines(t *testing.T, out string) []map[string]any {
	t.Helper()
	var events []map[string]any
	for _, line := range strings.Split(strings.TrimSuffix(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("stdout line is not JSON: %q", line)
		}
		events = append(events, ev)
	}
	return events
}

func runLines(t *testing.T, f *fakeRoom, lines ...string) (int, []map[string]any, string) {
	t.Helper()
	var out bytes.Buffer
	code := run(strings.NewReader(strings.Join(lines, "\n")), &out, fakeConnect(f, nil, nil))
	return code, decodeLines(t, out.String()), out.String()
}

func TestRunStartupOutcomes(t *testing.T) {
	for _, tc := range []struct {
		name        string
		stdin       string
		connectErr  error
		wantCode    int
		wantErrCode string
		wantConnect int
	}{
		{name: "empty stdin", stdin: "", wantCode: 0},
		{
			name:        "first line is not init",
			stdin:       `{"type":"publishData","id":1}` + "\n" + initLine,
			wantCode:    1,
			wantErrCode: "bad-command",
		},
		{
			name:        "connect fails",
			stdin:       initLine,
			connectErr:  fmt.Errorf("%w: dial wss://lk.example/rtc?access_token=secret&auto_subscribe=0", room.ErrConnect),
			wantCode:    1,
			wantErrCode: "connect-failed",
			wantConnect: 1,
		},
		{
			name:        "publishing on init fails",
			stdin:       initLine,
			connectErr:  fmt.Errorf("%w: permission denied", room.ErrPublish),
			wantCode:    1,
			wantErrCode: "publish-failed",
			wantConnect: 1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			var calls []connectCall

			code := run(strings.NewReader(tc.stdin), &out, fakeConnect(&fakeRoom{}, tc.connectErr, &calls))

			if code != tc.wantCode {
				t.Fatalf("expected exit %d, got %d", tc.wantCode, code)
			}
			events := decodeLines(t, out.String())
			if tc.wantErrCode == "" {
				if len(events) != 0 {
					t.Fatalf("expected no stdout, got %q", out.String())
				}
			} else if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != tc.wantErrCode {
				t.Fatalf("expected one %s error, got %v", tc.wantErrCode, events)
			}
			if len(calls) != tc.wantConnect {
				t.Fatalf("expected %d connects, got %d", tc.wantConnect, len(calls))
			}
			if strings.Contains(out.String(), "secret") {
				t.Fatalf("stdout leaked the token: %s", out.String())
			}
			if tc.connectErr != nil && errors.Is(tc.connectErr, room.ErrConnect) &&
				!strings.Contains(out.String(), "access_token=REDACTED") {
				t.Fatalf("expected a redacted token in the message, got %s", out.String())
			}
		})
	}
}

func TestRunPassesInitFieldsToConnect(t *testing.T) {
	var out bytes.Buffer
	var calls []connectCall

	run(strings.NewReader(initLine), &out, fakeConnect(&fakeRoom{}, nil, &calls))

	want := connectCall{"wss://lk.example", "tok-example123", "p1"}
	if len(calls) != 1 || calls[0] != want {
		t.Fatalf("expected connect %+v, got %+v", want, calls)
	}
}

func TestRunAcksUpdateMetadataAndShutdown(t *testing.T) {
	f := &fakeRoom{metadata: `{"presenters":["0xabc"]}`, count: 2}

	code, events, raw := runLines(t, f,
		initLine,
		`{"type":"updateMetadata","id":2,"metadata":"{\"role\":\"presentation\"}"}`,
		`{"type":"shutdown","id":3}`,
		`{"type":"updateMetadata","id":4,"metadata":"late"}`,
	)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %s", raw)
	}
	if events[0]["type"] != "ready" || events[0]["roomMetadata"] != f.metadata || events[0]["participantCount"] != float64(2) {
		t.Fatalf("unexpected ready: %v", events[0])
	}
	if events[1]["type"] != "ack" || events[1]["id"] != float64(2) {
		t.Fatalf("expected ack 2, got %v", events[1])
	}
	if events[2]["type"] != "ack" || events[2]["id"] != float64(3) {
		t.Fatalf("expected ack 3, got %v", events[2])
	}
	if len(f.metadataSet) != 1 || f.metadataSet[0] != `{"role":"presentation"}` {
		t.Fatalf("expected metadata to be set once, got %v", f.metadataSet)
	}
	if f.disconnectCount() != 1 {
		t.Fatalf("expected one disconnect, got %d", f.disconnectCount())
	}
	if strings.Contains(raw, "tok-example123") {
		t.Fatalf("stdout leaked the token: %s", raw)
	}
}

func TestRunDropsRoomEventsBeforeReady(t *testing.T) {
	f := &fakeRoom{count: 5, onConnect: func(ev room.Events) {
		ev.OnParticipantCount(5)
		ev.OnRoomMetadata("{}")
		ev.OnData("0xabc", []byte("early"))
	}}

	_, events, raw := runLines(t, f, initLine)

	if len(events) != 1 || events[0]["type"] != "ready" || events[0]["participantCount"] != float64(5) {
		t.Fatalf("expected only ready, got %s", raw)
	}
}

func TestRunPublishesDecodedData(t *testing.T) {
	f := &fakeRoom{}

	_, events, raw := runLines(t, f, initLine, `{"type":"publishData","id":5,"payloadBase64":"aGVsbG8="}`)

	if len(events) != 2 || events[1]["type"] != "ack" || events[1]["id"] != float64(5) {
		t.Fatalf("expected ack 5, got %s", raw)
	}
	if len(f.published) != 1 || string(f.published[0]) != "hello" {
		t.Fatalf("expected decoded payload, got %q", f.published)
	}
}

func TestRunReportsPublishDataErrors(t *testing.T) {
	f := &fakeRoom{publishErr: errors.New("closed")}

	_, events, raw := runLines(t, f, initLine,
		`{"type":"publishData","id":6,"payloadBase64":"!!!"}`,
		`{"type":"publishData","id":7,"payloadBase64":"aGVsbG8="}`,
	)

	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %s", raw)
	}
	for i, id := range []float64{6, 7} {
		ev := events[i+1]
		if ev["type"] != "error" || ev["code"] != "publish-failed" || ev["id"] != id {
			t.Fatalf("expected publish-failed for id %v, got %v", id, ev)
		}
	}
	if len(f.published) != 1 {
		t.Fatalf("expected only the valid payload to be published, got %d", len(f.published))
	}
}

func TestRunReportsUpdateMetadataErrors(t *testing.T) {
	f := &fakeRoom{setErr: errors.New("denied")}

	_, events, raw := runLines(t, f, initLine, `{"type":"updateMetadata","id":8,"metadata":"{}"}`)

	if len(events) != 2 || events[1]["code"] != "publish-failed" || events[1]["id"] != float64(8) {
		t.Fatalf("expected publish-failed for id 8, got %s", raw)
	}
}

func TestRunAnswersPlayFailedForAMissingFile(t *testing.T) {
	missing, _ := json.Marshal(filepath.Join(t.TempDir(), "missing.h264"))

	_, events, raw := runLines(t, &fakeRoom{}, initLine,
		fmt.Sprintf(`{"type":"play","id":10,"videoPath":%s,"audioPath":null}`, missing),
	)

	if len(events) != 2 || events[1]["type"] != "error" || events[1]["code"] != "play-failed" || events[1]["id"] != float64(10) {
		t.Fatalf("expected play-failed for id 10, got %s", raw)
	}
}

func TestRunAcksPauseResumeAndStopWithoutPlayback(t *testing.T) {
	_, events, raw := runLines(t, &fakeRoom{}, initLine,
		`{"type":"pause","id":11}`,
		`{"type":"resume","id":12}`,
		`{"type":"stop","id":13}`,
	)

	if len(events) != 4 {
		t.Fatalf("expected 4 events, got %s", raw)
	}
	for i, id := range []float64{11, 12, 13} {
		if ev := events[i+1]; ev["type"] != "ack" || ev["id"] != id {
			t.Fatalf("expected ack for id %v, got %v", id, ev)
		}
	}
}

func TestRunPlaysABakedFileToItsEnd(t *testing.T) {
	s := startHarness(t, &fakeRoom{})

	s.send(t, playLine(t, 20, 3))

	if ev := s.next(t); ev["type"] != "ack" || ev["id"] != float64(20) {
		t.Fatalf("expected ack 20, got %v", ev)
	}
	if ev := s.next(t); ev["type"] != "playbackEnded" {
		t.Fatalf("expected playbackEnded, got %v", ev)
	}
	s.send(t, `{"type":"shutdown","id":21}`)
	if ev := s.next(t); ev["type"] != "ack" || ev["id"] != float64(21) {
		t.Fatalf("expected ack 21, got %v", ev)
	}
	if code := s.exitCode(t); code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
}

func TestRunShutdownStopsAPlaybackWithoutPlaybackEnded(t *testing.T) {
	f := &fakeRoom{}
	s := startHarness(t, f)
	s.send(t, playLine(t, 30, 300))
	if ev := s.next(t); ev["type"] != "ack" || ev["id"] != float64(30) {
		t.Fatalf("expected ack 30, got %v", ev)
	}

	s.send(t, `{"type":"shutdown","id":31}`)

	if ev := s.next(t); ev["type"] != "ack" || ev["id"] != float64(31) {
		t.Fatalf("expected ack 31, got %v", ev)
	}
	if code := s.exitCode(t); code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if ev, ok := <-s.lines; ok {
		t.Fatalf("expected no event after the shutdown ack, got %v", ev)
	}
	if f.disconnectCount() != 1 {
		t.Fatalf("expected one disconnect, got %d", f.disconnectCount())
	}
}

func playLine(t *testing.T, id, frames int) string {
	t.Helper()
	stream := []byte{0, 0, 0, 1, 0x67, 1, 0, 0, 0, 1, 0x68, 1}
	for i := 0; i < frames; i++ {
		stream = append(stream, 0, 0, 0, 1, 0x65, 1, 2, 3)
	}
	path := filepath.Join(t.TempDir(), "bake.h264")
	if err := os.WriteFile(path, stream, 0o600); err != nil {
		t.Fatal(err)
	}
	quoted, _ := json.Marshal(path)
	return fmt.Sprintf(`{"type":"play","id":%d,"videoPath":%s,"audioPath":null}`, id, quoted)
}

func TestRunRejectsUnknownCommands(t *testing.T) {
	_, events, raw := runLines(t, &fakeRoom{}, initLine, `{"type":"seek","id":14}`, `{"type":"init","id":15}`)

	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %s", raw)
	}
	for i, id := range []float64{14, 15} {
		ev := events[i+1]
		if ev["type"] != "error" || ev["code"] != "bad-command" || ev["id"] != id {
			t.Fatalf("expected bad-command for id %v, got %v", id, ev)
		}
	}
}

func TestRunDisconnectsOnStdinEOFAfterInit(t *testing.T) {
	f := &fakeRoom{}

	code, _, raw := runLines(t, f, initLine)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if f.disconnectCount() != 1 {
		t.Fatalf("expected one disconnect, got %d", f.disconnectCount())
	}
	if !strings.Contains(raw, `"participantCount":0`) {
		t.Fatalf("expected participantCount 0 in ready, got %s", raw)
	}
}

func TestRunDoesNotReportSelfInitiatedDisconnects(t *testing.T) {
	f := &fakeRoom{onDisc: func(ev room.Events) { ev.OnDisconnected("CLIENT_INITIATED") }}

	code, events, raw := runLines(t, f, initLine, `{"type":"shutdown","id":3}`)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	for _, ev := range events {
		if ev["type"] == "disconnected" {
			t.Fatalf("self-initiated disconnect was reported: %s", raw)
		}
	}
}

type harness struct {
	stdin  *io.PipeWriter
	lines  chan map[string]any
	result chan int
}

func startHarness(t *testing.T, f *fakeRoom) *harness {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	s := &harness{stdin: inW, lines: make(chan map[string]any, 16), result: make(chan int, 1)}
	go func() {
		s.result <- run(inR, outW, fakeConnect(f, nil, nil))
		_ = outW.Close()
	}()
	go func() {
		sc := bufio.NewScanner(outR)
		for sc.Scan() {
			var ev map[string]any
			if err := json.Unmarshal(sc.Bytes(), &ev); err == nil {
				s.lines <- ev
			}
		}
		close(s.lines)
	}()
	t.Cleanup(func() { _ = inW.Close() })
	s.send(t, initLine)
	if ev := s.next(t); ev["type"] != "ready" {
		t.Fatalf("expected ready, got %v", ev)
	}
	return s
}

func (s *harness) send(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
}

func (s *harness) next(t *testing.T) map[string]any {
	t.Helper()
	select {
	case ev, ok := <-s.lines:
		if !ok {
			t.Fatal("stdout closed")
		}
		return ev
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for an event")
	}
	return nil
}

func (s *harness) exitCode(t *testing.T) int {
	t.Helper()
	select {
	case code := <-s.result:
		return code
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for run to return")
	}
	return -1
}

func TestRunForwardsRoomEvents(t *testing.T) {
	f := &fakeRoom{}
	s := startHarness(t, f)

	f.ev.OnData("0xabc", []byte("hello"))
	if ev := s.next(t); ev["type"] != "dataReceived" || ev["identity"] != "0xabc" || ev["payloadBase64"] != "aGVsbG8=" {
		t.Fatalf("unexpected dataReceived: %v", ev)
	}

	f.ev.OnRoomMetadata(`{"presenters":[]}`)
	if ev := s.next(t); ev["type"] != "roomMetadata" || ev["metadata"] != `{"presenters":[]}` {
		t.Fatalf("unexpected roomMetadata: %v", ev)
	}

	f.ev.OnParticipantCount(0)
	if ev := s.next(t); ev["type"] != "participantCount" || ev["count"] != float64(0) {
		t.Fatalf("unexpected participantCount: %v", ev)
	}

	s.send(t, `{"type":"shutdown","id":9}`)
	if ev := s.next(t); ev["type"] != "ack" || ev["id"] != float64(9) {
		t.Fatalf("expected ack 9, got %v", ev)
	}
	if code := s.exitCode(t); code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
}

func TestRunExitsOneWhenTheRoomIsLost(t *testing.T) {
	f := &fakeRoom{}
	s := startHarness(t, f)

	f.ev.OnDisconnected("SIGNAL_CLOSED")

	if ev := s.next(t); ev["type"] != "disconnected" || ev["reason"] != "SIGNAL_CLOSED" {
		t.Fatalf("unexpected event: %v", ev)
	}
	if code := s.exitCode(t); code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
}
