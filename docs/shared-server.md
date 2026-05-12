[< Back to README](../README.md)

# Shared Server Mode

Every MCP client session spawns its own callmux process and its own set of downstream servers. With 6 concurrent Claude Code sessions each connecting to 5 MCP servers, that's **~60 processes and 4+ GB RAM** for what could be 6.

Shared server mode runs callmux once as a persistent HTTP listener. All sessions connect to it over the network:

<p align="center">
  <img src="diagram-shared-server.png" alt="Shared server mode: 9+ processes reduced to 4" width="720">
</p>

**What you get:**
- ~60 processes -> ~6 (one callmux + one of each downstream)
- ~4 GB -> ~500 MB RAM for MCP infrastructure
- No orphaned servers when sessions die
- Cache shared across sessions when safe, scoped by project cwd for cwd-sensitive calls
- Downstream startup cost paid once

---

## Starting the Listener

```bash
callmux --listen 4860
```

By default, binds to `127.0.0.1` (localhost only). To expose on all interfaces (e.g. for Tailscale access from other machines):

```bash
callmux --listen 4860 --host 0.0.0.0
```

When binding to a non-loopback host, callmux requires auth configuration unless `--allow-insecure-remote-listener` is explicitly set. See [Enterprise Deployment](enterprise.md#authentication) for auth setup.

### Background Daemon

For a persistent shared listener, install callmux as a daemon:

```bash
callmux daemon install --config ~/.config/callmux/config.json --start --enable
```

callmux chooses the safest supported backend for the host:

- Linux: user-scoped `systemd` unit by default (`~/.config/systemd/user/callmux.service`)
- Linux with `--system`: system `systemd` unit (`/etc/systemd/system/callmux.service`)
- macOS: user LaunchAgent (`~/Library/LaunchAgents/dev.callmux.callmux.plist`)

Useful commands:

```bash
callmux daemon status
callmux daemon logs
callmux daemon restart
callmux daemon stop
callmux daemon uninstall
```

Use `--dry-run` with `install` or `uninstall` to preview generated files and commands. callmux marks generated daemon files and refuses to overwrite or remove unmanaged files unless `--force` is provided.

---

## Client Config

### Claude Code (SSE)

```json
{
  "mcpServers": {
    "callmux": { "url": "http://localhost:4860/sse" }
  }
}
```

Add to `~/.claude.json` or project `.mcp.json`.

### Codex (Streamable HTTP)

```toml
[mcp_servers.callmux]
url = "http://localhost:4860/mcp"
```

Add to `~/.codex/config.toml`. The Codex macOS app, CLI, and IDE extension all share this file. Project-scoped overrides go in `.codex/config.toml`.

### Codex with Stdio Bridge (Recommended)

```toml
[mcp_servers.callmux]
command = "callmux"
args = ["bridge", "--url", "http://localhost:4860/mcp"]
```

The bridge is a lightweight local process that Codex talks to over stdio. It connects to the shared listener over HTTP and adds two critical capabilities:

1. **Project cwd injection** - The bridge sends `x-callmux-cwd` from its process working directory, so wrapped path-sensitive stdio servers still see the project cwd even through an HTTP listener.

2. **Resilient reconnection** - Because Codex stays attached to the local stdio bridge, temporary shared-listener restarts, MCP session/transport failures, or downstream server hiccups can recover on the next tool call. The bridge reconnects and retries the request once. Without the bridge, Codex would need a full session restart to re-establish MCP connectivity, something Codex users frequently complain about.

For callmux meta-tools, the bridge derives the forwarded MCP request timeout from the downstream child timeouts plus overhead, so a long `callmux_parallel`, `callmux_batch`, or `callmux_pipeline` call is not cut off by the bridge before callmux can return the child result or timeout.

### Claude Desktop

Add to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "callmux": {
      "command": "npx",
      "args": ["-y", "callmux", "bridge", "--url", "http://localhost:4860/mcp"]
    }
  }
}
```

The Claude desktop app has a minimal PATH. If `npx` isn't found, use the full path (e.g., `/usr/local/bin/npx`). Find it with `which npx`. Or install callmux globally and use `"command": "callmux"` directly.

### Any MCP Client

callmux works with any client that supports MCP stdio or HTTP transports. Use:
- **Streamable HTTP** at `/mcp` (preferred, current MCP spec)
- **Legacy SSE** at `/sse` (for clients that don't support Streamable HTTP yet)
- **Stdio bridge** via `callmux bridge --url <listener-url>` (for any client that speaks stdio)

### Generating Client Snippets

```bash
callmux client print codex --url http://localhost:4860/mcp
callmux client print codex --url http://localhost:4860/mcp --bridge
callmux client print claude --url http://localhost:4860/sse
```

---

## Session-Cwd Behavior

For stdio servers in listener mode, callmux resolves a downstream call's project cwd from (in priority order):

1. Explicit meta-tool `cwd` (`callmux_call.cwd`, `callmux_parallel.calls[].cwd`, `callmux_batch.cwd/items[].cwd`, or `callmux_pipeline.steps[].cwd`)
2. Per-request `_meta` (`_meta.callmux.cwd`, `_meta["callmux.cwd"]`, `_meta.cwd`, or `_meta.workingDirectory`)
3. Existing session cwd, usually the `x-callmux-cwd` header sent by the stdio bridge
4. MCP roots, when the session does not already have a cwd

This makes relative paths in downstream servers behave like they would in a per-project MCP process.

Session-cwd stdio clients are reused per `server + cwd` pair and retired after `sessionCwdIdleTtlSeconds` of inactivity (default: 600s).

If a stdio server should always run from the configured/process cwd regardless of client session, set `cwdMode: "global"` for that server.

---

## Endpoints

| Path | Transport | Description |
|:-----|:----------|:------------|
| `/mcp` | Streamable HTTP | Primary endpoint (current MCP spec) |
| `/sse` | Server-Sent Events | Legacy transport for older clients |
| `/health` | HTTP GET | Server status and active session count |
| `/ready` | HTTP GET | Readiness check; returns HTTP 503 when configured downstreams are unavailable |
| `/metrics` | HTTP GET | Prometheus metrics (when [enabled](enterprise.md#prometheus-metrics)) |
| `/dashboard` | HTTP GET | Read-only dashboard (when enabled) |

---

## Read-Only Dashboard

The dashboard is disabled by default. Enable it in config:

```json
{
  "dashboard": {
    "enabled": true,
    "path": "/dashboard",
    "maxEvents": 500
  }
}
```

When enabled, callmux serves:

- `/dashboard` - browser UI
- `/dashboard/data` - JSON snapshot for the UI
- `/dashboard/events` - SSE stream for live refreshes

`dashboard.path` may also be a reverse-proxy mount such as `/relay/` or the root path `/`. Trailing slashes are normalized, and the browser UI resolves `data` and `events` relative to the URL it was loaded from, so both `/relay` and `/relay/` work behind path-prefix proxies.

The dashboard shows server health, active sessions, cache and response-store stats, recent HTTP requests, tool calls, cache hits, tool-suite changes, config reloads, and recent errors. Event rows are clickable and show routing details such as JSON-RPC method, callmux meta-tool vs downstream tool classification, fan-out counts for batch/parallel/pipeline calls, and aggregated downstream targets. Tool arguments are intentionally not stored in dashboard history. It is read-only in this version; server editing will come later.

If listener auth is configured, dashboard requests require the same auth as `/mcp`.

See [Dashboard](dashboard.md) for practical setup notes, including reverse-proxy prefix handling.

---

## Config Hot-Reload

In shared listener mode launched from a config file, callmux watches the config file and hot-reloads changes automatically. You can also trigger the same reload path with `SIGHUP`:

```bash
kill -HUP <callmux-pid>
```

callmux validates and connects the new upstream set before swapping it into the live listener. If parsing, validation, or upstream startup fails, the old runtime stays active and `callmux_status` reports the latest reload error under `listener.configReload`.

**Reloads** (no restart needed):
- `servers`, tool wiring, cache settings, recipes, `metaOnly`, `maxConcurrency`
- `auth`, `authorization`, `abuseControls`, `auditLog`, `metrics`
- `requestBodyMaxBytes`, `allowRequestBodyMaxOverride`, `allowInsecureRemoteListener`
- `responseShield`, `dashboard`

In-flight requests continue on the runtime they started with. New requests use the reloaded runtime after the swap, and stored `callmux_get_result` refs remain available across successful reloads until evicted.

---

## Remote Downstream Servers

callmux can connect to remote MCP servers over HTTP alongside local stdio processes. Use `url` instead of `command`:

```json
{
  "servers": {
    "local-github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"]
    },
    "remote-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." }
    }
  }
}
```

**Inline mode** for a single remote server:

```bash
npx -y callmux --url https://mcp.example.com/mcp --header "Authorization:Bearer sk-..."
```

---

## See Also

- [Enterprise Deployment](enterprise.md) - auth, RBAC, rate limiting for shared listeners
- [Config Reference](config-reference.md) - full config schema
- [CLI Reference](cli-reference.md) - bridge command details
