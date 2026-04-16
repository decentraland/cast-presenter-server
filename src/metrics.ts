import { getDefaultHttpMetrics } from '@well-known-components/http-server'
import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logsMetricsDeclarations } from '@well-known-components/logger'
import { validateMetricsDeclaration } from '@well-known-components/metrics'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logsMetricsDeclarations,
  test_ping_counter: {
    help: 'Count calls to ping',
    type: IMetricsComponent.CounterType,
    labelNames: ['pathname']
  },
  active_sessions: {
    help: 'Number of active presentation sessions',
    type: IMetricsComponent.GaugeType,
    labelNames: [] as string[]
  },
  session_created_total: {
    help: 'Total presentation sessions created',
    type: IMetricsComponent.CounterType,
    labelNames: ['status']
  },
  slide_navigations_total: {
    help: 'Total slide navigation events',
    type: IMetricsComponent.CounterType,
    labelNames: ['action']
  },
  video_playback_total: {
    help: 'Total video playback events',
    type: IMetricsComponent.CounterType,
    labelNames: ['action']
  },
  livekit_connection_errors_total: {
    help: 'Total LiveKit connection errors',
    type: IMetricsComponent.CounterType,
    labelNames: [] as string[]
  },
  idle_session_cleanups_total: {
    help: 'Total sessions cleaned up due to idle timeout',
    type: IMetricsComponent.CounterType,
    labelNames: [] as string[]
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
