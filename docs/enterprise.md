[← Back to README](../README.md)

# Enterprise Deployment

callmux in [shared server mode](shared-server.md) supports authentication, role-based access control, rate limiting, audit logging, and Prometheus metrics. These features are designed for teams deploying callmux as shared infrastructure.

---

## Authentication

### Bearer Tokens

Recommended for teams and internal deployments.

```json
{
  "auth": {
    "mode": "bearer",
    "tokens": [
      { "id": "ops", "hash": "scrypt$16384$8$1$<salt>$<derivedKey>" }
    ],
    "allowUnauthenticatedHealth": true
  }
}
```

**Token formats** (in order of preference):

| Format | Example | Use case |
|:-------|:--------|:---------|
| Hashed (recommended) | `{ "id": "ops", "hash": "scrypt$..." }` | Production |
| Secret reference | `{ "id": "ops", "hashRef": "env:CALLMUX_HASH" }` | Secrets from env vars |
| File reference | `{ "id": "ops", "hashRef": "file:./secrets/callmux.hash" }` | Secrets from files |
| Plaintext (migration only) | `{ "id": "ops", "token": "sk-..." }` | Temporary migration |

`tokenRef` values are converted to in-memory scrypt hashes at config load time. `callmux doctor` flags plaintext `token` values so you can migrate safely.

**Generate a scrypt hash:**

```bash
node --input-type=module -e 'import { scryptSync, randomBytes } from "node:crypto"; const t=process.argv[1]; if(!t){ throw new Error("token required"); } const N=16384,r=8,p=1; const salt=randomBytes(16); const maxmem=256*N*r+1048576; const dk=scryptSync(t, salt, 32, { N, r, p, maxmem }); console.log(["scrypt",N,r,p,salt.toString("base64url"),dk.toString("base64url")].join("$"));' "replace-with-token"
```

Relative paths in `file:` references resolve from the config file directory.

### OIDC JWT

Recommended for enterprise identity federation. Agents authenticate with JWTs from your identity provider; callmux validates signatures via JWKS.

```json
{
  "auth": {
    "mode": "oidc_jwt",
    "issuer": "https://auth.example.com/",
    "audience": "callmux",
    "jwksUri": "https://auth.example.com/.well-known/jwks.json"
  }
}
```

| Field | Type | Required | Default | Description |
|:------|:-----|:---------|:--------|:------------|
| `mode` | string | yes | — | Must be `"oidc_jwt"` |
| `issuer` | string | yes | — | Required `iss` claim value |
| `audience` | string \| string[] | yes | — | Allowed `aud` claim value(s) |
| `jwksUri` | string | yes | — | JWKS endpoint for signature verification |
| `algorithms` | string[] | — | `["RS256"]` | Allowed algorithms (`RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`) |
| `clockSkewSeconds` | integer | — | `30` | `exp`/`nbf` clock-skew tolerance |
| `jwksCacheTtlSeconds` | integer | — | `300` | JWKS cache TTL |
| `jwksFetchTimeoutMs` | integer | — | `5000` | JWKS fetch timeout |
| `allowUnauthenticatedHealth` | boolean | — | `false` | Allow `/health` without auth |

### Security Guardrail

When binding `--listen` to a non-loopback host, callmux fails startup if auth is not configured. This prevents accidentally exposing an unauthenticated listener on a network. Override with `allowInsecureRemoteListener: true` (or `--allow-insecure-remote-listener`) when you know what you're doing.

---

## Authorization (RBAC)

Control which principals can call which tools. Authorization requires authentication to be configured so requests carry identity.

### Policy Model

```json
{
  "authorization": {
    "defaultEffect": "deny",
    "rules": [
      {
        "id": "ops-all",
        "effect": "allow",
        "principals": ["bearer:ops"],
        "tools": ["*"]
      },
      {
        "id": "agents-read",
        "effect": "allow",
        "principals": ["oidc:*", "scope:mcp.read"],
        "tools": ["github__get_*", "github__list_*"]
      }
    ]
  }
}
```

**`defaultEffect`** — `"allow"` (default) or `"deny"` when no rule matches. Set to `"deny"` for least-privilege.

**Rule fields:**

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `id` | string | — | Stable rule identifier (included in denied responses) |
| `effect` | string | yes | `"allow"` or `"deny"` |
| `principals` | string[] | — | Principal patterns to match |
| `tools` | string[] | — | Tool patterns to match |

**Principal patterns:**
- `bearer:ops` — specific bearer token ID
- `oidc:alice` — specific OIDC subject
- `scope:mcp.read` — OIDC scope claim
- `group:admins` — OIDC group claim
- `*` — any authenticated principal

**Tool patterns:**
- `github__get_*` — wildcards supported
- `*` — all tools
- `server__tool` patterns work with namespaced tools

Rules are evaluated in order. First match wins.

---

## Rate Limiting and Abuse Controls

Protect shared infrastructure from runaway agents or misconfigured clients.

```json
{
  "abuseControls": {
    "globalRequestsPerMinute": 1200,
    "principalRequestsPerMinute": 240,
    "principalMaxInFlight": 20,
    "cidrAllowlist": ["127.0.0.1/32", "::1/128"]
  }
}
```

| Field | Type | Description |
|:------|:-----|:------------|
| `globalRequestsPerMinute` | integer | Max total requests per minute across all clients |
| `principalRequestsPerMinute` | integer | Max requests per minute per authenticated principal |
| `principalMaxInFlight` | integer | Max concurrent in-flight requests per principal |
| `cidrAllowlist` | string[] | Allowed source CIDR/IP list |

When limits are hit, listener endpoints return `429` with `Retry-After` header.

---

## Audit Logging

Structured JSON audit events for every request, designed for compliance and incident investigation.

```json
{
  "auditLog": {
    "enabled": true,
    "includeRequestBody": false,
    "maxPayloadChars": 4096,
    "redactKeys": ["password", "secret"]
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `enabled` | boolean | `false` | Enable structured JSON audit events |
| `includeRequestBody` | boolean | `false` | Include redacted payload details |
| `maxPayloadChars` | integer | — | Max serialized payload chars in logs (`0` disables) |
| `redactKeys` | string[] | — | Additional key names to redact (case-insensitive) |

Audit records include correlation `requestId`, principal metadata, status code, and duration. HTTP responses include `x-request-id` for correlation.

---

## Prometheus Metrics

```json
{
  "metrics": {
    "enabled": true,
    "path": "/metrics",
    "allowUnauthenticated": false
  }
}
```

| Field | Type | Default | Description |
|:------|:-----|:--------|:------------|
| `enabled` | boolean | `true` | Enable Prometheus endpoint |
| `path` | string | `"/metrics"` | Metrics path |
| `allowUnauthenticated` | boolean | `false` | Allow unauthenticated access to metrics |

---

## Payload Size Limits

Control inbound request payload sizes to prevent abuse:

- **Global:** `requestBodyMaxBytes` (default: `1048576` / 1 MiB)
- **Per-server:** `servers.<name>.requestBodyMaxBytes` overrides the global limit
- **Disable:** set to `0` for unlimited
- **Per-request override:** enable `allowRequestBodyMaxOverride`, then clients can send `x-callmux-max-body-bytes` header

---

## SIGHUP Runtime Reload

Auth, authorization, and abuse controls can be hot-reloaded without restarting the listener:

```bash
kill -HUP <callmux-pid>
```

See [Shared Server Mode](shared-server.md#sighup-hot-reload) for the full list of reloadable fields.

---

## Release Profiles

For production deployment guidance, see the release profiles documentation:

- **Dev** — minimal config, no auth, localhost only
- **Staging** — auth enabled, rate limits, audit logging
- **Production** — full hardening with RBAC, CIDR allowlist, hashed tokens

Detailed checklists: [`docs/security/2026-04-30-release-profiles.md`](security/2026-04-30-release-profiles.md)

Full threat model: [`docs/security/2026-04-30-enterprise-threat-model.md`](security/2026-04-30-enterprise-threat-model.md)

---

## See Also

- [Shared Server Mode](shared-server.md) — listener setup and client config
- [Config Reference](config-reference.md) — full config schema
