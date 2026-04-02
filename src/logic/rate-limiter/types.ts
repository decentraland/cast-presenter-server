import type { IHttpServerComponent } from '@well-known-components/interfaces'

export type RateLimitCheck = (ip: string) => IHttpServerComponent.IResponse | null

export interface IRateLimiterComponent {
  createLimiter(maxRequests: number, windowMs: number): RateLimitCheck
}
