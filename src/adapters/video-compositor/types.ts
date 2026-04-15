import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher } from '../livekit-publisher/types'

/** Video annotation geometry from a PDF slide. */
export interface SlideVideoInfo {
  url: string
  geometry: { x: number; y: number; width: number; height: number }
}

/**
 * A video compositor instance that handles downloading, transcoding,
 * and overlaying video onto slide frames via ffmpeg.
 */
export interface IVideoCompositor {
  downloadVideo(url: string): Promise<string>
  resolveStreamUrl(url: string): Promise<string>
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
  pausePlayback(): void
  resumePlayback(): void
  onEnd(callback: () => void): void
  getIsPlaying(): boolean
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
