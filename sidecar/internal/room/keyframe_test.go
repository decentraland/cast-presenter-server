package room

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	protoCodecs "github.com/livekit/protocol/codecs"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	pionmedia "github.com/pion/webrtc/v4/pkg/media"
)

func annexBNALs(t *testing.T, au []byte) [][]byte {
	t.Helper()
	if !bytes.HasPrefix(au, []byte{0, 0, 0, 1}) && !bytes.HasPrefix(au, []byte{0, 0, 1}) {
		t.Fatalf("access unit does not start with an Annex-B start code: % x", au[:min(len(au), 4)])
	}
	var nals [][]byte
	for _, chunk := range bytes.Split(au, []byte{0, 0, 1}) {
		chunk = bytes.TrimRight(chunk, "\x00")
		if len(chunk) > 0 {
			nals = append(nals, chunk)
		}
	}
	return nals
}

func TestBlackKeyframeIsAConstrainedBaselineLevel40IDRAccessUnit(t *testing.T) {
	nals := annexBNALs(t, blackKeyframe)

	if len(nals) == 0 || nals[0][0]&0x1f != 7 {
		t.Fatalf("expected the first NAL to be an SPS (type 7), got %v", nalTypes(nals))
	}
	sps := nals[0]
	if len(sps) < 4 || sps[1] != 66 || sps[2]&0x40 == 0 || sps[3] != 40 {
		t.Fatalf("expected SPS profile_idc 66, constraint_set1 and level_idc 40, got % x", sps[:min(len(sps), 4)])
	}
	types := nalTypes(nals)
	if !bytes.Contains(types, []byte{8}) || !bytes.Contains(types, []byte{5}) {
		t.Fatalf("expected a PPS (type 8) and an IDR slice (type 5), got %v", types)
	}
	if len(blackKeyframe) > 8<<10 {
		t.Fatalf("expected a tiny asset, got %d bytes", len(blackKeyframe))
	}
}

func nalTypes(nals [][]byte) []byte {
	types := make([]byte, len(nals))
	for i, nal := range nals {
		types[i] = nal[0] & 0x1f
	}
	return types
}

type fakeSampleWriter struct {
	samples []pionmedia.Sample
}

func (f *fakeSampleWriter) WriteSample(sample pionmedia.Sample, _ *lksdk.SampleWriteOptions) error {
	f.samples = append(f.samples, sample)
	return nil
}

func TestWriteBlackKeyframeWritesTheAssetOnceWhenTheTrackBecomesReady(t *testing.T) {
	track := &fakeSampleWriter{}
	polls := 0
	ready := func() bool {
		polls++
		return polls >= 3
	}

	if err := writeBlackKeyframe(context.Background(), track, ready); err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(track.samples) != 1 {
		t.Fatalf("expected exactly one sample, got %d", len(track.samples))
	}
	if !bytes.Equal(track.samples[0].Data, blackKeyframe) || track.samples[0].Duration <= 0 {
		t.Fatalf("expected the embedded keyframe with a positive duration, got %d bytes, %v", len(track.samples[0].Data), track.samples[0].Duration)
	}
	if polls != 3 {
		t.Fatalf("expected to stop polling once ready, polled %d times", polls)
	}
}

func TestWriteBlackKeyframeFailsWithoutWritingWhenTheTrackNeverBecomesReady(t *testing.T) {
	track := &fakeSampleWriter{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := writeBlackKeyframe(ctx, track, func() bool { return false })

	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected a context error, got %v", err)
	}
	if len(track.samples) != 0 {
		t.Fatalf("expected no samples, got %d", len(track.samples))
	}
}

func TestPublisherCodecsSignalConstrainedBaselineLevel40AndOpus(t *testing.T) {
	var h264, opus bool
	for i := range publisherCodecs {
		params := protoCodecs.ToWebrtcCodecParameters(&publisherCodecs[i])
		switch {
		case strings.EqualFold(params.MimeType, webrtc.MimeTypeH264):
			h264 = params.SDPFmtpLine == "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028"
		case strings.EqualFold(params.MimeType, webrtc.MimeTypeOpus):
			opus = params.ClockRate == 48000 && params.Channels == 2
		}
	}

	if !h264 || !opus {
		t.Fatalf("expected H.264 42e028 and stereo Opus, got h264=%v opus=%v", h264, opus)
	}
}
