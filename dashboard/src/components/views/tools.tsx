import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ToneText } from '@/components/shared/bits'
import { normalizeServers } from '@/lib/events'
import { formatDateTime } from '@/lib/format'
import type { ServerInfo } from '@/types'

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

export function ToolsView() {
  const snapshot = useStore((s) => s.snapshot)
  const status = snapshot?.status ?? {}
  const servers = normalizeServers(status)
  const changes = (snapshot?.events ?? [])
    .filter((event) => event.type === 'tool_suite_changed')
    .slice(-20)
    .reverse()

  return (
    <div className="space-y-4">
      {servers.map((server) => {
        const tools = Array.isArray(server.tools) ? server.tools : []
        const added = Array.isArray(server.addedTools) ? server.addedTools : []
        const removed = Array.isArray(server.removedTools) ? server.removedTools : []
        const showAdded = added.length > 0 && added.length < tools.length
        return (
          <Card key={server.name} className="space-y-2.5 p-4">
            <div className="text-sm">
              <strong>{server.name}</strong>
              <span className="text-muted-foreground">
                {' '}
                · gen {server.toolSuiteGeneration ?? (status.toolSuiteGeneration as number) ?? 0}
              </span>
            </div>
            <div className="text-sm text-muted-foreground">
              Last change: {formatDateTime(server.lastToolSuiteChangeAt ?? (status.lastToolSuiteChangeAt as string))}
            </div>
            <ToolChips tools={tools} />
            {showAdded && (
              <div className="text-sm">
                <ToneText tone="ok">Added</ToneText> {added.join(', ')}
              </div>
            )}
            {removed.length > 0 && (
              <div className="text-sm">
                <ToneText tone="bad">Removed</ToneText> {removed.join(', ')}
              </div>
            )}
          </Card>
        )
      })}

      <Card className="space-y-2 p-4">
        <h3 className="text-sm font-semibold">Recent tool-suite changes</h3>
        {changes.length === 0 ? (
          <div className="text-sm text-muted-foreground">No tool-suite changes recorded.</div>
        ) : (
          changes.map((change, i) => (
            <div key={i} className="rounded-md border border-border p-2">
              <strong className="text-sm">{change.server}</strong>
              <div className="text-xs text-muted-foreground">
                {formatDateTime(change.timestamp)} · gen {change.generation}
              </div>
              <div className="text-sm">
                {[
                  change.addedTools?.length ? '+' + change.addedTools.join(',') : '',
                  change.removedTools?.length ? '-' + change.removedTools.join(',') : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}
