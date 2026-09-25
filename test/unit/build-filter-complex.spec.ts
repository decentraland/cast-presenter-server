import { buildFilterComplex, validateMediaDimensions } from '../../src/adapters/video-compositor/component'

describe('when building the filter graph', () => {
  const videoOverlay = { x: 100, y: 200, w: 640, h: 480 }

  it('should return the two-input overlay filter', () => {
    expect(buildFilterComplex({ videoOverlay })).toBe('[1:v]scale=640:480[vid];[0:v][vid]overlay=100:200:shortest=1')
  })
})

describe('validateMediaDimensions', () => {
  it('accepts a standard 1280x720 frame', () => {
    expect(() => validateMediaDimensions(1280, 720, 'test')).not.toThrow()
  })
  it('accepts the max 7680x7680 frame', () => {
    expect(() => validateMediaDimensions(7680, 7680, 'test')).not.toThrow()
  })
  it('rejects a width above the cap', () => {
    expect(() => validateMediaDimensions(7681, 720, 'test')).toThrow(/width=7681/)
  })
  it('rejects a height of zero', () => {
    expect(() => validateMediaDimensions(1280, 0, 'test')).toThrow(/height=0/)
  })
  it('rejects NaN', () => {
    expect(() => validateMediaDimensions(NaN, 720, 'test')).toThrow()
  })
  it('rejects a non-integer width', () => {
    expect(() => validateMediaDimensions(1280.5, 720, 'test')).toThrow()
  })
  it('includes the ctx string in the error message', () => {
    expect(() => validateMediaDimensions(99999, 720, 'pumpCtx')).toThrow(/pumpCtx/)
  })
})
