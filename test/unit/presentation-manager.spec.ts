import { DEFAULT_OVERLAY_LAYOUT } from '../../src/logic/overlay-layout'
import {
  InvalidLivekitCredentialsError,
  PresentationNotFoundError,
  createPresentationManager
} from '../../src/logic/presentation-manager'
import type { ILiveKitPublisher } from '../../src/adapters/livekit-publisher/types'
import type { IRenderer } from '../../src/adapters/renderer/types'
import type { IVideoCompositor } from '../../src/adapters/video-compositor/types'
import type { OverlayLayout } from '../../src/logic/overlay-layout'
import type { IPresentationManager } from '../../src/logic/presentation-manager'

function createMockPublisher(): jest.Mocked<ILiveKitPublisher> {
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
    disconnect: jest.fn().mockResolvedValue(undefined)
  }
}

function createMockRenderer(): jest.Mocked<IRenderer> {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    renderSlide: jest.fn().mockResolvedValue({ buffer: Buffer.alloc(100), width: 1920, height: 1080 }),
    getSlideVideos: jest.fn().mockResolvedValue([]),
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

async function createManagerWithSession(components: ReturnType<typeof createMockComponents>) {
  const manager = await createPresentationManager(
    components as unknown as Parameters<typeof createPresentationManager>[0]
  )
  const info = await manager.createPresentation(
    Buffer.from('%PDF-1.7'),
    'pdf',
    'test-token',
    'wss://lk.example.com',
    'test.pdf'
  )
  return { manager, info }
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
      const manager = await createPresentationManager(
        components as unknown as Parameters<typeof createPresentationManager>[0]
      )
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
      const manager = await createPresentationManager(
        components as unknown as Parameters<typeof createPresentationManager>[0]
      )
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
      const manager = await createPresentationManager(
        components as unknown as Parameters<typeof createPresentationManager>[0]
      )
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
      const manager = await createPresentationManager(
        components as unknown as Parameters<typeof createPresentationManager>[0]
      )

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
      const manager = await createPresentationManager(
        components as unknown as Parameters<typeof createPresentationManager>[0]
      )

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
        manager = await createPresentationManager(
          components as unknown as Parameters<typeof createPresentationManager>[0]
        )
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
