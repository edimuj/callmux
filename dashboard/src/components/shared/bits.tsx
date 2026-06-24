import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { compactCount } from '@/lib/format'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted' | 'default'

const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-500 font-semibold',
  warn: 'text-amber-500 font-semibold',
  bad: 'text-red-400 font-semibold',
  muted: 'text-muted-foreground',
  default: '',
}

export function ToneText({ tone = 'default', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn(TONE_TEXT[tone], className)}>{children}</span>
}

const BAR_FILL: Record<Tone, string> = {
  ok: 'bg-emerald-500',
  bad: 'bg-red-500',
  warn: 'bg-amber-500',
  muted: 'bg-muted-foreground',
  default: 'bg-sky-400',
}

export function BarMeter({ label, value, max, tone = 'default' }: { label: string; value: number; max: number; tone?: Tone }) {
  const percent = max > 0 ? Math.max(2, Math.min(100, Math.round((Number(value || 0) / max) * 100))) : 0
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <strong>{compactCount(value || 0)}</strong>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full min-w-[2px] rounded-full', BAR_FILL[tone])} style={{ width: percent + '%' }} />
      </div>
    </div>
  )
}

export function MiniTable({ rows, empty = 'No activity' }: { rows: [string, number][]; empty?: string }) {
  const visible = rows.filter((row) => Number(row[1] ?? 0) > 0)
  if (visible.length === 0) return <div className="text-sm text-muted-foreground">{empty}</div>
  return (
    <div className="grid gap-1.5">
      {visible.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 text-sm">
          <span className="text-muted-foreground">{label}</span>
          <strong className="text-right text-[13px]">{compactCount(value)}</strong>
        </div>
      ))}
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-1 mb-3 text-[13px] font-semibold tracking-wider text-muted-foreground uppercase">{children}</h3>
  )
}

export function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="rounded-md border border-border p-2">
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="overflow-wrap-anywhere text-[13px] break-words">{value}</div>
    </div>
  )
}

export function EmptyChart({ children = 'No data in this range yet' }: { children?: ReactNode }) {
  return <div className="py-6 text-center text-sm text-muted-foreground">{children}</div>
}
