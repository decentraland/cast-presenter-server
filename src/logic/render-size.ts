const FULL_HD_LONG_SIDE = 1920
const FULL_HD_SHORT_SIDE = 1080
const MIN_SIDE = 2

function isValidSide(side: number): boolean {
  return Number.isFinite(side) && side > 0
}

/**
 * @returns the scale and even render dimensions, at least 2 px each, that fit the page inside 1920x1080, or 1080x1920 when portrait.
 * @throws {Error} When a page side is not a finite positive number.
 */
export function fitRenderSize(pageWidth: number, pageHeight: number): { scale: number; width: number; height: number } {
  if (!isValidSide(pageWidth) || !isValidSide(pageHeight)) {
    throw new Error(`Invalid page size ${pageWidth}x${pageHeight}`)
  }
  const [maxWidth, maxHeight] =
    pageWidth >= pageHeight ? [FULL_HD_LONG_SIDE, FULL_HD_SHORT_SIDE] : [FULL_HD_SHORT_SIDE, FULL_HD_LONG_SIDE]
  const scale = Math.min(maxWidth / pageWidth, maxHeight / pageHeight)
  return {
    scale,
    width: Math.max(MIN_SIDE, Math.round(pageWidth * scale) & ~1),
    height: Math.max(MIN_SIDE, Math.round(pageHeight * scale) & ~1)
  }
}
