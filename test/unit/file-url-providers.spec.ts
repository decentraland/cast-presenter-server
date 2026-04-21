import { resolveFileUrl } from '../../src/adapters/file-provider/file-url-providers'
import type { ResolvedFileUrl } from '../../src/adapters/file-provider/file-url-providers'

describe('when resolving file download URLs', () => {
  let result: ResolvedFileUrl

  describe('when the URL is a Google Slides presentation', () => {
    const presentationId = '1iijFedYWWOa0wvgK1Er2pU3YWci6yMs_S23NBaX6p1o'

    describe('and the URL ends with /edit', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://docs.google.com/presentation/d/${presentationId}/edit`)
      })

      it('should resolve to the PDF export URL', () => {
        expect(result.url).toBe(`https://docs.google.com/presentation/d/${presentationId}/export?format=pdf`)
      })

      it('should set the filename to the presentation ID with .pdf extension', () => {
        expect(result.filename).toBe(`${presentationId}.pdf`)
      })
    })

    describe('and the URL ends with /edit?usp=sharing', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://docs.google.com/presentation/d/${presentationId}/edit?usp=sharing`)
      })

      it('should resolve to the PDF export URL', () => {
        expect(result.url).toBe(`https://docs.google.com/presentation/d/${presentationId}/export?format=pdf`)
      })

      it('should set the filename to the presentation ID with .pdf extension', () => {
        expect(result.filename).toBe(`${presentationId}.pdf`)
      })
    })

    describe('and the URL ends with /present', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://docs.google.com/presentation/d/${presentationId}/present`)
      })

      it('should resolve to the PDF export URL', () => {
        expect(result.url).toBe(`https://docs.google.com/presentation/d/${presentationId}/export?format=pdf`)
      })
    })

    describe('and the URL ends with /pub', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://docs.google.com/presentation/d/${presentationId}/pub`)
      })

      it('should resolve to the PDF export URL', () => {
        expect(result.url).toBe(`https://docs.google.com/presentation/d/${presentationId}/export?format=pdf`)
      })
    })

    describe('and the URL has no suffix after the ID', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://docs.google.com/presentation/d/${presentationId}`)
      })

      it('should resolve to the PDF export URL', () => {
        expect(result.url).toBe(`https://docs.google.com/presentation/d/${presentationId}/export?format=pdf`)
      })
    })
  })

  describe('when the URL is a Google Drive file', () => {
    const fileId = 'abc123_XYZ-789'

    describe('and the URL has /view suffix', () => {
      beforeEach(() => {
        result = resolveFileUrl(`https://drive.google.com/file/d/${fileId}/view?usp=sharing`)
      })

      it('should resolve to the direct download URL', () => {
        expect(result.url).toBe(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`)
      })

      it('should not override the filename', () => {
        expect(result.filename).toBeUndefined()
      })
    })
  })

  describe('when the URL is a regular HTTPS link', () => {
    const regularUrl = 'https://example.com/slides/report.pdf'

    beforeEach(() => {
      result = resolveFileUrl(regularUrl)
    })

    it('should return the URL unchanged', () => {
      expect(result.url).toBe(regularUrl)
    })

    it('should not set a filename override', () => {
      expect(result.filename).toBeUndefined()
    })
  })
})
