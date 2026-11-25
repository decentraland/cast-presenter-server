import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WorkerMessage, WorkerRequest } from '../../../src/adapters/slide-renderer/worker'

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve) => process.send?.(message, undefined, undefined, () => resolve()))
}

function renderedSlide(index: number, outputDir: string): WorkerMessage {
  writeFileSync(join(outputDir, `${index}.png`), `png-${index}`)
  return { type: 'slide', index, hash: `hash-${index}`, width: 1, height: 1, videos: [], embeddedMediaDir: null }
}

process.once('message', async ({ buffer, outputDir }: WorkerRequest) => {
  const scenario = Buffer.from(buffer).toString()
  await send({ type: 'deck', slideCount: 2 })
  if (scenario === 'extract-then-hang') {
    writeFileSync(join(outputDir, '0.png'), 'png-0')
    const embeddedMediaDir = mkdtempSync(join(tmpdir(), 'cast-pptx-video-'))
    await send({ type: 'slide', index: 0, hash: 'hash-0', width: 1, height: 1, videos: [], embeddedMediaDir })
    return
  }
  await send(scenario === 'fail-first' ? { type: 'slideFailed', index: 0, error: 'boom' } : renderedSlide(0, outputDir))
  if (scenario === 'abort-after-first') process.abort()
  await send(renderedSlide(1, outputDir))
  process.exit()
})
