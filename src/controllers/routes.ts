import { Router } from '@dcl/http-server'
import { createPresentationHandler } from './handlers/create-presentation-handler'
import { driveVideoHandler } from './handlers/drive-video-handler'
import { pingHandler } from './handlers/ping-handler'
import { slideImageHandler } from './handlers/slide-image-handler'
import type { GlobalContext } from '../types'

// We return the entire router because it will be easier to test than a whole server
export async function setupRouter(_: GlobalContext): Promise<Router<GlobalContext>> {
  const router = new Router<GlobalContext>()

  router.get('/ping', pingHandler)
  router.get('/api/drive-video', driveVideoHandler)

  // Presentation creation — authenticated via LiveKit token (fail-fast connection).
  // Control endpoints (navigate, play, pause, stop) were removed because all
  // presentation control flows through the LiveKit data channel, which enforces
  // presenter authorization via room metadata. See docs/architecture.md for details.
  router.post('/presentations', createPresentationHandler)
  router.get('/presentations/:id/slides/:file', slideImageHandler)

  return router
}
