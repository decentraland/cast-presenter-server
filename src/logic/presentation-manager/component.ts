import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { MaxConcurrentPresentationsError, PresentationNotFoundError } from './errors'
import type { IPresentationManager, PresentationInfo, PresentationSession, PresentationState } from './types'
import type { ILiveKitPublisher } from '../../adapters/livekit-publisher/types'
import type { IPdfRenderer } from '../../adapters/pdf-renderer/types'
import type { IVideoCompositor } from '../../adapters/video-compositor/types'
import type { AppComponents } from '../../types'

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const IDLE_CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_MAX_CONCURRENT = 10

interface InternalSession extends PresentationSession {
  renderer: IPdfRenderer
  publisher: ILiveKitPublisher
  compositor: IVideoCompositor | null
  cachedVideoPaths: Map<string, string>
  navigating: boolean
  tempDir: string
  lastActivityAt: number
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
  components: Pick<AppComponents, 'config' | 'logs' | 'liveKitPublisher' | 'pdfRenderer' | 'videoCompositor'>
): Promise<IPresentationManager> {
  const { config, logs, liveKitPublisher, pdfRenderer, videoCompositor } = components
  const logger = logs.getLogger('presentation-manager')

  // Resolve config at component creation
  const maxConcurrentRaw = await config.getString('MAX_CONCURRENT_PRESENTATIONS')
  const maxConcurrent = maxConcurrentRaw
    ? parseInt(maxConcurrentRaw, 10) || DEFAULT_MAX_CONCURRENT
    : DEFAULT_MAX_CONCURRENT

  const sessions = new Map<string, InternalSession>()
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null

  async function cleanupIdleSessions(): Promise<void> {
    const now = Date.now()
    for (const [id, session] of sessions) {
      const participantCount = session.publisher.getRemoteParticipantCount()
      if (participantCount > 0) {
        session.lastActivityAt = now
      } else if (now - session.lastActivityAt >= DEFAULT_IDLE_TIMEOUT_MS) {
        logger.info(`Session ${id} idle for ${DEFAULT_IDLE_TIMEOUT_MS / 1000}s with no participants, cleaning up`)
        try {
          await stopSession(session)
        } catch (err) {
          logger.warn(`Failed to stop idle session ${id}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
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
      await session.publisher.updateMetadataState(state as unknown as Record<string, unknown>)
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
    if (sessions.size >= maxConcurrent) {
      throw new MaxConcurrentPresentationsError(maxConcurrent)
    }

    const id = randomUUID()
    logger.info(`Creating presentation ${id}`, { fileType, fileSize: fileBuffer.length })

    // Connect to LiveKit FIRST — validates the token
    const publisherLogger = logs.getLogger(`livekit-publisher:${id}`)
    const publisher = liveKitPublisher.createPublisher(id, publisherLogger)
    await publisher.connect(livekitUrl, livekitToken)

    // Initialize PDF renderer
    const renderer = pdfRenderer.createRenderer()
    await renderer.initialize(fileBuffer)
    const slideCount = renderer.getSlideCount()

    // Handle data channel commands from participants
    publisher.setDataHandler(async (message: Record<string, unknown>) => {
      const session = sessions.get(id)
      if (!session) return
      try {
        switch (message.type) {
          case 'presentation:navigate':
            await navigateSession(
              session,
              message.action as 'next' | 'prev' | 'goto',
              message.slideIndex as number | undefined
            )
            break
          case 'presentation:video:play':
            await playVideoSession(session, message.videoIndex as number)
            break
          case 'presentation:video:pause':
            await pauseVideoSession(session)
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
    await broadcastState(session)

    logger.info(`Presentation ${id} created with ${slideCount} slides`, {
      width,
      height,
      slideVideos: slideVideos.length
    })

    // Pre-download videos in the background (no transcoding — FFmpeg streams from local file)
    preDownloadVideos(session).catch((err) => {
      logger.warn(`Background video pre-download failed for ${id}: ${err instanceof Error ? err.message : String(err)}`)
    })

    return { id, fileName: presentationName, slideCount, currentSlide: 0, fileType }
  }

  async function preDownloadVideos(session: InternalSession): Promise<void> {
    const downloader = videoCompositor.createCompositor(logger, session.tempDir)

    const videoTargets = new Map<string, { width: number; height: number }>()
    for (let i = 0; i < session.slideCount; i++) {
      const videos = await session.renderer.getSlideVideos(i)
      for (const v of videos) {
        if (!videoTargets.has(v.url)) {
          videoTargets.set(v.url, { width: v.geometry.width, height: v.geometry.height })
        }
      }
    }

    const MAX_PRE_DOWNLOADS = 2
    logger.info(`Pre-download queue: ${videoTargets.size} videos to process (limit: ${MAX_PRE_DOWNLOADS})`)

    let downloaded = 0
    for (const [url] of videoTargets) {
      if (downloaded >= MAX_PRE_DOWNLOADS) {
        logger.info(`Pre-download limit reached (${MAX_PRE_DOWNLOADS}), remaining videos will be downloaded on demand`)
        break
      }
      if (!sessions.has(session.id)) {
        logger.info('Session ended, aborting pre-download queue')
        break
      }
      if (session.cachedVideoPaths.has(url)) continue
      try {
        logger.info(`Pre-downloading video: ${url}`)
        const rawPath = await downloader.downloadVideo(url)
        session.cachedVideoPaths.set(url, rawPath)
        logger.info(`Pre-downloaded video: ${url}`)
        downloaded++
      } catch (err) {
        logger.warn(`Failed to pre-download video: ${url} — ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    logger.info(`Pre-download queue complete. Cached: ${session.cachedVideoPaths.size} videos`)
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
        session.compositor.cleanup()
        session.compositor = null
      }
      session.videoState = 'idle'

      const { buffer, width, height } = await session.renderer.renderSlide(targetSlide)

      session.publisher.pushFrame(buffer, width, height)
      session.publisher.startHeartbeat(buffer, width, height)

      const slideVideos = await session.renderer.getSlideVideos(targetSlide)

      session.currentSlide = targetSlide
      session.lastFrameBuffer = buffer
      session.lastFrameWidth = width
      session.lastFrameHeight = height
      session.slideVideos = slideVideos

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
    if (session.videoState === 'playing' || session.videoState === 'loading') return

    if (videoIndex < 0 || videoIndex >= session.slideVideos.length) {
      throw new Error(`Invalid video index: ${videoIndex}`)
    }

    const videoInfo = session.slideVideos[videoIndex]

    if (session.videoState === 'paused' && session.compositor) {
      session.compositor.resumePlayback()
      session.videoState = 'playing'
      await broadcastState(session)
      return
    }

    const requestedSlide = session.currentSlide
    session.videoState = 'loading'
    await broadcastState(session)

    if (session.compositor) {
      session.compositor.cleanup()
      session.compositor = null
    }

    const compositorLogger = logs.getLogger(`video-compositor:${session.id}`)
    const compositor = videoCompositor.createCompositor(compositorLogger, session.tempDir)

    let videoPath = session.cachedVideoPaths.get(videoInfo.url)
    if (videoPath && fs.existsSync(videoPath)) {
      logger.info(`Playing cached video for presentation ${session.id}`, { path: videoPath })
    } else {
      videoPath = await compositor.resolveStreamUrl(videoInfo.url)
      logger.info(`Streaming video from URL for presentation ${session.id}`, { url: videoPath })
    }

    if (session.currentSlide !== requestedSlide) {
      compositor.cleanup()
      session.videoState = 'idle'
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

    await compositor.startPlayback(
      videoPath,
      videoInfo,
      session.lastFrameBuffer,
      session.lastFrameWidth,
      session.lastFrameHeight,
      session.publisher
    )

    session.videoState = 'playing'

    compositor.onEnd(async () => {
      session.videoState = 'idle'
      session.compositor = null
      broadcastState(session).catch(() => {
        /* noop */
      })
      logger.info(`Video ended naturally for presentation ${session.id}`)
    })

    await broadcastState(session)
    logger.info(`Video playback started for presentation ${session.id}`, { videoIndex })
  }

  async function pauseVideoSession(session: InternalSession): Promise<void> {
    if (session.compositor && session.videoState === 'playing') {
      session.compositor.pausePlayback()
      session.videoState = 'paused'
      await broadcastState(session)
      logger.info(`Video paused for presentation ${session.id}`)
    }
  }

  async function stopSession(session: InternalSession): Promise<void> {
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

    await session.publisher.disconnect()
    session.renderer.destroy()
    videoCompositor.destroyTempDir(session.tempDir)
    sessions.delete(session.id)

    logger.info(`Presentation ${session.id} stopped and cleaned up`)
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

  async function stopPresentation(id: string): Promise<void> {
    const session = sessions.get(id)
    if (!session) {
      logger.warn(`Tried to stop non-existent presentation ${id}`)
      return
    }
    return stopSession(session)
  }

  return {
    createPresentation,
    navigate,
    getState,
    playVideo,
    pauseVideo,
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
      for (const session of sessions.values()) {
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
