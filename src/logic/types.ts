export interface SlideVideoInfo {
  url: string
  geometry: { x: number; y: number; width: number; height: number }
}

export interface PresentationSession {
  id: string
  roomId: string
  fileName: string
  fileType: 'pdf' | 'pptx'
  slideCount: number
  currentSlide: number
  createdAt: Date
  lastFrameBuffer: Buffer | null
  lastFrameWidth: number
  lastFrameHeight: number
  slideVideos: SlideVideoInfo[]
  videoState: 'idle' | 'loading' | 'playing' | 'paused'
}

export interface PresentationInfo {
  id: string
  fileName: string
  slideCount: number
  currentSlide: number
  fileType: 'pdf' | 'pptx'
}

export interface PresentationState {
  id: string
  fileName: string
  slideCount: number
  currentSlide: number
  fileType: 'pdf' | 'pptx'
  slideVideos: SlideVideoInfo[]
  videoState: 'idle' | 'loading' | 'playing' | 'paused'
}

export interface IPresentationManager {
  createPresentation(
    fileBuffer: Buffer,
    fileType: 'pdf' | 'pptx',
    livekitToken: string,
    livekitUrl: string,
    fileName?: string
  ): Promise<PresentationInfo>

  navigate(id: string, action: 'next' | 'prev' | 'goto', slideIndex?: number): Promise<PresentationState>

  getState(id: string): PresentationState | null

  playVideo(id: string, videoIndex: number): Promise<void>
  pauseVideo(id: string): Promise<void>

  stopPresentation(id: string): Promise<void>
}
