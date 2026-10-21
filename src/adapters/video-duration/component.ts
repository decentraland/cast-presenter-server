import { execFile } from 'child_process'
import { drainResponse } from '../../logic/fetch-utils'
import type { IVideoDurationComponent } from './types'
import type { ClientVideo } from '../../logic/client-video'
import type { AppComponents } from '../../types'

type UnknownReason = 'status' | 'live' | 'timeout' | 'network' | 'parse' | 'ffprobe-exit' | 'unexpected'

class DurationUnknownError extends Error {
  constructor(readonly reason: UnknownReason) {
    super(`Video duration unknown: ${reason}`)
  }
}

const CACHE_SIZE = 256
const FAILURE_RETRY_MS = 60_000
const MAX_CONCURRENT_PROBES = 2
const MAX_DURATION_MS = 24 * 60 * 60 * 1000
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const INNERTUBE_TIMEOUT_MS = 5000
const INNERTUBE_CLIENT_VERSION = '1.65.10'
const INNERTUBE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': `com.google.android.apps.youtube.vr.oculus/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip`,
  'X-YouTube-Client-Name': '28',
  'X-YouTube-Client-Version': INNERTUBE_CLIENT_VERSION,
  Origin: 'https://www.youtube.com',
  Referer: 'https://www.youtube.com/',
  'Accept-Language': 'en-US,en;q=0.9'
}
const INNERTUBE_CLIENT = {
  clientName: 'ANDROID_VR',
  clientVersion: INNERTUBE_CLIENT_VERSION,
  deviceMake: 'Oculus',
  deviceModel: 'Quest 3',
  osName: 'Android',
  osVersion: '12L',
  platform: 'MOBILE',
  hl: 'en',
  gl: 'US',
  utcOffsetMinutes: 0
}
const LENGTH_SECONDS = /^\d+$/
const DRIVE_DOWNLOAD_URL = 'https://drive.usercontent.google.com/download'
const DRIVE_PROTOCOLS = 'https,tls,tcp'
const DRIVE_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm'
const VIMEO_HLS_PROTOCOLS = 'hls,https,tls,tcp,crypto'
const FFPROBE_OPTIONS = { timeout: 15000, maxBuffer: 65536 }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function lengthMsFromPlayer(body: unknown): number {
  if (!isRecord(body)) throw new DurationUnknownError('parse')
  const { playabilityStatus, videoDetails } = body
  if (!isRecord(playabilityStatus) || playabilityStatus.status !== 'OK') throw new DurationUnknownError('status')
  if (!isRecord(videoDetails)) throw new DurationUnknownError('parse')
  if (videoDetails.isLive === true || videoDetails.isLiveContent === true) throw new DurationUnknownError('live')
  const { lengthSeconds } = videoDetails
  if (typeof lengthSeconds !== 'string' || !LENGTH_SECONDS.test(lengthSeconds) || Number(lengthSeconds) <= 0) {
    throw new DurationUnknownError('parse')
  }
  return Number(lengthSeconds) * 1000
}

function probeDurationMs(url: string, protocols: string, extraArgs: string[]): Promise<number> {
  const args = [
    '-v',
    'error',
    '-rw_timeout',
    '10000000',
    '-protocol_whitelist',
    protocols,
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    ...extraArgs,
    url
  ]
  return new Promise((resolve, reject) => {
    execFile('ffprobe', args, FFPROBE_OPTIONS, (error, stdout) => {
      if (error) {
        const overflowed = 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        reject(new DurationUnknownError(overflowed ? 'parse' : error.killed ? 'timeout' : 'ffprobe-exit'))
        return
      }
      const seconds = Number(stdout.trim())
      if (Number.isFinite(seconds) && seconds > 0) resolve(Math.round(seconds * 1000))
      else reject(new DurationUnknownError('parse'))
    })
  })
}

/**
 * Creates the video duration component.
 *
 * Flow per lookup:
 * 1. Return a cached duration (keyed by canonical URL, capped at 256 entries), `null` for a URL whose
 *    lookup failed less than a minute ago, or join the in-flight lookup for the same URL.
 * 2. Ask the provider: one InnerTube `player` request for YouTube, ffprobe for Drive and Vimeo HLS, with
 *    at most two ffprobe processes at a time process-wide.
 * 3. Resolve `null` and log the reason on any failure or a duration over 24 hours; the URL is retried
 *    once a minute has passed.
 *
 * @param components - Required: fetcher (InnerTube request), logs
 * @returns The video duration component
 */
export async function createVideoDurationComponent(
  components: Pick<AppComponents, 'fetcher' | 'logs'>
): Promise<IVideoDurationComponent> {
  const { fetcher, logs } = components
  const logger = logs.getLogger('video-duration')
  const durations = new Map<string, number>()
  const failedAt = new Map<string, number>()
  const inFlight = new Map<string, Promise<number | null>>()
  const probeQueue: Array<() => void> = []
  let runningProbes = 0

  async function withProbeSlot<T>(probe: () => Promise<T>): Promise<T> {
    if (runningProbes < MAX_CONCURRENT_PROBES) runningProbes++
    else await new Promise<void>((resolve) => probeQueue.push(resolve))
    try {
      return await probe()
    } finally {
      const next = probeQueue.shift()
      if (next) next()
      else runningProbes--
    }
  }

  async function fetchPlayer(videoId: string, abortController: AbortController): Promise<unknown> {
    let response: Response
    try {
      response = await fetcher.fetch(INNERTUBE_PLAYER_URL, {
        method: 'POST',
        headers: INNERTUBE_HEADERS,
        body: JSON.stringify({ videoId, contentCheckOk: true, context: { client: INNERTUBE_CLIENT } }),
        abortController
      })
    } catch {
      throw new DurationUnknownError(abortController.signal.aborted ? 'timeout' : 'network')
    }
    if (!response.ok) {
      await drainResponse(response)
      throw new DurationUnknownError('status')
    }
    try {
      return await response.json()
    } catch {
      throw new DurationUnknownError(abortController.signal.aborted ? 'timeout' : 'parse')
    }
  }

  async function youtubeDurationMs(videoId: string): Promise<number> {
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), INNERTUBE_TIMEOUT_MS)
    try {
      return lengthMsFromPlayer(await fetchPlayer(videoId, abortController))
    } finally {
      clearTimeout(timer)
    }
  }

  function providerDurationMs(video: ClientVideo): Promise<number> {
    switch (video.provider) {
      case 'youtube':
        return youtubeDurationMs(video.id)
      case 'drive': {
        const query = new URLSearchParams({ id: video.id, export: 'download', confirm: 't' })
        return withProbeSlot(() =>
          probeDurationMs(`${DRIVE_DOWNLOAD_URL}?${query}`, DRIVE_PROTOCOLS, ['-format_whitelist', DRIVE_FORMATS])
        )
      }
      case 'vimeo-hls':
        return withProbeSlot(() => probeDurationMs(video.url, VIMEO_HLS_PROTOCOLS, []))
    }
  }

  function setCapped<V>(entries: Map<string, V>, url: string, value: V): void {
    entries.delete(url)
    entries.set(url, value)
    if (entries.size > CACHE_SIZE) {
      const [oldest] = entries.keys()
      entries.delete(oldest)
    }
  }

  async function lookup(video: ClientVideo): Promise<number | null> {
    try {
      const durationMs = await providerDurationMs(video)
      if (durationMs > MAX_DURATION_MS) throw new DurationUnknownError('parse')
      failedAt.delete(video.url)
      setCapped(durations, video.url, durationMs)
      return durationMs
    } catch (error) {
      const reason = error instanceof DurationUnknownError ? error.reason : 'unexpected'
      logger.info('Video duration unknown', { provider: video.provider, reason })
      setCapped(failedAt, video.url, Date.now())
      return null
    }
  }

  return {
    async getDurationMs(video: ClientVideo): Promise<number | null> {
      const cached = durations.get(video.url)
      if (cached !== undefined) return cached
      const lastFailure = failedAt.get(video.url)
      if (lastFailure !== undefined && Date.now() - lastFailure < FAILURE_RETRY_MS) return null
      const pending = inFlight.get(video.url)
      if (pending) return pending
      const next = lookup(video).finally(() => inFlight.delete(video.url))
      inFlight.set(video.url, next)
      return next
    }
  }
}
