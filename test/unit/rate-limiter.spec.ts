import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { createRateLimiterComponent } from '../../src/logic/rate-limiter'
import type { RateLimitCheck } from '../../src/logic/rate-limiter'

describe('when using the rate limiter component', () => {
  let limiter: RateLimitCheck

  describe('and the request count is under the limit', () => {
    beforeEach(() => {
      const component = createRateLimiterComponent()
      limiter = component.createLimiter(3, 60_000)
    })

    it('should return null for each request', () => {
      expect(limiter('1.2.3.4')).toBeNull()
      expect(limiter('1.2.3.4')).toBeNull()
      expect(limiter('1.2.3.4')).toBeNull()
    })
  })

  describe('and the request count exceeds the limit', () => {
    let result: IHttpServerComponent.IResponse | null

    beforeEach(() => {
      const component = createRateLimiterComponent()
      limiter = component.createLimiter(2, 60_000)
      limiter('1.2.3.4')
      limiter('1.2.3.4')
      result = limiter('1.2.3.4')
    })

    it('should return a 429 status', () => {
      expect(result?.status).toBe(429)
    })

    it('should include a Retry-After header', () => {
      expect((result?.headers as Record<string, string>)?.['Retry-After']).toBeDefined()
    })

    it('should return an error message about too many requests', () => {
      expect((result?.body as Record<string, string>)?.error).toContain('Too many requests')
    })
  })

  describe('and requests come from different IPs', () => {
    beforeEach(() => {
      const component = createRateLimiterComponent()
      limiter = component.createLimiter(1, 60_000)
    })

    it('should track each IP independently', () => {
      expect(limiter('1.1.1.1')).toBeNull()
      expect(limiter('2.2.2.2')).toBeNull()
      expect(limiter('1.1.1.1')).not.toBeNull()
      expect(limiter('2.2.2.2')).not.toBeNull()
    })
  })

  describe('and the time window has expired', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      const component = createRateLimiterComponent()
      limiter = component.createLimiter(1, 1000)
      limiter('1.2.3.4')
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should allow requests again after the window resets', () => {
      expect(limiter('1.2.3.4')).not.toBeNull()
      jest.advanceTimersByTime(1001)
      expect(limiter('1.2.3.4')).toBeNull()
    })
  })
})
