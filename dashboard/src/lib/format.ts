// Pure number / byte / date formatters — ported 1:1 from the vanilla dashboard
// so the React rebuild renders identical values.

export function compactCount(value: number | string | undefined): string {
  const count = Number(value ?? 0)
  if (!Number.isFinite(count) || count < 1000) return String(value ?? 0)
  return Math.floor(count / 1000) + 'K+'
}

export function fanoutCount(metaCalls: number | undefined, downstreamCalls: number | undefined): string {
  return compactCount(metaCalls) + ' / ' + compactCount(downstreamCalls)
}

export function formatNum(value: number | undefined): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}

export function formatBytes(value: number | undefined): string {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i]
}

export function formatDateTime(value: number | string | undefined): string {
  if (!value) return 'none'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

export function truncateText(value: string | undefined, maxLength = 180): string {
  const text = String(value ?? '')
  return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text
}

export function cacheEntriesText(cache: { enabled?: boolean; entries?: number } | undefined): string {
  if (cache && cache.enabled === false) return 'disabled'
  return compactCount(cache?.entries ?? 0)
}
