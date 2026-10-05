import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { errorMessage } from '../../logic/error-message'
import { removeQuietly } from '../../logic/remove-quietly'
import type { BakePriority, BakeResult, IMediaEncoder } from './types'
import type { AppComponents } from '../../types'

const PROBE_TIMEOUT_MS = 30_000
const BAKE_TIMEOUT_MS = 20 * 60 * 1000
const STDERR_TAIL_CHARS = 300
const HTTP_URL = /^https?:\/\//i
const SCALE_FILTER =
  "scale='if(gte(iw,ih),min(1920,iw),min(1080,iw))':'if(gte(iw,ih),min(1080,ih),min(1920,ih))'" +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30'

interface QueueEntry {
  run: () => Promise<void>
  signal: AbortSignal
  priority: BakePriority
}

interface ProcessOutcome {
  code: number | null
  stdout: string
  stderr: string
}

function probeArgs(sourcePath: string): string[] {
  return [
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
    sourcePath
  ]
}

function bakeArgs(sourcePath: string, videoPath: string, audioPath: string | null): string[] {
  const video = [
    '-n',
    '10',
    'ffmpeg',
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-protocol_whitelist',
    'file',
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-vf',
    SCALE_FILTER,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'baseline',
    '-level:v',
    '4.0',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '6M',
    '-maxrate',
    '6M',
    '-bufsize',
    '12M',
    '-bf',
    '0',
    '-x264-params',
    'keyint=60:min-keyint=60:scenecut=0:sliced-threads=0',
    '-bsf:v',
    'h264_mp4toannexb',
    '-f',
    'h264',
    '-y',
    videoPath
  ]
  if (!audioPath) return video
  return [
    ...video,
    '-map',
    '0:a:0',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-page_duration',
    '20000',
    '-f',
    'ogg',
    '-y',
    audioPath
  ]
}

/**
 * Creates the process-wide media encoder. Register it once: its queue is what bounds baking to one ffmpeg.
 *
 * Each bake runs in order:
 * 1. wait in the queue until nothing else is baking (play requests first);
 * 2. probe the source for an audio stream with ffprobe;
 * 3. encode it with a niced ffmpeg into `bake-<uuid>.h264` and, when audio exists, `bake-<uuid>.ogg`;
 * 4. on any failure, timeout or abort, SIGKILL the process, delete the partial outputs and reject.
 *
 * @param components - `logs` for the `media-encoder` logger.
 * @returns the media encoder.
 */
export async function createMediaEncoderComponent(components: Pick<AppComponents, 'logs'>): Promise<IMediaEncoder> {
  const logger = components.logs.getLogger('media-encoder')
  const queue: QueueEntry[] = []
  let running = false

  function queueLengths(): Record<string, number> {
    return {
      playQueue: queue.filter((entry) => entry.priority === 'play').length,
      prefetchQueue: queue.filter((entry) => entry.priority === 'prefetch').length
    }
  }

  function runProcess(
    command: string,
    args: string[],
    signal: AbortSignal,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<ProcessOutcome> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let failure: { reason: unknown } | null = null

      const kill = (reason: unknown): void => {
        failure = { reason }
        proc.kill('SIGKILL')
      }
      const onAbort = (): void => kill(signal.reason)
      const timeout = setTimeout(() => kill(new Error(timeoutMessage)), timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })

      const settle = (finish: () => void): void => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        finish()
      }

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS)
      })
      for (const stream of [proc.stdout, proc.stderr]) {
        stream?.on('error', (err: Error) => logger.warn('Bake process stream error', { command, error: err.message }))
      }
      proc.on('close', (code: number | null) =>
        settle(() => (failure ? reject(failure.reason) : resolve({ code, stdout, stderr })))
      )
      proc.on('error', (err: Error) => settle(() => reject(failure ? failure.reason : err)))
    })
  }

  async function probeAudio(sourcePath: string, signal: AbortSignal): Promise<boolean> {
    const { code, stdout, stderr } = await runProcess(
      'ffprobe',
      probeArgs(sourcePath),
      signal,
      PROBE_TIMEOUT_MS,
      'Audio probe exceeded time limit'
    )
    if (code !== 0) throw new Error(`Audio probe failed (code ${code}): ${stderr}`)
    return stdout.trim().length > 0
  }

  async function runBake(sourcePath: string, outDir: string, signal: AbortSignal): Promise<BakeResult> {
    const id = randomUUID()
    const videoPath = path.join(outDir, `bake-${id}.h264`)
    const audioOutput = path.join(outDir, `bake-${id}.ogg`)
    try {
      const audioPath = (await probeAudio(sourcePath, signal)) ? audioOutput : null
      const { code, stderr } = await runProcess(
        'nice',
        bakeArgs(sourcePath, videoPath, audioPath),
        signal,
        BAKE_TIMEOUT_MS,
        'Bake exceeded time limit'
      )
      if (code !== 0) throw new Error(`Bake failed (code ${code}): ${stderr}`)
      const bytes = fs.statSync(videoPath).size + (audioPath ? fs.statSync(audioPath).size : 0)
      return { videoPath, audioPath, bytes }
    } catch (err) {
      removeQuietly(videoPath, logger)
      removeQuietly(audioOutput, logger)
      throw err
    }
  }

  function pump(): void {
    if (running) return
    const playIndex = queue.findIndex((entry) => entry.priority === 'play')
    const [next] = queue.splice(playIndex === -1 ? 0 : playIndex, 1)
    if (!next) return
    running = true
    const release = (): void => {
      running = false
      pump()
    }
    void next.run().then(release, release)
  }

  return {
    async bake(sourcePath, outDir, { priority, signal }) {
      signal.throwIfAborted()
      return new Promise<BakeResult>((resolve, reject) => {
        const onQueuedAbort = (): void => {
          const index = queue.indexOf(entry)
          if (index === -1) return
          queue.splice(index, 1)
          reject(signal.reason)
        }
        const entry: QueueEntry = {
          signal,
          priority,
          run: async () => {
            signal.removeEventListener('abort', onQueuedAbort)
            const startedAt = Date.now()
            logger.info('Bake started', { sourcePath, priority, ...queueLengths() })
            try {
              const result = await runBake(sourcePath, outDir, signal)
              logger.info('Bake finished', {
                durationMs: Date.now() - startedAt,
                bytes: result.bytes,
                ...queueLengths()
              })
              resolve(result)
            } catch (err) {
              logger.info('Bake did not finish', {
                durationMs: Date.now() - startedAt,
                error: errorMessage(err),
                ...queueLengths()
              })
              reject(err)
            }
          }
        }
        signal.addEventListener('abort', onQueuedAbort, { once: true })
        queue.push(entry)
        pump()
      })
    },

    promote(signal) {
      const index = queue.findIndex((entry) => entry.signal === signal)
      if (index === -1) return
      const [entry] = queue.splice(index, 1)
      entry.priority = 'play'
      queue.unshift(entry)
    },

    resolveEmbeddedVideo(url, embeddedDir) {
      if (!embeddedDir || HTTP_URL.test(url)) return null
      try {
        const real = fs.realpathSync(url)
        if (path.dirname(real) !== fs.realpathSync(embeddedDir)) return null
        const stat = fs.statSync(real)
        return stat.isFile() ? { path: real, bytes: stat.size } : null
      } catch {
        return null
      }
    }
  }
}
