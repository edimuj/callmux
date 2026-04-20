import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ─── Transport types ──────────────────────────────────────────

export type TransportType = "stdio" | "streamable-http" | "sse";

// ─── Downstream server configuration ───────────────────────────

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
}

export interface HttpServerConfig {
  url: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  /** Whitelist of tool names to expose (omit to expose all) */
  tools?: string[];
  /** Optional per-server cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
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

export interface CallmuxConfig {
  /** Downstream MCP servers to proxy */
  servers: Record<string, ServerConfig>;
  /** Cache TTL in seconds for read operations (0 = disabled) */
  cacheTtlSeconds?: number;
  /** Optional global cache policy; supports exact names or "*" wildcards */
  cachePolicy?: CachePolicyConfig;
  /** Max concurrent calls for parallel() */
  maxConcurrency?: number;
}

export type ConfigFormat = "native" | "mcpCompatible";

// ─── Meta-tool call shapes ─────────────────────────────────────

export interface ParallelCall {
  server?: string;
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface ParallelResult {
  results: Array<{
    call: ParallelCall;
    result?: CallToolResult;
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
    result?: CallToolResult;
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
    result?: CallToolResult;
    error?: string;
    durationMs: number;
  }>;
  finalResult?: CallToolResult;
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
