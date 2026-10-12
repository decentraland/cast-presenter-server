import type { IBaseComponent } from '@well-known-components/interfaces'
import type { ClientVideo } from '../../logic/client-video'

/** Resolves the duration of client-played videos without API keys. */
export interface IVideoDurationComponent extends IBaseComponent {
  /**
   * Looks up a client-played video's duration; never throws.
   *
   * @param video - A video classified by `classifyClientVideo`
   * @returns The duration in milliseconds, or `null` when it is unknown
   */
  getDurationMs(video: ClientVideo): Promise<number | null>
}
