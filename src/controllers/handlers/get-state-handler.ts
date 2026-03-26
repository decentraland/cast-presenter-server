import type { IHttpServerComponent } from '@well-known-components/interfaces'
import type { HandlerContextWithPath } from '../../types'

export async function getStateHandler(
  context: HandlerContextWithPath<'presentationManager', '/presentations/:id'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { presentationManager },
    params
  } = context

  const state = presentationManager.getState(params.id)

  if (!state) {
    return { status: 404, body: { error: `Presentation ${params.id} not found` } }
  }

  return { status: 200, body: state }
}
