package ipc

import (
	"bytes"
	"strings"
	"testing"
)

func readAll(t *testing.T, input string) []Command {
	t.Helper()
	var got []Command
	if err := ReadLoop(strings.NewReader(input), func(c Command) {
		got = append(got, c)
	}); err != nil {
		t.Fatalf("ReadLoop returned error: %v", err)
	}
	return got
}

func TestReadLoopParsesCommandsAndSkipsMalformedAndEmptyLines(t *testing.T) {
	got := readAll(t, strings.Join([]string{
		`{"type":"init","url":"wss://x","token":"t","presentationId":"p1"}`,
		`not json at all`,
		``,
		`{"type":"play","id":2,"videoPath":"/tmp/v.h264","audioPath":null}`,
		`{"type":"play","id":3,"videoPath":"/v","audioPath":"/a.ogg"}`,
	}, "\n"))

	if len(got) != 3 {
		t.Fatalf("expected 3 commands, got %d: %+v", len(got), got)
	}
	if got[0].Type != "init" || got[0].URL != "wss://x" || got[0].Token != "t" || got[0].PresentationID != "p1" {
		t.Fatalf("init not parsed: %+v", got[0])
	}
	if got[1].Type != "play" || got[1].ID != 2 || got[1].VideoPath != "/tmp/v.h264" {
		t.Fatalf("play not parsed: %+v", got[1])
	}
	if got[1].AudioPath != nil {
		t.Fatalf("expected nil audioPath for null, got %q", *got[1].AudioPath)
	}
	if got[2].AudioPath == nil || *got[2].AudioPath != "/a.ogg" {
		t.Fatalf("audioPath string not parsed: %+v", got[2])
	}
}

func TestReadLoopParsesLongPayload(t *testing.T) {
	payload := strings.Repeat("A", 200_000)
	got := readAll(t, `{"type":"publishData","id":1,"payloadBase64":"`+payload+`"}`)

	if len(got) != 1 || got[0].PayloadBase64 != payload {
		t.Fatalf("long line not parsed")
	}
}

func TestWriterEmitsOneJSONLinePerEvent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	zero := 0

	for i, err := range []error{
		w.Send(Event{Type: "ready", RoomMetadata: `{"a":1}`}),
		w.Ack(7),
		w.Error(8, "bad-command", "nope"),
		w.Error(0, "playback-failed", "boom"),
		w.Send(Event{Type: "participantCount", Count: &zero}),
	} {
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
	}

	want := strings.Join([]string{
		`{"type":"ready","roomMetadata":"{\"a\":1}"}`,
		`{"type":"ack","id":7}`,
		`{"type":"error","id":8,"code":"bad-command","message":"nope"}`,
		`{"type":"error","code":"playback-failed","message":"boom"}`,
		`{"type":"participantCount","count":0}`,
	}, "\n") + "\n"
	if buf.String() != want {
		t.Fatalf("want %q, got %q", want, buf.String())
	}
}
