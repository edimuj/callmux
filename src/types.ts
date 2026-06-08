import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OutputFormat } from "./output-format.js";

// ─── Downstream server configuration ───────────────────────────

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Working directory behavior. Listener mode defaults to "session"; stdio mode defaults to "global". */
  cwdMode?: "global" | "session";
  /**
   * When this server uses session cwd but callmux cannot resolve the caller's
   * working directory (no roots, no x-callmux-cwd header, no _meta.callmux.cwd),
   * refuse the call with an actionable error instead of silently running it in
   * callmux's own process cwd (which for a daemon is typically $HOME). Default
   * false: fall back to the global client but warn. Ignored when cwdMode is
   * "global". See issue #33.
   */
  requireSessionCwd?: boolean;
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Tool names that should be eagerly loaded by the MCP client (sets _meta "anthropic/alwaysLoad") */
  alwaysLoad?: string[];
  /**
   * Override the sub-server prefix used when flattening this server's tools in
   * multi-server mode (default: the server key). "" drops the prefix entirely
   * (e.g. tokenlean's tl_diff -> tl_diff). Alphanumeric + underscore only.
   * Ignored in single-server mode, where tools keep their original names.
   */
  prefix?: string;
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls to this server (omit to use global maxConcurrency) */
  maxConcurrency?: number;
  /** Timeout in milliseconds for tool calls to this server (omit to use global callTimeoutMs) */
  callTimeoutMs?: number;
  /** Max inbound request payload bytes for calls targeting this server (0 = unlimited, omit to use global) */
  requestBodyMaxBytes?: number;
  /** Optional per-server response shielding overrides */
  responseShield?: ResponseShieldConfig;
  /** Optional per-server tool schema compression overrides */
  schemaCompression?: SchemaCompressionConfig;
  /** Exclude this server from downstream connection and tool exposure */
  disabled?: boolean;
}

export interface HttpServerConfig {
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Tool names that should be eagerly loaded by the MCP client (sets _meta "anthropic/alwaysLoad") */
  alwaysLoad?: string[];
  /**
   * Override the sub-server prefix used when flattening this server's tools in
   * multi-server mode (default: the server key). "" drops the prefix entirely
   * (e.g. tokenlean's tl_diff -> tl_diff). Alphanumeric + underscore only.
   * Ignored in single-server mode, where tools keep their original names.
   */
  prefix?: string;
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls to this server (omit to use global maxConcurrency) */
  maxConcurrency?: number;
  /** Timeout in milliseconds for tool calls to this server (omit to use global callTimeoutMs) */
  callTimeoutMs?: number;
  /** Max inbound request payload bytes for calls targeting this server (0 = unlimited, omit to use global) */
  requestBodyMaxBytes?: number;
  /** Optional per-server response shielding overrides */
  responseShield?: ResponseShieldConfig;
  /** Optional per-server tool schema compression overrides */
  schemaCompression?: SchemaCompressionConfig;
  /** Exclude this server from downstream connection and tool exposure */
  disabled?: boolean;
}

export type ServerConfig = StdioServerConfig | HttpServerConfig;

export interface ReconnectPolicyConfig {
  /** Initial reconnect backoff in milliseconds */
  initialDelayMs?: number;
  /** Maximum reconnect backoff in milliseconds */
  maxDelayMs?: number;
  /** Random jitter ratio applied to reconnect delay (0 = disabled) */
  jitterRatio?: number;
  /** Maximum failed reconnect attempts before stopping; null/omitted retries forever */
  maxAttempts?: number | null;
  /** Return downstream_unavailable during scheduled backoff instead of blocking on connect */
  fastFailDuringBackoff?: boolean;
}

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

export interface ResponseShieldConfig {
  /** Enable response shielding (default: true) */
  enabled?: boolean;
  /** Store and compact responses larger than this many serialized bytes */
  maxResultBytes?: number;
  /** Truncate individual string fields longer than this many characters */
  maxStringChars?: number;
  /** Truncate arrays longer than this many items */
  maxArrayItems?: number;
  /** Only shield matching tools when provided; supports exact names or "*" wildcards */
  allowTools?: string[];
  /** Never shield matching tools; supports exact names or "*" wildcards */
  denyTools?: string[];
}

export type SchemaCompressionMode = "off" | "balanced" | "aggressive";

export interface SchemaCompressionConfig {
  /** Enable tool schema compression (default: true) */
  enabled?: boolean;
  /** Compression policy for tool and input-schema descriptions (default: balanced) */
  mode?: SchemaCompressionMode;
  /** Max chars for retained descriptions (default: 160) */
  maxDescriptionChars?: number;
}

interface BearerAuthTokenHashConfig {
  /** Stable token identifier for audit/logging */
  id: string;
  /** Scrypt hash of bearer token */
  hash: string;
}

interface BearerAuthTokenHashRefConfig {
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

interface BearerAuthTokenPlaintextRefConfig {
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

export interface DashboardConfig {
  /** Enable read-only dashboard endpoints */
  enabled?: boolean;
  /** Dashboard base path (default: /dashboard) */
  path?: string;
  /** Max runtime events kept in memory (default: 500) */
  maxEvents?: number;
}

export interface ManagementConfig {
  /** Enable the standalone listener management API. Disabled by default. */
  enabled?: boolean;
  /** Management API base path (default: /management/v1) */
  path?: string;
  /** Persistent managed overlay path. Defaults to <config>.management.json in listener mode. */
  statePath?: string;
  /** Bearer auth for management endpoints. Mutations require this when configured. */
  auth?: BearerAuthConfig;
  /** Allow read-only management endpoints without management auth. Mutations still require auth. */
  allowUnauthenticatedRead?: boolean;
  /**
   * When no management-specific auth is configured, allow any globally
   * authenticated MCP principal to read management endpoints. Default false:
   * a tool-calling principal is not implicitly granted management read.
   */
  allowAuthenticatedRead?: boolean;
}

export interface CallmuxConfig {
  /** Downstream MCP servers to proxy */
  servers: Record<string, ServerConfig>;
  /** Named reusable meta-tool calls */
  recipes?: Record<string, RecipeConfig>;
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
  /** Downstream reconnect retry/backoff policy */
  reconnectPolicy?: ReconnectPolicyConfig;
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
  /** Model-facing text output format for callmux-owned structured results */
  outputFormat?: OutputFormat;
  /** Response shielding and stored-result configuration */
  responseShield?: ResponseShieldConfig & {
    /** Maximum stored full results before oldest refs are evicted */
    maxStoredResults?: number;
  };
  /** Tool schema compression for prompt-token reduction */
  schemaCompression?: SchemaCompressionConfig;
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
  /** Optional read-only dashboard configuration */
  dashboard?: DashboardConfig;
  /** Optional standalone listener management API configuration */
  management?: ManagementConfig;
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
  /** Force reconnect immediately even when the server is in a scheduled backoff window */
  forceReconnect?: boolean;
  /** Retry once after reconnect when a safe/read-only call hits retryable transport failure */
  retryOnReconnect?: boolean;
  /** Override the configured downstream tool call timeout for this call */
  timeoutMs?: number;
}

export interface ListenerRuntimeDiagnostics {
  configReload?: {
    lastReloadAt?: string;
    lastReloadError?: string;
  };
  activeSessions: number;
  activeToolCallCount?: number;
  activeToolCalls?: Array<{
    id: string;
    requestId: string;
    sessionId?: string;
    tool: string;
    server?: string;
    targetTool?: string;
    toolKind?: "callmux_meta" | "downstream";
    operation?: string;
    startedAt: string;
    durationMs: number;
    status: "in_flight" | "client_aborted";
    timeoutMs?: number;
    cwd?: string;
    principal?: string;
    clientAbortedAt?: string;
    timeoutOverrunAt?: string;
    downstreamTargets?: Array<{
      server?: string;
      tool: string;
      count: number;
    }>;
  }>;
  sessions: Array<{
    id: string;
    transport: "streamable-http" | "sse" | "unknown";
    cwd?: string;
    cwdSource?: "header" | "meta" | "roots";
    clientKind?: "stdio-bridge";
    rootsAttempted: boolean;
  }>;
  scopedStdioClients: {
    total: number;
    byServer: Record<string, number>;
    items: Array<{
      server: string;
      cwd: string;
      activeCalls: number;
      idle: boolean;
    }>;
  };
  /**
   * Count of tool calls per server that hit a session-cwd server without a
   * resolvable session cwd, so they ran (or were refused) against callmux's own
   * cwd instead of the caller's. A non-zero entry means relative-path tools may
   * be resolving against the wrong directory for some sessions. See issue #33.
   */
  unresolvedSessionCwd?: Record<string, number>;
}

// ─── Meta-tool call shapes ─────────────────────────────────────

export interface ParallelCall {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  /** Absolute cwd override for this downstream call when using session-cwd stdio servers */
  cwd?: string;
}

interface ParallelResult {
  results: Array<{
    call: ParallelCall;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  status: "completed" | "partial";
  totalDurationMs: number;
  succeeded: number;
  failed: number;
  failedIndexes: number[];
}

export interface BatchItem {
  arguments: Record<string, unknown>;
  timeoutMs?: number;
  /** Absolute cwd override for this item when using session-cwd stdio servers */
  cwd?: string;
}

interface BatchResult {
  results: Array<{
    index: number;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  status: "completed" | "partial";
  totalDurationMs: number;
  succeeded: number;
  failed: number;
  failedIndexes: number[];
}

export interface PipelineStep {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  /** Absolute cwd override for this downstream step when using session-cwd stdio servers */
  cwd?: string;
  /** jq-style path to extract from previous result and merge into arguments */
  inputMapping?: Record<string, string>;
  /** Behavior when an inputMapping entry cannot be resolved */
  onMappingMissing?: "continue" | "fail";
}

export type RecipeMode = "call" | "parallel" | "batch" | "pipeline";

export interface RecipeConfig {
  description?: string;
  mode: RecipeMode;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  /** Absolute cwd override for call/batch recipe modes */
  cwd?: string;
  calls?: ParallelCall[];
  items?: BatchItem[];
  steps?: PipelineStep[];
}

interface PipelineResult {
  steps: Array<{
    step: number;
    tool: string;
    /** Arguments populated by inputMapping for this step */
    mappedArguments?: Record<string, unknown>;
    /** inputMapping entries that could not be resolved from the previous step */
    skippedMappings?: Array<{ argument: string; expression: string; reason: string }>;
    /** Unwrapped payload from the upstream tool (JSON-parsed if possible, else raw text) */
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  status: "completed" | "failed";
  /** Zero-based step index that returned an error or threw */
  failedStep?: number;
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
  state: "starting" | "connected" | "degraded" | "failed" | "disconnected" | "reconnecting" | "disabled";
  connectDurationMs: number;
  totalTools: number;
  exposedTools: number;
  toolFilter?: string[];
  maxConcurrency?: number;
  error?: string;
  lastError?: string;
  lastConnectedAt?: string;
  lastFailureAt?: string;
  consecutiveFailures?: number;
  reconnectAttempts?: number;
  nextRetryAt?: string;
  toolSuiteGeneration?: number;
  lastToolSuiteChangeAt?: string;
  addedTools?: string[];
  removedTools?: string[];
}
