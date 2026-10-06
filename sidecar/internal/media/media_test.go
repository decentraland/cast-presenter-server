package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/ipc"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

var errBoom = errors.New("boom")

type write struct {
	size     int
	duration time.Duration
}

type fakeWriter struct {
	mu     sync.Mutex
	writes []write
	at     []time.Time
	failAt int
	block  chan struct{}
}

func (f *fakeWriter) WriteSample(s media.Sample, _ *lksdk.SampleWriteOptions) error {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAt > 0 && len(f.writes)+1 == f.failAt {
		return errBoom
	}
	f.writes = append(f.writes, write{len(s.Data), s.Duration})
	f.at = append(f.at, time.Now())
	return nil
}

func (f *fakeWriter) snapshot() []write {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]write(nil), f.writes...)
}

func (f *fakeWriter) count() int {
	return len(f.snapshot())
}

func nal(header byte, size int) []byte {
	out := []byte{0, 0, 0, 1, header}
	for i := 1; i < size; i++ {
		out = append(out, byte(i))
	}
	return out
}

func annexB(nals ...[]byte) []byte {
	return bytes.Join(nals, nil)
}

func longVideo(frames, size int) []byte {
	nals := [][]byte{nal(0x67, 4), nal(0x68, 4)}
	for i := 0; i < frames; i++ {
		header := byte(0x41)
		if i%60 == 0 {
			header = 0x65
		}
		nals = append(nals, nal(header, size))
	}
	return annexB(nals...)
}

func oggPage(headerType byte, granule uint64, seq uint32, payload []byte) []byte {
	page := []byte("OggS")
	page = append(page, 0, headerType)
	page = binary.LittleEndian.AppendUint64(page, granule)
	page = binary.LittleEndian.AppendUint32(page, 7)
	page = binary.LittleEndian.AppendUint32(page, seq)
	page = append(page, 0, 0, 0, 0, 1, byte(len(payload)))
	page = append(page, payload...)
	binary.LittleEndian.PutUint32(page[22:], oggCRC(page))
	return page
}

func oggCRC(b []byte) uint32 {
	var crc uint32
	for _, v := range b {
		crc ^= uint32(v) << 24
		for range 8 {
			if crc&0x80000000 != 0 {
				crc = crc<<1 ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func oggStream(packets int) []byte {
	head := append([]byte("OpusHead"), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0)
	stream := oggPage(2, 0, 0, head)
	stream = append(stream, oggPage(0, 0, 1, append([]byte("OpusTags"), 0, 0, 0, 0, 0, 0, 0, 0))...)
	for i := range packets {
		stream = append(stream, oggPage(0, uint64(i+1)*960, uint32(i+2), []byte{0xfc, 1, 2, 3})...)
	}
	return stream
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClockResumeShiftsTheClockByThePausedTime(t *testing.T) {
	start := time.Now()
	c := NewClock(start)

	c.Pause(start)
	c.Pause(start.Add(time.Hour))
	c.Resume(start.Add(60 * time.Millisecond))
	c.Resume(start.Add(time.Hour))

	if err := c.Wait(context.Background(), 0); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed < 60*time.Millisecond {
		t.Fatalf("expected the wait held until 60ms, it returned after %v", elapsed)
	}
}

func TestClockWaitBlocksWhilePaused(t *testing.T) {
	start := time.Now()
	c := NewClock(start)
	c.Pause(start)
	returned := make(chan error, 1)

	go func() { returned <- c.Wait(context.Background(), 0) }()

	select {
	case <-returned:
		t.Fatal("Wait returned while paused")
	case <-time.After(50 * time.Millisecond):
	}
	c.Resume(time.Now())
	select {
	case err := <-returned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not return after Resume")
	}
}

func TestClockWaitReturnsTheContextErrorWhenCancelledWhilePaused(t *testing.T) {
	c := NewClock(time.Now())
	c.Pause(time.Now())
	ctx, cancel := context.WithCancel(context.Background())
	returned := make(chan error, 1)

	go func() { returned <- c.Wait(ctx, 0) }()
	cancel()

	select {
	case err := <-returned:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not return after cancel")
	}
}

func TestClockPauseDuringAWaitHoldsItUntilResume(t *testing.T) {
	start := time.Now()
	c := NewClock(start)
	returned := make(chan error, 1)

	go func() { returned <- c.Wait(context.Background(), 50*time.Millisecond) }()
	time.Sleep(10 * time.Millisecond)
	c.Pause(time.Now())

	select {
	case <-returned:
		t.Fatal("Wait returned although the clock was paused during its sleep")
	case <-time.After(100 * time.Millisecond):
	}
	c.Resume(time.Now())
	select {
	case err := <-returned:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Wait did not return after Resume")
	}
}

func TestStreamPacesVCLNALsAndWritesParameterSetsImmediately(t *testing.T) {
	w := &fakeWriter{}
	in := annexB(nal(0x67, 4), nal(0x68, 5), nal(0x65, 20), nal(0x67, 6), nal(0x68, 7), nal(0x41, 10))
	start := time.Now()

	if err := playVideo(context.Background(), w, bytes.NewReader(in), NewClock(start)); err != nil {
		t.Fatal(err)
	}

	want := []write{{4, 0}, {5, 0}, {20, frameDuration}, {6, 0}, {7, 0}, {10, frameDuration}}
	if got := w.snapshot(); !slices.Equal(got, want) {
		t.Fatalf("expected writes %v, got %v", want, got)
	}
	if offset := w.at[4].Sub(start); offset > frameDuration/2 {
		t.Fatalf("expected the mid-stream parameter sets written without pacing, got %v", offset)
	}
	if offset := w.at[5].Sub(start); offset < frameDuration {
		t.Fatalf("expected the second frame paced one frame in, got %v", offset)
	}
}

func TestStreamWritesOneSamplePerOpusPacket(t *testing.T) {
	w := &fakeWriter{}

	if err := playAudio(context.Background(), w, bytes.NewReader(oggStream(3)), NewClock(time.Now())); err != nil {
		t.Fatal(err)
	}

	want := []write{{4, 20 * time.Millisecond}, {4, 20 * time.Millisecond}, {4, 20 * time.Millisecond}}
	if got := w.snapshot(); !slices.Equal(got, want) {
		t.Fatalf("expected writes %v, got %v", want, got)
	}
}

func TestStreamEndsOnCancelAndReportsReadAndWriteErrors(t *testing.T) {
	truncated := oggStream(3)
	for _, tc := range []struct {
		name    string
		play    func(context.Context, SampleWriter, io.Reader, *Clock) error
		in      io.Reader
		w       *fakeWriter
		cancel  bool
		wantErr error
	}{
		{"cancelled", playVideo, bytes.NewReader(longVideo(10, 8)), &fakeWriter{}, true, nil},
		{"video read error", playVideo, io.MultiReader(bytes.NewReader(longVideo(3, 8)), iotest.ErrReader(errBoom)), &fakeWriter{}, false, errBoom},
		{"video write error", playVideo, bytes.NewReader(longVideo(3, 8)), &fakeWriter{failAt: 3}, false, errBoom},
		{"truncated audio page", playAudio, bytes.NewReader(truncated[:len(truncated)-2]), &fakeWriter{}, false, io.ErrUnexpectedEOF},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.cancel {
				cancel()
			}

			if err := tc.play(ctx, tc.w, tc.in, NewClock(time.Now())); !errors.Is(err, tc.wantErr) {
				t.Fatalf("expected %v, got %v", tc.wantErr, err)
			}
		})
	}
}

type engineHarness struct {
	video, audio *fakeWriter
	events       chan ipc.Event
	engine       *Engine
}

func newEngineHarness() *engineHarness {
	h := &engineHarness{video: &fakeWriter{}, audio: &fakeWriter{}, events: make(chan ipc.Event, 8)}
	h.engine = NewEngine(h.video, h.audio, func(ev ipc.Event) { h.events <- ev })
	return h
}

func (h *engineHarness) next(t *testing.T) ipc.Event {
	t.Helper()
	select {
	case ev := <-h.events:
		return ev
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for an engine event")
	}
	return ipc.Event{}
}

func (h *engineHarness) quiet(t *testing.T) {
	t.Helper()
	select {
	case ev := <-h.events:
		t.Fatalf("unexpected event %+v", ev)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestEngineSendsOnePlaybackEndedAtNaturalEOF(t *testing.T) {
	for _, tc := range []struct {
		name      string
		withAudio bool
		wantAudio int
	}{
		{"with audio", true, 3},
		{"without audio", false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newEngineHarness()
			var audio *string
			if tc.withAudio {
				path := writeFile(t, "a.ogg", oggStream(3))
				audio = &path
			}

			if err := h.engine.Play(writeFile(t, "v.h264", longVideo(3, 8)), audio); err != nil {
				t.Fatal(err)
			}

			if ev := h.next(t); ev.Type != "playbackEnded" {
				t.Fatalf("expected playbackEnded, got %+v", ev)
			}
			h.quiet(t)
			if h.video.count() != 5 || h.audio.count() != tc.wantAudio {
				t.Fatalf("expected 5 video and %d audio writes, got %d and %d", tc.wantAudio, h.video.count(), h.audio.count())
			}
			if err := h.engine.Stop(); err != nil {
				t.Fatal(err)
			}
			h.quiet(t)
		})
	}
}

func TestEngineStopSuppressesPlaybackEndedAndHaltsWriting(t *testing.T) {
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(300, 8))
	audio := writeFile(t, "a.ogg", oggStream(500))
	if err := h.engine.Play(video, &audio); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)

	if err := h.engine.Stop(); err != nil {
		t.Fatal(err)
	}

	written := h.video.count() + h.audio.count()
	h.quiet(t)
	if after := h.video.count() + h.audio.count(); after != written {
		t.Fatalf("expected no writes after Stop, got %d more", after-written)
	}
}

func TestEnginePlayReplacesTheCurrentPlaybackWithoutPlaybackEnded(t *testing.T) {
	h := newEngineHarness()
	first := writeFile(t, "first.h264", longVideo(300, 8))
	second := writeFile(t, "second.h264", longVideo(3, 77))
	if err := h.engine.Play(first, nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)

	if err := h.engine.Play(second, nil); err != nil {
		t.Fatal(err)
	}

	if ev := h.next(t); ev.Type != "playbackEnded" {
		t.Fatalf("expected one playbackEnded for the second playback, got %+v", ev)
	}
	h.quiet(t)
	sizes := h.video.snapshot()
	tail := sizes[len(sizes)-3:]
	for _, w := range tail {
		if w.size != 77 {
			t.Fatalf("expected the second playback's frames last, got %v", tail)
		}
	}
}

func TestEnginePlayRejectsMissingFilesWithoutStartingAnything(t *testing.T) {
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(3, 8))
	missing := filepath.Join(t.TempDir(), "missing")

	if err := h.engine.Play(missing, nil); err == nil {
		t.Fatal("expected an error for a missing video")
	}
	if err := h.engine.Play(video, &missing); err == nil {
		t.Fatal("expected an error for a missing audio")
	}

	h.quiet(t)
	if h.video.count() != 0 || h.audio.count() != 0 {
		t.Fatalf("expected no writes, got %d video and %d audio", h.video.count(), h.audio.count())
	}
}

func TestEngineVideoWriteErrorStopsAudioAndReportsPlaybackFailedOnce(t *testing.T) {
	h := newEngineHarness()
	h.video.failAt = 3
	video := writeFile(t, "v.h264", longVideo(300, 8))
	audio := writeFile(t, "a.ogg", oggStream(500))

	if err := h.engine.Play(video, &audio); err != nil {
		t.Fatal(err)
	}

	ev := h.next(t)
	if ev.Type != "error" || ev.Code != "playback-failed" || ev.ID != 0 || !strings.Contains(ev.Message, "boom") {
		t.Fatalf("expected one unsolicited playback-failed, got %+v", ev)
	}
	h.quiet(t)
	written := h.audio.count()
	time.Sleep(100 * time.Millisecond)
	if h.audio.count() != written {
		t.Fatal("expected the audio goroutine to stop with the video error")
	}
}

func TestEnginePauseHoldsWritesUntilResume(t *testing.T) {
	h := newEngineHarness()
	audio := writeFile(t, "a.ogg", oggStream(500))
	if err := h.engine.Play(writeFile(t, "v.h264", longVideo(300, 8)), &audio); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)

	h.engine.Pause()
	h.engine.Pause()
	time.Sleep(20 * time.Millisecond)
	paused := h.video.count() + h.audio.count()
	time.Sleep(150 * time.Millisecond)
	if now := h.video.count() + h.audio.count(); now != paused {
		t.Fatalf("expected no writes while paused, got %d more", now-paused)
	}
	h.engine.Resume()
	h.engine.Resume()
	time.Sleep(150 * time.Millisecond)
	if h.video.count()+h.audio.count() <= paused {
		t.Fatal("expected writes to continue after Resume")
	}

	if err := h.engine.Stop(); err != nil {
		t.Fatal(err)
	}
	h.quiet(t)
}

func TestEnginePauseResumeAndStopWithoutPlaybackAreNoOps(t *testing.T) {
	h := newEngineHarness()

	h.engine.Resume()
	h.engine.Pause()
	if err := h.engine.Stop(); err != nil {
		t.Fatal(err)
	}
	h.engine.Pause()

	h.quiet(t)
}

func TestEngineStopTimesOutOnAStuckWriterAndPlayRefusesToStartAnother(t *testing.T) {
	h := newEngineHarness()
	h.engine.stopTimeout = 50 * time.Millisecond
	h.video.block = make(chan struct{})
	defer close(h.video.block)
	stuck := writeFile(t, "v.h264", longVideo(3, 8))
	if err := h.engine.Play(stuck, nil); err != nil {
		t.Fatal(err)
	}

	if err := h.engine.Stop(); err == nil {
		t.Fatal("expected Stop to time out")
	}
	if err := h.engine.Play(stuck, nil); err == nil {
		t.Fatal("expected Play to fail while the old writer still runs")
	}
}
