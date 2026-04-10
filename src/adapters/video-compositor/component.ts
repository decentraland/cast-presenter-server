import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { i420FrameSize } from '../../logic/color-convert'
import type { IVideoCompositor, IVideoCompositorComponent, SlideVideoInfo } from './types'
import type { INetworkValidatorComponent } from '../../logic/network-validator/types'
import type { AppComponents } from '../../types'
import type { ILiveKitPublisher } from '../livekit-publisher/types'
import type { ChildProcess } from 'child_process'

const FRAME_RATE = 10
const VIDEO_BUFFER_TYPE_I420 = 5 // VideoBufferType.I420 from @livekit/rtc-node
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024 // 500 MB
const DOWNLOAD_TIMEOUT_MS = 60_000 // 60 seconds

/**
 * Validates an ffmpeg filter parameter is a safe integer within bounds.
 *
 * @param value - The numeric value to validate
 * @param name - Parameter name for error messages
 * @param max - Upper bound (default 7680 for 8K resolution)
 * @throws {Error} If value is not an integer or out of range
 */
export function validateFilterParam(value: number, name: string, max = 7680): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Invalid ffmpeg filter param ${name}=${value}, must be integer 0-${max}`)
  }
}

function extractDriveFileId(url: string): string | null {
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/uc\?.*id=([a-zA-Z0-9_-]+)/]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

function getDriveDownloadUrls(fileId: string): string[] {
  return [
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
    `https://drive.google.com/uc?id=${fileId}&export=download&confirm=t`
  ]
}

function createVideoCompositor(
  logger: ILoggerComponent.ILogger,
  networkValidator: INetworkValidatorComponent,
  tempDir?: string
): IVideoCompositor {
  let compositeProcess: ChildProcess | null = null
  let audioProcess: ChildProcess | null = null
  let dataListener: ((chunk: Buffer) => void) | null = null
  let frameAccumulator: Buffer = Buffer.alloc(0)
  let frameAccumLength = 0
  const dir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cast-presenter-'))
  let isPlaying = false
  let isPaused = false
  let cleanedUp = false
  let onEndCallback: (() => void) | null = null

  async function tryDownload(downloadUrl: string, originalUrl: string): Promise<string> {
    const destPath = path.join(dir, `video-${Date.now()}.mp4`)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(downloadUrl, { redirect: 'follow', signal: controller.signal })
    } catch (err) {
      clearTimeout(timeout)
      throw err instanceof Error && err.name === 'AbortError'
        ? new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${downloadUrl}`)
        : err
    }

    if (!response.ok || !response.body) {
      clearTimeout(timeout)
      throw new Error(`HTTP ${response.status} from ${downloadUrl}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      clearTimeout(timeout)
      throw new Error(`Got HTML instead of video: ${originalUrl}`)
    }

    const fileStream = fs.createWriteStream(destPath)
    const reader = response.body.getReader()
    let bytesWritten = 0

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytesWritten += value.byteLength
        if (bytesWritten > MAX_DOWNLOAD_BYTES) {
          throw new Error(`Video download exceeds ${MAX_DOWNLOAD_BYTES / (1024 * 1024)}MB limit: ${originalUrl}`)
        }
        fileStream.write(Buffer.from(value))
      }
    } finally {
      clearTimeout(timeout)
      fileStream.end()
    }

    return new Promise((resolve, reject) => {
      fileStream.on('finish', () => {
        const stat = fs.statSync(destPath)
        if (stat.size < 1024) {
          fs.unlinkSync(destPath)
          reject(new Error(`File too small (${stat.size} bytes), likely not a valid video`))
          return
        }
        resolve(destPath)
      })
      fileStream.on('error', reject)
    })
  }

  function probeVideo(filePath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )

      let output = ''
      proc.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      proc.on('close', (code) => {
        resolve(code === 0 && output.trim().includes('video'))
      })
      proc.on('error', () => resolve(false))
    })
  }

  function stopPlayback(
    publisher: ILiveKitPublisher,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number
  ): void {
    cleanedUp = true
    isPlaying = false

    if (compositeProcess) {
      if (dataListener) {
        compositeProcess.stdout?.removeListener('data', dataListener)
        dataListener = null
      }
      compositeProcess.kill('SIGKILL')
      compositeProcess = null
    }

    frameAccumulator = Buffer.alloc(0)
    frameAccumLength = 0
    publisher.pushFrame(slideBuffer, slideWidth, slideHeight)
    publisher.startHeartbeat(slideBuffer, slideWidth, slideHeight)
  }

  return {
    async downloadVideo(url: string): Promise<string> {
      await networkValidator.validateVideoUrl(url)
      const driveFileId = extractDriveFileId(url)
      const urlsToTry = driveFileId ? getDriveDownloadUrls(driveFileId) : [url]

      let lastError: Error | null = null
      for (const downloadUrl of urlsToTry) {
        try {
          return await tryDownload(downloadUrl, url)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          logger.warn(`Download attempt failed: ${lastError.message}`)
        }
      }
      throw lastError || new Error(`Failed to download video: ${url}`)
    },

    async resolveStreamUrl(url: string): Promise<string> {
      await networkValidator.validateVideoUrl(url)
      const driveFileId = extractDriveFileId(url)
      if (driveFileId) {
        return `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`
      }
      return url
    },

    async preTranscode(inputPath: string, width: number, height: number): Promise<string> {
      validateFilterParam(width, 'width')
      validateFilterParam(height, 'height')

      const isValid = await probeVideo(inputPath)
      if (!isValid) {
        throw new Error(`Not a valid video file: ${inputPath}`)
      }

      const outputPath = path.join(dir, `transcoded-${Date.now()}-${width}x${height}.mp4`)

      return new Promise((resolve, reject) => {
        const proc = spawn(
          'ffmpeg',
          [
            '-threads',
            '1',
            '-i',
            inputPath,
            '-vf',
            `scale=${width}:${height}`,
            '-c:v',
            'libx264',
            '-preset',
            'fast',
            '-threads',
            '1',
            '-r',
            String(FRAME_RATE),
            '-c:a',
            'copy',
            '-y',
            outputPath
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] }
        )

        let stderr = ''
        proc.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) {
            logger.info(`Pre-transcoded video to ${width}x${height}`)
            resolve(outputPath)
          } else {
            reject(new Error(`Pre-transcode failed (code ${code}): ${stderr.slice(-200)}`))
          }
        })

        proc.on('error', reject)
      })
    },

    async startPlayback(
      videoPath: string,
      videoInfo: SlideVideoInfo,
      slideBuffer: Buffer,
      slideWidth: number,
      slideHeight: number,
      publisher: ILiveKitPublisher,
      onAudioData?: (pcmChunk: Buffer) => void
    ): Promise<void> {
      isPlaying = true

      const { x, y, width: vw, height: vh } = videoInfo.geometry
      validateFilterParam(x, 'x')
      validateFilterParam(y, 'y')
      validateFilterParam(vw, 'vw')
      validateFilterParam(vh, 'vh')

      const compositeFrameSize = i420FrameSize(slideWidth, slideHeight)

      const slidePath = path.join(dir, `slide-${Date.now()}.rgba`)
      fs.writeFileSync(slidePath, slideBuffer)

      // Overlay video at PDF geometry coordinates — no scaling needed
      // Video is pre-transcoded to exact geometry size, slide is already at target resolution
      const filterComplex = `[1:v]scale=${vw}:${vh}[vid];[0:v][vid]overlay=${x}:${y}:shortest=1`

      // Video composite — FFmpeg paces output at real-time via -re (no timers needed)
      const ffmpegArgs = [
        '-threads',
        '1',
        '-stream_loop',
        '-1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${slideWidth}x${slideHeight}`,
        '-r',
        String(FRAME_RATE),
        '-i',
        slidePath,
        '-threads',
        '1',
        '-re',
        '-i',
        videoPath,
        '-filter_complex',
        filterComplex,
        '-an',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(FRAME_RATE),
        'pipe:1'
      ]

      compositeProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

      compositeProcess.stderr?.on('data', () => {
        /* noop */
      })

      // Separate audio process — also paced at real-time via -re
      if (onAudioData) {
        audioProcess = spawn(
          'ffmpeg',
          [
            '-threads',
            '1',
            '-re',
            '-i',
            videoPath,
            '-vn',
            '-f',
            's16le',
            '-ar',
            String(AUDIO_SAMPLE_RATE),
            '-ac',
            String(AUDIO_CHANNELS),
            'pipe:1'
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        )

        audioProcess.stderr?.on('data', () => {
          /* noop */
        })

        // Push audio directly as it arrives — AudioSource self-paces via its internal queue
        audioProcess.stdout?.on('data', (chunk: Buffer) => {
          if (isPlaying && !isPaused) {
            onAudioData(Buffer.from(chunk))
          }
        })

        audioProcess.on('close', () => {
          audioProcess = null
        })
      }

      publisher.stopHeartbeat()

      // Push video frames immediately as complete frames arrive — FFmpeg -re handles pacing
      dataListener = (chunk: Buffer) => {
        if (frameAccumLength === 0) {
          frameAccumulator = chunk
          frameAccumLength = chunk.length
        } else {
          frameAccumulator = Buffer.concat([frameAccumulator, chunk])
          frameAccumLength = frameAccumulator.length
        }

        // Deliver all complete frames immediately
        while (frameAccumLength >= compositeFrameSize) {
          if (!isPlaying || isPaused) break
          const frame = frameAccumulator.subarray(0, compositeFrameSize)
          publisher.pushFrame(Buffer.from(frame), slideWidth, slideHeight, VIDEO_BUFFER_TYPE_I420)
          frameAccumulator = frameAccumulator.subarray(compositeFrameSize)
          frameAccumLength = frameAccumulator.length
        }
      }
      compositeProcess.stdout?.on('data', dataListener)

      compositeProcess.on('close', () => {
        if (!cleanedUp && isPlaying) {
          stopPlayback(publisher, slideBuffer, slideWidth, slideHeight)
          if (onEndCallback) onEndCallback()
        }
      })

      logger.info(`Video playback started (audio: ${onAudioData ? 'enabled' : 'disabled'})`, {
        slideSize: `${slideWidth}x${slideHeight}`,
        compositeSize: `${slideWidth}x${slideHeight}`,
        videoSize: `${vw}x${vh}`,
        position: `${x},${y}`
      })
    },

    pausePlayback(): void {
      isPaused = true
      if (compositeProcess) compositeProcess.kill('SIGSTOP')
      if (audioProcess) audioProcess.kill('SIGSTOP')
    },

    resumePlayback(): void {
      if (compositeProcess) compositeProcess.kill('SIGCONT')
      if (audioProcess) audioProcess.kill('SIGCONT')
      isPaused = false
    },

    onEnd(callback: () => void): void {
      onEndCallback = callback
    },

    getIsPlaying(): boolean {
      return isPlaying
    },

    cleanup(): void {
      cleanedUp = true
      isPlaying = false
      if (compositeProcess) {
        if (dataListener) {
          compositeProcess.stdout?.removeListener('data', dataListener)
          dataListener = null
        }
        compositeProcess.kill('SIGKILL')
        compositeProcess = null
      }
      if (audioProcess) {
        audioProcess.kill('SIGKILL')
        audioProcess = null
      }
      frameAccumulator = Buffer.alloc(0)
      frameAccumLength = 0
    }
  }
}

export function createVideoCompositorComponent(
  components: Pick<AppComponents, 'networkValidator'>
): IVideoCompositorComponent {
  const { networkValidator } = components
  return {
    createCompositor: (logger, tempDir?) => createVideoCompositor(logger, networkValidator, tempDir),
    destroyTempDir(tempDir: string): void {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
