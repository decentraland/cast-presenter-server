import { isPrivateIP, validateFilterParam, validateVideoUrl } from '../../src/adapters/video-compositor'

describe('ssrf-protection', () => {
  describe('isPrivateIP', () => {
    it('blocks loopback', () => {
      expect(isPrivateIP('127.0.0.1')).toBe(true)
      expect(isPrivateIP('127.255.255.255')).toBe(true)
    })

    it('blocks 10.x.x.x', () => {
      expect(isPrivateIP('10.0.0.1')).toBe(true)
      expect(isPrivateIP('10.255.255.255')).toBe(true)
    })

    it('blocks 172.16-31.x.x', () => {
      expect(isPrivateIP('172.16.0.1')).toBe(true)
      expect(isPrivateIP('172.31.255.255')).toBe(true)
    })

    it('allows 172.32.x.x', () => {
      expect(isPrivateIP('172.32.0.1')).toBe(false)
    })

    it('blocks 192.168.x.x', () => {
      expect(isPrivateIP('192.168.1.1')).toBe(true)
    })

    it('blocks link-local / cloud metadata', () => {
      expect(isPrivateIP('169.254.169.254')).toBe(true)
    })

    it('blocks 0.0.0.0', () => {
      expect(isPrivateIP('0.0.0.0')).toBe(true)
    })

    it('allows public IPs', () => {
      expect(isPrivateIP('8.8.8.8')).toBe(false)
      expect(isPrivateIP('142.250.80.46')).toBe(false)
    })
  })

  describe('validateVideoUrl', () => {
    it('rejects non-HTTPS protocols', async () => {
      await expect(validateVideoUrl('http://drive.google.com/file')).rejects.toThrow('HTTPS')
      await expect(validateVideoUrl('file:///etc/passwd')).rejects.toThrow('HTTPS')
      await expect(validateVideoUrl('ftp://drive.google.com')).rejects.toThrow('HTTPS')
    })

    it('rejects domains not in the allowlist', async () => {
      await expect(validateVideoUrl('https://evil.com/video.mp4')).rejects.toThrow('not allowed')
      await expect(validateVideoUrl('https://localhost/video.mp4')).rejects.toThrow('not allowed')
    })

    it('accepts allowed domains', async () => {
      await expect(validateVideoUrl('https://drive.google.com/file/d/abc')).resolves.toBeUndefined()
      await expect(validateVideoUrl('https://drive.usercontent.google.com/download?id=abc')).resolves.toBeUndefined()
      await expect(validateVideoUrl('https://youtube.com/watch?v=abc')).resolves.toBeUndefined()
      await expect(validateVideoUrl('https://www.youtube.com/watch?v=abc')).resolves.toBeUndefined()
      await expect(validateVideoUrl('https://youtu.be/abc')).resolves.toBeUndefined()
      await expect(validateVideoUrl('https://vimeo.com/123')).resolves.toBeUndefined()
    })

    it('rejects invalid URLs', async () => {
      await expect(validateVideoUrl('not-a-url')).rejects.toThrow('Invalid video URL')
    })
  })

  describe('validateFilterParam', () => {
    it('accepts valid integer values', () => {
      expect(() => validateFilterParam(100, 'width')).not.toThrow()
      expect(() => validateFilterParam(0, 'x')).not.toThrow()
      expect(() => validateFilterParam(7680, 'width')).not.toThrow()
    })

    it('rejects negative values', () => {
      expect(() => validateFilterParam(-1, 'x')).toThrow()
    })

    it('rejects values exceeding max', () => {
      expect(() => validateFilterParam(7681, 'width')).toThrow()
    })

    it('rejects non-integer values', () => {
      expect(() => validateFilterParam(1.5, 'width')).toThrow()
      expect(() => validateFilterParam(NaN, 'width')).toThrow()
    })
  })
})
