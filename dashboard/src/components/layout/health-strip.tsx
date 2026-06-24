import { useStore } from '@/store'
import { normalizeServers } from '@/lib/events'
import { cn } from '@/lib/utils'

function pillClass(tone: 'ok' | 'warn' | 'bad'): string {
  return {
    ok: 'bg-emerald-500/15 text-emerald-400',
    warn: 'bg-amber-500/15 text-amber-300',
    bad: 'bg-red-500/15 text-red-300',
  }[tone]
}

export function HealthStrip() {
  const snapshot = useStore((s) => s.snapshot)
  const connected = useStore((s) => s.connected)
  const lastUpdated = useStore((s) => s.lastUpdated)

  const status = snapshot?.status ?? {}
  const servers = normalizeServers(status)
  const statusValue = String(status.status || (connected ? 'unknown' : 'connecting'))
  const tone: 'ok' | 'warn' | 'bad' = statusValue === 'ok' ? 'ok' : statusValue === 'degraded' ? 'warn' : 'bad'
  const downCount =
    servers.filter((server) => server.state && server.state !== 'connected').length +
    ((status.failedServers?.length as number) ?? 0)

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {snapshot && lastUpdated ? 'Live · ' + new Date(lastUpdated).toLocaleTimeString() : 'Connecting…'}
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2 text-xs text-sidebar-foreground/80">
          <span>Readiness</span>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold uppercase', pillClass(tone))}>{statusValue}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-sidebar-foreground/80">
          <span>Downstream</span>
          <span>
            {downCount} issue{downCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs text-sidebar-foreground/80">
          <span>Tool suite</span>
          <span>gen {(status.toolSuiteGeneration as number) ?? 0}</span>
        </div>
      </div>
    </div>
  )
}
