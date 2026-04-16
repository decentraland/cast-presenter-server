import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { resolveVideoUrls } from './video-providers'
import { i420FrameSize } from '../../logic/color-convert'
import { pinnedHttpsRequest } from '../../logic/network-validator'
import type { IVideoCompositor, IVideoCompositorComponent, SlideVideoInfo, VideoFrameSnapshot } from './types'
import type { INetworkValidatorComponent } from '../../logic/network-validator/types'
import type { AppComponents } from '../../types'
import type { ILiveKitPublisher } from '../livekit-publisher/types'
import type { ChildProcess } from 'child_process'

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

  /**
   * Downloads a video to disk via HTTPS with redirect following, DNS-pinned SSRF protection, and size limit.
   *
   * @param connectionRef - Optional ref updated with the active connection's destroy callback,
   *   allowing the caller (e.g. timeout handler) to abort the in-flight request.
   */
  async function httpsDownload(
    url: string,
    destPath: string,
    connectionRef?: { destroy: (() => void) | null }
  ): Promise<void> {
    const MAX_REDIRECTS = 5
    let currentUrl = url

    for (let i = 0; i < MAX_REDIRECTS; i++) {
      // Validate and pin DNS on every hop (including the initial request)
      const resolved = await networkValidator.resolveAndValidateUrl(currentUrl)
      const { response: res, destroy } = await pinnedHttpsRequest(resolved.url, resolved.hostname, resolved.addresses)
      if (connectionRef) connectionRef.destroy = destroy

      // Follow redirects — each new target is validated at the top of the loop
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        destroy()
        currentUrl = new URL(res.headers.location, currentUrl).href
        continue
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        destroy()
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
            destroy()
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
  function remuxToMp4(inputPath: string, outputPath: string): { promise: Promise<void>; kill: () => void } {
    const proc = spawn(
      'ffmpeg',
      ['-protocol_whitelist', 'file', '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )

    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const promise = new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Remux failed (code ${code}): ${stderr.slice(-300)}`))
          return
        }
        resolve()
      })
      proc.on('error', reject)
    })

    return {
      promise,
      kill: () => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already exited */
        }
      }
    }
  }

  async function tryDownload(downloadUrl: string): Promise<string> {
    const rawPath = path.join(dir, `raw-${Date.now()}`)
    const destPath = path.join(dir, `video-${Date.now()}.mp4`)
    let succeeded = false

    // eslint-disable-next-line prefer-const -- assigned synchronously inside the Promise constructor
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const activeConnection: { destroy: (() => void) | null } = { destroy: null }

    const timeoutSignal = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        // Abort the in-flight HTTPS connection so it stops accumulating data
        if (activeConnection.destroy) activeConnection.destroy()
        reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`))
      }, DOWNLOAD_TIMEOUT_MS)
    })

    // Object wrapper prevents TypeScript from narrowing killRemux to `never`
    // across the async Promise.race boundary
    const remuxState: { kill: (() => void) | null } = { kill: null }

    async function doDownload(): Promise<string> {
      // Step 1: Download raw bytes via HTTPS (handles Google Drive redirects)
      await httpsDownload(downloadUrl, rawPath, activeConnection)

      const stat = fs.statSync(rawPath)
      if (stat.size < 1024) {
        fs.unlinkSync(rawPath)
        throw new Error(`File too small (${stat.size} bytes), likely not a valid video`)
      }

      // Step 2: Remux into a clean MP4 with faststart + proper stream indexing
      const remux = remuxToMp4(rawPath, destPath)
      remuxState.kill = remux.kill
      await remux.promise

      return destPath
    }

    try {
      const download = doDownload()
      // Suppress unhandled rejection if timeout wins the race and doDownload rejects later
      download.catch(() => {
        /* suppressed — timeout won the race */
      })
      const result = await Promise.race([download, timeoutSignal])
      succeeded = true
      return result
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (remuxState.kill) remuxState.kill()
      // Clean up raw file
      try {
        fs.unlinkSync(rawPath)
      } catch {
        /* already deleted or never created */
      }
      // Clean up partial dest file on failure (timeout or remux error)
      if (!succeeded) {
        try {
          fs.unlinkSync(destPath)
        } catch {
          /* never created or already deleted */
        }
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

      // videoPath is always a local file (downloaded before playback) —
      // no network protocols are exposed to FFmpeg, preventing HLS/DASH
      // playlist attacks that reference file:// URIs
      const protocols = 'file,pipe'

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
      if (currentSlidePath) {
        try {
          fs.unlinkSync(currentSlidePath)
        } catch {
          /* ignore */
        }
        currentSlidePath = null
      }
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
