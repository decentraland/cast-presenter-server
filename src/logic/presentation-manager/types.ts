import type { IBaseComponent } from '@well-known-components/interfaces'
import type { SlideVideoInfo } from '../../adapters/video-compositor/types'
import type { FileType } from '../file-validator'

/** Where the camera circle is drawn on the slide. */
export type OverlayCorner = 'TL' | 'TR' | 'BL' | 'BR'

/** Discrete size buckets: 15% / 20% / 25% of the slide width. */
export type OverlaySize = 'small' | 'medium' | 'large'

/** Per-session camera-overlay configuration; immutable once the session starts. */
export interface OverlayConfig {
  corner: OverlayCorner
  size: OverlaySize
}

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
  /** Camera-overlay layout for this session. Undefined disables the overlay entirely. */
  overlayConfig?: OverlayConfig
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
   * Verifies a LiveKit token by opening and closing a throwaway connection.
   *
   * Meant for pre-flight checks so we can reject bogus credentials before
   * running expensive work (e.g. downloading a user-supplied URL).
   *
   * @throws {InvalidLivekitCredentialsError} When the token is rejected by the room
   */
  validateCredentials(livekitUrl: string, livekitToken: string): Promise<void>

  /**
   * Creates a new presentation session from a file buffer.
   *
   * Connects to LiveKit first (fail-fast auth), then renders the PDF,
   * publishes the first slide, and starts the heartbeat.
   *
   * @param fileBuffer - Raw bytes of the PDF or PPTX file
   * @param fileType - Detected file format
   * @param livekitToken - Authentication token for the LiveKit room
   * @param livekitUrl - WebSocket URL of the LiveKit server
   * @param fileName - Optional display name for the presentation
   * @param overlayConfig - Camera-overlay layout (corner + size); omit to disable the overlay.
   * @returns Metadata about the created presentation
   * @throws {MaxConcurrentPresentationsError} When the session limit is reached
   */
  createPresentation(
    fileBuffer: Buffer,
    fileType: FileType,
    livekitToken: string,
    livekitUrl: string,
    fileName?: string,
    overlayConfig?: OverlayConfig
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
