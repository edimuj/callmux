import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CacheEntry, CachePolicyConfig } from "./types.js";

const DEFAULT_MAX_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;

export type ToolSafetyAnnotations = Pick<
  NonNullable<Tool["annotations"]>,
  "readOnlyHint" | "idempotentHint"
>;

export interface CacheLoadOptions {
  tool: string;
  args?: Record<string, unknown>;
  server?: string;
  scope?: string;
  annotations?: ToolSafetyAnnotations;
  /** Detaches this wait; shared work is aborted only after its last waiter leaves. */
  signal?: AbortSignal;
}

export interface CacheLoadResult {
  result: CallToolResult;
  source: "cache" | "coalesced" | "load";
}

interface InFlightLoad {
  promise: Promise<CallToolResult>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? undefined
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    // Values that cannot cross the JSON/MCP wire safely should not be retained.
    return undefined;
  }
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("cache wait aborted");
  error.name = "AbortError";
  return error;
}

function waitForSharedResult<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
  onDetach?: () => void
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onDetach?.();
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      signal.removeEventListener("abort", onAbort);
      onDetach?.();
    };
    const onAbort = () => {
      detach();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        detach();
        resolve(value);
      },
      (error) => {
        detach();
        reject(error);
      }
    );
  });
}

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

// Cache policy patterns are config-fixed, but shouldCache() runs on every
// cache get/set. Memoize compilation so the hot path reuses RegExp objects
// instead of recompiling per call. Bounded by the number of distinct patterns.
const patternRegExpCache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
  let compiled = patternRegExpCache.get(pattern);
  if (!compiled) {
    const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    compiled = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
    patternRegExpCache.set(pattern, compiled);
  }
  return compiled;
}

function matchesPolicy(patterns: string[], candidates: string[]): boolean {
  return patterns.some((pattern) => {
    const matcher = patternToRegExp(pattern);
    return candidates.some((candidate) => matcher.test(candidate));
  });
}

export class CallCache {
  private entries = new Map<string, CacheEntry>();
  private inFlight = new Map<string, InFlightLoad>();
  private ttlMs: number;
  private maxEntries: number;
  private maxEntryBytes: number;
  private maxTotalBytes: number;
  private currentBytes = 0;
  private pruneIntervalMs: number;
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private nextPruneAt = 0;
  private globalPolicy?: CachePolicyConfig;
  private serverPolicies: Map<string, CachePolicyConfig>;

  constructor(
    ttlSeconds: number,
    globalPolicy?: CachePolicyConfig,
    serverPolicies?: Record<string, CachePolicyConfig | undefined>,
    maxEntries = 1000,
    maxEntryBytes = DEFAULT_MAX_CACHE_ENTRY_BYTES,
    maxTotalBytes = DEFAULT_MAX_CACHE_BYTES
  ) {
    this.ttlMs = ttlSeconds * 1000;
    this.maxEntries = maxEntries;
    this.maxEntryBytes = maxEntryBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.pruneIntervalMs = this.ttlMs > 0 ? Math.min(this.ttlMs, 1_000) : 0;
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

  private effectiveServer(tool: string, server?: string): string | undefined {
    if (server) return server;
    const separator = tool.lastIndexOf("__");
    if (separator <= 0) return undefined;
    const inferred = tool.slice(0, separator);
    return this.serverPolicies.has(inferred) ? inferred : undefined;
  }

  private policyDecision(
    tool: string,
    server?: string
  ): { explicitlyAllowed: boolean; denied: boolean; hasAllowList: boolean } {
    const effectiveServer = this.effectiveServer(tool, server);
    const candidates = this.cacheCandidates(tool, effectiveServer);
    const policies = [
      this.globalPolicy,
      effectiveServer ? this.serverPolicies.get(effectiveServer) : undefined,
    ].filter((policy): policy is CachePolicyConfig => policy !== undefined);

    const denyPatterns = policies.flatMap((policy) => policy.denyTools ?? []);
    const allowPatterns = policies.flatMap((policy) => policy.allowTools ?? []);
    return {
      denied:
        denyPatterns.length > 0 && matchesPolicy(denyPatterns, candidates),
      explicitlyAllowed:
        allowPatterns.length > 0 && matchesPolicy(allowPatterns, candidates),
      hasAllowList: allowPatterns.length > 0,
    };
  }

  /** Undefined means eligible; otherwise explains the policy blocking caching. */
  getIneligibilityReason(
    tool: string,
    server?: string,
    annotations?: ToolSafetyAnnotations
  ): string | undefined {
    if (this.ttlMs <= 0) return "caching disabled; set cacheTtlSeconds above 0";
    const policy = this.policyDecision(tool, server);
    if (policy.denied) return "tool matches cachePolicy.denyTools; deny rules take precedence";
    if (policy.explicitlyAllowed) return undefined;
    if (policy.hasAllowList) return "tool does not match cachePolicy.allowTools; add it to allowTools if replay-safe";

    // Names such as `get_and_delete` are not a trustworthy side-effect signal.
    if (annotations?.readOnlyHint !== true) {
      return "tool lacks readOnlyHint: true; add it to cachePolicy.allowTools if replay-safe";
    }
    return undefined;
  }

  isSafeToRetry(
    tool: string,
    server?: string,
    annotations?: ToolSafetyAnnotations
  ): boolean {
    const policy = this.policyDecision(tool, server);
    // An explicit cache allow-list is also an operator assertion that identical
    // calls are replay-safe. Cache deny-lists do not imply the opposite: callers
    // may disable caching for freshness while an annotation still permits retry.
    return (
      policy.explicitlyAllowed ||
      annotations?.readOnlyHint === true ||
      annotations?.idempotentHint === true
    );
  }

  canCache(
    tool: string,
    server?: string,
    annotations?: ToolSafetyAnnotations
  ): boolean {
    return this.getIneligibilityReason(tool, server, annotations) === undefined;
  }

  private key(
    tool: string,
    args?: Record<string, unknown>,
    server?: string,
    scope?: string
  ): string {
    return JSON.stringify({
      server: server ?? null,
      scope: scope ?? null,
      tool,
      arguments: args === undefined ? null : stableValue(args),
    });
  }

  private pruneExpired(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.deleteEntry(key);
      }
    }
  }

  private maybePruneExpired(now = Date.now()): void {
    if (this.pruneIntervalMs <= 0 || now < this.nextPruneAt) return;
    this.pruneExpired(now);
    this.nextPruneAt = now + this.pruneIntervalMs;
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.currentBytes = Math.max(0, this.currentBytes - entry.byteSize);
  }

  private evictOldest(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.currentBytes > this.maxTotalBytes
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.deleteEntry(oldest);
    }
  }

  private waitForInFlight(
    entry: InFlightLoad,
    signal?: AbortSignal
  ): Promise<CallToolResult> {
    entry.waiters++;
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (
        entry.waiters === 0 &&
        !entry.settled &&
        !entry.controller.signal.aborted
      ) {
        entry.controller.abort(
          new Error("all callers aborted while waiting for shared cache load")
        );
      }
    };

    if (!signal) {
      return new Promise<CallToolResult>((resolve, reject) => {
        entry.promise.then(
          (result) => {
            detach();
            resolve(result);
          },
          (error) => {
            detach();
            reject(error);
          }
        );
      });
    }
    return waitForSharedResult(entry.promise, signal, detach);
  }

  get(
    tool: string,
    args?: Record<string, unknown>,
    server?: string,
    scope?: string,
    annotations?: ToolSafetyAnnotations
  ): CallToolResult | null {
    const effectiveServer = this.effectiveServer(tool, server);
    if (!this.canCache(tool, effectiveServer, annotations)) return null;
    const now = Date.now();
    this.maybePruneExpired(now);

    const key = this.key(tool, args, effectiveServer, scope);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (now > entry.expiresAt) {
      this.deleteEntry(key);
      this.misses++;
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.result;
  }

  set(
    tool: string,
    args: Record<string, unknown> | undefined,
    result: CallToolResult,
    server?: string,
    scope?: string,
    annotations?: ToolSafetyAnnotations
  ): void {
    const effectiveServer = this.effectiveServer(tool, server);
    if (!this.canCache(tool, effectiveServer, annotations)) return;
    if (result.isError) return;
    const now = Date.now();
    this.maybePruneExpired(now);

    const key = this.key(tool, args, effectiveServer, scope);
    // A replacement must not leave the old byte charge behind. If the new
    // value is too large, remove the old value as well so a completed refresh
    // cannot expose stale data under the same key.
    this.deleteEntry(key);
    const byteSize = serializedByteLength(result);
    if (
      byteSize === undefined ||
      byteSize > this.maxEntryBytes ||
      byteSize > this.maxTotalBytes
    ) {
      return;
    }

    this.entries.set(key, {
      tool,
      server: effectiveServer,
      result,
      expiresAt: now + this.ttlMs,
      byteSize,
    });
    this.currentBytes += byteSize;
    this.evictOldest();
  }

  async getOrLoad(
    options: CacheLoadOptions,
    loader: (operationSignal?: AbortSignal) => Promise<CallToolResult>
  ): Promise<CacheLoadResult> {
    const cached = this.get(
      options.tool,
      options.args,
      options.server,
      options.scope,
      options.annotations
    );
    if (cached) return { result: cached, source: "cache" };
    if (options.signal?.aborted) {
      throw abortReason(options.signal);
    }

    const effectiveServer = this.effectiveServer(options.tool, options.server);
    if (!this.canCache(options.tool, effectiveServer, options.annotations)) {
      return {
        // Preserve ordinary downstream cancellation semantics for calls that
        // are not eligible for sharing. The loader owns its request signal;
        // getOrLoad must not settle ahead of it and bypass lifecycle cleanup.
        result: await loader(options.signal),
        source: "load",
      };
    }

    const key = this.key(
      options.tool,
      options.args,
      effectiveServer,
      options.scope
    );
    let existing = this.inFlight.get(key);
    if (existing?.controller.signal.aborted && existing.waiters === 0) {
      if (this.inFlight.get(key) === existing) this.inFlight.delete(key);
      existing = undefined;
    }
    if (existing) {
      this.coalesced++;
      return {
        result: await this.waitForInFlight(existing, options.signal),
        source: "coalesced",
      };
    }

    const controller = new AbortController();
    const pending = Promise.resolve()
      // A cacheable operation may have multiple request-scoped waiters. Its
      // controller is aborted only after every attached waiter has left.
      .then(() => loader(controller.signal))
      .then((result) => {
        if (!controller.signal.aborted) {
          this.set(
            options.tool,
            options.args,
            result,
            effectiveServer,
            options.scope,
            options.annotations
          );
        }
        return result;
      });
    const entry: InFlightLoad = {
      promise: pending,
      controller,
      waiters: 0,
      settled: false,
    };
    this.inFlight.set(key, entry);
    // Register both settlement handlers so cleanup never creates a secondary
    // unhandled rejection and only deletes the generation it installed.
    pending.then(
      () => {
        entry.settled = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      },
      () => {
        entry.settled = true;
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      }
    );

    return {
      result: await this.waitForInFlight(entry, options.signal),
      source: "load",
    };
  }

  invalidate(tool?: string, server?: string): void {
    this.pruneExpired();

    if (!tool) {
      if (!server) {
        this.entries.clear();
        this.currentBytes = 0;
        return;
      }

      for (const [key, entry] of this.entries) {
        if (entry.server === server) {
          this.deleteEntry(key);
        }
      }
      return;
    }

    for (const [key, entry] of this.entries) {
      if (entry.tool === tool && (server === undefined || entry.server === server)) {
        this.deleteEntry(key);
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

  stats(): {
    entries: number;
    ttlSeconds: number;
    enabled: boolean;
    maxEntries: number;
    maxEntryBytes: number;
    maxTotalBytes: number;
    storedBytes: number;
    inFlight: number;
    coalesced: number;
    hits: number;
    misses: number;
    hitRate: number;
  } {
    this.pruneExpired();
    const lookups = this.hits + this.misses;
    return {
      entries: this.entries.size,
      ttlSeconds: this.ttlMs / 1000,
      enabled: this.ttlMs > 0,
      maxEntries: this.maxEntries,
      maxEntryBytes: this.maxEntryBytes,
      maxTotalBytes: this.maxTotalBytes,
      storedBytes: this.currentBytes,
      inFlight: this.inFlight.size,
      coalesced: this.coalesced,
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups > 0 ? this.hits / lookups : 0,
    };
  }
}
