import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { OverlayConfig } from '../../logic/presentation-manager/types'
import type { RemoteVideoTrack } from '@livekit/rtc-node'

/** A single composited frame, ready to push to LiveKit. */
export interface CompositeFrame {
  /** I420 (yuv420p) buffer sized for `width * height * 1.5`. */
  buffer: Buffer
  width: number
  height: number
}

/** Updates the slide buffer the compositor draws onto. Camera frames continue to flow. */
export interface ICameraOverlayCompositor {
  /**
   * Begin reading frames from the given camera track and pushing composites to `onFrame`.
   * Resolves once the stream is wired up; rejects on construction errors. Reading runs
   * in the background until `stop()` is called.
   */
  start(
    track: RemoteVideoTrack,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    onFrame: (frame: CompositeFrame) => void
  ): Promise<void>

  /** Swap the slide buffer (e.g. on slide navigation). No-op if not started. */
  updateSlide(slideBuffer: Buffer, slideWidth: number, slideHeight: number): void

  /** Stop reading frames and release the VideoStream. Idempotent. */
  stop(): Promise<void>
}

export interface ICameraOverlayCompositorComponent extends IBaseComponent {
  createCompositor(logger: ILoggerComponent.ILogger, overlayConfig: OverlayConfig): ICameraOverlayCompositor
}
