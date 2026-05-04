import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ─── Downstream server configuration ───────────────────────────

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Working directory behavior. Listener mode defaults to "session"; stdio mode defaults to "global". */
  cwdMode?: "global" | "session";
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls to this server (omit to use global maxConcurrency) */
  maxConcurrency?: number;
  /** Max inbound request payload bytes for calls targeting this server (0 = unlimited, omit to use global) */
  requestBodyMaxBytes?: number;
}

export interface HttpServerConfig {
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls to this server (omit to use global maxConcurrency) */
  maxConcurrency?: number;
  /** Max inbound request payload bytes for calls targeting this server (0 = unlimited, omit to use global) */
  requestBodyMaxBytes?: number;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export function isHttpServerConfig(config: ServerConfig): config is HttpServerConfig {
  return "url" in config;
}

export function isStdioServerConfig(config: ServerConfig): config is StdioServerConfig {
  return "command" in config;
}

export interface CachePolicyConfig {
  /** Cache only matching tools when provided; supports exact names or "*" wildcards */
  allowTools?: string[];
  /** Never cache matching tools; supports exact names or "*" wildcards */
  denyTools?: string[];
}

export interface BearerAuthTokenHashConfig {
  /** Stable token identifier for audit/logging */
  id: string;
  /** Scrypt hash of bearer token */
  hash: string;
}

export interface BearerAuthTokenHashRefConfig {
  /** Stable token identifier for audit/logging */
  id: string;
  /** Secret reference for scrypt hash (`env:NAME` or `file:/path`) */
  hashRef: string;
}

export interface BearerAuthTokenPlaintextConfig {
  /** Stable token identifier for audit/logging */
  id: string;
  /** Bearer token value (legacy migration mode) */
  token: string;
}

export interface BearerAuthTokenPlaintextRefConfig {
  /** Stable token identifier for audit/logging */
  id: string;
  /** Secret reference for plaintext token (`env:NAME` or `file:/path`) */
  tokenRef: string;
}

export type BearerAuthTokenConfig =
  | BearerAuthTokenHashConfig
  | BearerAuthTokenHashRefConfig
  | BearerAuthTokenPlaintextConfig
  | BearerAuthTokenPlaintextRefConfig;

export interface BearerAuthConfig {
  mode: "bearer";
  /** Tokens accepted by listener auth */
  tokens: BearerAuthTokenConfig[];
  /** Allow unauthenticated access to /health */
  allowUnauthenticatedHealth?: boolean;
}

export interface OidcJwtAuthConfig {
  mode: "oidc_jwt";
  /** Expected issuer claim (`iss`) */
  issuer: string;
  /** Expected audience claim (`aud`) */
  audience: string | string[];
  /** JWKS endpoint URL used for signature verification */
  jwksUri: string;
  /** Allowed JWT signature algorithms (default: ["RS256"]) */
  algorithms?: string[];
  /** Clock skew tolerance in seconds for exp/nbf checks (default: 30) */
  clockSkewSeconds?: number;
  /** JWKS cache TTL in seconds (default: 300) */
  jwksCacheTtlSeconds?: number;
  /** JWKS fetch timeout in milliseconds (default: 5000) */
  jwksFetchTimeoutMs?: number;
  /** Allow unauthenticated access to /health */
  allowUnauthenticatedHealth?: boolean;
}

export type AuthConfig = BearerAuthConfig | OidcJwtAuthConfig;

export interface AuthorizationRuleConfig {
  /** Stable rule identifier for audit/debugging */
  id?: string;
  /** Rule effect */
  effect: "allow" | "deny";
  /** Principal patterns (supports '*' wildcards). Omit for all principals. */
  principals?: string[];
  /** Tool patterns (supports '*' wildcards, including server__tool). Omit for all tools. */
  tools?: string[];
}

export interface AuthorizationConfig {
  /** Default effect when no rule matches */
  defaultEffect?: "allow" | "deny";
  /** Ordered rule list */
  rules: AuthorizationRuleConfig[];
}

export interface AbuseControlsConfig {
  /** Max total requests per minute across all principals */
  globalRequestsPerMinute?: number;
  /** Max requests per minute for each principal */
  principalRequestsPerMinute?: number;
  /** Max concurrent in-flight requests per principal */
  principalMaxInFlight?: number;
  /** Optional source IP allowlist (CIDR or exact IP entries) */
  cidrAllowlist?: string[];
}

export interface AuditLogConfig {
  /** Enable structured audit logging */
  enabled?: boolean;
  /** Include redacted request payload details when available */
  includeRequestBody?: boolean;
  /** Max serialized payload chars to include in audit log (0 = omit payload) */
  maxPayloadChars?: number;
  /** Extra key patterns to redact in payload objects */
  redactKeys?: string[];
}

export interface MetricsConfig {
  /** Enable Prometheus metrics endpoint */
  enabled?: boolean;
  /** Endpoint path (default: /metrics) */
  path?: string;
  /** Allow unauthenticated access to metrics endpoint */
  allowUnauthenticated?: boolean;
}

export interface CallmuxConfig {
  /** Downstream MCP servers to proxy */
  servers: Record<string, ServerConfig>;
  /** Cache TTL in seconds for read operations (0 = disabled) */
  cacheTtlSeconds?: number;
  /** Optional global cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls for parallel() */
  maxConcurrency?: number;
  /** Timeout in milliseconds for downstream startup connect/list-tools work */
  connectTimeoutMs?: number;
  /** Timeout in milliseconds for downstream tool calls */
  callTimeoutMs?: number;
  /** Idle TTL in seconds for listener-mode session cwd stdio clients (0 = close after each call) */
  sessionCwdIdleTtlSeconds?: number;
  /** When true, any downstream startup failure prevents callmux from starting */
  strictStartup?: boolean;
  /** Maximum cached entries before oldest entries are evicted */
  maxCacheEntries?: number;
  /** Hide proxied tools, expose only meta-tools (callmux_call, parallel, batch, etc.) */
  metaOnly?: boolean;
  /** Default max chars for tool descriptions in callmux_status (0 or omit = no limit) */
  descriptionMaxLength?: number;
  /** Global max inbound request payload bytes (0 = unlimited; default: 1048576) */
  requestBodyMaxBytes?: number;
  /** Allow per-request override via x-callmux-max-body-bytes header */
  allowRequestBodyMaxOverride?: boolean;
  /** Listener authentication configuration */
  auth?: AuthConfig;
  /** Listener authorization policy configuration */
  authorization?: AuthorizationConfig;
  /** Listener abuse controls */
  abuseControls?: AbuseControlsConfig;
  /** Listener audit log configuration */
  auditLog?: AuditLogConfig;
  /** Listener metrics endpoint configuration */
  metrics?: MetricsConfig;
  /** Allow insecure remote listener (non-loopback host) without auth */
  allowInsecureRemoteListener?: boolean;
}

export type ConfigFormat = "native" | "mcpCompatible";

export interface InstanceIdentity {
  /** Optional external namespace label (e.g. mcp__callmux__) */
  namespace?: string;
  /** Stable fingerprint for this callmux instance */
  instanceId: string;
}

export interface ToolCallContext {
  /** Project/session working directory resolved from MCP roots or listener metadata */
  cwd?: string;
  /** Client session identifier when available */
  sessionId?: string;
}

// ─── Meta-tool call shapes ─────────────────────────────────────

export interface ParallelCall {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface ParallelResult {
  results: Array<{
    call: ParallelCall;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  totalDurationMs: number;
}

export interface BatchItem {
  arguments: Record<string, unknown>;
}

export interface BatchResult {
  results: Array<{
    index: number;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  totalDurationMs: number;
  succeeded: number;
  failed: number;
}

export interface PipelineStep {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** jq-style path to extract from previous result and merge into arguments */
  inputMapping?: Record<string, string>;
}

export interface PipelineResult {
  steps: Array<{
    step: number;
    tool: string;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  /** Unwrapped result of the last step */
  finalResult?: unknown;
  totalDurationMs: number;
}

// ─── Cache ─────────────────────────────────────────────────────

export interface CacheEntry {
  tool: string;
  server?: string;
  result: CallToolResult;
  expiresAt: number;
}

// ─── Upstream connection (downstream MCP server state) ─────────

export interface UpstreamConnection {
  name: string;
  config: ServerConfig;
  tools: Tool[];
}

export interface UpstreamConnectionFailure {
  name: string;
  config: ServerConfig;
  error: string;
}

export interface ServerInfo {
  transport: "stdio" | "streamable-http" | "sse";
  state: "connected" | "failed" | "disconnected";
  connectDurationMs: number;
  totalTools: number;
  exposedTools: number;
  toolFilter?: string[];
  maxConcurrency?: number;
  error?: string;
}
