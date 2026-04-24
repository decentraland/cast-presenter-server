import * as path from 'path'

/**
 * Supported presentation file formats.
 *
 * `as const` + derived `FileType` union keeps the set extensible (to add a new
 * format: append the const and every `Record<FileType, T>` lookup forces a
 * compile error until the new entry is filled in).
 */
export const FILE_TYPES = {
  PDF: 'pdf',
  PPTX: 'pptx'
} as const

export type FileType = (typeof FILE_TYPES)[keyof typeof FILE_TYPES]

// PDF starts with %PDF, PPTX is a ZIP starting with PK\x03\x04
const PDF_MAGIC = Buffer.from('%PDF')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

const MAGIC_BYTES: Record<FileType, Buffer> = {
  [FILE_TYPES.PDF]: PDF_MAGIC,
  [FILE_TYPES.PPTX]: ZIP_MAGIC
}

const EXTENSION_MAP: Record<string, FileType> = {
  '.pdf': FILE_TYPES.PDF,
  '.pptx': FILE_TYPES.PPTX
}

/**
 * Validates that a buffer's first 4 bytes match the expected magic bytes
 * for the given file type.
 *
 * @param buffer - Raw file content to check
 * @param fileType - Expected file format
 * @returns true if the magic bytes match
 */
export function validateMagicBytes(buffer: Buffer, fileType: FileType): boolean {
  if (buffer.length < 4) return false
  const magic = MAGIC_BYTES[fileType]
  return buffer.subarray(0, magic.length).equals(magic)
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
 * @returns A FileType if recognized, null otherwise
 */
export function getFileTypeFromName(filename: string): FileType | null {
  const ext = path.extname(filename).toLowerCase()
  return EXTENSION_MAP[ext] ?? null
}
