# callmux

Multiplexer for MCP tool calls. Wraps any downstream MCP server and adds
parallel execution, batching, caching, and pipelining as meta-tools.

## Architecture

```
MCP Client (Claude, Codex, etc.)
  ↓ stdio
CallmuxProxy (src/proxy.ts)
  ├── exposes: proxied tools + meta-tools (parallel, batch, pipeline, cache_clear)
  ├── UpstreamManager (src/upstream.ts) — connects to downstream MCP servers as client
  ├── CallCache (src/cache.ts) — optional TTL-based result cache
  └── handlers.ts — meta-tool implementations with concurrency control
  ↓ stdio (per server)
Downstream MCP Server(s)
```

## Project Structure

```
src/
  bin/callmux.ts    # CLI entry point
  proxy.ts          # Main proxy: Server ← handles calls → UpstreamManager
  upstream.ts       # MCP Client connections to downstream servers
  handlers.ts       # parallel/batch/pipeline/cache_clear implementations
  meta-tools.ts     # Tool definitions for the 4 meta-tools
  cache.ts          # TTL-based call result cache
  config.ts         # Config loading (callmux.json or .mcp.json format)
  types.ts          # Shared type definitions
  index.ts          # Public API exports
```

## Dev Commands

```bash
npm run build       # tsc → dist/
npm run dev         # tsc --watch
npm test            # type-check + node --test
```

## Key Decisions

- **TypeScript** — MCP SDK is heavily typed, proxy needs schema juggling
- **Low-level Server class** (not McpServer) — we need to proxy arbitrary tool schemas from upstream, not register tools with Zod
- **Stdio-to-stdio proxy** for v1 — matches how Claude Code and most MCP clients spawn servers
- **Transport abstraction** — UpstreamManager handles connections, proxy doesn't care about transport type
- **Semaphore-based concurrency** — simple, no deps, limits parallel/batch fan-out
- **Two config formats** — native callmux config + MCP-compatible mcpServers (zero-friction adoption)

## Multi-server tool naming

Single server: tools keep original names (`create_issue`, `search`)
Multiple servers: tools are namespaced (`github__create_issue`, `jira__search`)
Meta-tools: always prefixed `callmux_` to avoid collisions
