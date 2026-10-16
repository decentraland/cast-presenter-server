import * as fs from 'fs'
import * as path from 'path'
import { createPptxRendererComponent } from '../../src/adapters/pptx-renderer/component'
import type { IRenderer } from '../../src/adapters/renderer/types'

interface MockVideo {
  mediaRef?: string
  externalUrl?: string
}

const mockDeck: { media: Map<string, Buffer>; videos: MockVideo[]; videosBySlide: MockVideo[][] | null } = {
  media: new Map(),
  videos: [],
  videosBySlide: null
}

jest.mock('../../src/adapters/pptx-renderer/parser/core/PPTXParser', () => ({
  MAX_EMBEDDED_MEDIA_BYTES: 200 * 1024 * 1024,
  PPTXParser: class {
    async parse(): Promise<void> {
      return undefined
    }
    getSlideCount(): number {
      return 1
    }
    async getSlide(index: number): Promise<unknown> {
      const videos = mockDeck.videosBySlide?.[index] ?? mockDeck.videos
      return {
        width: 960,
        height: 540,
        getVideos: () => videos.map((video) => ({ ...video, geometry: { x: 0, y: 0, width: 100, height: 100 } }))
      }
    }
    async getMedia(ref: string): Promise<ArrayBuffer> {
      const data = mockDeck.media.get(ref)
      if (!data) throw new Error(`Unknown media ${ref}`)
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }
  }
}))

describe('when a PPTX slide carries an embedded video', () => {
  const MEDIA_REF = 'ppt/media/media1.mp4'
  let renderer: IRenderer
  let extractedPath: string

  beforeEach(async () => {
    mockDeck.media = new Map([[MEDIA_REF, Buffer.from('original-bytes')]])
    mockDeck.videos = [{ mediaRef: MEDIA_REF }]
    renderer = createPptxRendererComponent().createRenderer()
    await renderer.initialize(Buffer.from('pptx'))
    extractedPath = (await renderer.getSlideVideos(0))[0].url
  })

  afterEach(() => {
    renderer.destroy()
  })

  it('should report the directory it extracted into as its embedded media directory', () => {
    expect(renderer.getEmbeddedMediaDir()).toBe(path.dirname(extractedPath))
  })

  describe('and the slide is requested again while the extracted file is being consumed', () => {
    let secondPath: string

    beforeEach(async () => {
      fs.writeFileSync(extractedPath, 'bytes-written-by-the-bake')
      secondPath = (await renderer.getSlideVideos(0))[0].url
    })

    it('should return the path extracted the first time', () => {
      expect(secondPath).toBe(extractedPath)
    })

    it('should leave the extracted file untouched instead of re-writing it', () => {
      expect(fs.readFileSync(extractedPath, 'utf8')).toBe('bytes-written-by-the-bake')
    })
  })
})

describe('when two slides extract different embedded videos at the same time', () => {
  let renderer: IRenderer
  let directories: string[]

  beforeEach(async () => {
    mockDeck.media = new Map([
      ['ppt/media/media1.mp4', Buffer.from('first')],
      ['ppt/media/media2.mp4', Buffer.from('second')]
    ])
    mockDeck.videosBySlide = [[{ mediaRef: 'ppt/media/media1.mp4' }], [{ mediaRef: 'ppt/media/media2.mp4' }]]
    renderer = createPptxRendererComponent().createRenderer()
    await renderer.initialize(Buffer.from('pptx'))
    const [first, second] = await Promise.all([renderer.getSlideVideos(0), renderer.getSlideVideos(1)])
    directories = [path.dirname(first[0].url), path.dirname(second[0].url)]
  })

  afterEach(() => {
    renderer.destroy()
    mockDeck.videosBySlide = null
  })

  it('should extract both into the one embedded media directory', () => {
    expect(directories).toEqual([renderer.getEmbeddedMediaDir(), renderer.getEmbeddedMediaDir()])
  })
})
