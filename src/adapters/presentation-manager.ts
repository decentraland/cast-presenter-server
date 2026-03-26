import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { PDFRenderer } from './pdf-renderer'
import { LiveKitPublisher } from './livekit-publisher'
import { VideoCompositor } from './video-compositor'
import type {
  IPresentationManager,
  PresentationInfo,
  PresentationSession,
  PresentationState,
  SlideVideoInfo
} from '../logic/types'

const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000 // check every 60 seconds

interface InternalSession extends PresentationSession {
  renderer: PDFRenderer
  publisher: LiveKitPublisher
  compositor: VideoCompositor | null
  cachedVideoPaths: Map<string, string> // url -> local path
  navigating: boolean // lock to prevent concurrent navigations
  tempDir: string
  lastActivityAt: number // timestamp of last participant activity
}

export function createPresentationManager(components: {
  config: IConfigComponent
  logs: ILoggerComponent
}): IPresentationManager {
  const { config, logs } = components
  const logger = logs.getLogger('presentation-manager')

  const sessions = new Map<string, InternalSession>()

  // Periodically clean up sessions with no remote participants for IDLE_TIMEOUT_MS
  const idleCheckInterval = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      const participantCount = session.publisher.getRemoteParticipantCount()
      if (participantCount > 0) {
        session.lastActivityAt = now
      } else if (now - session.lastActivityAt >= IDLE_TIMEOUT_MS) {
        logger.info(`Session ${id} idle for ${IDLE_TIMEOUT_MS / 1000}s with no participants, cleaning up`)
        stopPresentation(id).catch(err => {
          logger.warn(`Failed to stop idle session ${id}: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    }
  }, IDLE_CHECK_INTERVAL_MS)

  // Prevent the interval from keeping the process alive
  idleCheckInterval.unref()

  async function broadcastState(session: InternalSession): Promise<void> {
    const state = getStateFromSession(session)
    // Broadcast to currently connected participants via data channel
    await session.publisher.publishData({
      type: 'presentation:state',
      ...state
    }).catch(err => {
      logger.warn(`Failed to broadcast state: ${err instanceof Error ? err.message : String(err)}`)
    })
    // Update bot metadata so late joiners can read state immediately
    await session.publisher.updateMetadataState(state as unknown as Record<string, unknown>).catch(err => {
      logger.warn(`Failed to update metadata: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  async function createPresentation(
    fileBuffer: Buffer,
    fileType: 'pdf' | 'pptx',
    livekitToken: string,
    livekitUrl: string,
    fileName?: string
  ): Promise<PresentationInfo> {
    const id = randomUUID()
    logger.info(`Creating presentation ${id}`, { fileType, fileSize: fileBuffer.length })

    // Connect to LiveKit FIRST — this validates the token.
    // If the token is invalid/expired, LiveKit rejects immediately and we
    // avoid wasting resources on PDF parsing and rendering.
    const allowedRolesRaw = await config.getString('ALLOWED_COMMAND_ROLES')
    const allowedRoles = allowedRolesRaw
      ? new Set(allowedRolesRaw.split(',').map(r => r.trim()).filter(Boolean))
      : undefined
    const publisherLogger = logs.getLogger(`livekit-publisher:${id}`)
    const publisher = new LiveKitPublisher(id, publisherLogger, allowedRoles)
    await publisher.connect(livekitUrl, livekitToken)

    // Initialize PDF renderer
    const renderer = new PDFRenderer()
    await renderer.initialize(fileBuffer)
    const slideCount = renderer.getSlideCount()

    // Handle data channel commands from participants
    publisher.setDataHandler(async (message: any) => {
      try {
        switch (message.type) {
          case 'presentation:navigate':
            await navigate(id, message.action, message.slideIndex)
            break
          case 'presentation:video:play':
            await playVideo(id, message.videoIndex)
            break
          case 'presentation:video:pause':
            await pauseVideo(id)
            break
          case 'presentation:stop':
            await stopPresentation(id)
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

    // Force encoder to produce high-quality keyframes from the start
    publisher.forceEncoderQuality(buffer, width, height)

    // Start 30 FPS heartbeat to maintain quality
    publisher.startHeartbeat(buffer, width, height)

    // Get video annotations for first slide
    const slideVideos = await renderer.getSlideVideos(0)

    // Create shared temp dir for the entire session
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `cast-presenter-${id}-`))

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
      lastActivityAt: Date.now()
    }

    sessions.set(id, session)
    broadcastState(session).catch(() => {})

    logger.info(`Presentation ${id} created with ${slideCount} slides`, {
      width,
      height,
      slideVideos: slideVideos.length
    })

    // Pre-download all videos across all slides in the background
    preDownloadVideos(session).catch(err => {
      logger.warn(`Background video pre-download failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
    })

    return { id, fileName: presentationName, slideCount, currentSlide: 0, fileType }
  }

  async function preDownloadVideos(session: InternalSession): Promise<void> {
    const downloader = new VideoCompositor(logger, session.tempDir)

    // Collect all unique video URLs with their target sizes
    const videoTargets = new Map<string, { width: number; height: number }>()
    for (let i = 0; i < session.slideCount; i++) {
      const videos = await session.renderer.getSlideVideos(i)
      for (const v of videos) {
        if (!videoTargets.has(v.url)) {
          videoTargets.set(v.url, { width: v.geometry.width, height: v.geometry.height })
        }
      }
    }

    logger.info(`Pre-download queue: ${videoTargets.size} videos to process`)

    for (const [url, size] of videoTargets) {
      // Stop if session was ended while we're downloading
      if (!sessions.has(session.id)) {
        logger.info('Session ended, aborting pre-download queue')
        break
      }
      if (session.cachedVideoPaths.has(url)) continue
      try {
        logger.info(`Pre-downloading video (${size.width}x${size.height}): ${url}`)
        const rawPath = await downloader.downloadVideo(url)
        session.cachedVideoPaths.set(url, rawPath)
        logger.info(`Pre-downloaded video: ${url}`)

        // Try to pre-transcode (optional optimization — runtime overlay scales if this fails)
        try {
          const transcodedPath = await downloader.preTranscode(rawPath, size.width, size.height)
          session.cachedVideoPaths.set(url, transcodedPath)
          fs.unlink(rawPath, () => {})
          logger.info(`Pre-transcoded video to ${size.width}x${size.height}: ${url}`)
        } catch (transcodeErr) {
          logger.warn(`Pre-transcode failed (will scale at runtime): ${transcodeErr instanceof Error ? transcodeErr.message : String(transcodeErr)}`)
          // Keep raw download — runtime overlay will scale it
        }
      } catch (err) {
        logger.warn(`Failed to pre-download video: ${url} — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    logger.info(`Pre-download queue complete. Cached: ${session.cachedVideoPaths.size} videos`)
  }

  async function navigate(
    id: string,
    action: 'next' | 'prev' | 'goto',
    slideIndex?: number
  ): Promise<PresentationState> {
    const session = sessions.get(id)
    if (!session) throw new Error(`Presentation ${id} not found`)

    // Prevent concurrent navigations
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
      // Stop any video playback when navigating
      if (session.compositor) {
        session.compositor.cleanup()
        session.compositor = null
      }
      session.videoState = 'idle'

      // Render new slide
      const { buffer, width, height } = await session.renderer.renderSlide(targetSlide)

      // Force high-quality keyframe for the new slide
      session.publisher.forceEncoderQuality(buffer, width, height)

      // Restart heartbeat with new frame
      session.publisher.startHeartbeat(buffer, width, height)

      // Get video annotations for new slide
      const slideVideos = await session.renderer.getSlideVideos(targetSlide)

      // Update session state atomically
      session.currentSlide = targetSlide
      session.lastFrameBuffer = buffer
      session.lastFrameWidth = width
      session.lastFrameHeight = height
      session.slideVideos = slideVideos

      logger.info(`Navigated presentation ${id} to slide ${targetSlide}`, {
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

  // TODO: Video playback optimization
  // Current: ffmpeg → canvas composite → LiveKit. Heavy CPU/RAM, ~2-3s startup per play.
  // Better approaches (in order of preference):
  //   1. Publish video as a separate LiveKit track — cast2 overlays via CSS positioning.
  //      Zero server-side compositing. LiveKit handles encoding natively.
  //   2. Pipe ffmpeg raw frames directly to VideoSource (skip canvas composite),
  //      temporarily replacing the slide track during playback.
  //   3. Single shared ffmpeg process with seek — avoid respawning per play.
  async function playVideo(id: string, videoIndex: number): Promise<void> {
    const session = sessions.get(id)
    if (!session) throw new Error(`Presentation ${id} not found`)

    // Prevent concurrent play requests
    if (session.videoState === 'playing' || session.videoState === 'loading') return

    if (videoIndex < 0 || videoIndex >= session.slideVideos.length) {
      throw new Error(`Invalid video index: ${videoIndex}`)
    }

    const videoInfo = session.slideVideos[videoIndex]

    // If paused, just resume
    if (session.videoState === 'paused' && session.compositor) {
      session.compositor.resumePlayback()
      session.videoState = 'playing'
      await broadcastState(session)
      return
    }

    // Mark as loading immediately to block duplicate requests and show loading UI
    const requestedSlide = session.currentSlide
    session.videoState = 'loading'
    await broadcastState(session)

    // Stop previous compositor if any
    if (session.compositor) {
      session.compositor.cleanup()
      session.compositor = null
    }

    // Create compositor using session's shared temp dir
    const compositorLogger = logs.getLogger(`video-compositor:${id}`)
    const compositor = new VideoCompositor(compositorLogger, session.tempDir)

    // Use cached local file, or stream directly from URL via ffmpeg
    let videoPath = session.cachedVideoPaths.get(videoInfo.url)
    if (videoPath && fs.existsSync(videoPath)) {
      logger.info(`Playing cached video for presentation ${id}`, { path: videoPath })
    } else {
      // Not pre-downloaded — ffmpeg will stream directly from URL (no full download needed)
      videoPath = await compositor.resolveStreamUrl(videoInfo.url)
      logger.info(`Streaming video directly from URL for presentation ${id}`, { url: videoPath })
    }

    // Check slide hasn't changed while we set up
    if (session.currentSlide !== requestedSlide) {
      compositor.cleanup()
      session.videoState = 'idle'
      await broadcastState(session)
      return
    }

    session.compositor = compositor

    // Start playback
    await compositor.startPlayback(
      videoPath,
      videoInfo,
      session.lastFrameBuffer!,
      session.lastFrameWidth,
      session.lastFrameHeight,
      session.publisher
    )

    session.videoState = 'playing'

    // When video ends naturally, reset state and broadcast
    compositor.onEnd(() => {
      session.videoState = 'idle'
      session.compositor = null
      broadcastState(session).catch(() => {})
      logger.info(`Video ended naturally for presentation ${id}`)
    })

    await broadcastState(session)
    logger.info(`Video playback started for presentation ${id}`, { videoIndex })
  }

  async function pauseVideo(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) throw new Error(`Presentation ${id} not found`)

    if (session.compositor && session.videoState === 'playing') {
      session.compositor.pausePlayback()
      session.videoState = 'paused'
      await broadcastState(session)
      logger.info(`Video paused for presentation ${id}`)
    }
  }

  async function stopPresentation(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) {
      logger.warn(`Tried to stop non-existent presentation ${id}`)
      return
    }

    logger.info(`Stopping presentation ${id}`)

    // Stop video playback
    if (session.compositor) {
      session.compositor.cleanup()
      session.compositor = null
    }

    // Disconnect from LiveKit
    await session.publisher.disconnect()

    // Clean up PDF resources
    session.renderer.destroy()

    // Clean up temp dir (all cached video files)
    VideoCompositor.destroyTempDir(session.tempDir)

    // Remove session
    sessions.delete(id)

    logger.info(`Presentation ${id} stopped and cleaned up`)
  }

  function getStateFromSession(session: InternalSession): PresentationState {
    return {
      id: session.id,
      fileName: session.fileName,
      slideCount: session.slideCount,
      currentSlide: session.currentSlide,
      fileType: session.fileType,
      slideVideos: session.slideVideos,
      videoState: session.videoState
    }
  }

  return {
    createPresentation,
    navigate,
    getState,
    playVideo,
    pauseVideo,
    stopPresentation
  }
}
