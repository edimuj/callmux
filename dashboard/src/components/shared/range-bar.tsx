import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import type { MetricsRange } from '@/types'

const RANGES: { value: MetricsRange; label: string }[] = [
  { value: '1h', label: '1h' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
]

export function RangeBar() {
  const range = useStore((s) => s.range)
  const setRange = useStore((s) => s.setRange)
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[15px] font-semibold">History</span>
      <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">
        {RANGES.map((r) => (
          <button
            key={r.value}
            onClick={() => setRange(r.value)}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
              range === r.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  )
}
