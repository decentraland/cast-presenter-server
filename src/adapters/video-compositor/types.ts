import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { OverlayConfig } from '../../logic/presentation-manager/types'
import type { ILiveKitPublisher } from '../livekit-publisher/types'
import type { RemoteVideoTrack } from '@livekit/rtc-node'

/** Video annotation geometry from a PDF slide. */
export interface SlideVideoInfo {
  url: string
  geometry: { x: number; y: number; width: number; height: number }
}

/** A captured video frame with its pixel format, used to freeze the last frame on pause. */
export interface VideoFrameSnapshot {
  buffer: Buffer
  width: number
  height: number
  bufferType: number
}

/**
 * A video compositor instance that handles downloading, transcoding,
 * and overlaying video onto slide frames via ffmpeg.
 */
/** Result of a successful video download. */
export interface VideoDownloadResult {
  /** Absolute path to the remuxed MP4 on disk. */
  path: string
  /** Size of the downloaded file in bytes, used by the caller for per-session disk accounting. */
  bytes: number
}

/**
 * Reasons the compositor may abort playback. Distinct from the
 * presentation-manager's broader `VideoErrorCode` (which also covers
 * pre-playback failures like quota/HTTP errors) — this is the compositor's
 * own failure vocabulary, kept here so the contract stays self-describing.
 */
export type CompositorErrorReason =
  /** FFmpeg composite process exited with a non-zero code mid-stream. */
  | 'video-playback-interrupted'
  /** A composite stdio stream emitted an 'error' event (typically EPIPE). */
  | 'video-stream-error'
  /** The session-supplied onAudioData callback threw synchronously. */
  | 'audio-processing-failed'
  /** Camera frame resolution changed mid-playback — ffmpeg must be restarted. */
  | 'camera-resolution-changed'
  /** Camera frame dimensions failed validation (out of bounds or non-integer). */
  | 'camera-resolution-invalid'

export interface IVideoCompositor {
  /**
   * Downloads a video to disk. If `signal` aborts, the in-flight HTTPS request
   * and remux process are cancelled and any partial files are cleaned up.
   */
  downloadVideo(url: string, signal?: AbortSignal): Promise<VideoDownloadResult>
  startPlayback(
    videoPath: string,
    videoInfo: SlideVideoInfo,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    publisher: ILiveKitPublisher,
    onAudioData?: (pcmChunk: Buffer) => void,
    seekSeconds?: number,
    presenterCamera?: { track: RemoteVideoTrack; overlayConfig: OverlayConfig }
  ): Promise<void>
  /**
   * Registers a callback for natural end-of-stream (FFmpeg exit code 0).
   * Register-once per compositor instance: a second registration replaces the
   * first and the original closure becomes unreachable. Fires at most once.
   */
  onEnd(callback: () => void): void
  /**
   * Registers a callback for unrecoverable mid-stream failures. Before firing,
   * the compositor calls `stopPlayback` internally — FFmpeg processes are
   * killed and the slide heartbeat is restored. The callback's job is to
   * reset session state (videoState='error', drop the compositor reference)
   * and notify clients. Full teardown of latches/listeners still requires the
   * session to call `cleanup()`. Same register-once semantics as `onEnd`.
   */
  onError(callback: (reason: CompositorErrorReason) => void): void
  getIsPlaying(): boolean
  getLastFrame(): VideoFrameSnapshot | null
  cleanup(): void
}

/**
 * Factory component for creating per-session video compositors.
 */
export interface IVideoCompositorComponent extends IBaseComponent {
  /**
   * Creates a new compositor instance.
   *
   * @param logger - Scoped logger for this compositor
   * @param tempDir - Optional temp directory path (auto-created if omitted)
   * @returns A new IVideoCompositor instance
   */
  createCompositor(logger: ILoggerComponent.ILogger, tempDir?: string): IVideoCompositor

  /**
   * Removes a session's temp directory and all cached video files.
   *
   * @param tempDir - Path to the temp directory to remove
   */
  destroyTempDir(tempDir: string): void
}
