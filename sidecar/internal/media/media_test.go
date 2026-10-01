package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/ipc"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
)

const frame = time.Second / 30

var (
	t0      = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	errBoom = errors.New("boom")
)

type write struct {
	size     int
	duration time.Duration
}

type fakeWriter struct {
	mu     sync.Mutex
	writes []write
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

type sleepLog struct {
	mu      sync.Mutex
	targets []time.Time
}

func recordSleeps(c *Clock) *sleepLog {
	l := &sleepLog{}
	c.sleep = func(ctx context.Context, until time.Time) error {
		l.mu.Lock()
		l.targets = append(l.targets, until)
		l.mu.Unlock()
		return ctx.Err()
	}
	return l
}

func (l *sleepLog) offsets() []time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]time.Duration, len(l.targets))
	for i, target := range l.targets {
		out[i] = target.Sub(t0)
	}
	return out
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

func oggStream(t *testing.T, timestamps ...uint32) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := oggwriter.NewWith(&buf, 48000, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, ts := range timestamps {
		if err := w.WriteRTP(&rtp.Packet{Header: rtp.Header{Timestamp: ts}, Payload: []byte{0xfc, 1, 2, 3}}); err != nil {
			t.Fatal(err)
		}
	}
	return buf.Bytes()
}

func longAudio(t *testing.T, pages int) []byte {
	t.Helper()
	ts := make([]uint32, pages+1)
	for i := range ts {
		ts[i] = uint32(i * 960)
	}
	return oggStream(t, ts...)
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func ptr(s string) *string { return &s }

func TestClockWaitTargetsBasePlusPTS(t *testing.T) {
	c := NewClock(t0)
	sleeps := recordSleeps(c)

	for _, pts := range []time.Duration{0, frame} {
		if err := c.Wait(context.Background(), pts); err != nil {
			t.Fatal(err)
		}
	}

	if got := sleeps.offsets(); len(got) != 2 || got[0] != 0 || got[1] != frame {
		t.Fatalf("expected targets [0 %v], got %v", frame, got)
	}
}

func TestClockResumeShiftsTheNextTargetByThePausedTime(t *testing.T) {
	c := NewClock(t0)
	sleeps := recordSleeps(c)
	_ = c.Wait(context.Background(), frame)

	c.Pause(t0.Add(frame))
	c.Resume(t0.Add(frame + 5*time.Second))
	if err := c.Wait(context.Background(), 2*frame); err != nil {
		t.Fatal(err)
	}

	if got := sleeps.offsets(); got[len(got)-1] != 5*time.Second+2*frame {
		t.Fatalf("expected the next target shifted by 5s, got %v", got)
	}
}

func TestClockRepeatedPauseAndResumeAreNoOps(t *testing.T) {
	c := NewClock(t0)
	sleeps := recordSleeps(c)

	c.Resume(t0.Add(time.Hour))
	c.Pause(t0.Add(time.Second))
	c.Pause(t0.Add(2 * time.Second))
	c.Resume(t0.Add(4 * time.Second))
	c.Resume(t0.Add(9 * time.Second))
	_ = c.Wait(context.Background(), 0)

	if got := sleeps.offsets(); len(got) != 1 || got[0] != 3*time.Second {
		t.Fatalf("expected one target at 3s, got %v", got)
	}
}

func TestClockWaitBlocksWhilePaused(t *testing.T) {
	c := NewClock(t0)
	recordSleeps(c)
	c.Pause(t0)
	returned := make(chan error, 1)

	go func() { returned <- c.Wait(context.Background(), 0) }()

	select {
	case <-returned:
		t.Fatal("Wait returned while paused")
	case <-time.After(50 * time.Millisecond):
	}
	c.Resume(t0.Add(time.Second))
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
	c := NewClock(t0)
	recordSleeps(c)
	c.Pause(t0)
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

func TestClockPauseDuringASleepHoldsTheWaitUntilResume(t *testing.T) {
	c := NewClock(t0)
	var mu sync.Mutex
	var targets []time.Time
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	c.sleep = func(ctx context.Context, until time.Time) error {
		mu.Lock()
		targets = append(targets, until)
		first := len(targets) == 1
		mu.Unlock()
		entered <- struct{}{}
		if first {
			<-release
		}
		return nil
	}
	returned := make(chan error, 1)

	go func() { returned <- c.Wait(context.Background(), frame) }()
	<-entered
	c.Pause(t0)
	close(release)

	select {
	case <-returned:
		t.Fatal("Wait returned although the clock was paused during its sleep")
	case <-time.After(50 * time.Millisecond):
	}
	c.Resume(t0.Add(time.Second))
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("Wait did not return after Resume")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(targets) != 2 || targets[1].Sub(t0) != time.Second+frame {
		t.Fatalf("expected a second sleep shifted by 1s, got %v", targets)
	}
}

func TestPlayVideoPacesVCLAndWritesParameterSetsImmediately(t *testing.T) {
	c := NewClock(t0)
	sleeps := recordSleeps(c)
	w := &fakeWriter{}
	stream := annexB(nal(0x67, 4), nal(0x68, 5), nal(0x65, 20), nal(0x41, 10), nal(0x41, 11))

	if err := playVideo(context.Background(), w, bytes.NewReader(stream), c); err != nil {
		t.Fatal(err)
	}

	want := []write{{4, 0}, {5, 0}, {20, frame}, {10, frame}, {11, frame}}
	if got := w.snapshot(); !equalWrites(got, want) {
		t.Fatalf("expected writes %v, got %v", want, got)
	}
	if got := sleeps.offsets(); len(got) != 3 || got[0] != 0 || got[1] != frame || got[2] != 2*frame {
		t.Fatalf("expected waits at 0, %v, %v, got %v", frame, 2*frame, got)
	}
}

func TestPlayVideoReturnsNilWhenCancelled(t *testing.T) {
	c := NewClock(t0)
	recordSleeps(c)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := playVideo(ctx, &fakeWriter{}, bytes.NewReader(longVideo(10, 8)), c); err != nil {
		t.Fatalf("expected nil on cancel, got %v", err)
	}
}

func TestPlayVideoReportsAMidStreamReadError(t *testing.T) {
	c := NewClock(t0)
	recordSleeps(c)
	in := io.MultiReader(bytes.NewReader(longVideo(3, 8)), iotest.ErrReader(errBoom))

	if err := playVideo(context.Background(), &fakeWriter{}, in, c); !errors.Is(err, errBoom) {
		t.Fatalf("expected the read error, got %v", err)
	}
}

func TestPlayVideoReportsAWriteError(t *testing.T) {
	c := NewClock(t0)
	recordSleeps(c)

	if err := playVideo(context.Background(), &fakeWriter{failAt: 3}, bytes.NewReader(longVideo(3, 8)), c); !errors.Is(err, errBoom) {
		t.Fatalf("expected the write error, got %v", err)
	}
}

func TestPlayAudioUsesGranuleDeltasAndSkipsHeaderPages(t *testing.T) {
	c := NewClock(t0)
	sleeps := recordSleeps(c)
	w := &fakeWriter{}

	if err := playAudio(context.Background(), w, bytes.NewReader(oggStream(t, 0, 960, 2880)), c); err != nil {
		t.Fatal(err)
	}

	want := []write{{4, 20 * time.Millisecond}, {4, 40 * time.Millisecond}}
	if got := w.snapshot(); !equalWrites(got, want) {
		t.Fatalf("expected writes %v, got %v", want, got)
	}
	if got := sleeps.offsets(); len(got) != 2 || got[0] != 0 || got[1] != 20*time.Millisecond {
		t.Fatalf("expected waits at 0 and 20ms, got %v", got)
	}
}

func TestPlayAudioReportsATruncatedPage(t *testing.T) {
	c := NewClock(t0)
	recordSleeps(c)
	stream := longAudio(t, 3)

	if err := playAudio(context.Background(), &fakeWriter{}, bytes.NewReader(stream[:len(stream)-2]), c); err == nil {
		t.Fatal("expected an error for a truncated page")
	}
}

func equalWrites(a, b []write) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
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
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(3, 8))
	audio := writeFile(t, "a.ogg", longAudio(t, 3))

	if err := h.engine.Play(video, &audio); err != nil {
		t.Fatal(err)
	}

	if ev := h.next(t); ev.Type != "playbackEnded" {
		t.Fatalf("expected playbackEnded, got %+v", ev)
	}
	h.quiet(t)
	if h.video.count() != 5 || h.audio.count() != 3 {
		t.Fatalf("expected 5 video and 3 audio writes, got %d and %d", h.video.count(), h.audio.count())
	}
	if err := h.engine.Stop(); err != nil {
		t.Fatal(err)
	}
	h.quiet(t)
}

func TestEngineStopSuppressesPlaybackEndedAndHaltsWriting(t *testing.T) {
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(300, 8))
	audio := writeFile(t, "a.ogg", longAudio(t, 500))
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
	audio := writeFile(t, "a.ogg", longAudio(t, 500))

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

func TestEngineWithoutAudioPlaysVideoOnly(t *testing.T) {
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(3, 8))

	if err := h.engine.Play(video, nil); err != nil {
		t.Fatal(err)
	}

	if ev := h.next(t); ev.Type != "playbackEnded" {
		t.Fatalf("expected playbackEnded, got %+v", ev)
	}
	if h.audio.count() != 0 {
		t.Fatalf("expected a silent audio track, got %d writes", h.audio.count())
	}
}

func TestEnginePauseHoldsWritesUntilResume(t *testing.T) {
	h := newEngineHarness()
	video := writeFile(t, "v.h264", longVideo(300, 8))
	if err := h.engine.Play(video, ptr(writeFile(t, "a.ogg", longAudio(t, 500)))); err != nil {
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
