import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { NAV_ITEMS } from './nav'

export function MobileNav() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)

  return (
    <nav
      aria-label="Dashboard sections"
      className="sticky top-0 z-10 flex gap-1.5 overflow-x-auto border-b border-sidebar-border bg-sidebar p-2 md:hidden"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = view === item.id
        return (
          <button
            key={item.id}
            onClick={() => setView(item.id)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              active ? 'bg-sky-400 font-semibold text-[#06101d]' : 'text-sidebar-foreground/70 hover:bg-white/8',
            )}
          >
            <Icon className="size-3.5" />
            {item.short}
          </button>
        )
      })}
    </nav>
  )
}
