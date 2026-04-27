// EMU (English Metric Units) conversion
// 1 inch = 914400 EMU
// 1 inch = 96 pixels (at 96 DPI)
// Therefore: 1 pixel = 914400 / 96 = 9525 EMU
export const EMU_PER_PIXEL = 9525
export const EMU_PER_INCH = 914400
export const PIXELS_PER_INCH = 96

// At 96 DPI, 1 point = 1/72 inch = 96/72 px = 4/3 px.
// PPTX stores font sizes in hundredths of a point (sz="2400" → 24pt → 32px).
export const PT_TO_PX = 4 / 3

// Standard PowerPoint slide dimensions in EMU
export const SLIDE_WIDTH_EMU = 9144000 // 10 inches = 960px at 96dpi
export const SLIDE_HEIGHT_EMU = 6858000 // 7.5 inches = 720px at 96dpi

// Default rendered slide dimensions in pixels
export const DEFAULT_SLIDE_WIDTH_PX = 960
export const DEFAULT_SLIDE_HEIGHT_PX = 540

// OOXML namespaces
export const NS = {
  PRESENTATION: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  DRAWING: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  RELATIONSHIPS: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  CONTENT_TYPES: 'http://schemas.openxmlformats.org/package/2006/content-types'
} as const

// Relationship types
export const REL_TYPES = {
  SLIDE: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  SLIDE_LAYOUT: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  IMAGE: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  VIDEO: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video',
  AUDIO: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio',
  MEDIA: 'http://schemas.microsoft.com/office/2007/relationships/media'
} as const

// Video MIME type map
export const VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  m4v: 'video/mp4',
  ogv: 'video/ogg'
}

// Image MIME type map
export const IMAGE_EXTENSIONS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  webp: 'image/webp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf'
}
