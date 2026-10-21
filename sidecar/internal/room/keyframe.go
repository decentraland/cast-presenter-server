package room

import (
	"context"
	_ "embed"
	"time"

	"github.com/decentraland/cast-presenter-server/sidecar/internal/media"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
)

const (
	frameDuration = time.Second / 30
	readyPoll     = 10 * time.Millisecond
)

//go:embed black-keyframe.h264
var blackKeyframe []byte

func writeBlackKeyframe(ctx context.Context, track media.SampleWriter, ready func() bool) error {
	ticker := time.NewTicker(readyPoll)
	defer ticker.Stop()
	for !ready() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	return track.WriteSample(pionmedia.Sample{Data: blackKeyframe, Duration: frameDuration}, nil)
}
