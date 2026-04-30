# Callmux Release Profiles

Date: 2026-04-30  
Purpose: baseline security posture presets for `dev`, `staging`, and `prod`.

## Dev Profile

Use when running locally on loopback for interactive development.

- Listener bind: `127.0.0.1`
- Auth: optional, but recommended for shared machines
- Authorization: optional
- Abuse controls: optional/minimal
- Audit: optional
- Metrics: optional

Example:

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

## Staging Profile

Use for pre-production validation with production-like controls.

- Listener bind: non-loopback allowed only with auth
- Auth: required (`oidc_jwt` preferred)
- Authorization: enabled, default deny
- Abuse controls: enabled
- Audit: enabled with request body redaction/truncation
- Metrics: enabled, usually authenticated

Example:

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

## Prod Profile

Use for enterprise shared deployments.

- Listener bind: explicit host; TLS termination required
- Auth: required (`oidc_jwt` strongly preferred)
- Authorization: required, deny-by-default
- Abuse controls: required
- Audit: required (redaction tuned for compliance)
- Metrics: enabled and authenticated
- Secret handling: use `hashRef`/`tokenRef` via environment or mounted files

Recommended minimums:

- `requestBodyMaxBytes` set explicitly
- `allowRequestBodyMaxOverride = false` unless operationally required
- `allowInsecureRemoteListener = false`

## Reload Policy

- Runtime security settings can be reloaded with `SIGHUP`.
- Structural changes (servers/tool wiring/cache topology/concurrency model) require restart.

## Promotion Checklist

1. `callmux doctor` reports no blocking security issues.
2. Auth and authorization policies are validated with real principals.
3. Rate-limit/in-flight limits validated under load.
4. Audit logs and metrics integrated with monitoring stack.
5. Secret references resolve from deployment environment without plaintext config values.
