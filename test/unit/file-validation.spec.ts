import { sanitizeFilename, validateMagicBytes } from '../../src/controllers/handlers/create-presentation-handler'

describe('file-validation', () => {
  describe('validateMagicBytes', () => {
    it('accepts valid PDF magic bytes', () => {
      const pdf = Buffer.from('%PDF-1.7 rest of file')
      expect(validateMagicBytes(pdf, 'pdf')).toBe(true)
    })

    it('rejects non-PDF magic bytes for pdf type', () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
      expect(validateMagicBytes(png, 'pdf')).toBe(false)
    })

    it('accepts valid PPTX (ZIP) magic bytes', () => {
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
      expect(validateMagicBytes(zip, 'pptx')).toBe(true)
    })

    it('rejects non-ZIP magic bytes for pptx type', () => {
      const pdf = Buffer.from('%PDF-1.7')
      expect(validateMagicBytes(pdf, 'pptx')).toBe(false)
    })

    it('rejects buffer too small', () => {
      const small = Buffer.from([0x50, 0x4b])
      expect(validateMagicBytes(small, 'pptx')).toBe(false)
      expect(validateMagicBytes(small, 'pdf')).toBe(false)
    })

    it('rejects empty buffer', () => {
      expect(validateMagicBytes(Buffer.alloc(0), 'pdf')).toBe(false)
    })
  })

  describe('sanitizeFilename', () => {
    it('keeps safe characters', () => {
      expect(sanitizeFilename('report-2024.pdf')).toBe('report-2024.pdf')
      expect(sanitizeFilename('my_file.pptx')).toBe('my_file.pptx')
    })

    it('strips path traversal', () => {
      expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
      expect(sanitizeFilename('/tmp/evil.pdf')).toBe('evil.pdf')
    })

    it('replaces special characters with underscores', () => {
      expect(sanitizeFilename('file name (1).pdf')).toBe('file_name__1_.pdf')
      expect(sanitizeFilename('report<script>.pdf')).toBe('report_script_.pdf')
    })

    it('handles Unix paths', () => {
      expect(sanitizeFilename('/tmp/uploads/evil/file.pdf')).toBe('file.pdf')
    })
  })
})
