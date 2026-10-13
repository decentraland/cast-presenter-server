import { Readable } from 'stream'
import { test } from '../components'

test('GET /api/drive-video', function ({ components, spyComponents }) {
  const fileId = 'fakeDriveFile_01'
  let response: Response

  describe('when a presentation is playing the file', () => {
    beforeEach(async () => {
      spyComponents.presentationManager.isDriveFilePlaying.mockReturnValue(true)
      spyComponents.googleDrive.streamFile.mockResolvedValue({
        stream: Readable.from([Buffer.from('video-bytes')]),
        contentLength: 11,
        contentRange: 'bytes 0-10/100',
        contentType: 'video/mp4'
      })
      response = await components.localFetch.fetch(`/api/drive-video?fileId=${fileId}`, {
        headers: { Range: 'bytes=0-10' }
      })
    })

    it('should respond with a 206 and the video content type', () => {
      expect([response.status, response.headers.get('content-type')]).toEqual([206, 'video/mp4'])
    })

    it('should respond with the streamed bytes', async () => {
      expect(await response.text()).toBe('video-bytes')
    })

    it('should forward the requested range to Drive', () => {
      expect(spyComponents.googleDrive.streamFile).toHaveBeenCalledWith(fileId, { start: 0, end: 10 })
    })
  })

  describe('when no presentation is playing the file and it is not allowlisted', () => {
    beforeEach(async () => {
      spyComponents.presentationManager.isDriveFilePlaying.mockReturnValue(false)
      response = await components.localFetch.fetch(`/api/drive-video?fileId=${fileId}`)
    })

    it('should respond with a 403', () => {
      expect(response.status).toBe(403)
    })

    it('should not fetch the file from Drive', () => {
      expect(spyComponents.googleDrive.streamFile).not.toHaveBeenCalled()
    })
  })
})
