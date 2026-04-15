import { spawn } from 'child_process'
import * as fs from 'fs'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { resolveVideoUrls } from './video-providers'
import { i420FrameSize } from '../../logic/color-convert'
import type { IVideoCompositor, IVideoCompositorComponent, SlideVideoInfo, VideoFrameSnapshot } from './types'
import type { INetworkValidatorComponent } from '../../logic/network-validator/types'
import type { AppComponents } from '../../types'
import type { ILiveKitPublisher } from '../livekit-publisher/types'
import type { ChildProcess } from 'child_process'
import type { IncomingMessage } from 'http'

const FRAME_RATE = 20
const VIDEO_BUFFER_TYPE_I420 = 5 // VideoBufferType.I420 from @livekit/rtc-node
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const DOWNLOAD_TIMEOUT_MS = 120_000 // 120 seconds
const MAX_VIDEO_DOWNLOAD_SIZE = 1024 * 1024 * 1024 // 1 GB — rely on streaming for larger files
// Frames to skip after seeking — overlay filter passes the slide background
// through before the video decoder is ready (~10 frames ≈ 500ms at 20fps)
const SEEK_WARMUP_FRAMES = 10

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
  let cleanedUp = false
  let onEndCallback: (() => void) | null = null
  let lastPushedFrame: VideoFrameSnapshot | null = null
  let currentSlidePath: string | null = null

  /** Downloads a video to disk via HTTPS with redirect following, SSRF validation, and size limit. */
  async function httpsDownload(url: string, destPath: string): Promise<void> {
    const MAX_REDIRECTS = 5
    let currentUrl = url

    for (let i = 0; i < MAX_REDIRECTS; i++) {
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        https.get(currentUrl, resolve).on('error', reject)
      })

      // Follow redirects — validate each hop to prevent SSRF via open redirect
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        currentUrl = new URL(res.headers.location, currentUrl).href
        await networkValidator.validateHttpsUrl(currentUrl)
        continue
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        throw new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`)
      }

      // Pipe to file with size limit
      await new Promise<void>((resolve, reject) => {
        let bytesWritten = 0
        const file = fs.createWriteStream(destPath)

        res.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length
          if (bytesWritten > MAX_VIDEO_DOWNLOAD_SIZE) {
            res.destroy(new Error(`Video download exceeds ${MAX_VIDEO_DOWNLOAD_SIZE / (1024 * 1024 * 1024)}GB limit`))
          }
        })

        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', (err) => fs.unlink(destPath, () => reject(err)))
        res.on('error', (err) => {
          file.destroy()
          fs.unlink(destPath, () => reject(err))
        })
      })
      return
    }

    throw new Error(`Too many redirects downloading ${url}`)
  }

  /** Remux a raw download into a clean MP4 with properly indexed streams. */
  function remuxToMp4(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        'ffmpeg',
        ['-protocol_whitelist', 'file', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      )

      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Remux failed (code ${code}): ${stderr.slice(-300)}`))
          return
        }
        resolve()
      })
      proc.on('error', reject)
    })
  }

  async function tryDownload(downloadUrl: string): Promise<string> {
    const rawPath = path.join(dir, `raw-${Date.now()}`)
    const destPath = path.join(dir, `video-${Date.now()}.mp4`)

    // eslint-disable-next-line prefer-const -- assigned synchronously inside the Promise constructor
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutSignal = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)),
        DOWNLOAD_TIMEOUT_MS
      )
    })

    async function doDownload(): Promise<string> {
      // Step 1: Download raw bytes via HTTPS (handles Google Drive redirects)
      await httpsDownload(downloadUrl, rawPath)

      const stat = fs.statSync(rawPath)
      if (stat.size < 1024) {
        fs.unlinkSync(rawPath)
        throw new Error(`File too small (${stat.size} bytes), likely not a valid video`)
      }

      // Step 2: Remux into a clean MP4 with faststart + proper stream indexing
      await remuxToMp4(rawPath, destPath)

      return destPath
    }

    try {
      return await Promise.race([doDownload(), timeoutSignal])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // Clean up raw file
      try {
        fs.unlinkSync(rawPath)
      } catch {
        /* already deleted or never created */
      }
    }
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

    if (audioProcess) {
      audioProcess.kill('SIGKILL')
      audioProcess = null
    }

    frameAccumulator = Buffer.alloc(0)
    frameAccumLength = 0
    publisher.pushFrame(slideBuffer, slideWidth, slideHeight)
    publisher.startHeartbeat(slideBuffer, slideWidth, slideHeight)
  }

  return {
    async downloadVideo(url: string): Promise<string> {
      const validatedUrl = await networkValidator.validateVideoUrl(url)
      const { downloadUrls } = resolveVideoUrls(validatedUrl)

      let lastError: Error | null = null
      for (const downloadUrl of downloadUrls) {
        try {
          return await tryDownload(downloadUrl)
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
          logger.warn(`Download attempt failed: ${lastError.message}`)
        }
      }
      throw lastError || new Error(`Failed to download video: ${url}`)
    },

    async resolveStreamUrl(url: string): Promise<string> {
      const validatedUrl = await networkValidator.validateVideoUrl(url)
      return resolveVideoUrls(validatedUrl).streamUrl
    },

    async startPlayback(
      videoPath: string,
      videoInfo: SlideVideoInfo,
      slideBuffer: Buffer,
      slideWidth: number,
      slideHeight: number,
      publisher: ILiveKitPublisher,
      onAudioData?: (pcmChunk: Buffer) => void,
      seekSeconds?: number
    ): Promise<void> {
      isPlaying = true
      cleanedUp = false

      const { x, y, width: vw, height: vh } = videoInfo.geometry
      validateFilterParam(x, 'x')
      validateFilterParam(y, 'y')
      validateFilterParam(vw, 'vw')
      validateFilterParam(vh, 'vh')

      const compositeFrameSize = i420FrameSize(slideWidth, slideHeight)

      // Clean up previous slide file before writing a new one (pause/resume cycle)
      if (currentSlidePath) {
        try {
          fs.unlinkSync(currentSlidePath)
        } catch {
          /* already deleted */
        }
      }
      currentSlidePath = path.join(dir, `slide-${Date.now()}.rgba`)
      fs.writeFileSync(currentSlidePath, slideBuffer)

      // Overlay video at PDF geometry coordinates
      const filterComplex = `[1:v]scale=${vw}:${vh}[vid];[0:v][vid]overlay=${x}:${y}:shortest=1`

      // -ss before -i for input seeking (used for resume after pause)
      // Modern FFmpeg enables -accurate_seek by default, so input seeking
      // jumps to the nearest keyframe then decodes forward to the exact timestamp.
      const seekArgs = seekSeconds ? ['-ss', String(seekSeconds)] : []

      // videoPath may be a local file (cached) or HTTPS URL (streaming);
      // include network protocols since the URL was already validated via validateVideoUrl
      const protocols = videoPath.startsWith('http') ? 'file,pipe,http,https,tcp,tls,crypto' : 'file,pipe'

      // Video composite — -re on video input for real-time pacing
      const ffmpegArgs = [
        '-protocol_whitelist',
        protocols,
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
        currentSlidePath,
        '-threads',
        '1',
        ...seekArgs,
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

      let compositeStderr = ''
      compositeProcess.stderr?.on('data', (chunk: Buffer) => {
        compositeStderr = (compositeStderr + chunk.toString()).slice(-500)
      })

      // Audio process — uses -re for real-time pacing (killed on pause, restarted on resume)
      if (onAudioData) {
        audioProcess = spawn(
          'ffmpeg',
          [
            '-protocol_whitelist',
            protocols,
            '-threads',
            '1',
            '-re',
            ...seekArgs,
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

        let audioStderr = ''
        audioProcess.stderr?.on('data', (chunk: Buffer) => {
          audioStderr = (audioStderr + chunk.toString()).slice(-500)
        })

        audioProcess.stdout?.on('data', (chunk: Buffer) => {
          if (isPlaying) {
            onAudioData(Buffer.from(chunk))
          }
        })

        audioProcess.on('close', (code) => {
          if (code && code !== 0 && !cleanedUp) {
            logger.warn(`Audio process exited with error`, { code, stderr: audioStderr })
          }
          audioProcess = null
        })
      }

      // Push video frames as complete frames arrive — FFmpeg -re handles pacing.
      // Defer stopHeartbeat() until the first composite frame is ready so the
      // heartbeat (started on pause) keeps the stream alive during FFmpeg startup.
      //
      // When resuming from seek, the overlay filter passes through the slide
      // background before the video decoder is ready. Skip those initial frames
      // so the heartbeat's frozen video frame stays visible until real composites arrive.
      let firstFrameDelivered = false
      const seekWarmupFrames = seekSeconds ? SEEK_WARMUP_FRAMES : 0
      let framesReceived = 0

      dataListener = (chunk: Buffer) => {
        if (frameAccumLength === 0) {
          frameAccumulator = chunk
          frameAccumLength = chunk.length
        } else {
          frameAccumulator = Buffer.concat([frameAccumulator, chunk])
          frameAccumLength = frameAccumulator.length
        }

        while (frameAccumLength >= compositeFrameSize) {
          if (!isPlaying) break

          // During seek warmup, discard slide-only pass-through frames
          if (framesReceived < seekWarmupFrames) {
            framesReceived++
            frameAccumulator = frameAccumulator.subarray(compositeFrameSize)
            frameAccumLength = frameAccumulator.length
            continue
          }

          if (!firstFrameDelivered) {
            publisher.stopHeartbeat()
            firstFrameDelivered = true
          }
          const frame = frameAccumulator.subarray(0, compositeFrameSize)
          const frameCopy = Buffer.from(frame)
          lastPushedFrame = {
            buffer: frameCopy,
            width: slideWidth,
            height: slideHeight,
            bufferType: VIDEO_BUFFER_TYPE_I420
          }
          publisher.pushFrame(frameCopy, slideWidth, slideHeight, VIDEO_BUFFER_TYPE_I420)
          frameAccumulator = frameAccumulator.subarray(compositeFrameSize)
          frameAccumLength = frameAccumulator.length
        }
      }
      compositeProcess.stdout?.on('data', dataListener)

      compositeProcess.on('close', (code) => {
        if (code && code !== 0 && !cleanedUp) {
          logger.warn(`Composite process exited with error`, { code, stderr: compositeStderr })
        }
        if (!cleanedUp && isPlaying) {
          stopPlayback(publisher, slideBuffer, slideWidth, slideHeight)
          if (onEndCallback) onEndCallback()
        }
      })

      logger.info(`Video playback started (audio: ${onAudioData ? 'enabled' : 'disabled'})`, {
        slideSize: `${slideWidth}x${slideHeight}`,
        compositeSize: `${slideWidth}x${slideHeight}`,
        videoSize: `${vw}x${vh}`,
        position: `${x},${y}`,
        seekSeconds: seekSeconds ?? 0
      })
    },

    onEnd(callback: () => void): void {
      onEndCallback = callback
    },

    getIsPlaying(): boolean {
      return isPlaying
    },

    getLastFrame(): VideoFrameSnapshot | null {
      return lastPushedFrame
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
