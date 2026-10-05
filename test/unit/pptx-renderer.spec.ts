import * as fs from 'fs'
import { createPptxRendererComponent } from '../../src/adapters/pptx-renderer/component'
import type { IRenderer } from '../../src/adapters/renderer/types'

const mockDeck: { media: Map<string, Buffer>; videos: Array<{ mediaRef?: string; externalUrl?: string }> } = {
  media: new Map(),
  videos: []
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
    async getSlide(): Promise<unknown> {
      return {
        width: 960,
        height: 540,
        getVideos: () =>
          mockDeck.videos.map((video) => ({ ...video, geometry: { x: 0, y: 0, width: 100, height: 100 } }))
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

  describe('and the slide is requested again while the extracted file is being consumed', () => {
    beforeEach(() => {
      fs.writeFileSync(extractedPath, 'bytes-written-by-the-bake')
    })

    it('should return the path extracted the first time', async () => {
      const videos = await renderer.getSlideVideos(0)
      expect(videos[0].url).toBe(extractedPath)
    })

    it('should leave the extracted file untouched instead of re-writing it', async () => {
      await renderer.getSlideVideos(0)
      expect(fs.readFileSync(extractedPath, 'utf8')).toBe('bytes-written-by-the-bake')
    })
  })
})
