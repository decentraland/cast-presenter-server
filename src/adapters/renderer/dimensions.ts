export const MAX_SLIDE_DIMENSION = 16384

export const MAX_SLIDE_PIXELS = 960 * MAX_SLIDE_DIMENSION

/** Rounds a length to the nearest even integer, as required by yuv420p chroma subsampling. */
export function toEvenDimension(length: number): number {
  return Math.round(length) & ~1
}

/**
 * Asserts that a slide's computed canvas size is safe to allocate. A native
 * surface allocation past the limits below can abort the process instead of
 * throwing, so callers must run this before `createCanvas`.
 *
 * @throws {Error} if either dimension is not a finite positive number, exceeds
 * `MAX_SLIDE_DIMENSION`, or the total area exceeds `MAX_SLIDE_PIXELS`.
 */
export function assertRenderableDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid slide dimensions: ${width}x${height}`)
  }
  if (width > MAX_SLIDE_DIMENSION || height > MAX_SLIDE_DIMENSION || width * height > MAX_SLIDE_PIXELS) {
    throw new Error(`Slide dimensions ${width}x${height} exceed the ${MAX_SLIDE_PIXELS}px render limit`)
  }
}
