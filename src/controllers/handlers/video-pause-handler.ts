import type { IHttpServerComponent } from '@well-known-components/interfaces'
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
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not found')) {
      return { status: 404, body: { error: message } }
    }
    logger.error(`Video pause failed: ${message}`)
    return { status: 500, body: { error: message } }
  }
}
