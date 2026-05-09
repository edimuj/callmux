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

`maxEvents` controls the bounded in-memory event history. Tool arguments are not stored in dashboard history.

If listener auth is configured, dashboard requests use the same authentication as `/mcp`.

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
