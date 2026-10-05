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
}

// NewClock returns a running clock whose pts 0 is now.
func NewClock(now time.Time) *Clock {
	return &Clock{base: now}
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
		d := time.Until(c.base.Add(pts))
		c.mu.Unlock()
		if d <= 0 {
			return ctx.Err()
		}
		select {
		case <-time.After(d):
		case <-ctx.Done():
			return ctx.Err()
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
