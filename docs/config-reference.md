[< Back to README](../README.md)

# Config Reference

## Config File Location

Auto-discovery order:

1. `$CALLMUX_CONFIG` environment variable
2. `~/.config/callmux/config.json`

Works on Linux, macOS, and Windows.

Add `$schema` for editor autocomplete (VS Code, JetBrains, etc.):

```json
{
  "$schema": "https://raw.githubusercontent.com/edimuj/callmux/main/schema.json"
}
```

callmux also accepts MCP-compatible format (`{ "mcpServers": { ... } }`) so you can adopt it without changing config structure.

---

## Global Options

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `servers` | object | *(required)* | Map of server name -> server config |
| `recipes` | object | - | Named reusable callmux workflows ([details](recipes.md)) |
| `cacheTtlSeconds` | integer | `0` | Cache TTL in seconds (0 = disabled) |
| `cachePolicy` | object | - | Global cache allow/deny rules (see [Caching](#caching)) |
| `maxConcurrency` | integer | `20` | Global max concurrent calls for parallel/batch |
| `connectTimeoutMs` | integer | `30000` | Timeout for downstream startup connect + list-tools |
| `callTimeoutMs` | integer | `180000` | Timeout for downstream tool calls |
| `reconnectPolicy` | object | retry forever | Downstream reconnect/backoff policy (see [Resilience](#resilience)) |
| `sessionCwdIdleTtlSeconds` | integer | `600` | Idle TTL for listener-mode session-cwd stdio clients (`0` = close after each call) |
| `requestBodyMaxBytes` | integer | `1048576` | Global max inbound request payload bytes (`0` = unlimited) |
| `allowRequestBodyMaxOverride` | boolean | `false` | Allow per-request `x-callmux-max-body-bytes` header override |
| `allowInsecureRemoteListener` | boolean | `false` | Permit non-loopback listener startup without auth (unsafe) |
| `auth` | object | - | Listener authentication config ([details](enterprise.md#authentication)) |
| `authorization` | object | - | Listener authorization policy ([details](enterprise.md#authorization-rbac)) |
| `abuseControls` | object | - | Rate limits, in-flight caps, CIDR allowlist ([details](enterprise.md#rate-limiting-and-abuse-controls)) |
| `auditLog` | object | - | Structured per-request audit logging ([details](enterprise.md#audit-logging)) |
| `metrics` | object | - | Prometheus metrics endpoint ([details](enterprise.md#prometheus-metrics)) |
| `dashboard` | object | disabled | Read-only listener dashboard ([details](dashboard.md)) |
| `management` | object | disabled | Standalone listener management API |
| `strictStartup` | boolean | `false` | Fail startup if any server fails to connect |
| `maxCacheEntries` | integer | `1000` | Max cached entries before LRU eviction |
| `metaOnly` | boolean | `false` | Hide proxied tools, expose only meta-tools ([details](meta-only-mode.md)) |
| `descriptionMaxLength` | integer | - | Default max chars for tool descriptions in `callmux_status` |
| `outputFormat` | `"json"`, `"toon"`, or `"auto"` | `"json"` | Model-facing text format for callmux-owned structured results |
| `responseShield` | object | enabled | Response truncation, stored-result refs, and per-tool shielding rules |
| `schemaCompression` | object | balanced | Tool schema description compression for prompt-token reduction |

Tool-call timeout precedence is: meta-tool `timeoutMs`, then `servers.<name>.callTimeoutMs`, then global `callTimeoutMs`, then the built-in default.
Session-cwd precedence is: explicit meta-tool `cwd`, request `_meta` cwd, existing session cwd/header, then MCP roots when no session cwd exists.

`outputFormat` changes only the visible text in `content[].text` for callmux-owned structured results. `structuredContent`, cache keys, stored results, dashboard state, and pipeline `$json` mapping stay JSON-native. Use `"toon"` for explicit TOON rendering, or `"auto"` to choose TOON only for larger tabular payloads where it is materially smaller than pretty JSON.

---

## Stdio Server Config

Local process servers use `command` to launch:

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `command` | string | yes | Command to launch the MCP server |
| `args` | string[] | - | Arguments passed to the command |
| `env` | object | - | Environment variables for the process |
| `cwd` | string | - | Working directory |
| `cwdMode` | `"global"` or `"session"` | - | Listener-mode cwd behavior. Omit for session/project cwd when available; use `"global"` to force configured/process cwd |
| `tools` | string[] | - | Whitelist of tool names to expose (omit = all) |
| `maxConcurrency` | integer | - | Max concurrent calls to this server |
| `callTimeoutMs` | integer | - | Timeout for tool calls to this server (omit = global) |
| `requestBodyMaxBytes` | integer | - | Inbound payload cap for calls targeting this server (`0` = unlimited, omit = global) |
| `cachePolicy` | object | - | Per-server cache allow/deny rules |
| `responseShield` | object | - | Per-server response shielding overrides |
| `schemaCompression` | object | - | Per-server schema compression overrides |

---

## HTTP Server Config

Remote servers use `url` instead of `command`:

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `url` | string | yes | URL of the remote MCP server |
| `transport` | string | - | `"streamable-http"` or `"sse"` (auto-detected if omitted) |
| `headers` | object | - | HTTP headers (e.g. authorization) |
| `tools` | string[] | - | Whitelist of tool names to expose (omit = all) |
| `maxConcurrency` | integer | - | Max concurrent calls to this server |
| `callTimeoutMs` | integer | - | Timeout for tool calls to this server (omit = global) |
| `requestBodyMaxBytes` | integer | - | Inbound payload cap for calls targeting this server (`0` = unlimited, omit = global) |
| `cachePolicy` | object | - | Per-server cache allow/deny rules |
| `responseShield` | object | - | Per-server response shielding overrides |
| `schemaCompression` | object | - | Per-server schema compression overrides |

Transport is auto-detected: callmux tries Streamable HTTP first (the current MCP spec), then falls back to SSE for older servers. Force a specific transport with `"transport": "sse"` or `"transport": "streamable-http"`.

Startup is degraded by default: if one downstream server fails to connect, callmux still starts with the healthy servers and reports failures in `callmux_status.failedServers`. Set `"strictStartup": true` or pass `--strict-startup` to fail startup when any downstream server fails.

---

## Resilience

callmux keeps configured downstream servers as first-class targets even when they are down. A call routed to a configured-but-unavailable server returns a structured `downstream_unavailable` error with retry metadata instead of `server_not_found`.

By default, failed downstream servers reconnect forever with jittered exponential backoff. Calls during a scheduled backoff window fast-fail so a down server does not block every request on a fresh connect attempt. Use `forceReconnect: true` on `callmux_call` to bypass that window for an explicit recovery attempt.

```json
{
  "reconnectPolicy": {
    "initialDelayMs": 250,
    "maxDelayMs": 10000,
    "jitterRatio": 0.2,
    "maxAttempts": null,
    "fastFailDuringBackoff": true
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `initialDelayMs` | integer | `250` | Initial reconnect backoff |
| `maxDelayMs` | integer | `10000` | Maximum reconnect backoff |
| `jitterRatio` | number | `0.2` | Random jitter applied to reconnect delays (`0` disables jitter) |
| `maxAttempts` | integer or null | `null` | Maximum failed reconnect attempts before stopping; `null` retries forever |
| `fastFailDuringBackoff` | boolean | `true` | Return `downstream_unavailable` during scheduled backoff instead of blocking on reconnect |

When a connected server disconnects or a tool call hits a transport/session/protocol/timeout failure, callmux retires that client and allows the next call to try reconnecting immediately. For cacheable safe calls, callmux may retry once after reconnecting.

Tool suites are refreshed on reconnect. `listTools` is dynamic, callmux meta-tools stay present, and `callmux_status` reports `toolSuiteGeneration` plus per-server `addedTools` and `removedTools`. Calling a tool that disappeared after reconnect returns `tool_removed_after_reconnect` with the current alternatives.

Listener deployments expose two status endpoints:

- `/health` always reports listener liveness and session counts.
- `/ready` reports operational readiness and returns HTTP 503 when configured downstream servers are unavailable.

---

## Caching

Enable with `cacheTtlSeconds` or `--cache <seconds>`. Error results are never cached.

```json
{
  "cacheTtlSeconds": 60,
  "maxCacheEntries": 1000,
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
- Oldest cache entries are evicted after `maxCacheEntries` (default: 1000)
- `callmux_cache_clear` invalidates manually

---

## Response Shielding

Response shielding is enabled by default. When a tool result is too large, callmux stores the full result in memory and returns a compact preview with `_callmux.ref`, `_callmux.shape`, and `_callmux.retrieval`. Use `callmux_get_result` to page through the stored result. If an MCP client defers that tool, call `callmux_call` with `tool: "callmux_get_result"` and the same retrieval arguments.

Defaults:

| Field | Default | Description |
|:------|:--------|:------------|
| `enabled` | `true` | Enable response shielding |
| `maxResultBytes` | `65536` | Store and compact responses larger than this many serialized bytes |
| `maxStringChars` | `8192` | Truncate individual string fields longer than this |
| `maxArrayItems` | `50` | Truncate arrays longer than this |
| `maxStoredResults` | `100` | Global stored-result capacity before oldest refs are evicted |
| `allowTools` | - | Only shield matching tools when set |
| `denyTools` | - | Never shield matching tools; takes precedence |

Global example:

```json
{
  "responseShield": {
    "maxResultBytes": 32768,
    "maxStringChars": 4000,
    "maxArrayItems": 25,
    "maxStoredResults": 200,
    "denyTools": ["download_*"]
  }
}
```

Per-server override:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "responseShield": {
        "enabled": false
      }
    }
  }
}
```

Retrieve a stored result:

```json
{
  "ref": "r_...",
  "offset": 0,
  "limit": 50,
  "fields": ["id", "name"],
  "search": "failed",
  "outputFormat": "auto"
}
```

---

## Schema Compression

`schemaCompression` reduces system-prompt bloat from verbose MCP tool schemas. It only rewrites `description` fields on exposed tool definitions and input schemas; names, types, required fields, enums, defaults, bounds, and the actual argument contract are preserved.

Balanced mode is the default. It drops descriptions that only restate compact field names, caps retained descriptions, and keeps guidance for ambiguous fields such as `ref`, `cursor`, `sha`, `type`, `state_reason`, and `market`.

| Field | Default | Description |
|:------|:--------|:------------|
| `enabled` | `true` | Enable schema compression |
| `mode` | `"balanced"` | `"off"`, `"balanced"`, or `"aggressive"` |
| `maxDescriptionChars` | `160` | Maximum chars for retained descriptions |

```json
{
  "schemaCompression": {
    "mode": "balanced",
    "maxDescriptionChars": 160
  },
  "servers": {
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio"],
      "schemaCompression": { "mode": "aggressive" }
    },
    "docs": {
      "command": "docs-mcp",
      "schemaCompression": { "enabled": false }
    }
  }
}
```

`callmux_status` includes `schemaCompression` diagnostics with original/compressed schema bytes and estimated savings.

`callmux_status` includes `responseStore` stats: active stored refs, capacity, stored bytes, and total stored results since startup.

---

## Dashboard

The dashboard is disabled by default. Enable it only for listener deployments where the HTTP endpoint is trusted or protected by listener auth:

```json
{
  "dashboard": {
    "enabled": true,
    "path": "/dashboard",
    "maxEvents": 500
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `enabled` | boolean | `false` | Serve the read-only dashboard endpoints |
| `path` | string | `"/dashboard"` | Dashboard base path |
| `maxEvents` | integer | `500` | Bounded in-memory event history size |

`path` can be `/`, `/dashboard`, or a reverse-proxy prefix such as `/relay/`. Non-root trailing slashes are normalized, and the UI resolves `data` and `events` relative to the loaded page URL.

When auth is configured, dashboard requests use the same listener authentication as `/mcp`.

---

## Management API

The management API is disabled by default and only applies to standalone listener mode. It exposes versioned HTTP+JSON endpoints under `/management/v1` by default. Mutations require management bearer auth and persist to a callmux-owned overlay file, leaving the base config file untouched.

```json
{
  "management": {
    "enabled": true,
    "path": "/management/v1",
    "statePath": "/var/lib/callmux/managed-overlay.json",
    "auth": {
      "mode": "bearer",
      "tokens": [{ "id": "admin", "tokenRef": "env:CALLMUX_MANAGEMENT_TOKEN" }]
    }
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `enabled` | boolean | `false` | Serve management endpoints |
| `path` | string | `"/management/v1"` | Management API base path |
| `statePath` | string | `<config>.management.json` | Persistent managed overlay path |
| `auth` | bearer auth object | - | Management bearer tokens. Required for mutations |
| `allowUnauthenticatedRead` | boolean | `false` | Allow read-only management endpoints without management auth |

Initial endpoints:

| Endpoint | Purpose |
|:---------|:--------|
| `GET /management/v1/status` | Runtime status, management state, and servers |
| `GET /management/v1/config/effective` | Redacted effective config |
| `GET /management/v1/servers` | Redacted server config plus runtime state |
| `POST /management/v1/servers` | Add or replace a managed server |
| `PATCH /management/v1/servers/:id` | Update tools, disabled state, or full server config |
| `DELETE /management/v1/servers/:id` | Remove a server via overlay |
| `POST /management/v1/servers/:id/restart` | Reconnect using the current effective config |
| `POST /management/v1/cache/clear` | Clear cache globally or by `server`/`tool` |

---

## File References

Any argument object can use file references. callmux reads the file and replaces the reference with file content before forwarding to the downstream MCP tool.

Use the reference that matches the downstream field shape:

| Need | Use | Do not use |
| --- | --- | --- |
| Markdown or plain string fields such as GitHub issue `body`, `description`, `comment`, `text`, or `content` | `$file` or `$text` | `$jsonFile` unless the JSON file contains a JSON string |
| Full structured argument objects, arrays, or nested payload fields | `$jsonFile` or `$yamlFile` | `$file` if the downstream tool expects an object/array |
| Previous pipeline step output | `inputMapping` with `$text`, `$json`, or `$json.path` | Literal `"$json"` inside downstream `arguments` |

`$json` is not a file reference. It is valid only in `callmux_pipeline` `inputMapping`, where it means "parse the previous step's text as JSON". If you put `"$json"` directly under downstream `arguments`, callmux treats it as a suspicious literal and `callmux_dry_run` reports a warning.

### `$file` - Raw file content

```json
{
  "body": { "$file": "/tmp/issue-body.md" }
}
```

Optional `maxBytes` override per reference:

```json
{
  "body": { "$file": "/tmp/issue-body.md", "maxBytes": 2000000 }
}
```

- `maxBytes` defaults to `1000000` (1 MB) when omitted
- Hard cap for `maxBytes` is `10000000` (10 MB)

### `$jsonFile` / `$yamlFile` - Parsed file content

```json
{
  "payload": { "$jsonFile": "/tmp/payload.json" },
  "config": { "$yamlFile": "/tmp/config.yaml" }
}
```

Both support optional `maxBytes` like `$file`.

`$jsonFile` and `$yamlFile` forward the parsed value as-is. That is right for structured fields:

```json
{
  "metadata": { "$jsonFile": "/tmp/metadata.json" }
}
```

For string fields, use `$file` or `$text` instead:

```json
{
  "tool": "github__create_issue",
  "arguments": {
    "title": "Bug report",
    "body": { "$file": "/tmp/issue-body.md" }
  }
}
```

Avoid this unless `/tmp/issue-body.json` contains a JSON string:

```json
{
  "tool": "github__create_issue",
  "arguments": {
    "title": "Bug report",
    "body": { "$jsonFile": "/tmp/issue-body.json" }
  }
}
```

### `$text` - Inline text composition

Skip writing a temp file for long multi-line text:

```json
{
  "body": {
    "$text": {
      "lines": [
        "## Summary",
        "",
        "| Field | Value |",
        "| --- | --- |",
        "| A | B |"
      ]
    }
  }
}
```

`$text` forms:
- `{"$text": "literal string"}`
- `{"$text": {"lines": ["line1", "line2"], "join": "\n"}}` (`join` defaults to newline)

Like `$file`, `$text` is resolved by callmux before forwarding, so downstream MCP servers receive a normal string.

---

## Multi-Server Tool Naming

Single server: tools keep original names (`create_issue`, `search`)

Multiple servers: tools are automatically namespaced (`github__create_issue`, `linear__list_issues`)

Meta-tools: always prefixed `callmux_` to avoid collisions

The `server` field in meta-tool calls lets you target specific servers:

```json
{
  "calls": [
    { "server": "github", "tool": "get_issue", "arguments": { "number": 42 } },
    { "server": "linear", "tool": "get_issue", "arguments": { "id": "ENG-123" } }
  ]
}
```

---

## Full Example Config

```json
{
  "$schema": "https://raw.githubusercontent.com/edimuj/callmux/main/schema.json",
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxx" },
      "tools": ["create_issue", "get_issue", "list_issues", "search_issues"],
      "maxConcurrency": 5,
      "cachePolicy": { "allowTools": ["get_*", "list_*"] }
    },
    "remote-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer sk-..." },
      "transport": "streamable-http"
    }
  },
  "recipes": {
    "open_bug": {
      "description": "Create a labeled bug issue",
      "mode": "call",
      "server": "github",
      "tool": "create_issue",
      "arguments": {
        "title": { "$param": "title" },
        "body": { "$param": "body" },
        "labels": ["bug"]
      }
    }
  },
  "cacheTtlSeconds": 60,
  "maxCacheEntries": 1000,
  "cachePolicy": { "denyTools": ["create_*"] },
  "maxConcurrency": 20,
  "connectTimeoutMs": 30000,
  "callTimeoutMs": 180000,
  "strictStartup": false,
  "metaOnly": false,
  "descriptionMaxLength": 80,
  "outputFormat": "json",
  "responseShield": {
    "maxResultBytes": 65536,
    "maxStoredResults": 100,
    "denyTools": ["download_*"]
  },
  "schemaCompression": {
    "mode": "balanced",
    "maxDescriptionChars": 160
  },
  "auth": {
    "mode": "bearer",
    "tokens": [{ "id": "ops", "hash": "scrypt$16384$8$1$<salt>$<derivedKey>" }],
    "allowUnauthenticatedHealth": false
  },
  "authorization": {
    "defaultEffect": "deny",
    "rules": [
      { "id": "ops-all", "effect": "allow", "principals": ["bearer:ops"], "tools": ["*"] },
      { "id": "agents-read", "effect": "allow", "principals": ["oidc:*"], "tools": ["github__get_*", "github__list_*"] }
    ]
  },
  "abuseControls": {
    "globalRequestsPerMinute": 1200,
    "principalRequestsPerMinute": 240,
    "principalMaxInFlight": 20,
    "cidrAllowlist": ["127.0.0.1/32", "::1/128"]
  },
  "auditLog": {
    "enabled": true,
    "includeRequestBody": false,
    "maxPayloadChars": 4096
  },
  "metrics": {
    "enabled": true,
    "path": "/metrics",
    "allowUnauthenticated": false
  },
  "dashboard": {
    "enabled": true,
    "path": "/dashboard",
    "maxEvents": 500
  }
}
```

---

## See Also

- [CLI Reference](cli-reference.md) - command-line flags and management commands
- [Enterprise Deployment](enterprise.md) - auth, RBAC, rate limiting, audit details
- [Recipes](recipes.md) - workflow template guide
- [Shared Server Mode](shared-server.md) - listener setup and client config
