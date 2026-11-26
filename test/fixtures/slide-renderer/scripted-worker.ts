import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WorkerMessage, WorkerRequest } from '../../../src/adapters/slide-renderer/worker'

const VIDEO = { url: 'https://example.com/video.mp4', geometry: { x: 0, y: 0, width: 1, height: 1 } }

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve) => process.send?.(message, undefined, undefined, () => resolve()))
}

function renderedSlide(index: number, outputDir: string, embeddedMediaDir: string | null = null): WorkerMessage {
  writeFileSync(join(outputDir, `${index}.png`), `png-${index}`)
  return { type: 'slide', index, image: { hash: `hash-${index}`, width: 1, height: 1 }, videos: [], embeddedMediaDir }
}

function killSelf(): void {
  process.kill(process.pid, 'SIGKILL')
}

process.once('message', async ({ buffer, outputDir }: WorkerRequest) => {
  const scenario = Buffer.from(buffer).toString()
  if (scenario === 'die-before-deck') return killSelf()
  if (scenario === 'too-many-slides') {
    await send({ type: 'tooManySlides', slideCount: 501, maxSlides: 500 })
    process.exit()
  }
  await send({ type: 'deck', slideCount: 2 })
  if (scenario === 'extract-then-hang') {
    await send(renderedSlide(0, outputDir, mkdtempSync(join(tmpdir(), 'cast-pptx-video-'))))
    return
  }
  await send(
    scenario === 'fail-first-image'
      ? { type: 'slide', index: 0, image: { error: 'boom' }, videos: [VIDEO], embeddedMediaDir: null }
      : renderedSlide(0, outputDir)
  )
  if (scenario === 'kill-after-first') killSelf()
  if (scenario === 'exceed-image-budget') {
    await send({ type: 'imageBudgetExceeded', index: 1 })
    await send({
      type: 'slide',
      index: 1,
      image: { error: 'Deck exceeded its image budget of 1 bytes' },
      videos: [],
      embeddedMediaDir: null
    })
    process.exit()
  }
  await send(renderedSlide(1, outputDir))
  process.exit()
})
