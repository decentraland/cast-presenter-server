import { Readable } from 'stream'
import { driveVideoHandler } from '../../src/controllers/handlers/drive-video-handler'

function mockContext(overrides: {
  fileId?: string | null
  allowedIds?: string
  corsOrigin?: string
  rangeHeader?: string | null
  fetchResponse?: { ok: boolean; status: number; headers: Record<string, string | null>; body: Readable | null }
}) {
  const { fileId = 'valid-id', allowedIds = 'valid-id', corsOrigin = '', rangeHeader = null, fetchResponse } = overrides

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
          if (key === 'DRIVE_VIDEO_ALLOWED_FILE_IDS') return allowedIds
          if (key === 'DRIVE_VIDEO_CORS_ORIGIN') return corsOrigin
          return undefined
        }
      },
      fetcher: {
        fetch: async (_url: string, _init?: any) => {
          if (fetchResponse) return fetchResponse
          const stream = new Readable()
          stream.push(Buffer.from('video-data'))
          stream.push(null)
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) => {
                if (name === 'content-type') return 'video/mp4'
                if (name === 'content-length') return '1024'
                return null
              }
            },
            body: stream
          }
        }
      },
      logs: {
        getLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          log: () => {}
        })
      }
    }
  } as any
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
    const ctx = mockContext({
      fetchResponse: {
        ok: false,
        status: 404,
        headers: { 'content-type': null },
        body: null
      }
    })
    const res = await driveVideoHandler(ctx)
    expect(res.status).toBe(404)
  })
})
