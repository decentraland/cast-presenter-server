import { fork } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { errorMessage } from '../../logic/error-message'
import { SlideRenderError, TooManySlidesError } from '../renderer/errors'
import type { ISlideRenderer, ISlideRendererComponent } from './types'
import type { SlideReport, WorkerMessage, WorkerRequest } from './worker'
import type { FileType } from '../../logic/file-validator'
import type { SlideImage } from '../../logic/slide-image'
import type { AppComponents } from '../../types'
import type { SlideVideoInfo } from '../renderer/types'

/** PNG bytes the live renderers of one component may hold on disk together. */
export const MAX_SERVER_PNG_BYTES = 4 * 1024 * 1024 * 1024

interface Settleable<T> {
  promise: Promise<T>
  settle(result: T | Error): void
}

function settleable<T>(): Settleable<T> {
  let settle: (result: T | Error) => void = () => undefined
  const promise = new Promise<T>((resolve, reject) => {
    settle = (result) => (result instanceof Error ? reject(result) : resolve(result))
  })
  promise.catch(() => undefined)
  return { promise, settle }
}

/**
 * Creates the slide renderer component. Each renderer forks a render process that
 * writes every slide of its deck to a directory the renderer owns, then exits, so a
 * native crash while rendering ends only that renderer and a live session holds no process.
 *
 * Every renderer of the component shares one budget of PNG bytes on disk; the renderer whose
 * report pushes it past `MAX_SERVER_PNG_BYTES` stops its render process.
 *
 * @param components.logs - Logger factory; warns when a render process exits before finishing its deck or exceeds the shared budget
 * @param options.workerPath - Entry point of the render process; defaults to the sibling `worker` module
 * @returns The slide renderer factory component
 */
export function createSlideRendererComponent(
  components: Pick<AppComponents, 'logs'>,
  options: { workerPath?: string } = {}
): ISlideRendererComponent {
  const logger = components.logs.getLogger('slide-renderer')
  const workerPath = options.workerPath ?? path.join(__dirname, `worker${path.extname(__filename)}`)
  const execArgv = workerPath.endsWith('.ts') ? ['-r', 'ts-node/register/transpile-only'] : []
  let serverPngBytes = 0

  function createRenderer(fileType: FileType): ISlideRenderer {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cast-slides-'))
    const child = fork(workerPath, [], {
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv,
      env: { ...process.env, TMPDIR: dir }
    })
    const deck = settleable<number>()
    let slides: Array<Settleable<SlideReport>> = []
    let slideCount: number | null = null
    let reportedSlides = 0
    let deckFailed = false
    let embeddedMediaDir: string | null = null
    let destroyed = false
    let pngBytes = 0
    let stopCause: Error | null = null

    function removeDir(): void {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        logger.warn(`Failed to remove slide render directory: ${errorMessage(error)}`, { dir })
      }
    }

    function fail(cause: Error): void {
      deck.settle(new SlideRenderError(0, cause))
      slides.forEach((slide, index) => slide.settle(new SlideRenderError(index, cause)))
    }

    function slideAt(index: number): Promise<SlideReport> {
      return slides[index]?.promise ?? Promise.reject(new SlideRenderError(index, new Error('Slide is out of range')))
    }

    function addPngBytes({ index, image }: SlideReport): void {
      if (destroyed || 'error' in image) return
      pngBytes += image.bytes
      serverPngBytes += image.bytes
      if (serverPngBytes <= MAX_SERVER_PNG_BYTES || stopCause || child.exitCode !== null || child.signalCode !== null) {
        return
      }
      logger.warn('Deck exceeded the server-wide slide image budget', {
        index,
        slideCount: slideCount ?? 'unknown'
      })
      stopCause = new Error("The server's slide image budget was exceeded")
      child.kill('SIGKILL')
      fail(stopCause)
    }

    function send(request: WorkerRequest): void {
      child.send(request)
    }

    child.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'deck':
          slideCount = message.slideCount
          slides = Array.from({ length: message.slideCount }, () => settleable<SlideReport>())
          deck.settle(message.slideCount)
          break
        case 'deckFailed':
          deckFailed = true
          deck.settle(new Error(message.error))
          break
        case 'tooManySlides':
          deckFailed = true
          deck.settle(new TooManySlidesError(message.slideCount, message.maxSlides))
          break
        case 'imageBudgetExceeded':
          logger.warn('Deck exceeded its slide image budget', {
            index: message.index,
            slideCount: slideCount ?? 'unknown'
          })
          break
        case 'slide':
          reportedSlides++
          embeddedMediaDir = message.embeddedMediaDir
          slides[message.index]?.settle(message)
          addPngBytes(message)
          break
      }
    })
    child.on('error', fail)
    child.on('close', (code, signal) => {
      const exit = signal ?? code ?? 'unknown'
      const unrenderedSlides = slideCount === null ? 'unknown' : slideCount - reportedSlides
      if (!destroyed && !deckFailed && !stopCause && unrenderedSlides !== 0) {
        logger.warn(`Slide render process exited with ${exit} before finishing the deck`, { exit, unrenderedSlides })
      }
      fail(stopCause ?? new Error(`Slide render process exited with ${exit}`))
      if (destroyed) removeDir()
    })

    return {
      async initialize(fileBuffer: Buffer): Promise<void> {
        send({ fileType, buffer: fileBuffer, outputDir: dir })
        await deck.promise
      },

      async renderSlide(index: number): Promise<SlideImage> {
        const { image } = await slideAt(index)
        if ('error' in image) throw new SlideRenderError(index, new Error(image.error))
        const { hash, width, height } = image
        try {
          return { hash, width, height, png: await readFile(path.join(dir, `${index}.png`)) }
        } catch (err) {
          throw new SlideRenderError(index, err)
        }
      },

      async getSlideVideos(index: number): Promise<SlideVideoInfo[]> {
        const { videos } = await slideAt(index)
        if ('error' in videos) throw new Error(videos.error)
        return videos
      },

      getEmbeddedMediaDir(): string | null {
        return embeddedMediaDir
      },

      getSlideCount(): number {
        if (slideCount === null) throw new Error('Slide renderer not initialized')
        return slideCount
      },

      destroy(): void {
        if (!destroyed) serverPngBytes -= pngBytes
        destroyed = true
        child.kill('SIGKILL')
        removeDir()
      }
    }
  }

  return { createRenderer }
}
