[< Back to Enterprise Deployment](../enterprise.md)

# Release Profiles

*Last updated: 2026-04-30*

When deploying callmux as a [shared listener](../shared-server.md), the security posture should match the environment. These profiles provide baseline configurations for development, staging, and production, progressively enabling security controls.

For full configuration details, see [Enterprise Deployment](../enterprise.md). For the threat model behind these controls, see [Threat Model](2026-04-30-enterprise-threat-model.md).

---

## Dev Profile

**Use when:** Running locally on loopback for interactive development.

| Control | Setting |
|:--------|:--------|
| Listener bind | `127.0.0.1` (default) |
| Auth | Optional (recommended on shared machines) |
| Authorization | Optional |
| Abuse controls | Optional/minimal |
| Audit | Optional |
| Metrics | Optional |

```json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  },
  "auth": {
    "mode": "bearer",
    "tokens": [{ "id": "dev", "hashRef": "env:CALLMUX_DEV_HASH" }],
    "allowUnauthenticatedHealth": true
  },
  "metrics": {
    "enabled": false
  }
}
```

---

## Staging Profile

**Use when:** Pre-production validation with production-like controls.

| Control | Setting |
|:--------|:--------|
| Listener bind | Non-loopback allowed (with auth) |
| Auth | Required, OIDC JWT preferred |
| Authorization | Enabled, default deny |
| Abuse controls | Enabled |
| Audit | Enabled with request body redaction |
| Metrics | Enabled, authenticated |

```json
{
  "auth": {
    "mode": "oidc_jwt",
    "issuer": "https://id.staging.example.com",
    "audience": "callmux",
    "jwksUri": "https://id.staging.example.com/.well-known/jwks.json"
  },
  "authorization": {
    "defaultEffect": "deny",
    "rules": [
      { "id": "ops", "effect": "allow", "principals": ["oidc_jwt:ops-*"], "tools": ["*"] }
    ]
  },
  "abuseControls": {
    "globalRequestsPerMinute": 1200,
    "principalRequestsPerMinute": 240,
    "principalMaxInFlight": 20
  },
  "auditLog": {
    "enabled": true,
    "includeRequestBody": true,
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

## Production Profile

**Use when:** Enterprise shared deployments serving multiple teams or agent sessions.

| Control | Setting |
|:--------|:--------|
| Listener bind | Explicit host with TLS termination |
| Auth | Required, OIDC JWT strongly preferred |
| Authorization | Required, deny-by-default |
| Abuse controls | Required |
| Audit | Required, redaction tuned for compliance |
| Metrics | Enabled, authenticated |
| Secrets | `hashRef`/`tokenRef` via environment or mounted files only |

**Recommended minimums:**
- `requestBodyMaxBytes` set explicitly
- `allowRequestBodyMaxOverride: false` unless operationally required
- `allowInsecureRemoteListener: false` (the default)

---

## Promotion Checklist

Before promoting a callmux shared listener to the next environment:

- [ ] `callmux doctor` reports no blocking security issues
- [ ] Auth and authorization policies validated with real principals
- [ ] Rate-limit and in-flight caps validated under realistic load
- [ ] Audit logs and metrics integrated with monitoring stack
- [ ] All secret references resolve from deployment environment (no plaintext config values)
- [ ] TLS termination verified for non-loopback listeners

---

## Config Reload Policy

Shared listeners launched from a config file hot-reload that file automatically. Operators can also trigger the same reload path with `SIGHUP`:

```bash
kill -HUP <callmux-pid>
```

callmux builds and connects the new runtime before swapping it into the live listener. Failed reloads keep the previous runtime active and are visible through `callmux_status`.

---

## See Also

- [Enterprise Deployment](../enterprise.md) - full configuration guide
- [Threat Model](2026-04-30-enterprise-threat-model.md) - threat analysis and controls
- [Config Reference](../config-reference.md) - all configuration fields
