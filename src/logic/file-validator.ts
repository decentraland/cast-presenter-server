import * as path from 'path'

// PDF starts with %PDF, PPTX is a ZIP starting with PK\x03\x04
const PDF_MAGIC = Buffer.from('%PDF')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * Validates that a buffer's first 4 bytes match the expected magic bytes
 * for the given file type.
 *
 * @param buffer - Raw file content to check
 * @param fileType - Expected file format
 * @returns true if the magic bytes match
 */
export function validateMagicBytes(buffer: Buffer, fileType: 'pdf' | 'pptx'): boolean {
  if (buffer.length < 4) return false
  if (fileType === 'pdf') return buffer.subarray(0, 4).equals(PDF_MAGIC)
  if (fileType === 'pptx') return buffer.subarray(0, 4).equals(ZIP_MAGIC)
  return false
}

/**
 * Sanitizes a filename by stripping directory components and replacing
 * special characters with underscores.
 *
 * @param filename - Raw filename (may include path components)
 * @returns Safe filename with only alphanumeric, dot, hyphen, underscore
 */
export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename)
  return base.replace(/[^a-zA-Z0-9._-]/g, '_')
}

/**
 * Detects the presentation file type from its extension.
 *
 * @param filename - Filename to check (case-insensitive)
 * @returns 'pdf' or 'pptx' if supported, null otherwise
 */
export function getFileTypeFromName(filename: string): 'pdf' | 'pptx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.pptx')) return 'pptx'
  return null
}
