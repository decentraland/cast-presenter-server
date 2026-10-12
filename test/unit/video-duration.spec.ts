import { execFile } from 'child_process'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { IFetchComponent } from '@dcl/core-commons'
import { createVideoDurationComponent } from '../../src/adapters/video-duration'
import { createLoggerMock } from '../mocks/context'
import type { IVideoDurationComponent } from '../../src/adapters/video-duration'
import type { ClientVideo } from '../../src/logic/client-video'

jest.mock('child_process')

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

const execFileMock = execFile as unknown as jest.Mock
const YOUTUBE_VIDEO: ClientVideo = {
  provider: 'youtube',
  id: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
}
const DRIVE_VIDEO: ClientVideo = {
  provider: 'drive',
  id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  url: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view'
}
const VIMEO_VIDEO: ClientVideo = {
  provider: 'vimeo-hls',
  id: '123',
  url: 'https://player.vimeo.com/external/123.m3u8?s=abc'
}

function playerResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function okPlayerBody(lengthSeconds: string): unknown {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId: 'dQw4w9WgXcQ', lengthSeconds, isLive: false, isLiveContent: false }
  }
}

function mockFfprobe(error: Error | null, stdout: string): void {
  execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
    callback(error, stdout, '')
    return {}
  })
}

function ffprobeArgs(): string[] {
  return execFileMock.mock.calls[0][1]
}

describe('when resolving a client video duration', () => {
  let fetcher: jest.Mocked<IFetchComponent>
  let logger: jest.Mocked<ILoggerComponent.ILogger>
  let videoDuration: IVideoDurationComponent
  let result: number | null

  beforeEach(async () => {
    fetcher = { fetch: jest.fn() }
    logger = createLoggerMock()
    videoDuration = await createVideoDurationComponent({ fetcher, logs: { getLogger: () => logger } })
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the video is on YouTube', () => {
    describe('and InnerTube answers OK with a length', () => {
      beforeEach(async () => {
        fetcher.fetch.mockImplementation(async () => playerResponse(okPlayerBody('212')))
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve the length in milliseconds', () => {
        expect(result).toBe(212000)
      })

      it('should POST to the InnerTube player endpoint with the ANDROID_VR headers', () => {
        expect(fetcher.fetch).toHaveBeenCalledWith(
          'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
          expect.objectContaining({
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent':
                'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
              'X-YouTube-Client-Name': '28',
              'X-YouTube-Client-Version': '1.65.10',
              Origin: 'https://www.youtube.com',
              Referer: 'https://www.youtube.com/',
              'Accept-Language': 'en-US,en;q=0.9'
            }
          })
        )
      })

      it('should send the video id and the ANDROID_VR client context in order', () => {
        const body = JSON.parse(String(fetcher.fetch.mock.calls[0][1]?.body))
        expect({ keys: Object.keys(body), clientKeys: Object.keys(body.context.client), body }).toEqual({
          keys: ['videoId', 'contentCheckOk', 'context'],
          clientKeys: [
            'clientName',
            'clientVersion',
            'deviceMake',
            'deviceModel',
            'osName',
            'osVersion',
            'platform',
            'hl',
            'gl',
            'utcOffsetMinutes'
          ],
          body: {
            videoId: 'dQw4w9WgXcQ',
            contentCheckOk: true,
            context: {
              client: {
                clientName: 'ANDROID_VR',
                clientVersion: '1.65.10',
                deviceMake: 'Oculus',
                deviceModel: 'Quest 3',
                osName: 'Android',
                osVersion: '12L',
                platform: 'MOBILE',
                hl: 'en',
                gl: 'US',
                utcOffsetMinutes: 0
              }
            }
          }
        })
      })
    })

    describe('and InnerTube answers LOGIN_REQUIRED', () => {
      beforeEach(async () => {
        fetcher.fetch.mockResolvedValueOnce(
          playerResponse({ playabilityStatus: { status: 'LOGIN_REQUIRED' }, videoDetails: { lengthSeconds: '212' } })
        )
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })

      it('should log that the duration is unknown with the provider and a short reason', () => {
        expect(logger.info).toHaveBeenCalledWith('Video duration unknown', { provider: 'youtube', reason: 'status' })
      })
    })

    describe('and the video is live', () => {
      beforeEach(async () => {
        fetcher.fetch.mockResolvedValueOnce(
          playerResponse({
            playabilityStatus: { status: 'OK' },
            videoDetails: { lengthSeconds: '0', isLive: true, isLiveContent: true }
          })
        )
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })

    describe('and the length is zero', () => {
      beforeEach(async () => {
        fetcher.fetch.mockResolvedValueOnce(playerResponse(okPlayerBody('0')))
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })

    describe('and the response is not JSON', () => {
      beforeEach(async () => {
        fetcher.fetch.mockResolvedValueOnce(new Response('<html></html>', { status: 200 }))
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })

    describe('and InnerTube answers a non-2xx status', () => {
      beforeEach(async () => {
        fetcher.fetch.mockResolvedValueOnce(playerResponse(okPlayerBody('212'), 429))
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })

    describe('and the request throws', () => {
      beforeEach(async () => {
        fetcher.fetch.mockRejectedValueOnce(new Error('socket hang up'))
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })

    describe('and the duration was already resolved', () => {
      beforeEach(async () => {
        fetcher.fetch.mockImplementation(async () => playerResponse(okPlayerBody('212')))
        await videoDuration.getDurationMs(YOUTUBE_VIDEO)
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should resolve the cached duration without a new request', () => {
        expect({ result, calls: fetcher.fetch.mock.calls.length }).toEqual({ result: 212000, calls: 1 })
      })
    })

    describe('and two lookups run concurrently', () => {
      let results: Array<number | null>

      beforeEach(async () => {
        fetcher.fetch.mockImplementation(async () => playerResponse(okPlayerBody('212')))
        results = await Promise.all([
          videoDuration.getDurationMs(YOUTUBE_VIDEO),
          videoDuration.getDurationMs(YOUTUBE_VIDEO)
        ])
      })

      it('should share one request between both lookups', () => {
        expect({ results, calls: fetcher.fetch.mock.calls.length }).toEqual({ results: [212000, 212000], calls: 1 })
      })
    })

    describe('and a previous lookup resolved null', () => {
      beforeEach(async () => {
        fetcher.fetch
          .mockRejectedValueOnce(new Error('socket hang up'))
          .mockResolvedValueOnce(playerResponse(okPlayerBody('212')))
        await videoDuration.getDurationMs(YOUTUBE_VIDEO)
        result = await videoDuration.getDurationMs(YOUTUBE_VIDEO)
      })

      it('should retry the lookup and resolve the duration', () => {
        expect({ result, calls: fetcher.fetch.mock.calls.length }).toEqual({ result: 212000, calls: 2 })
      })
    })
  })

  describe('and the video is on Google Drive', () => {
    describe('and ffprobe prints a duration', () => {
      beforeEach(async () => {
        mockFfprobe(null, '61.44\n')
        result = await videoDuration.getDurationMs(DRIVE_VIDEO)
      })

      it('should resolve the rounded duration in milliseconds', () => {
        expect(result).toBe(61440)
      })

      it('should probe the usercontent download URL restricted to https and video containers', () => {
        expect(ffprobeArgs()).toEqual([
          '-v',
          'error',
          '-rw_timeout',
          '10000000',
          '-protocol_whitelist',
          'https,tls,tcp',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          '-format_whitelist',
          'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm',
          'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUvWxYz012345&export=download&confirm=t'
        ])
      })

      it('should run ffprobe with a timeout and a capped output buffer', () => {
        expect(execFileMock).toHaveBeenCalledWith(
          'ffprobe',
          expect.any(Array),
          { timeout: 15000, maxBuffer: 65536 },
          expect.any(Function)
        )
      })

      it('should not call the fetcher', () => {
        expect(fetcher.fetch).not.toHaveBeenCalled()
      })
    })

    describe('and ffprobe fails', () => {
      beforeEach(async () => {
        mockFfprobe(new Error('Command failed: ffprobe'), '')
        result = await videoDuration.getDurationMs(DRIVE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })

      it('should log that the duration is unknown with the ffprobe-exit reason', () => {
        expect(logger.info).toHaveBeenCalledWith('Video duration unknown', {
          provider: 'drive',
          reason: 'ffprobe-exit'
        })
      })
    })

    describe('and ffprobe prints no duration', () => {
      beforeEach(async () => {
        mockFfprobe(null, 'N/A\n')
        result = await videoDuration.getDurationMs(DRIVE_VIDEO)
      })

      it('should resolve null', () => {
        expect(result).toBeNull()
      })
    })
  })

  describe('and the video is a Vimeo HLS playlist', () => {
    beforeEach(async () => {
      mockFfprobe(null, '30.5\n')
      result = await videoDuration.getDurationMs(VIMEO_VIDEO)
    })

    it('should resolve the duration in milliseconds', () => {
      expect(result).toBe(30500)
    })

    it('should probe the playlist URL with the HLS protocols and no format whitelist', () => {
      expect(ffprobeArgs()).toEqual([
        '-v',
        'error',
        '-rw_timeout',
        '10000000',
        '-protocol_whitelist',
        'hls,https,tls,tcp,crypto',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        'https://player.vimeo.com/external/123.m3u8?s=abc'
      ])
    })
  })
})
