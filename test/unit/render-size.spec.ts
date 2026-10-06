import { fitRenderSize } from '../../src/logic/render-size'

describe('when fitting a page into the render box', () => {
  let result: { scale: number; width: number; height: number }

  describe('and the page is a 16:9 landscape slide', () => {
    beforeEach(() => {
      result = fitRenderSize(960, 540)
    })

    it('should render it at 1920x1080', () => {
      expect({ width: result.width, height: result.height }).toEqual({ width: 1920, height: 1080 })
    })
  })

  describe('and the page is a portrait US-letter page', () => {
    beforeEach(() => {
      result = fitRenderSize(612, 792)
    })

    it('should fit it inside 1080x1920 with even dimensions', () => {
      expect({ width: result.width, height: result.height }).toEqual({ width: 1080, height: 1398 })
    })
  })

  describe('and the page is a 4:3 slide', () => {
    beforeEach(() => {
      result = fitRenderSize(1024, 768)
    })

    it('should be limited by the 1080 px height of the landscape box', () => {
      expect({ width: result.width, height: result.height }).toEqual({ width: 1440, height: 1080 })
    })
  })

  describe('and the page is square', () => {
    beforeEach(() => {
      result = fitRenderSize(500, 500)
    })

    it('should render it at 1080x1080', () => {
      expect({ width: result.width, height: result.height }).toEqual({ width: 1080, height: 1080 })
    })
  })

  describe('and the page is a very wide banner with an odd scaled height', () => {
    beforeEach(() => {
      result = fitRenderSize(3000, 501)
    })

    it('should round the height down to an even number', () => {
      expect({ width: result.width, height: result.height }).toEqual({ width: 1920, height: 320 })
    })
  })

  describe('and the page comes from a range of common sizes', () => {
    let sizes: Array<{ width: number; height: number }>

    beforeEach(() => {
      sizes = [
        [960, 540],
        [612, 792],
        [792, 612],
        [595, 842],
        [842, 595],
        [1024, 768],
        [500, 500],
        [3000, 501],
        [501, 3000],
        [12192000, 6858000]
      ].map(([w, h]) => fitRenderSize(w, h))
    })

    it('should keep every page inside 1920x1080 or 1080x1920 with even dimensions', () => {
      expect(
        sizes.every(
          (s) =>
            s.width % 2 === 0 &&
            s.height % 2 === 0 &&
            (s.width >= s.height ? s.width <= 1920 && s.height <= 1080 : s.width <= 1080 && s.height <= 1920)
        )
      ).toBe(true)
    })
  })
})
