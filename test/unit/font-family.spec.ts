import { resolveFontFamily } from '../../src/adapters/pptx-renderer/font-family'

describe('when resolving the font family a slide asks for', () => {
  let installed: Set<string>
  let isInstalled: (family: string) => boolean

  beforeEach(() => {
    installed = new Set(['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Inter'])
    isInstalled = (family) => installed.has(family)
  })

  describe('and the family is installed', () => {
    it('should keep the requested family', () => {
      expect(resolveFontFamily('Inter', isInstalled)).toBe('Inter')
    })
  })

  describe('and the family is missing but has a metric-compatible substitute', () => {
    it.each([
      ['Arial', 'Liberation Sans'],
      ['Helvetica', 'Liberation Sans'],
      ['Times New Roman', 'Liberation Serif'],
      ['Courier New', 'Liberation Mono']
    ])('should render %s with %s', (requested, substitute) => {
      expect(resolveFontFamily(requested, isInstalled)).toBe(substitute)
    })
  })

  describe('and the family is missing with no substitute', () => {
    describe('and Arial is installed', () => {
      beforeEach(() => {
        installed.add('Arial')
      })

      it('should fall back to Arial', () => {
        expect(resolveFontFamily('Calibri', isInstalled)).toBe('Arial')
      })
    })

    describe('and Arial is missing', () => {
      it('should fall back to Liberation Sans', () => {
        expect(resolveFontFamily('Calibri', isInstalled)).toBe('Liberation Sans')
      })
    })
  })

  describe('and no candidate is installed', () => {
    beforeEach(() => {
      installed.clear()
    })

    it('should still name Arial so the canvas falls back on its own', () => {
      expect(resolveFontFamily('Calibri', isInstalled)).toBe('Arial')
    })
  })
})
