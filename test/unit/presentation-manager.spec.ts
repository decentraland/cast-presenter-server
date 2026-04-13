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
    downloadVideo: jest.fn().mockResolvedValue('/tmp/video.mp4'),
    resolveStreamUrl: jest.fn().mockResolvedValue('https://example.com/video.mp4'),
    preTranscode: jest.fn().mockResolvedValue('/tmp/transcoded.mp4'),
    startPlayback: jest.fn().mockResolvedValue(undefined),
    pausePlayback: jest.fn(),
    resumePlayback: jest.fn(),
    onEnd: jest.fn(),
    getIsPlaying: jest.fn().mockReturnValue(false),
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
})
