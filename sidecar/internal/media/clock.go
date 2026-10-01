// Package media plays baked H.264 and Ogg/Opus files onto the sidecar's sample tracks.
package media

import (
	"context"
	"sync"
	"time"
)

// Clock is the pacing clock shared by the streams of one playback. Pausing it holds every Wait.
type Clock struct {
	mu       sync.Mutex
	base     time.Time
	pausedAt time.Time
	paused   bool
	resumed  chan struct{}
	sleep    func(ctx context.Context, until time.Time) error
}

// NewClock returns a running clock whose pts 0 is now.
func NewClock(now time.Time) *Clock {
	return &Clock{base: now, sleep: sleepUntil}
}

func sleepUntil(ctx context.Context, until time.Time) error {
	d := time.Until(until)
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Wait blocks until base+pts, or for as long as the clock is paused; it returns ctx.Err() on cancel.
func (c *Clock) Wait(ctx context.Context, pts time.Duration) error {
	for {
		c.mu.Lock()
		if c.paused {
			resumed := c.resumed
			c.mu.Unlock()
			select {
			case <-resumed:
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		target := c.base.Add(pts)
		c.mu.Unlock()
		if err := c.sleep(ctx, target); err != nil {
			return err
		}
		c.mu.Lock()
		moved := c.paused || !c.base.Add(pts).Equal(target)
		c.mu.Unlock()
		if !moved {
			return nil
		}
	}
}

// Pause freezes the clock at now. It is a no-op while already paused.
func (c *Clock) Pause(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.paused {
		return
	}
	c.paused, c.pausedAt, c.resumed = true, now, make(chan struct{})
}

// Resume shifts the clock by the time spent paused. It is a no-op while running.
func (c *Clock) Resume(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.paused {
		return
	}
	c.base = c.base.Add(now.Sub(c.pausedAt))
	c.paused = false
	close(c.resumed)
}
