import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { setTimeout as delay } from 'timers/promises'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { errorMessage } from '../../logic/error-message'
import {
  decodePresentationPacket,
  encodePresentationPacket,
  parsePresentersFromRoomMetadata
} from '../livekit-publisher/comms'
import type { ISidecarPublisher, ISidecarPublisherComponent, PlaybackFiles } from './types'
import type { AppComponents } from '../../types'
import type { ChildProcessByStdio } from 'child_process'
import type { Readable, Writable } from 'stream'

const INIT_ID = 0
const DEFAULT_BINARY_PATH = '/usr/local/bin/cast-sidecar'
const CONNECT_TIMEOUT_MS = 25_000
const RPC_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 3_000

type SidecarProcess = ChildProcessByStdio<Writable, Readable, Readable>

interface SidecarEvent {
  type: string
  id?: number
  code?: string
  message?: string
  roomMetadata?: string
  metadata?: string
  identity?: string
  payloadBase64?: string
  count?: number
  participantCount?: number
  reason?: string
}

interface PendingCommand {
  resolve(): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

function redact(text: string): string {
  return text.replace(/access_token=[^&\s]+/g, 'access_token=REDACTED')
}

function parseEvent(line: string): SidecarEvent | null {
  try {
    const parsed: unknown = JSON.parse(line)
    return isSidecarEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isSidecarEvent(value: unknown): value is SidecarEvent {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}

function createPublisher(
  binaryPath: string,
  presentationId: string,
  logger: ILoggerComponent.ILogger
): ISidecarPublisher {
  let child: SidecarProcess | null = null
  let running = false
  let ready = false
  let shutdownDone: Promise<void> | null = null
  let exited: Promise<void> = Promise.resolve()
  let nextId = 1
  const pending = new Map<number, PendingCommand>()
  let presenters: Set<string> = new Set()
  let participantCount = 0
  let lastSceneId = ''
  let dataHandler: ((data: Record<string, unknown>, senderIdentity: string) => void) | null = null
  let playbackEndedCallback: (() => void) | null = null
  let playbackFailedCallback: ((message: string) => void) | null = null
  let fatalCallback: ((reason: string) => void) | null = null
  let fatalFired = false

  function write(command: Record<string, unknown>): void {
    child?.stdin.write(`${JSON.stringify(command)}\n`)
  }

  function track(id: number, timeoutMs: number, onTimeout: (fail: (err: Error) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        onTimeout(reject)
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
    })
  }

  function rpc(command: { type: string } & Record<string, unknown>, timeoutMs = RPC_TIMEOUT_MS): Promise<void> {
    if (!running) return Promise.reject(new Error('Sidecar not running'))
    const id = nextId++
    const acked = track(id, timeoutMs, (fail) => fail(new Error(`Sidecar ${command.type} timed out`)))
    write({ ...command, id })
    return acked
  }

  function settle(id: number, err: Error | null): void {
    const command = pending.get(id)
    if (!command) return
    pending.delete(id)
    clearTimeout(command.timer)
    if (err) command.reject(err)
    else command.resolve()
  }

  function connectError(reason: string): Error {
    return new Error(`LiveKit connect failed: ${redact(reason)}`)
  }

  function fireFatal(reason: string): void {
    if (fatalFired || shutdownDone !== null) return
    fatalFired = true
    fatalCallback?.(reason)
  }

  function onExit(reason: string): void {
    if (!running) return
    running = false
    participantCount = 0
    for (const [id, command] of pending) {
      clearTimeout(command.timer)
      command.reject(id === INIT_ID ? connectError(reason) : new Error(reason))
    }
    pending.clear()
    if (shutdownDone === null) logger.warn('Sidecar exited', { presentationId, reason })
    if (ready) fireFatal(reason)
  }

  function handleData(event: SidecarEvent): void {
    const identity = event.identity || 'unknown'
    const decoded = decodePresentationPacket(Buffer.from(event.payloadBase64 ?? '', 'base64'))
    if (!decoded) return
    const { message, sceneId } = decoded
    const msgType = typeof message.type === 'string' ? message.type : ''
    if (!dataHandler || !msgType.startsWith('presentation:')) return
    if (!presenters.has(identity.toLowerCase())) {
      logger.warn(`[dataReceived] Identity '${identity}' not in presenters list, ignoring ${msgType}`)
      return
    }
    if (sceneId) lastSceneId = sceneId
    dataHandler(message, identity)
  }

  function handleEvent(event: SidecarEvent): void {
    if ((event.type === 'ack' || event.type === 'error') && typeof event.id === 'number' && event.id > 0) {
      settle(event.id, event.type === 'error' ? new Error(redact(event.message ?? 'Sidecar error')) : null)
      return
    }
    switch (event.type) {
      case 'ready':
        presenters = parsePresentersFromRoomMetadata(event.roomMetadata)
        participantCount = event.participantCount ?? 0
        ready = true
        logger.info(`[connect] Initial presenters: ${[...presenters].join(', ') || 'none'}`)
        settle(INIT_ID, null)
        return
      case 'error':
        if (!ready) {
          settle(INIT_ID, connectError(event.message ?? event.code ?? 'unknown error'))
        } else if (event.code === 'playback-failed') {
          playbackFailedCallback?.(redact(event.message ?? 'playback failed'))
        } else {
          logger.warn('Sidecar error', { code: event.code ?? '', message: redact(event.message ?? '') })
        }
        return
      case 'dataReceived':
        handleData(event)
        return
      case 'roomMetadata':
        presenters = parsePresentersFromRoomMetadata(event.metadata)
        return
      case 'participantCount':
        if (typeof event.count === 'number') participantCount = event.count
        return
      case 'playbackEnded':
        playbackEndedCallback?.()
        return
      case 'disconnected':
        fireFatal(`Room disconnected: ${event.reason ?? 'unknown'}`)
        return
      default:
        logger.debug(`[sidecar] ignoring event ${event.type}`)
    }
  }

  async function shutdown(): Promise<void> {
    const proc = child
    if (!proc || !running) return
    try {
      await rpc({ type: 'shutdown' }, SHUTDOWN_TIMEOUT_MS)
    } catch (err) {
      logger.warn('Sidecar shutdown failed', { presentationId, error: redact(errorMessage(err)) })
    }
    if (!(await Promise.race([exited.then(() => true), delay(EXIT_TIMEOUT_MS, false, { ref: false })]))) {
      logger.warn('Sidecar did not exit after shutdown, killing it', { presentationId })
      proc.kill('SIGKILL')
    }
  }

  return {
    async connect(url: string, token: string): Promise<void> {
      const proc = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      child = proc
      running = true
      exited = new Promise<void>((resolve) => {
        proc.on('exit', (code, signal) => {
          onExit(`Sidecar exited (code=${code}, signal=${signal})`)
          resolve()
        })
        proc.on('error', (err) => {
          logger.warn('Sidecar process error', { presentationId, error: redact(err.message) })
          if (proc.pid !== undefined) return
          onExit(`Sidecar failed to start: ${redact(err.message)}`)
          resolve()
        })
      })
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        stream.on('error', (err) => logger.warn('Sidecar stream error', { presentationId, error: err.message }))
      }
      createInterface({ input: proc.stdout }).on('line', (line) => {
        const event = parseEvent(line)
        if (event) handleEvent(event)
        else logger.warn('Skipping malformed sidecar line', { presentationId, length: line.length })
      })
      createInterface({ input: proc.stderr }).on('line', (line) => logger.debug(`[sidecar] ${redact(line)}`))

      const connected = track(INIT_ID, CONNECT_TIMEOUT_MS, (fail) => {
        fail(connectError(`sidecar not ready after ${CONNECT_TIMEOUT_MS / 1000}s`))
        proc.kill('SIGKILL')
      })
      write({ type: 'init', url, token, presentationId })
      await connected
    },

    startPublishing: async () => undefined,
    pushFrame: () => undefined,
    startHeartbeat: () => undefined,
    stopHeartbeat: () => undefined,
    startAudioPublishing: async () => undefined,
    pushAudioFrame: () => undefined,
    stopAudioPublishing: async () => undefined,

    setDataHandler(handler: (data: Record<string, unknown>, senderIdentity: string) => void): void {
      dataHandler = handler
    },

    async updateMetadataState(state: object): Promise<void> {
      await rpc({
        type: 'updateMetadata',
        metadata: JSON.stringify({ role: 'presentation', presentationId, ...state })
      })
    },

    async publishData(message: Record<string, unknown>): Promise<void> {
      const payloadBase64 = Buffer.from(encodePresentationPacket(message, lastSceneId)).toString('base64')
      await rpc({ type: 'publishData', payloadBase64 })
    },

    getRemoteParticipantCount(): number {
      return running ? participantCount : 0
    },

    play(files: PlaybackFiles): Promise<void> {
      return rpc({ type: 'play', videoPath: files.videoPath, audioPath: files.audioPath })
    },

    pause(): Promise<void> {
      return rpc({ type: 'pause' })
    },

    resume(): Promise<void> {
      return rpc({ type: 'resume' })
    },

    stopVideo(): Promise<void> {
      return rpc({ type: 'stop' })
    },

    onPlaybackEnded(cb: () => void): void {
      playbackEndedCallback = cb
    },

    onPlaybackFailed(cb: (message: string) => void): void {
      playbackFailedCallback = cb
    },

    onFatal(cb: (reason: string) => void): void {
      fatalCallback = cb
    },

    disconnect(): Promise<void> {
      return (shutdownDone ??= shutdown())
    }
  }
}

/**
 * Creates the factory of per-session publishers backed by the Go `cast-sidecar` process.
 *
 * Each publisher spawns the binary on `connect`, sends `init` (the token travels only on stdin),
 * resolves on `ready`, and then speaks the JSON-lines IPC: one `ack` or `error` per command id,
 * plus unsolicited room and playback events.
 *
 * @param components - `config`, read once for `SIDECAR_BINARY_PATH` (default `/usr/local/bin/cast-sidecar`).
 * @returns the sidecar publisher component.
 */
export async function createSidecarPublisherComponent(
  components: Pick<AppComponents, 'config'>
): Promise<ISidecarPublisherComponent> {
  const binaryPath = (await components.config.getString('SIDECAR_BINARY_PATH')) || DEFAULT_BINARY_PATH
  return {
    createPublisher: (presentationId, logger) => createPublisher(binaryPath, presentationId, logger)
  }
}
