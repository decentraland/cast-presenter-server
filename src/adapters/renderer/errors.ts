/**
 * Thrown by a renderer when a slide cannot be rendered (e.g. the native canvas
 * cannot allocate a surface for an oversized page). The original error is kept
 * as `cause`.
 */
export class SlideRenderError extends Error {
  readonly cause: unknown

  constructor(index: number, cause: unknown) {
    super(`Failed to render slide ${index}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'SlideRenderError'
    this.cause = cause
  }
}
