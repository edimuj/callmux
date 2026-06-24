import { Activity, Boxes, Braces, LayoutDashboard, ScrollText, Search, Server, SlidersHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ViewId } from '@/types'

export interface NavItem {
  id: ViewId
  label: string
  short: string
  icon: LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', short: 'Overview', icon: LayoutDashboard },
  { id: 'servers', label: 'Servers', short: 'Servers', icon: Server },
  { id: 'management', label: 'Management', short: 'Manage', icon: SlidersHorizontal },
  { id: 'tools', label: 'Tool Suites', short: 'Tools', icon: Boxes },
  { id: 'diagrams', label: 'Runtime Diagrams', short: 'Diagrams', icon: Activity },
  { id: 'drilldown', label: 'Drill-down', short: 'Drill-down', icon: Search },
  { id: 'events', label: 'Recent Events', short: 'Events', icon: ScrollText },
  { id: 'runtime', label: 'Runtime', short: 'Runtime', icon: Braces },
]

export const VIEW_TITLES: Record<ViewId, string> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.id, item.label]),
) as Record<ViewId, string>
