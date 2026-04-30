# Callmux Threat Model (Enterprise Listener)

Date: 2026-04-30  
Scope: `callmux --listen` deployments used as shared MCP infrastructure.

## System Boundary

- In scope:
  - Listener endpoints: `/mcp`, `/sse`, `/messages`, `/health`, `/metrics`
  - Authn/authz, abuse controls, audit logs, request limits
  - Downstream MCP proxy calls and meta-tool routing
- Out of scope:
  - Compromised host OS/runtime
  - Upstream/downstream MCP server vulnerabilities
  - External secret manager internals

## Assets

- Bearer/OIDC credentials and identity context
- Tool-call arguments (may include secrets/PII)
- Authorization policy and security config
- Audit events and metrics
- Availability of shared callmux listener

## Threat Actors

- Unauthenticated network clients
- Authenticated but low-privilege principals
- Malicious/buggy MCP clients
- Operators with partial config access

## Key Threats and Controls

1. Unauthorized listener access
- Threat: direct calls to `/mcp`/`/sse`/`/messages`
- Controls:
  - `auth` (bearer or OIDC JWT)
  - remote startup guardrail (rejects insecure non-loopback by default)
  - optional `/health` and `/metrics` auth gates

2. Privilege escalation through tool routing
- Threat: caller reaches disallowed tools via direct or meta-tool indirection
- Controls:
  - principal-aware authorization engine
  - deny-by-default support
  - meta-routed calls resolved to concrete targets before policy evaluation

3. Credential leakage in logs
- Threat: secret-bearing payloads in stderr/audit records
- Controls:
  - redaction for sensitive keys
  - payload truncation
  - optional request body capture

4. Denial of service
- Threat: request floods, high in-flight concurrency, oversized payloads
- Controls:
  - global/per-principal rate limits
  - per-principal in-flight caps
  - CIDR allowlist
  - payload byte limits + optional per-request override control
  - `429` with retry guidance

5. Configuration drift and unsafe runtime changes
- Threat: accidental insecure settings introduced live
- Controls:
  - non-structural runtime reload via `SIGHUP`
  - reload rejects structural changes (server/tool wiring)
  - explicit restart required for structural updates

6. Secret exposure in config files
- Threat: plaintext secrets committed or persisted locally
- Controls:
  - scrypt hashes for bearer tokens
  - `hashRef`/`tokenRef` secret adapters (`env:` / `file:`)
  - `doctor` warnings for legacy plaintext token usage

## Residual Risks

- Bearer tokens are replayable if intercepted; use TLS and short rotation windows.
- Local host compromise bypasses process-level controls.
- Secret refs trust environment/file integrity on host.
- Shared listener is a central point of failure unless replicated.

## Operational Guidance

- Use HTTPS/TLS termination in front of remote listeners.
- Prefer OIDC JWT for enterprise identity federation.
- Keep `authorization.defaultEffect = "deny"` for shared environments.
- Enable audit logging and metrics in staging/prod.
- Rotate bearer secrets periodically and avoid plaintext `token` fields.
