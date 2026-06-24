// Event-derivation + filtering logic ported from the vanilla dashboard. Pure
// functions over RuntimeEvent so the Events view and overview share one source
// of truth for status/target/detail text and the filter predicate.

import type { EventFilters, RuntimeEvent, ServerInfo, StatusSnapshot } from '@/types'

export function eventKey(event: RuntimeEvent): string {
  return [event.timestamp, event.type, event.requestId || event.tool || event.path || ''].join('|')
}

export function targetText(event: RuntimeEvent): string {
  if (event.type === 'tool_call' || event.type === 'tool_call_lifecycle') {
    return (event.server ? event.server + '__' : '') + (event.targetTool || event.tool)
  }
  if (event.type === 'tool_suite_changed') return event.server ?? ''
  return event.jsonRpcTool || event.path || 'config'
}

export function downstreamCallCount(event: RuntimeEvent): number {
  return Number(
    event.totalDownstreamToolCalls ?? event.realToolCalls ?? event.callmuxDownstreamToolCalls ?? 0,
  )
}

export function eventDurationText(event: RuntimeEvent): string {
  return event.durationMs !== undefined ? event.durationMs + 'ms' : ''
}

export function detailText(event: RuntimeEvent): string {
  if (event.error) return event.error
  if (event.type === 'tool_call_lifecycle') {
    return event.lifecycle === 'client_aborted'
      ? 'client disconnected before completion'
      : 'call exceeded timeout while still in flight'
  }
  if (event.status === 'error' || event.success === false) return 'error'
  if (event.status === 'downstream_error') return 'downstream error'
  if (event.type === 'tool_call' && event.toolKind === 'callmux_meta') {
    const downstream = downstreamCallCount(event)
    return downstream > 1 ? downstream + ' downstream calls' : ''
  }
  if (event.type === 'tool_suite_changed') {
    return [
      'gen ' + event.generation,
      event.addedTools?.length ? '+' + event.addedTools.join(',') : '',
      event.removedTools?.length ? '-' + event.removedTools.join(',') : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  return ''
}

export function statusText(event: RuntimeEvent, ok: boolean): string {
  return String(event.status ?? (ok ? 'ok' : 'error')).replace(/_/g, ' ')
}

export type StatusTone = 'ok' | 'warn' | 'bad'

export function statusTone(event: RuntimeEvent, ok: boolean): StatusTone {
  if (event.status === 'downstream_error') return 'warn'
  if (event.status === 'in_flight' || event.status === 'client_aborted') return 'warn'
  return ok ? 'ok' : 'bad'
}

export function eventOk(event: RuntimeEvent): boolean {
  return event.type === 'http_request'
    ? Number(event.status) < 400
    : event.status !== 'error' && event.success !== false
}

export function eventStatus(event: RuntimeEvent): string {
  return statusText(event, eventOk(event))
}

export function isTransportHttpEvent(event: RuntimeEvent): boolean {
  if (event.type !== 'http_request' || !['/mcp', '/sse', '/messages'].includes(event.path ?? '')) {
    return false
  }
  const status = Number(event.status ?? 0)
  if (status < 400) return true
  return status === 499 && (event.path === '/sse' || (event.path === '/mcp' && event.method === 'GET'))
}

export function isAgentStatusEvent(event: RuntimeEvent): boolean {
  const text = [event.type, targetText(event), detailText(event), event.error, event.jsonRpcMethod, event.jsonRpcTool]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  if (/\bagent\s+(ready|idle|busy)\b/.test(text)) return true
  return (
    event.type === 'http_request' &&
    Number(event.status ?? 0) < 400 &&
    !event.jsonRpcTool &&
    ['initialize', 'notifications/initialized', 'tools/list'].includes(event.jsonRpcMethod ?? '')
  )
}

export interface EventFilterContext {
  hideAgentStatus: boolean
  hideTransportHttp: boolean
  filters: EventFilters
}

export function eventMatchesFilters(event: RuntimeEvent, ctx: EventFilterContext): boolean {
  const { hideAgentStatus, hideTransportHttp, filters } = ctx
  if (hideAgentStatus && isAgentStatusEvent(event)) return false
  if (hideTransportHttp && isTransportHttpEvent(event)) return false
  if (filters.type && event.type !== filters.type) return false
  if (filters.status && eventStatus(event) !== filters.status.replace(/_/g, ' ')) return false
  if (filters.server) {
    const targets = Array.isArray(event.downstreamTargets) ? event.downstreamTargets : []
    const matchesServer =
      event.server === filters.server ||
      targets.some((target) => target.server === filters.server) ||
      (event.type === 'tool_suite_changed' && event.server === filters.server)
    if (!matchesServer) return false
  }
  if (filters.search) {
    const needle = filters.search.toLowerCase()
    const haystack = [event.type, targetText(event), detailText(event), event.error, event.jsonRpcMethod, event.jsonRpcTool]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(needle)) return false
  }
  return true
}

// status.servers arrives as either an array or a name-keyed object; normalize.
export function normalizeServers(status: StatusSnapshot | undefined): ServerInfo[] {
  const raw = status?.servers
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([name, server]) => ({ name, ...(server as object) }) as ServerInfo)
  }
  return []
}

export function targetListText(targets: { server?: string; tool: string; count: number }[] | undefined): string {
  if (!Array.isArray(targets) || targets.length === 0) return 'None'
  return targets
    .map(
      (target) =>
        (target.server ? target.server + '__' : '') +
        target.tool +
        (target.count === 0 ? ' planned, 0 calls' : ' x' + target.count),
    )
    .join(', ')
}
