import type { IHttpServerComponent } from '@well-known-components/interfaces'
import type { HandlerContextWithPath } from '../../types'

export async function navigateHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager', '/presentations/:id/navigate'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager },
    params,
    request
  } = context

  const logger = logs.getLogger('navigate-handler')

  try {
    const { id } = params
    const body = await request.json()
    const { action, slideIndex } = body as { action: 'next' | 'prev' | 'goto'; slideIndex?: number }

    if (!action || !['next', 'prev', 'goto'].includes(action)) {
      return { status: 400, body: { error: 'Invalid action. Must be "next", "prev", or "goto".' } }
    }

    const state = await presentationManager.navigate(id, action, slideIndex)

    return { status: 200, body: state }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('not found')) {
      return { status: 404, body: { error: message } }
    }
    logger.error(`Navigation failed: ${message}`)
    return { status: 500, body: { error: message } }
  }
}
