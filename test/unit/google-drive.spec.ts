import { createGoogleDriveComponent, getPublicDriveDownloadUrl } from '../../src/adapters/google-drive'
import type { IGoogleDriveComponent } from '../../src/adapters/google-drive'

describe('google-drive', () => {
  let googleDrive: IGoogleDriveComponent

  describe('with allowed file IDs configured', () => {
    beforeEach(async () => {
      googleDrive = await createGoogleDriveComponent({
        config: {
          getString: async (key: string) => {
            if (key === 'DRIVE_VIDEO_ALLOWED_FILE_IDS') return 'file-a, file-b'
            return undefined
          },
          getNumber: async () => undefined,
          requireString: async (key: string) => key,
          requireNumber: async (key: string) => parseInt(key, 10)
        },
        fetcher: { fetch: async () => new Response() } as unknown as Parameters<
          typeof createGoogleDriveComponent
        >[0]['fetcher']
      })
    })

    describe('isValidFileId', () => {
      it('accepts alphanumeric with hyphens and underscores', () => {
        expect(googleDrive.isValidFileId('abc123-_XYZ')).toBe(true)
      })

      it('rejects empty string', () => {
        expect(googleDrive.isValidFileId('')).toBe(false)
      })

      it('rejects path traversal characters', () => {
        expect(googleDrive.isValidFileId('../etc/passwd')).toBe(false)
        expect(googleDrive.isValidFileId('file/id')).toBe(false)
      })

      it('rejects special characters', () => {
        expect(googleDrive.isValidFileId('id<script>')).toBe(false)
        expect(googleDrive.isValidFileId('id with spaces')).toBe(false)
      })
    })

    describe('isFileAllowed', () => {
      it('allows file in the allowlist', () => {
        expect(googleDrive.isFileAllowed('file-a')).toBe(true)
      })

      it('denies file not in the allowlist', () => {
        expect(googleDrive.isFileAllowed('file-c')).toBe(false)
      })
    })

    describe('isVideoMime', () => {
      it('accepts video MIME types', () => {
        expect(googleDrive.isVideoMime('video/mp4')).toBe(true)
        expect(googleDrive.isVideoMime('video/webm')).toBe(true)
        expect(googleDrive.isVideoMime('Video/MP4')).toBe(true)
      })

      it('rejects non-video MIME types', () => {
        expect(googleDrive.isVideoMime('text/html')).toBe(false)
        expect(googleDrive.isVideoMime('application/pdf')).toBe(false)
      })
    })
  })

  describe('with empty allowlist (default-deny)', () => {
    beforeEach(async () => {
      googleDrive = await createGoogleDriveComponent({
        config: {
          getString: async () => '',
          getNumber: async () => undefined,
          requireString: async (key: string) => key,
          requireNumber: async (key: string) => parseInt(key, 10)
        },
        fetcher: { fetch: async () => new Response() } as unknown as Parameters<
          typeof createGoogleDriveComponent
        >[0]['fetcher']
      })
    })

    it('denies all files when allowlist is empty', () => {
      expect(googleDrive.isFileAllowed('any-id')).toBe(false)
    })
  })

  describe('getPublicDriveDownloadUrl', () => {
    it('encodes the file ID', () => {
      const url = getPublicDriveDownloadUrl('abc-123')
      expect(url).toContain('id=abc-123')
      expect(url).toContain('export=download')
    })
  })
})
