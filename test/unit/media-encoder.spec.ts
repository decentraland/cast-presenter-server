import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { createMediaEncoderComponent } from '../../src/adapters/media-encoder/component'
import type { BakePriority, BakeResult, IMediaEncoder } from '../../src/adapters/media-encoder/types'

jest.mock('child_process')

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = jest.fn(() => {
    this.emit('close', null)
    return true
  })

  constructor(
    public command: string,
    public args: string[]
  ) {
    super()
  }
}

interface StartedBake {
  controller: AbortController
  promise: Promise<BakeResult>
}

const BAKE_TIMEOUT_MS = 20 * 60 * 1000
const spawnMock = spawn as unknown as jest.Mock

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function spawnsOf(processes: FakeChildProcess[], command: string): FakeChildProcess[] {
  return processes.filter((proc) => proc.command === command)
}

function lastSpawn(processes: FakeChildProcess[], command: string): FakeChildProcess {
  const found = spawnsOf(processes, command)
  if (found.length === 0) throw new Error(`no ${command} spawn`)
  return found[found.length - 1]
}

function outputPaths(proc: FakeChildProcess): string[] {
  return proc.args.filter((arg) => arg.endsWith('.h264') || arg.endsWith('.ogg'))
}

function inOrder(argv: string[], expected: string[]): string[] {
  const matched: string[] = []
  let from = 0
  for (const token of expected) {
    const index = argv.indexOf(token, from)
    if (index === -1) break
    matched.push(token)
    from = index + 1
  }
  return matched
}

async function answerProbe(proc: FakeChildProcess, output: string): Promise<void> {
  if (output) proc.stdout.emit('data', Buffer.from(output))
  proc.emit('close', 0)
  await flush()
}

async function finishEncode(
  proc: FakeChildProcess,
  code: number,
  options: { writeOutputs?: boolean } = {}
): Promise<void> {
  if (options.writeOutputs ?? code === 0) {
    for (const output of outputPaths(proc)) fs.writeFileSync(output, Buffer.alloc(10))
  }
  proc.emit('close', code)
  await flush()
}

describe('when using the media encoder', () => {
  let processes: FakeChildProcess[]
  let logger: jest.Mocked<ILoggerComponent.ILogger>
  let encoder: IMediaEncoder
  let outDir: string
  let started: StartedBake[]

  function startBake(sourcePath: string, priority: BakePriority): StartedBake {
    const controller = new AbortController()
    const promise = encoder.bake(sourcePath, outDir, { priority, signal: controller.signal })
    promise.catch(() => undefined)
    const bake = { controller, promise }
    started.push(bake)
    return bake
  }

  async function startRunningBake(
    sourcePath: string,
    priority: BakePriority,
    probeOutput = '1\n'
  ): Promise<StartedBake> {
    const bake = startBake(sourcePath, priority)
    await flush()
    await answerProbe(lastSpawn(processes, 'ffprobe'), probeOutput)
    return bake
  }

  beforeEach(() => {
    processes = []
    started = []
    spawnMock.mockImplementation((command: string, args: string[]) => {
      const proc = new FakeChildProcess(command, args)
      processes.push(proc)
      return proc
    })
    logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      log: jest.fn()
    }
    encoder = createMediaEncoderComponent({ logs: { getLogger: () => logger } })
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-encoder-spec-'))
  })

  afterEach(() => {
    for (const bake of started) bake.controller.abort()
    jest.restoreAllMocks()
    spawnMock.mockReset()
    jest.useRealTimers()
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  describe('and the source has an audio stream', () => {
    let bake: StartedBake

    beforeEach(async () => {
      bake = await startRunningBake('/src/with-audio.mp4', 'play', '1\n')
    })

    describe('and ffmpeg exits 0', () => {
      let result: BakeResult

      beforeEach(async () => {
        await finishEncode(lastSpawn(processes, 'nice'), 0)
        result = await bake.promise
      })

      it('should probe the first audio stream with ffprobe restricted to local files', () => {
        expect(spawnsOf(processes, 'ffprobe')[0].args).toEqual([
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=index',
          '-of',
          'csv=p=0',
          '-protocol_whitelist',
          'file',
          '/src/with-audio.mp4'
        ])
      })

      it('should spawn nice with the video and audio encode arguments in order', () => {
        const expected = [
          'ffmpeg',
          '-map',
          '0:v:0',
          '-level:v',
          '4.0',
          '-bf',
          '0',
          'keyint=60:min-keyint=60:scenecut=0:sliced-threads=0',
          '-map',
          '0:a:0',
          'libopus'
        ]
        expect(inOrder(lastSpawn(processes, 'nice').args, expected)).toEqual(expected)
      })

      it('should resolve with an .ogg audio path', () => {
        expect(result.audioPath).toMatch(/\.ogg$/)
      })

      it('should resolve with the summed size of both outputs', () => {
        expect(result.bytes).toBe(20)
      })
    })

    describe('and ffmpeg exits 1 with stderr output', () => {
      let rmSpy: jest.SpyInstance
      let outputs: string[]

      beforeEach(async () => {
        rmSpy = jest.spyOn(fs, 'rmSync')
        const ffmpeg = lastSpawn(processes, 'nice')
        outputs = outputPaths(ffmpeg)
        ffmpeg.stderr.emit('data', Buffer.from('boom'))
        await finishEncode(ffmpeg, 1, { writeOutputs: true })
      })

      it('should reject with the exit code and the stderr tail', async () => {
        await expect(bake.promise).rejects.toThrow(/Bake failed \(code 1\).*boom/)
      })

      it('should remove each output with force', () => {
        expect(rmSpy.mock.calls).toEqual(outputs.map((output) => [output, { force: true }]))
      })
    })

    describe('and ffmpeg exits 1 without writing any output', () => {
      beforeEach(async () => {
        await finishEncode(lastSpawn(processes, 'nice'), 1, { writeOutputs: false })
      })

      it('should reject with a bake failure without throwing from the cleanup', async () => {
        await expect(bake.promise).rejects.toThrow('Bake failed')
      })
    })

    describe('and the ffmpeg stderr stream emits an error', () => {
      beforeEach(() => {
        lastSpawn(processes, 'nice').stderr.emit('error', new Error('EPIPE'))
      })

      it('should log a warning instead of throwing', () => {
        expect(logger.warn).toHaveBeenCalled()
      })
    })
  })

  describe('and the source has no audio stream', () => {
    let result: BakeResult

    beforeEach(async () => {
      const bake = await startRunningBake('/src/silent.mp4', 'play', '')
      await finishEncode(lastSpawn(processes, 'nice'), 0)
      result = await bake.promise
    })

    it('should not map an audio stream', () => {
      expect(lastSpawn(processes, 'nice').args).not.toContain('0:a:0')
    })

    it('should resolve with a null audio path', () => {
      expect(result.audioPath).toBeNull()
    })
  })

  describe('and the signal is already aborted', () => {
    let promise: Promise<BakeResult>

    beforeEach(() => {
      const controller = new AbortController()
      controller.abort()
      promise = encoder.bake('/src/a.mp4', outDir, { priority: 'play', signal: controller.signal })
      promise.catch(() => undefined)
    })

    it('should reject', async () => {
      await expect(promise).rejects.toBeDefined()
    })

    it('should not spawn any process', () => {
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('and the encode runs past the time limit', () => {
    let bake: StartedBake
    let ffmpeg: FakeChildProcess

    beforeEach(async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
      bake = await startRunningBake('/src/long.mp4', 'play')
      ffmpeg = lastSpawn(processes, 'nice')
      jest.advanceTimersByTime(BAKE_TIMEOUT_MS)
      await flush()
    })

    it('should kill ffmpeg with SIGKILL', () => {
      expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('should reject with the time limit message', async () => {
      await expect(bake.promise).rejects.toThrow('Bake exceeded time limit')
    })
  })

  describe('and two prefetch bakes then a play bake are requested while the first runs', () => {
    beforeEach(async () => {
      await startRunningBake('/src/prefetch-1.mp4', 'prefetch')
      startBake('/src/prefetch-2.mp4', 'prefetch')
      startBake('/src/play.mp4', 'play')
      await flush()
    })

    it('should run only one encode at a time', () => {
      expect(spawnsOf(processes, 'nice')).toHaveLength(1)
    })

    describe('and the first bake finishes', () => {
      beforeEach(async () => {
        await finishEncode(lastSpawn(processes, 'nice'), 0)
      })

      it('should start the play bake before the queued prefetch', () => {
        expect(lastSpawn(processes, 'ffprobe').args).toContain('/src/play.mp4')
      })
    })
  })

  describe('and a queued prefetch is promoted', () => {
    beforeEach(async () => {
      await startRunningBake('/src/running.mp4', 'prefetch')
      startBake('/src/session-2.mp4', 'prefetch')
      const promoted = startBake('/src/session-1.mp4', 'prefetch')
      encoder.promote(promoted.controller.signal)
      await finishEncode(lastSpawn(processes, 'nice'), 0)
    })

    it('should start the promoted bake next', () => {
      expect(lastSpawn(processes, 'ffprobe').args).toContain('/src/session-1.mp4')
    })
  })

  describe('and promote is called with the running or an unknown signal', () => {
    let promoteCalls: () => void

    beforeEach(async () => {
      const running = await startRunningBake('/src/running.mp4', 'prefetch')
      startBake('/src/first.mp4', 'prefetch')
      startBake('/src/second.mp4', 'prefetch')
      promoteCalls = () => {
        encoder.promote(running.controller.signal)
        encoder.promote(new AbortController().signal)
      }
    })

    it('should not throw', () => {
      expect(promoteCalls).not.toThrow()
    })

    describe('and the running bake finishes', () => {
      beforeEach(async () => {
        promoteCalls()
        await finishEncode(lastSpawn(processes, 'nice'), 0)
      })

      it('should keep the queue order', () => {
        expect(lastSpawn(processes, 'ffprobe').args).toContain('/src/first.mp4')
      })
    })
  })

  describe('and a queued bake is aborted', () => {
    let aborted: StartedBake

    beforeEach(async () => {
      await startRunningBake('/src/running.mp4', 'prefetch')
      aborted = startBake('/src/aborted.mp4', 'prefetch')
      startBake('/src/next.mp4', 'prefetch')
      aborted.controller.abort()
      await finishEncode(lastSpawn(processes, 'nice'), 0)
    })

    it('should reject the aborted bake', async () => {
      await expect(aborted.promise).rejects.toBeDefined()
    })

    it('should never spawn a process for the aborted bake', () => {
      expect(processes.some((proc) => proc.args.includes('/src/aborted.mp4'))).toBe(false)
    })

    it('should continue with the next queued bake', () => {
      expect(lastSpawn(processes, 'ffprobe').args).toContain('/src/next.mp4')
    })
  })

  describe('and the running bake is aborted', () => {
    let running: StartedBake
    let ffmpeg: FakeChildProcess
    let rmSpy: jest.SpyInstance
    let outputs: string[]

    beforeEach(async () => {
      running = await startRunningBake('/src/running.mp4', 'play')
      startBake('/src/next.mp4', 'prefetch')
      ffmpeg = lastSpawn(processes, 'nice')
      outputs = outputPaths(ffmpeg)
      rmSpy = jest.spyOn(fs, 'rmSync')
      running.controller.abort()
      await flush()
    })

    it('should kill ffmpeg with SIGKILL', () => {
      expect(ffmpeg.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('should reject the running bake', async () => {
      await expect(running.promise).rejects.toBeDefined()
    })

    it('should remove the outputs with force', () => {
      expect(rmSpy.mock.calls).toEqual(outputs.map((output) => [output, { force: true }]))
    })

    it('should start the next queued bake', () => {
      expect(lastSpawn(processes, 'ffprobe').args).toContain('/src/next.mp4')
    })
  })

  describe('and the bake is aborted while probing for audio', () => {
    let bake: StartedBake
    let ffprobe: FakeChildProcess

    beforeEach(async () => {
      bake = startBake('/src/probing.mp4', 'play')
      await flush()
      ffprobe = lastSpawn(processes, 'ffprobe')
      bake.controller.abort()
      await flush()
    })

    it('should kill ffprobe with SIGKILL', () => {
      expect(ffprobe.kill).toHaveBeenCalledWith('SIGKILL')
    })

    it('should reject without spawning ffmpeg', async () => {
      await expect(bake.promise).rejects.toBeDefined()
      expect(spawnsOf(processes, 'nice')).toHaveLength(0)
    })
  })

  describe('and an embedded video is resolved', () => {
    let embeddedDir: string
    let otherDir: string

    beforeEach(() => {
      embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-pptx-video-'))
      otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-other-'))
      fs.writeFileSync(path.join(embeddedDir, 'clip.mp4'), Buffer.alloc(42))
      fs.writeFileSync(path.join(otherDir, 'clip.mp4'), Buffer.alloc(42))
      fs.mkdirSync(path.join(embeddedDir, 'sub'))
      fs.writeFileSync(path.join(embeddedDir, 'sub', 'f'), Buffer.alloc(1))
    })

    afterEach(() => {
      fs.rmSync(embeddedDir, { recursive: true, force: true })
      fs.rmSync(otherDir, { recursive: true, force: true })
    })

    describe('and the file sits directly in a PPTX media directory', () => {
      it('should return its real path and size', () => {
        expect(encoder.resolveEmbeddedVideo(path.join(embeddedDir, 'clip.mp4'))).toEqual({
          path: fs.realpathSync(path.join(embeddedDir, 'clip.mp4')),
          bytes: 42
        })
      })
    })

    describe('and the url is an https link', () => {
      it('should return null', () => {
        expect(encoder.resolveEmbeddedVideo('https://example.com/v.mp4')).toBeNull()
      })
    })

    describe('and the file is in another tmp directory', () => {
      it('should return null', () => {
        expect(encoder.resolveEmbeddedVideo(path.join(otherDir, 'clip.mp4'))).toBeNull()
      })
    })

    describe('and the file is outside the tmp directory', () => {
      it('should return null', () => {
        expect(encoder.resolveEmbeddedVideo('/etc/hosts')).toBeNull()
      })
    })

    describe('and the file is nested below the PPTX media directory', () => {
      it('should return null', () => {
        expect(encoder.resolveEmbeddedVideo(path.join(embeddedDir, 'sub', 'f'))).toBeNull()
      })
    })

    describe('and the path is a symlink in the PPTX media directory pointing outside it', () => {
      beforeEach(() => {
        fs.symlinkSync('/etc/hosts', path.join(embeddedDir, 'link.mp4'))
      })

      it('should return null', () => {
        expect(encoder.resolveEmbeddedVideo(path.join(embeddedDir, 'link.mp4'))).toBeNull()
      })
    })
  })
})
