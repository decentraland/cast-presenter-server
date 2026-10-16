/**
 * Describes an unknown thrown value for logging and error propagation.
 *
 * @param err - The caught value
 * @returns `err.message` when `err` is an Error, otherwise its string form
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
