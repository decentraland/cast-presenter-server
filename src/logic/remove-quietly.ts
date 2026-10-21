import * as fs from 'fs'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { errorMessage } from './error-message'

/**
 * Deletes a file if it exists, logging instead of throwing when the delete fails.
 *
 * @param filePath - Absolute path of the file to remove
 * @param logger - Logger that receives the failure warning
 */
export function removeQuietly(filePath: string, logger: ILoggerComponent.ILogger): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (err) {
    logger.warn('Failed to remove file', { filePath, error: errorMessage(err) })
  }
}
