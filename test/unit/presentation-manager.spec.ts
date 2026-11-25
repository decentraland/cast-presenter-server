import fs from 'fs'
import { LivekitConnectError } from '../../src/adapters/sidecar-publisher/errors'
import { DEFAULT_OVERLAY_LAYOUT } from '../../src/logic/overlay-layout'
import {
  InvalidLivekitCredentialsError,
  PresentationNotFoundError,
  createPresentationManager
} from '../../src/logic/presentation-manager'
import { SESSION_DISK_QUOTA_BYTES } from '../../src/logic/presentation-manager/component'
import type { ISidecarPublisher } from '../../src/adapters/sidecar-publisher/types'
import type { ISlideRenderer } from '../../src/adapters/slide-renderer/types'
import type { OverlayLayout } from '../../src/logic/overlay-layout'
import type { IPresentationManager } from '../../src/logic/presentation-manager'

const PUBLIC_BASE_URL = 'https://cast.example.com'

function createMockPublisher(): jest.Mocked<ISidecarPublisher> {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
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

function createMockRenderer(): jest.Mocked<ISlideRenderer> {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    renderSlide: jest.fn().mockResolvedValue({ hash: 'h1', png: Buffer.from('png1'), width: 1920, height: 1080 }),
    getSlideVideos: jest.fn().mockResolvedValue([]),
    getEmbeddedMediaDir: jest.fn().mockReturnValue(null),
    getSlideCount: jest.fn().mockReturnValue(3),
    destroy: jest.fn()
  }
}

function createMockComponents(overrides?: { publisher?: jest.Mocked<ISidecarPublisher> }) {
  const publisher = overrides?.publisher ?? createMockPublisher()
  return {
    config: {
      getString: jest.fn(async (key: string) => (key === 'PUBLIC_BASE_URL' ? PUBLIC_BASE_URL : undefined)),
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
    sidecarPublisher: {
      createPublisher: jest.fn().mockReturnValue(publisher)
    },
    mediaEncoder: {
      bake: jest.fn().mockResolvedValue({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg', bytes: 10 }),
      promote: jest.fn(),
      resolveEmbeddedVideo: jest.fn().mockReturnValue(null)
    },
    videoDuration: {
      getDurationMs: jest.fn().mockResolvedValue(null)
    },
    slideRenderer: {
      createRenderer: jest.fn().mockReturnValue(createMockRenderer())
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
  let publisher: jest.Mocked<ISidecarPublisher>

  describe('and the connect succeeds', () => {
    beforeEach(() => {
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
    })

    it('should create the throw-away publisher through the sidecar factory', async () => {
      const manager = await createManager(components)
      await manager.validateCredentials('wss://lk.example.com', 'good-token')
      expect(components.sidecarPublisher.createPublisher).toHaveBeenCalledWith('validate', expect.anything())
    })

    it('should resolve and disconnect the throw-away publisher', async () => {
      const manager = await createManager(components)
      await expect(manager.validateCredentials('wss://lk.example.com', 'good-token')).resolves.toBeUndefined()
      expect(publisher.connect).toHaveBeenCalledWith('wss://lk.example.com', 'good-token')
      expect(publisher.disconnect).toHaveBeenCalled()
    })
  })

  describe('and the connect rejects with a LiveKit connect error', () => {
    let outcome: unknown

    beforeEach(async () => {
      publisher = createMockPublisher()
      publisher.connect.mockRejectedValue(new LivekitConnectError('LiveKit connect failed: token rejected'))
      components = createMockComponents({ publisher })
      const manager = await createManager(components)
      outcome = await manager.validateCredentials('wss://lk.example.com', 'bad-token').catch((err: unknown) => err)
    })

    it('should reject the credentials through the sidecar factory publisher', () => {
      expect(components.sidecarPublisher.createPublisher).toHaveBeenCalledWith('validate', expect.anything())
    })

    it('should throw InvalidLivekitCredentialsError', () => {
      expect(outcome).toBeInstanceOf(InvalidLivekitCredentialsError)
    })

    it('should still disconnect the throw-away publisher', () => {
      expect(publisher.disconnect).toHaveBeenCalled()
    })
  })

  describe('and the connect fails for a reason other than the LiveKit connection', () => {
    let failure: Error
    let outcome: unknown

    beforeEach(async () => {
      failure = new Error('LiveKit connect failed: Sidecar exited (code=1, signal=null)')
      publisher = createMockPublisher()
      publisher.connect.mockRejectedValue(failure)
      components = createMockComponents({ publisher })
      const manager = await createManager(components)
      outcome = await manager.validateCredentials('wss://lk.example.com', 'good-token').catch((err: unknown) => err)
    })

    it('should rethrow the original error', () => {
      expect(outcome).toBe(failure)
    })

    it('should still disconnect the throw-away publisher', () => {
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
      components.slideRenderer.createRenderer.mockReturnValue(renderer)
    })

    it('should throw an error about no pages', async () => {
      const manager = await createManager(components)
      await expect(
        manager.createPresentation(Buffer.from('%PDF-1.7'), 'pdf', 'token', 'wss://lk.example.com')
      ).rejects.toThrow('PDF contains no pages')
    })
  })

  describe('and publisher.connect() throws', () => {
    let publisher: jest.Mocked<ISidecarPublisher>

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
  let publisher: jest.Mocked<ISidecarPublisher>
  let dataHandler: (message: Record<string, unknown>) => Promise<void>

  beforeEach(async () => {
    publisher = createMockPublisher()
    components = createMockComponents({ publisher })

    const renderer = createMockRenderer()
    renderer.getSlideVideos.mockResolvedValue([
      { url: 'https://example.com/video.mp4', geometry: { x: 100, y: 100, width: 640, height: 480 } }
    ])
    components.slideRenderer.createRenderer.mockReturnValue(renderer)

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
  let publisher: jest.Mocked<ISidecarPublisher>
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

describe('when stopping video playback', () => {
  let manager: IPresentationManager
  let components: ReturnType<typeof createMockComponents>
  let publisher: jest.Mocked<ISidecarPublisher>

  describe('and no video is playing', () => {
    beforeEach(async () => {
      publisher = createMockPublisher()
      components = createMockComponents({ publisher })
      const result = await createManagerWithSession(components)
      manager = result.manager
      publisher.publishData.mockClear()
      await manager.stopVideo(result.info.id)
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

describe('when presenting through the sidecar', () => {
  const PRESENTER_IDENTITY = 'stream:p:1'
  const VIDEO_URL = 'https://example.com/video.mp4'
  const EMBEDDED_PATH = '/tmp/cast-pptx-video-a/v.mp4'
  const YOUTUBE_URL = 'https://youtu.be/dQw4w9WgXcQ'
  const GEOMETRY = { x: 100, y: 100, width: 640, height: 480 }
  const NOW = 1760270400000
  let components: ReturnType<typeof createMockComponents>
  let sidecar: jest.Mocked<ISidecarPublisher>
  let configValues: Record<string, string | undefined>
  let manager: IPresentationManager
  let presentationId: string
  let renderCount: number
  let renderer: jest.Mocked<ISlideRenderer>
  let rmSync: jest.SpyInstance

  function stateBroadcasts(): Array<Record<string, unknown>> {
    return sidecar.publishData.mock.calls.map(([message]) => message).filter((m) => m.type === 'presentation:state')
  }

  function lastSlideUrl(): unknown {
    const states = stateBroadcasts()
    return (states[states.length - 1].slide as { url: string }).url
  }

  function lastPlayId(): number {
    const calls = sidecar.play.mock.calls
    return calls[calls.length - 1][1]
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

  function embedOnly(urls: string[]): void {
    components.mediaEncoder.resolveEmbeddedVideo.mockImplementation((url: string) =>
      urls.includes(url) ? { path: EMBEDDED_PATH, bytes: 0 } : null
    )
  }

  function lastState(): Record<string, unknown> {
    const states = stateBroadcasts()
    return states[states.length - 1]
  }

  beforeEach(async () => {
    rmSync = jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined)
    configValues = { PUBLIC_BASE_URL: `${PUBLIC_BASE_URL}/` }
    sidecar = createMockPublisher()
    components = createMockComponents({ publisher: sidecar })
    components.config.getString.mockImplementation(async (key: string) => configValues[key])
    renderer = createMockRenderer()
    renderCount = 0
    renderer.renderSlide.mockImplementation(async () => {
      renderCount++
      return { hash: `h${renderCount}`, png: Buffer.from(`png${renderCount}`), width: 1920, height: 1080 }
    })
    renderer.getSlideCount.mockReturnValue(10)
    renderer.getSlideVideos.mockResolvedValue([
      { url: VIDEO_URL, geometry: { x: 100, y: 100, width: 640, height: 480 } }
    ])
    components.slideRenderer.createRenderer.mockReturnValue(renderer)
    embedOnly([VIDEO_URL])
    manager = await createManager(components)
  })

  afterEach(() => {
    rmSync.mockRestore()
  })

  describe('and PUBLIC_BASE_URL is unset', () => {
    beforeEach(() => {
      configValues.PUBLIC_BASE_URL = undefined
    })

    it('should reject creating the manager with an https requirement', async () => {
      await expect(createManager(components)).rejects.toThrow('PUBLIC_BASE_URL must be an https:// URL')
    })
  })

  describe.each([
    ['has no scheme', 'cast.example.com'],
    ['uses http on a public host', 'http://cast.example.com'],
    ['has a query string', 'https://cast.example.com?a=1'],
    ['has a fragment', 'https://cast.example.com#f'],
    ['has credentials', 'https://user:pass@cast.example.com']
  ])('and PUBLIC_BASE_URL %s', (_label, value) => {
    beforeEach(() => {
      configValues.PUBLIC_BASE_URL = value
    })

    it('should reject creating the manager with an https requirement', async () => {
      await expect(createManager(components)).rejects.toThrow('PUBLIC_BASE_URL must be an https:// URL')
    })
  })

  describe('and PUBLIC_BASE_URL uses http on localhost', () => {
    beforeEach(() => {
      configValues.PUBLIC_BASE_URL = 'http://localhost:5000'
    })

    it('should create the manager', async () => {
      await expect(createManager(components)).resolves.toBeDefined()
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

    it('should create the slide renderer for the PDF file type', () => {
      expect(components.slideRenderer.createRenderer).toHaveBeenCalledWith('pdf')
    })

    it('should start the prefetch bake right away', () => {
      expect(components.mediaEncoder.bake).toHaveBeenCalledWith(EMBEDDED_PATH, expect.any(String), {
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

    describe('and rendering the next slide fails', () => {
      let navigation: Promise<unknown>

      beforeEach(async () => {
        renderer.renderSlide.mockRejectedValueOnce(new Error('render failed'))
        sidecar.publishData.mockClear()
        navigation = manager.navigate(presentationId, 'next')
        await navigation.catch(() => undefined)
      })

      it('should broadcast the state of the current slide', () => {
        expect(sidecar.publishData).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'presentation:state', currentSlide: 0, videoState: 'idle' })
        )
      })

      it('should reject the navigation with the render error', async () => {
        await expect(navigation).rejects.toThrow('render failed')
      })

      it('should stay on the current slide', () => {
        expect(manager.getState(presentationId)?.currentSlide).toBe(0)
      })

      it('should keep the previous slide url', () => {
        expect(manager.getState(presentationId)?.slide?.url).toBe(
          `${PUBLIC_BASE_URL}/presentations/${presentationId}/slides/h1.png`
        )
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
        expect(sidecar.play).toHaveBeenCalledWith(
          { videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg' },
          expect.any(Number)
        )
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

        it('should reuse the first bake instead of repeating it', () => {
          expect(components.mediaEncoder.bake).toHaveBeenCalledTimes(1)
        })
      })

      describe('and the sidecar reports the natural end', () => {
        beforeEach(async () => {
          sidecar.onPlaybackEnded.mock.calls[0][0](lastPlayId())
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
          sidecar.onPlaybackFailed.mock.calls[0][0]('read v.h264: input/output error', lastPlayId())
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

      describe('and the presenter replays it and the first playback reports a late end', () => {
        let firstPlayId: number

        beforeEach(async () => {
          firstPlayId = lastPlayId()
          await manager.stopVideo(presentationId)
          await manager.playVideo(presentationId, 0)
          sidecar.onPlaybackEnded.mock.calls[0][0](firstPlayId)
          await flushMicrotasks()
        })

        it('should keep playing the replay', () => {
          expect(manager.getState(presentationId)?.videoState).toBe('playing')
        })
      })

      describe('and the presenter pauses and the clip ends before the resume ack is handled', () => {
        beforeEach(async () => {
          await manager.pauseVideo(presentationId)
          const playId = lastPlayId()
          sidecar.resume.mockImplementationOnce(async () => {
            sidecar.onPlaybackEnded.mock.calls[0][0](playId)
          })
          await manager.playVideo(presentationId, 0)
          await flushMicrotasks()
        })

        it('should go idle instead of staying in playing', () => {
          expect(manager.getState(presentationId)?.videoState).toBe('idle')
        })
      })
    })

    describe('and the sidecar reports the end before the play ack is handled', () => {
      beforeEach(async () => {
        sidecar.play.mockImplementationOnce(async (_files, playId) => {
          sidecar.onPlaybackEnded.mock.calls[0][0](playId)
        })
        await manager.playVideo(presentationId, 0)
        await flushMicrotasks()
      })

      it('should go idle instead of staying in playing', () => {
        expect(manager.getState(presentationId)?.videoState).toBe('idle')
      })

      it('should never broadcast playing', () => {
        expect(stateBroadcasts().map((s) => s.videoState)).not.toContain('playing')
      })
    })

    describe('and the sidecar reports a failure before the play ack is handled', () => {
      beforeEach(async () => {
        sidecar.play.mockImplementationOnce(async (_files, playId) => {
          sidecar.onPlaybackFailed.mock.calls[0][0]('read v.h264: unexpected EOF', playId)
        })
        await manager.playVideo(presentationId, 0)
        await flushMicrotasks()
      })

      it('should put the video in the interrupted error state', () => {
        expect(manager.getState(presentationId)).toEqual(
          expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-playback-interrupted' })
        )
      })
    })
  })

  describe('and rendering the first slide fails', () => {
    let creation: Promise<unknown>

    beforeEach(async () => {
      renderer.renderSlide.mockRejectedValueOnce(new Error('render failed'))
      creation = createPdfSession(manager)
      await creation.catch(() => undefined)
    })

    it('should reject creating the presentation with the render error', async () => {
      await expect(creation).rejects.toThrow('render failed')
    })

    it('should destroy the slide renderer', () => {
      expect(renderer.destroy).toHaveBeenCalled()
    })

    it('should disconnect the sidecar', () => {
      expect(sidecar.disconnect).toHaveBeenCalled()
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

      it('should bake the embedded file', () => {
        expect(components.mediaEncoder.bake.mock.calls[0][0]).toBe(EMBEDDED_PATH)
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
      embedOnly([VIDEO_URL, SECOND_VIDEO_URL])
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
      sidecar.onPlaybackEnded.mock.calls[0][0](lastPlayId())
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

  describe('and the session is stopped', () => {
    beforeEach(async () => {
      await createSession()
      await manager.stopPresentation(presentationId)
    })

    it('should destroy the session slide renderer', () => {
      expect(renderer.destroy).toHaveBeenCalledTimes(1)
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

  describe('and the slide video is a YouTube short link', () => {
    beforeEach(async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      jest.setSystemTime(NOW)
      renderer.getSlideVideos.mockResolvedValue([{ url: YOUTUBE_URL, geometry: GEOMETRY }])
      await createSession()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should broadcast the canonical url with the client source', () => {
      expect(lastState().slideVideos).toEqual([
        { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', geometry: GEOMETRY, source: 'client' }
      ])
    })

    it('should broadcast null position fields', () => {
      expect([lastState().videoPositionMs, lastState().videoPositionAt]).toEqual([null, null])
    })

    describe('and play is requested', () => {
      let duration: ReturnType<typeof createDeferred<number | null>>

      beforeEach(async () => {
        duration = createDeferred<number | null>()
        components.videoDuration.getDurationMs.mockReturnValue(duration.promise)
        await manager.playVideo(presentationId, 0)
      })

      it('should broadcast playing at position 0 anchored at the play time', () => {
        expect(lastState()).toEqual(
          expect.objectContaining({
            videoState: 'playing',
            playingVideoIndex: 0,
            videoPositionMs: 0,
            videoPositionAt: NOW
          })
        )
      })

      it('should look up the duration of the canonical video', () => {
        expect(components.videoDuration.getDurationMs).toHaveBeenCalledWith({
          provider: 'youtube',
          id: 'dQw4w9WgXcQ',
          url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
        })
      })

      it('should not bake or play anything on the sidecar', () => {
        expect([components.mediaEncoder.bake.mock.calls.length, sidecar.play.mock.calls.length]).toEqual([0, 0])
      })

      describe('and the duration is 10 s', () => {
        beforeEach(async () => {
          duration.resolve(10_000)
          await flushMicrotasks()
        })

        describe('and 11.9 s pass', () => {
          beforeEach(async () => {
            await jest.advanceTimersByTimeAsync(11_900)
          })

          it('should still be playing', () => {
            expect(lastState().videoState).toBe('playing')
          })
        })

        describe('and 12 s pass', () => {
          beforeEach(async () => {
            await jest.advanceTimersByTimeAsync(12_000)
          })

          it('should broadcast idle with no playing video and null position fields', () => {
            expect(lastState()).toEqual(
              expect.objectContaining({
                videoState: 'idle',
                playingVideoIndex: null,
                videoPositionMs: null,
                videoPositionAt: null
              })
            )
          })

          it('should count the natural end', () => {
            expect(components.metrics.increment).toHaveBeenCalledWith('video_playback_total', { action: 'end' })
          })
        })

        describe('and it is paused at 4 s', () => {
          beforeEach(async () => {
            await jest.advanceTimersByTimeAsync(4_000)
            await manager.pauseVideo(presentationId)
          })

          it('should broadcast paused at position 4000', () => {
            expect(lastState()).toEqual(expect.objectContaining({ videoState: 'paused', videoPositionMs: 4_000 }))
          })

          it('should not pause the sidecar', () => {
            expect(sidecar.pause).not.toHaveBeenCalled()
          })

          describe('and 60 s pass', () => {
            beforeEach(async () => {
              await jest.advanceTimersByTimeAsync(60_000)
            })

            it('should stay paused', () => {
              expect(lastState().videoState).toBe('paused')
            })

            describe('and it is resumed', () => {
              beforeEach(async () => {
                await manager.playVideo(presentationId, 0)
                await flushMicrotasks()
              })

              it('should broadcast playing at position 4000 anchored at the resume time', () => {
                expect(lastState()).toEqual(
                  expect.objectContaining({
                    videoState: 'playing',
                    videoPositionMs: 4_000,
                    videoPositionAt: NOW + 64_000
                  })
                )
              })

              describe('and 7.9 s pass', () => {
                beforeEach(async () => {
                  await jest.advanceTimersByTimeAsync(7_900)
                })

                it('should still be playing', () => {
                  expect(lastState().videoState).toBe('playing')
                })
              })

              describe('and 8 s pass', () => {
                beforeEach(async () => {
                  await jest.advanceTimersByTimeAsync(8_000)
                })

                it('should broadcast idle', () => {
                  expect(lastState().videoState).toBe('idle')
                })
              })
            })
          })
        })

        describe('and it is stopped before the end', () => {
          let statesBefore: number

          beforeEach(async () => {
            await manager.stopVideo(presentationId)
            statesBefore = stateBroadcasts().length
            await jest.advanceTimersByTimeAsync(12_000)
          })

          it('should not broadcast any state afterwards', () => {
            expect(stateBroadcasts().slice(statesBefore)).toEqual([])
          })

          it('should not stop the sidecar', () => {
            expect(sidecar.stopVideo).not.toHaveBeenCalled()
          })
        })

        describe('and the slide changes before the end', () => {
          let statesBefore: number

          beforeEach(async () => {
            await manager.navigate(presentationId, 'next')
            statesBefore = stateBroadcasts().length
            await jest.advanceTimersByTimeAsync(12_000)
          })

          it('should not broadcast any state afterwards', () => {
            expect(stateBroadcasts().slice(statesBefore)).toEqual([])
          })

          it('should not stop the sidecar', () => {
            expect(sidecar.stopVideo).not.toHaveBeenCalled()
          })
        })

        describe('and the sidecar reports playbackEnded while it plays', () => {
          beforeEach(async () => {
            sidecar.onPlaybackEnded.mock.calls[0][0](0)
            await flushMicrotasks()
          })

          it('should still be playing', () => {
            expect(manager.getState(presentationId)?.videoState).toBe('playing')
          })
        })

        describe('and the sidecar reports a playback failure while it plays', () => {
          beforeEach(async () => {
            sidecar.onPlaybackFailed.mock.calls[0][0]('read v.h264: input/output error', 0)
            await flushMicrotasks()
          })

          it('should still be playing', () => {
            expect(manager.getState(presentationId)?.videoState).toBe('playing')
          })
        })

        describe('and the presentation stops before the end', () => {
          beforeEach(async () => {
            await manager.stopPresentation(presentationId)
          })

          it('should clear the end timer', () => {
            expect(jest.getTimerCount()).toBe(0)
          })

          describe('and 12 s pass', () => {
            let messagesAfterStop: unknown[]

            beforeEach(async () => {
              await jest.advanceTimersByTimeAsync(12_000)
              const types = sidecar.publishData.mock.calls.map(([message]) => message.type)
              messagesAfterStop = types.slice(types.indexOf('presentation:stopped') + 1)
            })

            it('should not publish anything after presentation:stopped', () => {
              expect(messagesAfterStop).toEqual([])
            })
          })
        })
      })

      describe('and the duration is unknown', () => {
        beforeEach(async () => {
          duration.resolve(null)
          await flushMicrotasks()
          await jest.advanceTimersByTimeAsync(10 * 60_000)
        })

        it('should keep playing', () => {
          expect(lastState().videoState).toBe('playing')
        })
      })

      describe('and the duration resolves after a pause', () => {
        beforeEach(async () => {
          await manager.pauseVideo(presentationId)
          duration.resolve(10_000)
          await flushMicrotasks()
        })

        it('should not arm an end timer', () => {
          expect(jest.getTimerCount()).toBe(0)
        })

        describe('and 10 minutes pass', () => {
          beforeEach(async () => {
            await jest.advanceTimersByTimeAsync(10 * 60_000)
          })

          it('should stay paused', () => {
            expect(lastState().videoState).toBe('paused')
          })
        })
      })
    })
  })

  describe('and an embedded video is paused on a slide that also has a YouTube video', () => {
    beforeEach(async () => {
      renderer.getSlideVideos.mockResolvedValue([
        { url: VIDEO_URL, geometry: GEOMETRY },
        { url: YOUTUBE_URL, geometry: GEOMETRY }
      ])
      await createSession()
      await manager.playVideo(presentationId, 0)
      await manager.pauseVideo(presentationId)
    })

    describe('and the YouTube video is played', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 1)
      })

      it('should stop the sidecar once and play the YouTube video', () => {
        expect([sidecar.stopVideo.mock.calls.length, lastState().videoState, lastState().playingVideoIndex]).toEqual([
          1,
          'playing',
          1
        ])
      })
    })

    describe('and a pause arrives before the sidecar stop resolves', () => {
      beforeEach(async () => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        components.videoDuration.getDurationMs.mockResolvedValue(10_000)
        const stop = createDeferred<void>()
        sidecar.stopVideo.mockReturnValueOnce(stop.promise)
        const playing = manager.playVideo(presentationId, 1)
        await flushMicrotasks()
        await manager.pauseVideo(presentationId)
        stop.resolve()
        await playing
        await flushMicrotasks()
        await jest.advanceTimersByTimeAsync(10 * 60_000)
      })

      afterEach(() => {
        jest.useRealTimers()
      })

      it('should stay paused on the YouTube video', () => {
        expect(manager.getState(presentationId)).toEqual(
          expect.objectContaining({ videoState: 'paused', playingVideoIndex: 1 })
        )
      })

      it('should never broadcast playing after the pause', () => {
        const states = stateBroadcasts().map((state) => state.videoState)
        expect(states.slice(states.lastIndexOf('paused'))).toEqual(['paused'])
      })
    })

    describe('and the sidecar stop fails while switching to the YouTube video', () => {
      beforeEach(async () => {
        sidecar.stopVideo.mockRejectedValueOnce(new Error('stop failed'))
        await manager.playVideo(presentationId, 1)
      })

      it('should end with the error event and the error state, without broadcasting playing', () => {
        expect(sidecar.publishData.mock.calls.slice(-2).map(([message]) => [message.type, message.videoState])).toEqual(
          [
            ['presentation:error', undefined],
            ['presentation:state', 'error']
          ]
        )
      })
    })
  })

  describe('and a YouTube video is paused on a slide that also has another YouTube video and an embedded video', () => {
    beforeEach(async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      jest.setSystemTime(NOW)
      renderer.getSlideVideos.mockResolvedValue([
        { url: YOUTUBE_URL, geometry: GEOMETRY },
        { url: 'https://youtu.be/9bZkp7q19f0', geometry: GEOMETRY },
        { url: VIDEO_URL, geometry: GEOMETRY }
      ])
      await createSession()
      await manager.playVideo(presentationId, 0)
      await jest.advanceTimersByTimeAsync(4_000)
      await manager.pauseVideo(presentationId)
      await jest.advanceTimersByTimeAsync(1_000)
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    describe('and the other YouTube video is played', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 1)
      })

      it('should broadcast it playing from position 0 anchored at the play time', () => {
        expect(lastState()).toEqual(
          expect.objectContaining({
            videoState: 'playing',
            playingVideoIndex: 1,
            videoPositionMs: 0,
            videoPositionAt: NOW + 5_000
          })
        )
      })

      it('should not stop the sidecar', () => {
        expect(sidecar.stopVideo).not.toHaveBeenCalled()
      })
    })

    describe('and the embedded video is played', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 2)
      })

      it('should not stop the sidecar', () => {
        expect(sidecar.stopVideo).not.toHaveBeenCalled()
      })

      it('should play the embedded video on the sidecar once', () => {
        expect(sidecar.play).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('and the deck has more YouTube videos than the prefetch limit before an embedded video', () => {
    beforeEach(async () => {
      renderer.getSlideCount.mockReturnValue(11)
      renderer.getSlideVideos.mockImplementation(async (slide: number) => [
        { url: slide < 10 ? `https://youtu.be/dQw4w9WgXc${slide}` : VIDEO_URL, geometry: GEOMETRY }
      ])
      await createSession()
    })

    it('should prefetch only the embedded video', () => {
      expect(components.mediaEncoder.bake.mock.calls).toEqual([
        [EMBEDDED_PATH, expect.any(String), { priority: 'prefetch', signal: expect.any(AbortSignal) }]
      ])
    })
  })

  describe('and the slide video is a Google Drive link', () => {
    const DRIVE_FILE_ID = 'fakeDriveFile_01'

    beforeEach(async () => {
      renderer.getSlideVideos.mockResolvedValue([
        { url: `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view?usp=sharing`, geometry: GEOMETRY }
      ])
      await createSession()
    })

    describe('and it is not played', () => {
      it('should not report the file as playing', () => {
        expect(manager.isDriveFilePlaying(DRIVE_FILE_ID)).toBe(false)
      })
    })

    describe('and play is requested', () => {
      beforeEach(async () => {
        await manager.playVideo(presentationId, 0)
      })

      afterEach(async () => {
        await manager.stopPresentation(presentationId)
      })

      it('should report the file as playing', () => {
        expect(manager.isDriveFilePlaying(DRIVE_FILE_ID)).toBe(true)
      })

      it('should not report another file as playing', () => {
        expect(manager.isDriveFilePlaying('otherDriveFile_02')).toBe(false)
      })

      describe('and it is paused', () => {
        beforeEach(async () => {
          await manager.pauseVideo(presentationId)
        })

        it('should still report the file as playing', () => {
          expect(manager.isDriveFilePlaying(DRIVE_FILE_ID)).toBe(true)
        })
      })

      describe('and it is stopped', () => {
        beforeEach(async () => {
          await manager.stopVideo(presentationId)
        })

        it('should not report the file as playing', () => {
          expect(manager.isDriveFilePlaying(DRIVE_FILE_ID)).toBe(false)
        })
      })
    })
  })

  describe('and the slide video is a vimeo.com page link', () => {
    beforeEach(async () => {
      renderer.getSlideVideos.mockResolvedValue([{ url: 'https://vimeo.com/123', geometry: GEOMETRY }])
      await createSession()
      await manager.playVideo(presentationId, 0)
    })

    it('should publish an invalid-format error with the supported-links message', () => {
      expect(sidecar.publishData).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'presentation:error',
          code: 'video-invalid-format',
          message: 'Unsupported video link — use YouTube, Google Drive or a Vimeo .m3u8 link'
        })
      )
    })

    it('should not bake', () => {
      expect(components.mediaEncoder.bake).not.toHaveBeenCalled()
    })
  })

  describe('and an unsupported link is played while an embedded video is paused', () => {
    beforeEach(async () => {
      renderer.getSlideVideos.mockResolvedValue([
        { url: VIDEO_URL, geometry: GEOMETRY },
        { url: 'https://vimeo.com/123', geometry: GEOMETRY }
      ])
      embedOnly([VIDEO_URL])
      await createSession()
      await manager.playVideo(presentationId, 0)
      await manager.pauseVideo(presentationId)
      await manager.playVideo(presentationId, 1)
    })

    it('should stop the paused sidecar playback', () => {
      expect(sidecar.stopVideo).toHaveBeenCalledTimes(1)
    })

    it('should report the error for the unsupported video', () => {
      expect(lastState()).toEqual(
        expect.objectContaining({ videoState: 'error', videoErrorCode: 'video-invalid-format' })
      )
    })
  })
})
