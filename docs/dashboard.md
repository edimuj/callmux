[< Back to README](../README.md)

# Dashboard

callmux has an optional read-only dashboard for shared listener deployments. It shows server health, active sessions, cache and response-store stats, recent requests, tool calls, config reloads, tool-suite changes, and errors.

## Enable It

Add `dashboard` to your callmux config and run callmux in listener mode:

```json
{
  "dashboard": {
    "enabled": true,
    "path": "/dashboard",
    "maxEvents": 500
  }
}
```

```bash
callmux --listen 4860 --config ~/.config/callmux/config.json
```

With the default path, callmux serves:

- `/dashboard` - browser UI
- `/dashboard/data` - JSON snapshot used by the UI
- `/dashboard/events` - SSE stream for live updates
- `/dashboard/series` - tiered RRD time-series for the history charts
- `/dashboard/drilldown` - SQLite event-store drill-down when `eventStore.enabled` is true

`maxEvents` controls the bounded in-memory event history. Tool arguments are not stored in dashboard history.

The dashboard's history charts use the aggregate RRD JSON metrics store. The Drill-down tab is additive and requires the optional [SQLite event store](observability.md); it shows per-server, per-tool, per-session, and forwarded-header audit breakdowns for the selected range.

If listener auth is configured, dashboard requests use the same authentication as `/mcp`.

## How It's Built

The UI is a [Vite](https://vite.dev) + React 19 + Tailwind 4 + [shadcn/ui](https://ui.shadcn.com) SPA living in [`dashboard/`](../dashboard). It bundles to **one self-contained HTML file** via `vite-plugin-singlefile` (no CDN or sibling-asset requests), which the listener reads at runtime and serves verbatim. Published npm tarballs ship the prebuilt bundle, so `npm i -g callmux` needs no frontend build.

Working on the dashboard from a source checkout:

```bash
npm run build:dashboard   # installs deps, builds the SPA, writes assets/dashboard.html
npm --prefix dashboard run dev   # hot-reload dev server (set CALLMUX_DASHBOARD_TARGET to a running listener)
```

`prepack` runs `build:dashboard` automatically when packing/publishing. If you run callmux from source without building the dashboard, the route serves a minimal "not built yet" placeholder until you run the build.

## Reverse Proxies

The important decision is whether your proxy **preserves** or **strips** the public path prefix before forwarding to callmux.

### Prefix Preserved

If the upstream receives `/callmux`, `/callmux/data`, and `/callmux/events`, configure callmux with that same base path:

```json
{
  "dashboard": {
    "enabled": true,
    "path": "/callmux"
  }
}
```

Caddy example:

```caddyfile
redir /callmux /callmux/ 301
handle /callmux/* {
	reverse_proxy localhost:4860
}
```

### Prefix Stripped

If the proxy strips `/callmux` before forwarding, the upstream receives `/`, `/data`, and `/events`. Configure the dashboard at root:

```json
{
  "dashboard": {
    "enabled": true,
    "path": "/"
  }
}
```

Caddy example:

```caddyfile
redir /callmux /callmux/ 301
handle_path /callmux/* {
	reverse_proxy localhost:4860
}
```

Do not mix these modes. If the dashboard HTML loads but stays on `Connecting...`, check the data and event endpoints directly:

```bash
curl -i http://localhost:4860/dashboard/data
curl -i http://localhost:4860/dashboard/events
```

For a public prefix, use the public URLs instead, for example `/callmux/data` and `/callmux/events`. Both must return `200`; the event endpoint should return `Content-Type: text/event-stream`.
