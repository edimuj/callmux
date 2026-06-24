import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { MiniTable, ToneText } from '@/components/shared/bits'
import { normalizeServers, targetListText } from '@/lib/events'
import { cacheEntriesText, compactCount, fanoutCount, formatBytes, formatNum } from '@/lib/format'
import type { ActiveToolCall, MetricsSnapshot, StatusSnapshot, RuntimeSummary } from '@/types'
import { cn } from '@/lib/utils'

interface HeroCardDef {
  accent?: boolean
  label: string
  value: string
  sub: string
}

function heroCards(metrics: MetricsSnapshot | undefined): HeroCardDef[] {
  if (!metrics || !metrics.totals) return []
  const t = metrics.totals
  const calls = Number(t.calls || 0)
  const downstream = Number(t.downstream || 0)
  const saved = Math.max(0, downstream - calls)
  const ratio = calls > 0 ? downstream / calls : 1
  const cacheHits = Number(t.cacheHits || 0)
  const bytes = Number(t.bytesIn || 0) + Number(t.bytesOut || 0)
  return [
    {
      accent: true,
      label: 'Round-trips saved',
      value: formatNum(saved + cacheHits),
      sub:
        ratio >= 1.05
          ? ratio.toFixed(1) + 'x fan-out (' + formatNum(downstream) + ' downstream from ' + formatNum(calls) + ' calls)'
          : 'meta-tools + cache collapse calls into one',
    },
    { label: 'Cache hits', value: formatNum(cacheHits), sub: cacheHits > 0 ? 'downstream calls served from cache' : 'no cache hits yet' },
    { label: 'Data through callmux', value: formatBytes(bytes), sub: formatBytes(t.bytesIn) + ' in / ' + formatBytes(t.bytesOut) + ' out' },
    { label: 'Tool calls', value: formatNum(calls), sub: formatNum(t.meta) + ' meta / ' + formatNum(t.passthrough) + ' passthrough' },
  ]
}

function clientRows(status: StatusSnapshot): [string, number][] {
  const sessions = Array.isArray(status.listener?.sessions) ? status.listener!.sessions! : []
  const bridge = sessions.filter((s) => s.clientKind === 'stdio-bridge').length
  const sse = sessions.filter((s) => s.transport === 'sse').length
  const http = sessions.filter((s) => s.transport === 'streamable-http' && s.clientKind !== 'stdio-bridge').length
  return [
    ['HTTP', http],
    ['SSE', sse],
    ['STDIO Bridge', bridge],
  ]
}

function ActiveCall({ call }: { call: ActiveToolCall }) {
  const target = (call.server ? call.server + '__' : '') + (call.targetTool || call.tool)
  const meta = [
    call.requestId ? 'request ' + call.requestId : '',
    call.sessionId ? 'session ' + call.sessionId : '',
    call.cwd || '',
    targetListText(call.downstreamTargets),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border border-border p-2.5">
      <div>
        <strong className="text-sm">{target}</strong>
        <div className="mt-0.5 text-xs break-words text-muted-foreground">{meta}</div>
      </div>
      <div className="text-right">
        <ToneText tone={call.status === 'client_aborted' ? 'warn' : 'ok'}>
          {String(call.status || 'in_flight').replace(/_/g, ' ')}
        </ToneText>
        <div className="text-xs text-muted-foreground">{call.durationMs ?? 0}ms</div>
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="gap-1 p-3.5">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </Card>
  )
}

export function OverviewView() {
  const snapshot = useStore((s) => s.snapshot)
  const status = (snapshot?.status ?? {}) as StatusSnapshot
  const summary = snapshot?.summary as RuntimeSummary | undefined
  const servers = normalizeServers(status)
  const cache = status.cache ?? {}
  const responseStore = status.responseStore ?? {}
  const activeCalls = Array.isArray(status.listener?.activeToolCalls) ? status.listener!.activeToolCalls! : []

  const cards = heroCards(snapshot?.metrics)
  const passthrough = summary?.passthroughToolCalls ?? 0
  const metaCalls = summary?.callmuxMetaToolCalls ?? summary?.callmuxToolCalls ?? 0
  const metaDownstream = summary?.callmuxDownstreamToolCalls ?? 0

  const stats: [string, string | number][] = [
    ['Servers', servers.length],
    ['Sessions', status.listener?.activeSessions ?? 0],
    ['In-flight', status.listener?.activeToolCallCount ?? 0],
    ['Cache entries', cacheEntriesText(cache)],
    ['Stored refs', responseStore.entries ?? 0],
    ['Events', compactCount(summary?.totalEvents ?? summary?.eventCount)],
    ['Passthrough calls', compactCount(summary?.passthroughToolCalls ?? 0)],
    ['Meta calls / downstream', fanoutCount(metaCalls, metaDownstream)],
    ['Total downstream', compactCount(summary?.totalDownstreamToolCalls ?? summary?.realToolCalls)],
    ['Recent errors', summary?.recentErrors ?? 0],
  ]

  return (
    <div className="space-y-4.5">
      {cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => (
            <Card
              key={card.label}
              className={cn(
                'gap-2 p-4',
                card.accent && 'bg-gradient-to-br from-sky-400/15 to-transparent ring-sky-400/35',
              )}
            >
              <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{card.label}</div>
              <div className="text-3xl leading-none font-extrabold">{card.value}</div>
              <div className="text-xs text-muted-foreground">{card.sub}</div>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map(([label, value]) => (
          <StatCard key={label} label={label} value={value} />
        ))}
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-lg font-semibold">In-Flight Tool Calls</h2>
        {activeCalls.length === 0 ? (
          <div className="text-sm text-muted-foreground">No active tool calls</div>
        ) : (
          <div className="grid gap-2">
            {activeCalls.map((call, i) => (
              <ActiveCall key={i} call={call} />
            ))}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-lg font-semibold">Runtime Flow</h2>
        <div className="grid items-stretch gap-2.5 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <div className="grid gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
            <strong className="text-sm">Clients</strong>
            <MiniTable rows={clientRows(status)} empty="No active clients" />
          </div>
          <div className="flex items-center justify-center text-2xl font-bold text-muted-foreground max-md:rotate-90">→</div>
          <div className="grid gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
            <strong className="text-sm">callmux</strong>
            <MiniTable rows={[['Passthrough', passthrough], ['Meta calls', metaCalls]]} />
          </div>
          <div className="flex items-center justify-center text-2xl font-bold text-muted-foreground max-md:rotate-90">→</div>
          <div className="grid gap-1.5 rounded-lg border border-border bg-muted/30 p-3">
            <strong className="text-sm">MCP Servers</strong>
            <MiniTable rows={[['Passthrough', passthrough], ['Meta calls', metaDownstream]]} />
          </div>
        </div>
      </Card>
    </div>
  )
}
