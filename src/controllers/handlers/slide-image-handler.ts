import type { IHttpServerComponent } from '@dcl/core-commons'
import type { HandlerContextWithPath } from '../../types'

const SLIDE_FILE_PATTERN = /^([0-9a-f]{16})\.png$/

/**
 * Serves the cached PNG of a recently shown slide. Unauthenticated: the content hash is the capability.
 *
 * @param context - Request context with the `id` and `file` path params
 * @returns 200 with the PNG, or 404 when the file name is malformed or the image is not cached
 */
export async function slideImageHandler(
  context: Pick<
    HandlerContextWithPath<'presentationManager', '/presentations/:id/slides/:file'>,
    'params' | 'components'
  >
): Promise<IHttpServerComponent.IResponse> {
  const {
    params,
    components: { presentationManager }
  } = context

  const match = SLIDE_FILE_PATTERN.exec(params.file)
  if (!match) return { status: 404 }

  const png = presentationManager.getSlideImage(params.id, match[1])
  if (!png) return { status: 404 }

  return {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
    body: png
  }
}
