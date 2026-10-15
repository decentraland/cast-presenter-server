import {
  MAX_SLIDE_DIMENSION,
  MAX_SLIDE_PIXELS,
  assertRenderableDimensions,
  toEvenDimension
} from '../../src/adapters/renderer/dimensions'

describe('when validating slide dimensions before allocating a canvas', () => {
  describe('and the dimensions are finite, positive and within the limits', () => {
    it('should accept a moderately tall A4-portrait slide', () => {
      expect(() => assertRenderableDimensions(960, 1358)).not.toThrow()
    })

    it('should accept the dimensions at the exact pixel limit', () => {
      expect(() => assertRenderableDimensions(960, MAX_SLIDE_PIXELS / 960)).not.toThrow()
    })
  })

  describe('and a dimension is not a finite positive number', () => {
    it('should reject a zero dimension', () => {
      expect(() => assertRenderableDimensions(960, 0)).toThrow(/Invalid slide dimensions/)
    })

    it('should reject a non-finite dimension', () => {
      expect(() => assertRenderableDimensions(960, Number.POSITIVE_INFINITY)).toThrow(/Invalid slide dimensions/)
    })
  })

  describe('and the dimensions exceed the limits', () => {
    it('should reject a slide taller than the max dimension', () => {
      expect(() => assertRenderableDimensions(960, MAX_SLIDE_DIMENSION + 1)).toThrow(/exceed/)
    })

    it('should reject a slide whose total area exceeds the pixel limit', () => {
      expect(() => assertRenderableDimensions(960, 559241)).toThrow(/exceed/)
    })
  })
})

describe('when rounding a length to an even dimension', () => {
  it('should round an odd length down to the nearest even integer', () => {
    expect(toEvenDimension(961)).toBe(960)
  })

  it('should round a fractional length to the nearest even integer', () => {
    expect(toEvenDimension(958.6)).toBe(958)
  })
})
