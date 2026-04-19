import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ─── Downstream server configuration ───────────────────────────

export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CallmuxConfig {
  /** Downstream MCP servers to proxy */
  servers: Record<string, ServerConfig>;
  /** Cache TTL in seconds for read operations (0 = disabled) */
  cacheTtlSeconds?: number;
  /** Max concurrent calls for parallel() */
  maxConcurrency?: number;
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
  result: CallToolResult;
  expiresAt: number;
}

// ─── Upstream connection (downstream MCP server state) ─────────

export interface UpstreamConnection {
  name: string;
  config: ServerConfig;
  tools: Tool[];
}
