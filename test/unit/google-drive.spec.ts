import type { IFetchComponent } from '@well-known-components/interfaces'
import { createGoogleDriveComponent, getPublicDriveDownloadUrl } from '../../src/adapters/google-drive'
import type { IGoogleDriveComponent } from '../../src/adapters/google-drive'

function createMockConfig(allowedIds: string) {
  return {
    getString: async (key: string) => {
      if (key === 'DRIVE_VIDEO_ALLOWED_FILE_IDS') return allowedIds
      return undefined
    },
    getNumber: async () => undefined,
    requireString: async (key: string) => key,
    requireNumber: async (key: string) => parseInt(key, 10)
  }
}

function createMockFetcher(): IFetchComponent {
  return { fetch: async () => new Response() } as unknown as IFetchComponent
}

describe('when using the google drive component', () => {
  let googleDrive: IGoogleDriveComponent

  describe('and the allowlist has configured file IDs', () => {
    beforeEach(async () => {
      googleDrive = await createGoogleDriveComponent({
        config: createMockConfig('file-a, file-b'),
        fetcher: createMockFetcher()
      })
    })

    describe('when validating a file ID format', () => {
      it('should accept alphanumeric characters with hyphens and underscores', () => {
        expect(googleDrive.isValidFileId('abc123-_XYZ')).toBe(true)
      })

      it('should reject an empty string', () => {
        expect(googleDrive.isValidFileId('')).toBe(false)
      })

      it('should reject path traversal characters', () => {
        expect(googleDrive.isValidFileId('../etc/passwd')).toBe(false)
        expect(googleDrive.isValidFileId('file/id')).toBe(false)
      })

      it('should reject special characters like angle brackets and spaces', () => {
        expect(googleDrive.isValidFileId('id<script>')).toBe(false)
        expect(googleDrive.isValidFileId('id with spaces')).toBe(false)
      })
    })

    describe('when checking if a file is allowed', () => {
      it('should return true for a file in the allowlist', () => {
        expect(googleDrive.isFileAllowed('file-a')).toBe(true)
      })

      it('should return false for a file not in the allowlist', () => {
        expect(googleDrive.isFileAllowed('file-c')).toBe(false)
      })
    })
  })

  describe('and the allowlist is empty (default-deny)', () => {
    beforeEach(async () => {
      googleDrive = await createGoogleDriveComponent({
        config: createMockConfig(''),
        fetcher: createMockFetcher()
      })
    })

    it('should deny all files', () => {
      expect(googleDrive.isFileAllowed('any-id')).toBe(false)
    })
  })

  describe('when building a public Drive download URL', () => {
    it('should encode the file ID and include the export parameter', () => {
      const url = getPublicDriveDownloadUrl('abc-123')
      expect(url).toContain('id=abc-123')
      expect(url).toContain('export=download')
    })
  })
})
