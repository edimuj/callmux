[< Back to README](../README.md)

# CLI Reference

## Management Commands

| Command | Description |
|:--------|:------------|
| `callmux setup` | Interactive setup wizard |
| `callmux init` | Create empty config file |
| `callmux server add <name> [opts] -- <cmd>` | Add a downstream server |
| `callmux server set <name> [opts]` | Modify an existing server |
| `callmux server test <name>\|--all` | Smoke-test connectivity |
| `callmux server list [--json]` | List configured servers |
| `callmux server remove <name>` | Remove a server |
| `callmux doctor [--json]` | Validate config + probe all servers |
| `callmux doctor --url <url> [--cwd <path>] [--header Name:Value] [--json]` | Smoke-test a running shared listener |
| `callmux bridge --url <url> [--cwd <path>] [--header Name:Value]` | Stdio bridge to a shared listener |
| `callmux client status [claude\|codex]` | Check client configuration state |
| `callmux client attach <client> [--yes]` | Write command-mode callmux into client config |
| `callmux client attach <client> --url <url> [--yes]` | Write shared listener URL into client config |
| `callmux client attach <client> --url <url> --bridge [--yes]` | Write stdio bridge config for a shared listener |
| `callmux client detach <client> [--yes]` | Remove callmux from client config |
| `callmux client print <client> [--url <url>] [--bridge]` | Output ready-to-paste snippet |
| `callmux instructions [--profile codex\|claude] [--mode meta-only]` | Print compact agent instructions |
| `callmux daemon install [--start] [--enable] [--dry-run]` | Install a background shared-listener daemon |
| `callmux daemon status\|logs\|start\|stop\|restart` | Inspect or control the daemon |
| `callmux daemon enable\|disable` | Enable or disable launch at login/boot |

---

## Inline Flags

Single-server mode flags (used with `callmux -- <server-command>`):

| Flag | Description |
|:-----|:------------|
| `--tools <list>` | Comma-separated tool whitelist |
| `--env KEY=VALUE` | Environment variable (repeatable) |
| `--cache <seconds>` | Cache TTL |
| `--cache-max-entries <n>` | Max cache entries before LRU eviction |
| `--cache-allow <list>` | Cacheable tool patterns |
| `--cache-deny <list>` | Non-cacheable tool patterns |
| `--concurrency <n>` | Max parallel calls (default: 20) |
| `--connect-timeout <ms>` | Startup connect/list-tools timeout |
| `--call-timeout <ms>` | Downstream tool call timeout (default: `180000`) |
| `--request-body-max-bytes <n>` | Max inbound request payload bytes (0 = unlimited) |
| `--allow-request-body-override` | Allow `x-callmux-max-body-bytes` per-request override |
| `--allow-insecure-remote-listener` | Allow remote listener startup without auth (unsafe) |
| `--strict-startup` | Fail startup if any downstream server fails |
| `--listen <port>` | Run as shared HTTP/SSE server ([details](shared-server.md)) |
| `--host <addr>` | Bind address for `--listen` (default: `127.0.0.1`) |
| `--meta-only` | Hide proxied tools, expose only meta-tools ([details](meta-only-mode.md)) |
| `--description-max-length <n>` | Default max chars for tool descriptions in status |
| `--url <url>` | Connect to remote server (instead of `-- command`) |
| `--transport <type>` | Force `streamable-http` or `sse` |
| `--header Name:Value` | HTTP header (repeatable) |

---

## Common Workflows

### First-Time Setup

```bash
npx -y callmux setup
```

The wizard detects existing MCP servers, lets you pick from a curated list or add custom ones, auto-discovers tools, configures caching, and attaches to your client.

### Add a Server

```bash
callmux server add github -- npx -y @modelcontextprotocol/server-github
```

Without `--tools`, callmux probes the server and lets you pick which tools to expose interactively.

Use `--call-timeout <ms>` on `server add` or `server set` to override the global tool-call timeout for that server.

### Filter Tools on an Existing Server

```bash
callmux server set github --add-tool search_issues --add-tool get_issue
```

### Validate Config and Connectivity

```bash
callmux doctor
```

### Smoke-Test a Running Listener

```bash
callmux doctor --url http://localhost:4860/mcp --cwd "$PWD"
```

### Attach a Client

```bash
callmux client attach claude --yes
callmux client attach codex --url http://localhost:4860/mcp --yes
callmux client attach codex --url http://localhost:4860/mcp --bridge --yes
```

### Print Client Snippets

```bash
callmux client print codex --url http://localhost:4860/mcp
callmux client print codex --url http://localhost:4860/mcp --bridge
callmux client print claude --url http://localhost:4860/sse
```

### Run as Shared Listener

```bash
callmux --listen 4860
callmux --listen 4860 --host 0.0.0.0   # expose on all interfaces (e.g. Tailscale)
```

### Install as a Daemon

```bash
callmux daemon install --config ~/.config/callmux/config.json --start --enable
callmux daemon status
callmux daemon logs
callmux daemon restart
```

`daemon install` picks the safest supported backend automatically: Linux user systemd units by default, Linux system units with `--system`, and macOS user LaunchAgents. Use `--dry-run` to inspect the generated unit/plist and commands before making changes.

---

## Agent Instructions

```bash
callmux instructions
callmux instructions --profile codex --mode meta-only
```

The command prints a concise markdown block for `AGENTS.md`, `CLAUDE.md`, or similar agent instruction files. It stays generic and public: no local paths, private config, or user-specific workflow text.

The output covers meta-tool recovery fields, `callmux_dry_run`, response-shield retrieval via `_callmux.retrieval`, cwd overrides, file-reference choices, and the `$json`/`$jsonFile` footgun.

---

## Environment Variables

| Variable | Description |
|:---------|:------------|
| `CALLMUX_CONFIG` | Override config file path |
| `CALLMUX_NAMESPACE` | Instance identifier for multi-instance sessions (e.g. `mcp__server1__`) |

---

## See Also

- [Config Reference](config-reference.md) - full config schema and options
- [Shared Server Mode](shared-server.md) - listener setup, bridge command, client config
