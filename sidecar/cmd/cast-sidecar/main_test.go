package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/room"
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
}

func (f *fakeRoom) Metadata() string { return f.metadata }
func (f *fakeRoom) RemoteCount() int { return f.count }

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

func TestRunReturnsZeroWithoutOutputOnEmptyStdin(t *testing.T) {
	var out bytes.Buffer
	var calls []connectCall

	code := run(strings.NewReader(""), &out, fakeConnect(&fakeRoom{}, nil, &calls))

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if out.Len() != 0 {
		t.Fatalf("expected empty stdout, got %q", out.String())
	}
	if len(calls) != 0 {
		t.Fatalf("expected no connect, got %d", len(calls))
	}
}

func TestRunRejectsAFirstLineThatIsNotInit(t *testing.T) {
	var out bytes.Buffer
	var calls []connectCall

	code := run(strings.NewReader(`{"type":"publishData","id":1}`+"\n"+initLine), &out, fakeConnect(&fakeRoom{}, nil, &calls))

	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	events := decodeLines(t, out.String())
	if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != "bad-command" {
		t.Fatalf("expected one bad-command error, got %v", events)
	}
	if len(calls) != 0 {
		t.Fatalf("expected no connect, got %d", len(calls))
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

func TestRunReportsConnectFailureWithoutLeakingTheToken(t *testing.T) {
	var out bytes.Buffer
	connectErr := fmt.Errorf("%w: dial wss://lk.example/rtc?access_token=secret&auto_subscribe=0", room.ErrConnect)

	code := run(strings.NewReader(initLine), &out, fakeConnect(nil, connectErr, nil))

	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	events := decodeLines(t, out.String())
	if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != "connect-failed" {
		t.Fatalf("expected one connect-failed error, got %v", events)
	}
	if strings.Contains(out.String(), "secret") {
		t.Fatalf("stdout leaked the token: %s", out.String())
	}
	if !strings.Contains(out.String(), "access_token=REDACTED") {
		t.Fatalf("expected a redacted token in the message, got %s", out.String())
	}
}

func TestRunReportsPublishFailureOnInit(t *testing.T) {
	var out bytes.Buffer

	code := run(strings.NewReader(initLine), &out, fakeConnect(nil, fmt.Errorf("%w: permission denied", room.ErrPublish), nil))

	if code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
	events := decodeLines(t, out.String())
	if len(events) != 1 || events[0]["code"] != "publish-failed" {
		t.Fatalf("expected one publish-failed error, got %v", events)
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

func TestRunReadySerialisesZeroParticipants(t *testing.T) {
	_, _, raw := runLines(t, &fakeRoom{}, initLine)

	if !strings.Contains(raw, `"participantCount":0`) {
		t.Fatalf("expected participantCount 0 in ready, got %s", raw)
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

func TestRunRejectsPlaybackCommandsUntilImplemented(t *testing.T) {
	_, events, raw := runLines(t, &fakeRoom{}, initLine,
		`{"type":"play","id":10,"videoPath":"/v","audioPath":null}`,
		`{"type":"pause","id":11}`,
		`{"type":"resume","id":12}`,
		`{"type":"stop","id":13}`,
	)

	if len(events) != 5 {
		t.Fatalf("expected 5 events, got %s", raw)
	}
	for i, id := range []float64{10, 11, 12, 13} {
		ev := events[i+1]
		if ev["type"] != "error" || ev["code"] != "play-failed" || ev["message"] != "playback not implemented" || ev["id"] != id {
			t.Fatalf("expected play-failed for id %v, got %v", id, ev)
		}
	}
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

	code, _, _ := runLines(t, f, initLine)

	if code != 0 {
		t.Fatalf("expected exit 0, got %d", code)
	}
	if f.disconnectCount() != 1 {
		t.Fatalf("expected one disconnect, got %d", f.disconnectCount())
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

type session struct {
	stdin  *io.PipeWriter
	lines  chan map[string]any
	result chan int
}

func startSession(t *testing.T, f *fakeRoom) *session {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	s := &session{stdin: inW, lines: make(chan map[string]any, 16), result: make(chan int, 1)}
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

func (s *session) send(t *testing.T, line string) {
	t.Helper()
	if _, err := io.WriteString(s.stdin, line+"\n"); err != nil {
		t.Fatalf("write stdin: %v", err)
	}
}

func (s *session) next(t *testing.T) map[string]any {
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

func (s *session) exitCode(t *testing.T) int {
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
	s := startSession(t, f)

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
	s := startSession(t, f)

	f.ev.OnDisconnected("SIGNAL_CLOSED")

	if ev := s.next(t); ev["type"] != "disconnected" || ev["reason"] != "SIGNAL_CLOSED" {
		t.Fatalf("unexpected event: %v", ev)
	}
	if code := s.exitCode(t); code != 1 {
		t.Fatalf("expected exit 1, got %d", code)
	}
}
