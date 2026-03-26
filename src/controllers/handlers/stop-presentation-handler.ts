import type { IHttpServerComponent } from '@well-known-components/interfaces'
import type { HandlerContextWithPath } from '../../types'

export async function stopPresentationHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager', '/presentations/:id'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager },
    params
  } = context

  const logger = logs.getLogger('stop-presentation-handler')

  try {
    await presentationManager.stopPresentation(params.id)
    return { status: 200, body: { status: 'stopped' } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`Stop presentation failed: ${message}`)
    return { status: 500, body: { error: message } }
  }
}
