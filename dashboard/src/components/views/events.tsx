import { Fragment, useMemo } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToneText, DetailItem } from '@/components/shared/bits'
import { Badge } from '@/components/ui/badge'
import {
  detailText,
  eventDurationText,
  eventKey,
  eventMatchesFilters,
  eventOk,
  normalizeServers,
  statusText,
  statusTone,
  targetListText,
  targetText,
} from '@/lib/events'
import { truncateText } from '@/lib/format'
import type { RuntimeEvent } from '@/types'
import { cn } from '@/lib/utils'

const TYPE_OPTIONS = [
  ['', 'All'],
  ['tool_call', 'Tool call'],
  ['tool_call_lifecycle', 'Tool lifecycle'],
  ['http_request', 'HTTP'],
  ['tool_suite_changed', 'Tool suite'],
  ['config_reload', 'Config reload'],
] as const

const STATUS_OPTIONS = [
  ['', 'All'],
  ['ok', 'OK'],
  ['in_flight', 'In flight'],
  ['client_aborted', 'Client aborted'],
  ['downstream_error', 'Downstream error'],
  ['error', 'Error'],
] as const

function EventDetail({ event }: { event: RuntimeEvent }) {
  const items: { label: string; value: React.ReactNode }[] = []
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    if (typeof value === 'number' && value === 0) return
    items.push({ label, value: String(value) })
  }
  items.push({ label: 'Type', value: event.type })
  items.push({ label: 'Status', value: statusText(event, event.success !== false) })
  add('Request id', event.requestId)
  add('Session id', event.sessionId)
  add('HTTP', event.method ? event.method + ' ' + (event.path || '') : '')
  add('Lifecycle', event.lifecycle)
  add('JSON-RPC', [event.jsonRpcMethod, event.jsonRpcTool].filter(Boolean).join(' / '))
  add('Tool kind', event.toolKind === 'callmux_meta' ? 'callmux meta' : event.toolKind)
  add('Operation', event.operation)
  if (event.outputFormat) {
    items.push({
      label: 'Output format',
      value: <Badge variant="secondary" className="uppercase">{event.outputFormat}</Badge>,
    })
  }
  if (event.cacheHit) add('Cache', 'hit')
  add('Passthrough tool calls', event.passthroughToolCalls)
  add('Callmux meta tool calls', event.callmuxMetaToolCalls ?? event.callmuxToolCalls)
  add('Callmux downstream calls', event.callmuxDownstreamToolCalls)
  add('Total downstream calls', event.totalDownstreamToolCalls ?? event.realToolCalls)
  if (Array.isArray(event.downstreamTargets) && event.downstreamTargets.length) {
    add('Downstream targets', targetListText(event.downstreamTargets))
  }
  add('Added tools', event.addedTools?.length ? event.addedTools.join(', ') : '')
  add('Removed tools', event.removedTools?.length ? event.removedTools.join(', ') : '')
  add('Tool suite generation', event.generation)
  if (event.durationMs !== undefined) add('Duration', event.durationMs + 'ms')
  add('Error', event.error)

  return (
    <div className="bg-muted/40 p-3">
      <h3 className="mb-2 text-sm font-semibold">Event details</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
        {items.map((item, i) => (
          <DetailItem key={i} label={item.label} value={item.value} />
        ))}
      </div>
    </div>
  )
}

export function EventsView() {
  const snapshot = useStore((s) => s.snapshot)
  const filters = useStore((s) => s.filters)
  const setFilter = useStore((s) => s.setFilter)
  const hideAgentStatus = useStore((s) => s.hideAgentStatus)
  const hideTransportHttp = useStore((s) => s.hideTransportHttp)
  const setHideAgentStatus = useStore((s) => s.setHideAgentStatus)
  const setHideTransportHttp = useStore((s) => s.setHideTransportHttp)
  const selectedEventKey = useStore((s) => s.selectedEventKey)
  const toggleEvent = useStore((s) => s.toggleEvent)

  const allEvents = snapshot?.events ?? []
  const servers = normalizeServers(snapshot?.status)

  const displayed = useMemo(
    () =>
      allEvents
        .filter((event) => eventMatchesFilters(event, { hideAgentStatus, hideTransportHttp, filters }))
        .slice(-80)
        .reverse(),
    [allEvents, hideAgentStatus, hideTransportHttp, filters],
  )

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Recent Events</h2>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={hideAgentStatus} onCheckedChange={setHideAgentStatus} /> Hide agent status
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch checked={hideTransportHttp} onCheckedChange={setHideTransportHttp} /> Hide transport HTTP
          </label>
        </div>
      </div>

      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select value={filters.type || '__all'} onValueChange={(v) => setFilter({ type: v === '__all' ? '' : v })}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value || '__all'}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select value={filters.status || '__all'} onValueChange={(v) => setFilter({ status: v === '__all' ? '' : v })}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value || '__all'}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Server</Label>
            <Select value={filters.server || '__all'} onValueChange={(v) => setFilter({ server: v === '__all' ? '' : v })}>
              <SelectTrigger size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All</SelectItem>
                {servers.map((server) => (
                  <SelectItem key={server.name} value={server.name}>
                    {server.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 sm:col-span-3">
            <Label className="text-xs text-muted-foreground">Search</Label>
            <Input
              type="search"
              placeholder="Tool, path, error"
              value={filters.search}
              onChange={(e) => setFilter({ search: e.target.value })}
            />
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="w-[82px] p-2 font-semibold">Time</th>
              <th className="w-[110px] p-2 font-semibold">Type</th>
              <th className="p-2 font-semibold">Target</th>
              <th className="w-[82px] p-2 font-semibold">Duration</th>
              <th className="w-[104px] p-2 font-semibold">Status</th>
              <th className="p-2 font-semibold">Detail</th>
            </tr>
          </thead>
          <tbody>
            {displayed.length === 0 && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-muted-foreground">
                  No events match the current filters.
                </td>
              </tr>
            )}
            {displayed.map((event) => {
              const key = eventKey(event)
              const ok = eventOk(event)
              const selected = key === selectedEventKey
              return (
                <Fragment key={key}>
                  <tr
                    onClick={() => toggleEvent(key)}
                    className={cn(
                      'cursor-pointer border-t border-border align-top hover:bg-muted/40',
                      selected && 'bg-muted/60',
                    )}
                  >
                    <td className="p-2 text-muted-foreground">{new Date(event.timestamp).toLocaleTimeString()}</td>
                    <td className="p-2">{event.type}</td>
                    <td className="p-2 break-words">{targetText(event)}</td>
                    <td className="p-2">{eventDurationText(event)}</td>
                    <td className="p-2">
                      <ToneText tone={statusTone(event, ok)}>{statusText(event, ok)}</ToneText>
                    </td>
                    <td className="p-2 text-muted-foreground">{truncateText(detailText(event))}</td>
                  </tr>
                  {selected && (
                    <tr className="border-t border-border">
                      <td colSpan={6} className="p-0">
                        <EventDetail event={event} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
