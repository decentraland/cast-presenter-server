import { test } from '../components'

// These tests drive a real multipart/form-data request through the migrated
// @dcl/http-server (native undici Request). They prove the handler reads the body
// via request.arrayBuffer() and busboy parses it — i.e. multipart still works after
// the WKC -> @dcl/core-components http-server update. A web FormData + Blob is used
// because the test-helpers local fetch is native fetch (a node form-data instance
// would be serialized as "[object FormData]").
test('POST /presentations multipart parsing (native-Request http-server)', function ({ components }) {
  describe('when the body is multipart/form-data with a file part but no livekit fields', () => {
    it('should parse the uploaded file from the multipart body and fail on the missing livekit fields (not "missing file")', async () => {
      const { localFetch } = components

      const form = new FormData()
      form.append('file', new Blob(['%PDF-1.4 fake pdf'], { type: 'application/pdf' }), 'test.pdf')

      const response = await localFetch.fetch('/presentations', { method: 'POST', body: form })

      expect(response.status).toEqual(400)
      expect((await response.json()).error).toMatch(/livekitToken|livekitUrl/i)
    })
  })

  describe('when the body is multipart/form-data with fields but no file part', () => {
    it('should parse the multipart fields and report the missing file', async () => {
      const { localFetch } = components

      const form = new FormData()
      form.append('livekitToken', 'test-token')
      form.append('livekitUrl', 'wss://example.livekit.cloud')

      const response = await localFetch.fetch('/presentations', { method: 'POST', body: form })

      expect(response.status).toEqual(400)
      expect((await response.json()).error).toMatch(/missing file/i)
    })
  })
})
