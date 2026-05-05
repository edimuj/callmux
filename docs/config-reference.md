[← Back to README](../README.md)

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

callmux also accepts MCP-compatible format (`{ "mcpServers": { ... } }`) for zero-friction adoption.

---

## Global Options

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `servers` | object | *(required)* | Map of server name → server config |
| `recipes` | object | — | Named reusable callmux workflows ([details](recipes.md)) |
| `cacheTtlSeconds` | integer | `0` | Cache TTL in seconds (0 = disabled) |
| `cachePolicy` | object | — | Global cache allow/deny rules (see [Caching](#caching)) |
| `maxConcurrency` | integer | `20` | Global max concurrent calls for parallel/batch |
| `connectTimeoutMs` | integer | `30000` | Timeout for downstream startup connect + list-tools |
| `callTimeoutMs` | integer | `30000` | Timeout for downstream tool calls |
| `sessionCwdIdleTtlSeconds` | integer | `600` | Idle TTL for listener-mode session-cwd stdio clients (`0` = close after each call) |
| `requestBodyMaxBytes` | integer | `1048576` | Global max inbound request payload bytes (`0` = unlimited) |
| `allowRequestBodyMaxOverride` | boolean | `false` | Allow per-request `x-callmux-max-body-bytes` header override |
| `allowInsecureRemoteListener` | boolean | `false` | Permit non-loopback listener startup without auth (unsafe) |
| `auth` | object | — | Listener authentication config ([details](enterprise.md#authentication)) |
| `authorization` | object | — | Listener authorization policy ([details](enterprise.md#authorization-rbac)) |
| `abuseControls` | object | — | Rate limits, in-flight caps, CIDR allowlist ([details](enterprise.md#rate-limiting-and-abuse-controls)) |
| `auditLog` | object | — | Structured per-request audit logging ([details](enterprise.md#audit-logging)) |
| `metrics` | object | — | Prometheus metrics endpoint ([details](enterprise.md#prometheus-metrics)) |
| `strictStartup` | boolean | `false` | Fail startup if any server fails to connect |
| `maxCacheEntries` | integer | `1000` | Max cached entries before LRU eviction |
| `metaOnly` | boolean | `false` | Hide proxied tools, expose only meta-tools ([details](meta-only-mode.md)) |
| `descriptionMaxLength` | integer | — | Default max chars for tool descriptions in `callmux_status` |

---

## Stdio Server Config

Local process servers use `command` to launch:

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `command` | string | yes | Command to launch the MCP server |
| `args` | string[] | — | Arguments passed to the command |
| `env` | object | — | Environment variables for the process |
| `cwd` | string | — | Working directory |
| `cwdMode` | `"global"` or `"session"` | — | Listener-mode cwd behavior. Omit for session/project cwd when available; use `"global"` to force configured/process cwd |
| `tools` | string[] | — | Whitelist of tool names to expose (omit = all) |
| `maxConcurrency` | integer | — | Max concurrent calls to this server |
| `requestBodyMaxBytes` | integer | — | Inbound payload cap for calls targeting this server (`0` = unlimited, omit = global) |
| `cachePolicy` | object | — | Per-server cache allow/deny rules |

---

## HTTP Server Config

Remote servers use `url` instead of `command`:

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `url` | string | yes | URL of the remote MCP server |
| `transport` | string | — | `"streamable-http"` or `"sse"` (auto-detected if omitted) |
| `headers` | object | — | HTTP headers (e.g. authorization) |
| `tools` | string[] | — | Whitelist of tool names to expose (omit = all) |
| `maxConcurrency` | integer | — | Max concurrent calls to this server |
| `requestBodyMaxBytes` | integer | — | Inbound payload cap for calls targeting this server (`0` = unlimited, omit = global) |
| `cachePolicy` | object | — | Per-server cache allow/deny rules |

Transport is auto-detected: callmux tries Streamable HTTP first (the current MCP spec), then falls back to SSE for older servers. Force a specific transport with `"transport": "sse"` or `"transport": "streamable-http"`.

Startup is degraded by default: if one downstream server fails to connect, callmux still starts with the healthy servers and reports failures in `callmux_status.failedServers`. Set `"strictStartup": true` or pass `--strict-startup` to fail startup when any downstream server fails.

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

## File References

Any argument object can use file references. callmux reads the file and replaces the reference with file content before forwarding to the downstream MCP tool.

### `$file` — Raw file content

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

### `$jsonFile` / `$yamlFile` — Parsed file content

```json
{
  "payload": { "$jsonFile": "/tmp/payload.json" },
  "config": { "$yamlFile": "/tmp/config.yaml" }
}
```

Both support optional `maxBytes` like `$file`.

### `$text` — Inline text composition

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
  "callTimeoutMs": 30000,
  "strictStartup": false,
  "metaOnly": false,
  "descriptionMaxLength": 80,
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
  }
}
```

---

## See Also

- [CLI Reference](cli-reference.md) — command-line flags and management commands
- [Enterprise Deployment](enterprise.md) — auth, RBAC, rate limiting, audit details
- [Recipes](recipes.md) — workflow template guide
- [Shared Server Mode](shared-server.md) — listener setup and client config
