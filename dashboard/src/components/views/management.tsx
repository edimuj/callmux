import { useState } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToneText } from '@/components/shared/bits'
import { managementRequest } from '@/lib/api'
import { normalizeServers } from '@/lib/events'
import type { ServerInfo } from '@/types'
import { cn } from '@/lib/utils'

type Action = 'restart' | 'enable' | 'disable' | 'delete'

export function ManagementView() {
  const snapshot = useStore((s) => s.snapshot)
  const token = useStore((s) => s.managementToken)
  const setManagementToken = useStore((s) => s.setManagementToken)
  const message = useStore((s) => s.managementMessage)
  const setMessage = useStore((s) => s.setManagementMessage)
  const refresh = useStore((s) => s.refresh)
  const [draftToken, setDraftToken] = useState(token)

  const enabled = snapshot?.management?.enabled ?? false
  const basePath = snapshot?.management?.path ?? '/management/v1'
  const servers = (
    Array.isArray(snapshot?.managementServers) && snapshot.managementServers.length > 0
      ? snapshot.managementServers
      : normalizeServers(snapshot?.status)
  ) as ServerInfo[]

  async function runAction(name: string, action: Action) {
    try {
      const ctx = { token, basePath }
      const enc = encodeURIComponent(name)
      if (action === 'restart') await managementRequest(`servers/${enc}/restart`, ctx, { method: 'POST' })
      if (action === 'enable') await managementRequest(`servers/${enc}`, ctx, { method: 'PATCH', body: { disabled: false } })
      if (action === 'disable') await managementRequest(`servers/${enc}`, ctx, { method: 'PATCH', body: { disabled: true } })
      if (action === 'delete') await managementRequest(`servers/${enc}`, ctx, { method: 'DELETE' })
      setMessage('ok', `${action[0].toUpperCase()}${action.slice(1)} completed for ${name}.`)
      await refresh()
    } catch (error) {
      setMessage('bad', error instanceof Error ? error.message : String(error))
    }
  }

  const noticeClass =
    message.kind === 'ok'
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : message.kind === 'bad'
        ? 'border-red-500/30 bg-red-500/10 text-red-300'
        : 'border-border text-muted-foreground'

  return (
    <div className="space-y-3.5">
      <Card className="space-y-3 p-4">
        <div className="grid items-end gap-3 sm:grid-cols-[minmax(180px,1fr)_auto]">
          <div className="grid gap-1.5">
            <Label htmlFor="management-token" className="text-xs text-muted-foreground">
              Management token
            </Label>
            <Input
              id="management-token"
              type="password"
              autoComplete="off"
              placeholder="Bearer token for write actions"
              value={draftToken}
              onChange={(e) => setDraftToken(e.target.value)}
            />
          </div>
          <Button onClick={() => setManagementToken(draftToken.trim())}>Save</Button>
        </div>
        <div className={cn('rounded-md border px-2.5 py-2 text-sm', noticeClass)}>{message.text}</div>
      </Card>

      <Card className="overflow-hidden p-0">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-2 font-semibold">Server</th>
              <th className="p-2 font-semibold">State</th>
              <th className="p-2 font-semibold">Tools</th>
              <th className="p-2 font-semibold">Managed</th>
              <th className="p-2 font-semibold">Actions</th>
            </tr>
          </thead>
          <tbody>
            {!enabled ? (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  Management API is disabled.
                </td>
              </tr>
            ) : servers.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-4 text-center text-muted-foreground">
                  No servers configured.
                </td>
              </tr>
            ) : (
              servers.map((server) => {
                const config = server.config ?? {}
                const state = server.runtime?.state || server.state || (config.disabled ? 'disabled' : 'unknown')
                const disabled = config.disabled === true || state === 'disabled'
                const tools = Array.isArray(server.tools) ? server.tools.length : (server.toolCount ?? 0)
                return (
                  <tr key={server.name} className="border-t border-border align-top">
                    <td className="p-2">{server.name}</td>
                    <td className="p-2">
                      <ToneText tone={disabled ? 'warn' : state === 'connected' ? 'ok' : 'bad'}>{state}</ToneText>
                    </td>
                    <td className="p-2">{tools}</td>
                    <td className="p-2">{server.managed ? 'Override' : 'base'}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={disabled}
                          title={disabled ? 'Enable this server before restarting' : undefined}
                          onClick={() => runAction(server.name, 'restart')}
                        >
                          Restart
                        </Button>
                        <Button size="xs" variant="outline" onClick={() => runAction(server.name, disabled ? 'enable' : 'disable')}>
                          {disabled ? 'Enable' : 'Disable'}
                        </Button>
                        <Button size="xs" variant="destructive" onClick={() => runAction(server.name, 'delete')}>
                          Remove
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
