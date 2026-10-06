package room

import (
	"context"
	_ "embed"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	frameDuration = time.Second / 30
	readyPoll     = 10 * time.Millisecond
)

//go:embed black-keyframe.h264
var blackKeyframe []byte

type sampleWriter interface {
	WriteSample(sample media.Sample, opts *lksdk.SampleWriteOptions) error
}

func writeBlackKeyframe(ctx context.Context, track sampleWriter, ready func() bool) error {
	ticker := time.NewTicker(readyPoll)
	defer ticker.Stop()
	for !ready() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
	return track.WriteSample(media.Sample{Data: blackKeyframe, Duration: frameDuration}, nil)
}
