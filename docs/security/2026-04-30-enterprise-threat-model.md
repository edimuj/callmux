[← Back to Enterprise Deployment](../enterprise.md)

# Threat Model — callmux Shared Listener

*Last updated: 2026-04-30*

callmux can run as a [shared HTTP listener](../shared-server.md) that serves multiple AI agent sessions through a single set of downstream MCP servers. This document models the security boundaries, threats, and controls for that deployment mode.

For general callmux documentation, see the [README](../../README.md). For deployment hardening guidance, see [Enterprise Deployment](../enterprise.md).

---

## Scope

**In scope:**
- Listener endpoints: `/mcp`, `/sse`, `/messages`, `/health`, `/metrics`
- Authentication (bearer tokens, OIDC JWT) and authorization (RBAC)
- Abuse controls (rate limits, in-flight caps, CIDR allowlist)
- Audit logging and metrics
- Downstream MCP proxy calls and meta-tool routing

**Out of scope:**
- Compromised host OS or Node.js runtime
- Vulnerabilities in downstream MCP servers themselves
- External secret manager internals

---

## Assets

| Asset | Sensitivity | Notes |
|:------|:------------|:------|
| Bearer/OIDC credentials | High | Used for authentication; replayable if intercepted |
| Tool-call arguments | Variable | May contain secrets, PII, or sensitive business data |
| Authorization policy | Medium | Controls who can call which tools |
| Audit events | Medium | Contain request metadata and optionally payloads |
| Listener availability | High | Single point of failure for all connected agent sessions |

---

## Threat Actors

| Actor | Capability |
|:------|:-----------|
| Unauthenticated network client | Can reach listener endpoints if exposed beyond loopback |
| Authenticated low-privilege principal | Has valid credentials but limited tool access |
| Malicious/buggy MCP client | Sends malformed, oversized, or high-frequency requests |
| Operator with partial config access | Can modify config files but may introduce unsafe settings |

---

## Key Threats and Controls

### 1. Unauthorized Listener Access

**Threat:** Direct calls to `/mcp`, `/sse`, or `/messages` without credentials.

**Controls:**
- `auth` config — bearer tokens (scrypt-hashed) or OIDC JWT validation
- Remote startup guardrail — callmux refuses to start on non-loopback without auth unless explicitly overridden
- Optional `/health` and `/metrics` auth gates

### 2. Privilege Escalation Through Tool Routing

**Threat:** A caller reaches disallowed tools by routing through meta-tools (`callmux_parallel`, `callmux_batch`, `callmux_call`) rather than calling tools directly.

**Controls:**
- Authorization engine resolves meta-tool calls to concrete downstream targets *before* policy evaluation
- Deny-by-default mode ensures unknown tool/principal combinations are blocked
- Tool patterns in rules support wildcards including `server__tool` forms

### 3. Credential Leakage in Logs

**Threat:** Secret-bearing request payloads appear in stderr or audit records.

**Controls:**
- Key-based redaction with configurable `redactKeys`
- Payload truncation via `maxPayloadChars`
- Request body inclusion is opt-in (`includeRequestBody: false` by default)

### 4. Denial of Service

**Threat:** Request floods, excessive in-flight concurrency, or oversized payloads from one or more clients.

**Controls:**
- Global and per-principal rate limits
- Per-principal in-flight concurrency caps
- CIDR allowlist for network-level restriction
- Payload byte limits with optional per-request override control
- `429` responses include `Retry-After` for cooperative clients

### 5. Configuration Drift

**Threat:** Unsafe settings introduced via live config changes without full restart validation.

**Controls:**
- Config-file hot-reload builds and connects the replacement runtime before the live listener swaps over
- Failed reloads keep the previous runtime active and surface through `callmux_status`
- `callmux doctor` validates configuration integrity

### 6. Secret Exposure in Config Files

**Threat:** Plaintext secrets committed to version control or persisted on disk.

**Controls:**
- Scrypt hashes for bearer tokens (recommended over plaintext)
- Secret adapter references: `env:VARIABLE` and `file:./path` for external secret storage
- `callmux doctor` warns on plaintext `token` values

---

## Residual Risks

- **Token replay:** Bearer tokens are replayable if intercepted. Use TLS termination and short rotation windows.
- **Host compromise:** Local host compromise bypasses all process-level controls. Standard OS hardening applies.
- **Secret ref integrity:** `env:` and `file:` references trust the host environment and filesystem.
- **Single point of failure:** Shared listener serves all sessions. Consider process supervision (systemd, pm2) for availability.

---

## Operational Recommendations

1. Use HTTPS/TLS termination (reverse proxy) in front of remote listeners
2. Prefer OIDC JWT for enterprise identity federation
3. Set `authorization.defaultEffect: "deny"` in shared environments
4. Enable audit logging and metrics in staging and production
5. Rotate bearer secrets periodically
6. Run `callmux doctor` before promoting config changes

---

## See Also

- [Enterprise Deployment](../enterprise.md) — configuration guide for all security features
- [Release Profiles](2026-04-30-release-profiles.md) — dev/staging/prod hardening presets
