import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher } from '../livekit-publisher/types'

export interface SlideVideoInfo {
  url: string
  geometry: { x: number; y: number; width: number; height: number }
}

export interface IVideoCompositor {
  downloadVideo(url: string): Promise<string>
  resolveStreamUrl(url: string): Promise<string>
  preTranscode(inputPath: string, width: number, height: number): Promise<string>
  startPlayback(
    videoPath: string,
    videoInfo: SlideVideoInfo,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    publisher: ILiveKitPublisher
  ): Promise<void>
  pausePlayback(): void
  resumePlayback(): void
  onEnd(callback: () => void): void
  getIsPlaying(): boolean
  cleanup(): void
}

export interface IVideoCompositorComponent {
  createCompositor(logger: ILoggerComponent.ILogger, tempDir?: string): IVideoCompositor
  destroyTempDir(tempDir: string): void
}
