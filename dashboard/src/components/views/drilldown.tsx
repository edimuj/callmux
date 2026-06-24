import { useEffect } from 'react'
import { useStore } from '@/store'
import { Card } from '@/components/ui/card'
import { ToneText, DetailItem } from '@/components/shared/bits'
import { RangeBar } from '@/components/shared/range-bar'
import { formatBytes, formatDateTime, formatNum } from '@/lib/format'
import type { BreakdownRow, ForwardedHeaderRow } from '@/types'

function BreakdownTable({ title, rows, firstColumn }: { title: string; rows: BreakdownRow[] | undefined; firstColumn: string }) {
  return (
    <Card className="overflow-hidden p-0">
      <h2 className="px-4 pt-4 text-lg font-semibold">{title}</h2>
      {!rows || rows.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No rows in this range</div>
      ) : (
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-2 font-semibold">{firstColumn}</th>
              <th className="p-2 font-semibold">Calls</th>
              <th className="p-2 font-semibold">Errors</th>
              <th className="p-2 font-semibold">Avg</th>
              <th className="p-2 font-semibold">In</th>
              <th className="p-2 font-semibold">Out</th>
              <th className="p-2 font-semibold">Last call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border">
                <td className="p-2 break-words">{row.name}</td>
                <td className="p-2">{formatNum(row.calls)}</td>
                <td className="p-2">
                  <ToneText tone={row.errors > 0 ? 'bad' : 'muted'}>{formatNum(row.errors)}</ToneText>
                </td>
                <td className="p-2">{formatNum(row.avgDurationMs)}ms</td>
                <td className="p-2">{formatBytes(row.bytesIn)}</td>
                <td className="p-2">{formatBytes(row.bytesOut)}</td>
                <td className="p-2 text-muted-foreground">{formatDateTime(row.lastCallAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function ForwardedHeaderAudit({ rows }: { rows: ForwardedHeaderRow[] | undefined }) {
  return (
    <Card className="overflow-hidden p-0">
      <h2 className="px-4 pt-4 text-lg font-semibold">Forwarded Header Audit</h2>
      {!rows || rows.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">No forwarded headers recorded in this range</div>
      ) : (
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-2 font-semibold">Server</th>
              <th className="p-2 font-semibold">Tool</th>
              <th className="p-2 font-semibold">Session</th>
              <th className="p-2 font-semibold">Principal</th>
              <th className="p-2 font-semibold">Header</th>
              <th className="p-2 font-semibold">Calls</th>
              <th className="p-2 font-semibold">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-border">
                <td className="p-2">{row.server}</td>
                <td className="p-2">{row.tool}</td>
                <td className="p-2">{row.sessionId}</td>
                <td className="p-2">{row.principal}</td>
                <td className="p-2">{row.headerName}</td>
                <td className="p-2">{formatNum(row.calls)}</td>
                <td className="p-2 text-muted-foreground">{formatDateTime(row.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

export function DrilldownView() {
  const drilldown = useStore((s) => s.drilldown)
  const loadDrilldown = useStore((s) => s.loadDrilldown)

  useEffect(() => {
    void loadDrilldown()
  }, [loadDrilldown])

  const disabled = drilldown && drilldown.enabled === false
  const totals = drilldown?.totals

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <RangeBar />
        {!disabled && totals && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
            <DetailItem label="Calls" value={formatNum(totals.calls)} />
            <DetailItem label="Errors" value={formatNum(totals.errors)} />
            <DetailItem label="Avg duration" value={formatNum(totals.avgDurationMs) + 'ms'} />
            <DetailItem label="Bytes in" value={formatBytes(totals.bytesIn)} />
            <DetailItem label="Bytes out" value={formatBytes(totals.bytesOut)} />
          </div>
        )}
      </Card>

      {disabled ? (
        <Card className="p-4">
          <div className="text-sm text-muted-foreground">SQLite event store is disabled.</div>
        </Card>
      ) : (
        <div className="grid gap-4">
          <BreakdownTable title="By Server" rows={drilldown?.byServer} firstColumn="Server" />
          <BreakdownTable title="By Tool" rows={drilldown?.byTool} firstColumn="Tool" />
          <BreakdownTable title="By Session" rows={drilldown?.bySession} firstColumn="Session" />
          <ForwardedHeaderAudit rows={drilldown?.forwardedHeaders} />
        </div>
      )}
    </div>
  )
}
