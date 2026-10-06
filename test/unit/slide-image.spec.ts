import { encodeSlidePng } from '../../src/logic/slide-image'
import type { SlideImage } from '../../src/logic/slide-image'

function opaqueRed(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255
    rgba[i + 3] = 255
  }
  return rgba
}

describe('when encoding a slide to PNG', () => {
  let rgba: Buffer

  beforeEach(() => {
    rgba = opaqueRed(4, 2)
  })

  describe('and the buffer matches the dimensions', () => {
    let image: SlideImage

    beforeEach(async () => {
      image = await encodeSlidePng(rgba, 4, 2)
    })

    it('should produce bytes that start with the PNG signature', () => {
      expect([...image.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    })

    it('should use 16 lowercase hex characters as the hash', () => {
      expect(image.hash).toMatch(/^[0-9a-f]{16}$/)
    })

    describe('and the same pixels are encoded again', () => {
      let again: SlideImage

      beforeEach(async () => {
        again = await encodeSlidePng(opaqueRed(4, 2), 4, 2)
      })

      it('should produce the same hash', () => {
        expect(again.hash).toBe(image.hash)
      })
    })
  })

  describe('and the buffer length does not match the dimensions', () => {
    let encoding: Promise<SlideImage>

    beforeEach(() => {
      encoding = encodeSlidePng(rgba, 4, 3)
      encoding.catch(() => undefined)
    })

    it('should reject', async () => {
      await expect(encoding).rejects.toThrow()
    })
  })
})
