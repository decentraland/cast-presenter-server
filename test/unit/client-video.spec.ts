import { classifyClientVideo } from '../../src/logic/client-video'
import type { ClientVideo } from '../../src/logic/client-video'

const YOUTUBE_ID = 'dQw4w9WgXcQ'
const YOUTUBE_CANONICAL = `https://www.youtube.com/watch?v=${YOUTUBE_ID}`
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345'
const DRIVE_CANONICAL = `https://drive.google.com/file/d/${DRIVE_ID}/view`

describe('when classifying a slide video URL', () => {
  let result: ClientVideo | null

  describe.each([
    ['a youtu.be short link', `https://youtu.be/${YOUTUBE_ID}`],
    ['a watch link', `https://www.youtube.com/watch?v=${YOUTUBE_ID}`],
    ['a watch link on the bare domain with extra params', `https://youtube.com/watch?v=${YOUTUBE_ID}&t=42s`],
    ['a shorts link', `https://www.youtube.com/shorts/${YOUTUBE_ID}`],
    ['a live link', `https://www.youtube.com/live/${YOUTUBE_ID}`],
    ['an embed link', `https://www.youtube.com/embed/${YOUTUBE_ID}`],
    ['an http watch link', `http://www.youtube.com/watch?v=${YOUTUBE_ID}`]
  ])('and the URL is YouTube %s', (_label, url) => {
    beforeEach(() => {
      result = classifyClientVideo(url)
    })

    it('should classify it as a YouTube video with the canonical watch URL', () => {
      expect(result).toEqual({ provider: 'youtube', id: YOUTUBE_ID, url: YOUTUBE_CANONICAL })
    })
  })

  describe('and the YouTube id contains hyphens and underscores', () => {
    beforeEach(() => {
      result = classifyClientVideo('https://youtu.be/a-b_c-d_e-f')
    })

    it('should keep the id in the canonical watch URL', () => {
      expect(result).toEqual({
        provider: 'youtube',
        id: 'a-b_c-d_e-f',
        url: 'https://www.youtube.com/watch?v=a-b_c-d_e-f'
      })
    })
  })

  describe.each([
    ['a file view link', `https://drive.google.com/file/d/${DRIVE_ID}/view?usp=sharing`],
    ['an http file view link', `http://drive.google.com/file/d/${DRIVE_ID}/view`],
    ['an open link', `https://drive.google.com/open?id=${DRIVE_ID}`],
    ['a uc download link', `https://drive.google.com/uc?export=download&id=${DRIVE_ID}`],
    ['a docs link', `https://docs.google.com/file/d/${DRIVE_ID}/edit`],
    ['a usercontent download link', `https://drive.usercontent.google.com/download?id=${DRIVE_ID}&export=download`]
  ])('and the URL is Google Drive %s', (_label, url) => {
    beforeEach(() => {
      result = classifyClientVideo(url)
    })

    it('should classify it as a Drive video with the canonical file view URL', () => {
      expect(result).toEqual({ provider: 'drive', id: DRIVE_ID, url: DRIVE_CANONICAL })
    })
  })

  describe.each([
    [
      'an https playlist with a query',
      'https://player.vimeo.com/external/123456.m3u8?s=abc&logging=false',
      '123456',
      'https://player.vimeo.com/external/123456.m3u8?s=abc&logging=false'
    ],
    [
      'an http playlist',
      'http://player.vimeo.com/external/123.m3u8?s=abc',
      '123',
      'https://player.vimeo.com/external/123.m3u8?s=abc'
    ],
    [
      'a playlist with a fragment',
      'https://player.vimeo.com/external/123.m3u8?s=abc#t=10',
      '123',
      'https://player.vimeo.com/external/123.m3u8?s=abc'
    ]
  ])('and the URL is Vimeo HLS %s', (_label, url, id, canonical) => {
    beforeEach(() => {
      result = classifyClientVideo(url)
    })

    it('should classify it as a Vimeo HLS video with the https URL and its query', () => {
      expect(result).toEqual({ provider: 'vimeo-hls', id, url: canonical })
    })
  })

  describe.each([
    ['a 10-char YouTube id', 'https://youtu.be/dQw4w9WgXc'],
    ['a 12-char YouTube id', 'https://www.youtube.com/watch?v=dQw4w9WgXcQQ'],
    ['a YouTube watch link without an id', 'https://www.youtube.com/watch'],
    ['a YouTube channel link', 'https://www.youtube.com/@decentraland'],
    ['a too short Drive id', 'https://drive.google.com/file/d/abc/view'],
    ['a Vimeo page link', 'https://vimeo.com/123'],
    ['a Vimeo player page link', 'https://player.vimeo.com/video/123'],
    ['a Vimeo playlist with a non-numeric id', 'https://player.vimeo.com/external/abc.m3u8'],
    ['a YouTube path on another host', `https://evil.com/youtube.com/watch?v=${YOUTUBE_ID}`],
    ['a YouTube-prefixed host', `https://youtube.com.evil.com/watch?v=${YOUTUBE_ID}`],
    ['a URL with credentials', `https://user:pw@www.youtube.com/watch?v=${YOUTUBE_ID}`],
    ['a non-default port', `https://www.youtube.com:8443/watch?v=${YOUTUBE_ID}`],
    ['an ftp URL', `ftp://www.youtube.com/watch?v=${YOUTUBE_ID}`],
    ['an empty string', ''],
    ['a local path', '/tmp/cast-pptx-video-a/v.mp4']
  ])('and the URL is %s', (_label, url) => {
    beforeEach(() => {
      result = classifyClientVideo(url)
    })

    it('should not classify it as a client-played video', () => {
      expect(result).toBeNull()
    })
  })
})
