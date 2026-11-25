import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

interface Request {
  id: number
  op: string
}

process.on('message', ({ id, op }: Request) => {
  if (op === 'initialize') process.send?.({ id, result: { slideCount: 2 } })
  if (op === 'getSlideVideos') {
    process.send?.({ id, result: { videos: [], embeddedMediaDir: mkdtempSync(join(tmpdir(), 'cast-abort-test-')) } })
  }
  if (op === 'renderSlide') process.abort()
})
