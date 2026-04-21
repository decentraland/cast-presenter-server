import { Readable } from 'stream'
import { FileNotFoundError } from '../../src/adapters/google-drive'
import { driveVideoHandler } from '../../src/controllers/handlers/drive-video-handler'
import { createMockLogger } from '../mocks/context'

function createMockGoogleDrive(overrides?: { allowedIds?: string; streamError?: Error; contentType?: string }) {
  const { allowedIds = 'valid-id', streamError, contentType = 'video/mp4' } = overrides ?? {}

  return {
    isValidFileId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
    isFileAllowed: (id: string) => {
      if (!allowedIds) return false
      return allowedIds
        .split(',')
        .map((s) => s.trim())
        .includes(id)
    },
    streamFile: jest.fn().mockImplementation(async () => {
      if (streamError) throw streamError
      const stream = new Readable()
      stream.push(Buffer.from('video-data'))
      stream.push(null)
      return {
        stream,
        contentLength: 1024,
        contentRange: undefined,
        contentType
      }
    })
  }
}

function createMockContext(overrides?: {
  fileId?: string | null
  allowedIds?: string
  corsOrigin?: string
  rangeHeader?: string | null
  streamError?: Error
  contentType?: string
}) {
  const {
    fileId = 'valid-id',
    allowedIds = 'valid-id',
    corsOrigin = '',
    rangeHeader = null,
    streamError,
    contentType
  } = overrides ?? {}

  const url = new URL('http://localhost/api/drive-video')
  if (fileId !== null) url.searchParams.set('fileId', fileId)

  return {
    url,
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'Range') return rangeHeader
          return null
        }
      }
    },
    components: {
      config: {
        getString: async (key: string) => {
          if (key === 'DRIVE_VIDEO_CORS_ORIGIN') return corsOrigin
          return undefined
        },
        getNumber: async () => undefined,
        requireString: async (key: string) => key,
        requireNumber: async (key: string) => parseInt(key, 10)
      },
      googleDrive: createMockGoogleDrive({ allowedIds, streamError, contentType }),
      logs: createMockLogger()
    }
  } as unknown as Parameters<typeof driveVideoHandler>[0]
}

describe('when handling a drive video proxy request', () => {
  let result: { status: number; headers: Record<string, string>; body?: unknown }

  describe('and no fileId is provided', () => {
    beforeEach(async () => {
      const ctx = createMockContext({ fileId: null })
      ctx.url.searchParams.delete('fileId')
      result = await driveVideoHandler(ctx)
    })

    it('should return status 400', () => {
      expect(result.status).toBe(400)
    })
  })

  describe('and the fileId contains invalid characters', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ fileId: '../etc/passwd' }))
    })

    it('should return status 400', () => {
      expect(result.status).toBe(400)
    })
  })

  describe('and the allowlist is empty (default-deny)', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ allowedIds: '' }))
    })

    it('should return status 403', () => {
      expect(result.status).toBe(403)
    })
  })

  describe('and the file is not in the allowlist', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ fileId: 'not-allowed', allowedIds: 'other-id' }))
    })

    it('should return status 403', () => {
      expect(result.status).toBe(403)
    })
  })

  describe('and the file is allowed and accessible', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({}))
    })

    it('should return status 200', () => {
      expect(result.status).toBe(200)
    })

    it('should set Content-Type to video/mp4', () => {
      expect(result.headers['Content-Type']).toBe('video/mp4')
    })

    it('should include Accept-Ranges header', () => {
      expect(result.headers['Accept-Ranges']).toBe('bytes')
    })
  })

  describe('and a CORS origin is configured', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ corsOrigin: 'https://cast2.decentraland.org' }))
    })

    it('should include the configured Access-Control-Allow-Origin header', () => {
      expect(result.headers['Access-Control-Allow-Origin']).toBe('https://cast2.decentraland.org')
    })
  })

  describe('and Drive returns a file not found error', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ streamError: new FileNotFoundError('test-id') }))
    })

    it('should return status 404', () => {
      expect(result.status).toBe(404)
    })
  })

  describe('and Drive returns a Content-Type with CRLF injection attempt', () => {
    beforeEach(async () => {
      result = await driveVideoHandler(createMockContext({ contentType: 'video/mp4\r\nX-Injected: evil\r\n\0junk' }))
    })

    it('should strip CR/LF/NUL bytes from the Content-Type header', () => {
      expect(result.headers['Content-Type']).toBe('video/mp4X-Injected: eviljunk')
      expect(result.headers['Content-Type']).not.toMatch(/[\r\n\0]/)
    })
  })
})
