/**
 * Returns the byte size of an I420 frame for the given dimensions.
 * I420 = Y plane (w*h) + U plane (w/2*h/2) + V plane (w/2*h/2)
 */
export function i420FrameSize(width: number, height: number): number {
  const chromaW = (width + 1) >> 1
  const chromaH = (height + 1) >> 1
  return width * height + chromaW * chromaH * 2
}

/**
 * Converts an RGBA buffer to I420 (YUV420 planar) using BT.601 coefficients.
 * The output is a single Buffer with Y, U, V planes packed sequentially.
 */
export function rgbaToI420(rgba: Buffer, width: number, height: number): Buffer {
  const chromaW = (width + 1) >> 1
  const chromaH = (height + 1) >> 1
  const ySize = width * height
  const uvSize = chromaW * chromaH

  const out = Buffer.allocUnsafe(ySize + uvSize * 2)
  const yPlane = out
  const uPlane = ySize
  const vPlane = ySize + uvSize

  // Y plane — full resolution
  for (let j = 0; j < height; j++) {
    const rowOff = j * width * 4
    const yRowOff = j * width
    for (let i = 0; i < width; i++) {
      const p = rowOff + i * 4
      const r = rgba[p]
      const g = rgba[p + 1]
      const b = rgba[p + 2]
      yPlane[yRowOff + i] = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16
    }
  }

  // U and V planes — 2x2 subsampled
  for (let j = 0; j < chromaH; j++) {
    const srcRow = j * 2
    for (let i = 0; i < chromaW; i++) {
      const srcCol = i * 2

      // Average the 2x2 block (handle odd dimensions)
      let rSum = 0,
        gSum = 0,
        bSum = 0,
        count = 0
      for (let dj = 0; dj < 2 && srcRow + dj < height; dj++) {
        for (let di = 0; di < 2 && srcCol + di < width; di++) {
          const p = ((srcRow + dj) * width + srcCol + di) * 4
          rSum += rgba[p]
          gSum += rgba[p + 1]
          bSum += rgba[p + 2]
          count++
        }
      }
      const r = (rSum / count) | 0
      const g = (gSum / count) | 0
      const b = (bSum / count) | 0

      const idx = j * chromaW + i
      out[uPlane + idx] = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128
      out[vPlane + idx] = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128
    }
  }

  return out
}
