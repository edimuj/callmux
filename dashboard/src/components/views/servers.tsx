import { useEffect } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ToneText, DetailItem } from '@/components/shared/bits'
import { normalizeServers } from '@/lib/events'
import { formatBytes, formatDateTime, formatNum } from '@/lib/format'
import type { MetricsServer, ServerInfo } from '@/types'
import { cn } from '@/lib/utils'

function toolCountOf(server: ServerInfo): number {
  return server.toolCount ?? server.exposedTools ?? (Array.isArray(server.tools) ? server.tools.length : 0)
}

function ToolChips({ tools }: { tools: ServerInfo['tools'] }) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return <span className="text-sm text-muted-foreground">No exposed tools</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((tool, i) => (
        <Badge key={i} variant="secondary">
          {typeof tool === 'string' ? tool : tool.name}
        </Badge>
      ))}
    </div>
  )
}

function ServerStats({ stat }: { stat: MetricsServer }) {
  const avg = stat.calls > 0 ? Math.round(stat.totalDurationMs / stat.calls) : 0
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
      <DetailItem label="Calls" value={formatNum(stat.calls)} />
      {stat.errors ? <DetailItem label="Errors" value={formatNum(stat.errors)} /> : null}
      <DetailItem label="Downstream" value={formatNum(stat.downstream)} />
      <DetailItem label="Avg duration" value={avg + 'ms'} />
      <DetailItem label="Bytes out" value={formatBytes(stat.bytesOut)} />
    </div>
  )
}

function ServerDetail({ server, stat }: { server: ServerInfo | undefined; stat?: MetricsServer }) {
  if (!server) return <div className="text-sm text-muted-foreground">Select a server for details.</div>
  const total = server.totalTools ?? toolCountOf(server)
  const lastError = server.lastError ?? server.error
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold">{server.name}</h3>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
        <DetailItem label="State" value={server.state} />
        <DetailItem label="Transport" value={server.transport} />
        <DetailItem label="Tools" value={`${toolCountOf(server)}/${total}`} />
        {server.connectDurationMs !== undefined && <DetailItem label="Connect latency" value={server.connectDurationMs + 'ms'} />}
        {server.lastConnectedAt && <DetailItem label="Last connected" value={formatDateTime(server.lastConnectedAt)} />}
        {server.lastFailureAt && <DetailItem label="Last failure" value={formatDateTime(server.lastFailureAt)} />}
        {server.nextRetryAt && <DetailItem label="Next retry" value={formatDateTime(server.nextRetryAt)} />}
        {lastError && <DetailItem label="Last error" value={lastError} />}
      </div>
      {stat && (
        <div>
          <h4 className="mt-3 mb-1.5 text-sm font-semibold">Traffic</h4>
          <ServerStats stat={stat} />
        </div>
      )}
      <div>
        <h4 className="mt-3 mb-1.5 text-sm font-semibold">Tools</h4>
        <ToolChips tools={server.tools} />
      </div>
    </div>
  )
}

export function ServersView() {
  const snapshot = useStore((s) => s.snapshot)
  const selectedServer = useStore((s) => s.selectedServer)
  const selectServer = useStore((s) => s.selectServer)

  const servers = normalizeServers(snapshot?.status)
  const statsMap: Record<string, MetricsServer> = {}
  for (const stat of snapshot?.metrics?.servers ?? []) statsMap[stat.server] = stat

  // Default selection to the first server once data arrives.
  useEffect(() => {
    if (!selectedServer && servers.length > 0) selectServer(servers[0].name)
  }, [selectedServer, servers, selectServer])

  const active = servers.find((server) => server.name === selectedServer)

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="overflow-hidden p-0">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-2 font-semibold">Server</th>
              <th className="p-2 font-semibold">State</th>
              <th className="p-2 font-semibold">Transport</th>
              <th className="p-2 font-semibold">Tools</th>
              <th className="p-2 font-semibold">Calls</th>
              <th className="p-2 font-semibold">Errors</th>
              <th className="p-2 font-semibold">Latency</th>
            </tr>
          </thead>
          <tbody>
            {servers.length === 0 && (
              <tr>
                <td colSpan={7} className="p-4 text-center text-muted-foreground">
                  No servers configured.
                </td>
              </tr>
            )}
            {servers.map((server) => {
              const stat = statsMap[server.name]
              const total = server.totalTools ?? toolCountOf(server)
              return (
                <tr
                  key={server.name}
                  onClick={() => selectServer(server.name)}
                  className={cn(
                    'cursor-pointer border-t border-border hover:bg-muted/40',
                    server.name === selectedServer && 'bg-muted/60',
                  )}
                >
                  <td className="p-2">{server.name}</td>
                  <td className="p-2">
                    <ToneText tone={server.state === 'connected' ? 'ok' : 'bad'}>{server.state}</ToneText>
                  </td>
                  <td className="p-2">{server.transport}</td>
                  <td className="p-2">{toolCountOf(server)}/{total}</td>
                  <td className="p-2">{stat ? formatNum(stat.calls) : '0'}</td>
                  <td className="p-2">
                    <ToneText tone={stat && stat.errors > 0 ? 'bad' : 'muted'}>{stat ? formatNum(stat.errors) : '0'}</ToneText>
                  </td>
                  <td className="p-2">{server.connectDurationMs === undefined ? '' : server.connectDurationMs + 'ms'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      <Card className="p-4">
        <ServerDetail server={active} stat={active ? statsMap[active.name] : undefined} />
      </Card>
    </div>
  )
}
