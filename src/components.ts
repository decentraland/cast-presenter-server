import { createDotEnvConfigComponent } from '@well-known-components/env-config-provider'
import { Verbosity, instrumentHttpServerWithRequestLogger } from '@well-known-components/http-requests-logger-component'
import {
  createServerComponent,
  createStatusCheckComponent,
  instrumentHttpServerWithPromClientRegistry
} from '@well-known-components/http-server'
import { createHttpTracerComponent } from '@well-known-components/http-tracer-component'
import { createLogComponent } from '@well-known-components/logger'
import { createMetricsComponent } from '@well-known-components/metrics'
import { createTracerComponent } from '@well-known-components/tracer-component'
import { createTracedFetcherComponent } from '@dcl/traced-fetch-component'
import { createFileProviderComponent } from './adapters/file-provider'
import { createGoogleDriveComponent } from './adapters/google-drive'
import { createLiveKitPublisherComponent } from './adapters/livekit-publisher'
import { createPdfRendererComponent } from './adapters/pdf-renderer'
import { createVideoCompositorComponent } from './adapters/video-compositor'
import { createNetworkValidatorComponent } from './logic/network-validator'
import { createPresentationManager } from './logic/presentation-manager'
import { metricDeclarations } from './metrics'
import type { AppComponents, GlobalContext } from './types'

// Initialize all the components of the app
export async function initComponents(): Promise<AppComponents> {
  const config = await createDotEnvConfigComponent({ path: ['.env.default', '.env'] })
  const metrics = await createMetricsComponent(metricDeclarations, { config })
  const tracer = await createTracerComponent()
  const fetcher = await createTracedFetcherComponent({ tracer })
  const logs = await createLogComponent({ metrics, tracer })
  const server = await createServerComponent<GlobalContext>(
    { config, logs },
    {
      cors: {
        maxAge: 36000
      }
    }
  )

  // Security headers middleware
  const securityHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'"
  }
  server.use(async (_ctx, next) => {
    const res = await next()
    return {
      ...res,
      headers: { ...securityHeaders, ...((res.headers as Record<string, string>) || {}) }
    }
  })

  const statusChecks = await createStatusCheckComponent({ server, config })
  createHttpTracerComponent({ server, tracer })
  instrumentHttpServerWithRequestLogger({ server, logger: logs }, { verbosity: Verbosity.INFO })

  if (!metrics.registry) {
    throw new Error('Metrics registry is not initialized')
  }

  await instrumentHttpServerWithPromClientRegistry({ metrics, server, config, registry: metrics.registry })

  // Logic components
  const networkValidator = createNetworkValidatorComponent()

  // Adapter components
  const googleDrive = await createGoogleDriveComponent({ config, fetcher })
  const fileProvider = createFileProviderComponent({ logs, networkValidator })

  const liveKitPublisher = createLiveKitPublisherComponent()
  const pdfRenderer = createPdfRendererComponent()
  const videoCompositor = createVideoCompositorComponent({ networkValidator })

  const presentationManager = await createPresentationManager({
    config,
    logs,
    liveKitPublisher,
    pdfRenderer,
    videoCompositor
  })

  return {
    fetcher,
    config,
    logs,
    server,
    statusChecks,
    metrics,
    presentationManager,
    googleDrive,
    fileProvider,
    liveKitPublisher,
    pdfRenderer,
    videoCompositor,
    networkValidator
  }
}
