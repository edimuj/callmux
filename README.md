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

### Wrap a single server

The simplest way — pass the downstream command after `--`:

```bash
callmux -- npx -y @modelcontextprotocol/server-github
callmux --tools create_issue,search_issues -- npx -y @modelcontextprotocol/server-github
callmux --cache 60 -- node my-mcp-server.js
```

### Use with Claude Code

Add callmux as an MCP server in your Claude Code settings (`~/.claude.json` or project `.mcp.json`). This is the same as any other MCP server entry — callmux just wraps the real one.

**Single server — inline args:**

```json
{
  "mcpServers": {
    "github": {
      "command": "callmux",
      "args": [
        "--tools", "create_issue,get_issue,list_issues,search_issues,search_code",
        "--cache", "60",
        "--", "npx", "-y", "@modelcontextprotocol/server-github"
      ]
    }
  }
}
```

Claude sees the original tool names (`create_issue`, `search_issues`, etc.) plus the `callmux_*` meta-tools.

**Multiple servers — config file:**

When you want to wrap more than one MCP server through a single callmux instance, use a config file. Create `~/.config/callmux.json`:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
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

Or even simpler — callmux auto-discovers `~/.config/callmux/config.json` when no arguments are given:

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

With multiple servers, tools are automatically namespaced: `github__create_issue`, `linear__list_issues`. This avoids collisions when servers expose tools with the same name. The meta-tools can target any server's tools — including cross-server pipelines.

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
      "tools": ["whitelist", "of", "tool", "names"]
    }
  },
  "cacheTtlSeconds": 60,
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
{ "tool": "get_issue" }
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

When `cacheTtlSeconds` is set, read results are cached and reused within the TTL window. Error results are never cached. Use `callmux_cache_clear` to invalidate manually.

## Related

- **[tokenlean](https://github.com/edimuj/tokenlean)** — CLI tools for AI agents, token-efficient code understanding. Same philosophy: make agents less wasteful.

## License

MIT
