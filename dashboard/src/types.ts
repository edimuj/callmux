// Data shapes served by callmux's listener dashboard endpoints. These mirror
// the runtime types in src/dashboard.ts, src/metrics-store.ts and
// src/event-store.ts — kept loose (optional fields) because the snapshot is
// assembled from several sources and older fields linger for back-compat.

export type ToolStatus = 'ok' | 'downstream_error' | 'error'

export interface DownstreamTarget {
  server?: string
  tool: string
  count: number
}

export interface RuntimeEvent {
  type:
    | 'http_request'
    | 'tool_call'
    | 'tool_call_lifecycle'
    | 'config_reload'
    | 'tool_suite_changed'
  timestamp: string
  // http_request
  requestId?: string
  method?: string
  path?: string
  // tool_call / lifecycle
  tool?: string
  server?: string
  targetTool?: string
  toolKind?: 'callmux_meta' | 'downstream'
  operation?: string
  lifecycle?: 'client_aborted' | 'timeout_overrun'
  sessionId?: string
  status?: number | ToolStatus | 'client_aborted' | 'in_flight'
  success?: boolean
  cacheHit?: boolean
  outputFormat?: 'json' | 'toon'
  error?: string
  durationMs?: number
  timeoutMs?: number
  principal?: string
  // http_request: the 404 was a stale/unknown session rejection — expected
  // re-init churn (e.g. a burst after a restart), not a real error.
  sessionReinit?: boolean
  jsonRpcMethod?: string
  jsonRpcTool?: string
  jsonRpcRequestCount?: number
  passthroughToolCalls?: number
  callmuxMetaToolCalls?: number
  callmuxDownstreamToolCalls?: number
  totalDownstreamToolCalls?: number
  callmuxToolCalls?: number
  realToolCalls?: number
  downstreamTargets?: DownstreamTarget[]
  // tool_suite_changed
  generation?: number
  addedTools?: string[]
  removedTools?: string[]
}

export interface RuntimeSummary {
  eventCount: number
  totalEvents: number
  passthroughToolCalls: number
  callmuxMetaToolCalls: number
  callmuxDownstreamToolCalls: number
  totalDownstreamToolCalls: number
  callmuxToolCalls: number
  realToolCalls: number
  maxEvents: number
  recentErrors: number
}

export interface MetricsTotals {
  calls?: number
  meta?: number
  passthrough?: number
  downstream?: number
  cacheHits?: number
  errors?: number
  bytesIn?: number
  bytesOut?: number
  toonCalls?: number
  jsonCalls?: number
  toonSaved?: number
}

export interface MetricsServer {
  server: string
  calls: number
  errors: number
  downstream: number
  bytesOut: number
  totalDurationMs: number
  lastCallAt?: number
}

export interface MetricsSnapshot {
  startedAt: number
  totals: MetricsTotals
  servers: MetricsServer[]
}

export interface ServerInfo {
  name: string
  state?: string
  transport?: string
  toolCount?: number
  totalTools?: number
  exposedTools?: number
  tools?: (string | { name: string })[]
  addedTools?: string[]
  removedTools?: string[]
  connectDurationMs?: number
  lastConnectedAt?: number | string
  lastFailureAt?: number | string
  nextRetryAt?: number | string
  lastError?: string
  error?: string
  toolSuiteGeneration?: number
  lastToolSuiteChangeAt?: number | string
  managed?: boolean
  runtime?: { state?: string }
  config?: { disabled?: boolean }
}

export interface ActiveToolCall {
  tool?: string
  server?: string
  targetTool?: string
  requestId?: string
  sessionId?: string
  cwd?: string
  status?: string
  durationMs?: number
  downstreamTargets?: DownstreamTarget[]
}

export interface StatusSnapshot {
  status?: string
  failedServers?: unknown[]
  toolSuiteGeneration?: number
  lastToolSuiteChangeAt?: number | string
  servers?: ServerInfo[] | Record<string, Omit<ServerInfo, 'name'>>
  cache?: { enabled?: boolean; entries?: number; maxEntries?: number }
  responseStore?: { entries?: number; maxEntries?: number }
  listener?: {
    activeSessions?: number
    activeToolCallCount?: number
    activeToolCalls?: ActiveToolCall[]
    sessions?: { clientKind?: string; transport?: string }[]
  }
  [key: string]: unknown
}

export interface DashboardSnapshot {
  generatedAt: string
  dashboard?: { enabled: boolean; path: string }
  summary: RuntimeSummary
  status: StatusSnapshot
  management?: { enabled: boolean; path: string }
  managementServers?: ServerInfo[]
  metrics?: MetricsSnapshot
  events: RuntimeEvent[]
}

export type MetricsRange = '1h' | 'today' | 'yesterday' | '7d' | '30d'

export interface SeriesPoint extends MetricsTotals {
  t: number
}

export interface SeriesResponse {
  range: MetricsRange
  bucketMs: number
  from: number
  to: number
  points: SeriesPoint[]
  totals: MetricsTotals
}

export interface BreakdownRow {
  name: string
  calls: number
  errors: number
  avgDurationMs: number
  bytesIn: number
  bytesOut: number
  lastCallAt: string
}

export interface ForwardedHeaderRow {
  server: string
  tool: string
  sessionId: string
  principal: string
  headerName: string
  calls: number
  lastSeenAt: string
}

export interface DrilldownResponse {
  enabled: boolean
  reason?: string
  range?: MetricsRange
  from?: number
  to?: number
  totals?: {
    calls: number
    errors: number
    avgDurationMs: number
    bytesIn: number
    bytesOut: number
  }
  byServer?: BreakdownRow[]
  byTool?: BreakdownRow[]
  bySession?: BreakdownRow[]
  forwardedHeaders?: ForwardedHeaderRow[]
}

export type ThemeName = 'light' | 'dark' | 'midnight' | 'nord' | 'ember' | 'parchment'

export type ViewId =
  | 'overview'
  | 'servers'
  | 'management'
  | 'tools'
  | 'diagrams'
  | 'drilldown'
  | 'events'
  | 'runtime'

export interface EventFilters {
  type: string
  status: string
  server: string
  search: string
}
