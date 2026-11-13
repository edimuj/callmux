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
| `callmux call <tool> [json] [--file <path>] [--url <url>] [--output-format <fmt>]` | Call one tool on a running shared listener |
| `callmux tools list [--server <name>] [--json] [--url <url>]` | List hosted tool names + one-line descriptions |
| `callmux tools schema <tool> [--json] [--url <url>]` | Print the full input schema for one tool |
| `callmux tools search <query> [--server <name>] [--json] [--url <url>]` | Substring-match tool names/descriptions |
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
| `--cache <seconds>` | Cache TTL; 0 disables caching (default) |
| `--cache-max-entries <n>` | Max cache entries before LRU eviction |
| `--cache-allow <list>` | Explicit replay-safe tool allowlist; overrides missing `readOnlyHint` |
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

### Call a Tool on a Running Listener

```bash
callmux call github__search_issues '{"query":"is:open"}'
callmux call github__create_issue --file payload.json --url http://localhost:4860/mcp
callmux call callmux_parallel '{"calls":[{"tool":"github__issue_read","arguments":{"number":1}}]}'
```

Defaults to `http://127.0.0.1:4860/mcp` when `--url` is omitted. Meta-tools (`callmux_parallel`, `callmux_batch`, `callmux_pipeline`, ...) are reachable the same way as proxied downstream tools.

Exit codes: `0` success, `1` the downstream tool reported an error (`isError: true`), `2` a usage error (bad flag, invalid JSON payload, ...) or a transport/connection failure (listener unreachable, bad HTTP status, ...). The same codes apply to `parallel`/`batch`/`pipeline`.

Add `--verbose` to print the listener URL and which token precedence tier is about to be used (env var, `--token`, `--token-file`, or the managed store) to stderr before the call — useful when a 401 is confusing because more than one token source is in play.

When a result is truncated it comes back with a `_callmux.ref`. Page through the full result the same way, via `callmux_get_result`:

```bash
callmux call callmux_get_result '{"ref":"r_...","offset":0,"limit":50}'
```

### Discover Tools on a Running Listener

```bash
callmux tools list --url http://localhost:4860/mcp
callmux tools list --server github --json
callmux tools schema github__create_issue
callmux tools search issue
```

`tools list`/`tools search` call the daemon's `tools/list` once and print only names + one-line descriptions — cheap discovery for an agent deciding what's callable. `tools schema <tool>` prints the full input schema for one tool, paid for only when that tool is actually used. `--server <name>` filters to tools qualified with the `<name>__` prefix (honors the server's configured `prefix`, e.g. `gh__`). Same exit codes as `callmux call` (`0` success, `2` usage/transport error or unknown tool — there's no per-tool `isError` result to report as `1` here).

`--quiet` drops the "no tools found"/"no tools matched" sentence on an empty `list`/`search` result, leaving stdout empty for scripts that only care whether anything came back. `--verbose` prints the same listener/token diagnostic line `call` does.

### CLI vs MCP: When to Use Which

Both transports call the same tools through the same daemon — this is a routing choice, not a capability difference:

- **Long-tail tools** (used once or rarely in a session): reach for the CLI. `tools schema <tool>` loads one schema on demand; it never rides along in every turn's system prompt the way a connected MCP tool definition does.
- **Hot tools** (called repeatedly): keep them on the MCP connection. You get structured `structuredContent` results, per-tool authorization errors surfaced as part of the normal tool-call flow, and no per-call session-bootstrap overhead (the CLI opens and tears down an MCP session for every single call).
- **Secrets stay server-side either way.** The CLI only ever presents a client→callmux bearer token (see below); it never touches `GITHUB_TOKEN`-style downstream credentials, which live exclusively in the daemon config.
- **One audit trail.** CLI and MCP calls hit the same authentication, [authorization](#per-tool-authorization-for-agents-deny-write-pattern), and [event store](observability.md) — a `callmux call` shows up in `/dashboard/drilldown`'s `byTransport` breakdown tagged `cli`, with the same principal an equivalent MCP call would carry, right alongside `mcp` traffic.

### Authenticating Against a Remote or Shared Daemon

A **loopback** daemon needs no token — the listener permits `127.0.0.1`/`::1`/`localhost` without auth, so `callmux call ...` just works locally. When you point `--url` at a **remote or auth-configured** daemon, `call`, `tools`, and `bridge` present a client→callmux **bearer token**. This is a separate layer from downstream secrets like `GITHUB_TOKEN`, which stay server-side in the daemon — the agent never holds them.

The token is resolved in this precedence (cheapest-trust-first — the first source that yields a token wins):

1. **Loopback** → no token required.
2. **`CALLMUX_TOKEN`** environment variable.
3. **`--token <t>`** / **`--token-file <path>`** (`--token` wins if both are given; the file form keeps the secret out of `ps` output and shell history).
4. The **managed CLI token store** written by `callmux client attach --token …` (`~/.config/callmux/cli-token`, mode `0600`).

```bash
# Remote daemon, token via env (nothing lands in argv):
CALLMUX_TOKEN=… callmux call github__search_issues '{"query":"is:open"}' --url https://mux.example.com/mcp

# Token from a file (out of ps/history):
callmux call github__search_issues '{"query":"is:open"}' --url https://mux.example.com/mcp --token-file ~/.secrets/callmux.token
```

The token is sent as `Authorization: Bearer <token>`. An explicit `--header Authorization:…` always overrides the resolved token. On the daemon, the existing stack verifies it — `authenticateBearerToken` for bearer tokens, the OIDC verifier for `oidc_jwt` SSO principals — then `evaluateToolAuthorization` applies the policy. Nothing about that server-side path changes; the CLI only *presents* the token.

A rejected (401) call names which tier actually sent the token — e.g. `sent the token from the CALLMUX_TOKEN env var` — so a stale env var beating a correct `--token` flag doesn't read as an unexplained bare `HTTP 401`.

#### One `attach` wires both the MCP client and the CLI

`callmux client attach <claude|codex> --token <t> --yes` (or `--token-file <path>`) stashes the bearer in the managed CLI token store **in addition to** writing the MCP client entry. A subsequent bare `callmux call …` then resolves the token at tier 4 with no extra flags. In `--bridge` mode the MCP client spawns `callmux bridge --url …`, which reads the same store — so a single `attach --bridge --token …` authenticates both the client's MCP session and any CLI call.

Running `attach --yes` again with neither `--token` nor `--token-file` leaves the managed store untouched and prints nothing about it — attach only stashes a token when you actually give it one, so re-running it to update just the client config never silently re-writes (or falsely reports re-writing) whatever token is already there.

#### Per-tool authorization for agents (deny-write pattern)

Keep the **harness grant coarse and the daemon policy fine.** Give an agent a single broad permission — `callmux call:*` — and let callmux enforce which tools that principal may actually invoke. Issue the agent a read-ish principal by denying writes per-tool:

```jsonc
// callmux config.json (daemon side)
{
  "auth": {
    "mode": "bearer",
    "tokens": [{ "id": "agent-readonly", "hash": "scrypt$..." }]
  },
  "authorization": {
    "defaultEffect": "allow",
    "rules": [
      { "id": "deny-writes", "effect": "deny", "principals": ["*"], "tools": ["*__*write*"] }
    ]
  }
}
```

With the agent holding only the `agent-readonly` token, `callmux call github__search_issues …` succeeds while `callmux call github__create_issue …` (or any `*write*` tool) comes back as an `authorization_denied` error result (exit code `1`) naming the blocked tool. Read tools stay allowed; a single write rule fences off the mutating surface. Tighten further by flipping `defaultEffect` to `deny` and adding explicit `allow` rules for the exact read tools the agent needs — deny always wins when allow and deny both match, so the policy fails closed. See the [Config Reference](config-reference.md) for the full `auth`/`authorization` schema.

### Attach a Client

```bash
callmux client attach claude --yes
callmux client attach codex --url http://localhost:4860/mcp --yes
callmux client attach codex --url http://localhost:4860/mcp --bridge --yes
# Remote/auth'd daemon: stash the client→callmux bearer for the CLI + bridge:
callmux client attach codex --url https://mux.example.com/mcp --bridge --token-file ~/.secrets/callmux.token --yes
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
| `CALLMUX_TOKEN` | Client→callmux bearer token presented by `call`/`tools`/`bridge` ([details](#authenticating-against-a-remote-or-shared-daemon)) |

---

## See Also

- [Config Reference](config-reference.md) - full config schema and options
- [Shared Server Mode](shared-server.md) - listener setup, bridge command, client config

For cache eligibility rules and per-tool exclusion reasons via `callmux_status`, see
[Caching](config-reference.md#caching).
