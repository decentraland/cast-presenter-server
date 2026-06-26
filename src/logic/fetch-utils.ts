/**
 * Cancels an unread fetch response body so the underlying socket is released.
 *
 * Native fetch (undici) keeps the connection pinned until the response body is
 * read or cancelled. When a caller discards a response without consuming its
 * body (e.g. on an error branch), call this to avoid leaking sockets.
 */
export async function drainResponse(response: {
  bodyUsed: boolean
  body?: { cancel(): Promise<void> } | null
}): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined)
  }
}
