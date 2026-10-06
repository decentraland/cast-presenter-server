/** Diameter preset of the camera bubble. */
export type OverlaySize = 'small' | 'large'

/** Camera-bubble layout as sent on the wire. */
export interface OverlayLayout {
  /** Bubble centre as a fraction of frame width, clamped to `[0, 1]`. */
  x: number
  /** Bubble centre as a fraction of frame height, clamped to `[0, 1]`. */
  y: number
  /** Diameter preset. */
  size: OverlaySize
}

/** Layout a session starts with: small bubble in the bottom-left corner. */
export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { x: 0, y: 1, size: 'small' }

function isOverlaySize(value: unknown): value is OverlaySize {
  return value === 'small' || value === 'large'
}

/**
 * Parses a `presentation:overlay:update` command into the layout fields it carries.
 *
 * @param message - Raw data-channel command
 * @returns The carried fields, with `x` and `y` clamped to `[0, 1]`, or `null` when any field is invalid
 */
export function parseOverlayUpdate(message: Record<string, unknown>): Partial<OverlayLayout> | null {
  const patch: Partial<OverlayLayout> = {}

  for (const axis of ['x', 'y'] as const) {
    const value = message[axis]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    patch[axis] = Math.min(1, Math.max(0, value))
  }

  if (message.size !== undefined) {
    if (!isOverlaySize(message.size)) return null
    patch.size = message.size
  }

  return patch
}
