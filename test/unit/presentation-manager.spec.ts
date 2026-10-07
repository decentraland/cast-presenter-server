import fs from 'fs'
import { DEFAULT_OVERLAY_LAYOUT } from '../../src/logic/overlay-layout'
import {
  InvalidLivekitCredentialsError,
  PresentationNotFoundError,
  createPresentationManager
} from '../../src/logic/presentation-manager'
import { SESSION_DISK_QUOTA_BYTES } from '../../src/logic/presentation-manager/component'
import { encodeSlidePng } from '../../src/logic/slide-image'
import type { ILiveKitPublisher } from '../../src/adapters/livekit-publisher/types'
import type { IRenderer } from '../../src/adapters/renderer/types'
import type { ISidecarPublisher } from '../../src/adapters/sidecar-publisher/types'
import type { IVideoCompositor } from '../../src/adapters/video-compositor/types'
import type { OverlayLayout } from '../../src/logic/overlay-layout'
import type { IPresentationManager } from '../../src/logic/presentation-manager'

jest.mock('../../src/logic/slide-image')

function createMockPublisher(): jest.Mocked<ISidecarPublisher> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    startPublishing: jest.fn().mockResolvedValue(undefined),
    pushFrame: jest.fn(),
    startHeartbeat: jest.fn(),
    stopHeartbeat: jest.fn(),
    startAudioPublishing: jest.fn().mockResolvedValue(undefined),
    pushAudioFrame: jest.fn(),
    stopAudioPublishing: jest.fn().mockResolvedValue(undefined),
    setDataHandler: jest.fn(),
    updateMetadataState: jest.fn().mockResolvedValue(undefined),
    publishData: jest.fn().mockResolvedValue(undefined),
    getRemoteParticipantCount: jest.fn().mockReturnValue(0),
    disconnect: jest.fn().mockResolvedValue(undefined),
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    stopVideo: jest.fn().mockResolvedValue(undefined),
    onPlaybackEnded: jest.fn(),
    onPlaybackFailed: jest.fn(),
    onFatal: jest.fn()
  }
}

function createMockRenderer(): jest.Mocked<IRenderer> {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    renderSlide: jest.fn().mockResolvedValue({ buffer: Buffer.alloc(100), width: 1920, height: 1080 }),
    getSlideVideos: jest.fn().mockResolvedValue([]),
    getEmbeddedMediaDir: jest.fn().mockReturnValue(null),
    getSlideCount: jest.fn().mockReturnValue(3),
    destroy: jest.fn()
  }
}

function createMockCompositor(): jest.Mocked<IVideoCompositor> {
  return {
    downloadVideo: jest.fn().mockResolvedValue({ path: '/tmp/video.mp4', bytes: 1024 }),
    startPlayback: jest.fn().mockResolvedValue(undefined),
    onEnd: jest.fn(),
    onError: jest.fn(),
    getIsPlaying: jest.fn().mockReturnValue(false),
    getLastFrame: jest.fn().mockReturnValue({ buffer: Buffer.alloc(100), width: 1920, height: 1080, bufferType: 5 }),
    cleanup: jest.fn()
  }
}

function createMockComponents(overrides?: { publisher?: jest.Mocked<ILiveKitPublisher> }) {
  const publisher = overrides?.publisher ?? createMockPublisher()
  return {
    config: {
      getString: jest.fn().mockResolvedValue(undefined),
      getNumber: jest.fn().mockResolvedValue(undefined),
      requireString: jest.fn().mockResolvedValue(''),
      requireNumber: jest.fn().mockResolvedValue(0)
    },
    logs: {
      getLogger: jest.fn().mockReturnValue({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        log: jest.fn()
      })
    },
    liveKitPublisher: {
      createPublisher: jest.fn().mockReturnValue(publisher)
    },
    sidecarPublisher: {
      createPublisher: jest.fn().mockReturnValue(publisher)
    },
    mediaEncoder: {
      bake: jest.fn().mockResolvedValue({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg', bytes: 10 }),
      promote: jest.fn(),
      resolveEmbeddedVideo: jest.fn().mockReturnValue(null)
    },
    pdfRenderer: {
      createRenderer: jest.fn().mockReturnValue(createMockRenderer())
    },
    pptxRenderer: {
      createRenderer: jest.fn().mockReturnValue(createMockRenderer())
    },
    videoCompositor: {
      createCompositor: jest.fn().mockReturnValue(createMockCompositor()),
      destroyTempDir: jest.fn()
    },
    metrics: {
      increment: jest.fn(),
      decrement: jest.fn(),
      observe: jest.fn(),
      reset: jest.fn(),
      getValue: jest.fn(),
      startTimer: jest.fn()
    },
    _publisher: publisher
  }
}

function createDeferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve))
}

function createManager(components: ReturnType<typeof createMockComponents>): Promise<IPresentationManager> {
  return createPresentationManager(components as unknown as Parameters<typeof createPresentationManager>[0])
}

function createPdfSession(manager: IPresentationManager, presenterIdentity?: string) {
  return manager.createPresentation(
    Buffer.from('%PDF-1.7'),
    'pdf',
    'test-token',
    'wss://lk.example.com',
    'test.pdf',
    presenterIdentity
  )
}

async function createManagerWithSession(components: ReturnType<typeof createMockComponents>) {
  const manager = await createManager(components)
  return { manager, info: await createPdfSession(manager) }
}

describe('when pre-validating LiveKit credentials', () => {
  let components: ReturnType<typeof createMockComponents>
  let publisher: jest.Mocked<ILiveKitPublisher>

  describe('and the connect succeeds', () => {
    beforeEach(() => {
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
    })

    it('should resolve and disconnect the throw-away publisher', async () => {
      const manager = await createManager(components)
      await expect(manager.validateCredentials('wss://lk.example.com', 'good-token')).resolves.toBeUndefined()
      expect(publisher.connect).toHaveBeenCalledWith('wss://lk.example.com', 'good-token')
      expect(publisher.disconnect).toHaveBeenCalled()
    })
  })

  describe('and the connect rejects', () => {
    beforeEach(() => {
      publisher = createMockPublisher()
      publisher.connect.mockRejectedValue(new Error('token rejected'))
      components = createMockComponents({ publisher })
    })

    it('should throw InvalidLivekitCredentialsError and still disconnect', async () => {
      const manager = await createManager(components)
      await expect(manager.validateCredentials('wss://lk.example.com', 'bad-token')).rejects.toBeInstanceOf(
        InvalidLivekitCredentialsError
      )
      expect(publisher.disconnect).toHaveBeenCalled()
    })
  })
})

describe('when creating a presentation', () => {
  let components: ReturnType<typeof createMockComponents>

  describe('and the PDF has zero pages', () => {
    beforeEach(() => {
      components = createMockComponents()
      const renderer = createMockRenderer()
      renderer.getSlideCount.mockReturnValue(0)
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)
    })

    it('should throw an error about no pages', async () => {
      const manager = await createManager(components)
      await expect(
        manager.createPresentation(Buffer.from('%PDF-1.7'), 'pdf', 'token', 'wss://lk.example.com')
      ).rejects.toThrow('PDF contains no pages')
    })
  })

  describe('and publisher.connect() throws', () => {
    let publisher: jest.Mocked<ILiveKitPublisher>

    beforeEach(() => {
      publisher = createMockPublisher()
      publisher.connect.mockRejectedValue(new Error('LiveKit auth failed'))
      components = createMockComponents({ publisher })
    })

    it('should still allow subsequent creations (inFlightCreations is decremented)', async () => {
      const manager = await createManager(components)

      // First creation fails
      await expect(
        manager.createPresentation(Buffer.from('%PDF-1.7'), 'pdf', 'bad-token', 'wss://lk.example.com')
      ).rejects.toThrow('LiveKit auth failed')

      // Reset mock so next connect succeeds
      publisher.connect.mockResolvedValue(undefined)

      // Second creation should succeed — proves inFlightCreations was decremented
      const info = await manager.createPresentation(
        Buffer.from('%PDF-1.7'),
        'pdf',
        'good-token',
        'wss://lk.example.com'
      )
      expect(info.id).toBeDefined()
    })

    it('should record the error metric', async () => {
      const manager = await createManager(components)

      await expect(
        manager.createPresentation(Buffer.from('%PDF-1.7'), 'pdf', 'bad-token', 'wss://lk.example.com')
      ).rejects.toThrow()

      expect(components.metrics.increment).toHaveBeenCalledWith('session_created_total', { status: 'error' })
    })
  })
})

describe('when handling data channel messages', () => {
  let components: ReturnType<typeof createMockComponents>
  let publisher: jest.Mocked<ILiveKitPublisher>
  let dataHandler: (message: Record<string, unknown>) => Promise<void>

  beforeEach(async () => {
    publisher = createMockPublisher()
    components = createMockComponents({ publisher })

    const renderer = createMockRenderer()
    renderer.getSlideVideos.mockResolvedValue([
      { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
    ])
    components.pdfRenderer.createRenderer.mockReturnValue(renderer)

    await createManagerWithSession(components)
    dataHandler = publisher.setDataHandler.mock.calls[0][0] as (message: Record<string, unknown>) => Promise<void>
  })

  describe('when the navigate action is a non-string value', () => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      await dataHandler({ type: 'presentation:navigate', action: 42, slideIndex: 0 })
    })

    it('should not broadcast any state update', () => {
      expect(publisher.publishData).not.toHaveBeenCalled()
    })
  })

  describe('when the navigate action is an invalid string', () => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      await dataHandler({ type: 'presentation:navigate', action: 'delete', slideIndex: 0 })
    })

    it('should not broadcast any state update', () => {
      expect(publisher.publishData).not.toHaveBeenCalled()
    })
  })

  describe('when the videoIndex is a non-number value', () => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      await dataHandler({ type: 'presentation:video:play', videoIndex: 'not-a-number' })
    })

    it('should not broadcast video loading state', () => {
      expect(publisher.publishData).not.toHaveBeenCalledWith(expect.objectContaining({ videoState: 'loading' }))
    })
  })

  describe.each([
    { label: 'NaN', slideIndex: NaN },
    { label: 'a float', slideIndex: 1.5 },
    { label: 'Infinity', slideIndex: Infinity },
    { label: 'a numeric string', slideIndex: '2' }
  ])('when the navigate slideIndex is $label on a goto action', ({ slideIndex }) => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      await dataHandler({ type: 'presentation:navigate', action: 'goto', slideIndex })
    })

    it('should not broadcast any state update (rejected as invalid index)', () => {
      expect(publisher.publishData).not.toHaveBeenCalled()
    })
  })

  describe.each([
    { label: 'NaN', videoIndex: NaN },
    { label: 'a float', videoIndex: 0.5 },
    { label: 'Infinity', videoIndex: Infinity }
  ])('when the videoIndex is $label', ({ videoIndex }) => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      await dataHandler({ type: 'presentation:video:play', videoIndex })
    })

    it('should not broadcast video loading state', () => {
      expect(publisher.publishData).not.toHaveBeenCalledWith(expect.objectContaining({ videoState: 'loading' }))
    })
  })
})

describe('when a presenter sends presentation:overlay:update', () => {
  const OVERLAY_UPDATE = 'presentation:overlay:update'
  let publisher: jest.Mocked<ILiveKitPublisher>
  let manager: IPresentationManager
  let sessionId: string
  let dataHandler: (message: Record<string, unknown>) => Promise<void>

  function stateBroadcasts(): Array<Record<string, unknown>> {
    return publisher.publishData.mock.calls.map(([message]) => message).filter((m) => m.type === 'presentation:state')
  }

  function currentOverlay(): OverlayLayout | undefined {
    return manager.getState(sessionId)?.overlay
  }

  async function advanceBroadcastInterval(): Promise<void> {
    await jest.advanceTimersByTimeAsync(250)
    await flushMicrotasks()
  }

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    publisher = createMockPublisher()
    const created = await createManagerWithSession(createMockComponents({ publisher }))
    manager = created.manager
    sessionId = created.info.id
    dataHandler = publisher.setDataHandler.mock.calls[0][0] as (message: Record<string, unknown>) => Promise<void>
    publisher.publishData.mockClear()
    publisher.updateMetadataState.mockClear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('and it carries x, y and size', () => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.5, y: 0.25, size: 'large' })
    })

    it('should store the full layout on the session', () => {
      expect(currentOverlay()).toEqual({ x: 0.5, y: 0.25, size: 'large' })
    })
  })

  describe('and it carries only size', () => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.3, y: 0.6 })
      await dataHandler({ type: OVERLAY_UPDATE, size: 'large' })
    })

    it('should keep the previous x and y', () => {
      expect(currentOverlay()).toEqual({ x: 0.3, y: 0.6, size: 'large' })
    })
  })

  describe('and x and y are outside [0, 1]', () => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 2, y: -1 })
    })

    it('should store them clamped to the nearest edge', () => {
      expect(currentOverlay()).toEqual({ x: 1, y: 0, size: 'small' })
    })
  })

  describe.each([
    { label: 'x is NaN', fields: { x: NaN } },
    { label: 'x is a numeric string', fields: { x: '0.5' } },
    { label: 'y is Infinity', fields: { y: Infinity } },
    { label: 'size is unknown', fields: { size: 'medium' } }
  ])('and $label', ({ fields }) => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.5, ...fields })
    })

    it('should leave the layout untouched, dropping the whole command', () => {
      expect(currentOverlay()).toEqual(DEFAULT_OVERLAY_LAYOUT)
    })
  })

  describe('and it carries no layout fields', () => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE })
      await advanceBroadcastInterval()
    })

    it('should leave the layout untouched', () => {
      expect(currentOverlay()).toEqual(DEFAULT_OVERLAY_LAYOUT)
    })

    it('should not broadcast state', () => {
      expect(stateBroadcasts()).toHaveLength(0)
    })
  })

  describe('and three valid updates arrive within 100 ms', () => {
    const lastOverlay = { x: 0.3, y: 1, size: 'large' }

    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.1 })
      await jest.advanceTimersByTimeAsync(50)
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.2 })
      await jest.advanceTimersByTimeAsync(50)
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.3, size: 'large' })
    })

    it('should not broadcast state before the interval elapses', () => {
      expect(stateBroadcasts()).toHaveLength(0)
    })

    describe('and the broadcast interval elapses', () => {
      beforeEach(async () => {
        await advanceBroadcastInterval()
      })

      it('should broadcast state exactly once with the last overlay', () => {
        expect(stateBroadcasts()).toEqual([expect.objectContaining({ overlay: lastOverlay })])
      })

      it('should update the metadata once with the last overlay', () => {
        expect(publisher.updateMetadataState).toHaveBeenCalledTimes(1)
        expect(publisher.updateMetadataState).toHaveBeenCalledWith(expect.objectContaining({ overlay: lastOverlay }))
      })
    })
  })

  describe('and a presenter requests the state after session creation', () => {
    beforeEach(async () => {
      await dataHandler({ type: 'presentation:get-state' })
    })

    it('should broadcast the default overlay layout', () => {
      expect(stateBroadcasts()).toEqual([expect.objectContaining({ overlay: DEFAULT_OVERLAY_LAYOUT })])
    })
  })

  describe('and the session stops while a broadcast is pending', () => {
    beforeEach(async () => {
      await dataHandler({ type: OVERLAY_UPDATE, x: 0.5 })
      await manager.stopPresentation(sessionId)
      publisher.publishData.mockClear()
      publisher.updateMetadataState.mockClear()
      await advanceBroadcastInterval()
    })

    it('should not broadcast state', () => {
      expect(stateBroadcasts()).toHaveLength(0)
    })

    it('should not update the metadata', () => {
      expect(publisher.updateMetadataState).not.toHaveBeenCalled()
    })
  })
})

describe('when managing video playback in a presentation', () => {
  let manager: IPresentationManager
  let presentationId: string
  let components: ReturnType<typeof createMockComponents>
  let publisher: jest.Mocked<ILiveKitPublisher>
  let compositor: jest.Mocked<IVideoCompositor>

  describe('when stopping video playback', () => {
    describe('and a video is currently playing', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        publisher.publishData.mockClear()
        publisher.pushFrame.mockClear()
        publisher.startHeartbeat.mockClear()

        await manager.stopVideo(presentationId)
      })

      it('should clean up the compositor', () => {
        expect(compositor.cleanup).toHaveBeenCalled()
      })

      it('should restore the static slide frame', () => {
        expect(publisher.pushFrame).toHaveBeenCalled()
      })

      it('should restart the heartbeat with the slide frame', () => {
        expect(publisher.startHeartbeat).toHaveBeenCalled()
      })

      it('should broadcast state with videoState idle', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'idle'
          })
        )
      })
    })

    describe('and a video is currently paused', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        await manager.pauseVideo(presentationId)
        publisher.publishData.mockClear()

        await manager.stopVideo(presentationId)
      })

      it('should have cleaned up the compositor during pause', () => {
        expect(compositor.cleanup).toHaveBeenCalled()
      })

      it('should broadcast state with videoState idle', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'idle'
          })
        )
      })
    })

    describe('and no video is playing', () => {
      beforeEach(async () => {
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        publisher.publishData.mockClear()
        await manager.stopVideo(presentationId)
      })

      it('should not broadcast any state update', () => {
        expect(publisher.publishData).not.toHaveBeenCalled()
      })
    })

    describe('and the presentation does not exist', () => {
      beforeEach(async () => {
        components = createMockComponents()
        manager = await createManager(components)
      })

      it('should throw PresentationNotFoundError', async () => {
        await expect(manager.stopVideo('non-existent-id')).rejects.toThrow(PresentationNotFoundError)
      })
    })
  })

  describe('when pausing video playback', () => {
    describe('and a video is currently playing', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        publisher.pushFrame.mockClear()
        publisher.startHeartbeat.mockClear()
        compositor.getLastFrame.mockClear()
        compositor.cleanup.mockClear()

        await manager.pauseVideo(presentationId)
      })

      it('should push the last video frame immediately to avoid any gap', () => {
        expect(publisher.pushFrame).toHaveBeenCalledWith(
          expect.any(Buffer),
          expect.any(Number),
          expect.any(Number),
          5 // VIDEO_BUFFER_TYPE_I420
        )
      })

      it('should start a heartbeat with the last video frame', () => {
        expect(publisher.startHeartbeat).toHaveBeenCalledWith(
          expect.any(Buffer),
          expect.any(Number),
          expect.any(Number),
          5 // VIDEO_BUFFER_TYPE_I420
        )
      })

      it('should get the last frame before cleanup', () => {
        expect(compositor.getLastFrame).toHaveBeenCalled()
        const getFrameOrder = compositor.getLastFrame.mock.invocationCallOrder[0]
        const cleanupOrder = compositor.cleanup.mock.invocationCallOrder[0]
        expect(getFrameOrder).toBeLessThan(cleanupOrder)
      })

      it('should broadcast state with videoState paused', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'paused'
          })
        )
      })
    })
  })

  describe('when resuming a paused video', () => {
    let dateSpy: jest.SpyInstance

    beforeEach(async () => {
      compositor = createMockCompositor()
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)

      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)

      const result = await createManagerWithSession(components)
      manager = result.manager
      presentationId = result.info.id

      // Simulate 5 seconds of playback before pausing
      let now = 1000
      dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => now)
      await manager.playVideo(presentationId, 0)
      now = 6000
      await manager.pauseVideo(presentationId)
      publisher.startAudioPublishing.mockClear()
      compositor.startPlayback.mockClear()

      await manager.playVideo(presentationId, 0)
    })

    afterEach(() => {
      dateSpy.mockRestore()
    })

    it('should not re-create the audio track (it stays published during pause)', () => {
      expect(publisher.startAudioPublishing).not.toHaveBeenCalled()
    })

    it('should pass a non-zero seekSeconds to startPlayback', () => {
      const seekArg = compositor.startPlayback.mock.calls[0][7]
      expect(seekArg).toBeGreaterThan(0)
    })

    it('should broadcast state with videoState playing', () => {
      expect(publisher.publishData).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'presentation:state',
          videoState: 'playing'
        })
      )
    })
  })

  describe('when playing a video after a full stop', () => {
    beforeEach(async () => {
      compositor = createMockCompositor()
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)

      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)

      const result = await createManagerWithSession(components)
      manager = result.manager
      presentationId = result.info.id

      await manager.playVideo(presentationId, 0)
      await manager.stopVideo(presentationId)
      publisher.startAudioPublishing.mockClear()
      compositor.startPlayback.mockClear()

      await manager.playVideo(presentationId, 0)
    })

    it('should create a fresh audio track', () => {
      expect(publisher.startAudioPublishing).toHaveBeenCalledWith(48000, 2)
    })

    it('should start playback without seekSeconds', () => {
      const seekArg = compositor.startPlayback.mock.calls[0][7]
      expect(seekArg).toBeUndefined()
    })
  })

  describe('when playing a video embedded in the PPTX', () => {
    const embeddedPath = '/tmp/cast-pptx-video-abc/media1.mp4'

    beforeEach(async () => {
      compositor = createMockCompositor()
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)
      components.mediaEncoder.resolveEmbeddedVideo.mockImplementation((url: string) =>
        url === embeddedPath ? { path: embeddedPath, bytes: 5 } : null
      )

      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: embeddedPath, geometry: { x: 100, y: 100, width: 640, height: 480 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)

      const result = await createManagerWithSession(components)
      manager = result.manager
      presentationId = result.info.id
      compositor.downloadVideo.mockClear()

      await manager.playVideo(presentationId, 0)
    })

    it('should play the extracted file without downloading it', () => {
      expect({
        downloaded: compositor.downloadVideo.mock.calls.length,
        playedPath: compositor.startPlayback.mock.calls[0]?.[0]
      }).toEqual({ downloaded: 0, playedPath: embeddedPath })
    })
  })

  describe('when managing audio during video playback', () => {
    describe('when playing a video', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
      })

      it('should start audio publishing at 48kHz stereo', () => {
        expect(publisher.startAudioPublishing).toHaveBeenCalledWith(48000, 2)
      })

      it('should call startAudioPublishing before startPlayback', () => {
        const audioOrder = publisher.startAudioPublishing.mock.invocationCallOrder[0]
        const playbackOrder = compositor.startPlayback.mock.invocationCallOrder[0]
        expect(audioOrder).toBeLessThan(playbackOrder)
      })

      it('should pass onAudioData callback to compositor startPlayback', () => {
        expect(compositor.startPlayback).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ url: 'https://example.com/video.mp4' }),
          expect.any(Buffer),
          expect.any(Number),
          expect.any(Number),
          publisher,
          expect.any(Function),
          undefined
        )
      })
    })

    describe('when startAudioPublishing fails', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        publisher.startAudioPublishing.mockRejectedValueOnce(new Error('Audio publish failed'))
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
      })

      it('should still start video playback', () => {
        expect(compositor.startPlayback).toHaveBeenCalled()
      })
    })

    describe('when stopping a playing video', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        publisher.stopAudioPublishing.mockClear()

        await manager.stopVideo(presentationId)
      })

      it('should stop audio publishing', () => {
        expect(publisher.stopAudioPublishing).toHaveBeenCalled()
      })

      it('should stop audio before cleaning up compositor', () => {
        const audioOrder = publisher.stopAudioPublishing.mock.invocationCallOrder[0]
        const cleanupOrder =
          compositor.cleanup.mock.invocationCallOrder[compositor.cleanup.mock.invocationCallOrder.length - 1]
        expect(audioOrder).toBeLessThan(cleanupOrder)
      })
    })

    describe('when navigating away from a playing video', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        publisher.stopAudioPublishing.mockClear()

        await manager.navigate(presentationId, 'next')
      })

      it('should stop audio publishing', () => {
        expect(publisher.stopAudioPublishing).toHaveBeenCalled()
      })
    })

    describe('when a video ends naturally', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
        publisher.stopAudioPublishing.mockClear()

        // Simulate video ending by invoking the onEnd callback
        const onEndCallback = compositor.onEnd.mock.calls[0][0]
        await onEndCallback()
      })

      it('should stop audio publishing', () => {
        expect(publisher.stopAudioPublishing).toHaveBeenCalled()
      })
    })
  })

  describe('when a video download fails', () => {
    describe('and the server returns HTTP 403', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        compositor.downloadVideo.mockRejectedValue(new Error('HTTP 403 downloading https://example.com/video.mp4'))
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast videoState error', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'error',
            videoErrorReason: expect.stringContaining('not authorized')
          })
        )
      })

      it('should clean up the compositor', () => {
        expect(compositor.cleanup).toHaveBeenCalled()
      })
    })

    describe('and the download times out', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        compositor.downloadVideo.mockRejectedValue(new Error('Download timed out after 120s'))
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast videoState error with timeout reason', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'error',
            videoErrorReason: expect.stringContaining('timed out')
          })
        )
      })
    })

    describe('and the video is not found (404)', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        compositor.downloadVideo.mockRejectedValue(new Error('HTTP 404 downloading https://example.com/video.mp4'))
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast videoState error with not found reason', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'error',
            videoErrorReason: expect.stringContaining('not found')
          })
        )
      })
    })

    describe('and the error is cleared on retry', () => {
      beforeEach(async () => {
        compositor = createMockCompositor()
        compositor.downloadVideo
          .mockRejectedValueOnce(new Error('HTTP 403 downloading https://example.com/video.mp4'))
          .mockResolvedValue({ path: '/tmp/video.mp4', bytes: 1024 })
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)

        const renderer = createMockRenderer()
        renderer.getSlideVideos.mockResolvedValue([
          { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
        ])
        components.pdfRenderer.createRenderer.mockReturnValue(renderer)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        // First play fails
        await manager.playVideo(presentationId, 0)

        publisher.publishData.mockClear()

        // Second play succeeds (downloadVideo mock resets to default success)
        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast loading state without error reason on retry', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'loading'
          })
        )
        const loadingCall = publisher.publishData.mock.calls.find(
          (call) => (call[0] as Record<string, unknown>).videoState === 'loading'
        )
        expect(loadingCall).toBeDefined()
        if (loadingCall) {
          expect((loadingCall[0] as Record<string, unknown>).videoErrorReason).toBeUndefined()
        }
      })
    })
  })

  describe('when stopVideo races with an in-flight playVideo', () => {
    function setupRenderer(components: ReturnType<typeof createMockComponents>) {
      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)
    }

    function lastBroadcastVideoState(pub: jest.Mocked<ILiveKitPublisher>): string | undefined {
      const stateCalls = pub.publishData.mock.calls.filter(
        (call) => (call[0] as Record<string, unknown>).type === 'presentation:state'
      )
      const last = stateCalls[stateCalls.length - 1]
      return last ? ((last[0] as Record<string, unknown>).videoState as string | undefined) : undefined
    }

    describe('and stopVideo is called while the download is pending', () => {
      let downloadDeferred: ReturnType<typeof createDeferred<{ path: string; bytes: number }>>
      let playPromise: Promise<void>

      beforeEach(async () => {
        compositor = createMockCompositor()
        downloadDeferred = createDeferred<{ path: string; bytes: number }>()
        compositor.downloadVideo.mockReturnValue(downloadDeferred.promise)
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)
        setupRenderer(components)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        playPromise = manager.playVideo(presentationId, 0)
        await flushMicrotasks() // let playVideoSession reach the download await

        await manager.stopVideo(presentationId)

        downloadDeferred.resolve({ path: '/tmp/video.mp4', bytes: 1024 })
        await playPromise
      })

      it('should not call startPlayback', () => {
        expect(compositor.startPlayback).not.toHaveBeenCalled()
      })

      it('should not register onEnd', () => {
        expect(compositor.onEnd).not.toHaveBeenCalled()
      })

      it('should leave videoState idle (not revert to playing)', () => {
        expect(lastBroadcastVideoState(publisher)).toBe('idle')
      })
    })

    describe('and stopVideo is called while audio publishing is pending', () => {
      let audioDeferred: ReturnType<typeof createDeferred<void>>
      let playPromise: Promise<void>

      beforeEach(async () => {
        compositor = createMockCompositor()
        audioDeferred = createDeferred<void>()
        publisher = createMockPublisher()
        publisher.startAudioPublishing.mockReturnValue(audioDeferred.promise)
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)
        setupRenderer(components)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        playPromise = manager.playVideo(presentationId, 0)
        await flushMicrotasks() // let playVideoSession reach the startAudioPublishing await

        await manager.stopVideo(presentationId)

        audioDeferred.resolve()
        await playPromise
      })

      it('should not call startPlayback', () => {
        expect(compositor.startPlayback).not.toHaveBeenCalled()
      })

      it('should leave videoState idle', () => {
        expect(lastBroadcastVideoState(publisher)).toBe('idle')
      })
    })

    describe('and stopVideo is called while startPlayback is pending', () => {
      let startDeferred: ReturnType<typeof createDeferred<void>>
      let playPromise: Promise<void>

      beforeEach(async () => {
        compositor = createMockCompositor()
        startDeferred = createDeferred<void>()
        compositor.startPlayback.mockReturnValue(startDeferred.promise)
        publisher = createMockPublisher()
        components = createMockComponents({ publisher })
        components.videoCompositor.createCompositor.mockReturnValue(compositor)
        setupRenderer(components)

        const result = await createManagerWithSession(components)
        manager = result.manager
        presentationId = result.info.id

        playPromise = manager.playVideo(presentationId, 0)
        await flushMicrotasks() // let playVideoSession reach the startPlayback await

        await manager.stopVideo(presentationId)

        startDeferred.resolve()
        await playPromise
      })

      it('should leave videoState idle (the post-startPlayback guard trips)', () => {
        expect(lastBroadcastVideoState(publisher)).toBe('idle')
      })

      it('should not register onEnd (play returned before reaching that line)', () => {
        expect(compositor.onEnd).not.toHaveBeenCalled()
      })

      it('should not increment the play metric', () => {
        expect(components.metrics.increment).not.toHaveBeenCalledWith('video_playback_total', { action: 'play' })
      })

      // Without this the FFmpegs spawned inside startPlayback after stopVideo's
      // cleanup are orphaned — the compositor's close handler is gated on
      // `!cleanedUp && isPlaying` and wouldn't kill them either.
      it('should cleanup the orphaned compositor once the post-startPlayback guard trips', () => {
        expect(compositor.cleanup).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('when a user-initiated video play fails', () => {
    let compositor: jest.Mocked<IVideoCompositor>
    let publisher: jest.Mocked<ILiveKitPublisher>
    let components: ReturnType<typeof createMockComponents>
    let manager: IPresentationManager
    let presentationId: string

    function setup(overrides: { downloadError?: Error; startPlaybackError?: Error } = {}) {
      compositor = createMockCompositor()
      if (overrides.downloadError) compositor.downloadVideo.mockRejectedValue(overrides.downloadError)
      if (overrides.startPlaybackError) compositor.startPlayback.mockRejectedValue(overrides.startPlaybackError)
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)
      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/v.mp4', geometry: { x: 0, y: 0, width: 100, height: 100 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)
      return createManagerWithSession(components).then((r) => {
        manager = r.manager
        presentationId = r.info.id
      })
    }

    describe('and the download fails with HTTP 403', () => {
      beforeEach(async () => {
        await setup({ downloadError: new Error('HTTP 403 downloading https://example.com/v.mp4') })
        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast a transient presentation:error with code video-permission-denied', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:error',
            code: 'video-permission-denied',
            message: expect.stringContaining('not authorized'),
            videoIndex: 0,
            videoUrl: 'https://example.com/v.mp4'
          })
        )
      })
    })

    describe('and the remux returns invalid data', () => {
      beforeEach(async () => {
        await setup({ downloadError: new Error('Remux failed (code 183): Invalid data found when processing input') })
        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast code video-invalid-format', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'presentation:error', code: 'video-invalid-format' })
        )
      })
    })

    describe('and startPlayback throws mid-setup', () => {
      beforeEach(async () => {
        await setup({ startPlaybackError: new Error('spawn ffmpeg ENOENT') })
        await manager.playVideo(presentationId, 0).catch(() => {
          /* rethrown by the manager — swallowed in tests */
        })
      })

      it('should broadcast a transient presentation:error', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'presentation:error', videoIndex: 0 })
        )
      })
    })
  })

  describe('when the compositor fires onError mid-stream', () => {
    let compositor: jest.Mocked<IVideoCompositor>
    let publisher: jest.Mocked<ILiveKitPublisher>

    async function setupAndFire(
      reason: 'video-playback-interrupted' | 'video-stream-error' | 'audio-processing-failed'
    ) {
      compositor = createMockCompositor()
      publisher = createMockPublisher()
      const components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)
      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/v.mp4', geometry: { x: 0, y: 0, width: 100, height: 100 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)
      const result = await createManagerWithSession(components)
      await result.manager.playVideo(result.info.id, 0)

      publisher.publishData.mockClear()
      publisher.stopAudioPublishing.mockClear()
      const onErrorCallback = compositor.onError.mock.calls[0][0]
      await onErrorCallback(reason)
      await flushMicrotasks()
    }

    describe('with reason video-playback-interrupted', () => {
      let compositorRef: jest.Mocked<IVideoCompositor>
      beforeEach(async () => {
        await setupAndFire('video-playback-interrupted')
        compositorRef = compositor
      })

      it('should broadcast presentation:error with an "interrupted" message', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:error',
            code: 'video-playback-interrupted',
            message: expect.stringContaining('interrupted'),
            videoIndex: 0,
            videoUrl: 'https://example.com/v.mp4'
          })
        )
      })

      it('should transition session to videoState error and include the structured code', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:state',
            videoState: 'error',
            videoErrorCode: 'video-playback-interrupted',
            videoErrorReason: expect.stringContaining('interrupted')
          })
        )
      })

      it('should tear down the audio track', () => {
        expect(publisher.stopAudioPublishing).toHaveBeenCalled()
      })

      it('should call compositor.cleanup() to release latches and the slide temp file', () => {
        expect(compositorRef.cleanup).toHaveBeenCalled()
      })
    })

    describe('with reason video-stream-error', () => {
      beforeEach(() => setupAndFire('video-stream-error'))

      it('should broadcast a stream-error-specific message', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:error',
            code: 'video-stream-error',
            message: expect.stringContaining('stream error')
          })
        )
      })
    })

    describe('with reason audio-processing-failed', () => {
      beforeEach(() => setupAndFire('audio-processing-failed'))

      it('should broadcast an audio-specific message', () => {
        expect(publisher.publishData).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'presentation:error',
            code: 'audio-processing-failed',
            message: expect.stringContaining('Audio')
          })
        )
      })
    })
  })

  describe('when the audio handler receives PCM chunks', () => {
    // Covers the RangeError crash: feeding an oversize chunk to onAudioData
    // used to drift audioWrite past the buffer and throw inside Buffer.copy.
    let compositor: jest.Mocked<IVideoCompositor>
    let publisher: jest.Mocked<ILiveKitPublisher>
    let onAudioData: (chunk: Buffer) => void

    beforeEach(async () => {
      compositor = createMockCompositor()
      publisher = createMockPublisher()
      const components = createMockComponents({ publisher })
      components.videoCompositor.createCompositor.mockReturnValue(compositor)
      const renderer = createMockRenderer()
      renderer.getSlideVideos.mockResolvedValue([
        { url: 'https://example.com/v.mp4', geometry: { x: 0, y: 0, width: 100, height: 100 } }
      ])
      components.pdfRenderer.createRenderer.mockReturnValue(renderer)
      const result = await createManagerWithSession(components)
      await result.manager.playVideo(result.info.id, 0)
      // The seventh positional arg (index 6) of startPlayback is the onAudioData callback.
      onAudioData = compositor.startPlayback.mock.calls[0][6] as (chunk: Buffer) => void
    })

    it('should push nothing for a sub-frame chunk', () => {
      onAudioData(Buffer.alloc(100))
      expect(publisher.pushAudioFrame).not.toHaveBeenCalled()
    })

    it('should push exactly one frame for a 1920-byte chunk', () => {
      onAudioData(Buffer.alloc(1920))
      expect(publisher.pushAudioFrame).toHaveBeenCalledTimes(1)
    })

    it('should push one frame and keep the tail for a 1.5-frame chunk', () => {
      onAudioData(Buffer.alloc(1920 + 500))
      expect(publisher.pushAudioFrame).toHaveBeenCalledTimes(1)
      // Next small chunk should complete a second frame by combining with the residual
      publisher.pushAudioFrame.mockClear()
      onAudioData(Buffer.alloc(1920 - 500))
      expect(publisher.pushAudioFrame).toHaveBeenCalledTimes(1)
    })

    it('should not throw on a chunk larger than any fixed ring buffer would have been', () => {
      // Regression: old ring buffer was 40448 bytes; a 60 KB burst from FFmpeg
      // used to drift audioWrite past the buffer and crash later.
      expect(() => onAudioData(Buffer.alloc(60 * 1024))).not.toThrow()
      // 60 KB / 1920 = 32 full frames
      expect(publisher.pushAudioFrame).toHaveBeenCalledTimes(Math.floor((60 * 1024) / 1920))
    })

    it('should stitch arbitrary chunk boundaries into 1920-byte frames', () => {
      onAudioData(Buffer.alloc(1000))
      onAudioData(Buffer.alloc(1000)) // total 2000 → 1 frame, 80 residual
      onAudioData(Buffer.alloc(50)) // total 130 residual
      onAudioData(Buffer.alloc(1920 - 130)) // completes frame 2
      expect(publisher.pushAudioFrame).toHaveBeenCalledTimes(2)
    })
  })
})

describe('when the legacy compositor pre-downloads the deck videos', () => {
  const EMBEDDED_PATH = '/tmp/cast-pptx-video-abc/media1.mp4'
  const REMOTE_URL = 'https://example.com/clip.mp4'
  let components: ReturnType<typeof createMockComponents>
  let compositor: jest.Mocked<IVideoCompositor>

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
    compositor = createMockCompositor()
    components = createMockComponents()
    components.videoCompositor.createCompositor.mockReturnValue(compositor)
    components.mediaEncoder.resolveEmbeddedVideo.mockImplementation((url: string) =>
      url === EMBEDDED_PATH ? { path: EMBEDDED_PATH, bytes: 5 } : null
    )
    const renderer = createMockRenderer()
    renderer.getSlideCount.mockReturnValue(1)
    renderer.getSlideVideos.mockResolvedValue([
      { url: EMBEDDED_PATH, geometry: { x: 0, y: 0, width: 640, height: 480 } },
      { url: REMOTE_URL, geometry: { x: 0, y: 0, width: 640, height: 480 } }
    ])
    components.pdfRenderer.createRenderer.mockReturnValue(renderer)
    await createManagerWithSession(components)
    compositor.downloadVideo.mockClear()
    jest.advanceTimersByTime(3000)
    await flushMicrotasks()
    await flushMicrotasks()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should download the remote video and leave the file the PPTX renderer already extracted alone', () => {
    expect(compositor.downloadVideo.mock.calls.map(([url]) => url)).toEqual([REMOTE_URL])
  })
})

describe('when client composition is enabled', () => {
  const PUBLIC_BASE_URL = 'https://cast.example.com'
  const PRESENTER_IDENTITY = 'stream:p:1'
  const VIDEO_URL = 'https://example.com/video.mp4'
  const DOWNLOADED_PATH = '/tmp/video.mp4'
  const EMBEDDED_PATH = '/tmp/cast-pptx-video-a/v.mp4'
  let components: ReturnType<typeof createMockComponents>
  let sidecar: jest.Mocked<ISidecarPublisher>
  let compositor: jest.Mocked<IVideoCompositor>
  let configValues: Record<string, string | undefined>
  let manager: IPresentationManager
  let presentationId: string
  let encodeCount: number
  let renderer: jest.Mocked<IRenderer>
  let rmSync: jest.SpyInstance

  function stateBroadcasts(): Array<Record<string, unknown>> {
    return sidecar.publishData.mock.calls.map(([message]) => message).filter((m) => m.type === 'presentation:state')
  }

  function lastSlideUrl(): unknown {
    const states = stateBroadcasts()
    return (states[states.length - 1].slide as { url: string }).url
  }

  function bakeSignal(call: number): AbortSignal {
    return components.mediaEncoder.bake.mock.calls[call][2].signal
  }

  function pendingUntilAborted(signal: AbortSignal): Promise<never> {
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted'))))
  }

  function bakeUntilAborted(): void {
    components.mediaEncoder.bake.mockImplementation((_source: string, _dir: string, options: { signal: AbortSignal }) =>
      pendingUntilAborted(options.signal)
    )
  }

  async function createSession(): Promise<void> {
    presentationId = (await createPdfSession(manager, PRESENTER_IDENTITY)).id
    await flushMicrotasks()
  }

  beforeEach(async () => {
    rmSync = jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined)
    encodeCount = 0
    jest.mocked(encodeSlidePng).mockImplementation(async () => {
      encodeCount++
      return { hash: `h${encodeCount}`, png: Buffer.from(`png${encodeCount}`), width: 1920, height: 1080 }
    })
    configValues = { CLIENT_COMPOSITION_ENABLED: 'true', PUBLIC_BASE_URL: `${PUBLIC_BASE_URL}/` }
    sidecar = createMockPublisher()
    compositor = createMockCompositor()
    components = createMockComponents({ publisher: sidecar })
    components.config.getString.mockImplementation(async (key: string) => configValues[key])
    components.videoCompositor.createCompositor.mockReturnValue(compositor)
    renderer = createMockRenderer()
    renderer.getSlideCount.mockReturnValue(10)
    renderer.getSlideVideos.mockResolvedValue([
      { url: VIDEO_URL, geometry: { x: 100, y: 100, width: 640, height: 480 } }
    ])
    components.pdfRenderer.createRenderer.mockReturnValue(renderer)
    manager = await createManager(components)
  })

  afterEach(() => {
    rmSync.mockRestore()
    jest.mocked(encodeSlidePng).mockReset()
  })

  describe('and PUBLIC_BASE_URL is unset', () => {
    beforeEach(() => {
      configValues.PUBLIC_BASE_URL = undefined
    })

    it('should reject creating the manager', async () => {
      await expect(createManager(components)).rejects.toThrow('PUBLIC_BASE_URL')
    })
  })

  describe('and a session is created with a presenterIdentity', () => {
    let expectedFields: Record<string, unknown>

    beforeEach(async () => {
      await createSession()
      expectedFields = {
        slide: { url: `${PUBLIC_BASE_URL}/presentations/${presentationId}/slides/h1.png`, width: 1920, height: 1080 },
        presenterIdentity: PRESENTER_IDENTITY,
        playingVideoIndex: null
      }
    })

    it('should create the session publisher through the sidecar factory instead of an rtc-node one', () => {
      expect([
        components.sidecarPublisher.createPublisher.mock.calls.length,
        components.liveKitPublisher.createPublisher.mock.calls.length
      ]).toEqual([1, 0])
    })

    it('should not publish a composite track', () => {
      expect(sidecar.startPublishing).not.toHaveBeenCalled()
    })

    it('should start the prefetch bake right away, without the legacy timer', () => {
      expect(components.mediaEncoder.bake).toHaveBeenCalledWith(DOWNLOADED_PATH, expect.any(String), {
        priority: 'prefetch',
        signal: expect.any(AbortSignal)
      })
    })

    it('should broadcast the slide, presenterIdentity and playingVideoIndex in the first state', () => {
      expect(stateBroadcasts()[0]).toEqual(expect.objectContaining(expectedFields))
    })

    it('should put the same fields in the bot metadata', () => {
      expect(sidecar.updateMetadataState.mock.calls[0][0]).toEqual(expect.objectContaining(expectedFields))
    })

    describe('and the presenter navigates to the next slide', () => {
      beforeEach(async () => {
        await manager.navigate(presentationId, 'next')
      })

      it('should broadcast the new slide url', () => {
        expect(lastSlideUrl()).toBe(`${PUBLIC_BASE_URL}/presentations/${presentationId}/slides/h2.png`)
      })

      it('should still serve the previous slide image', () => {
        expect(manager.getSlideImage(presentationId, 'h1')).toEqual(Buffer.from('png1'))
      })

      it('should serve the current slide image', () => {
        expect(manager.getSlideImage(presentationId, 'h2')).toEqual(Buffer.from('png2'))
      })
    })

    describe('and the presenter navigates nine times', () => {
      beforeEach(async () => {
        for (let slide = 1; slide <= 9; slide++) {
          await manager.navigate(presentationId, 'goto', slide)
        }
      })

      it('should evict the oldest slide image', () => {
        expect(manager.getSlideImage(presentationId, 'h1')).toBeNull()
      })

      it('should keep the latest slide image', () => {
        expect(manager.getSlideImage(presentationId, 'h10')).toEqual(Buffer.from('png10'))
      })
    })

    describe('and encoding the next slide fails', () => {
      beforeEach(async () => {
        jest.mocked(encodeSlidePng).mockRejectedValueOnce(new Error('encode failed'))
        await manager.navigate(presentationId, 'next')
      })

      it('should still move to the next slide', () => {
        expect(manager.getState(presentationId)?.currentSlide).toBe(1)
      })

      it('should leave the stale slide out of the state', () => {
        expect(manager.getState(presentationId)?.slide).toBeUndefined()
      })
    })

    describe('and loading the next slide videos fails', () => {
      beforeEach(async () => {
        renderer.getSlideVideos.mockRejectedValueOnce(new Error('videos failed'))
        await manager.navigate(presentationId, 'next').catch(() => undefined)
      })

      it('should keep the previous slide url', () => {
        expect(manager.getState(presentationId)?.slide?.url).toBe(
          `${PUBLIC_BASE_URL}/presentations/${presentationId}/slides/h1.png`
        )
      })
    })

    describe('and the state is read while the next slide videos are loading', () => {
      let slideUrlDuringNavigation: string | undefined

      beforeEach(async () => {
        let releaseVideos: (videos: []) => void = () => undefined
        renderer.getSlideVideos.mockReturnValueOnce(
          new Promise((resolve) => {
            releaseVideos = resolve
          })
        )
        const navigation = manager.navigate(presentationId, 'next')
        await new Promise((resolve) => setImmediate(resolve))
        slideUrlDuringNavigation = manager.getState(presentationId)?.slide?.url
        releaseVideos([])
        await navigation
      })

      it('should report the previous slide url', () => {
        expect(slideUrlDuringNavigation).toBe(`${PUBLIC_BASE_URL}/presentations/${presentationId}/slides/h1.png`)
      })
    })

    describe('and the presenter plays video 0', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 0)
      })

      it('should play the baked files on the sidecar', () => {
        expect(sidecar.play).toHaveBeenCalledWith({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg' })
      })

      it('should broadcast loading and then playing with playingVideoIndex 0', () => {
        expect(stateBroadcasts().map((s) => [s.videoState, s.playingVideoIndex])).toEqual([
          ['idle', null],
          ['loading', 0],
          ['playing', 0]
        ])
      })

      describe('and the presenter stops the video', () => {
        beforeEach(async () => {
          await manager.stopVideo(presentationId)
        })

        it('should broadcast playingVideoIndex null', () => {
          const states = stateBroadcasts()
          expect(states[states.length - 1]).toEqual(
            expect.objectContaining({ videoState: 'idle', playingVideoIndex: null })
          )
        })
      })

      describe('and the presenter stops it and plays it again', () => {
        beforeEach(async () => {
          await manager.stopVideo(presentationId)
          await manager.playVideo(presentationId, 0)
        })

        it('should delete the downloaded source after the bake', () => {
          expect(rmSync).toHaveBeenCalledWith(DOWNLOADED_PATH, { force: true })
        })

        it('should reuse the first download and bake instead of repeating them', () => {
          expect([compositor.downloadVideo.mock.calls.length, components.mediaEncoder.bake.mock.calls.length]).toEqual([
            1, 1
          ])
        })
      })

      describe('and the sidecar reports the natural end', () => {
        beforeEach(async () => {
          sidecar.onPlaybackEnded.mock.calls[0][0]()
          await flushMicrotasks()
        })

        it('should go idle with a null playingVideoIndex', () => {
          expect(manager.getState(presentationId)).toEqual(
            expect.objectContaining({ videoState: 'idle', playingVideoIndex: null })
          )
        })
      })

      describe('and the sidecar reports a playback failure', () => {
        beforeEach(async () => {
          sidecar.onPlaybackFailed.mock.calls[0][0]('read v.h264: input/output error')
          await flushMicrotasks()
        })

        it('should put the video in the interrupted error state', () => {
          expect(manager.getState(presentationId)).toEqual(
            expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-playback-interrupted' })
          )
        })

        it('should publish a presentation:error', () => {
          expect(sidecar.publishData).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'presentation:error', code: 'video-playback-interrupted', videoIndex: 0 })
          )
        })
      })

      describe('and the presenter navigates away', () => {
        beforeEach(async () => {
          await manager.navigate(presentationId, 'next')
        })

        it('should stop the sidecar playback', () => {
          expect(sidecar.stopVideo).toHaveBeenCalledTimes(1)
        })

        it('should go idle', () => {
          expect(manager.getState(presentationId)?.videoState).toBe('idle')
        })
      })

      describe('and the presenter pauses and plays the same video', () => {
        beforeEach(async () => {
          await manager.pauseVideo(presentationId)
          await manager.playVideo(presentationId, 0)
        })

        it('should pause the sidecar before resuming it', () => {
          expect(sidecar.pause.mock.invocationCallOrder[0]).toBeLessThan(sidecar.resume.mock.invocationCallOrder[0])
        })

        it('should not bake or play again', () => {
          expect([components.mediaEncoder.bake.mock.calls.length, sidecar.play.mock.calls.length]).toEqual([1, 1])
        })

        it('should be playing', () => {
          expect(manager.getState(presentationId)?.videoState).toBe('playing')
        })
      })
    })
  })

  describe('and a session is created without a presenterIdentity', () => {
    beforeEach(async () => {
      await createPdfSession(manager)
    })

    it('should broadcast a null presenterIdentity', () => {
      expect(stateBroadcasts()[0]).toEqual(expect.objectContaining({ presenterIdentity: null }))
    })
  })

  describe('and the sidecar dies before the session is registered', () => {
    beforeEach(() => {
      sidecar.connect.mockImplementation(async () => {
        sidecar.onFatal.mock.calls[0][0]('sidecar exited with status 1')
      })
    })

    it('should reject the creation with the fatal reason', async () => {
      await expect(createSession()).rejects.toThrow('sidecar exited with status 1')
    })

    it('should disconnect the sidecar instead of leaving it running', async () => {
      await createSession().catch(() => undefined)
      expect(sidecar.disconnect).toHaveBeenCalled()
    })
  })

  describe('and the source is an embedded PPTX video', () => {
    beforeEach(() => {
      components.mediaEncoder.resolveEmbeddedVideo.mockReturnValue({ path: EMBEDDED_PATH, bytes: 5 })
    })

    describe('and the presenter plays it', () => {
      beforeEach(async () => {
        await createSession()
        await manager.playVideo(presentationId, 0)
      })

      it('should bake the embedded file without downloading anything', () => {
        expect([components.mediaEncoder.bake.mock.calls[0][0], compositor.downloadVideo.mock.calls.length]).toEqual([
          EMBEDDED_PATH,
          0
        ])
      })
    })

    describe('and the bake output exceeds the session quota', () => {
      beforeEach(async () => {
        components.mediaEncoder.bake.mockResolvedValue({
          videoPath: '/tmp/v.h264',
          audioPath: '/tmp/a.ogg',
          bytes: SESSION_DISK_QUOTA_BYTES + 1
        })
        await createSession()
        await manager.playVideo(presentationId, 0)
      })

      it('should put the video in the quota error state', () => {
        expect(manager.getState(presentationId)).toEqual(
          expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-quota-exceeded' })
        )
      })

      it('should delete only the bake outputs, never the source', () => {
        expect(new Set(rmSync.mock.calls.map(([target]) => target))).toEqual(new Set(['/tmp/v.h264', '/tmp/a.ogg']))
      })
    })
  })

  describe('and the bake output alone fits the quota but source plus output would not', () => {
    beforeEach(async () => {
      components.mediaEncoder.bake.mockResolvedValue({
        videoPath: '/tmp/v.h264',
        audioPath: '/tmp/a.ogg',
        bytes: SESSION_DISK_QUOTA_BYTES - 1000
      })
      await createSession()
      await manager.playVideo(presentationId, 0)
    })

    it('should release the source bytes and play', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('playing')
    })
  })

  describe('and a cancelled job rejects late after the same video was played again', () => {
    let lateBake: ReturnType<typeof createDeferred<never>>

    beforeEach(async () => {
      lateBake = createDeferred<never>()
      components.mediaEncoder.bake.mockReturnValueOnce(lateBake.promise)
      await createSession()
      const firstPlay = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      await manager.stopVideo(presentationId)
      await manager.playVideo(presentationId, 0)
      lateBake.reject(new Error('Aborted'))
      await firstPlay
      await flushMicrotasks()
    })

    it('should keep the second play playing', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('playing')
    })

    it('should bake twice in total', () => {
      expect(components.mediaEncoder.bake).toHaveBeenCalledTimes(2)
    })
  })

  describe('and video 0 is played while its prefetch bake is still queued', () => {
    beforeEach(async () => {
      bakeUntilAborted()
      await createSession()
      manager.playVideo(presentationId, 0).catch(() => undefined)
      await flushMicrotasks()
    })

    afterEach(async () => {
      await manager.stopPresentation(presentationId)
    })

    it('should promote the prefetch job', () => {
      expect(components.mediaEncoder.promote).toHaveBeenCalledWith(bakeSignal(0))
    })

    it('should not start a second bake', () => {
      expect(components.mediaEncoder.bake).toHaveBeenCalledTimes(1)
    })
  })

  describe('and video 0 is played while its prefetch download is still running', () => {
    beforeEach(async () => {
      const download = createDeferred<{ path: string; bytes: number }>()
      compositor.downloadVideo.mockReturnValueOnce(download.promise)
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      download.resolve({ path: DOWNLOADED_PATH, bytes: 1024 })
      await playing
    })

    it('should bake it with play priority', () => {
      expect(components.mediaEncoder.bake).toHaveBeenCalledWith(
        DOWNLOADED_PATH,
        expect.any(String),
        expect.objectContaining({ priority: 'play' })
      )
    })
  })

  describe('and the presenter stops while the download is pending', () => {
    beforeEach(async () => {
      compositor.downloadVideo.mockImplementationOnce((_url: string, signal?: AbortSignal) =>
        pendingUntilAborted(signal ?? new AbortController().signal)
      )
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      await manager.stopVideo(presentationId)
      await playing
    })

    it('should abort the download', () => {
      expect(compositor.downloadVideo.mock.calls[0][1]?.aborted).toBe(true)
    })

    it('should not bake', () => {
      expect(components.mediaEncoder.bake).not.toHaveBeenCalled()
    })
  })

  describe('and the presenter stops while the bake is pending', () => {
    beforeEach(async () => {
      bakeUntilAborted()
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      await manager.stopVideo(presentationId)
      await playing
    })

    it('should abort the bake', () => {
      expect(bakeSignal(0).aborted).toBe(true)
    })

    it('should go idle', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('idle')
    })
  })

  describe('and the presenter plays the same video twice while it bakes', () => {
    beforeEach(async () => {
      const bake = createDeferred<{ videoPath: string; audioPath: string; bytes: number }>()
      components.mediaEncoder.bake.mockReturnValueOnce(bake.promise)
      await createSession()
      const first = manager.playVideo(presentationId, 0)
      const second = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      bake.resolve({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg', bytes: 10 })
      await Promise.all([first, second])
    })

    it('should send a single play command', () => {
      expect(sidecar.play).toHaveBeenCalledTimes(1)
    })
  })

  describe('and the presentation stops while the bake is still settling', () => {
    beforeEach(async () => {
      const bake = createDeferred<{ videoPath: string; audioPath: string; bytes: number }>()
      components.mediaEncoder.bake.mockReturnValueOnce(bake.promise)
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      const stopping = manager.stopPresentation(presentationId)
      bake.resolve({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg', bytes: 10 })
      await stopping
      await playing
    })

    it('should not play the video on the ended session', () => {
      expect(sidecar.play).not.toHaveBeenCalled()
    })
  })

  describe('and the presenter stops while the settled bake is still resuming the play', () => {
    beforeEach(async () => {
      const bake = createDeferred<{ videoPath: string; audioPath: string; bytes: number }>()
      const stop = createDeferred<void>()
      components.mediaEncoder.bake.mockReturnValueOnce(bake.promise)
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      sidecar.stopVideo.mockReturnValueOnce(stop.promise)
      const stopping = manager.stopVideo(presentationId)
      bake.resolve({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg', bytes: 10 })
      await flushMicrotasks()
      stop.resolve()
      await stopping
      await playing
    })

    it('should not play the stopped video', () => {
      expect(sidecar.play).not.toHaveBeenCalled()
    })
  })

  describe('and another video starts while the stopped one is still sending its play command', () => {
    const SECOND_VIDEO_URL = 'https://example.com/second.mp4'
    let firstPlay: ReturnType<typeof createDeferred<void>>
    let firstPlaying: Promise<void>

    beforeEach(async () => {
      firstPlay = createDeferred<void>()
      renderer.getSlideVideos.mockResolvedValue([
        { url: VIDEO_URL, geometry: { x: 100, y: 100, width: 640, height: 480 } },
        { url: SECOND_VIDEO_URL, geometry: { x: 100, y: 100, width: 640, height: 480 } }
      ])
      await createSession()
      sidecar.play.mockReturnValueOnce(firstPlay.promise)
      firstPlaying = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      await manager.stopVideo(presentationId)
      await manager.playVideo(presentationId, 1)
    })

    describe('and the stopped video play command then succeeds', () => {
      beforeEach(async () => {
        firstPlay.resolve()
        await firstPlaying
      })

      it('should not stop the newer video', () => {
        const [, secondPlayOrder] = sidecar.play.mock.invocationCallOrder
        expect(sidecar.stopVideo.mock.invocationCallOrder.filter((order) => order > secondPlayOrder)).toEqual([])
      })
    })

    describe('and the stopped video play command then fails', () => {
      beforeEach(async () => {
        firstPlay.reject(new Error('play failed'))
        await firstPlaying
      })

      it('should keep the newer video playing', () => {
        expect(manager.getState(presentationId)).toEqual(
          expect.objectContaining({ videoState: 'playing', playingVideoIndex: 1 })
        )
      })
    })
  })

  describe('and the presenter navigates while the loading broadcast is still in flight', () => {
    beforeEach(async () => {
      bakeUntilAborted()
      await createSession()
      sidecar.publishData.mockImplementation(async (message: Record<string, unknown>) => {
        if (message.type !== 'presentation:state' || message.videoState !== 'loading') return
        sidecar.publishData.mockResolvedValue(undefined)
        await manager.navigate(presentationId, 'next')
      })
      manager.playVideo(presentationId, 0).catch(() => undefined)
      await flushMicrotasks()
      await flushMicrotasks()
    })

    afterEach(async () => {
      await manager.stopPresentation(presentationId)
    })

    it('should not enqueue a play-priority bake for the slide that was left', () => {
      expect(components.mediaEncoder.bake).not.toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ priority: 'play' })
      )
    })

    it('should leave the session idle', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('idle')
    })
  })

  describe('and the presenter navigates while the bake is pending', () => {
    beforeEach(async () => {
      bakeUntilAborted()
      await createSession()
      const playing = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      await manager.navigate(presentationId, 'next')
      await playing
    })

    it('should abort the bake', () => {
      expect(bakeSignal(0).aborted).toBe(true)
    })
  })

  describe('and the sidecar resume rejects', () => {
    beforeEach(async () => {
      sidecar.resume.mockRejectedValueOnce(new Error('Sidecar resume timed out'))
      await createSession()
      await manager.playVideo(presentationId, 0)
      await manager.pauseVideo(presentationId)
      await manager.playVideo(presentationId, 0)
    })

    it('should put the video in the playback-failed error state', () => {
      expect(manager.getState(presentationId)).toEqual(
        expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-playback-failed' })
      )
    })

    it('should report the message that matches the playback-failed code, not a download message', () => {
      expect(manager.getState(presentationId)?.videoErrorReason).toBe('Video unavailable')
    })

    describe('and the presenter plays it again', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 0)
      })

      it('should play', () => {
        expect(manager.getState(presentationId)?.videoState).toBe('playing')
      })
    })
  })

  describe('and the presenter navigates while a resume is pending', () => {
    let statesAfterNavigation: Array<Record<string, unknown>>

    beforeEach(async () => {
      const resume = createDeferred<void>()
      sidecar.resume.mockReturnValueOnce(resume.promise)
      await createSession()
      await manager.playVideo(presentationId, 0)
      await manager.pauseVideo(presentationId)
      const resuming = manager.playVideo(presentationId, 0)
      await flushMicrotasks()
      const before = stateBroadcasts().length
      await manager.navigate(presentationId, 'next')
      resume.resolve()
      await resuming
      statesAfterNavigation = stateBroadcasts().slice(before)
    })

    it('should go idle', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('idle')
    })

    it('should stop the sidecar playback', () => {
      expect(sidecar.stopVideo).toHaveBeenCalled()
    })

    it('should not broadcast playing after the navigation', () => {
      expect(statesAfterNavigation.map((s) => s.videoState)).not.toContain('playing')
    })
  })

  describe('and the video ends while a pause is pending', () => {
    beforeEach(async () => {
      const pause = createDeferred<void>()
      sidecar.pause.mockReturnValueOnce(pause.promise)
      await createSession()
      await manager.playVideo(presentationId, 0)
      const pausing = manager.pauseVideo(presentationId)
      await flushMicrotasks()
      sidecar.onPlaybackEnded.mock.calls[0][0]()
      await flushMicrotasks()
      pause.resolve()
      await pausing
    })

    it('should stay idle', () => {
      expect(manager.getState(presentationId)?.videoState).toBe('idle')
    })
  })

  describe('and every bake fails', () => {
    beforeEach(async () => {
      components.mediaEncoder.bake.mockRejectedValue(new Error('Bake failed (code 1): boom'))
      await createSession()
      await manager.playVideo(presentationId, 0)
    })

    it('should put the video in the playback-failed error state', () => {
      expect(manager.getState(presentationId)).toEqual(
        expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-playback-failed' })
      )
    })

    describe('and the presenter plays it again', () => {
      let bakesBefore: number

      beforeEach(async () => {
        bakesBefore = components.mediaEncoder.bake.mock.calls.length
        await manager.playVideo(presentationId, 0)
      })

      it('should bake again', () => {
        expect(components.mediaEncoder.bake).toHaveBeenCalledTimes(bakesBefore + 1)
      })
    })
  })

  describe('and the sidecar fails fatally', () => {
    beforeEach(async () => {
      await createSession()
      sidecar.onFatal.mock.calls[0][0]('Sidecar exited (code=1)')
      await flushMicrotasks()
    })

    it('should stop the session', () => {
      expect(manager.getState(presentationId)).toBeNull()
    })

    it('should disconnect the sidecar', () => {
      expect(sidecar.disconnect).toHaveBeenCalled()
    })
  })

  describe('and a presenter claims the session', () => {
    beforeEach(async () => {
      await createSession()
      sidecar.publishData.mockClear()
      sidecar.updateMetadataState.mockClear()
      sidecar.setDataHandler.mock.calls[0][0]({ type: 'presentation:presenter:claim' }, 'stream:new:2')
      await flushMicrotasks()
    })

    it('should broadcast the new presenterIdentity', () => {
      expect(stateBroadcasts()[0]).toEqual(expect.objectContaining({ presenterIdentity: 'stream:new:2' }))
    })

    it('should put the new presenterIdentity in the bot metadata', () => {
      expect(sidecar.updateMetadataState.mock.calls[0][0]).toEqual(
        expect.objectContaining({ presenterIdentity: 'stream:new:2' })
      )
    })
  })

  describe('and the session is stopped with a pending bake', () => {
    beforeEach(async () => {
      bakeUntilAborted()
      await createSession()
      await manager.stopPresentation(presentationId)
    })

    it('should abort the bake', () => {
      expect(bakeSignal(0).aborted).toBe(true)
    })
  })
})

describe('when client composition is disabled', () => {
  let components: ReturnType<typeof createMockComponents>
  let publisher: jest.Mocked<ILiveKitPublisher>
  let manager: IPresentationManager

  beforeEach(async () => {
    publisher = createMockPublisher()
    components = createMockComponents({ publisher })
    manager = await createManager(components)
    await createPdfSession(manager, 'stream:p:1')
  })

  afterEach(() => {
    jest.mocked(encodeSlidePng).mockReset()
  })

  describe('and a session is created', () => {
    let state: Record<string, unknown>

    beforeEach(() => {
      state = publisher.publishData.mock.calls[0][0]
    })

    it('should not include any client-composition field in the state', () => {
      expect(['slide', 'presenterIdentity', 'playingVideoIndex'].filter((key) => key in state)).toEqual([])
    })

    it('should not encode a slide image', () => {
      expect(encodeSlidePng).not.toHaveBeenCalled()
    })
  })

  describe('and a presenter claims the session', () => {
    beforeEach(async () => {
      publisher.publishData.mockClear()
      publisher.updateMetadataState.mockClear()
      publisher.setDataHandler.mock.calls[0][0]({ type: 'presentation:presenter:claim' }, 'stream:x:1')
      await flushMicrotasks()
    })

    it('should not publish any state', () => {
      expect(publisher.publishData).not.toHaveBeenCalled()
    })

    it('should not update the bot metadata', () => {
      expect(publisher.updateMetadataState).not.toHaveBeenCalled()
    })
  })
})
