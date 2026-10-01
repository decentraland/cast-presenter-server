// Package room owns the sidecar's LiveKit connection and its two playback tracks.
package room

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
)

const (
	connectTimeout = 20 * time.Second
	streamName     = "presentation"
	videoTrackName = "presentation-video"
	audioTrackName = "presentation-audio"
	h264Fmtp       = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e028"
)

var (
	// ErrConnect marks a failure to join the room.
	ErrConnect = errors.New("connect failed")
	// ErrPublish marks a failure to publish a track, a data packet or metadata.
	ErrPublish = errors.New("publish failed")
)

var publisherCodecs = []livekit.Codec{
	{Mime: webrtc.MimeTypeH264, FmtpLine: h264Fmtp},
	{Mime: webrtc.MimeTypeOpus},
}

var accessTokenParam = regexp.MustCompile(`access_token=[^&\s]+`)

// Redact replaces every access_token value in s.
func Redact(s string) string {
	return accessTokenParam.ReplaceAllString(s, "access_token=REDACTED")
}

func wrap(kind, err error) error {
	return fmt.Errorf("%w: %s", kind, Redact(err.Error()))
}

// Events receives room notifications. Every field must be set.
type Events struct {
	OnData             func(identity string, payload []byte)
	OnRoomMetadata     func(metadata string)
	OnParticipantCount func(count int)
	OnDisconnected     func(reason string)
}

// Room is a joined LiveKit room with presentation-video and presentation-audio published.
type Room struct {
	lk     *lksdk.Room
	video  *lksdk.LocalSampleTrack
	audio  *lksdk.LocalSampleTrack
	notify sync.Mutex
}

type botMetadata struct {
	Role           string `json:"role"`
	PresentationID string `json:"presentationId"`
}

// Connect joins the room, sets the bot metadata, publishes both playback tracks and
// writes one black keyframe to presentation-video so the SFU lists it before the first play.
func Connect(url, token, presentationID string, ev Events) (*Room, error) {
	r := &Room{}
	r.lk = lksdk.NewRoom(&lksdk.RoomCallback{
		OnRoomMetadataChanged: func(string) {
			r.serialized(func() { ev.OnRoomMetadata(r.Metadata()) })
		},
		OnParticipantConnected: func(*lksdk.RemoteParticipant) {
			r.serialized(func() { ev.OnParticipantCount(r.RemoteCount()) })
		},
		OnParticipantDisconnected: func(*lksdk.RemoteParticipant) {
			r.serialized(func() { ev.OnParticipantCount(r.RemoteCount()) })
		},
		OnDisconnectedWithReason: func(reason lksdk.DisconnectionReason) {
			ev.OnDisconnected(string(reason))
		},
		ParticipantCallback: lksdk.ParticipantCallback{
			OnDataPacket: func(data lksdk.DataPacket, params lksdk.DataReceiveParams) {
				if user, ok := data.(*lksdk.UserDataPacket); ok {
					ev.OnData(params.SenderIdentity, user.Payload)
				}
			},
		},
	})

	ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	if err := r.lk.JoinWithContextAndToken(ctx, url, token, lksdk.WithAutoSubscribe(false), lksdk.WithCodecs(publisherCodecs)); err != nil {
		return nil, wrap(ErrConnect, err)
	}

	metadata, err := json.Marshal(botMetadata{Role: "presentation", PresentationID: presentationID})
	if err != nil {
		r.lk.Disconnect()
		return nil, wrap(ErrPublish, err)
	}
	if err := r.SetMetadata(string(metadata)); err != nil {
		r.lk.Disconnect()
		return nil, err
	}
	if err := r.publishPlaybackTracks(ctx); err != nil {
		r.lk.Disconnect()
		return nil, wrap(ErrPublish, err)
	}
	return r, nil
}

func (r *Room) serialized(notify func()) {
	r.notify.Lock()
	defer r.notify.Unlock()
	notify()
}

func (r *Room) publishPlaybackTracks(ctx context.Context) error {
	video, err := r.publish(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeH264,
		ClockRate: 90000,
	}, videoTrackName, livekit.TrackSource_SCREEN_SHARE)
	if err != nil {
		return err
	}
	audio, err := r.publish(webrtc.RTPCodecCapability{
		MimeType:  webrtc.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	}, audioTrackName, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	if err != nil {
		return err
	}
	if err := writeBlackKeyframe(ctx, video, func() bool { return video.IsBound() && r.publisherSRTPReady() }); err != nil {
		return fmt.Errorf("%s keyframe: %w", videoTrackName, err)
	}
	r.video, r.audio = video, audio
	return nil
}

func (r *Room) publisherSRTPReady() bool {
	pc := r.lk.LocalParticipant.GetPublisherPeerConnection()
	return pc != nil && pc.SCTP().Transport().State() == webrtc.DTLSTransportStateConnected
}

func (r *Room) publish(codec webrtc.RTPCodecCapability, name string, source livekit.TrackSource) (*lksdk.LocalSampleTrack, error) {
	track, err := lksdk.NewLocalSampleTrack(codec)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if _, err := r.lk.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   name,
		Source: source,
		Stream: streamName,
	}); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	return track, nil
}

// Metadata returns the current room metadata.
func (r *Room) Metadata() string {
	return r.lk.Metadata()
}

// RemoteCount returns the number of remote participants.
func (r *Room) RemoteCount() int {
	return len(r.lk.GetRemoteParticipants())
}

// VideoTrack returns the published presentation-video track.
func (r *Room) VideoTrack() *lksdk.LocalSampleTrack {
	return r.video
}

// AudioTrack returns the published presentation-audio track.
func (r *Room) AudioTrack() *lksdk.LocalSampleTrack {
	return r.audio
}

// PublishData sends payload to the room as a reliable user packet.
func (r *Room) PublishData(payload []byte) error {
	if err := r.lk.LocalParticipant.PublishDataPacket(lksdk.UserData(payload), lksdk.WithDataPublishReliable(true)); err != nil {
		return wrap(ErrPublish, err)
	}
	return nil
}

// SetMetadata replaces the bot participant metadata. It fails only when the room is not connected.
func (r *Room) SetMetadata(metadata string) error {
	if state := r.lk.ConnectionState(); state != lksdk.ConnectionStateConnected {
		return fmt.Errorf("%w: room is %s", ErrPublish, state)
	}
	r.lk.LocalParticipant.SetMetadata(metadata)
	return nil
}

// Disconnect leaves the room.
func (r *Room) Disconnect() {
	r.lk.Disconnect()
}
