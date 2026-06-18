[< Back to README](../README.md)

# Meta-Only Mode

## The Problem: Tool-Listing Bloat

Every tool definition in the system prompt costs tokens on every API turn. With multiple servers, 50-100+ tool definitions can dominate the prompt, and they're re-processed by the model on every single message, even when the agent only uses a few tools.

**Meta-only mode** hides all proxied tools and exposes only the 11 callmux meta-tools. The agent discovers available tools via `callmux_search_tools` or `callmux_status` and invokes them through `callmux_call`, recipes, or the batch/parallel meta-tools.

| | Standard Mode | Meta-Only Mode |
|:---|:---|:---|
| Tools in listing | All downstream + 11 meta-tools | 11 meta-tools only |
| Single tool call | Direct by name | `callmux_call` |
| Tool discovery | Automatic (in listing) | `callmux_search_tools` or `callmux_status` with `descriptions: true` |
| System prompt size | Grows with server count | Fixed at 9 tools |

---

## Enabling Meta-Only Mode

Three ways:

**Config file:**
```json
{
  "metaOnly": true,
  "descriptionMaxLength": 80
}
```

**CLI flag:**
```bash
callmux --meta-only
```

**Setup wizard:**
```bash
callmux setup   # offers meta-only as an option
```

---

## How the Agent Works

In meta-only mode, the agent follows this workflow:

### 1. Discover available servers

```json
// callmux_status (no args)
-> Returns: server names, tool counts, cache state, mode
```

### 2. Search tools

```json
// callmux_search_tools
{ "query": "github issue", "limit": 5 }
-> Returns matching callable tool names, servers, descriptions, scores, and input field hints
```

Use `server` to narrow results when you already know the target downstream server.

### 3. List tools

```json
// callmux_status with descriptions
{ "descriptions": true, "descriptionMaxLength": 80 }
-> Returns: tool names + truncated descriptions per server
```

This is useful for browsing the whole exposed surface. Use `descriptionMaxLength` to control description verbosity.

### 4. Call tools

Single tool call:
```json
// callmux_call
{ "tool": "get_issue", "server": "github", "arguments": { "number": 42 }, "timeoutMs": 300000, "cwd": "/work/repo" }
```

Parallel calls:
```json
// callmux_parallel
{
  "calls": [
    { "tool": "get_issue", "server": "github", "arguments": { "number": 1 }, "timeoutMs": 300000, "cwd": "/work/repo" },
    { "tool": "get_issue", "server": "github", "arguments": { "number": 2 } }
  ]
}
```

`timeoutMs` is optional. When set on a meta-tool call, it overrides the server/global timeout for that downstream call. If no meta `timeoutMs` is set, callmux also honors a downstream argument named `timeoutMs` or `timeout` as that call's timeout budget, while still forwarding the argument to the downstream tool.
`cwd` is optional and must be an absolute path. For session-cwd stdio servers, it overrides request/session cwd for that downstream call.

If a downstream response is too large, callmux returns a `_callmux.ref` with a compact preview. Page through the full stored result with:

```json
// callmux_get_result
{ "ref": "r_...", "offset": 0, "limit": 50, "fields": ["id", "name"] }
```

The truncated response also includes `_callmux.shape` and `_callmux.retrieval`:

- `_callmux.shape` describes the stored data type, item counts, object keys, and useful array paths.
- `_callmux.retrieval.arguments` is a ready-to-call first-page argument object.
- `_callmux.retrieval.supports` documents `path`, `offset`, `limit`, `fields`, and `search` semantics inline.

If your MCP client defers `callmux_get_result`, use the fallback carried in `_callmux.retrieval.viaCallmuxCall.arguments`:

```json
// callmux_call
{
  "tool": "callmux_get_result",
  "arguments": { "ref": "r_...", "offset": 0, "limit": 50 }
}
```

Batch, pipeline, and recipe calls work identically to standard mode.

---

## Error Handling

If `server` is wrong, `callmux_call` returns a structured `tool_resolution_failed` error with the instance identity and available server names, so the agent can self-correct without another status call.

---

## Tool Filtering + Meta-Only

Per-server `tools: [...]` whitelists still apply. They filter what `callmux_call` can invoke and what `callmux_status` reports. This lets you hide tools even from discovery.

---

## When to Use Meta-Only

- **Many servers (5+)** - system prompt savings become significant
- **Token-sensitive deployments** - every token in the system prompt compounds across the session
- **Consistent interface** - system prompt size never changes regardless of how many servers you add
- **Agents that struggle with large tool listings** - some models perform worse with 50+ tool definitions

---

## When to Skip It

- **Single server with few tools** - the overhead of `callmux_status` + `callmux_call` exceeds the savings
- **Agents that benefit from seeing all tools upfront** - some workflows are faster when the agent can call tools directly by name

---

## See Also

- [Config Reference](config-reference.md) - `metaOnly`, `descriptionMaxLength` fields
- [Recipes](recipes.md) - recipes work in meta-only mode without changes
