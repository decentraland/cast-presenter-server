package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/livekit/server-sdk-go/v2/pkg/oggreader"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
)

const (
	frameRate      = 30
	videoClockRate = 90000
)

// SampleWriter is the part of *lksdk.LocalSampleTrack that playback writes to.
type SampleWriter interface {
	WriteSample(sample media.Sample, opts *lksdk.SampleWriteOptions) error
}

type stickyErrReader struct {
	r   io.Reader
	err error
}

func (s *stickyErrReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		s.err = err
	}
	return n, err
}

func rtpDuration(ticks, clockRate uint64) time.Duration {
	return time.Duration((ticks*uint64(time.Second) + clockRate - 1) / clockRate)
}

var frameDuration = rtpDuration(videoClockRate/frameRate, videoClockRate)

func stream(ctx context.Context, w SampleWriter, clock *Clock, next func() (media.Sample, error)) error {
	var pts time.Duration
	for {
		sample, err := next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}
		if sample.Duration > 0 {
			if clock.Wait(ctx, pts) != nil {
				return nil
			}
			pts += sample.Duration
		}
		if err := w.WriteSample(sample, nil); err != nil {
			return fmt.Errorf("write: %w", err)
		}
	}
}

func playVideo(ctx context.Context, w SampleWriter, in io.Reader, clock *Clock) error {
	src := &stickyErrReader{r: in}
	reader, err := h264reader.NewReader(src)
	if err != nil {
		return err
	}
	return stream(ctx, w, clock, func() (media.Sample, error) {
		nal, err := reader.NextNAL()
		if src.err != nil {
			return media.Sample{}, src.err
		}
		if err != nil {
			return media.Sample{}, err
		}
		if nal.UnitType == h264reader.NalUnitTypeCodedSliceIdr || nal.UnitType == h264reader.NalUnitTypeCodedSliceNonIdr {
			return media.Sample{Data: nal.Data, Duration: frameDuration}, nil
		}
		return media.Sample{Data: nal.Data}, nil
	})
}

func playAudio(ctx context.Context, w SampleWriter, in io.Reader, clock *Clock) error {
	reader, _, err := oggreader.NewOggReader(in)
	if err != nil {
		return err
	}
	return stream(ctx, w, clock, func() (media.Sample, error) {
		packet, err := reader.ReadPacket()
		if err != nil {
			return media.Sample{}, err
		}
		duration, err := oggreader.ParsePacketDuration(packet)
		return media.Sample{Data: packet, Duration: duration}, err
	})
}
