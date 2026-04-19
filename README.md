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

### Single server (inline)

```bash
# Wrap any MCP server — callmux proxies all its tools and adds meta-tools
callmux -- npx -y @modelcontextprotocol/server-github

# With caching (60s TTL for read operations)
callmux --cache 60 -- node my-mcp-server.js
```

### Config file (multi-server)

```json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] },
    "jira": { "command": "node", "args": ["jira-mcp.js"] }
  },
  "cacheTtlSeconds": 60,
  "maxConcurrency": 20
}
```

```bash
callmux --config callmux.json
```

### Use with Claude Code

```json
{
  "mcpServers": {
    "github-mux": {
      "command": "callmux",
      "args": ["--cache", "60", "--", "npx", "-y", "@modelcontextprotocol/server-github"]
    }
  }
}
```

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

When multiple servers are configured, tools are namespaced to avoid collisions:

- `github__create_issue`
- `jira__create_ticket`

Use the `server` field in meta-tool calls to target specific servers:

```json
{
  "calls": [
    { "server": "github", "tool": "get_issue", "arguments": { "number": 1 } },
    { "server": "jira", "tool": "get_ticket", "arguments": { "key": "PROJ-1" } }
  ]
}
```

## Caching

When `cacheTtlSeconds` is set, read results are cached and reused within the TTL window. Error results are never cached. Use `callmux_cache_clear` to invalidate manually.

## Related

- **[tokenlean](https://github.com/edimuj/tokenlean)** — CLI tools for AI agents, token-efficient code understanding. Same philosophy: make agents less wasteful.

## License

MIT
