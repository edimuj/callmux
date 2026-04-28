# Meta-only mode

## Problem

When callmux wraps MCP servers, it proxies all downstream tools into the agent's tool listing. With multiple servers this can mean 50-100+ tool definitions in the system prompt on every API turn. This burns context and dilutes attention, partially undermining the context savings that callmux's batching provides.

Users who want single-tool calls currently need the original MCP server defined alongside callmux, creating redundancy.

## Solution

A new `metaOnly` config flag that hides all proxied tools from the tool listing. The agent sees only meta-tools and discovers available tools through `callmux_status`. A new `callmux_call` meta-tool handles single tool invocations.

## Design

### Config changes

New fields on `CallmuxConfig`:

```typescript
interface CallmuxConfig {
  // ... existing fields ...
  metaOnly?: boolean;               // default false
  descriptionMaxLength?: number;     // default: unlimited
}
```

`metaOnly` controls whether proxied tools appear in the tool listing.

`descriptionMaxLength` sets the default truncation length for tool descriptions returned by `callmux_status`. Truncated descriptions get a trailing `...`. Overridable per-call.

Both fields supported in native callmux.json and MCP-compatible config formats.

### New meta-tool: `callmux_call`

Single tool invocation with flat parameters. Primary invocation path in meta-only mode; also available in standard mode.

```json
{
  "name": "callmux_call",
  "description": "Call a single tool on a downstream server. Primary way to invoke tools in meta-only mode. Use callmux_status with descriptions:true to discover available tools.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tool": { "type": "string", "description": "Tool name to call. Use original tool name with server param, or qualified name (e.g. github__get_issue) without server param in multi-server setups." },
      "server": { "type": "string", "description": "Target server name (optional if only one server configured)" },
      "arguments": { "type": "object", "description": "Arguments to pass to the tool" }
    },
    "required": ["tool"]
  }
}
```

Behavior:
- Resolves server the same way parallel/batch do (explicit `server` param, or auto-resolve for single-server setups). Both forms work in multi-server: `{ tool: "get_issue", server: "github" }` and `{ tool: "github__get_issue" }`.
- Goes through the cache identically to proxied tool calls
- Validates tool name exists on the resolved server. On failure, returns an error listing available tools on the target server (or all servers if no server specified)
- Returns the raw tool result (no wrapper object, unlike parallel/batch which return structured results with timing)

### Enhanced `callmux_status`

Schema updates: add `descriptions` and `descriptionMaxLength` to `callmux_status` inputSchema in `meta-tools.ts` (currently has `additionalProperties: false`, so new params must be declared).

Two new optional parameters:

| Parameter | Type | Default | Description |
|:--|:--|:--|:--|
| `descriptions` | boolean | false | Include tool descriptions in output |
| `descriptionMaxLength` | number | config default or unlimited | Max chars per description (0 or omit = no limit). Truncated values end with `...` |

`descriptionMaxLength` in the call overrides the config-level default. Only applies when `descriptions` is true.

New field in response: `mode` is always present. Values: `"meta-only"` or `"standard"`.

`handleStatus` signature gains `metaOnly: boolean` parameter so it can report the mode.

Response shape varies by `descriptions` flag:

**`descriptions: false` (default)** - tools is `string[]`, same as today:

```json
{
  "status": "ok",
  "mode": "standard",
  "servers": [{ "name": "github", "tools": ["get_issue", "create_issue"], "toolCount": 24 }],
  "totalTools": 87
}
```

**`descriptions: true`** - tools becomes `Array<{ name, description }>`:

```json
{
  "status": "ok",
  "mode": "meta-only",
  "servers": [
    {
      "name": "github",
      "tools": [
        { "name": "get_issue", "description": "Get details of a specific issue..." },
        { "name": "create_issue", "description": "Create a new issue in a reposit..." }
      ],
      "toolCount": 24
    }
  ],
  "totalTools": 87,
  "cache": { "size": 3, "hits": 12, "misses": 5 },
  "maxConcurrency": 20
}
```

The response shape is intentionally polymorphic: the agent controls which shape it gets via the `descriptions` flag it passes. This avoids always paying the cost of full descriptions.

### Proxy changes

In `CallmuxProxy.start()`, tool list assembly becomes mode-dependent:

```
metaOnly = true:
  allTools = META_TOOLS  (now includes callmux_call)

metaOnly = false:
  allTools = proxiedTools + META_TOOLS  (current behavior)
```

`callmux_call` is always present in META_TOOLS regardless of mode. In non-meta-only mode it still works, it's just redundant with the proxied tools.

Startup log reflects the mode (use `META_TOOLS.length` dynamically, not hardcoded):

```
[callmux] Meta-only mode: ${META_TOOLS.length} meta-tools (87 tools available via callmux_call/parallel/batch)
```

vs current:

```
[callmux] Proxying 87 tools from 4 server(s) + ${META_TOOLS.length} meta-tools
```

### Onboarding (setup wizard)

New question after server configuration:

> Meta-only mode hides individual tools from your agent's tool listing and exposes them only through callmux meta-tools (callmux_call, callmux_parallel, etc). This reduces tool listing bloat from N tools to 6, regardless of how many servers you configure. Enable meta-only mode? (y/N)

Default is no, preserving current behavior for new users unless they explicitly opt in. The wizard should show the actual tool count discovered from configured servers (e.g. "from 24 tools to 6") rather than the generic "N".

### Handler implementation

`callmux_call` handler (in handlers.ts):

1. Validate `tool` is a non-empty string
2. Resolve server (same logic as parallel/batch: explicit param > auto-resolve for single server > error)
3. Validate tool exists on the resolved server. On failure: return `errorResult("tool_not_found", message, { available: string[] })` listing available tools on the target server
4. Check cache, return if hit
5. Call upstream, cache result, return

This is essentially the same code path as the proxied tool handler in `CallmuxProxy.handleToolCall()`, extracted to work with explicit server/tool parameters.

### What doesn't change

- parallel, batch, pipeline work identically in both modes
- Cache behavior unchanged
- Multi-server namespacing: in meta-only mode, tools aren't in the listing so namespace prefixes don't apply to tool definitions. However, `callmux_call` accepts both forms: `{ tool: "get_issue", server: "github" }` or `{ tool: "github__get_issue" }` (same resolution logic as parallel/batch)
- Per-server tool whitelisting (`tools: [...]` in config) still applies and filters what's available through `callmux_call` and `callmux_status`

## Files to modify

| File | Change |
|:--|:--|
| `src/types.ts` | Add `metaOnly` and `descriptionMaxLength` to `CallmuxConfig` |
| `src/config.ts` | Parse new config fields |
| `src/meta-tools.ts` | Add `callmux_call` definition; add `descriptions` and `descriptionMaxLength` params to `callmux_status` inputSchema |
| `src/handlers.ts` | Add `handleCall()`. Update `handleStatus()`: add `metaOnly` param, add descriptions support. Add `handleCall` error path that lists available tools on tool-not-found |
| `src/proxy.ts` | Conditional tool list based on `metaOnly`, pass `metaOnly` to `handleStatus()` |
| `src/upstream.ts` | Add `getToolsWithDescriptions(serverName?: string): Array<{ name: string, description?: string }>` method. `getTools()` already returns full `Tool[]` objects with descriptions; this method filters to just name + description for status output |
| `src/detect.ts` | Support `metaOnly` in setup wizard |

## Edge cases

- `callmux_call` with a tool name that doesn't exist: return error with available tool names (same pattern as status server_not_found)
- `callmux_call` in non-meta-only mode: works fine, just redundant
- `descriptionMaxLength: 0` or omitted: no truncation (full descriptions). Document this in the `callmux_status` schema description to avoid ambiguity
- Downstream server with no tool descriptions: description field omitted or empty string
- Tool whitelist + meta-only: `callmux_call` respects the whitelist, `callmux_status` only shows whitelisted tools
