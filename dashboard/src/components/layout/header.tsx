import { useStore } from '@/store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ThemeName } from '@/types'
import { VIEW_TITLES } from './nav'

const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'nord', label: 'Nord' },
  { value: 'ember', label: 'Ember' },
  { value: 'parchment', label: 'Parchment' },
]

export function Header() {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-card px-6 py-4">
      <h1 className="text-xl font-semibold">{VIEW_TITLES[view]}</h1>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Theme</span>
        <Select value={theme} onValueChange={(value) => setTheme(value as ThemeName)}>
          <SelectTrigger size="sm" className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </header>
  )
}
