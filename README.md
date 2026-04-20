# callmux

Multiplexer for MCP tool calls — parallel execution, batching, caching, and pipelining for any MCP server.

```
Claude / Codex / any MCP client
        ↓
    callmux (proxy)
        ↓
  downstream MCP server(s)
```

callmux wraps any MCP server and adds capabilities the original doesn't have. Your agent gets the original tools *plus* meta-tools for combining them efficiently.

## Why

AI agents make tool calls one at a time. Creating 10 GitHub issues? That's 10 sequential round-trips. Fetching data from 3 endpoints before making a decision? 3 serial calls.

callmux fixes this:

| Without callmux | With callmux |
|-----------------|--------------|
| 10 sequential `create_issue` calls | 1 `callmux_batch` call |
| 5 independent reads, one after another | 1 `callmux_parallel` call |
| Read → transform → write chain | 1 `callmux_pipeline` call |
| Same data fetched 3 times | Cached after first call |

## Install

```bash
npm install -g callmux
```

## Quick Start

The shape is the same in every client:

1. Run `callmux` as the MCP server your agent connects to
2. Pass the real downstream MCP server after `--`, or point callmux at a config file
3. Use the downstream tools plus the `callmux_*` meta-tools from your agent

You can manage callmux's own downstream server registry from the CLI:

```bash
callmux init
callmux server add github --tools get_issue,list_issues -- npx -y @modelcontextprotocol/server-github
callmux server test github
callmux server set github --add-tool search_issues
callmux server list --json
callmux doctor
callmux client attach codex
callmux client attach codex --yes
```

`client attach` and `client detach` preview changes by default. Pass `--yes` to write the target client config file.

The simplest direct wrapper looks like this:

```bash
callmux -- npx -y @modelcontextprotocol/server-github
callmux --tools create_issue,search_issues -- npx -y @modelcontextprotocol/server-github
callmux --cache 60 -- node my-mcp-server.js
callmux --cache 60 --cache-allow get_*,list_* -- npx -y @modelcontextprotocol/server-github
```

With multiple downstream servers, tools are automatically namespaced like `github__create_issue` and `linear__list_issues`.

<details>
<summary>Claude Code</summary>

Add callmux as an MCP server in Claude Code settings (`~/.claude.json` or project `.mcp.json`).

If you already manage downstream servers in `~/.config/callmux/config.json`, you can print a ready-to-paste snippet with:

```bash
callmux client print claude
```

Single server:

```json
{
  "mcpServers": {
    "github": {
      "command": "callmux",
      "args": [
        "--tools", "create_issue,get_issue,list_issues,search_issues,search_code",
        "--cache", "60",
        "--cache-allow", "get_*,list_*,search_*",
        "--", "npx", "-y", "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

Claude sees the original tool names (`create_issue`, `search_issues`, etc.) plus the `callmux_*` meta-tools.

Multiple servers via config file:

When you want to wrap more than one MCP server through a single callmux instance, use a config file. Create `~/.config/callmux.json`:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "tools": ["create_issue", "get_issue", "list_issues", "search_issues"],
      "cachePolicy": { "allowTools": ["get_*", "list_*", "search_*"] }
    },
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"],
      "env": { "LINEAR_API_KEY": "lin_api_..." }
    }
  },
  "cacheTtlSeconds": 60,
  "cachePolicy": { "denyTools": ["*_issue"] },
  "maxConcurrency": 20
}
```

Then point Claude Code at it:

```json
{
  "mcpServers": {
    "callmux": {
      "command": "callmux",
      "args": ["--config", "~/.config/callmux/config.json"]
    }
  }
}
```

Or let callmux auto-discover `~/.config/callmux/config.json`:

```json
{
  "mcpServers": {
    "callmux": {
      "command": "callmux",
      "args": []
    }
  }
}
```

</details>

<details>
<summary>Codex</summary>

Codex stores MCP server configuration in `~/.codex/config.toml`, with optional project-scoped overrides in `.codex/config.toml`. The Codex macOS app, CLI, and IDE extension share this MCP configuration, so setting up callmux once makes it available in all three. Official Codex MCP docs: <https://developers.openai.com/codex/mcp>.

If you already manage downstream servers in `~/.config/callmux/config.json`, you can print a ready-to-paste snippet with:

```bash
callmux client print codex
```

Single server:

```toml
[mcp_servers.github]
command = "callmux"
args = [
  "--tools", "create_issue,get_issue,list_issues,search_issues,search_code",
  "--cache", "60",
  "--cache-allow", "get_*,list_*,search_*",
  "--", "npx", "-y", "@modelcontextprotocol/server-github"
]
```

Multi-server via callmux config file:

```toml
[mcp_servers.callmux]
command = "callmux"
args = ["--config", "/Users/you/.config/callmux/config.json"]
```

Codex users can also add the server with the `codex mcp` CLI instead of editing `config.toml` by hand:

```bash
codex mcp add github -- callmux --cache 60 --cache-allow get_*,list_*,search_* -- npx -y @modelcontextprotocol/server-github
```

</details>

### Config file format

When no `--config` or `--` arguments are given, callmux looks for a config file automatically:

1. `$CALLMUX_CONFIG` environment variable (if set)
2. `~/.config/callmux/config.json`

This path works on Linux, macOS, and Windows (`~` resolves to the user's home directory on all platforms).

The config file supports two formats:

**Native callmux format:**

```json
{
  "servers": {
    "<name>": {
      "command": "...",
      "args": ["..."],
      "env": { "KEY": "value" },
      "cwd": "/path",
      "tools": ["whitelist", "of", "tool", "names"],
      "cachePolicy": {
        "allowTools": ["get_*", "list_*"],
        "denyTools": ["get_secret"]
      }
    }
  },
  "cacheTtlSeconds": 60,
  "cachePolicy": {
    "denyTools": ["create_*"]
  },
  "maxConcurrency": 20
}
```

**MCP-compatible format** — if you already have an `mcpServers` block, callmux can read it directly:

```json
{
  "mcpServers": {
    "github": { "command": "...", "args": ["..."] }
  }
}
```

All fields on a server entry except `command` are optional. `tools` filters which tools are exposed — omit it to expose everything.

### Managing callmux from the CLI

Use the built-in CLI to manage the native callmux config format:

```bash
callmux init
callmux server add github --tools get_issue,list_issues -- npx -y @modelcontextprotocol/server-github
callmux server add linear --env LINEAR_API_KEY=lin_api_... -- npx -y @linear/mcp-server
callmux server test github
callmux server set github --add-tool search_issues --cache-deny create_*
callmux server list --json
callmux doctor
callmux client attach codex
callmux client attach codex --yes
callmux client detach codex --yes
callmux server remove linear
```

Notes:

- `callmux init` creates `~/.config/callmux/config.json` by default
- use `--config <path>` with any management command to target a different file
- `callmux doctor` validates config, checks whether downstream commands are resolvable, and attempts a lightweight connect/list-tools probe for each configured server
- `callmux server test <name>` is the focused smoke test for one downstream server, with optional `--tool <name>` verification
- `callmux server set <name>` and `callmux server edit <name>` update an existing downstream entry without re-adding it
- `callmux server list --json`, `callmux server test --json`, and `callmux doctor --json` are useful for scripts and agent workflows
- `callmux client print claude` and `callmux client print codex` print host-client snippets for registering callmux itself
- `callmux client attach` / `detach` target host client config files; they preview by default and only write with `--yes`
- management commands operate on native callmux config with a top-level `servers` object; they do not rewrite external `.mcp.json` / `mcpServers` files

## Meta-Tools

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

Validation failures are returned as tool results with `isError: true` and structured error payloads, so agents can inspect and self-correct.

### `callmux_batch`

Apply the same tool across many items.

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

Chain tool calls where output feeds into the next step.

```json
{
  "steps": [
    { "tool": "search_issues", "arguments": { "query": "is:open label:bug" } },
    { "tool": "analyze", "arguments": {}, "inputMapping": { "data": "$json" } }
  ]
}
```

### `callmux_cache_clear`

Clear the result cache.

```json
{ "tool": "get_issue", "server": "github" }
```

## Multi-Server Mode

With multiple servers, use the `server` field in meta-tool calls to target specific servers — enabling cross-server operations in a single call:

```json
{
  "calls": [
    { "server": "github", "tool": "get_issue", "arguments": { "number": 42 } },
    { "server": "linear", "tool": "get_issue", "arguments": { "id": "ENG-123" } }
  ]
}
```

## Use with Claude Desktop (Mac / Windows)

callmux works the same way in the Claude desktop app. Add it to your `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "callmux": {
      "command": "callmux",
      "args": []
    }
  }
}
```

> **Note:** The Claude desktop app has a minimal PATH. If `callmux` isn't found, use the full path to the binary (e.g., `/usr/local/bin/callmux` or `C:\\Users\\you\\AppData\\Roaming\\npm\\callmux.cmd`). Find it with `which callmux` (macOS/Linux) or `where callmux` (Windows).

## Caching

When `cacheTtlSeconds` is set, callmux can reuse cached results within the TTL window. Error results are never cached.

By default, caching falls back to the built-in read-tool heuristic. To tighten that behavior, use explicit cache policy rules:

```json
{
  "cacheTtlSeconds": 60,
  "cachePolicy": {
    "allowTools": ["get_*", "list_*", "search_*"],
    "denyTools": ["get_secret", "search_private_*"]
  }
}
```

- `allowTools`: if present, only matching tools are cacheable
- `denyTools`: matching tools are never cacheable
- Rules support exact names and `*` wildcards
- Per-server `cachePolicy` rules are combined with the global policy

Use `callmux_cache_clear` to invalidate manually by tool, server, or both.

## Related

- **[tokenlean](https://github.com/edimuj/tokenlean)** — CLI tools for AI agents, token-efficient code understanding. Same philosophy: make agents less wasteful.

## License

MIT
