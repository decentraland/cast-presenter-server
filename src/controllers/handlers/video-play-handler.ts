import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { PresentationNotFoundError } from '../../logic/presentation-manager'
import type { HandlerContextWithPath } from '../../types'

export async function videoPlayHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager', '/presentations/:id/video/play'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager },
    params,
    request
  } = context

  const logger = logs.getLogger('video-play-handler')

  try {
    const body = await request.json()
    const { videoIndex } = body as { videoIndex: number }

    if (typeof videoIndex !== 'number' || videoIndex < 0) {
      return { status: 400, body: { error: 'Invalid videoIndex' } }
    }

    await presentationManager.playVideo(params.id, videoIndex)

    return { status: 200, body: { status: 'playing' } }
  } catch (error) {
    if (error instanceof PresentationNotFoundError) {
      return { status: 404, body: { error: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Video play failed: ${message}`)
    return { status: 500, body: { error: message } }
  }
}
