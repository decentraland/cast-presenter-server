import { spawn } from 'child_process'
import * as dns from 'dns/promises'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { LiveKitPublisher } from './livekit-publisher'
import type { SlideVideoInfo } from '../logic/types'
import type { ChildProcess } from 'child_process'

// TODO: Implement audio track for videos
// Current approach (fd 3 pipe from ffmpeg) causes audio track corruption
// after the first video play. Needs investigation into @livekit/rtc-node
// AudioSource lifecycle — possibly publish once and mute/unmute, or use
// a separate dedicated audio publisher.

const FRAME_RATE = 15
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024 // 500 MB
const DOWNLOAD_TIMEOUT_MS = 60_000 // 60 seconds

// Allowed domains for video downloads extracted from PDF annotations
const ALLOWED_VIDEO_DOMAINS = new Set([
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'vimeo.com',
  'player.vimeo.com'
])

// Private IP ranges — block SSRF to internal services
export function isPrivateIP(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return false
  // 127.0.0.0/8
  if (parts[0] === 127) return true
  // 10.0.0.0/8
  if (parts[0] === 10) return true
  // 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  // 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (parts[0] === 169 && parts[1] === 254) return true
  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true
  return false
}

export async function validateVideoUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid video URL: ${url}`)
  }

  // Only allow HTTPS
  if (parsed.protocol !== 'https:') {
    throw new Error(`Video URL must use HTTPS, got ${parsed.protocol} for ${url}`)
  }

  // Domain allowlist
  if (!ALLOWED_VIDEO_DOMAINS.has(parsed.hostname)) {
    throw new Error(`Video URL domain not allowed: ${parsed.hostname}`)
  }

  // DNS resolution check — block private IPs
  try {
    const addresses = await dns.resolve4(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`Video URL resolves to private IP: ${parsed.hostname} → ${addr}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
    // DNS resolution failure — let the download fail naturally
  }
}

export function validateFilterParam(value: number, name: string, max = 7680): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`Invalid ffmpeg filter param ${name}=${value}, must be integer 0-${max}`)
  }
}

// Extract Google Drive file ID from various URL patterns
function extractDriveFileId(url: string): string | null {
  const patterns = [/\/file\/d\/([a-zA-Z0-9_-]+)/, /[?&]id=([a-zA-Z0-9_-]+)/, /\/uc\?.*id=([a-zA-Z0-9_-]+)/]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

function getDriveDownloadUrls(fileId: string): string[] {
  // Try multiple URL formats — Google Drive is inconsistent about which works
  return [
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
    `https://drive.google.com/uc?id=${fileId}&export=download&confirm=t`
  ]
}

export class VideoCompositor {
  private compositeProcess: ChildProcess | null = null
  private frameLoop: ReturnType<typeof setInterval> | null = null
  private videoBuffer: Buffer = Buffer.alloc(0)
  private tempDir: string
  private logger: ILoggerComponent.ILogger
  private isPlaying = false
  private cleanedUp = false
  private onEndCallback: (() => void) | null = null

  constructor(logger: ILoggerComponent.ILogger, tempDir?: string) {
    this.logger = logger
    this.tempDir = tempDir || fs.mkdtempSync(path.join(os.tmpdir(), 'cast-presenter-'))
  }

  async downloadVideo(url: string): Promise<string> {
    // SSRF protection: validate URL before downloading
    await validateVideoUrl(url)

    const driveFileId = extractDriveFileId(url)
    const urlsToTry = driveFileId ? getDriveDownloadUrls(driveFileId) : [url]

    let lastError: Error | null = null

    for (const downloadUrl of urlsToTry) {
      try {
        const result = await this.tryDownload(downloadUrl, url)
        return result
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        this.logger.warn(`Download attempt failed: ${lastError.message}`)
      }
    }

    throw lastError || new Error(`Failed to download video: ${url}`)
  }

  private async tryDownload(downloadUrl: string, originalUrl: string): Promise<string> {
    const destPath = path.join(this.tempDir, `video-${Date.now()}.mp4`)

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

    // Reject HTML error pages from Google Drive
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

  /**
   * Resolve the original URL to a direct download URL that ffmpeg can stream.
   * Used when video isn't pre-downloaded — ffmpeg streams it directly.
   * Validates URL against SSRF protections before returning.
   */
  async resolveStreamUrl(url: string): Promise<string> {
    await validateVideoUrl(url)
    const driveFileId = extractDriveFileId(url)
    if (driveFileId) {
      return `https://drive.usercontent.google.com/download?id=${driveFileId}&export=download&confirm=t`
    }
    return url
  }

  private probeVideo(filePath: string): Promise<boolean> {
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

  async preTranscode(inputPath: string, width: number, height: number): Promise<string> {
    validateFilterParam(width, 'width')
    validateFilterParam(height, 'height')

    const isValid = await this.probeVideo(inputPath)
    if (!isValid) {
      throw new Error(`Not a valid video file: ${inputPath}`)
    }

    const outputPath = path.join(this.tempDir, `transcoded-${Date.now()}-${width}x${height}.mp4`)

    return new Promise((resolve, reject) => {
      const proc = spawn(
        'ffmpeg',
        [
          '-i',
          inputPath,
          '-map',
          '0:v',
          '-vf',
          `scale=${width}:${height}`,
          '-c:v',
          'libx264',
          '-preset',
          'fast',
          '-an', // no audio in pre-transcode
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
          this.logger.info(`Pre-transcoded video to ${width}x${height}`)
          resolve(outputPath)
        } else {
          reject(new Error(`Pre-transcode failed (code ${code}): ${stderr.slice(-200)}`))
        }
      })

      proc.on('error', reject)
    })
  }

  async startPlayback(
    videoPath: string,
    videoInfo: SlideVideoInfo,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    publisher: LiveKitPublisher
  ): Promise<void> {
    this.isPlaying = true

    const { x, y, width: vw, height: vh } = videoInfo.geometry
    validateFilterParam(x, 'x')
    validateFilterParam(y, 'y')
    validateFilterParam(vw, 'vw')
    validateFilterParam(vh, 'vh')
    const compositeFrameSize = slideWidth * slideHeight * 4

    // Write slide as raw RGBA file for ffmpeg to use as background
    const slidePath = path.join(this.tempDir, `slide-${Date.now()}.rgba`)
    fs.writeFileSync(slidePath, slideBuffer)

    // Single ffmpeg process: slide background + video overlay → composited RGBA
    // Video only — no audio (TODO: implement audio separately)
    this.compositeProcess = spawn(
      'ffmpeg',
      [
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
        '-i',
        videoPath,
        '-filter_complex',
        `[1:v]scale=${vw}:${vh}[vid];[0:v][vid]overlay=${x}:${y}:shortest=1`,
        '-an', // no audio output
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-r',
        String(FRAME_RATE),
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    // Buffer composited video data
    this.compositeProcess.stdout?.on('data', (chunk: Buffer) => {
      this.videoBuffer = Buffer.concat([this.videoBuffer, chunk])
    })

    this.compositeProcess.stderr?.on('data', () => {
      /* noop */
    })

    // Stop heartbeat since we're pushing composited frames
    publisher.stopHeartbeat()

    const MAX_BUFFERED_FRAMES = 5
    const POLL_INTERVAL_MS = 30

    // Frame loop — video only
    this.frameLoop = setInterval(() => {
      if (!this.isPlaying) return

      // Drop stale frames
      const maxVideoBytes = compositeFrameSize * MAX_BUFFERED_FRAMES
      if (this.videoBuffer.length > maxVideoBytes) {
        const framesToDrop = Math.floor(this.videoBuffer.length / compositeFrameSize) - 1
        this.videoBuffer = this.videoBuffer.subarray(framesToDrop * compositeFrameSize)
      }

      if (this.videoBuffer.length >= compositeFrameSize) {
        const frame = this.videoBuffer.subarray(0, compositeFrameSize)
        this.videoBuffer = this.videoBuffer.subarray(compositeFrameSize)
        publisher.pushFrame(Buffer.from(frame), slideWidth, slideHeight)
      }
    }, POLL_INTERVAL_MS)

    // When video ends naturally, clean up (but not if cleanup() was already called)
    this.compositeProcess.on('close', () => {
      if (!this.cleanedUp && this.isPlaying) {
        this.stopPlayback(publisher, slideBuffer, slideWidth, slideHeight)
        if (this.onEndCallback) this.onEndCallback()
      }
    })

    this.logger.info('Video playback started (video only, no audio)', {
      slideSize: `${slideWidth}x${slideHeight}`,
      videoSize: `${vw}x${vh}`,
      position: `${x},${y}`
    })
  }

  pausePlayback(): void {
    if (this.compositeProcess) {
      this.compositeProcess.kill('SIGSTOP')
    }
    this.isPlaying = false
  }

  resumePlayback(): void {
    if (this.compositeProcess) {
      this.compositeProcess.kill('SIGCONT')
    }
    this.isPlaying = true
  }

  stopPlayback(publisher: LiveKitPublisher, slideBuffer: Buffer, slideWidth: number, slideHeight: number): void {
    this.cleanedUp = true
    this.isPlaying = false

    if (this.frameLoop) {
      clearInterval(this.frameLoop)
      this.frameLoop = null
    }

    if (this.compositeProcess) {
      this.compositeProcess.kill('SIGKILL')
      this.compositeProcess = null
    }

    this.videoBuffer = Buffer.alloc(0)

    // Revert to static slide with heartbeat
    publisher.pushFrame(slideBuffer, slideWidth, slideHeight)
    publisher.startHeartbeat(slideBuffer, slideWidth, slideHeight)
  }

  onEnd(callback: () => void): void {
    this.onEndCallback = callback
  }

  getIsPlaying(): boolean {
    return this.isPlaying
  }

  cleanup(): void {
    this.cleanedUp = true
    this.isPlaying = false
    if (this.frameLoop) {
      clearInterval(this.frameLoop)
      this.frameLoop = null
    }
    if (this.compositeProcess) {
      this.compositeProcess.kill('SIGKILL')
      this.compositeProcess = null
    }
    this.videoBuffer = Buffer.alloc(0)
  }

  static destroyTempDir(tempDir: string): void {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}
