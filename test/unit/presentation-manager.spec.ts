import { PresentationNotFoundError, createPresentationManager } from '../../src/logic/presentation-manager'
import type { ILiveKitPublisher } from '../../src/adapters/livekit-publisher/types'
import type { IPdfRenderer } from '../../src/adapters/pdf-renderer/types'
import type { IVideoCompositor } from '../../src/adapters/video-compositor/types'
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

function createMockRenderer(): jest.Mocked<IPdfRenderer> {
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
})
