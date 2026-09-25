import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { RemoteVideoTrack } from '@livekit/rtc-node'

/** Diameter preset of the camera bubble. */
export type OverlaySize = 'small' | 'large'

/** Bubble layout as sent on the wire. */
export interface OverlayLayout {
  /** Bubble centre as a fraction of frame width, clamped to `[0, 1]`. */
  x: number
  /** Bubble centre as a fraction of frame height, clamped to `[0, 1]`. */
  y: number
  /** Diameter preset. */
  size: OverlaySize
}

/** Bubble bounding square in pixels. `left`, `top` and `d` are even. */
export interface OverlayRect {
  left: number
  top: number
  /** Diameter; `0` means nothing is drawn. */
  d: number
}

/** Circular camera patch as I420 planes plus per-pixel alpha. */
export interface OverlayPatch {
  /** Side length in pixels. */
  d: number
  /** Luma plane, `d * d` bytes. */
  y: Uint8Array
  /** U plane, `(d / 2) * (d / 2)` bytes. */
  u: Uint8Array
  /** V plane, `(d / 2) * (d / 2)` bytes. */
  v: Uint8Array
  /** Alpha per luma pixel, `d * d` bytes. */
  alpha: Uint8Array
}

/** Per-session camera bubble that reads a presenter camera track and stamps it into I420 frames. */
export interface ICameraOverlay {
  /** Start reading the track, replacing any running reader. */
  start(track: RemoteVideoTrack): void
  /** Stop reading and drop the cached camera frame. Idempotent. */
  stop(): Promise<void>
  /** Store a copy of the layout with `x`/`y` clamped to `[0, 1]`. */
  setLayout(layout: OverlayLayout): void
  /** Return a copy of the current layout. */
  getLayout(): OverlayLayout
  /** True while running and at least one camera frame was accepted. */
  isActive(): boolean
  /** Blend the bubble into the I420 buffer in place. No-op while inactive. */
  stamp(i420: Buffer, width: number, height: number): void
  /** Register a callback fired after every accepted camera frame. */
  onCameraFrame(callback: () => void): void
}

/** Factory for per-session camera overlays. */
export interface ICameraOverlayComponent extends IBaseComponent {
  /** Create an overlay bound to the given logger. */
  createOverlay(logger: ILoggerComponent.ILogger): ICameraOverlay
}
