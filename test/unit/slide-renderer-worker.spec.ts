import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { renderDeck } from '../../src/adapters/slide-renderer/worker'
import { buildPptx, ellipseSlide, embeddedVideoSlide } from '../helpers/build-pptx'
import type { WorkerMessage } from '../../src/adapters/slide-renderer/worker'

jest.setTimeout(60_000)

let outputDir: string
let messages: WorkerMessage[]
let send: jest.Mock<Promise<void>, [WorkerMessage]>

beforeEach(() => {
  outputDir = mkdtempSync(path.join(tmpdir(), 'cast-worker-test-'))
  messages = []
  send = jest.fn(async (message: WorkerMessage) => {
    messages.push(message)
  })
})

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true })
})

describe('when the deck has more slides than the render process accepts', () => {
  beforeEach(async () => {
    const deck = await buildPptx(Array.from({ length: 501 }, () => ellipseSlide('0')))
    await renderDeck({ fileType: 'pptx', buffer: deck, outputDir }, send)
  })

  it('should report only that the deck has too many slides', () => {
    expect(messages).toEqual([{ type: 'tooManySlides', slideCount: 501, maxSlides: 500 }])
  })

  it('should not write any slide image', () => {
    expect(readdirSync(outputDir)).toEqual([])
  })
})

describe('when the document cannot be loaded', () => {
  beforeEach(async () => {
    await renderDeck({ fileType: 'pptx', buffer: Buffer.from('not a pptx'), outputDir }, send)
  })

  it('should report that the deck failed to load', () => {
    expect(messages).toEqual([{ type: 'deckFailed', error: expect.any(String) }])
  })
})

describe('when a slide image is written', () => {
  let slideReport: WorkerMessage | undefined

  beforeEach(async () => {
    await renderDeck({ fileType: 'pptx', buffer: await buildPptx([ellipseSlide('0')]), outputDir }, send)
    slideReport = messages.find((message) => message.type === 'slide')
  })

  it('should report the byte size of the written PNG on the slide image', () => {
    expect(slideReport).toEqual(
      expect.objectContaining({
        image: expect.objectContaining({ bytes: statSync(path.join(outputDir, '0.png')).size })
      })
    )
  })
})

describe('when the slide images exceed the deck budget', () => {
  let slideReports: WorkerMessage[]

  beforeEach(async () => {
    const deck = await buildPptx([ellipseSlide('0'), ellipseSlide('0'), embeddedVideoSlide('clip.mp4')], {
      'ppt/media/clip.mp4': 'video-bytes'
    })
    const probeDir = mkdtempSync(path.join(tmpdir(), 'cast-worker-probe-'))
    await renderDeck({ fileType: 'pptx', buffer: deck, outputDir: probeDir }, jest.fn().mockResolvedValue(undefined))
    const onePngBytes = statSync(path.join(probeDir, '0.png')).size
    rmSync(probeDir, { recursive: true, force: true })
    await renderDeck({ fileType: 'pptx', buffer: deck, outputDir }, send, onePngBytes)
    slideReports = messages.filter((message) => message.type === 'slide')
  })

  it('should report the exhausted budget once with the first slide that did not fit', () => {
    expect(messages.filter((message) => message.type === 'imageBudgetExceeded')).toEqual([
      { type: 'imageBudgetExceeded', index: 1 }
    ])
  })

  it('should fail the slide images past the budget with an image budget error', () => {
    expect(slideReports[1]).toEqual(
      expect.objectContaining({ image: { error: expect.stringContaining('image budget') } })
    )
  })

  it('should report the first slide image and fail the slides past the budget', () => {
    expect(slideReports.map((report) => report.type === 'slide' && 'hash' in report.image)).toEqual([
      true,
      false,
      false
    ])
  })

  it('should write only the image that fits the budget', () => {
    expect(readdirSync(outputDir).filter((name) => name.endsWith('.png'))).toEqual(['0.png'])
  })

  it('should still report the videos of a slide whose image failed', () => {
    expect(slideReports[2]).toEqual(
      expect.objectContaining({ videos: [expect.objectContaining({ url: expect.stringContaining('clip.mp4') })] })
    )
  })
})

describe('when reporting a slide fails after the deck was announced', () => {
  let renderError: unknown

  beforeEach(async () => {
    send.mockImplementation(async (message: WorkerMessage) => {
      messages.push(message)
      if (message.type === 'slide') throw new Error('Channel closed')
    })
    const deck = await buildPptx([ellipseSlide('0'), ellipseSlide('0')])
    renderError = await renderDeck({ fileType: 'pptx', buffer: deck, outputDir }, send).catch((error: unknown) => error)
  })

  it('should reject with the send failure', () => {
    expect(renderError).toEqual(new Error('Channel closed'))
  })

  it('should not report the deck as failed', () => {
    expect(messages.map((message) => message.type)).toEqual(['deck', 'slide'])
  })
})
