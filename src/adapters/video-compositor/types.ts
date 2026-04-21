import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher } from '../livekit-publisher/types'

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
    seekSeconds?: number
  ): Promise<void>
  onEnd(callback: () => void): void
  /**
   * Fires when playback is aborted due to an unrecoverable failure (FFmpeg
   * stream error, audio processing throw, or non-zero exit mid-stream).
   * The compositor cleans itself up before firing — the callback's job is to
   * reset session state and notify clients.
   */
  onError(callback: (reason: string) => void): void
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
