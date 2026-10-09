import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher } from '../livekit-publisher/types'

/** Baked files for one playback. */
export interface PlaybackFiles {
  videoPath: string
  audioPath: string | null
}

/** Session publisher backed by the Go sidecar; inherited frame, heartbeat and audio methods are no-ops. */
export interface ISidecarPublisher extends ILiveKitPublisher {
  /** Starts paced playback of baked files from the start, replacing any current playback. */
  play(files: PlaybackFiles): Promise<void>
  /** Stops writing samples; the pacing clock freezes. */
  pause(): Promise<void>
  /** Continues from the paused sample. */
  resume(): Promise<void>
  /** Ends the current playback; the tracks stay published and idle. */
  stopVideo(): Promise<void>
  /** Registers the callback for the natural end of a playback. */
  onPlaybackEnded(cb: () => void): void
  /** Registers the callback for a mid-stream read failure. */
  onPlaybackFailed(cb: (message: string) => void): void
  /** Sidecar exited unexpectedly or the room dropped. */
  onFatal(cb: (reason: string) => void): void
}

/** Factory component for per-session sidecar publishers. */
export interface ISidecarPublisherComponent extends IBaseComponent {
  /**
   * Creates a publisher for one presentation session; the sidecar process starts on `connect`.
   * @param presentationId - Unique ID for the presentation
   * @param logger - Scoped logger for this publisher
   * @returns A new ISidecarPublisher instance
   */
  createPublisher(presentationId: string, logger: ILoggerComponent.ILogger): ISidecarPublisher
}
