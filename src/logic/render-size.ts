const FULL_HD_LONG_SIDE = 1920
const FULL_HD_SHORT_SIDE = 1080

/**
 * @returns the scale and even render dimensions that fit the page inside 1920x1080, or 1080x1920 when portrait.
 */
export function fitRenderSize(pageWidth: number, pageHeight: number): { scale: number; width: number; height: number } {
  const [maxWidth, maxHeight] =
    pageWidth >= pageHeight ? [FULL_HD_LONG_SIDE, FULL_HD_SHORT_SIDE] : [FULL_HD_SHORT_SIDE, FULL_HD_LONG_SIDE]
  const scale = Math.min(maxWidth / pageWidth, maxHeight / pageHeight)
  return {
    scale,
    width: Math.round(pageWidth * scale) & ~1,
    height: Math.round(pageHeight * scale) & ~1
  }
}
