package ipc

import (
	"bytes"
	"strings"
	"testing"
)

func readAll(t *testing.T, input string) []Command {
	t.Helper()
	var got []Command
	if err := ReadLoop(strings.NewReader(input), func(c Command) bool {
		got = append(got, c)
		return true
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
	}, "\n"))

	if len(got) != 2 {
		t.Fatalf("expected 2 commands, got %d: %+v", len(got), got)
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
}

func TestReadLoopParsesAudioPathString(t *testing.T) {
	got := readAll(t, `{"type":"play","id":3,"videoPath":"/v","audioPath":"/a.ogg"}`)

	if len(got) != 1 || got[0].AudioPath == nil || *got[0].AudioPath != "/a.ogg" {
		t.Fatalf("audioPath not parsed: %+v", got)
	}
}

func TestReadLoopParsesLongPayload(t *testing.T) {
	payload := strings.Repeat("A", 200_000)
	got := readAll(t, `{"type":"publishData","id":1,"payloadBase64":"`+payload+`"}`)

	if len(got) != 1 || got[0].PayloadBase64 != payload {
		t.Fatalf("long line not parsed")
	}
}

func TestReadLoopStopsWhenHandleReturnsFalse(t *testing.T) {
	var got []Command
	err := ReadLoop(strings.NewReader("{\"type\":\"a\"}\n{\"type\":\"b\"}\n"), func(c Command) bool {
		got = append(got, c)
		return false
	})
	if err != nil {
		t.Fatalf("ReadLoop returned error: %v", err)
	}
	if len(got) != 1 || got[0].Type != "a" {
		t.Fatalf("expected to stop after first command, got %+v", got)
	}
}

func TestWriterEmitsOneJSONLinePerEvent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	if err := w.Send(Event{Type: "ready", RoomMetadata: `{"a":1}`}); err != nil {
		t.Fatal(err)
	}
	if err := w.Ack(7); err != nil {
		t.Fatal(err)
	}
	if err := w.Error(8, "bad-command", "nope"); err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	want := []string{
		`{"type":"ready","roomMetadata":"{\"a\":1}"}`,
		`{"type":"ack","id":7}`,
		`{"type":"error","id":8,"code":"bad-command","message":"nope"}`,
	}
	if len(lines) != len(want) {
		t.Fatalf("expected %d lines, got %d: %q", len(want), len(lines), buf.String())
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Fatalf("line %d: want %s, got %s", i, want[i], lines[i])
		}
	}
}

func TestWriterErrorWithZeroIDIsUnsolicited(t *testing.T) {
	var buf bytes.Buffer
	if err := NewWriter(&buf).Error(0, "playback-failed", "boom"); err != nil {
		t.Fatal(err)
	}

	if strings.Contains(buf.String(), `"id"`) {
		t.Fatalf("unsolicited error must not carry an id: %s", buf.String())
	}
}

func TestEventSerialisesZeroCount(t *testing.T) {
	var buf bytes.Buffer
	zero := 0
	if err := NewWriter(&buf).Send(Event{Type: "participantCount", Count: &zero}); err != nil {
		t.Fatal(err)
	}

	if !strings.Contains(buf.String(), `"count":0`) {
		t.Fatalf("expected count 0 to be serialised, got %s", buf.String())
	}
}
