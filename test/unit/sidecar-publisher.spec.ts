import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { decodePresentationPacket, encodePresentationPacket } from '../../src/adapters/livekit-publisher/comms'
import { createSidecarPublisherComponent } from '../../src/adapters/sidecar-publisher/component'
import type { ISidecarPublisher } from '../../src/adapters/sidecar-publisher/types'
import type { ChildProcess } from 'child_process'

jest.mock('child_process')

const BINARY_PATH = '/opt/cast-sidecar'
const LIVEKIT_URL = 'wss://lk.example.com'
const TOKEN = 'secret-token'
const PRESENTATION_ID = 'p-1'

interface FakeProcess extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: jest.Mock
  lines(): Array<Record<string, unknown>>
}

function createFakeProcess(): FakeProcess {
  let written = ''
  const stdin = new PassThrough()
  stdin.on('data', (chunk: Buffer) => {
    written += chunk.toString()
  })
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
    lines: () =>
      written
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
  })
}

function createLogger(): jest.Mocked<ILoggerComponent.ILogger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    log: jest.fn()
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

function noop(): void {
  return undefined
}

describe('when using the sidecar publisher', () => {
  let fake: FakeProcess
  let logger: jest.Mocked<ILoggerComponent.ILogger>
  let publisher: ISidecarPublisher

  function emit(event: Record<string, unknown>): void {
    fake.stdout.write(`${JSON.stringify(event)}\n`)
  }

  function lastLine(): Record<string, unknown> {
    const lines = fake.lines()
    return lines[lines.length - 1]
  }

  async function ackLast(): Promise<void> {
    await flush()
    emit({ type: 'ack', id: lastLine().id })
    await flush()
  }

  beforeEach(async () => {
    fake = createFakeProcess()
    jest.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess)
    logger = createLogger()
    const component = await createSidecarPublisherComponent({
      config: {
        getString: jest.fn().mockResolvedValue(BINARY_PATH),
        getNumber: jest.fn(),
        requireString: jest.fn(),
        requireNumber: jest.fn()
      }
    })
    publisher = component.createPublisher(PRESENTATION_ID, logger)
  })

  afterEach(() => {
    jest.mocked(spawn).mockReset()
  })

  describe('and it connects and the sidecar answers ready', () => {
    beforeEach(async () => {
      const connecting = publisher.connect(LIVEKIT_URL, TOKEN)
      await flush()
      emit({ type: 'ready', roomMetadata: JSON.stringify({ presenters: ['Presenter-Id'] }), participantCount: 2 })
      await connecting
    })

    it('should spawn the binary with no arguments', () => {
      expect(spawn).toHaveBeenCalledWith(BINARY_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    })

    it('should write init with the token as the first stdin line', () => {
      expect(fake.lines()[0]).toEqual({
        type: 'init',
        url: LIVEKIT_URL,
        token: TOKEN,
        presentationId: PRESENTATION_ID
      })
    })

    it('should report the participant count from ready', () => {
      expect(publisher.getRemoteParticipantCount()).toBe(2)
    })
  })

  describe('and the sidecar answers publish-failed before ready', () => {
    let error: Error

    beforeEach(async () => {
      const connecting = publisher.connect(LIVEKIT_URL, TOKEN)
      await flush()
      emit({ type: 'error', code: 'publish-failed', message: 'x access_token=abc' })
      error = await connecting.then(
        () => new Error('connect resolved'),
        (err: Error) => err
      )
    })

    it('should reject with a LiveKit connect error', () => {
      expect(error.message).toMatch(/^LiveKit connect failed/)
    })

    it('should redact the token from the message', () => {
      expect(error.message).not.toContain('abc')
    })
  })

  describe('and it is connected', () => {
    let dataHandler: jest.Mock

    beforeEach(async () => {
      dataHandler = jest.fn()
      publisher.setDataHandler(dataHandler)
      const connecting = publisher.connect(LIVEKIT_URL, TOKEN)
      await flush()
      emit({ type: 'ready', roomMetadata: JSON.stringify({ presenters: ['Presenter-Id'] }), participantCount: 0 })
      await connecting
    })

    function emitData(identity: string, message: Record<string, unknown>): void {
      emit({
        type: 'dataReceived',
        identity,
        payloadBase64: Buffer.from(encodePresentationPacket(message, 'scene-1')).toString('base64')
      })
    }

    describe('and a presenter sends presentation:navigate', () => {
      beforeEach(async () => {
        emitData('Presenter-Id', { type: 'presentation:navigate', action: 'next' })
        await flush()
      })

      it('should call the data handler with the message and the identity in its original case', () => {
        expect(dataHandler).toHaveBeenCalledWith({ type: 'presentation:navigate', action: 'next' }, 'Presenter-Id')
      })
    })

    describe('and a non-presenter sends presentation:navigate', () => {
      beforeEach(async () => {
        emitData('Stranger', { type: 'presentation:navigate', action: 'next' })
        await flush()
      })

      it('should not call the data handler', () => {
        expect(dataHandler).not.toHaveBeenCalled()
      })
    })

    describe('and a presenter sends a non-presentation message', () => {
      beforeEach(async () => {
        emitData('Presenter-Id', { type: 'chat:message', text: 'hi' })
        await flush()
      })

      it('should not call the data handler', () => {
        expect(dataHandler).not.toHaveBeenCalled()
      })
    })

    describe('and the room metadata adds an identity before it sends data', () => {
      beforeEach(async () => {
        emit({ type: 'roomMetadata', metadata: JSON.stringify({ presenters: ['Presenter-Id', 'New-One'] }) })
        emitData('New-One', { type: 'presentation:video:stop' })
        await flush()
      })

      it('should call the data handler', () => {
        expect(dataHandler).toHaveBeenCalledWith({ type: 'presentation:video:stop' }, 'New-One')
      })
    })

    describe('and it publishes data', () => {
      let line: Record<string, unknown>

      beforeEach(async () => {
        const publishing = publisher.publishData({ type: 'presentation:state' })
        await ackLast()
        await publishing
        line = lastLine()
      })

      it('should write a publishData command', () => {
        expect(line.type).toBe('publishData')
      })

      it('should encode the message so the shared codec decodes it back', () => {
        expect(decodePresentationPacket(Buffer.from(String(line.payloadBase64), 'base64'))?.message).toEqual({
          type: 'presentation:state'
        })
      })
    })

    describe('and it updates the metadata state', () => {
      let line: Record<string, unknown>

      beforeEach(async () => {
        const updating = publisher.updateMetadataState({ currentSlide: 2 })
        await ackLast()
        await updating
        line = lastLine()
      })

      it('should write updateMetadata with the role, presentation id and state', () => {
        expect(JSON.parse(String(line.metadata))).toEqual({
          role: 'presentation',
          presentationId: PRESENTATION_ID,
          currentSlide: 2
        })
      })
    })

    describe('and it plays baked files without audio', () => {
      let line: Record<string, unknown>

      beforeEach(async () => {
        const playing = publisher.play({ videoPath: '/tmp/v.h264', audioPath: null })
        await ackLast()
        await playing
        line = lastLine()
      })

      it('should write a play command with a null audio path', () => {
        expect(line).toEqual({ type: 'play', id: expect.any(Number), videoPath: '/tmp/v.h264', audioPath: null })
      })
    })

    describe('and the sidecar answers an error to a command', () => {
      let playing: Promise<void>

      beforeEach(async () => {
        playing = publisher.play({ videoPath: '/tmp/v.h264', audioPath: '/tmp/a.ogg' })
        playing.catch(noop)
        await flush()
        emit({ type: 'error', id: lastLine().id, code: 'play-failed', message: 'open /tmp/v.h264: no such file' })
        await flush()
      })

      it('should reject with the error message', async () => {
        await expect(playing).rejects.toThrow('open /tmp/v.h264: no such file')
      })
    })

    describe('and the sidecar reports a participant count', () => {
      beforeEach(async () => {
        emit({ type: 'participantCount', count: 3 })
        await flush()
      })

      it('should return it from getRemoteParticipantCount', () => {
        expect(publisher.getRemoteParticipantCount()).toBe(3)
      })
    })

    describe('and a command gets no reply', () => {
      let pausing: Promise<void>

      beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })
        pausing = publisher.pause()
        pausing.catch(noop)
        jest.advanceTimersByTime(10_000)
      })

      afterEach(() => {
        jest.useRealTimers()
      })

      it('should reject with a timeout', async () => {
        await expect(pausing).rejects.toThrow('Sidecar pause timed out')
      })
    })

    describe('and the sidecar reports the natural end of playback', () => {
      let ended: jest.Mock

      beforeEach(async () => {
        ended = jest.fn()
        publisher.onPlaybackEnded(ended)
        emit({ type: 'playbackEnded' })
        await flush()
      })

      it('should call the playback ended callback', () => {
        expect(ended).toHaveBeenCalledTimes(1)
      })
    })

    describe('and the sidecar reports an unsolicited playback failure', () => {
      let failed: jest.Mock

      beforeEach(async () => {
        failed = jest.fn()
        publisher.onPlaybackFailed(failed)
        emit({ type: 'error', code: 'playback-failed', message: 'read v.h264: input/output error' })
        await flush()
      })

      it('should call the playback failed callback with the message', () => {
        expect(failed).toHaveBeenCalledWith('read v.h264: input/output error')
      })
    })

    describe('and the sidecar logs a line containing a token', () => {
      beforeEach(async () => {
        fake.stderr.write('dial wss://lk.example.com/rtc?access_token=abc&auto=1 failed\n')
        await flush()
      })

      it('should log it at debug with the token redacted', () => {
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('access_token=REDACTED&auto=1'))
      })

      it('should never log the token', () => {
        expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('abc')
      })
    })

    describe('and the process exits', () => {
      let fatal: jest.Mock

      beforeEach(async () => {
        fatal = jest.fn()
        publisher.onFatal(fatal)
        fake.emit('exit', 1, null)
        await flush()
      })

      it('should call the fatal callback once', () => {
        expect(fatal).toHaveBeenCalledTimes(1)
      })

      it('should report no remote participants', () => {
        expect(publisher.getRemoteParticipantCount()).toBe(0)
      })

      it('should reject new commands at once', async () => {
        await expect(publisher.resume()).rejects.toThrow('Sidecar not running')
      })

      it('should resolve disconnect at once', async () => {
        await expect(publisher.disconnect()).resolves.toBeUndefined()
      })
    })

    describe('and the room is lost before the process exits', () => {
      let fatal: jest.Mock

      beforeEach(async () => {
        fatal = jest.fn()
        publisher.onFatal(fatal)
        emit({ type: 'disconnected', reason: 'room closed' })
        await flush()
        fake.emit('exit', 1, null)
        await flush()
      })

      it('should call the fatal callback once', () => {
        expect(fatal).toHaveBeenCalledTimes(1)
      })
    })

    describe('and it disconnects', () => {
      let fatal: jest.Mock
      let shutdown: Record<string, unknown>

      beforeEach(async () => {
        fatal = jest.fn()
        publisher.onFatal(fatal)
        const disconnecting = publisher.disconnect()
        await flush()
        shutdown = lastLine()
        emit({ type: 'ack', id: shutdown.id })
        await flush()
        fake.emit('exit', 0, null)
        await disconnecting
      })

      it('should send shutdown', () => {
        expect(shutdown.type).toBe('shutdown')
      })

      it('should not call the fatal callback', () => {
        expect(fatal).not.toHaveBeenCalled()
      })

      it('should not kill the process that exited in time', () => {
        expect(fake.kill).not.toHaveBeenCalled()
      })
    })
  })
})
