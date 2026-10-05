import { test } from '../components'

test('GET /presentations/:id/slides/:file', function ({ components, spyComponents }) {
  const presentationId = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f'
  const hash = '0123456789abcdef'
  let response: Response

  describe('when the hash names a cached slide', () => {
    beforeEach(async () => {
      spyComponents.presentationManager.getSlideImage.mockReturnValue(Buffer.from('png'))
      response = await components.localFetch.fetch(`/presentations/${presentationId}/slides/${hash}.png`)
    })

    it('should respond with a 200', () => {
      expect(response.status).toBe(200)
    })

    it('should respond with the image/png content type', () => {
      expect(response.headers.get('content-type')).toBe('image/png')
    })

    it('should respond with an immutable public cache policy', () => {
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    })

    it('should respond with the PNG bytes', async () => {
      expect(await response.text()).toBe('png')
    })

    it('should look the image up by presentation id and hash', () => {
      expect(spyComponents.presentationManager.getSlideImage).toHaveBeenCalledWith(presentationId, hash)
    })
  })

  describe('when the hash is not cached', () => {
    beforeEach(async () => {
      spyComponents.presentationManager.getSlideImage.mockReturnValue(null)
      response = await components.localFetch.fetch(`/presentations/${presentationId}/slides/${hash}.png`)
    })

    it('should respond with a 404', () => {
      expect(response.status).toBe(404)
    })
  })

  describe('when the file name is not a hex hash', () => {
    beforeEach(async () => {
      response = await components.localFetch.fetch(`/presentations/${presentationId}/slides/XYZ.png`)
    })

    it('should respond with a 404', () => {
      expect(response.status).toBe(404)
    })
  })
})
