import { Router } from '@well-known-components/http-server'
import { createPresentationHandler } from './handlers/create-presentation-handler'
import { driveVideoHandler } from './handlers/drive-video-handler'
import { pingHandler } from './handlers/ping-handler'
import { createRateLimiterComponent } from '../logic/rate-limiter'
import type { GlobalContext } from '../types'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(_: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  // Rate limiters per endpoint group
  const rateLimiter = createRateLimiterComponent()
  const presentationLimiter = rateLimiter.createLimiter(5, 60_000) // 5 per minute
  const driveVideoLimiter = rateLimiter.createLimiter(30, 60_000) // 30 per minute

  router.get('/ping', pingHandler)
  router.get('/api/drive-video', async (ctx) => {
    const ip = ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const limited = driveVideoLimiter(ip)
    if (limited) return limited
    return driveVideoHandler(ctx)
  })

  // Presentation creation — authenticated via LiveKit token (fail-fast connection).
  // Control endpoints (navigate, play, pause, stop) were removed because all
  // presentation control flows through the LiveKit data channel, which enforces
  // presenter authorization via room metadata. See docs/architecture.md for details.
  router.post('/presentations', async (ctx) => {
    const ip = ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const limited = presentationLimiter(ip)
    if (limited) return limited
    return createPresentationHandler(ctx)
  })

  return router
}
