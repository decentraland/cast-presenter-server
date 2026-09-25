import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { createVideoCompositorComponent } from '../../src/adapters/video-compositor/component'
import { i420FrameSize } from '../../src/logic/color-convert'
import type { ILiveKitPublisher } from '../../src/adapters/livekit-publisher/types'
import type { IVideoCompositor, SlideVideoInfo } from '../../src/adapters/video-compositor/types'
import type { INetworkValidatorComponent } from '../../src/logic/network-validator/types'

jest.mock('child_process')

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = jest.fn()
  simulateClose(code = 0) {
    this.emit('close', code)
  }
}

const fakeProcesses: FakeChildProcess[] = []
const spawnMock = spawn as unknown as jest.Mock

function createLogger(): ILoggerComponent.ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
  }
}

function createPublisherStub(): ILiveKitPublisher {
  return {
    connect: jest.fn(),
    startPublishing: jest.fn(),
    pushFrame: jest.fn(),
    startHeartbeat: jest.fn(),
    stopHeartbeat: jest.fn(),
    startAudioPublishing: jest.fn(),
    pushAudioFrame: jest.fn(),
    stopAudioPublishing: jest.fn(),
    setDataHandler: jest.fn(),
    updateMetadataState: jest.fn(),
    publishData: jest.fn(),
    getRemoteParticipantCount: jest.fn().mockReturnValue(0),
    disconnect: jest.fn()
  } as unknown as ILiveKitPublisher
}

function createNetworkValidatorStub(): INetworkValidatorComponent {
  return {
    isPrivateIP: jest.fn().mockReturnValue(false),
    validateHttpsUrl: jest.fn().mockResolvedValue(undefined),
    resolveAndValidateUrl: jest.fn(),
    validateVideoUrl: jest.fn().mockResolvedValue('https://example.com/v.mp4')
  } as unknown as INetworkValidatorComponent
}

const SLIDE_W = 16
const SLIDE_H = 16
const SLIDE_BUFFER = Buffer.alloc(SLIDE_W * SLIDE_H * 4) // RGBA placeholder
const VIDEO_INFO: SlideVideoInfo = {
  url: 'https://example.com/v.mp4',
  geometry: { x: 0, y: 0, width: 16, height: 16 }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('video-compositor onEnd latch', () => {
  let tempDir: string
  let compositor: IVideoCompositor
  let publisher: ILiveKitPublisher

  beforeEach(() => {
    fakeProcesses.length = 0
    spawnMock.mockImplementation(() => {
      const fake = new FakeChildProcess()
      fakeProcesses.push(fake)
      return fake
    })

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-spec-'))
    const component = createVideoCompositorComponent({ networkValidator: createNetworkValidatorStub() })
    compositor = component.createCompositor(createLogger(), tempDir)
    publisher = createPublisherStub()
  })

  afterEach(() => {
    compositor.cleanup()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('when the close event fires before onEnd is registered', () => {
    it('should latch the event and invoke the callback when onEnd is registered', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)

      // Simulate FFmpeg exiting immediately (before any onEnd registration).
      const compositeProc = fakeProcesses[0]
      compositeProc.simulateClose(0)

      const cb = jest.fn()
      compositor.onEnd(cb)

      // Replay is deferred to a microtask.
      expect(cb).not.toHaveBeenCalled()
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledTimes(1)
    })
  })

  describe('when onEnd is registered before the close event', () => {
    it('should invoke the callback directly without going through the latch', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)

      const cb = jest.fn()
      compositor.onEnd(cb)

      const compositeProc = fakeProcesses[0]
      compositeProc.simulateClose(0)

      expect(cb).toHaveBeenCalledTimes(1)
    })
  })

  describe('when cleanup runs after the close event but before onEnd is registered', () => {
    it('should swallow the latched event (no spurious natural-end callback)', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)

      const compositeProc = fakeProcesses[0]
      compositeProc.simulateClose(0)

      compositor.cleanup()

      const cb = jest.fn()
      compositor.onEnd(cb)
      await flushMicrotasks()
      expect(cb).not.toHaveBeenCalled()
    })
  })

  describe('when the latch is consumed', () => {
    it('should not double-fire on subsequent onEnd registrations without a new close event', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)

      const compositeProc = fakeProcesses[0]
      compositeProc.simulateClose(0)

      const firstCb = jest.fn()
      compositor.onEnd(firstCb)
      await flushMicrotasks()
      expect(firstCb).toHaveBeenCalledTimes(1)

      // Register a second callback — latch was already consumed, no replay expected.
      const secondCb = jest.fn()
      compositor.onEnd(secondCb)
      await flushMicrotasks()
      expect(secondCb).not.toHaveBeenCalled()
    })
  })
})

describe('video-compositor error isolation', () => {
  let tempDir: string
  let compositor: IVideoCompositor
  let publisher: ILiveKitPublisher

  beforeEach(() => {
    fakeProcesses.length = 0
    spawnMock.mockImplementation(() => {
      const fake = new FakeChildProcess()
      fakeProcesses.push(fake)
      return fake
    })

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-spec-err-'))
    const component = createVideoCompositorComponent({ networkValidator: createNetworkValidatorStub() })
    compositor = component.createCompositor(createLogger(), tempDir)
    publisher = createPublisherStub()
  })

  afterEach(() => {
    compositor.cleanup()
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  describe('when the composite process exits with a non-zero code mid-stream', () => {
    it('should fire onError (not onEnd) with code video-playback-interrupted', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)
      const onEnd = jest.fn()
      const onError = jest.fn()
      compositor.onEnd(onEnd)
      compositor.onError(onError)

      fakeProcesses[0].simulateClose(1)
      await flushMicrotasks()

      expect(onEnd).not.toHaveBeenCalled()
      expect(onError).toHaveBeenCalledWith('video-playback-interrupted')
    })
  })

  describe('when onAudioData throws inside the stdout data handler', () => {
    it('should swallow the throw, stop playback, and fire onError(audio-processing-failed)', async () => {
      const throwingOnAudio = jest.fn(() => {
        throw new RangeError('simulated buffer overflow')
      })
      await compositor.startPlayback(
        '/tmp/nonexistent.mp4',
        VIDEO_INFO,
        SLIDE_BUFFER,
        SLIDE_W,
        SLIDE_H,
        publisher,
        throwingOnAudio
      )
      const onError = jest.fn()
      compositor.onError(onError)

      // fakeProcesses[0] = composite, fakeProcesses[1] = audio
      const audioProc = fakeProcesses[1]
      // Must not throw out of the event emitter — this is the crash-fix assertion.
      expect(() => audioProc.stdout.emit('data', Buffer.alloc(1920))).not.toThrow()
      await flushMicrotasks()

      expect(throwingOnAudio).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith('audio-processing-failed')
    })
  })

  describe('when a stdio stream emits an error event', () => {
    it('should not propagate a composite stderr error as an uncaught exception', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)
      const onError = jest.fn()
      compositor.onError(onError)

      const compositeProc = fakeProcesses[0]
      // If no error listener were attached, this would throw synchronously.
      expect(() => compositeProc.stderr.emit('error', new Error('EPIPE'))).not.toThrow()
      await flushMicrotasks()

      expect(onError).toHaveBeenCalledWith('video-stream-error')
    })

    it('should not propagate an audio stderr error', async () => {
      const onAudioData = jest.fn()
      await compositor.startPlayback(
        '/tmp/nonexistent.mp4',
        VIDEO_INFO,
        SLIDE_BUFFER,
        SLIDE_W,
        SLIDE_H,
        publisher,
        onAudioData
      )
      const audioProc = fakeProcesses[1]
      expect(() => audioProc.stderr.emit('error', new Error('EPIPE'))).not.toThrow()
    })
  })

  describe('onError latch', () => {
    it('should replay the latched reason when onError is registered after the event', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)
      fakeProcesses[0].simulateClose(1)

      const cb = jest.fn()
      compositor.onError(cb)
      await flushMicrotasks()
      expect(cb).toHaveBeenCalledWith('video-playback-interrupted')
    })

    it('should not fire if cleanup() runs before onError is registered', async () => {
      await compositor.startPlayback('/tmp/nonexistent.mp4', VIDEO_INFO, SLIDE_BUFFER, SLIDE_W, SLIDE_H, publisher)
      fakeProcesses[0].simulateClose(1)
      compositor.cleanup()

      const cb = jest.fn()
      compositor.onError(cb)
      await flushMicrotasks()
      expect(cb).not.toHaveBeenCalled()
    })
  })
})

describe('when a decorateFrame callback is passed', () => {
  const FRAME_SIZE = i420FrameSize(SLIDE_W, SLIDE_H)
  let tempDir: string
  let compositor: IVideoCompositor
  let publisher: jest.Mocked<ILiveKitPublisher>
  let logger: jest.Mocked<ILoggerComponent.ILogger>
  let frame: Buffer

  beforeEach(() => {
    fakeProcesses.length = 0
    spawnMock.mockImplementation(() => {
      const fake = new FakeChildProcess()
      fakeProcesses.push(fake)
      return fake
    })

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compositor-spec-decorate-'))
    logger = createLogger() as jest.Mocked<ILoggerComponent.ILogger>
    const component = createVideoCompositorComponent({ networkValidator: createNetworkValidatorStub() })
    compositor = component.createCompositor(logger, tempDir)
    publisher = createPublisherStub() as jest.Mocked<ILiveKitPublisher>
    frame = Buffer.alloc(FRAME_SIZE, 7)
  })

  afterEach(() => {
    compositor.cleanup()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('and it returns a decorated frame', () => {
    let decorated: Buffer
    let decorateFrame: jest.Mock<Buffer, [Buffer, number, number]>

    beforeEach(async () => {
      decorated = Buffer.alloc(FRAME_SIZE, 9)
      decorateFrame = jest.fn<Buffer, [Buffer, number, number]>().mockReturnValue(decorated)
      await compositor.startPlayback(
        '/tmp/nonexistent.mp4',
        VIDEO_INFO,
        SLIDE_BUFFER,
        SLIDE_W,
        SLIDE_H,
        publisher,
        undefined,
        undefined,
        decorateFrame
      )
      fakeProcesses[0].stdout.emit('data', frame)
    })

    it('should pass the undecorated frame and the slide size to decorateFrame', () => {
      expect(decorateFrame).toHaveBeenCalledWith(frame, SLIDE_W, SLIDE_H)
    })

    it('should push the buffer decorateFrame returned', () => {
      expect(publisher.pushFrame).toHaveBeenCalledTimes(1)
      expect(publisher.pushFrame.mock.calls[0][0]).toBe(decorated)
      expect(publisher.pushFrame).toHaveBeenCalledWith(decorated, SLIDE_W, SLIDE_H, 5)
    })

    it('should keep the undecorated frame for getLastFrame', () => {
      const last = compositor.getLastFrame()
      expect(last?.buffer).toEqual(frame)
      expect(last?.buffer).not.toBe(decorated)
    })
  })

  describe('and it throws', () => {
    let emitFrame: () => boolean

    beforeEach(async () => {
      const decorateFrame = jest.fn<Buffer, [Buffer, number, number]>(() => {
        throw new Error('stamp failed')
      })
      await compositor.startPlayback(
        '/tmp/nonexistent.mp4',
        VIDEO_INFO,
        SLIDE_BUFFER,
        SLIDE_W,
        SLIDE_H,
        publisher,
        undefined,
        undefined,
        decorateFrame
      )
      emitFrame = () => fakeProcesses[0].stdout.emit('data', frame)
    })

    it('should not throw from the stdout data handler', () => {
      expect(emitFrame).not.toThrow()
    })

    it('should push the undecorated frame', () => {
      emitFrame()
      expect(publisher.pushFrame).toHaveBeenCalledWith(frame, SLIDE_W, SLIDE_H, 5)
    })

    it('should log a warning', () => {
      emitFrame()
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('decorateFrame'))
    })
  })
})
