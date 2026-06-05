import { buildFilterComplex, validateMediaDimensions } from '../../src/adapters/video-compositor/component'

describe('buildFilterComplex', () => {
  const videoOverlay = { x: 100, y: 200, w: 640, h: 480 }

  it('returns the 2-input filter when camera is absent', () => {
    const f = buildFilterComplex({ videoOverlay, camera: null })
    expect(f).toBe('[1:v]scale=640:480[vid];[0:v][vid]overlay=100:200:shortest=1')
  })

  it('builds a circular-mask + corner overlay when camera is present', () => {
    const f = buildFilterComplex({
      videoOverlay,
      camera: { config: { corner: 'BR', size: 'medium' }, slideWidth: 1280, slideHeight: 720 }
    })
    // 20% of 1280 = 256, margin 2% = 26, BR origin = (1280-26-256, 720-26-256) = (998, 438)
    expect(f).toContain('[bg][cam]overlay=998:438')
    expect(f).toContain('scale=256:256,format=yuva420p')
    expect(f).toContain('hypot(X-128,Y-128)')
  })

  it('places the camera in TL at margin offset', () => {
    const f = buildFilterComplex({
      videoOverlay,
      camera: { config: { corner: 'TL', size: 'small' }, slideWidth: 1920, slideHeight: 1080 }
    })
    // 15% of 1920 = 288, margin 2% = 38, TL origin = (38, 38)
    expect(f).toContain('[bg][cam]overlay=38:38')
  })

  it('throws on out-of-range slide size (validateFilterParam)', () => {
    expect(() =>
      buildFilterComplex({
        videoOverlay,
        camera: { config: { corner: 'BR', size: 'large' }, slideWidth: 99999, slideHeight: 720 }
      })
    ).toThrow(/Invalid ffmpeg filter param/)
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
