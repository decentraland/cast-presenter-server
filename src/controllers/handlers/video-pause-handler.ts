import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { PresentationNotFoundError } from '../../logic/presentation-manager'
import type { HandlerContextWithPath } from '../../types'

export async function videoPauseHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager', '/presentations/:id/video/pause'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager },
    params
  } = context

  const logger = logs.getLogger('video-pause-handler')

  try {
    await presentationManager.pauseVideo(params.id)
    return { status: 200, body: { status: 'paused' } }
  } catch (error) {
    if (error instanceof PresentationNotFoundError) {
      return { status: 404, body: { error: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Video pause failed: ${message}`)
    return { status: 500, body: { error: message } }
  }
}
