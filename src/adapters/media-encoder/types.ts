import type { IBaseComponent } from '@well-known-components/interfaces'

/** Files produced by one bake. `audioPath` is null when the source has no audio stream. */
export interface BakeResult {
  videoPath: string
  audioPath: string | null
  bytes: number
}

export type BakePriority = 'play' | 'prefetch'

/** Bakes videos into sidecar-playable Annex-B H.264 + Ogg/Opus files, one at a time process-wide. */
export interface IMediaEncoder extends IBaseComponent {
  /**
   * Queues a bake; `play` requests run before queued `prefetch` requests. A running bake is never preempted.
   * @throws immediately if `signal` is already aborted; otherwise when ffmpeg fails, times out, or `signal` aborts (queued or running); partial outputs are deleted.
   */
  bake(
    sourcePath: string,
    outDir: string,
    options: { priority: BakePriority; signal: AbortSignal }
  ): Promise<BakeResult>
  /** Moves the still-queued bake owning `signal` to the front of the pending queue; no-op if running, finished or unknown. */
  promote(signal: AbortSignal): void
  /** @returns the real path and size when `url` is a file the PPTX renderer extracted, otherwise null. */
  resolveEmbeddedVideo(url: string): { path: string; bytes: number } | null
}
