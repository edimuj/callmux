// Endpoint resolution + fetch helpers. The dashboard ships as one static HTML
// doc served at whatever path callmux is mounted on (default /dashboard, but
// also "/" or a reverse-proxy subpath). So every endpoint is derived from
// window.location at runtime — there is no build-time base — exactly like the
// vanilla dashboard's dashboardEndpoint().

import type { DashboardSnapshot, DrilldownResponse, MetricsRange, SeriesResponse } from '@/types'

export function dashboardEndpoint(name: string): string {
  const path = window.location.pathname || '/'
  const base = path.endsWith('/') ? path : path + '/'
  return new URL(name, window.location.origin + base).pathname
}

export async function fetchSnapshot(): Promise<DashboardSnapshot> {
  const res = await fetch(dashboardEndpoint('data'), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

export async function fetchSeries(range: MetricsRange): Promise<SeriesResponse | null> {
  const res = await fetch(dashboardEndpoint('series') + '?range=' + encodeURIComponent(range), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  const data = (await res.json()) as { series?: SeriesResponse }
  return data.series ?? null
}

export async function fetchDrilldown(range: MetricsRange): Promise<DrilldownResponse | null> {
  const res = await fetch(dashboardEndpoint('drilldown') + '?range=' + encodeURIComponent(range), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) return null
  return res.json()
}

export function openEventStream(onMessage: () => void, onError: () => void): EventSource {
  const stream = new EventSource(dashboardEndpoint('events'))
  stream.onmessage = onMessage
  stream.onerror = onError
  return stream
}

// --- Management API (write actions) -----------------------------------------
// The management base path comes from the snapshot; combine it with the
// reverse-proxy mount prefix the dashboard is served under.

const DEFAULT_DASHBOARD_PATH = '/dashboard'

function externalMountPrefix(configuredPath: string): string {
  const pagePath = (window.location.pathname || configuredPath || '/').replace(/\/+$/, '') || '/'
  const dashboardPath = (configuredPath || '/').replace(/\/+$/, '') || '/'
  if (dashboardPath === '/') {
    return pagePath === '/' ? '' : pagePath
  }
  return pagePath.endsWith(dashboardPath) ? pagePath.slice(0, -dashboardPath.length).replace(/\/+$/, '') : ''
}

function managementUrl(path: string, managementBasePath: string, configuredPath: string): string {
  const base = (managementBasePath || '/management/v1').replace(/\/+$/, '')
  const prefix = externalMountPrefix(configuredPath)
  const normalized = prefix + base + (path ? '/' + path.replace(/^\/+/, '') : '')
  return new URL(normalized, window.location.origin).toString()
}

export interface ManagementContext {
  token: string
  basePath: string
  // configuredPath is unknown to a static bundle, so default the dashboard mount
  // to its conventional value; the mount prefix math still works for "/" mounts.
  configuredPath?: string
}

export async function managementRequest(
  path: string,
  ctx: ManagementContext,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const url = managementUrl(path, ctx.basePath, ctx.configuredPath ?? DEFAULT_DASHBOARD_PATH)
  const method = options.method || 'GET'
  const headers: Record<string, string> = { Accept: 'application/json', ...(options.headers || {}) }
  if (ctx.token) headers.Authorization = 'Bearer ' + ctx.token
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await res.text()
  let payload: unknown = {}
  try {
    payload = text ? JSON.parse(text) : {}
  } catch {
    payload = text || {}
  }
  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : typeof payload === 'string' && payload
          ? payload
          : 'HTTP ' + res.status
    throw new Error(method + ' ' + url + ' -> HTTP ' + res.status + ': ' + message)
  }
  return payload
}
