import { Router } from '@well-known-components/http-server'
import { createPresentationHandler } from './handlers/create-presentation-handler'
import { driveVideoHandler } from './handlers/drive-video-handler'
import { getStateHandler } from './handlers/get-state-handler'
import { navigateHandler } from './handlers/navigate-handler'
import { pingHandler } from './handlers/ping-handler'
import { stopPresentationHandler } from './handlers/stop-presentation-handler'
import { videoPauseHandler } from './handlers/video-pause-handler'
import { videoPlayHandler } from './handlers/video-play-handler'
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

  // Presentation endpoints
  router.post('/presentations', async (ctx) => {
    const ip = ctx.request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    const limited = presentationLimiter(ip)
    if (limited) return limited
    return createPresentationHandler(ctx)
  })
  router.post('/presentations/:id/navigate', navigateHandler)
  router.get('/presentations/:id', getStateHandler)
  router.post('/presentations/:id/video/play', videoPlayHandler)
  router.post('/presentations/:id/video/pause', videoPauseHandler)
  router.delete('/presentations/:id', stopPresentationHandler)

  return router
}
