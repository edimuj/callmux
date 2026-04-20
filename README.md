<p align="center">
  <h1 align="center">callmux</h1>
  <p align="center">
    <strong>Add parallel execution, batching, caching, and pipelining to any MCP server.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/callmux"><img src="https://img.shields.io/npm/v/callmux?color=blue&label=npm" alt="npm version"></a>
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
    <a href="https://www.npmjs.com/package/callmux"><img src="https://img.shields.io/node/v/callmux" alt="Node version"></a>
  </p>
</p>

---

AI agents make tool calls one at a time. Creating 10 GitHub issues? That's 10 sequential round-trips. Fetching data from 3 different servers? 3 serial waits.

**callmux sits between your agent and any MCP server**, adding capabilities the original doesn't have:

| Without callmux | With callmux |
|:---|:---|
| 10 sequential `create_issue` calls | 1 `callmux_batch` call |
| 5 independent reads, one after another | 1 `callmux_parallel` call |
| Read > transform > write chain | 1 `callmux_pipeline` call |
| Same data fetched 3 times per session | Cached after first call |

```
Agent (Claude, Codex, etc.)          callmux adds:
        │                            ┌─────────────────────┐
        │  stdio                     │ callmux_parallel    │
        ▼                            │ callmux_batch       │
   ┌─────────┐                       │ callmux_pipeline    │
   │ callmux │──── stdio ───▶ MCP    │ callmux_cache_clear │
   └─────────┘              Server   │ callmux_status      │
        │                            └─────────────────────┘
        └──── stdio ───▶ MCP Server 2 (optional)
```

## Install

No install needed. Use `npx`:

```bash
npx -y callmux -- npx -y @modelcontextprotocol/server-github
```

Or install globally:

```bash
npm install -g callmux
```

## Quick Start

### Claude Code

Add to `~/.claude.json` or project `.mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "callmux", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

Done. Claude now sees all GitHub tools plus the `callmux_*` meta-tools.

<details>
<summary><strong>More:</strong> tool filtering, caching, env vars, multi-server</summary>

**Filter tools and enable caching:**

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": [
        "-y", "callmux",
        "--tools", "create_issue,get_issue,list_issues,search_issues",
        "--env", "GITHUB_TOKEN=ghp_xxx",
        "--cache", "60",
        "--cache-allow", "get_*,list_*,search_*",
        "--", "npx", "-y", "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

**Multiple servers via config file:**

Create `~/.config/callmux/config.json` (or run `callmux setup`):

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" },
      "tools": ["create_issue", "get_issue", "list_issues", "search_issues"]
    },
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"],
      "env": { "LINEAR_API_KEY": "lin_api_..." }
    }
  },
  "cacheTtlSeconds": 60,
  "maxConcurrency": 20
}
```

Then in your MCP config:

```json
{
  "mcpServers": {
    "callmux": {
      "command": "npx",
      "args": ["-y", "callmux"]
    }
  }
}
```

callmux auto-discovers `~/.config/callmux/config.json`. With multiple servers, tools are namespaced: `github__create_issue`, `linear__list_issues`.

</details>

---

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.github]
command = "npx"
args = ["-y", "callmux", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
```

Or use the Codex CLI:

```bash
codex mcp add github -- npx -y callmux -- npx -y @modelcontextprotocol/server-github
```

<details>
<summary><strong>More:</strong> tool filtering, caching, env vars, multi-server</summary>

```toml
[mcp_servers.github]
command = "npx"
args = [
  "-y", "callmux",
  "--tools", "create_issue,get_issue,list_issues,search_issues",
  "--env", "GITHUB_TOKEN=ghp_xxx",
  "--cache", "60",
  "--cache-allow", "get_*,list_*,search_*",
  "--", "npx", "-y", "@modelcontextprotocol/server-github"
]
```

**Multi-server:**

```toml
[mcp_servers.callmux]
command = "npx"
args = ["-y", "callmux", "--config", "/Users/you/.config/callmux/config.json"]
```

The Codex macOS app, CLI, and IDE extension all share `~/.codex/config.toml`. Project-scoped overrides go in `.codex/config.toml`.

</details>

---

### Claude Desktop (Mac / Windows)

Add to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "callmux": {
      "command": "npx",
      "args": ["-y", "callmux", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

<details>
<summary><strong>More:</strong> PATH issues, multi-server</summary>

The Claude desktop app has a minimal PATH. If `npx` isn't found, use the full path (e.g., `/usr/local/bin/npx`). Find it with `which npx`. Or install globally and use `"command": "callmux"` directly.

Multi-server works the same way as Claude Code. Point at a config file or let auto-discovery find it.

</details>

---

## Interactive Setup

The fastest way to go from zero to configured:

```bash
npx -y callmux setup
```

The wizard walks you through:
1. **Pick servers** from a curated list (GitHub, Linear, Slack, Filesystem, etc.) or add custom
2. **Auto-discovers tools** by probing each server, then lets you pick which to expose
3. **Configures caching** with sensible defaults
4. **Attaches to your client** (Claude Code, Codex) automatically

---

## Meta-Tools

These are exposed to your agent alongside the proxied tools:

### `callmux_parallel`

Execute multiple independent tool calls concurrently.

```json
{
  "calls": [
    { "tool": "get_issue", "arguments": { "number": 1 } },
    { "tool": "get_issue", "arguments": { "number": 2 } },
    { "tool": "get_issue", "arguments": { "number": 3 } }
  ]
}
```

### `callmux_batch`

Same tool, many items. The bulk operation pattern.

```json
{
  "tool": "create_issue",
  "items": [
    { "arguments": { "title": "Bug A", "labels": ["bug"] } },
    { "arguments": { "title": "Bug B", "labels": ["bug"] } }
  ]
}
```

### `callmux_pipeline`

Chain tools where each step feeds into the next.

```json
{
  "steps": [
    { "tool": "search_issues", "arguments": { "query": "is:open label:bug" } },
    { "tool": "analyze", "arguments": {}, "inputMapping": { "data": "$json" } }
  ]
}
```

### `callmux_cache_clear`

Invalidate cached results. Scope by tool, server, or clear everything.

```json
{ "tool": "get_issue", "server": "github" }
```

### `callmux_status`

Introspect callmux from inside your agent. Shows connected servers, tools, and cache state.

```json
{ "server": "github" }
```

---

## Multi-Server Mode

Wrap multiple MCP servers through a single callmux instance. Tools are automatically namespaced (`github__create_issue`, `linear__list_issues`) and the `server` field in meta-tool calls lets you target specific servers:

```json
{
  "calls": [
    { "server": "github", "tool": "get_issue", "arguments": { "number": 42 } },
    { "server": "linear", "tool": "get_issue", "arguments": { "id": "ENG-123" } }
  ]
}
```

## Caching

Enable with `cacheTtlSeconds` or `--cache <seconds>`. Error results are never cached.

```json
{
  "cacheTtlSeconds": 60,
  "cachePolicy": {
    "allowTools": ["get_*", "list_*", "search_*"],
    "denyTools": ["get_secret"]
  }
}
```

- **`allowTools`**: only matching tools are cacheable (whitelist)
- **`denyTools`**: matching tools are never cached (blacklist)
- Supports exact names and `*` wildcards
- Per-server policies combine with the global policy
- `callmux_cache_clear` invalidates manually

## CLI Management

Manage servers without editing JSON:

```bash
callmux setup                         # interactive wizard
callmux init                          # create config manually
callmux server add github -- npx -y @modelcontextprotocol/server-github
callmux server set github --add-tool search_issues
callmux server test --all
callmux doctor
callmux client status
callmux client attach claude --yes
```

When adding a server without `--tools`, callmux probes it automatically and lets you pick which tools to expose interactively.

<details>
<summary><strong>Full CLI reference</strong></summary>

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
| `callmux client status [claude\|codex]` | Check client configuration state |
| `callmux client attach <client> [--yes]` | Write callmux into client config |
| `callmux client detach <client> [--yes]` | Remove callmux from client config |
| `callmux client print <client>` | Output ready-to-paste snippet |

**Inline flags** (single-server mode):

| Flag | Description |
|:-----|:------------|
| `--tools <list>` | Comma-separated tool whitelist |
| `--env KEY=VALUE` | Environment variable (repeatable) |
| `--cache <seconds>` | Cache TTL |
| `--cache-allow <list>` | Cacheable tool patterns |
| `--cache-deny <list>` | Non-cacheable tool patterns |
| `--concurrency <n>` | Max parallel calls (default: 20) |

</details>

## Config File

Auto-discovery order:

1. `$CALLMUX_CONFIG` environment variable
2. `~/.config/callmux/config.json`

Works on Linux, macOS, and Windows.

<details>
<summary><strong>Full config schema</strong></summary>

```json
{
  "servers": {
    "<name>": {
      "command": "...",
      "args": ["..."],
      "env": { "KEY": "value" },
      "cwd": "/path",
      "tools": ["tool_a", "tool_b"],
      "cachePolicy": {
        "allowTools": ["get_*"],
        "denyTools": ["get_secret"]
      }
    }
  },
  "cacheTtlSeconds": 60,
  "cachePolicy": { "denyTools": ["create_*"] },
  "maxConcurrency": 20
}
```

Also accepts MCP-compatible format (`{ "mcpServers": { ... } }`).

All fields except `command` are optional. `tools` filters which downstream tools are exposed. Omit to expose everything.

</details>

## Related

- **[tokenlean](https://github.com/edimuj/tokenlean)** - CLI tools for AI agents, token-efficient code understanding. Same philosophy: make agents less wasteful.

## License

MIT
