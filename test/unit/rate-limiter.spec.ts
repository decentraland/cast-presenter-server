import { createRateLimiterComponent } from '../../src/logic/rate-limiter'

describe('rate-limiter', () => {
  const component = createRateLimiterComponent()

  it('allows requests under the limit', () => {
    const limiter = component.createLimiter(3, 60_000)
    expect(limiter('1.2.3.4')).toBeNull()
    expect(limiter('1.2.3.4')).toBeNull()
    expect(limiter('1.2.3.4')).toBeNull()
  })

  it('returns 429 when limit is exceeded', () => {
    const limiter = component.createLimiter(2, 60_000)
    limiter('1.2.3.4')
    limiter('1.2.3.4')
    const result = limiter('1.2.3.4')
    expect(result).not.toBeNull()
    expect(result?.status).toBe(429)
    expect((result?.body as Record<string, string>)?.error).toContain('Too many requests')
    expect((result?.headers as Record<string, string>)?.['Retry-After']).toBeDefined()
  })

  it('tracks IPs independently', () => {
    const limiter = component.createLimiter(1, 60_000)
    expect(limiter('1.1.1.1')).toBeNull()
    expect(limiter('2.2.2.2')).toBeNull()
    expect(limiter('1.1.1.1')).not.toBeNull()
    expect(limiter('2.2.2.2')).not.toBeNull()
  })

  it('resets after window expires', () => {
    jest.useFakeTimers()
    const limiter = component.createLimiter(1, 1000)
    expect(limiter('1.2.3.4')).toBeNull()
    expect(limiter('1.2.3.4')).not.toBeNull()

    jest.advanceTimersByTime(1001)
    expect(limiter('1.2.3.4')).toBeNull()
    jest.useRealTimers()
  })
})
