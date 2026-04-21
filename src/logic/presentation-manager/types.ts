import type { IBaseComponent } from '@well-known-components/interfaces'
import type { SlideVideoInfo } from '../../adapters/video-compositor/types'
import type { FileType } from '../file-validator'

/** Internal session state for a running presentation. */
export interface PresentationSession {
  id: string
  roomId: string
  fileName: string
  fileType: FileType
  slideCount: number
  currentSlide: number
  createdAt: Date
  lastFrameBuffer: Buffer | null
  lastFrameWidth: number
  lastFrameHeight: number
  slideVideos: SlideVideoInfo[]
  videoState: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
}

/** Metadata returned after creating a presentation. */
export interface PresentationInfo {
  id: string
  fileName: string
  slideCount: number
  currentSlide: number
  fileType: FileType
}

/** Full presentation state including slide videos and playback status. */
export interface PresentationState {
  id: string
  fileName: string
  slideCount: number
  currentSlide: number
  fileType: FileType
  slideVideos: SlideVideoInfo[]
  videoState: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  /** Human-readable error message; present only when videoState === 'error'. */
  videoErrorReason?: string
  /**
   * Stable error code mirroring `presentation:error.code`. Present only when
   * videoState === 'error'. Lets reconnecting clients branch on the failure
   * type without having had to catch the transient `presentation:error`.
   */
  videoErrorCode?: string
}

/**
 * Manages presentation lifecycle including slide navigation, video playback,
 * and LiveKit stream publishing.
 *
 * Orchestrates pdf-renderer, livekit-publisher, and video-compositor adapters
 * to deliver real-time presentation streaming.
 */
export interface IPresentationManager extends IBaseComponent {
  /**
   * Verifies a LiveKit token by opening and closing a throwaway connection to
   * the server-configured LiveKit host.
   *
   * Meant for pre-flight checks so we can reject bogus credentials before
   * running expensive work (e.g. downloading a user-supplied URL).
   *
   * @throws {InvalidLivekitCredentialsError} When the token is rejected by the room
   */
  validateCredentials(livekitToken: string): Promise<void>

  /**
   * Creates a new presentation session from a file buffer.
   *
   * Verifies the JWT server-side, reserves the target room (one presentation
   * per room), then connects to the server-configured LiveKit host, renders
   * the PDF, publishes the first slide, and starts the heartbeat.
   *
   * @param fileBuffer - Raw bytes of the PDF or PPTX file
   * @param fileType - Detected file format
   * @param livekitToken - Authentication token for the LiveKit room
   * @param fileName - Optional display name for the presentation
   * @returns Metadata about the created presentation
   * @throws {InvalidTokenError} When the JWT signature, claims, or grants are invalid
   * @throws {RoomAlreadyPresentingError} When the token's room already has an active presentation
   * @throws {MaxConcurrentPresentationsError} When the global session limit is reached
   */
  createPresentation(
    fileBuffer: Buffer,
    fileType: FileType,
    livekitToken: string,
    fileName?: string
  ): Promise<PresentationInfo>

  /**
   * Navigates to a different slide in the presentation.
   *
   * @param id - Presentation session ID
   * @param action - Navigation action (next, prev, or goto)
   * @param slideIndex - Target slide index (required for goto)
   * @returns Updated presentation state
   * @throws {PresentationNotFoundError} If the session does not exist
   */
  navigate(id: string, action: 'next' | 'prev' | 'goto', slideIndex?: number): Promise<PresentationState>

  /**
   * Returns the current state of a presentation, or null if not found.
   *
   * @param id - Presentation session ID
   * @returns Current state or null
   */
  getState(id: string): PresentationState | null

  /**
   * Starts or resumes video playback on the current slide.
   *
   * @param id - Presentation session ID
   * @param videoIndex - Index of the video annotation on the current slide
   * @throws {PresentationNotFoundError} If the session does not exist
   */
  playVideo(id: string, videoIndex: number): Promise<void>

  /**
   * Pauses the currently playing video.
   *
   * @param id - Presentation session ID
   * @throws {PresentationNotFoundError} If the session does not exist
   */
  pauseVideo(id: string): Promise<void>

  /**
   * Stops video playback and returns to the static slide frame.
   *
   * @param id - Presentation session ID
   * @throws {PresentationNotFoundError} If the session does not exist
   */
  stopVideo(id: string): Promise<void>

  /**
   * Stops and cleans up a presentation session.
   *
   * @param id - Presentation session ID
   */
  stopPresentation(id: string): Promise<void>
}
