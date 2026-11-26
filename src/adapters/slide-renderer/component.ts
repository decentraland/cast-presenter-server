import { fork } from 'child_process'
import { rmSync } from 'fs'
import path from 'path'
import { SlideRenderError } from '../renderer/errors'
import type { ISlideRenderer, ISlideRendererComponent } from './types'
import type { WorkerResponse, WorkerResults } from './worker'
import type { FileType } from '../../logic/file-validator'
import type { SlideImage } from '../../logic/slide-image'
import type { SlideVideoInfo } from '../renderer/types'

const DESTROY_GRACE_MS = 2_000

interface PendingCall {
  index: number
  resolve(result: unknown): void
  reject(error: Error): void
}

/**
 * Creates the slide renderer component. Each renderer it creates forks its own
 * render process, so a native crash while rendering ends only that renderer.
 *
 * @param options.workerPath - Entry point of the render process; defaults to the sibling `worker` module
 * @returns The slide renderer factory component
 */
export function createSlideRendererComponent(options: { workerPath?: string } = {}): ISlideRendererComponent {
  const workerPath = options.workerPath ?? path.join(__dirname, `worker${path.extname(__filename)}`)
  const execArgv = workerPath.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only'] : []

  function createRenderer(fileType: FileType): ISlideRenderer {
    const child = fork(workerPath, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv
    })
    const pending = new Map<number, PendingCall>()
    let nextId = 0
    let exitCause: Error | null = null
    let slideCount: number | null = null
    let embeddedMediaDir: string | null = null

    function markDead(cause: Error): void {
      exitCause ??= cause
      for (const call of pending.values()) call.reject(new SlideRenderError(call.index, exitCause))
      pending.clear()
    }

    child.on('message', (response: WorkerResponse) => {
      const call = pending.get(response.id)
      if (!call) return
      pending.delete(response.id)
      if ('error' in response) call.reject(new Error(response.error))
      else call.resolve(response.result)
    })
    child.on('error', markDead)
    child.on('exit', (code, signal) => markDead(new Error(`Slide render process exited with ${signal ?? code}`)))

    function call<Op extends keyof WorkerResults>(op: Op, index: number, fields = {}): Promise<WorkerResults[Op]> {
      return new Promise((resolve, reject) => {
        if (exitCause) return reject(new SlideRenderError(index, exitCause))
        const id = nextId++
        pending.set(id, { index, resolve, reject })
        child.send({ ...fields, id, op, index })
      })
    }

    return {
      async initialize(fileBuffer: Buffer): Promise<void> {
        ;({ slideCount } = await call('initialize', 0, { fileType, buffer: fileBuffer }))
      },

      async renderSlide(index: number): Promise<SlideImage> {
        try {
          const image = await call('renderSlide', index)
          return { ...image, png: Buffer.from(image.png) }
        } catch (err) {
          throw err instanceof SlideRenderError ? err : new SlideRenderError(index, err)
        }
      },

      async getSlideVideos(index: number): Promise<SlideVideoInfo[]> {
        const reply = await call('getSlideVideos', index)
        embeddedMediaDir = reply.embeddedMediaDir
        return reply.videos
      },

      getEmbeddedMediaDir(): string | null {
        return embeddedMediaDir
      },

      getSlideCount(): number {
        if (slideCount === null) throw new Error('Slide renderer not initialized')
        return slideCount
      },

      destroy(): void {
        if (child.connected) child.send({ op: 'destroy' })
        setTimeout(() => child.kill('SIGKILL'), DESTROY_GRACE_MS).unref()
        if (embeddedMediaDir) rmSync(embeddedMediaDir, { recursive: true, force: true })
      }
    }
  }

  return { createRenderer }
}
