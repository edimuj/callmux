import { useEffect, useRef } from 'react'
import { useStore, applyTheme } from '@/store'
import { openEventStream } from '@/lib/api'
import { Sidebar } from '@/components/layout/sidebar'
import { MobileNav } from '@/components/layout/mobile-nav'
import { Header } from '@/components/layout/header'
import { OverviewView } from '@/components/views/overview'
import { ServersView } from '@/components/views/servers'
import { ManagementView } from '@/components/views/management'
import { ToolsView } from '@/components/views/tools'
import { DiagramsView } from '@/components/views/diagrams'
import { DrilldownView } from '@/components/views/drilldown'
import { EventsView } from '@/components/views/events'
import { RuntimeView } from '@/components/views/runtime'
import type { ViewId } from '@/types'

const VIEWS: Record<ViewId, () => React.JSX.Element> = {
  overview: OverviewView,
  servers: ServersView,
  management: ManagementView,
  tools: ToolsView,
  diagrams: DiagramsView,
  drilldown: DrilldownView,
  events: EventsView,
  runtime: RuntimeView,
}

function hasActiveTextSelection(): boolean {
  const selection = window.getSelection ? window.getSelection() : null
  return Boolean(selection && !selection.isCollapsed && selection.toString())
}

export function App() {
  const view = useStore((s) => s.view)
  const theme = useStore((s) => s.theme)
  const refresh = useStore((s) => s.refresh)
  const loadSeries = useStore((s) => s.loadSeries)
  const loadDrilldown = useStore((s) => s.loadDrilldown)

  // Apply the persisted theme before first paint.
  useEffect(() => {
    applyTheme(theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Defer snapshot refreshes while the user is selecting text so a live update
  // doesn't blow away their selection (the vanilla dashboard did the same).
  const pendingRef = useRef(false)
  useEffect(() => {
    const safeRefresh = () => {
      if (hasActiveTextSelection()) {
        pendingRef.current = true
        return
      }
      void refresh()
    }
    const onSelectionChange = () => {
      if (!hasActiveTextSelection() && pendingRef.current) {
        pendingRef.current = false
        void refresh()
      }
    }
    document.addEventListener('selectionchange', onSelectionChange)

    void refresh()
    const stream = openEventStream(safeRefresh, () => setTimeout(safeRefresh, 1500))
    // Periodically refresh the historic charts / drilldown while their view is open.
    const interval = window.setInterval(() => {
      const current = useStore.getState().view
      if (current === 'diagrams') void loadSeries()
      if (current === 'drilldown') void loadDrilldown()
    }, 15000)

    return () => {
      stream.close()
      window.clearInterval(interval)
      document.removeEventListener('selectionchange', onSelectionChange)
    }
  }, [refresh, loadSeries, loadDrilldown])

  const ActiveView = VIEWS[view]

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <MobileNav />
        <Header />
        <main className="mx-auto max-w-[1240px] px-6 pt-5 pb-8 max-sm:px-3">
          <ActiveView />
        </main>
      </div>
    </div>
  )
}
