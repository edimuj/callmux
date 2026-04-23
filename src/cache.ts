import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CacheEntry, CachePolicyConfig } from "./types.js";

const READ_ONLY_TOOL_PREFIXES = [
  "check",
  "compare",
  "count",
  "describe",
  "diff",
  "fetch",
  "find",
  "get",
  "info",
  "inspect",
  "list",
  "lookup",
  "query",
  "read",
  "search",
  "show",
  "stat",
  "status",
  "validate",
  "view",
  "whoami",
];

const MUTATING_TOOL_PREFIXES = [
  "add",
  "approve",
  "assign",
  "batch",
  "clear",
  "close",
  "comment",
  "convert",
  "create",
  "delete",
  "deploy",
  "disable",
  "dismiss",
  "enable",
  "install",
  "invalidate",
  "label",
  "lock",
  "mark",
  "merge",
  "move",
  "open",
  "patch",
  "pipeline",
  "post",
  "publish",
  "put",
  "remove",
  "reply",
  "request",
  "reset",
  "resolve",
  "restart",
  "run",
  "save",
  "send",
  "set",
  "start",
  "stop",
  "submit",
  "trigger",
  "unlock",
  "unresolve",
  "uninstall",
  "update",
  "upsert",
  "write",
];

function normalizeToolName(tool: string): string {
  const separator = tool.lastIndexOf("__");
  return separator === -1 ? tool : tool.slice(separator + 2);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }

  return value;
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
}

function matchesPolicy(patterns: string[], candidates: string[]): boolean {
  return patterns.some((pattern) => {
    const matcher = patternToRegExp(pattern);
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

function isToolCacheable(tool: string): boolean {
  const normalized = normalizeToolName(tool).toLowerCase();
  const prefix = normalized.split(/[^a-z0-9]+/, 1)[0];

  if (!prefix) return false;
  if (MUTATING_TOOL_PREFIXES.includes(prefix)) return false;
  return READ_ONLY_TOOL_PREFIXES.includes(prefix);
}

export class CallCache {
  private entries = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxEntries: number;
  private globalPolicy?: CachePolicyConfig;
  private serverPolicies: Map<string, CachePolicyConfig>;

  constructor(
    ttlSeconds: number,
    globalPolicy?: CachePolicyConfig,
    serverPolicies?: Record<string, CachePolicyConfig | undefined>,
    maxEntries = 1000
  ) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.globalPolicy = globalPolicy;
    this.serverPolicies = new Map(
      Object.entries(serverPolicies ?? {}).filter(([, policy]) => policy !== undefined)
    ) as Map<string, CachePolicyConfig>;
  }

  private cacheCandidates(tool: string, server?: string): string[] {
    const candidates = new Set<string>();
    const normalized = normalizeToolName(tool);
    candidates.add(tool);
    candidates.add(normalized);

    if (server) {
      candidates.add(`${server}__${normalized}`);
    }

    return Array.from(candidates);
  }

  private shouldCache(tool: string, server?: string): boolean {
    const candidates = this.cacheCandidates(tool, server);
    const policies = [
      this.globalPolicy,
      server ? this.serverPolicies.get(server) : undefined,
    ].filter((policy): policy is CachePolicyConfig => policy !== undefined);

    const denyPatterns = policies.flatMap((policy) => policy.denyTools ?? []);
    if (denyPatterns.length > 0 && matchesPolicy(denyPatterns, candidates)) {
      return false;
    }

    const allowPatterns = policies.flatMap((policy) => policy.allowTools ?? []);
    if (allowPatterns.length > 0) {
      return matchesPolicy(allowPatterns, candidates);
    }

    return isToolCacheable(tool);
  }

  private key(
    tool: string,
    args?: Record<string, unknown>,
    server?: string
  ): string {
    return JSON.stringify({
      server: server ?? null,
      tool,
      arguments: args === undefined ? null : stableValue(args),
    });
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  get(
    tool: string,
    args?: Record<string, unknown>,
    server?: string
  ): CallToolResult | null {
    if (this.ttlMs <= 0) return null;
    if (!this.shouldCache(tool, server)) return null;

    this.pruneExpired();

    const key = this.key(tool, args, server);
    const entry = this.entries.get(key);
    if (!entry) return null;

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(
    tool: string,
    args: Record<string, unknown> | undefined,
    result: CallToolResult,
    server?: string
  ): void {
    if (this.ttlMs <= 0) return;
    if (!this.shouldCache(tool, server)) return;
    if (result.isError) return;

    this.pruneExpired();

    this.entries.set(this.key(tool, args, server), {
      tool,
      server,
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
    this.evictOldest();
  }

  invalidate(tool?: string, server?: string): void {
    this.pruneExpired();

    if (!tool) {
      if (!server) {
        this.entries.clear();
        return;
      }

      for (const [key, entry] of this.entries) {
        if (entry.server === server) {
          this.entries.delete(key);
        }
      }
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.tool === tool && (server === undefined || entry.server === server)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  get ttlSeconds(): number {
    return this.ttlMs / 1000;
  }

  stats(): { entries: number; ttlSeconds: number; enabled: boolean; maxEntries: number } {
    this.pruneExpired();
    return {
      entries: this.entries.size,
      ttlSeconds: this.ttlMs / 1000,
      enabled: this.ttlMs > 0,
      maxEntries: this.maxEntries,
    };
  }
}
