import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openEventStore } from "./event-store.js";

const T0 = Date.UTC(2026, 5, 23, 12, 0, 0);

test("event store records call rows and drill-down breakdowns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-event-store-"));
  const store = await openEventStore({
    path: join(dir, "events.sqlite"),
    now: () => T0,
  });
  try {
    store.recordCall({
      timestampMs: T0 - 1_000,
      server: "github",
      tool: "github__issue_read",
      targetTool: "issue_read",
      sessionId: "session-a",
      principal: "bearer:ops",
      durationMs: 25,
      ok: true,
      status: "ok",
      bytesIn: 100,
      bytesOut: 200,
      toolKind: "downstream",
      operation: "direct",
      downstreamCalls: 1,
      targets: [{ server: "github", tool: "issue_read", count: 1 }],
      forwardedHeaders: ["Authorization"],
    });
    store.recordCall({
      timestampMs: T0,
      server: "github",
      tool: "github__issue_write",
      targetTool: "issue_write",
      sessionId: "session-a",
      principal: "bearer:ops",
      durationMs: 75,
      ok: false,
      status: "error",
      errorClass: "tool_call_failed",
      bytesIn: 50,
      bytesOut: 150,
      toolKind: "downstream",
      operation: "direct",
      downstreamCalls: 1,
      targets: [{ server: "github", tool: "issue_write", count: 1 }],
    });

    const drilldown = store.queryDrilldown({ fromMs: T0 - 10_000, toMs: T0 + 10_000 });
    assert.equal(drilldown.totals.calls, 2);
    assert.equal(drilldown.totals.errors, 1);
    assert.equal(drilldown.totals.avgDurationMs, 50);
    assert.equal(drilldown.totals.bytesIn, 150);
    assert.equal(drilldown.totals.bytesOut, 350);
    assert.equal(drilldown.byServer[0].name, "github");
    assert.equal(drilldown.byServer[0].calls, 2);
    assert.equal(drilldown.byTool.some((row) => row.name === "issue_read"), true);
    assert.equal(drilldown.bySession[0].name, "session-a");
    assert.deepEqual(drilldown.forwardedHeaders, [{
      server: "github",
      tool: "issue_read",
      sessionId: "session-a",
      principal: "bearer:ops",
      headerName: "authorization",
      calls: 1,
      lastSeenAt: new Date(T0 - 1_000).toISOString(),
    }]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("event store prunes by max rows and age", async () => {
  const dir = await mkdtemp(join(tmpdir(), "callmux-event-prune-"));
  const store = await openEventStore({
    path: join(dir, "events.sqlite"),
    maxRows: 2,
    retentionDays: 1,
    pruneEvery: 1,
    now: () => T0,
  });
  try {
    store.recordCall({
      timestampMs: T0 - 2 * 24 * 60 * 60_000,
      tool: "old",
      durationMs: 1,
      ok: true,
    });
    store.recordCall({ timestampMs: T0 - 2_000, tool: "one", durationMs: 1, ok: true });
    store.recordCall({ timestampMs: T0 - 1_000, tool: "two", durationMs: 1, ok: true });
    store.recordCall({ timestampMs: T0, tool: "three", durationMs: 1, ok: true });

    const drilldown = store.queryDrilldown({ fromMs: T0 - 3 * 24 * 60 * 60_000, toMs: T0 + 1 });
    assert.equal(drilldown.totals.calls, 2);
    assert.equal(drilldown.byTool.some((row) => row.name === "old"), false);
    assert.equal(drilldown.byTool.some((row) => row.name === "one"), false);
    assert.deepEqual(drilldown.byTool.map((row) => row.name).sort(), ["three", "two"]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
