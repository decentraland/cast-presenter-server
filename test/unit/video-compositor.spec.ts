import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { createVideoCompositorComponent } from '../../src/adapters/video-compositor/component'
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
