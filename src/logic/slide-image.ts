import { createHash } from 'crypto'
import { ImageData, createCanvas } from '@napi-rs/canvas'

/** A rendered slide encoded as PNG, addressed by a content hash. */
export interface SlideImage {
  /** First 16 hex characters of the SHA-256 of `png`. */
  hash: string
  png: Buffer
  width: number
  height: number
}

/**
 * Encodes an RGBA slide render as PNG.
 *
 * @param rgba - Tightly packed RGBA pixels, `width * height * 4` bytes
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @returns The PNG bytes with their content hash and dimensions
 * @throws {Error} When the buffer length does not match the dimensions
 */
export async function encodeSlidePng(rgba: Buffer, width: number, height: number): Promise<SlideImage> {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer is ${rgba.length} bytes, expected ${width * height * 4} for ${width}x${height}`)
  }
  const canvas = createCanvas(width, height)
  canvas
    .getContext('2d')
    .putImageData(
      new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height),
      0,
      0
    )
  const png = await canvas.encode('png')
  const hash = createHash('sha256').update(png).digest('hex').slice(0, 16)
  return { hash, png, width, height }
}
