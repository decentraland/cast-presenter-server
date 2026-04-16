import { validateFilterParam } from '../../src/adapters/video-compositor'
import { isPrivateIP, validateVideoUrl } from '../../src/logic/network-validator'

// Mock DNS to avoid real network calls in CI (validateVideoUrl triggers dns.resolve4/resolve6)
jest.mock('dns/promises', () => ({
  resolve4: jest.fn().mockResolvedValue(['142.250.80.46']),
  resolve6: jest.fn().mockResolvedValue([])
}))

describe('when checking SSRF protections', () => {
  describe('when evaluating an IP address', () => {
    describe('and the IP is in a private range', () => {
      it('should identify 127.x.x.x as private (loopback)', () => {
        expect(isPrivateIP('127.0.0.1')).toBe(true)
        expect(isPrivateIP('127.255.255.255')).toBe(true)
      })

      it('should identify 10.x.x.x as private', () => {
        expect(isPrivateIP('10.0.0.1')).toBe(true)
        expect(isPrivateIP('10.255.255.255')).toBe(true)
      })

      it('should identify 172.16-31.x.x as private', () => {
        expect(isPrivateIP('172.16.0.1')).toBe(true)
        expect(isPrivateIP('172.31.255.255')).toBe(true)
      })

      it('should identify 192.168.x.x as private', () => {
        expect(isPrivateIP('192.168.1.1')).toBe(true)
      })

      it('should identify 169.254.x.x as private (link-local / cloud metadata)', () => {
        expect(isPrivateIP('169.254.169.254')).toBe(true)
      })

      it('should identify 0.0.0.0 as private', () => {
        expect(isPrivateIP('0.0.0.0')).toBe(true)
      })

      it('should identify 224.x.x.x as private (multicast)', () => {
        expect(isPrivateIP('224.0.0.1')).toBe(true)
        expect(isPrivateIP('239.255.255.255')).toBe(true)
      })

      it('should identify 255.255.255.255 as private (broadcast)', () => {
        expect(isPrivateIP('255.255.255.255')).toBe(true)
      })
    })

    describe('and the IP is an IPv6 address', () => {
      it('should identify ::1 as private (loopback)', () => {
        expect(isPrivateIP('::1')).toBe(true)
      })

      it('should identify :: as private (unspecified)', () => {
        expect(isPrivateIP('::')).toBe(true)
      })

      it('should identify fe80:: as private (link-local)', () => {
        expect(isPrivateIP('fe80::1')).toBe(true)
        expect(isPrivateIP('fe80::abcd:1234')).toBe(true)
      })

      it('should identify fc00::/fd00:: as private (unique local)', () => {
        expect(isPrivateIP('fc00::1')).toBe(true)
        expect(isPrivateIP('fd00::1')).toBe(true)
        expect(isPrivateIP('fdab::1')).toBe(true)
      })

      it('should identify IPv6-mapped private IPv4 as private', () => {
        expect(isPrivateIP('::ffff:127.0.0.1')).toBe(true)
        expect(isPrivateIP('::ffff:10.0.0.1')).toBe(true)
        expect(isPrivateIP('::ffff:192.168.1.1')).toBe(true)
        expect(isPrivateIP('::ffff:169.254.169.254')).toBe(true)
      })

      it('should return false for IPv6-mapped public IPv4', () => {
        expect(isPrivateIP('::ffff:8.8.8.8')).toBe(false)
        expect(isPrivateIP('::ffff:142.250.80.46')).toBe(false)
      })

      it('should return false for public IPv6 addresses', () => {
        expect(isPrivateIP('2001:4860:4860::8888')).toBe(false)
        expect(isPrivateIP('2607:f8b0:4004:800::200e')).toBe(false)
      })
    })

    describe('and the IP is public', () => {
      it('should return false for 172.32.x.x (outside private range)', () => {
        expect(isPrivateIP('172.32.0.1')).toBe(false)
      })

      it('should return false for well-known public IPs', () => {
        expect(isPrivateIP('8.8.8.8')).toBe(false)
        expect(isPrivateIP('142.250.80.46')).toBe(false)
      })
    })
  })

  describe('when validating a video URL', () => {
    describe('and the URL uses a non-HTTPS protocol', () => {
      it('should upgrade http to https for allowlisted domains', async () => {
        const result = await validateVideoUrl('http://drive.google.com/file/d/abc')
        expect(result).toBe('https://drive.google.com/file/d/abc')
      })

      it('should throw an error mentioning HTTPS for http URLs on non-allowlisted domains', async () => {
        await expect(validateVideoUrl('http://evil.com/video.mp4')).rejects.toThrow('HTTPS')
      })

      it('should throw an error mentioning HTTPS for file URLs', async () => {
        await expect(validateVideoUrl('file:///etc/passwd')).rejects.toThrow('HTTPS')
      })

      it('should throw an error mentioning HTTPS for ftp URLs', async () => {
        await expect(validateVideoUrl('ftp://drive.google.com')).rejects.toThrow('HTTPS')
      })
    })

    describe('and the domain is not in the allowlist', () => {
      it('should throw an error with "not allowed" for unknown domains', async () => {
        await expect(validateVideoUrl('https://evil.com/video.mp4')).rejects.toThrow('not allowed')
      })

      it('should throw an error with "not allowed" for localhost', async () => {
        await expect(validateVideoUrl('https://localhost/video.mp4')).rejects.toThrow('not allowed')
      })
    })

    describe('and the domain is in the allowlist', () => {
      it('should return the validated URL for allowed domains', async () => {
        await expect(validateVideoUrl('https://drive.google.com/file/d/abc')).resolves.toBe(
          'https://drive.google.com/file/d/abc'
        )
        await expect(validateVideoUrl('https://youtube.com/watch?v=abc')).resolves.toBe(
          'https://youtube.com/watch?v=abc'
        )
        await expect(validateVideoUrl('https://vimeo.com/123')).resolves.toBe('https://vimeo.com/123')
      })
    })

    describe('and the URL is malformed', () => {
      it('should throw an error with "Invalid video URL"', async () => {
        await expect(validateVideoUrl('not-a-url')).rejects.toThrow('Invalid video URL')
      })
    })
  })

  describe('when validating an ffmpeg filter parameter', () => {
    describe('and the value is valid', () => {
      it('should not throw for integers within the allowed range', () => {
        expect(() => validateFilterParam(100, 'width')).not.toThrow()
        expect(() => validateFilterParam(0, 'x')).not.toThrow()
        expect(() => validateFilterParam(7680, 'width')).not.toThrow()
      })
    })

    describe('and the value is out of range', () => {
      it('should throw for negative values', () => {
        expect(() => validateFilterParam(-1, 'x')).toThrow('Invalid ffmpeg filter param x=-1')
      })

      it('should throw for values exceeding the maximum', () => {
        expect(() => validateFilterParam(7681, 'width')).toThrow('Invalid ffmpeg filter param width=7681')
      })
    })

    describe('and the value is not an integer', () => {
      it('should throw for floating point numbers', () => {
        expect(() => validateFilterParam(1.5, 'width')).toThrow('Invalid ffmpeg filter param')
      })

      it('should throw for NaN', () => {
        expect(() => validateFilterParam(NaN, 'width')).toThrow('Invalid ffmpeg filter param')
      })
    })
  })
})
