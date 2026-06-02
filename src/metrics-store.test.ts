import { test } from "node:test";
import assert from "node:assert/strict";
import { MetricsStore } from "./metrics-store.js";

const T0 = Date.UTC(2026, 4, 30, 12, 0, 0); // fixed reference instant

test("record accumulates aggregate counters", () => {
  const store = new MetricsStore(T0);
  store.record({ at: T0, meta: true, downstreamCalls: 3, bytesIn: 100, bytesOut: 400, format: "toon", toonSaved: 250 });
  store.record({ at: T0, server: "github", bytesIn: 50, bytesOut: 200, format: "json", cacheHit: true });
  store.record({ at: T0, server: "github", error: true });

  const totals = store.totals();
  assert.equal(totals.calls, 3);
  assert.equal(totals.meta, 1);
  assert.equal(totals.passthrough, 2);
  assert.equal(totals.downstream, 3);
  assert.equal(totals.cacheHits, 1);
  assert.equal(totals.errors, 1);
  assert.equal(totals.bytesIn, 150);
  assert.equal(totals.bytesOut, 600);
  assert.equal(totals.toonCalls, 1);
  assert.equal(totals.jsonCalls, 1);
  assert.equal(totals.toonSaved, 250);
});

test("per-server stats attribute calls, errors, and downstream fan-out", () => {
  const store = new MetricsStore(T0);
  store.record({ at: T0, server: "github", durationMs: 10, bytesOut: 100 });
  store.record({ at: T0, server: "github", error: true, durationMs: 30 });
  store.record({
    at: T0,
    meta: true,
    downstreamCalls: 4,
    downstreamTargets: [
      { server: "github", count: 1 },
      { server: "jira", count: 3 },
    ],
  });

  const stats = store.serverStats();
  const github = stats.find((s) => s.server === "github");
  const jira = stats.find((s) => s.server === "jira");
  assert.ok(github && jira);
  // github: 2 passthrough + 1 meta fan-out = 3 calls
  assert.equal(github.calls, 3);
  assert.equal(github.errors, 1);
  // 1 per passthrough (x2) + 1 from the meta target count
  assert.equal(github.downstream, 3);
  assert.equal(jira.calls, 1);
  assert.equal(jira.downstream, 3);
  // sorted by call count desc
  assert.equal(stats[0].server, "github");
});

test("passthrough call with matching server and target is not double counted", () => {
  // Real summaries carry both a flat `server` and a downstreamTargets entry for
  // the same server; attributing both would double the per-server downstream.
  const store = new MetricsStore(T0);
  store.record({
    at: T0,
    server: "github",
    downstreamCalls: 1,
    downstreamTargets: [{ server: "github", count: 1 }],
  });
  const stats = store.serverStats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].server, "github");
  assert.equal(stats[0].calls, 1);
  assert.equal(stats[0].downstream, 1);
  // per-server downstream stays consistent with the global counter
  assert.equal(store.totals().downstream, 1);
});

test("1h series buckets by minute and pads gaps with zeros", () => {
  const store = new MetricsStore(T0);
  store.record({ at: T0 - 30 * 60_000, server: "a" }); // 30 min ago
  store.record({ at: T0 - 30 * 60_000, server: "a" });
  store.record({ at: T0 - 2 * 60_000, server: "b" }); // 2 min ago

  const series = store.series("1h", T0);
  assert.equal(series.bucketMs, 60_000);
  assert.equal(series.points.length, 60);
  assert.equal(series.totals.calls, 3);
  // the bucket 30 minutes ago holds 2 calls
  const busy = series.points.find((p) => p.calls === 2);
  assert.ok(busy, "expected a minute bucket with 2 calls");
});

test("today and yesterday windows use the five-minute tier and split at local midnight", () => {
  // Anchor "now" at local noon so the in-window instants stay in the past
  // regardless of the wall-clock hour the test actually runs at.
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const now = midnight.getTime() + 12 * 60 * 60_000; // noon today
  const store = new MetricsStore(now);
  const todayInstant = midnight.getTime() + 60 * 60_000; // 1am today
  const yesterdayInstant = midnight.getTime() - 60 * 60_000; // 11pm yesterday

  store.record({ at: todayInstant, server: "x" });
  store.record({ at: yesterdayInstant, server: "y" });

  const today = store.series("today", now);
  const yesterday = store.series("yesterday", now);
  assert.equal(today.bucketMs, 5 * 60_000);
  assert.equal(today.totals.calls, 1);
  assert.equal(yesterday.totals.calls, 1);
});

test("tier retention prunes oldest minute buckets", () => {
  const store = new MetricsStore(T0);
  // 200 distinct minute buckets, retain is 120
  for (let i = 0; i < 200; i++) {
    store.record({ at: T0 + i * 60_000, server: "a" });
  }
  const json = store.toJSON();
  assert.equal(json.tiers.minute.buckets.length, 120);
  // aggregate still counts every call
  assert.equal(json.aggregate.calls, 200);
});

test("tier retention keeps the newest buckets and drops the oldest", () => {
  const store = new MetricsStore(T0);
  // 200 distinct minute buckets, retain is 120 → oldest 80 evicted.
  for (let i = 0; i < 200; i++) {
    store.record({ at: T0 + i * 60_000, server: "a" });
  }
  const buckets = store.toJSON().tiers.minute.buckets;
  assert.equal(buckets.length, 120);
  // Buckets are serialized ascending by key; the retained window is the most
  // recent 120 (i = 80..199), not an arbitrary subset.
  assert.equal(buckets[0][0], T0 + 80 * 60_000);
  assert.equal(buckets[buckets.length - 1][0], T0 + 199 * 60_000);
});

test("toJSON / fromJSON round-trips state", () => {
  const store = new MetricsStore(T0);
  store.record({ at: T0, server: "github", meta: false, bytesOut: 123, format: "json" });
  store.record({ at: T0, meta: true, downstreamCalls: 2, format: "toon", toonSaved: 99 });

  const restored = MetricsStore.fromJSON(store.toJSON(), T0);
  assert.deepEqual(restored.totals(), store.totals());
  assert.deepEqual(restored.serverStats(), store.serverStats());
  assert.equal(restored.startedAtMs(), T0);
  const a = restored.series("1h", T0);
  const b = store.series("1h", T0);
  assert.deepEqual(a.totals, b.totals);
});

test("fromJSON ignores malformed or versionless input", () => {
  assert.equal(MetricsStore.fromJSON(undefined, T0).totals().calls, 0);
  assert.equal(MetricsStore.fromJSON({ version: 99 }, T0).totals().calls, 0);
  assert.equal(MetricsStore.fromJSON("nope", T0).totals().calls, 0);
  const partial = MetricsStore.fromJSON({ version: 1, aggregate: { calls: 5 } }, T0);
  assert.equal(partial.totals().calls, 5);
});
