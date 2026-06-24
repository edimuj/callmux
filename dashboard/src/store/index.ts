import { create } from 'zustand'
import {
  fetchDrilldown,
  fetchSeries,
  fetchSnapshot,
} from '@/lib/api'
import type {
  DashboardSnapshot,
  DrilldownResponse,
  EventFilters,
  MetricsRange,
  SeriesResponse,
  ThemeName,
  ViewId,
} from '@/types'

const THEME_KEY = 'callmux-dashboard-theme'
const VIEW_KEY = 'callmux-dashboard-view'
const RANGE_KEY = 'callmux-dashboard-range'
const TOKEN_KEY = 'callmux-management-token'

const THEMES: ThemeName[] = ['light', 'dark', 'midnight', 'nord', 'ember', 'parchment']
const VIEWS: ViewId[] = ['overview', 'servers', 'management', 'tools', 'diagrams', 'drilldown', 'events', 'runtime']
const RANGES: MetricsRange[] = ['1h', 'today', 'yesterday', '7d', '30d']

function readStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback
  } catch {
    return fallback
  }
}
function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

// Map a theme to the html classes app.css keys off (.dark for the dark
// variant, .theme-* for the full token override).
const THEME_CLASSES: Record<ThemeName, string[]> = {
  light: [],
  dark: ['dark'],
  midnight: ['dark', 'theme-midnight'],
  nord: ['dark', 'theme-nord'],
  ember: ['dark', 'theme-ember'],
  parchment: ['theme-parchment'],
}

export function applyTheme(theme: ThemeName): void {
  const el = document.documentElement
  el.classList.remove('dark', 'theme-midnight', 'theme-nord', 'theme-ember', 'theme-parchment')
  for (const cls of THEME_CLASSES[theme]) el.classList.add(cls)
}

function initialTheme(): ThemeName {
  const stored = readStorage(THEME_KEY, '')
  if (THEMES.includes(stored as ThemeName)) return stored as ThemeName
  const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  return prefersDark ? 'dark' : 'light'
}

interface DashboardState {
  snapshot: DashboardSnapshot | null
  series: SeriesResponse | null
  drilldown: DrilldownResponse | null
  connected: boolean
  lastUpdated: number | null

  view: ViewId
  theme: ThemeName
  range: MetricsRange

  filters: EventFilters
  hideAgentStatus: boolean
  hideTransportHttp: boolean
  hideSessionReinit: boolean
  selectedServer: string | null
  selectedEventKey: string | null

  managementToken: string
  managementMessage: { kind: 'muted' | 'ok' | 'bad'; text: string }

  setView: (view: ViewId) => void
  setTheme: (theme: ThemeName) => void
  setRange: (range: MetricsRange) => void
  setFilter: (patch: Partial<EventFilters>) => void
  setHideAgentStatus: (value: boolean) => void
  setHideTransportHttp: (value: boolean) => void
  setHideSessionReinit: (value: boolean) => void
  selectServer: (name: string | null) => void
  toggleEvent: (key: string) => void
  setManagementToken: (token: string) => void
  setManagementMessage: (kind: 'muted' | 'ok' | 'bad', text: string) => void

  refresh: () => Promise<void>
  loadSeries: () => Promise<void>
  loadDrilldown: () => Promise<void>
}

export const useStore = create<DashboardState>((set, get) => ({
  snapshot: null,
  series: null,
  drilldown: null,
  connected: false,
  lastUpdated: null,

  view: (VIEWS.includes(readStorage(VIEW_KEY, '') as ViewId) ? readStorage(VIEW_KEY, '') : 'overview') as ViewId,
  theme: initialTheme(),
  range: (RANGES.includes(readStorage(RANGE_KEY, '') as MetricsRange) ? readStorage(RANGE_KEY, '') : '1h') as MetricsRange,

  filters: { type: '', status: '', server: '', search: '' },
  hideAgentStatus: true,
  hideTransportHttp: true,
  hideSessionReinit: true,
  selectedServer: null,
  selectedEventKey: null,

  managementToken: readStorage(TOKEN_KEY, ''),
  managementMessage: { kind: 'muted', text: 'No management action yet.' },

  setView: (view) => {
    writeStorage(VIEW_KEY, view)
    set({ view })
    if (view === 'diagrams') void get().loadSeries()
    if (view === 'drilldown') void get().loadDrilldown()
  },
  setTheme: (theme) => {
    writeStorage(THEME_KEY, theme)
    applyTheme(theme)
    set({ theme })
  },
  setRange: (range) => {
    writeStorage(RANGE_KEY, range)
    set({ range })
    const view = get().view
    if (view === 'diagrams') void get().loadSeries()
    if (view === 'drilldown') void get().loadDrilldown()
  },
  setFilter: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setHideAgentStatus: (value) => set({ hideAgentStatus: value }),
  setHideTransportHttp: (value) => set({ hideTransportHttp: value }),
  setHideSessionReinit: (value) => set({ hideSessionReinit: value }),
  selectServer: (name) => set({ selectedServer: name }),
  toggleEvent: (key) => set((s) => ({ selectedEventKey: s.selectedEventKey === key ? null : key })),
  setManagementToken: (token) => {
    writeStorage(TOKEN_KEY, token)
    set({ managementToken: token })
  },
  setManagementMessage: (kind, text) => set({ managementMessage: { kind, text } }),

  refresh: async () => {
    try {
      const snapshot = await fetchSnapshot()
      set((s) => ({
        snapshot,
        connected: true,
        lastUpdated: Date.now(),
        selectedServer: s.selectedServer,
      }))
    } catch {
      set({ connected: false })
    }
  },
  loadSeries: async () => {
    const series = await fetchSeries(get().range)
    set({ series })
  },
  loadDrilldown: async () => {
    const drilldown = await fetchDrilldown(get().range)
    set({ drilldown })
  },
}))
