import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { resolveVideoUrls } from './video-providers'
import { i420FrameSize } from '../../logic/color-convert'
import type { IVideoCompositor, IVideoCompositorComponent, SlideVideoInfo } from './types'
import type { INetworkValidatorComponent } from '../../logic/network-validator/types'
import type { AppComponents } from '../../types'
import type { ILiveKitPublisher } from '../livekit-publisher/types'
import type { ChildProcess } from 'child_process'

const FRAME_RATE = 20
const VIDEO_BUFFER_TYPE_I420 = 5 // VideoBufferType.I420 from @livekit/rtc-node
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNELS = 2
const DOWNLOAD_TIMEOUT_MS = 120_000 // 120 seconds

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
  let isPaused = false
  let cleanedUp = false
  let onEndCallback: (() => void) | null = null

  async function tryDownload(downloadUrl: string): Promise<string> {
    const destPath = path.join(dir, `video-${Date.now()}.mp4`)

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${downloadUrl}`))
      }, DOWNLOAD_TIMEOUT_MS)

      // Use FFmpeg to download — its HTTP handler follows Google Drive redirects
      // that Node's fetch cannot (virus scan confirmation pages).
      // -c copy = no re-encoding, just remux to mp4.
      const proc = spawn('ffmpeg', ['-threads', '1', '-i', downloadUrl, '-c', 'copy', '-y', destPath], {
        stdio: ['ignore', 'ignore', 'pipe']
      })

      let stderr = ''
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      proc.on('close', (code) => {
        clearTimeout(timeout)
        if (code !== 0) {
          reject(new Error(`FFmpeg download failed (code ${code}): ${stderr.slice(-200)}`))
          return
        }
        try {
          const stat = fs.statSync(destPath)
          if (stat.size < 1024) {
            fs.unlinkSync(destPath)
            reject(new Error(`File too small (${stat.size} bytes), likely not a valid video`))
            return
          }
          resolve(destPath)
        } catch (err) {
          reject(err)
        }
      })

      proc.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
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
      const { downloadUrls } = resolveVideoUrls(url)

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
      await networkValidator.validateVideoUrl(url)
      return resolveVideoUrls(url).streamUrl
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

      const slidePath = path.join(dir, `slide-${Date.now()}.rgba`)
      fs.writeFileSync(slidePath, slideBuffer)

      // Overlay video at PDF geometry coordinates
      const filterComplex = `[1:v]scale=${vw}:${vh}[vid];[0:v][vid]overlay=${x}:${y}:shortest=1`

      // -ss before -i for input seeking (used for resume after pause)
      // Modern FFmpeg enables -accurate_seek by default, so input seeking
      // jumps to the nearest keyframe then decodes forward to the exact timestamp.
      const seekArgs = seekSeconds ? ['-ss', String(seekSeconds)] : []

      // Video composite — -re on video input for real-time pacing
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

      compositeProcess.stderr?.on('data', () => {
        /* noop */
      })

      // Audio process — uses -re for real-time pacing (killed on pause, restarted on resume)
      if (onAudioData) {
        audioProcess = spawn(
          'ffmpeg',
          [
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

        audioProcess.stderr?.on('data', () => {
          /* noop */
        })

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

      // Push video frames as complete frames arrive — FFmpeg -re handles pacing
      dataListener = (chunk: Buffer) => {
        if (frameAccumLength === 0) {
          frameAccumulator = chunk
          frameAccumLength = chunk.length
        } else {
          frameAccumulator = Buffer.concat([frameAccumulator, chunk])
          frameAccumLength = frameAccumulator.length
        }

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
        position: `${x},${y}`,
        seekSeconds: seekSeconds ?? 0
      })
    },

    pausePlayback(): void {
      isPaused = true
    },

    resumePlayback(): void {
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
