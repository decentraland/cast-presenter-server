package media

import (
	"context"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/ipc"
)

const defaultStopTimeout = 2 * time.Second

// Engine runs at most one playback at a time onto the video and audio tracks.
type Engine struct {
	video, audio SampleWriter
	send         func(ipc.Event)
	stopTimeout  time.Duration

	mu  sync.Mutex
	cur *playback
}

type playback struct {
	cancel  context.CancelFunc
	done    chan struct{}
	clock   *Clock
	stopped atomic.Bool
}

// NewEngine returns an idle engine that reports playbackEnded and playback-failed through send.
func NewEngine(video, audio SampleWriter, send func(ipc.Event)) *Engine {
	return &Engine{video: video, audio: audio, send: send, stopTimeout: defaultStopTimeout}
}

// Play stops the current playback without playbackEnded, then plays videoPath and, when set, audioPath from the start.
func (e *Engine) Play(videoPath string, audioPath *string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.stopLocked(); err != nil {
		return err
	}
	video, err := os.Open(videoPath)
	if err != nil {
		return err
	}
	streams := []func(context.Context, *Clock) error{
		func(ctx context.Context, clock *Clock) error { return playVideo(ctx, e.video, video, clock) },
	}
	files := []io.Closer{video}
	if audioPath != nil {
		audio, err := os.Open(*audioPath)
		if err != nil {
			_ = video.Close()
			return err
		}
		streams = append(streams, func(ctx context.Context, clock *Clock) error { return playAudio(ctx, e.audio, audio, clock) })
		files = append(files, audio)
	}
	e.cur = e.start(streams, files)
	return nil
}

func (e *Engine) start(streams []func(context.Context, *Clock) error, files []io.Closer) *playback {
	ctx, cancel := context.WithCancel(context.Background())
	pb := &playback{cancel: cancel, done: make(chan struct{}), clock: NewClock(time.Now())}
	errs := make(chan error, len(streams))
	var wg sync.WaitGroup
	for i, stream := range streams {
		wg.Go(func() {
			defer files[i].Close()
			if err := stream(ctx, pb.clock); err != nil {
				errs <- err
				cancel()
			}
		})
	}
	go func() {
		wg.Wait()
		cancel()
		close(errs)
		if !pb.stopped.Load() {
			if err := <-errs; err != nil {
				e.send(ipc.Event{Type: "error", Code: "playback-failed", Message: err.Error()})
			} else {
				e.send(ipc.Event{Type: "playbackEnded"})
			}
		}
		close(pb.done)
	}()
	return pb
}

// Pause freezes the current playback. It is a no-op without one.
func (e *Engine) Pause() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cur != nil {
		e.cur.clock.Pause(time.Now())
	}
}

// Resume continues the current playback from where it paused. It is a no-op without one.
func (e *Engine) Resume() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.cur != nil {
		e.cur.clock.Resume(time.Now())
	}
}

// Stop ends the current playback without playbackEnded and waits for its writers to exit.
func (e *Engine) Stop() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stopLocked()
}

func (e *Engine) stopLocked() error {
	if e.cur == nil {
		return nil
	}
	e.cur.stopped.Store(true)
	e.cur.cancel()
	select {
	case <-e.cur.done:
		e.cur = nil
		return nil
	case <-time.After(e.stopTimeout):
		return fmt.Errorf("playback did not stop within %s", e.stopTimeout)
	}
}
