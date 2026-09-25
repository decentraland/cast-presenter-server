import type { ICameraOverlayComponent, OverlayLayout, OverlayPatch, OverlayRect, OverlaySize } from './types'

export const OVERLAY_SIZES: readonly OverlaySize[] = []

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { x: 0, y: 0, size: 'small' }

export function overlayRect(_layout: OverlayLayout, _width: number, _height: number): OverlayRect {
  throw new Error('not implemented')
}

export function blendPatch(
  _i420: Buffer,
  _width: number,
  _height: number,
  _patch: OverlayPatch,
  _rect: OverlayRect
): void {
  throw new Error('not implemented')
}

export function createCameraOverlayComponent(): ICameraOverlayComponent {
  throw new Error('not implemented')
}
