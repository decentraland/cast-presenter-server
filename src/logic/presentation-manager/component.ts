import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { InvalidLivekitCredentialsError, MaxConcurrentPresentationsError, PresentationNotFoundError } from './errors'
import type { IPresentationManager, PresentationInfo, PresentationSession, PresentationState } from './types'
import type { ILiveKitPublisher } from '../../adapters/livekit-publisher/types'
import type { IPdfRenderer } from '../../adapters/pdf-renderer/types'
import type { IVideoCompositor } from '../../adapters/video-compositor/types'
import type { AppComponents } from '../../types'

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_MAX_CONCURRENT = 10
// Total disk a single session may consume across all its downloaded videos.
// Per-file cap (MAX_VIDEO_DOWNLOAD_SIZE = 1 GB) is enforced inside the compositor.
// This bound protects tempDir capacity when a deck references many videos.
export const SESSION_DISK_QUOTA_BYTES = 2 * 1024 * 1024 * 1024 // 2 GB

class SessionDiskQuotaExceededError extends Error {
  constructor(used: number, requested: number) {
    super(`Session disk quota exceeded (used=${used}, adding=${requested}, limit=${SESSION_DISK_QUOTA_BYTES})`)
    this.name = 'SessionDiskQuotaExceededError'
  }
}

interface InternalSession extends PresentationSession {
  renderer: IPdfRenderer
  publisher: ILiveKitPublisher
  compositor: IVideoCompositor | null
  cachedVideoPaths: Map<string, string>
  navigating: boolean
  tempDir: string
  lastActivityAt: number
  videoPlaybackStartedAt: number
  videoElapsedBeforePause: number
  pausedVideoIndex: number
  stoppingPromise: Promise<void> | null
  videoErrorReason: string | null
  preDownloadTimer: ReturnType<typeof setTimeout> | null
  // Signalled when the session stops; cancels in-flight downloads so we don't
  // race with tempDir cleanup or write to a deleted directory.
  abortController: AbortController
  // Cumulative bytes written to tempDir across all downloads; enforced against
  // SESSION_DISK_QUOTA_BYTES to bound disk usage per session.
  bytesDownloaded: number
}

/** Maps download/playback errors to user-friendly reasons. */
function classifyVideoError(err: Error): string {
  if (err instanceof SessionDiskQuotaExceededError) {
    return 'Presentation has exceeded its video disk budget — stop other videos or restart the session'
  }
  const msg = err.message
  if (/HTTP 40[13]/.test(msg)) return 'Video not authorized — check sharing permissions'
  if (/HTTP 404/.test(msg)) return 'Video not found or no longer available'
  if (/HTTP [45]\d\d/.test(msg)) return 'Video server error — try again later'
  if (/timed out/i.test(msg)) return 'Video download timed out — file may be too large'
  if (/exceeds.*limit/i.test(msg)) return 'Video exceeds maximum size limit'
  if (/too many redirects/i.test(msg)) return 'Video URL has too many redirects'
  if (/too small/i.test(msg)) return 'File is not a valid video'
  if (/remux failed/i.test(msg)) return 'Video format is not supported'
  return 'Video unavailable'
}

/**
 * Creates the presentation manager logic component.
 *
 * Orchestrates the full presentation lifecycle:
 * 1. Connects to LiveKit (fail-fast auth validation)
 * 2. Initializes PDF renderer and renders first slide
 * 3. Publishes video track and starts heartbeat
 * 4. Handles navigation, video playback, and session cleanup
 *
 * Uses START_COMPONENT/STOP_COMPONENT for idle session cleanup lifecycle.
 *
 * @param components - Required: config, logs, liveKitPublisher, pdfRenderer, videoCompositor
 * @returns IPresentationManager implementation
 */
export async function createPresentationManager(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'metrics' | 'liveKitPublisher' | 'pdfRenderer' | 'videoCompositor'
  >
): Promise<IPresentationManager> {
  const { config, logs, metrics, liveKitPublisher, pdfRenderer, videoCompositor } = components
  const logger = logs.getLogger('presentation-manager')

  // Resolve config at component creation (0 = unlimited per .env.default docs)
  const maxConcurrentRaw = await config.getString('MAX_CONCURRENT_PRESENTATIONS')
  const parsed = maxConcurrentRaw !== undefined ? parseInt(maxConcurrentRaw, 10) : NaN
  const maxConcurrent = Number.isNaN(parsed) || parsed < 0 ? DEFAULT_MAX_CONCURRENT : parsed === 0 ? Infinity : parsed

  const sessions = new Map<string, InternalSession>()
  let inFlightCreations = 0
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null

  async function cleanupIdleSessions(): Promise<void> {
    const now = Date.now()
    for (const [id, session] of [...sessions.entries()]) {
      const participantCount = session.publisher.getRemoteParticipantCount()
      if (participantCount > 0) {
        session.lastActivityAt = now
      } else if (now - session.lastActivityAt >= DEFAULT_IDLE_TIMEOUT_MS) {
        logger.info(`Session ${id} idle for ${DEFAULT_IDLE_TIMEOUT_MS / 1000}s with no participants, cleaning up`)
        try {
          await stopSession(session)
          metrics.increment('idle_session_cleanups_total')
        } catch (err) {
          logger.warn(`Failed to stop idle session ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  async function validateCredentials(livekitUrl: string, livekitToken: string): Promise<void> {
    // Throw-away publisher connects and disconnects immediately. Used to
    // pre-flight bogus tokens before expensive work (e.g. fetching a
    // user-supplied URL that could be 100 MB).
    const publisher = liveKitPublisher.createPublisher('validate', logs.getLogger('livekit-validate'))
    try {
      await publisher.connect(livekitUrl, livekitToken)
    } catch (err) {
      throw new InvalidLivekitCredentialsError(err instanceof Error ? err.message : String(err))
    } finally {
      await publisher.disconnect().catch(() => {
        /* best-effort cleanup */
      })
    }
  }

  async function broadcastState(session: InternalSession): Promise<void> {
    const state = getStateFromSession(session)
    try {
      await session.publisher.publishData({
        type: 'presentation:state',
        ...state
      })
    } catch (err) {
      logger.warn(`Failed to broadcast state: ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      await session.publisher.updateMetadataState(state)
    } catch (err) {
      logger.warn(`Failed to update metadata: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function createPresentation(
    fileBuffer: Buffer,
    fileType: 'pdf' | 'pptx',
    livekitToken: string,
    livekitUrl: string,
    fileName?: string
  ): Promise<PresentationInfo> {
    if (sessions.size + inFlightCreations >= maxConcurrent) {
      throw new MaxConcurrentPresentationsError(maxConcurrent)
    }

    inFlightCreations++
    const id = randomUUID()
    logger.info(`Creating presentation ${id}`, { fileType, fileSize: fileBuffer.length })

    const publisherLogger = logs.getLogger(`livekit-publisher:${id}`)
    const publisher = liveKitPublisher.createPublisher(id, publisherLogger)

    let renderer: ReturnType<typeof pdfRenderer.createRenderer> | null = null
    let tempDir: string | null = null

    try {
      // Connect to LiveKit FIRST — validates the token (fail-fast auth)
      await publisher.connect(livekitUrl, livekitToken)

      // Initialize PDF renderer
      renderer = pdfRenderer.createRenderer()
      await renderer.initialize(fileBuffer)
      const slideCount = renderer.getSlideCount()
      if (slideCount === 0) {
        throw new Error('PDF contains no pages')
      }

      // Handle data channel commands from participants
      publisher.setDataHandler(async (message: Record<string, unknown>) => {
        const session = sessions.get(id)
        if (!session) return
        try {
          switch (message.type) {
            case 'presentation:navigate': {
              const action = message.action
              if (action !== 'next' && action !== 'prev' && action !== 'goto') break
              // Number.isInteger rejects NaN, Infinity, floats and non-numbers.
              // Without this, NaN slips past `< 0` and `>= slideCount` checks
              // (both are false for NaN) and propagates as a silently broken index.
              const slideIndex =
                Number.isInteger(message.slideIndex) && (message.slideIndex as number) >= 0
                  ? (message.slideIndex as number)
                  : undefined
              await navigateSession(session, action, slideIndex)
              break
            }
            case 'presentation:video:play': {
              const videoIndex = Number.isInteger(message.videoIndex) ? (message.videoIndex as number) : -1
              await playVideoSession(session, videoIndex)
              break
            }
            case 'presentation:video:pause':
              await pauseVideoSession(session)
              break
            case 'presentation:video:stop':
              await stopVideoSession(session)
              break
            case 'presentation:stop':
              await stopSession(session)
              break
            case 'presentation:get-state':
              await broadcastState(session)
              break
          }
        } catch (err) {
          logger.warn(`Data channel command failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })

      // Render first slide
      const { buffer, width, height } = await renderer.renderSlide(0)

      // Start publishing video track
      await publisher.startPublishing(width, height)

      publisher.pushFrame(buffer, width, height)
      publisher.startHeartbeat(buffer, width, height)

      // Get video annotations for first slide
      const slideVideos = await renderer.getSlideVideos(0)

      // Create shared temp dir for the entire session
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cast-presenter-${id}-`))

      const presentationName = fileName?.replace(/\.[^.]+$/, '') || 'Presentation'

      const session: InternalSession = {
        id,
        roomId: '',
        fileName: presentationName,
        fileType,
        slideCount,
        currentSlide: 0,
        createdAt: new Date(),
        lastFrameBuffer: buffer,
        lastFrameWidth: width,
        lastFrameHeight: height,
        slideVideos,
        videoState: 'idle',
        renderer,
        publisher,
        compositor: null,
        cachedVideoPaths: new Map(),
        tempDir,
        navigating: false,
        videoPlaybackStartedAt: 0,
        videoElapsedBeforePause: 0,
        pausedVideoIndex: -1,
        lastActivityAt: Date.now(),
        stoppingPromise: null,
        videoErrorReason: null,
        preDownloadTimer: null,
        abortController: new AbortController(),
        bytesDownloaded: 0
      }

      sessions.set(id, session)
      metrics.increment('session_created_total', { status: 'success' })
      metrics.increment('active_sessions')
      await broadcastState(session)

      logger.info(`Presentation ${id} created with ${slideCount} slides`, {
        width,
        height,
        slideVideos: slideVideos.length
      })

      // Pre-download videos in the background after stream establishes
      session.preDownloadTimer = setTimeout(() => {
        session.preDownloadTimer = null
        preDownloadVideos(session).catch((err) => {
          logger.warn(
            `Background video pre-download failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
          )
        })
      }, 3000)

      return { id, fileName: presentationName, slideCount, currentSlide: 0, fileType }
    } catch (err) {
      metrics.increment('session_created_total', { status: 'error' })
      if (err instanceof Error && err.message.includes('LiveKit')) {
        metrics.increment('livekit_connection_errors_total')
      }
      // Clean up acquired resources in reverse order on failure
      if (tempDir) {
        videoCompositor.destroyTempDir(tempDir)
      }
      if (renderer) {
        renderer.destroy()
      }
      await publisher.disconnect()
      throw err
    } finally {
      inFlightCreations--
    }
  }

  async function preDownloadVideos(session: InternalSession): Promise<void> {
    const downloader = videoCompositor.createCompositor(logger, session.tempDir)
    const { signal } = session.abortController

    try {
      const videoTargets = new Map<string, { width: number; height: number }>()
      for (let i = 0; i < session.slideCount; i++) {
        if (signal.aborted) return
        const videos = await session.renderer.getSlideVideos(i)
        for (const v of videos) {
          if (!videoTargets.has(v.url)) {
            videoTargets.set(v.url, { width: v.geometry.width, height: v.geometry.height })
          }
        }
      }

      const MAX_PRE_DOWNLOADS = 10
      logger.info(`Pre-download queue: ${videoTargets.size} videos to process (limit: ${MAX_PRE_DOWNLOADS})`)

      let downloaded = 0
      for (const [url] of videoTargets) {
        if (downloaded >= MAX_PRE_DOWNLOADS) {
          logger.info(
            `Pre-download limit reached (${MAX_PRE_DOWNLOADS}), remaining videos will be downloaded on demand`
          )
          break
        }
        if (signal.aborted || !sessions.has(session.id)) {
          logger.info('Session ended, aborting pre-download queue')
          break
        }
        if (session.cachedVideoPaths.has(url)) continue
        if (session.bytesDownloaded >= SESSION_DISK_QUOTA_BYTES) {
          logger.info(
            `Pre-download stopped: session disk quota reached (${session.bytesDownloaded}/${SESSION_DISK_QUOTA_BYTES} bytes)`
          )
          break
        }
        try {
          logger.info(`Pre-downloading video: ${url}`)
          const { path: rawPath, bytes } = await downloader.downloadVideo(url, signal)
          // Enforce quota post-download: per-file cap already bounds one download,
          // and aborting a live HTTPS stream at an exact byte count is awkward.
          if (session.bytesDownloaded + bytes > SESSION_DISK_QUOTA_BYTES) {
            try {
              fs.unlinkSync(rawPath)
            } catch {
              /* ignore */
            }
            logger.warn(
              `Pre-download dropped ${url}: would exceed session quota (${session.bytesDownloaded + bytes}/${SESSION_DISK_QUOTA_BYTES} bytes)`
            )
            break
          }
          session.cachedVideoPaths.set(url, rawPath)
          session.bytesDownloaded += bytes
          logger.info(`Pre-downloaded video: ${url}`)
          downloaded++
        } catch (err) {
          if (signal.aborted) {
            logger.info('Pre-download aborted')
            break
          }
          logger.warn(`Failed to pre-download video: ${url} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      logger.info(`Pre-download queue complete. Cached: ${session.cachedVideoPaths.size} videos`)
    } finally {
      downloader.cleanup()
    }
  }

  async function navigateSession(
    session: InternalSession,
    action: 'next' | 'prev' | 'goto',
    slideIndex?: number
  ): Promise<PresentationState> {
    if (session.navigating) {
      return getStateFromSession(session)
    }

    let targetSlide = session.currentSlide

    switch (action) {
      case 'next':
        targetSlide = Math.min(session.currentSlide + 1, session.slideCount - 1)
        break
      case 'prev':
        targetSlide = Math.max(session.currentSlide - 1, 0)
        break
      case 'goto':
        if (slideIndex === undefined || slideIndex < 0 || slideIndex >= session.slideCount) {
          throw new Error(`Invalid slide index: ${slideIndex}`)
        }
        targetSlide = slideIndex
        break
    }

    if (targetSlide === session.currentSlide) {
      return getStateFromSession(session)
    }

    session.navigating = true

    try {
      if (session.compositor) {
        await session.publisher.stopAudioPublishing()
        session.compositor.cleanup()
        session.compositor = null
      }
      session.videoState = 'idle'
      session.pausedVideoIndex = -1
      session.videoElapsedBeforePause = 0

      const { buffer, width, height } = await session.renderer.renderSlide(targetSlide)

      session.publisher.pushFrame(buffer, width, height)
      session.publisher.startHeartbeat(buffer, width, height)

      const slideVideos = await session.renderer.getSlideVideos(targetSlide)

      session.currentSlide = targetSlide
      session.lastFrameBuffer = buffer
      session.lastFrameWidth = width
      session.lastFrameHeight = height
      session.slideVideos = slideVideos

      metrics.increment('slide_navigations_total', { action })
      logger.info(`Navigated presentation ${session.id} to slide ${targetSlide}`, {
        slideVideos: slideVideos.length
      })

      await broadcastState(session)
      return getStateFromSession(session)
    } finally {
      session.navigating = false
    }
  }

  function getState(id: string): PresentationState | null {
    const session = sessions.get(id)
    if (!session) return null
    return getStateFromSession(session)
  }

  async function playVideoSession(session: InternalSession, videoIndex: number): Promise<void> {
    if (session.navigating) return
    // The check below and the `videoState = 'loading'` write a few lines down
    // form an atomic guard against concurrent play commands. Keep them synchronous —
    // do not introduce any `await` between them, or two rapid calls can both pass
    // the check and allocate duplicate compositors.
    if (session.videoState === 'playing' || session.videoState === 'loading') return

    if (videoIndex < 0 || videoIndex >= session.slideVideos.length) {
      throw new Error(`Invalid video index: ${videoIndex}`)
    }

    const videoInfo = session.slideVideos[videoIndex]

    // Resume from pause: kill old compositor, restart with seek offset
    const seekSeconds =
      session.videoState === 'paused' && session.pausedVideoIndex === videoIndex
        ? session.videoElapsedBeforePause / 1000
        : 0

    const requestedSlide = session.currentSlide
    session.videoState = 'loading'
    session.videoErrorReason = null
    await broadcastState(session)

    if (session.compositor) {
      session.compositor.cleanup()
      session.compositor = null
    }

    const compositorLogger = logs.getLogger(`video-compositor:${session.id}`)
    const compositor = videoCompositor.createCompositor(compositorLogger, session.tempDir)

    let videoPath = session.cachedVideoPaths.get(videoInfo.url)
    if (!videoPath || !fs.existsSync(videoPath)) {
      if (session.bytesDownloaded >= SESSION_DISK_QUOTA_BYTES) {
        compositor.cleanup()
        session.videoState = 'error'
        session.videoErrorReason = classifyVideoError(new SessionDiskQuotaExceededError(session.bytesDownloaded, 0))
        await broadcastState(session)
        logger.warn(`Video play blocked for ${session.id}: session disk quota reached`)
        return
      }
      // Download before playback — FFmpeg must only use file protocol
      try {
        const result = await compositor.downloadVideo(videoInfo.url, session.abortController.signal)
        if (session.bytesDownloaded + result.bytes > SESSION_DISK_QUOTA_BYTES) {
          try {
            fs.unlinkSync(result.path)
          } catch {
            /* ignore */
          }
          throw new SessionDiskQuotaExceededError(session.bytesDownloaded, result.bytes)
        }
        videoPath = result.path
        session.cachedVideoPaths.set(videoInfo.url, videoPath)
        session.bytesDownloaded += result.bytes
        logger.info(`Downloaded video for presentation ${session.id}`, { path: videoPath, bytes: result.bytes })
      } catch (err) {
        compositor.cleanup()
        if (session.abortController.signal.aborted) return
        session.videoState = 'error'
        session.videoErrorReason = classifyVideoError(err instanceof Error ? err : new Error(String(err)))
        await broadcastState(session)
        logger.warn(`Video download failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
    } else {
      logger.info(`Playing cached video for presentation ${session.id}`, { path: videoPath })
    }

    // Re-check after download — navigation or stopVideoSession may have interleaved.
    // stopVideoSession sets videoState='idle'; don't overwrite that transition.
    if (session.navigating || session.currentSlide !== requestedSlide || session.videoState !== 'loading') {
      compositor.cleanup()
      if (session.videoState === 'loading') session.videoState = 'idle'
      await broadcastState(session)
      return
    }

    session.compositor = compositor

    if (!session.lastFrameBuffer) {
      compositor.cleanup()
      session.videoState = 'idle'
      await broadcastState(session)
      return
    }

    // Start audio publishing — skip if resuming from pause (track is still published)
    if (seekSeconds === 0) {
      try {
        await session.publisher.startAudioPublishing(48000, 2)
      } catch (err) {
        logger.warn(
          `Failed to start audio publishing for ${session.id}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    // Re-check after audio setup — navigation or stopVideoSession may have interleaved.
    // stopVideoSession sets videoState='idle'; don't overwrite that transition.
    if (session.navigating || session.currentSlide !== requestedSlide || session.videoState !== 'loading') {
      compositor.cleanup()
      session.compositor = null
      if (session.videoState === 'loading') session.videoState = 'idle'
      await session.publisher.stopAudioPublishing().catch(() => {
        /* noop */
      })
      await broadcastState(session)
      return
    }

    // Chunk audio into strict 10ms frames (480 samples × 2ch × 2 bytes = 1920 bytes)
    // Prevents overfilling AudioSource's internal buffer which causes tail latency on pause
    const AUDIO_FRAME_BYTES = 1920
    const MAX_AUDIO_REMAINDER = AUDIO_FRAME_BYTES * 4
    // Pre-sized ring-style buffer: holds up to MAX_AUDIO_REMAINDER of leftover bytes
    // plus one typical FFmpeg chunk (~16 KB observed). Sized generously; never grows.
    const AUDIO_BUFFER_BYTES = MAX_AUDIO_REMAINDER + 32 * 1024
    const audioBuf = Buffer.allocUnsafe(AUDIO_BUFFER_BYTES)
    let audioRead = 0
    let audioWrite = 0

    const onAudioData = (pcmChunk: Buffer) => {
      // Make room at the tail by shifting unread bytes to index 0 when needed.
      if (audioWrite + pcmChunk.length > AUDIO_BUFFER_BYTES) {
        const unread = audioWrite - audioRead
        if (unread > 0 && audioRead > 0) audioBuf.copy(audioBuf, 0, audioRead, audioWrite)
        audioRead = 0
        audioWrite = unread
        // Should never happen with the sizing above, but cap the backlog just in case
        if (audioWrite + pcmChunk.length > AUDIO_BUFFER_BYTES) {
          // Drop the oldest MAX_AUDIO_REMAINDER worth of bytes, same behavior as the
          // previous subarray-trim fallback.
          const drop = audioWrite - MAX_AUDIO_REMAINDER
          if (drop > 0) {
            audioBuf.copy(audioBuf, 0, drop, audioWrite)
            audioWrite -= drop
          }
        }
      }

      pcmChunk.copy(audioBuf, audioWrite)
      audioWrite += pcmChunk.length

      while (audioWrite - audioRead >= AUDIO_FRAME_BYTES) {
        // Use Buffer.alloc for dedicated ArrayBuffer with guaranteed 2-byte alignment
        // (Buffer pool may have odd byteOffset which breaks Int16Array)
        const frame = Buffer.alloc(AUDIO_FRAME_BYTES)
        audioBuf.copy(frame, 0, audioRead, audioRead + AUDIO_FRAME_BYTES)
        const int16 = new Int16Array(frame.buffer, 0, AUDIO_FRAME_BYTES / 2)
        session.publisher.pushAudioFrame(int16, 48000, 2, 480)
        audioRead += AUDIO_FRAME_BYTES
      }

      if (audioRead === audioWrite) {
        audioRead = 0
        audioWrite = 0
      }
    }

    // Set playback start BEFORE spawning FFmpeg so the startup latency is
    // counted symmetrically on both initial play and resume-from-pause.
    // This prevents the elapsed time from overestimating by the spawn delay.
    session.videoPlaybackStartedAt = Date.now()
    session.pausedVideoIndex = videoIndex
    if (seekSeconds === 0) session.videoElapsedBeforePause = 0

    try {
      await compositor.startPlayback(
        videoPath,
        videoInfo,
        session.lastFrameBuffer,
        session.lastFrameWidth,
        session.lastFrameHeight,
        session.publisher,
        onAudioData,
        seekSeconds > 0 ? seekSeconds : undefined
      )
    } catch (err) {
      compositor.cleanup()
      session.compositor = null
      session.videoState = 'error'
      session.videoErrorReason = classifyVideoError(err instanceof Error ? err : new Error(String(err)))
      await session.publisher.stopAudioPublishing().catch(() => {
        /* noop */
      })
      await broadcastState(session)
      throw err
    }

    // Re-check after startPlayback — stopVideoSession may have cleaned up the compositor
    // while the promise was resolving. The compositor's close handler is gated by
    // `!cleanedUp && isPlaying`, so the onEnd latch doesn't cover this path.
    // cleanup() here also kills FFmpegs that startPlayback spawned after an
    // external cleanup ran during its internal fs.writeFile yield.
    if (session.compositor !== compositor) {
      compositor.cleanup()
      return
    }

    session.videoState = 'playing'

    logger.info(`Video seek: ${seekSeconds.toFixed(2)}s, elapsed tracked: ${session.videoElapsedBeforePause}ms`)

    const endedCompositor = compositor
    compositor.onEnd(async () => {
      if (session.compositor !== endedCompositor) return // stale callback from a replaced compositor
      session.videoState = 'idle'
      session.compositor = null
      await session.publisher.stopAudioPublishing().catch(() => {
        /* noop */
      })
      metrics.increment('video_playback_total', { action: 'end' })
      broadcastState(session).catch(() => {
        /* noop */
      })
      logger.info(`Video ended naturally for presentation ${session.id}`)
    })

    metrics.increment('video_playback_total', { action: 'play' })
    await broadcastState(session)
    logger.info(`Video playback started for presentation ${session.id}`, { videoIndex })
  }

  async function stopVideoSession(session: InternalSession): Promise<void> {
    if (session.navigating) return
    if (session.videoState === 'idle') return

    await session.publisher.stopAudioPublishing()

    if (session.compositor) {
      session.compositor.cleanup()
      session.compositor = null
    }
    session.videoState = 'idle'
    // Clear pause bookmarks so replaying the same video starts from the beginning
    // (parity with navigateSession; seek is gated on state='paused' so this is defense-in-depth)
    session.pausedVideoIndex = -1
    session.videoElapsedBeforePause = 0

    if (session.lastFrameBuffer) {
      session.publisher.pushFrame(session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight)
      session.publisher.startHeartbeat(session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight)
    }

    metrics.increment('video_playback_total', { action: 'stop' })
    await broadcastState(session)
    logger.info(`Video stopped for presentation ${session.id}`)
  }

  async function pauseVideoSession(session: InternalSession): Promise<void> {
    if (session.navigating) return
    if (session.compositor && session.videoState === 'playing') {
      // Record elapsed time, then kill processes — resume will restart with -ss seek.
      // Keep the LiveKit audio track published during pause — only the FFmpeg audio
      // process is killed. On resume, the new FFmpeg feeds into the existing audioSource.
      session.videoElapsedBeforePause += Date.now() - session.videoPlaybackStartedAt
      // Capture the last video frame before killing FFmpeg so we can freeze on it
      const lastFrame = session.compositor.getLastFrame()
      session.compositor.cleanup()
      session.compositor = null

      // Keep pushing the last video frame so viewers see a frozen video, not the slide placeholder
      if (lastFrame) {
        session.publisher.pushFrame(lastFrame.buffer, lastFrame.width, lastFrame.height, lastFrame.bufferType)
        session.publisher.startHeartbeat(lastFrame.buffer, lastFrame.width, lastFrame.height, lastFrame.bufferType)
      } else if (session.lastFrameBuffer) {
        session.publisher.pushFrame(session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight)
        session.publisher.startHeartbeat(session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight)
      }

      session.videoState = 'paused'
      metrics.increment('video_playback_total', { action: 'pause' })
      await broadcastState(session)
      logger.info(`Video paused for presentation ${session.id}`, {
        elapsedMs: session.videoElapsedBeforePause
      })
    }
  }

  async function stopSession(session: InternalSession): Promise<void> {
    if (session.stoppingPromise) return session.stoppingPromise

    // Remove from map immediately to prevent re-entry from other lookup paths
    sessions.delete(session.id)
    metrics.decrement('active_sessions')

    // Cancel pending pre-download timer to prevent downloads against a destroyed temp dir
    if (session.preDownloadTimer) {
      clearTimeout(session.preDownloadTimer)
      session.preDownloadTimer = null
    }

    // Abort any in-flight downloads so they don't race with tempDir cleanup below
    session.abortController.abort()

    session.stoppingPromise = (async () => {
      logger.info(`Stopping presentation ${session.id}`)

      if (session.compositor) {
        session.compositor.cleanup()
        session.compositor = null
      }

      try {
        await session.publisher.publishData({ type: 'presentation:stopped', id: session.id })
      } catch (err) {
        logger.warn(`Failed to broadcast stop event: ${err instanceof Error ? err.message : String(err)}`)
      }

      try {
        await session.publisher.disconnect()
      } catch (err) {
        logger.warn(`Failed to disconnect publisher: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        session.renderer.destroy()
      } catch (err) {
        logger.warn(`Failed to destroy renderer: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        videoCompositor.destroyTempDir(session.tempDir)
      } catch (err) {
        logger.warn(`Failed to remove temp dir: ${err instanceof Error ? err.message : String(err)}`)
      }

      logger.info(`Presentation ${session.id} stopped and cleaned up`)
    })()

    return session.stoppingPromise
  }

  function getStateFromSession(session: InternalSession): PresentationState {
    return {
      id: session.id,
      fileName: session.fileName,
      slideCount: session.slideCount,
      currentSlide: session.currentSlide,
      fileType: session.fileType,
      slideVideos: session.slideVideos,
      videoState: session.videoState,
      ...(session.videoState === 'error' && session.videoErrorReason
        ? { videoErrorReason: session.videoErrorReason }
        : {})
    }
  }

  async function navigate(
    id: string,
    action: 'next' | 'prev' | 'goto',
    slideIndex?: number
  ): Promise<PresentationState> {
    const session = sessions.get(id)
    if (!session) throw new PresentationNotFoundError(id)
    return navigateSession(session, action, slideIndex)
  }

  async function playVideo(id: string, videoIndex: number): Promise<void> {
    const session = sessions.get(id)
    if (!session) throw new PresentationNotFoundError(id)
    return playVideoSession(session, videoIndex)
  }

  async function pauseVideo(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) throw new PresentationNotFoundError(id)
    return pauseVideoSession(session)
  }

  async function stopVideo(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) throw new PresentationNotFoundError(id)
    return stopVideoSession(session)
  }

  async function stopPresentation(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) {
      logger.warn(`Tried to stop non-existent presentation ${id}`)
      return
    }
    return stopSession(session)
  }

  return {
    validateCredentials,
    createPresentation,
    navigate,
    getState,
    playVideo,
    pauseVideo,
    stopVideo,
    stopPresentation,
    async [START_COMPONENT](): Promise<void> {
      idleCheckInterval = setInterval(() => {
        cleanupIdleSessions().catch((err) => {
          logger.warn(`Idle cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }, IDLE_CHECK_INTERVAL_MS)
      logger.info('Presentation manager started', { maxConcurrent })
    },
    async [STOP_COMPONENT](): Promise<void> {
      if (idleCheckInterval) {
        clearInterval(idleCheckInterval)
        idleCheckInterval = null
      }
      // Stop all active sessions
      for (const session of [...sessions.values()]) {
        try {
          await stopSession(session)
        } catch (err) {
          logger.warn(`Failed to stop session during shutdown: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      logger.info('Presentation manager stopped')
    }
  }
}
