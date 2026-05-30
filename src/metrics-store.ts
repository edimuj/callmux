/**
 * Persisted, tiered time-series metrics for the dashboard.
 *
 * Callmux had no durable metrics — the dashboard was a pure in-memory event
 * ring buffer, so anything older than a couple hundred events (and everything
 * across a restart) was gone. This store keeps lightweight rollups at three
 * granularities so the dashboard can chart 1h / today / 7d / 30d ranges, plus
 * all-time aggregates and per-server counters for the savings + server panels.
 *
 * No external deps: tiers are plain Maps keyed by aligned bucket timestamps,
 * pruned to a fixed retention. The store is pure (toJSON/fromJSON) — file I/O
 * and flush scheduling live in the caller (the listener).
 */

const MINUTE_MS = 60_000;
const FIVE_MIN_MS = 5 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Counter fields tracked per time bucket and in the all-time aggregate. */
export interface MetricsCounters {
  /** Inbound tool calls received (one per completed tool_call). */
  calls: number;
  /** callmux_* meta-tool calls. */
  meta: number;
  /** Direct downstream passthrough calls (non-meta). */
  passthrough: number;
  /** Real downstream tool calls performed, including meta fan-out. */
  downstream: number;
  /** Calls served from cache. */
  cacheHits: number;
  /** Calls that ended in error. */
  errors: number;
  /** Inbound request bytes attributed to tool calls. */
  bytesIn: number;
  /** Outbound response bytes attributed to tool calls. */
  bytesOut: number;
  /** Calls whose model-facing output was emitted as TOON. */
  toonCalls: number;
  /** Calls whose model-facing output was emitted as JSON. */
  jsonCalls: number;
  /** Bytes saved by TOON encoding vs JSON (sum of json-minus-toon). */
  toonSaved: number;
}

const COUNTER_KEYS: (keyof MetricsCounters)[] = [
  "calls",
  "meta",
  "passthrough",
  "downstream",
  "cacheHits",
  "errors",
  "bytesIn",
  "bytesOut",
  "toonCalls",
  "jsonCalls",
  "toonSaved",
];

/** A normalized sample recorded for a single completed tool call. */
export interface ToolCallSample {
  /** Epoch ms the call completed (defaults to now). */
  at?: number;
  /** Server the call targeted, when known (passthrough downstream). */
  server?: string;
  /** Per-server downstream fan-out counts (meta calls). */
  downstreamTargets?: { server?: string; count?: number }[];
  /** True for callmux_* meta tools. */
  meta?: boolean;
  /** Total real downstream calls performed by this call. */
  downstreamCalls?: number;
  /** True when served from cache. */
  cacheHit?: boolean;
  /** True when the call ended in error. */
  error?: boolean;
  /** Inbound request bytes. */
  bytesIn?: number;
  /** Outbound response bytes. */
  bytesOut?: number;
  /** Wall-clock duration in ms (for per-server average latency). */
  durationMs?: number;
  /** Model-facing output format actually emitted. */
  format?: "json" | "toon";
  /** Bytes saved by TOON vs JSON for this call. */
  toonSaved?: number;
}

export interface PerServerCounters {
  calls: number;
  errors: number;
  downstream: number;
  bytesOut: number;
  totalDurationMs: number;
  lastCallAt?: number;
}

export type MetricsRange = "1h" | "today" | "yesterday" | "7d" | "30d";

export interface MetricsSeriesPoint extends MetricsCounters {
  /** Bucket start, epoch ms. */
  t: number;
}

export interface MetricsSeries {
  range: MetricsRange;
  bucketMs: number;
  from: number;
  to: number;
  points: MetricsSeriesPoint[];
  totals: MetricsCounters;
}

interface Tier {
  stepMs: number;
  retain: number;
  buckets: Map<number, MetricsCounters>;
}

interface SerializedTier {
  stepMs: number;
  retain: number;
  buckets: [number, Partial<MetricsCounters>][];
}

export interface SerializedMetrics {
  version: 1;
  startedAt: number;
  aggregate: MetricsCounters;
  servers: Record<string, PerServerCounters>;
  tiers: {
    minute: SerializedTier;
    fiveMin: SerializedTier;
    hour: SerializedTier;
  };
}

function zeroCounters(): MetricsCounters {
  return {
    calls: 0,
    meta: 0,
    passthrough: 0,
    downstream: 0,
    cacheHits: 0,
    errors: 0,
    bytesIn: 0,
    bytesOut: 0,
    toonCalls: 0,
    jsonCalls: 0,
    toonSaved: 0,
  };
}

function addInto(target: MetricsCounters, delta: Partial<MetricsCounters>): void {
  for (const key of COUNTER_KEYS) {
    const value = delta[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] += value;
    }
  }
}

function coerceCounters(value: Partial<MetricsCounters> | undefined): MetricsCounters {
  const counters = zeroCounters();
  if (value) addInto(counters, value);
  return counters;
}

export class MetricsStore {
  private readonly tiers: { minute: Tier; fiveMin: Tier; hour: Tier };
  private readonly aggregate: MetricsCounters;
  private readonly servers = new Map<string, PerServerCounters>();
  private startedAt: number;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
    this.aggregate = zeroCounters();
    this.tiers = {
      // 1-min buckets, 2h retained -> serves the "1h" range with headroom.
      minute: { stepMs: MINUTE_MS, retain: 120, buckets: new Map() },
      // 5-min buckets, 48h retained -> serves "today" and "yesterday".
      fiveMin: { stepMs: FIVE_MIN_MS, retain: 576, buckets: new Map() },
      // 1-hr buckets, 31d retained -> serves "7d" and "30d".
      hour: { stepMs: HOUR_MS, retain: 744, buckets: new Map() },
    };
  }

  /** Record a completed tool call into every tier, the aggregate, and per-server. */
  record(sample: ToolCallSample): void {
    const at = sample.at ?? Date.now();
    const delta: Partial<MetricsCounters> = {
      calls: 1,
      meta: sample.meta ? 1 : 0,
      passthrough: sample.meta ? 0 : 1,
      downstream: sample.downstreamCalls ?? 0,
      cacheHits: sample.cacheHit ? 1 : 0,
      errors: sample.error ? 1 : 0,
      bytesIn: sample.bytesIn ?? 0,
      bytesOut: sample.bytesOut ?? 0,
      toonCalls: sample.format === "toon" ? 1 : 0,
      jsonCalls: sample.format === "json" ? 1 : 0,
      toonSaved: sample.toonSaved ?? 0,
    };

    addInto(this.aggregate, delta);
    for (const tier of Object.values(this.tiers)) {
      this.addToTier(tier, at, delta);
    }
    this.recordServers(sample, at);
  }

  private recordServers(sample: ToolCallSample, at: number): void {
    // Attribute the call to the server(s) it hit. downstreamTargets is the
    // authoritative per-server breakdown when present (passthrough calls carry
    // both a `server` and a matching target, so using both would double-count);
    // fall back to the flat `server` only when no targets are reported.
    const targets = new Map<string, number>();
    const reported = (sample.downstreamTargets ?? []).filter((t) => t?.server);
    if (reported.length > 0) {
      for (const target of reported) {
        targets.set(target.server as string, (targets.get(target.server as string) ?? 0) + (target.count ?? 0));
      }
    } else if (sample.server) {
      targets.set(sample.server, (sample.downstreamCalls ?? 1) || 1);
    }
    if (targets.size === 0) return;

    const errored = Boolean(sample.error);
    const duration = sample.durationMs ?? 0;
    // Split outbound bytes evenly across the servers touched (best-effort).
    const bytesShare = (sample.bytesOut ?? 0) / targets.size;
    for (const [server, downstream] of targets) {
      const entry = this.servers.get(server) ?? {
        calls: 0,
        errors: 0,
        downstream: 0,
        bytesOut: 0,
        totalDurationMs: 0,
      };
      entry.calls += 1;
      entry.errors += errored ? 1 : 0;
      entry.downstream += downstream;
      entry.bytesOut += bytesShare;
      entry.totalDurationMs += duration;
      entry.lastCallAt = at;
      this.servers.set(server, entry);
    }
  }

  private addToTier(tier: Tier, at: number, delta: Partial<MetricsCounters>): void {
    const bucketKey = Math.floor(at / tier.stepMs) * tier.stepMs;
    const bucket = tier.buckets.get(bucketKey) ?? zeroCounters();
    addInto(bucket, delta);
    tier.buckets.set(bucketKey, bucket);
    this.pruneTier(tier);
  }

  private pruneTier(tier: Tier): void {
    if (tier.buckets.size <= tier.retain) return;
    const keys = [...tier.buckets.keys()].sort((a, b) => a - b);
    for (let i = 0; i < keys.length - tier.retain; i++) {
      tier.buckets.delete(keys[i]);
    }
  }

  /** All-time aggregate counters. */
  totals(): MetricsCounters {
    return { ...this.aggregate };
  }

  /** Per-server counters, newest-active first. */
  serverStats(): (PerServerCounters & { server: string })[] {
    return [...this.servers.entries()]
      .map(([server, counters]) => ({ server, ...counters }))
      .sort((a, b) => b.calls - a.calls);
  }

  startedAtMs(): number {
    return this.startedAt;
  }

  /** Build a time-series for a named range, padding empty buckets with zeros. */
  series(range: MetricsRange, now: number = Date.now()): MetricsSeries {
    const { tier, from, to } = this.rangeWindow(range, now);
    const points: MetricsSeriesPoint[] = [];
    const totals = zeroCounters();
    for (let t = Math.floor(from / tier.stepMs) * tier.stepMs; t < to; t += tier.stepMs) {
      const bucket = tier.buckets.get(t);
      const counters = bucket ? { ...bucket } : zeroCounters();
      if (bucket) addInto(totals, bucket);
      points.push({ t, ...counters });
    }
    return { range, bucketMs: tier.stepMs, from, to, points, totals };
  }

  private rangeWindow(range: MetricsRange, now: number): { tier: Tier; from: number; to: number } {
    switch (range) {
      case "1h":
        return { tier: this.tiers.minute, from: now - HOUR_MS, to: now };
      case "today": {
        const start = startOfLocalDay(now);
        return { tier: this.tiers.fiveMin, from: start, to: now };
      }
      case "yesterday": {
        const start = startOfLocalDay(now) - DAY_MS;
        return { tier: this.tiers.fiveMin, from: start, to: start + DAY_MS };
      }
      case "7d":
        return { tier: this.tiers.hour, from: now - 7 * DAY_MS, to: now };
      case "30d":
        return { tier: this.tiers.hour, from: now - 30 * DAY_MS, to: now };
    }
  }

  toJSON(): SerializedMetrics {
    const serializeTier = (tier: Tier): SerializedTier => ({
      stepMs: tier.stepMs,
      retain: tier.retain,
      buckets: [...tier.buckets.entries()].sort((a, b) => a[0] - b[0]),
    });
    return {
      version: 1,
      startedAt: this.startedAt,
      aggregate: { ...this.aggregate },
      servers: Object.fromEntries(this.servers),
      tiers: {
        minute: serializeTier(this.tiers.minute),
        fiveMin: serializeTier(this.tiers.fiveMin),
        hour: serializeTier(this.tiers.hour),
      },
    };
  }

  /** Restore from a serialized snapshot. Unknown/old shapes are ignored safely. */
  static fromJSON(data: unknown, now: number = Date.now()): MetricsStore {
    const store = new MetricsStore(now);
    if (!data || typeof data !== "object") return store;
    const parsed = data as Partial<SerializedMetrics>;
    if (parsed.version !== 1) return store;

    if (typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)) {
      store.startedAt = parsed.startedAt;
    }
    if (parsed.aggregate) addInto(store.aggregate, parsed.aggregate);
    if (parsed.servers && typeof parsed.servers === "object") {
      for (const [server, counters] of Object.entries(parsed.servers)) {
        if (!counters || typeof counters !== "object") continue;
        const c = counters as Partial<PerServerCounters>;
        store.servers.set(server, {
          calls: numberOr(c.calls),
          errors: numberOr(c.errors),
          downstream: numberOr(c.downstream),
          bytesOut: numberOr(c.bytesOut),
          totalDurationMs: numberOr(c.totalDurationMs),
          ...(typeof c.lastCallAt === "number" ? { lastCallAt: c.lastCallAt } : {}),
        });
      }
    }
    const tierMap: [keyof SerializedMetrics["tiers"], Tier][] = [
      ["minute", store.tiers.minute],
      ["fiveMin", store.tiers.fiveMin],
      ["hour", store.tiers.hour],
    ];
    for (const [name, tier] of tierMap) {
      const serialized = parsed.tiers?.[name];
      if (!serialized || !Array.isArray(serialized.buckets)) continue;
      for (const entry of serialized.buckets) {
        if (!Array.isArray(entry) || typeof entry[0] !== "number") continue;
        tier.buckets.set(entry[0], coerceCounters(entry[1] as Partial<MetricsCounters>));
      }
      store.pruneTier(tier);
    }
    return store;
  }
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
