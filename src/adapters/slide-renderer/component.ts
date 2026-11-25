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
 * @param components.logs - Logger factory; warns when a render process exits before finishing its deck
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
        case 'slide':
          reportedSlides++
          embeddedMediaDir = message.embeddedMediaDir
          slides[message.index]?.settle(message)
          break
      }
    })
    child.on('error', fail)
    child.on('close', (code, signal) => {
      const exit = signal ?? code ?? 'unknown'
      const unrenderedSlides = slideCount === null ? 'unknown' : slideCount - reportedSlides
      if (!destroyed && !deckFailed && unrenderedSlides !== 0) {
        logger.warn(`Slide render process exited with ${exit} before finishing the deck`, { exit, unrenderedSlides })
      }
      fail(new Error(`Slide render process exited with ${exit}`))
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
        destroyed = true
        child.kill('SIGKILL')
        removeDir()
      }
    }
  }

  return { createRenderer }
}
