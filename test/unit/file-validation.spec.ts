import { getFileTypeFromName, sanitizeFilename, validateMagicBytes } from '../../src/logic/file-validator'

describe('when validating file uploads', () => {
  describe('when checking magic bytes', () => {
    describe('and the file is a valid PDF', () => {
      it('should return true for a buffer starting with %PDF', () => {
        const pdf = Buffer.from('%PDF-1.7 rest of file')
        expect(validateMagicBytes(pdf, 'pdf')).toBe(true)
      })
    })

    describe('and the file claims to be PDF but has wrong magic bytes', () => {
      it('should return false for a PNG buffer', () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])
        expect(validateMagicBytes(png, 'pdf')).toBe(false)
      })
    })

    describe('and the file is a valid PPTX (ZIP archive)', () => {
      it('should return true for a buffer starting with PK\\x03\\x04', () => {
        const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
        expect(validateMagicBytes(zip, 'pptx')).toBe(true)
      })
    })

    describe('and the file claims to be PPTX but has wrong magic bytes', () => {
      it('should return false for a PDF buffer', () => {
        const pdf = Buffer.from('%PDF-1.7')
        expect(validateMagicBytes(pdf, 'pptx')).toBe(false)
      })
    })

    describe('and the buffer is too small to contain magic bytes', () => {
      let small: Buffer

      beforeEach(() => {
        small = Buffer.from([0x50, 0x4b])
      })

      it('should return false for pptx', () => {
        expect(validateMagicBytes(small, 'pptx')).toBe(false)
      })

      it('should return false for pdf', () => {
        expect(validateMagicBytes(small, 'pdf')).toBe(false)
      })
    })

    describe('and the buffer is empty', () => {
      it('should return false', () => {
        expect(validateMagicBytes(Buffer.alloc(0), 'pdf')).toBe(false)
      })
    })
  })

  describe('when detecting file type from filename', () => {
    describe('and the filename has a .pdf extension', () => {
      it('should return "pdf"', () => {
        expect(getFileTypeFromName('slides.pdf')).toBe('pdf')
      })
    })

    describe('and the filename has a .pptx extension', () => {
      it('should return "pptx"', () => {
        expect(getFileTypeFromName('deck.pptx')).toBe('pptx')
      })
    })

    describe('and the extension is uppercase', () => {
      it('should match case-insensitively', () => {
        expect(getFileTypeFromName('SLIDES.PDF')).toBe('pdf')
        expect(getFileTypeFromName('Deck.Pptx')).toBe('pptx')
      })
    })

    describe('and the extension is unsupported', () => {
      it('should return null', () => {
        expect(getFileTypeFromName('notes.key')).toBeNull()
        expect(getFileTypeFromName('README.md')).toBeNull()
      })
    })

    describe('and there is no extension', () => {
      it('should return null', () => {
        expect(getFileTypeFromName('slides')).toBeNull()
      })
    })
  })

  describe('when sanitizing filenames', () => {
    describe('and the filename contains only safe characters', () => {
      it('should return the filename unchanged', () => {
        expect(sanitizeFilename('report-2024.pdf')).toBe('report-2024.pdf')
        expect(sanitizeFilename('my_file.pptx')).toBe('my_file.pptx')
      })
    })

    describe('and the filename contains path traversal sequences', () => {
      it('should strip directory components and return only the base name', () => {
        expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
        expect(sanitizeFilename('/tmp/evil.pdf')).toBe('evil.pdf')
        expect(sanitizeFilename('/tmp/uploads/evil/file.pdf')).toBe('file.pdf')
      })
    })

    describe('and the filename contains special characters', () => {
      it('should replace them with underscores', () => {
        expect(sanitizeFilename('file name (1).pdf')).toBe('file_name__1_.pdf')
        expect(sanitizeFilename('report<script>.pdf')).toBe('report_script_.pdf')
      })
    })
  })
})
