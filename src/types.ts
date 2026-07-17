import type {
  IBaseComponent,
  IConfigComponent,
  ILoggerComponent,
  IMetricsComponent
} from '@well-known-components/interfaces'
import type { IFetchComponent, IHttpServerComponent } from '@dcl/core-commons'
import type { IFileProviderComponent } from './adapters/file-provider'
import type { IGoogleDriveComponent } from './adapters/google-drive'
import type { ILiveKitPublisherComponent } from './adapters/livekit-publisher'
import type { IRendererComponent } from './adapters/pdf-renderer'
import type { IVideoCompositorComponent } from './adapters/video-compositor'
import type { ILiveKitTokenVerifier } from './logic/livekit-token-verifier'
import type { INetworkValidatorComponent } from './logic/network-validator'
import type { IPresentationManager } from './logic/presentation-manager'
import type { metricDeclarations } from './metrics'

export interface GlobalContext {
  components: BaseComponents
}

// components used in every environment
export interface BaseComponents {
  config: IConfigComponent
  logs: ILoggerComponent
  server: IHttpServerComponent<GlobalContext>
  metrics: IMetricsComponent<keyof typeof metricDeclarations>
  fetcher: IFetchComponent
  presentationManager: IPresentationManager
  googleDrive: IGoogleDriveComponent
  fileProvider: IFileProviderComponent
  liveKitPublisher: ILiveKitPublisherComponent
  liveKitTokenVerifier: ILiveKitTokenVerifier
  pdfRenderer: IRendererComponent
  pptxRenderer: IRendererComponent
  videoCompositor: IVideoCompositorComponent
  networkValidator: INetworkValidatorComponent
}

// components used in runtime
export type AppComponents = BaseComponents & {
  statusChecks: IBaseComponent
}

// components used in tests
export type TestComponents = BaseComponents & {
  // A fetch component that only hits the test server
  localFetch: IFetchComponent
}

// this type simplifies the typings of http handlers
export type HandlerContextWithPath<
  ComponentNames extends keyof AppComponents,
  Path extends string = string
> = IHttpServerComponent.PathAwareContext<
  IHttpServerComponent.DefaultContext<{
    components: Pick<AppComponents, ComponentNames>
  }>,
  Path
>

export type Context<Path extends string = string> = IHttpServerComponent.PathAwareContext<GlobalContext, Path>
