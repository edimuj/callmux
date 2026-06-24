import { useStore } from '@/store'
import { cn } from '@/lib/utils'
import { NAV_ITEMS } from './nav'
import { HealthStrip } from './health-strip'

export function Sidebar() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)

  return (
    <aside className="sticky top-0 hidden h-screen w-[230px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <div className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sky-400/35 bg-[#05070a] font-extrabold text-sky-400">
            C
          </span>
          <span className="text-base font-bold">callmux</span>
        </div>
      </div>
      <nav aria-label="Dashboard sections" className="flex flex-col gap-1 p-2.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const active = view === item.id
          return (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                active
                  ? 'bg-sky-400 font-semibold text-[#06101d]'
                  : 'text-sidebar-foreground/70 hover:bg-white/8 hover:text-white',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {item.label}
            </button>
          )
        })}
      </nav>
      <div className="mt-auto border-t border-sidebar-border px-4 py-4">
        <HealthStrip />
      </div>
    </aside>
  )
}
