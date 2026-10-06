import { AudioSource, LocalAudioTrack, Room, TrackPublishOptions } from '@livekit/rtc-node'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { createLiveKitPublisherComponent } from '../../src/adapters/livekit-publisher/component'
import type { ILiveKitPublisher } from '../../src/adapters/livekit-publisher/types'

// Hoisted by ts-jest above the imports. Required because the real
// @livekit/rtc-node loads a native addon that jest cannot instantiate
// in a unit-test environment.
jest.mock('@livekit/rtc-node', () => ({
  Room: jest.fn(),
  RoomEvent: { RoomMetadataChanged: 'roomMetadataChanged', DataReceived: 'dataReceived' },
  VideoSource: jest.fn(),
  LocalVideoTrack: { createVideoTrack: jest.fn() },
  AudioSource: jest.fn(),
  LocalAudioTrack: { createAudioTrack: jest.fn() },
  TrackPublishOptions: jest.fn(),
  TrackSource: { SOURCE_SCREENSHARE: 'SOURCE_SCREENSHARE', SOURCE_SCREENSHARE_AUDIO: 'SOURCE_SCREENSHARE_AUDIO' },
  VideoBufferType: { RGBA: 0, I420: 5 },
  VideoCodec: { H264: 'H264', VP8: 'VP8' },
  VideoFrame: jest.fn(),
  AudioFrame: jest.fn()
}))

const RoomMock = Room as unknown as jest.Mock

function createLogger(): ILoggerComponent.ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
  }
}

interface FakeRoom {
  connect: jest.Mock
  disconnect: jest.Mock
  on: jest.Mock
  localParticipant: { updateMetadata: jest.Mock; publishTrack?: jest.Mock } | null
  metadata: string | undefined
  remoteParticipants: Map<string, unknown>
}

function installFakeRoom(overrides: Partial<FakeRoom> = {}): FakeRoom {
  const room: FakeRoom = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    localParticipant: {
      updateMetadata: jest.fn().mockResolvedValue(undefined),
      publishTrack: jest.fn().mockResolvedValue(undefined)
    },
    metadata: undefined,
    remoteParticipants: new Map(),
    ...overrides
  }
  RoomMock.mockImplementation(() => room)
  return room
}

function noop(): void {
  /* used to swallow expected rejections in tests */
}

describe('when the LiveKit publisher connects', () => {
  let publisher: ILiveKitPublisher

  beforeEach(() => {
    RoomMock.mockReset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('and the remote end responds promptly', () => {
    let room: FakeRoom

    beforeEach(async () => {
      room = installFakeRoom()
      publisher = createLiveKitPublisherComponent().createPublisher('p-1', createLogger())
      await publisher.connect('wss://lk.example.com', 'tok')
    })

    it('should call room.connect with the URL and token', () => {
      expect(room.connect).toHaveBeenCalledWith('wss://lk.example.com', 'tok')
    })

    it('should not call room.disconnect on success', () => {
      expect(room.disconnect).not.toHaveBeenCalled()
    })
  })

  describe('and the remote end never responds', () => {
    let room: FakeRoom
    let connectPromise: Promise<void>

    beforeEach(() => {
      // Pending promise that never resolves — simulates a hung LiveKit server.
      room = installFakeRoom({ connect: jest.fn().mockReturnValue(new Promise<void>(noop)) })
      publisher = createLiveKitPublisherComponent().createPublisher('p-1', createLogger())
      connectPromise = publisher.connect('wss://lk.example.com', 'tok')
      // Swallow the eventual rejection so Node doesn't treat it as unhandled
      // while fake timers are still advancing.
      connectPromise.catch(noop)
    })

    it('should reject with a timeout error after the connect timeout elapses', async () => {
      jest.advanceTimersByTime(20_000)
      await expect(connectPromise).rejects.toThrow(/timed out/)
    })

    it('should call disconnect on the stale room so inFlightCreations releases', async () => {
      jest.advanceTimersByTime(20_000)
      await connectPromise.catch(noop)
      expect(room.disconnect).toHaveBeenCalled()
    })
  })

  describe('and room.connect rejects immediately', () => {
    let room: FakeRoom
    let connectPromise: Promise<void>

    beforeEach(() => {
      room = installFakeRoom({ connect: jest.fn().mockRejectedValue(new Error('token rejected')) })
      publisher = createLiveKitPublisherComponent().createPublisher('p-1', createLogger())
      connectPromise = publisher.connect('wss://lk.example.com', 'bad-tok')
      connectPromise.catch(noop)
    })

    it('should propagate the original error', async () => {
      await expect(connectPromise).rejects.toThrow('token rejected')
    })

    it('should still call disconnect for cleanup', async () => {
      await connectPromise.catch(noop)
      expect(room.disconnect).toHaveBeenCalled()
    })
  })
})

describe('when audio start races with a pending stop', () => {
  beforeEach(() => {
    RoomMock.mockReset()
  })

  it("preserves the new track's refs when the old stop's close resolves after the new start", async () => {
    installFakeRoom()

    // Each new source/track is recorded so we can probe them after the race.
    const sources: Array<{ captureFrame: jest.Mock }> = []
    const tracks: Array<{ close: jest.Mock; resolveClose: () => void }> = []
    ;(AudioSource as unknown as jest.Mock).mockImplementation(() => {
      const source = { captureFrame: jest.fn().mockResolvedValue(undefined) }
      sources.push(source)
      return source
    })
    ;(LocalAudioTrack.createAudioTrack as unknown as jest.Mock).mockImplementation(() => {
      let resolveClose!: () => void
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve
      })
      const track = { close: jest.fn().mockReturnValue(closePromise), resolveClose }
      tracks.push(track)
      return track
    })

    const publisher = createLiveKitPublisherComponent().createPublisher('p-1', createLogger())
    await publisher.connect('wss://lk.example.com', 'tok')

    await publisher.startAudioPublishing(48000, 2)
    const stopA = publisher.stopAudioPublishing()
    await publisher.startAudioPublishing(48000, 2)
    tracks[0].resolveClose()
    await stopA

    // If stopAudioPublishing nulled refs *after* awaiting close, the closure
    // vars would now be null and captureFrame on source B would never fire.
    publisher.pushAudioFrame(new Int16Array(480), 48000, 2, 480)
    expect(sources[1].captureFrame).toHaveBeenCalled()
    expect(tracks[0].close).toHaveBeenCalledTimes(1)
    expect(tracks[1].close).not.toHaveBeenCalled()
  })
})

describe('when the presentation video track is published', () => {
  let publisher: ILiveKitPublisher

  beforeEach(async () => {
    RoomMock.mockReset()
    installFakeRoom()
    publisher = createLiveKitPublisherComponent().createPublisher('p-1', createLogger())
    await publisher.connect('wss://lk.example.com', 'tok')
    await publisher.startPublishing(960, 1242)
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should publish it with the VP8 codec so tall slides are not dropped by the H.264 level limit', () => {
    expect(TrackPublishOptions).toHaveBeenCalledWith(expect.objectContaining({ videoCodec: 'VP8' }))
  })
})
