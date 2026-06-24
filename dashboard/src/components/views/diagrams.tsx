import { useEffect } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { ApexArea, type ApexSeries } from '@/components/charts/apex-area'
import { BarMeter, SectionTitle, EmptyChart } from '@/components/shared/bits'
import { RangeBar } from '@/components/shared/range-bar'
import { normalizeServers } from '@/lib/events'
import { formatBytes } from '@/lib/format'
import type { RuntimeEvent, SeriesPoint } from '@/types'

const COLORS = {
  downstream: '#a78bfa',
  passthrough: '#34d399',
  meta: '#38bdf8',
  bytesOut: '#f59e0b',
  bytesIn: '#38bdf8',
  cacheHits: '#34d399',
  errors: '#f87171',
}

function pick(points: SeriesPoint[], key: keyof SeriesPoint, color: string, name: string): ApexSeries {
  return { name, color, data: points.map((p) => [p.t, Number(p[key] ?? 0)] as [number, number]) }
}

// Build the 2-minute live traffic series (24 × 5s buckets) from the event ring.
function liveTrafficSeries(events: RuntimeEvent[]): ApexSeries[] {
  const now = Date.now()
  const bucketMs = 5000
  const bucketCount = 24
  const meta = new Array(bucketCount).fill(0)
  const passthrough = new Array(bucketCount).fill(0)
  const downstream = new Array(bucketCount).fill(0)
  for (const event of events) {
    if (event.type !== 'tool_call') continue
    const ts = new Date(event.timestamp).getTime()
    if (!Number.isFinite(ts)) continue
    const age = now - ts
    if (age < 0 || age >= bucketMs * bucketCount) continue
    const i = bucketCount - 1 - Math.floor(age / bucketMs)
    if (event.toolKind === 'callmux_meta') meta[i] += 1
    else passthrough[i] += 1
    downstream[i] += Number(event.totalDownstreamToolCalls ?? event.realToolCalls ?? 1)
  }
  const base = now - (bucketCount - 1) * bucketMs
  const toData = (arr: number[]): [number, number][] => arr.map((v, j) => [base + j * bucketMs, v])
  return [
    { name: 'Downstream', color: COLORS.downstream, data: toData(downstream) },
    { name: 'Passthrough', color: COLORS.passthrough, data: toData(passthrough) },
    { name: 'Meta', color: COLORS.meta, data: toData(meta) },
  ]
}

export function DiagramsView() {
  const snapshot = useStore((s) => s.snapshot)
  const series = useStore((s) => s.series)
  const loadSeries = useStore((s) => s.loadSeries)
  // Charts read theme-derived axis/grid colors at mount; remount on theme change.
  const theme = useStore((s) => s.theme)

  useEffect(() => {
    void loadSeries()
  }, [loadSeries])

  const points = series?.points ?? []
  const status = snapshot?.status ?? {}
  const summary = snapshot?.summary
  const servers = normalizeServers(status)
  const events = snapshot?.events ?? []

  const maxCalls = Math.max(
    1,
    summary?.totalDownstreamToolCalls ?? summary?.realToolCalls ?? 0,
    summary?.passthroughToolCalls ?? 0,
    summary?.callmuxDownstreamToolCalls ?? 0,
  )
  const connected = servers.filter((s) => s.state === 'connected').length
  const failed = (status.failedServers?.length as number) ?? 0
  const degraded = servers.length - connected + failed
  const serverMax = Math.max(1, servers.length + failed)
  const cacheEntries = status.cache?.entries ?? 0
  const storedRefs = status.responseStore?.entries ?? 0

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-4">
        <RangeBar />
        {points.length === 0 ? (
          <EmptyChart>No metrics recorded yet</EmptyChart>
        ) : (
          <div className="grid gap-5 lg:grid-cols-3">
            <div>
              <h3 className="text-sm font-medium">Tool Calls</h3>
              <p className="mb-1 text-xs text-muted-foreground">meta vs passthrough vs real downstream</p>
              <ApexArea
                key={`calls-${theme}`}
                ariaLabel="Tool calls over time"
                height={220}
                series={[
                  pick(points, 'downstream', COLORS.downstream, 'Downstream'),
                  pick(points, 'passthrough', COLORS.passthrough, 'Passthrough'),
                  pick(points, 'meta', COLORS.meta, 'Meta'),
                ]}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium">Data Volume</h3>
              <p className="mb-1 text-xs text-muted-foreground">bytes in / out through callmux</p>
              <ApexArea
                key={`bytes-${theme}`}
                ariaLabel="Data volume over time"
                height={220}
                yFormatter={formatBytes}
                series={[pick(points, 'bytesOut', COLORS.bytesOut, 'Out'), pick(points, 'bytesIn', COLORS.bytesIn, 'In')]}
              />
            </div>
            <div>
              <h3 className="text-sm font-medium">Cache &amp; Errors</h3>
              <p className="mb-1 text-xs text-muted-foreground">cache hits vs errors</p>
              <ApexArea
                key={`cache-${theme}`}
                ariaLabel="Cache hits and errors over time"
                height={220}
                series={[pick(points, 'cacheHits', COLORS.cacheHits, 'Cache hits'), pick(points, 'errors', COLORS.errors, 'Errors')]}
              />
            </div>
          </div>
        )}
      </Card>

      <div>
        <SectionTitle>Live (last 2 minutes)</SectionTitle>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h2 className="mb-2 text-lg font-semibold">Tool Call Traffic</h2>
            <ApexArea key={`live-${theme}`} ariaLabel="Tool call traffic" height={220} series={liveTrafficSeries(events)} />
          </Card>
          <Card className="space-y-2.5 p-4">
            <h2 className="text-lg font-semibold">Tool Call Mix</h2>
            <BarMeter label="Passthrough" value={summary?.passthroughToolCalls ?? 0} max={maxCalls} />
            <BarMeter label="Meta fan-out" value={summary?.callmuxDownstreamToolCalls ?? 0} max={maxCalls} />
            <BarMeter label="Total downstream" value={summary?.totalDownstreamToolCalls ?? summary?.realToolCalls ?? 0} max={maxCalls} />
          </Card>
          <Card className="space-y-2.5 p-4">
            <h2 className="text-lg font-semibold">Runtime Buffers</h2>
            <BarMeter label="Cache entries" value={cacheEntries} max={Math.max(1, status.cache?.maxEntries ?? cacheEntries)} />
            <BarMeter label="Stored refs" value={storedRefs} max={Math.max(1, status.responseStore?.maxEntries ?? storedRefs)} />
          </Card>
          <Card className="space-y-2.5 p-4">
            <h2 className="text-lg font-semibold">Downstream Health</h2>
            <BarMeter label="Connected" value={connected} max={serverMax} tone="ok" />
            <BarMeter label="Degraded/down" value={degraded} max={serverMax} tone="bad" />
          </Card>
        </div>
      </div>
    </div>
  )
}
