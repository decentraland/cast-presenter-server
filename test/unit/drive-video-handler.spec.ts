import { Readable } from 'stream'
import { driveVideoHandler } from '../../src/controllers/handlers/drive-video-handler'
import { createMockLogger } from '../mocks/context'

function mockContext(overrides: {
  fileId?: string | null
  allowedIds?: string
  corsOrigin?: string
  rangeHeader?: string | null
  streamError?: Error
}) {
  const { fileId = 'valid-id', allowedIds = 'valid-id', corsOrigin = '', rangeHeader = null, streamError } = overrides

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
      googleDrive: {
        isValidFileId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id),
        isFileAllowed: (id: string) => {
          if (!allowedIds) return false
          return allowedIds
            .split(',')
            .map((s) => s.trim())
            .includes(id)
        },
        streamFile: async () => {
          if (streamError) throw streamError
          const stream = new Readable()
          stream.push(Buffer.from('video-data'))
          stream.push(null)
          return {
            stream,
            contentLength: 1024,
            contentRange: undefined,
            contentType: 'video/mp4'
          }
        },
        isVideoMime: (mime: string) => mime.startsWith('video/')
      },
      logs: createMockLogger()
    }
  } as unknown as Parameters<typeof driveVideoHandler>[0]
}

describe('drive-video-handler', () => {
  it('returns 400 for missing fileId', async () => {
    const ctx = mockContext({ fileId: null })
    ctx.url.searchParams.delete('fileId')
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid fileId characters', async () => {
    const ctx = mockContext({ fileId: '../etc/passwd' })
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 403 when allowlist is empty (default-deny)', async () => {
    const ctx = mockContext({ allowedIds: '' })
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(403)
  })

  it('returns 403 when file is not in allowlist', async () => {
    const ctx = mockContext({ fileId: 'not-allowed', allowedIds: 'other-id' })
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(403)
  })

  it('returns 200 with stream for allowed file', async () => {
    const ctx = mockContext({})
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(200)
    expect(res.headers['Content-Type']).toBe('video/mp4')
    expect(res.headers['Accept-Ranges']).toBe('bytes')
  })

  it('includes CORS headers when configured', async () => {
    const ctx = mockContext({ corsOrigin: 'https://cast2.decentraland.org' })
    const res = await driveVideoHandler(ctx)
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://cast2.decentraland.org')
  })

  it('returns 404 when Drive returns not found', async () => {
    const { FileNotFoundError } = await import('../../src/adapters/google-drive')
    const ctx = mockContext({ streamError: new FileNotFoundError('test-id') })
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(404)
  })
})
