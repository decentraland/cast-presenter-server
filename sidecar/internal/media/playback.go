package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/h264reader"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
)

const (
	frameRate       = 30
	videoClockRate  = 90000
	opusSampleRate  = 48000
	videoStreamName = "video"
	audioStreamName = "audio"
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

func isVCL(t h264reader.NalUnitType) bool {
	return t == h264reader.NalUnitTypeCodedSliceIdr || t == h264reader.NalUnitTypeCodedSliceNonIdr
}

func frameTime(frame int) time.Duration {
	return time.Duration(frame) * time.Second / frameRate
}

func rtpDuration(ticks, clockRate uint64) time.Duration {
	return time.Duration((ticks*uint64(time.Second) + clockRate - 1) / clockRate)
}

var frameDuration = rtpDuration(videoClockRate/frameRate, videoClockRate)

func playVideo(ctx context.Context, w SampleWriter, in io.Reader, clock *Clock) error {
	src := &stickyErrReader{r: in}
	reader, err := h264reader.NewReader(src)
	if err != nil {
		return fmt.Errorf("%s: %w", videoStreamName, err)
	}
	for frame := 0; ; {
		nal, err := reader.NextNAL()
		if src.err != nil {
			return fmt.Errorf("%s read: %w", videoStreamName, src.err)
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%s read: %w", videoStreamName, err)
		}
		duration := time.Duration(0)
		if isVCL(nal.UnitType) {
			if clock.Wait(ctx, frameTime(frame)) != nil {
				return nil
			}
			duration = frameDuration
			frame++
		}
		if err := w.WriteSample(media.Sample{Data: nal.Data, Duration: duration}, nil); err != nil {
			return fmt.Errorf("%s write: %w", videoStreamName, err)
		}
	}
}

func playAudio(ctx context.Context, w SampleWriter, in io.Reader, clock *Clock) error {
	reader, _, err := oggreader.NewWith(in)
	if err != nil {
		return fmt.Errorf("%s: %w", audioStreamName, err)
	}
	var granule, played uint64
	for {
		payload, header, err := reader.ParseNextPage()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("%s read: %w", audioStreamName, err)
		}
		if len(payload) == 0 || header.GranulePosition <= granule {
			continue
		}
		samples := header.GranulePosition - granule
		granule = header.GranulePosition
		if clock.Wait(ctx, time.Duration(played)*time.Second/opusSampleRate) != nil {
			return nil
		}
		if err := w.WriteSample(media.Sample{Data: payload, Duration: rtpDuration(samples, opusSampleRate)}, nil); err != nil {
			return fmt.Errorf("%s write: %w", audioStreamName, err)
		}
		played += samples
	}
}
