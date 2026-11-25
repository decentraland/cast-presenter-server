import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { START_COMPONENT, STOP_COMPONENT } from '@well-known-components/interfaces'
import { InvalidLivekitCredentialsError, MaxConcurrentPresentationsError, PresentationNotFoundError } from './errors'
import { classifyClientVideo } from '../client-video'
import { errorMessage } from '../error-message'
import { DEFAULT_OVERLAY_LAYOUT, parseOverlayUpdate } from '../overlay-layout'
import { removeQuietly } from '../remove-quietly'
import type { IPresentationManager, PresentationInfo, PresentationSession, PresentationState } from './types'
import type { BakePriority, BakeResult } from '../../adapters/media-encoder/types'
import type { ISidecarPublisher } from '../../adapters/sidecar-publisher/types'
import type { ISlideRenderer } from '../../adapters/slide-renderer/types'
import type { AppComponents } from '../../types'
import type { ClientVideo } from '../client-video'
import type { FileType } from '../file-validator'
import type { OverlayLayout } from '../overlay-layout'
import type { SlideImage } from '../slide-image'

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const IDLE_CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_MAX_CONCURRENT = 10
const OVERLAY_BROADCAST_INTERVAL_MS = 250
const SLIDE_IMAGE_CACHE_SIZE = 8
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
export const SESSION_DISK_QUOTA_BYTES = 2 * 1024 * 1024 * 1024
const MAX_PRE_DOWNLOADS = 10

class SessionDiskQuotaExceededError extends Error {
  constructor(used: number, requested: number) {
    super(`Session disk quota exceeded (used=${used}, adding=${requested}, limit=${SESSION_DISK_QUOTA_BYTES})`)
    this.name = 'SessionDiskQuotaExceededError'
  }
}

interface BakeJob {
  promise: Promise<BakeResult>
  abort: AbortController
  priority: BakePriority
  settled: boolean
}

interface SidecarOutcome {
  playId: number
  failure: string | null
}

interface InternalSession extends PresentationSession {
  renderer: ISlideRenderer
  navigating: boolean
  tempDir: string
  lastActivityAt: number
  videoPlaybackStartedAt: number
  videoElapsedBeforePause: number
  stoppingPromise: Promise<void> | null
  videoErrorReason: string | null
  videoErrorCode: VideoErrorCode | null
  overlay: OverlayLayout
  overlayBroadcastTimer: ReturnType<typeof setTimeout> | null
  videoEndTimer: ReturnType<typeof setTimeout> | null
  abortController: AbortController
  bytesDownloaded: number
  slideImages: Map<string, SlideImage>
  currentSlideImage: SlideImage | null
  activeVideoIndex: number
  playGeneration: number
  sidecarPlayId: number
  earlySidecarOutcome: SidecarOutcome | null
  presenterIdentity: string | null
  sidecar: ISidecarPublisher
  bakeJobs: Map<string, BakeJob>
}

/** Codes for failures detected by the presentation-manager itself; with `CompositorErrorReason` they form `presentation:error.code`. */
type ManagerVideoErrorCode =
  | 'video-quota-exceeded'
  | 'video-permission-denied'
  | 'video-not-found'
  | 'video-server-error'
  | 'video-timeout'
  | 'video-too-large'
  | 'video-too-many-redirects'
  | 'video-invalid-format'
  | 'video-playback-failed'

/** Reasons a video can stop mid-stream. */
type CompositorErrorReason = 'video-playback-interrupted' | 'video-stream-error' | 'audio-processing-failed'

export type VideoErrorCode = ManagerVideoErrorCode | CompositorErrorReason

export interface VideoErrorInfo {
  code: VideoErrorCode
  message: string
}

/** User-facing messages for mid-stream video failures. */
const COMPOSITOR_ERROR_MESSAGES: Record<CompositorErrorReason, string> = {
  'video-playback-interrupted': 'Video playback was interrupted — the stream ended unexpectedly',
  'video-stream-error': 'Video playback failed — a stream error stopped the video',
  'audio-processing-failed': 'Audio processing failed during playback'
}

const PLAYBACK_FAILED_MESSAGE = 'Video unavailable'
const UNSUPPORTED_VIDEO_MESSAGE = 'Unsupported video link — use YouTube, Google Drive or a Vimeo .m3u8 link'
const END_GRACE_MS = 2000

/** Maps download/playback errors to a stable code + user-friendly reason. */
function classifyVideoError(err: Error): VideoErrorInfo {
  if (err instanceof SessionDiskQuotaExceededError) {
    return {
      code: 'video-quota-exceeded',
      message: 'Presentation has exceeded its video disk budget — stop other videos or restart the session'
    }
  }
  const msg = err.message
  if (/HTTP 40[13]/.test(msg)) {
    return { code: 'video-permission-denied', message: 'Video not authorized — check sharing permissions' }
  }
  if (/HTTP 404/.test(msg)) {
    return { code: 'video-not-found', message: 'Video not found or no longer available' }
  }
  if (/HTTP [45]\d\d/.test(msg)) {
    return { code: 'video-server-error', message: 'Video server error — try again later' }
  }
  if (/timed out/i.test(msg)) {
    return { code: 'video-timeout', message: 'Video download timed out — file may be too large' }
  }
  if (/exceeds.*limit/i.test(msg)) {
    return { code: 'video-too-large', message: 'Video exceeds maximum size limit' }
  }
  if (/too many redirects/i.test(msg)) {
    return { code: 'video-too-many-redirects', message: 'Video URL has too many redirects' }
  }
  if (/too small/i.test(msg) || /remux failed/i.test(msg) || /invalid data/i.test(msg)) {
    return {
      code: 'video-invalid-format',
      message: 'Video format is not supported — the file may be private or require authentication'
    }
  }
  return { code: 'video-playback-failed', message: PLAYBACK_FAILED_MESSAGE }
}

function isVideoActive(session: InternalSession): boolean {
  return session.videoState === 'loading' || session.videoState === 'playing' || session.videoState === 'paused'
}

function activeClientVideo(session: InternalSession): ClientVideo | null {
  const video = session.slideVideos[session.activeVideoIndex]
  return isVideoActive(session) && video ? classifyClientVideo(video.url) : null
}

function clientPositionMs(session: InternalSession): number {
  const sinceAnchor = session.videoState === 'playing' ? Date.now() - session.videoPlaybackStartedAt : 0
  return session.videoElapsedBeforePause + sinceAnchor
}

function clearVideoEndTimer(session: InternalSession): void {
  if (session.videoEndTimer) clearTimeout(session.videoEndTimer)
  session.videoEndTimer = null
}

function servableBaseUrl(value: string): string | null {
  if (!URL.canParse(value)) return null
  const { protocol, hostname, origin, pathname, username, password, search, hash } = new URL(value)
  const secure = protocol === 'https:' || (protocol === 'http:' && LOCAL_HOSTNAMES.has(hostname))
  if (!secure || username || password || search || hash) return null
  return `${origin}${pathname}`.replace(/\/+$/, '')
}

function rememberSlideImage(session: InternalSession, image: SlideImage): void {
  session.slideImages.delete(image.hash)
  session.slideImages.set(image.hash, image)
  if (session.slideImages.size > SLIDE_IMAGE_CACHE_SIZE) {
    const [oldest] = session.slideImages.keys()
    session.slideImages.delete(oldest)
  }
  session.currentSlideImage = image
}

/**
 * Creates the presentation manager logic component.
 *
 * Orchestrates the full presentation lifecycle:
 * 1. Connects the session's sidecar to LiveKit (fail-fast auth validation)
 * 2. Loads the deck in an out-of-process slide renderer and renders the first slide
 * 3. Handles navigation, video playback, and session cleanup
 *
 * Uses START_COMPONENT/STOP_COMPONENT for idle session cleanup lifecycle.
 *
 * @param components - Required: config, logs, metrics, slideRenderer, sidecarPublisher, mediaEncoder, videoDuration
 * @returns IPresentationManager implementation
 * @throws {Error} When PUBLIC_BASE_URL is unset or not a servable https:// URL
 */
export async function createPresentationManager(
  components: Pick<
    AppComponents,
    'config' | 'logs' | 'metrics' | 'slideRenderer' | 'sidecarPublisher' | 'mediaEncoder' | 'videoDuration'
  >
): Promise<IPresentationManager> {
  const { config, logs, metrics, slideRenderer, sidecarPublisher, mediaEncoder, videoDuration } = components
  const logger = logs.getLogger('presentation-manager')

  const maxConcurrentRaw = await config.getString('MAX_CONCURRENT_PRESENTATIONS')
  const parsed = maxConcurrentRaw !== undefined ? parseInt(maxConcurrentRaw, 10) : NaN
  const maxConcurrent = Number.isNaN(parsed) || parsed < 0 ? DEFAULT_MAX_CONCURRENT : parsed === 0 ? Infinity : parsed
  const publicBaseUrl = servableBaseUrl((await config.getString('PUBLIC_BASE_URL')) ?? '')
  if (publicBaseUrl === null) {
    throw new Error(
      'PUBLIC_BASE_URL must be an https:// URL (http:// only for localhost) with no credentials, query or fragment'
    )
  }

  const sessions = new Map<string, InternalSession>()
  let inFlightCreations = 0
  let idleCheckInterval: ReturnType<typeof setInterval> | null = null

  async function cleanupIdleSessions(): Promise<void> {
    const now = Date.now()
    for (const [id, session] of [...sessions.entries()]) {
      const participantCount = session.sidecar.getRemoteParticipantCount()
      if (participantCount > 0) {
        session.lastActivityAt = now
      } else if (now - session.lastActivityAt >= DEFAULT_IDLE_TIMEOUT_MS) {
        logger.info(`Session ${id} idle for ${DEFAULT_IDLE_TIMEOUT_MS / 1000}s with no participants, cleaning up`)
        try {
          await stopSession(session)
          metrics.increment('idle_session_cleanups_total')
        } catch (err) {
          logger.warn(`Failed to stop idle session ${id}: ${errorMessage(err)}`)
        }
      }
    }
  }

  async function validateCredentials(livekitUrl: string, livekitToken: string): Promise<void> {
    const publisher = sidecarPublisher.createPublisher('validate', logs.getLogger('livekit-validate'))
    try {
      await publisher.connect(livekitUrl, livekitToken)
    } catch (err) {
      throw new InvalidLivekitCredentialsError(errorMessage(err))
    } finally {
      await publisher.disconnect().catch(() => undefined)
    }
  }

  /** Coalesces bursts of overlay updates into at most one state broadcast per interval. */
  function scheduleOverlayBroadcast(session: InternalSession): void {
    if (session.overlayBroadcastTimer) return
    session.overlayBroadcastTimer = setTimeout(() => {
      session.overlayBroadcastTimer = null
      broadcastState(session).catch(() => undefined)
    }, OVERLAY_BROADCAST_INTERVAL_MS)
  }

  async function broadcastState(session: InternalSession): Promise<void> {
    const state = getStateFromSession(session)
    try {
      await session.sidecar.publishData({
        type: 'presentation:state',
        ...state
      })
    } catch (err) {
      logger.warn(`Failed to broadcast state: ${errorMessage(err)}`)
    }
    try {
      await session.sidecar.updateMetadataState(state)
    } catch (err) {
      logger.warn(`Failed to update metadata: ${errorMessage(err)}`)
    }
  }

  /**
   * Sends a transient error event over the LiveKit data channel. Separate from
   * `presentation:state` so clients can react to *this* failure (e.g. toast)
   * without having to diff state, and so repeated failures can be surfaced even
   * if state is otherwise unchanged.
   */
  async function broadcastError(
    session: InternalSession,
    code: VideoErrorCode,
    message: string,
    context?: { videoIndex?: number; videoUrl?: string }
  ): Promise<void> {
    try {
      await session.sidecar.publishData({
        type: 'presentation:error',
        code,
        message,
        ...(context?.videoIndex !== undefined ? { videoIndex: context.videoIndex } : {}),
        ...(context?.videoUrl !== undefined ? { videoUrl: context.videoUrl } : {})
      })
    } catch (err) {
      logger.warn(`Failed to broadcast error: ${errorMessage(err)}`)
    }
  }

  async function createPresentation(
    fileBuffer: Buffer,
    fileType: FileType,
    livekitToken: string,
    livekitUrl: string,
    fileName?: string,
    presenterIdentity?: string | null
  ): Promise<PresentationInfo> {
    if (sessions.size + inFlightCreations >= maxConcurrent) {
      throw new MaxConcurrentPresentationsError(maxConcurrent)
    }

    inFlightCreations++
    const id = randomUUID()
    logger.info(`Creating presentation ${id}`, { fileType, fileSize: fileBuffer.length })

    const sidecar = sidecarPublisher.createPublisher(id, logs.getLogger(`livekit-publisher:${id}`))
    const unhandledSidecarFatal = registerSidecarEvents(id, sidecar)

    let renderer: ISlideRenderer | null = null
    let tempDir: string | null = null

    try {
      await sidecar.connect(livekitUrl, livekitToken)

      renderer = slideRenderer.createRenderer(fileType)
      await renderer.initialize(fileBuffer)
      const slideCount = renderer.getSlideCount()
      if (slideCount === 0) {
        throw new Error('PDF contains no pages')
      }

      sidecar.setDataHandler(async (message: Record<string, unknown>, senderIdentity: string) => {
        const session = sessions.get(id)
        if (!session) return
        try {
          switch (message.type) {
            case 'presentation:navigate': {
              const action = message.action
              if (action !== 'next' && action !== 'prev' && action !== 'goto') break
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
            case 'presentation:overlay:update': {
              const patch = parseOverlayUpdate(message)
              if (!patch || Object.keys(patch).length === 0) break
              session.overlay = { ...session.overlay, ...patch }
              scheduleOverlayBroadcast(session)
              break
            }
            case 'presentation:presenter:claim':
              session.presenterIdentity = senderIdentity
              await broadcastState(session)
              break
            case 'presentation:get-state':
              await broadcastState(session)
              break
          }
        } catch (err) {
          logger.warn(`Data channel command failed: ${errorMessage(err)}`)
        }
      })

      const firstSlideImage = await renderer.renderSlide(0)
      const slideVideos = await renderer.getSlideVideos(0)

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
        slideVideos,
        videoState: 'idle',
        renderer,
        tempDir,
        navigating: false,
        videoPlaybackStartedAt: 0,
        videoElapsedBeforePause: 0,
        lastActivityAt: Date.now(),
        stoppingPromise: null,
        videoErrorReason: null,
        videoErrorCode: null,
        overlay: { ...DEFAULT_OVERLAY_LAYOUT },
        overlayBroadcastTimer: null,
        videoEndTimer: null,
        abortController: new AbortController(),
        bytesDownloaded: 0,
        slideImages: new Map(),
        currentSlideImage: null,
        activeVideoIndex: -1,
        playGeneration: 0,
        sidecarPlayId: 0,
        earlySidecarOutcome: null,
        presenterIdentity: presenterIdentity ?? null,
        sidecar,
        bakeJobs: new Map()
      }

      const fatalReason = unhandledSidecarFatal()
      if (fatalReason) throw new Error(`Sidecar failed before the session started: ${fatalReason}`)

      sessions.set(id, session)
      rememberSlideImage(session, firstSlideImage)
      metrics.increment('session_created_total', { status: 'success' })
      metrics.increment('active_sessions')
      await broadcastState(session)

      logger.info(`Presentation ${id} created with ${slideCount} slides`, {
        width: firstSlideImage.width,
        height: firstSlideImage.height,
        slideVideos: slideVideos.length
      })

      prefetchBakes(session).catch((err) => {
        logger.warn(`Prefetch bakes failed for ${id}: ${errorMessage(err)}`)
      })

      return { id, fileName: presentationName, slideCount, currentSlide: 0, fileType }
    } catch (err) {
      metrics.increment('session_created_total', { status: 'error' })
      if (err instanceof Error && err.message.includes('LiveKit')) {
        metrics.increment('livekit_connection_errors_total')
      }
      if (tempDir) {
        removeTempDir(tempDir)
      }
      if (renderer) {
        renderer.destroy()
      }
      await sidecar.disconnect()
      throw err
    } finally {
      inFlightCreations--
    }
  }

  function removeTempDir(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      logger.warn(`Failed to remove temp dir: ${errorMessage(err)}`)
    }
  }

  async function deckVideoUrls(session: InternalSession): Promise<Set<string>> {
    const urls = new Set<string>()
    for (let i = 0; i < session.slideCount; i++) {
      if (session.abortController.signal.aborted) break
      for (const video of await session.renderer.getSlideVideos(i)) urls.add(video.url)
    }
    return urls
  }

  function registerSidecarEvents(id: string, sidecar: ISidecarPublisher): () => string | null {
    let unhandledFatal: string | null = null
    const onFailure = (err: unknown): void => {
      logger.warn(`Sidecar event handling failed for ${id}: ${errorMessage(err)}`)
    }
    sidecar.onPlaybackEnded((playId) => {
      const session = sessions.get(id)
      if (session) settleSidecarPlayback(session, { playId, failure: null }).catch(onFailure)
    })
    sidecar.onPlaybackFailed((message, playId) => {
      const session = sessions.get(id)
      if (session) settleSidecarPlayback(session, { playId, failure: message }).catch(onFailure)
    })
    sidecar.onFatal((reason) => {
      logger.error(`Sidecar failed for presentation ${id}: ${reason}`)
      const session = sessions.get(id)
      if (session) stopSession(session).catch(onFailure)
      else unhandledFatal = reason
    })
    return () => unhandledFatal
  }

  async function settleSidecarPlayback(session: InternalSession, outcome: SidecarOutcome): Promise<void> {
    if (outcome.playId !== session.sidecarPlayId) return
    if (session.videoState === 'loading') {
      session.earlySidecarOutcome = outcome
      return
    }
    await finishSidecarPlayback(session, outcome)
  }

  async function finishSidecarPlayback(session: InternalSession, { failure }: SidecarOutcome): Promise<void> {
    if (failure === null) await endSidecarPlayback(session)
    else await interruptSidecarPlayback(session, failure)
  }

  async function endSidecarPlayback(session: InternalSession): Promise<void> {
    if (activeClientVideo(session)) return
    if (session.videoState !== 'playing' && session.videoState !== 'paused') return
    session.videoState = 'idle'
    metrics.increment('video_playback_total', { action: 'end' })
    await broadcastState(session)
    logger.info(`Video ended naturally for presentation ${session.id}`)
  }

  async function interruptSidecarPlayback(session: InternalSession, message: string): Promise<void> {
    if (activeClientVideo(session)) return
    if (session.videoState !== 'playing' && session.videoState !== 'paused') return
    const reason = 'video-playback-interrupted'
    await failVideo(session, session.activeVideoIndex, reason, COMPOSITOR_ERROR_MESSAGES[reason])
    logger.warn(`Video playback interrupted for presentation ${session.id}: ${message}`)
  }

  async function runBakeJob(
    session: InternalSession,
    url: string,
    job: Pick<BakeJob, 'abort' | 'priority'>
  ): Promise<BakeResult> {
    const embedded = mediaEncoder.resolveEmbeddedVideo(url, session.renderer.getEmbeddedMediaDir())
    if (!embedded) throw new Error('Only embedded videos are baked')
    const result = await mediaEncoder.bake(embedded.path, session.tempDir, {
      priority: job.priority,
      signal: job.abort.signal
    })
    if (session.bytesDownloaded + result.bytes > SESSION_DISK_QUOTA_BYTES) {
      removeQuietly(result.videoPath, logger)
      if (result.audioPath) removeQuietly(result.audioPath, logger)
      throw new SessionDiskQuotaExceededError(session.bytesDownloaded, result.bytes)
    }
    session.bytesDownloaded += result.bytes
    return result
  }

  function ensureBakeJob(session: InternalSession, url: string, priority: BakePriority): BakeJob {
    const existing = session.bakeJobs.get(url)
    if (existing) {
      if (priority === 'play') {
        existing.priority = 'play'
        mediaEncoder.promote(existing.abort.signal)
      }
      return existing
    }
    const abort = new AbortController()
    const sessionSignal = session.abortController.signal
    const abortWithSession = (): void => abort.abort()
    sessionSignal.addEventListener('abort', abortWithSession, { once: true })
    const settle = (): void => {
      job.settled = true
      sessionSignal.removeEventListener('abort', abortWithSession)
    }
    const state: Omit<BakeJob, 'promise'> = { abort, priority, settled: false }
    const job: BakeJob = Object.assign(state, {
      promise: runBakeJob(session, url, state).then(
        (result) => {
          settle()
          return result
        },
        (err: unknown) => {
          settle()
          if (session.bakeJobs.get(url) === job) session.bakeJobs.delete(url)
          throw err
        }
      )
    })
    session.bakeJobs.set(url, job)
    return job
  }

  async function prefetchBakes(session: InternalSession): Promise<void> {
    const { signal } = session.abortController
    const embeddedDir = session.renderer.getEmbeddedMediaDir()
    const urls = [...(await deckVideoUrls(session))].filter(
      (url) => mediaEncoder.resolveEmbeddedVideo(url, embeddedDir) !== null
    )
    if (signal.aborted) return
    logger.info(`Prefetch bake queue: ${urls.length} embedded videos to process (limit: ${MAX_PRE_DOWNLOADS})`)
    for (const url of urls.slice(0, MAX_PRE_DOWNLOADS)) {
      if (signal.aborted || !sessions.has(session.id)) return
      await ensureBakeJob(session, url, 'prefetch').promise.catch((err) => {
        logger.warn(`Prefetch bake failed: ${url} — ${errorMessage(err)}`)
      })
    }
  }

  function cancelPendingBake(session: InternalSession): void {
    if (session.videoState !== 'loading') return
    const url = session.slideVideos[session.activeVideoIndex]?.url ?? ''
    const job = session.bakeJobs.get(url)
    if (!job || job.settled) return
    job.abort.abort()
    session.bakeJobs.delete(url)
  }

  async function failVideo(
    session: InternalSession,
    videoIndex: number,
    code: VideoErrorCode,
    message: string,
    videoUrl?: string
  ): Promise<void> {
    session.videoState = 'error'
    session.videoErrorCode = code
    session.videoErrorReason = message
    await broadcastError(session, code, message, { videoIndex, videoUrl })
    await broadcastState(session)
  }

  async function runSidecarCommand(
    session: InternalSession,
    videoIndex: number,
    command: () => Promise<void>,
    isCurrent: () => boolean = () => true
  ): Promise<boolean> {
    try {
      await command()
      return true
    } catch (err) {
      logger.warn(`Sidecar playback failed for ${session.id}: ${errorMessage(err)}`)
      if (isCurrent()) await failVideo(session, videoIndex, 'video-playback-failed', PLAYBACK_FAILED_MESSAGE)
      return false
    }
  }

  async function markSidecarPlaying(session: InternalSession, videoIndex: number): Promise<void> {
    const early = session.earlySidecarOutcome
    session.earlySidecarOutcome = null
    if (early?.playId !== session.sidecarPlayId) return markV2Playing(session, videoIndex)
    session.videoState = 'playing'
    await finishSidecarPlayback(session, early)
  }

  async function markV2Playing(session: InternalSession, videoIndex: number): Promise<void> {
    session.videoState = 'playing'
    metrics.increment('video_playback_total', { action: 'play' })
    await broadcastState(session)
    logger.info(`Video playback started for presentation ${session.id}`, { videoIndex })
  }

  async function playSidecarVideo(
    session: InternalSession,
    sidecar: ISidecarPublisher,
    videoIndex: number
  ): Promise<void> {
    const { url } = session.slideVideos[videoIndex]
    const resuming = session.videoState === 'paused' && session.activeVideoIndex === videoIndex
    const stopPaused = session.videoState === 'paused' && !resuming && activeClientVideo(session) === null
    const requestedSlide = session.currentSlide
    const generation = ++session.playGeneration
    const isCurrent = (): boolean => session.playGeneration === generation
    session.videoState = 'loading'
    session.earlySidecarOutcome = null
    session.activeVideoIndex = videoIndex
    session.videoErrorReason = null
    session.videoErrorCode = null
    const stillWanted = (): boolean =>
      isCurrent() &&
      !session.abortController.signal.aborted &&
      !session.navigating &&
      session.currentSlide === requestedSlide &&
      session.videoState === 'loading' &&
      session.activeVideoIndex === videoIndex
    const abandon = async (): Promise<void> => {
      if (!isCurrent()) return
      if (session.videoState === 'loading') session.videoState = 'idle'
      await broadcastState(session)
    }

    if (resuming) {
      if (!(await runSidecarCommand(session, videoIndex, () => sidecar.resume(), isCurrent))) return
      if (!stillWanted()) {
        if (isCurrent()) {
          await sidecar.stopVideo().catch((err) => {
            logger.warn(`Sidecar stop after resume failed: ${errorMessage(err)}`)
          })
        }
        await abandon()
        return
      }
      await markSidecarPlaying(session, videoIndex)
      return
    }

    await broadcastState(session)
    if (stopPaused && !(await runSidecarCommand(session, videoIndex, () => sidecar.stopVideo(), isCurrent))) return

    if (!stillWanted()) {
      await abandon()
      return
    }

    const job = ensureBakeJob(session, url, 'play')
    let files: BakeResult
    try {
      files = await job.promise
    } catch (err) {
      if (!isCurrent() || session.abortController.signal.aborted || job.abort.signal.aborted) return
      const info = classifyVideoError(err instanceof Error ? err : new Error(String(err)))
      await failVideo(session, videoIndex, info.code, info.message)
      logger.warn(`Video bake failed for ${session.id}: ${errorMessage(err)}`)
      return
    }

    if (!stillWanted()) {
      await abandon()
      return
    }
    const played = await runSidecarCommand(
      session,
      videoIndex,
      () => {
        session.sidecarPlayId = generation
        session.earlySidecarOutcome = null
        return sidecar.play({ videoPath: files.videoPath, audioPath: files.audioPath }, generation)
      },
      isCurrent
    )
    if (!played) return
    if (!stillWanted()) {
      if (isCurrent()) {
        await sidecar.stopVideo().catch((err) => {
          logger.warn(`Sidecar stop after play failed: ${errorMessage(err)}`)
        })
      }
      return
    }
    await markSidecarPlaying(session, videoIndex)
  }

  async function playClientVideo(
    session: InternalSession,
    sidecar: ISidecarPublisher,
    videoIndex: number,
    clientVideo: ClientVideo
  ): Promise<void> {
    const resuming = session.videoState === 'paused' && session.activeVideoIndex === videoIndex
    const previousIndex = session.activeVideoIndex
    const stopPaused = session.videoState === 'paused' && !resuming
    const pausedStream = stopPaused && activeClientVideo(session) === null
    const generation = ++session.playGeneration
    clearVideoEndTimer(session)
    session.videoState = 'playing'
    session.activeVideoIndex = videoIndex
    session.videoErrorReason = null
    session.videoErrorCode = null
    if (!resuming) session.videoElapsedBeforePause = 0
    session.videoPlaybackStartedAt = Date.now()

    if (pausedStream) {
      const isCurrent = (): boolean => session.playGeneration === generation
      if (!(await runSidecarCommand(session, previousIndex, () => sidecar.stopVideo(), isCurrent))) return
      if (!isCurrent() || session.videoState !== 'playing' || session.activeVideoIndex !== videoIndex) return
    }

    await markV2Playing(session, videoIndex)
    scheduleClientEnd(session, generation, clientVideo).catch((err) => {
      logger.warn('Video end scheduling failed', { presentationId: session.id, error: errorMessage(err) })
    })
  }

  async function scheduleClientEnd(
    session: InternalSession,
    generation: number,
    clientVideo: ClientVideo
  ): Promise<void> {
    const ms = await videoDuration.getDurationMs(clientVideo)
    if (session.playGeneration !== generation || session.videoState !== 'playing' || !sessions.has(session.id)) return
    if (ms === null) return
    session.videoEndTimer = setTimeout(
      () => {
        endClientVideo(session, generation).catch((err) => {
          logger.warn('Video end failed', { presentationId: session.id, error: errorMessage(err) })
        })
      },
      Math.max(0, ms - clientPositionMs(session)) + END_GRACE_MS
    )
  }

  async function endClientVideo(session: InternalSession, generation: number): Promise<void> {
    if (session.playGeneration !== generation || session.videoState !== 'playing') return
    session.videoEndTimer = null
    session.videoState = 'idle'
    session.activeVideoIndex = -1
    session.videoElapsedBeforePause = 0
    metrics.increment('video_playback_total', { action: 'end' })
    await broadcastState(session)
    logger.info(`Video ended naturally for presentation ${session.id}`)
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
      session.playGeneration++
      clearVideoEndTimer(session)
      cancelPendingBake(session)
      if (isVideoActive(session) && !activeClientVideo(session)) {
        await session.sidecar.stopVideo().catch((err) => {
          logger.warn(`Sidecar stop on navigate failed: ${errorMessage(err)}`)
        })
      }
      session.videoState = 'idle'
      session.activeVideoIndex = -1
      session.videoElapsedBeforePause = 0

      try {
        const slideImage = await session.renderer.renderSlide(targetSlide)
        const slideVideos = await session.renderer.getSlideVideos(targetSlide)

        rememberSlideImage(session, slideImage)
        session.currentSlide = targetSlide
        session.slideVideos = slideVideos
      } catch (err) {
        await broadcastState(session)
        throw err
      }

      metrics.increment('slide_navigations_total', { action })
      logger.info(`Navigated presentation ${session.id} to slide ${targetSlide}`, {
        slideVideos: session.slideVideos.length
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
    if (session.videoState === 'playing' || session.videoState === 'loading') return

    if (videoIndex < 0 || videoIndex >= session.slideVideos.length) {
      throw new Error(`Invalid video index: ${videoIndex}`)
    }

    const { url } = session.slideVideos[videoIndex]
    const clientVideo = classifyClientVideo(url)
    if (clientVideo) return playClientVideo(session, session.sidecar, videoIndex, clientVideo)
    if (mediaEncoder.resolveEmbeddedVideo(url, session.renderer.getEmbeddedMediaDir()) === null) {
      if (session.videoState === 'paused' && activeClientVideo(session) === null) {
        session.playGeneration++
        await session.sidecar.stopVideo().catch((err) => {
          logger.warn(`Sidecar stop before an unsupported video failed: ${errorMessage(err)}`)
        })
      }
      await failVideo(session, videoIndex, 'video-invalid-format', UNSUPPORTED_VIDEO_MESSAGE)
      return
    }
    return playSidecarVideo(session, session.sidecar, videoIndex)
  }

  async function stopVideoSession(session: InternalSession): Promise<void> {
    if (session.navigating) return
    if (session.videoState === 'idle') return

    const { sidecar } = session
    const clientPlayback = activeClientVideo(session) !== null
    session.playGeneration++
    clearVideoEndTimer(session)
    if (!clientPlayback) {
      cancelPendingBake(session)
      if (!(await runSidecarCommand(session, session.activeVideoIndex, () => sidecar.stopVideo()))) return
    }

    session.videoState = 'idle'
    session.activeVideoIndex = -1
    session.videoElapsedBeforePause = 0

    metrics.increment('video_playback_total', { action: 'stop' })
    await broadcastState(session)
    logger.info(`Video stopped for presentation ${session.id}`)
  }

  async function pauseVideoSession(session: InternalSession): Promise<void> {
    if (session.navigating) return
    if (session.videoState !== 'playing') return
    const { sidecar } = session
    if (activeClientVideo(session)) {
      clearVideoEndTimer(session)
      session.videoElapsedBeforePause = clientPositionMs(session)
      session.videoPlaybackStartedAt = Date.now()
    } else {
      if (!(await runSidecarCommand(session, session.activeVideoIndex, () => sidecar.pause()))) return
      if (session.videoState !== 'playing') return
    }
    session.videoState = 'paused'
    metrics.increment('video_playback_total', { action: 'pause' })
    await broadcastState(session)
    logger.info(`Video paused for presentation ${session.id}`)
  }

  async function stopSession(session: InternalSession): Promise<void> {
    if (session.stoppingPromise) return session.stoppingPromise

    sessions.delete(session.id)
    metrics.decrement('active_sessions')

    if (session.overlayBroadcastTimer) {
      clearTimeout(session.overlayBroadcastTimer)
      session.overlayBroadcastTimer = null
    }
    clearVideoEndTimer(session)

    session.playGeneration++
    session.abortController.abort()

    session.stoppingPromise = (async () => {
      logger.info(`Stopping presentation ${session.id}`)

      try {
        await session.sidecar.publishData({ type: 'presentation:stopped', id: session.id })
      } catch (err) {
        logger.warn(`Failed to broadcast stop event: ${errorMessage(err)}`)
      }

      try {
        await session.sidecar.disconnect()
      } catch (err) {
        logger.warn(`Failed to disconnect publisher: ${errorMessage(err)}`)
      }
      try {
        session.renderer.destroy()
      } catch (err) {
        logger.warn(`Failed to destroy renderer: ${errorMessage(err)}`)
      }
      removeTempDir(session.tempDir)

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
      videoState: session.videoState,
      overlay: session.overlay,
      ...(session.videoState === 'error' && session.videoErrorReason
        ? { videoErrorReason: session.videoErrorReason }
        : {}),
      ...(session.videoState === 'error' && session.videoErrorCode ? { videoErrorCode: session.videoErrorCode } : {}),
      ...v2Fields(session)
    }
  }

  function v2Fields(
    session: InternalSession
  ): Pick<
    PresentationState,
    'slide' | 'presenterIdentity' | 'playingVideoIndex' | 'slideVideos' | 'videoPositionMs' | 'videoPositionAt'
  > {
    const image = session.currentSlideImage
    const positioned =
      activeClientVideo(session) !== null && (session.videoState === 'playing' || session.videoState === 'paused')
    return {
      slide: image
        ? {
            url: `${publicBaseUrl}/presentations/${session.id}/slides/${image.hash}.png`,
            width: image.width,
            height: image.height
          }
        : undefined,
      presenterIdentity: session.presenterIdentity,
      playingVideoIndex: isVideoActive(session) ? session.activeVideoIndex : null,
      slideVideos: session.slideVideos.map((video) => {
        const client = classifyClientVideo(video.url)
        return client ? { ...video, url: client.url, source: 'client' } : { ...video, source: 'stream' }
      }),
      videoPositionMs: positioned ? session.videoElapsedBeforePause : null,
      videoPositionAt: positioned ? session.videoPlaybackStartedAt : null
    }
  }

  function isDriveFilePlaying(fileId: string): boolean {
    for (const session of sessions.values()) {
      const video = activeClientVideo(session)
      if (video?.provider === 'drive' && video.id === fileId) return true
    }
    return false
  }

  function getSlideImage(id: string, hash: string): Buffer | null {
    return sessions.get(id)?.slideImages.get(hash)?.png ?? null
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
    getSlideImage,
    isDriveFilePlaying,
    playVideo,
    pauseVideo,
    stopVideo,
    stopPresentation,
    async [START_COMPONENT](): Promise<void> {
      idleCheckInterval = setInterval(() => {
        cleanupIdleSessions().catch((err) => {
          logger.warn(`Idle cleanup failed: ${errorMessage(err)}`)
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
          logger.warn(`Failed to stop session during shutdown: ${errorMessage(err)}`)
        }
      }
      logger.info('Presentation manager stopped')
    }
  }
}
