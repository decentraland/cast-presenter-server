import {
  isValidFileId,
  isFileAllowed,
  getAllowedFileIds,
  isVideoMime,
  PUBLIC_DRIVE_DOWNLOAD_URL
} from '../../src/adapters/google-drive'

describe('google-drive', () => {
  describe('isValidFileId', () => {
    it('accepts alphanumeric with hyphens and underscores', () => {
      expect(isValidFileId('abc123-_XYZ')).toBe(true)
    })

    it('rejects empty string', () => {
      expect(isValidFileId('')).toBe(false)
    })

    it('rejects path traversal characters', () => {
      expect(isValidFileId('../etc/passwd')).toBe(false)
      expect(isValidFileId('file/id')).toBe(false)
    })

    it('rejects special characters', () => {
      expect(isValidFileId('id<script>')).toBe(false)
      expect(isValidFileId('id with spaces')).toBe(false)
    })
  })

  describe('isFileAllowed', () => {
    it('denies all when allowlist is null (default-deny)', () => {
      expect(isFileAllowed('any-id', null)).toBe(false)
    })

    it('allows file in the allowlist', () => {
      const allowed = new Set(['file-a', 'file-b'])
      expect(isFileAllowed('file-a', allowed)).toBe(true)
    })

    it('denies file not in the allowlist', () => {
      const allowed = new Set(['file-a'])
      expect(isFileAllowed('file-c', allowed)).toBe(false)
    })
  })

  describe('getAllowedFileIds', () => {
    it('returns null for empty config (default-deny)', async () => {
      const getConfig = async () => ''
      expect(await getAllowedFileIds(getConfig)).toBeNull()
    })

    it('returns null for undefined config', async () => {
      const getConfig = async () => undefined
      expect(await getAllowedFileIds(getConfig)).toBeNull()
    })

    it('parses comma-separated IDs', async () => {
      const getConfig = async () => 'id1, id2, id3'
      const result = await getAllowedFileIds(getConfig)
      expect(result).toEqual(new Set(['id1', 'id2', 'id3']))
    })

    it('trims whitespace and filters empty entries', async () => {
      const getConfig = async () => ' id1 ,, id2 , '
      const result = await getAllowedFileIds(getConfig)
      expect(result).toEqual(new Set(['id1', 'id2']))
    })
  })

  describe('isVideoMime', () => {
    it('accepts video MIME types', () => {
      expect(isVideoMime('video/mp4')).toBe(true)
      expect(isVideoMime('video/webm')).toBe(true)
      expect(isVideoMime('Video/MP4')).toBe(true)
    })

    it('rejects non-video MIME types', () => {
      expect(isVideoMime('text/html')).toBe(false)
      expect(isVideoMime('application/pdf')).toBe(false)
    })
  })

  describe('PUBLIC_DRIVE_DOWNLOAD_URL', () => {
    it('encodes the file ID', () => {
      const url = PUBLIC_DRIVE_DOWNLOAD_URL('abc-123')
      expect(url).toContain('id=abc-123')
      expect(url).toContain('export=download')
    })
  })
})
