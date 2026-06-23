import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_EVENT_STORE_MAX_ROWS = 100_000;
export const DEFAULT_EVENT_STORE_RETENTION_DAYS = 14;
export const DEFAULT_EVENT_STORE_PRUNE_EVERY = 100;

interface EventStoreOptions {
  path: string;
  maxRows?: number;
  retentionDays?: number;
  pruneEvery?: number;
  now?: () => number;
}

interface StatementSync {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface DatabaseSyncConstructor {
  new(path: string): DatabaseSync;
}

interface EventTargetSample {
  server?: string;
  tool: string;
  count?: number;
}

export interface EventStoreCallSample {
  timestampMs?: number;
  server?: string;
  tool: string;
  targetTool?: string;
  sessionId?: string;
  principal?: string;
  durationMs: number;
  ok: boolean;
  status?: string;
  errorClass?: string;
  bytesIn?: number;
  bytesOut?: number;
  cacheHit?: boolean;
  toolKind?: "callmux_meta" | "downstream";
  operation?: string;
  downstreamCalls?: number;
  targets?: EventTargetSample[];
  forwardedHeaders?: string[];
}

interface EventStoreBreakdownRow {
  name: string;
  calls: number;
  errors: number;
  avgDurationMs: number;
  bytesIn: number;
  bytesOut: number;
  lastCallAt: string;
}

interface EventStoreForwardedHeaderRow {
  server: string;
  tool: string;
  sessionId: string;
  principal: string;
  headerName: string;
  calls: number;
  lastSeenAt: string;
}

interface EventStoreDrilldown {
  totals: {
    calls: number;
    errors: number;
    avgDurationMs: number;
    bytesIn: number;
    bytesOut: number;
  };
  byServer: EventStoreBreakdownRow[];
  byTool: EventStoreBreakdownRow[];
  bySession: EventStoreBreakdownRow[];
  forwardedHeaders: EventStoreForwardedHeaderRow[];
}

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  ts TEXT NOT NULL,
  server TEXT,
  tool TEXT NOT NULL,
  target_tool TEXT,
  session_id TEXT,
  principal TEXT,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status TEXT,
  error_class TEXT,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  tool_kind TEXT,
  operation TEXT,
  downstream_calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS call_event_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES call_events(id) ON DELETE CASCADE,
  server TEXT,
  tool TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS forwarded_header_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES call_events(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  ts TEXT NOT NULL,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT,
  principal TEXT,
  header_name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_events_ts ON call_events(ts_ms);
CREATE INDEX IF NOT EXISTS idx_call_events_server_ts ON call_events(server, ts_ms);
CREATE INDEX IF NOT EXISTS idx_call_events_tool_ts ON call_events(tool, ts_ms);
CREATE INDEX IF NOT EXISTS idx_call_events_session_ts ON call_events(session_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_call_event_targets_server_tool ON call_event_targets(server, tool);
CREATE INDEX IF NOT EXISTS idx_forwarded_header_usage_ts ON forwarded_header_usage(ts_ms);
CREATE INDEX IF NOT EXISTS idx_forwarded_header_usage_server ON forwarded_header_usage(server, header_name, ts_ms);

CREATE VIEW IF NOT EXISTS audit_forwarded_headers AS
SELECT
  fh.ts,
  fh.ts_ms,
  fh.server,
  fh.tool,
  COALESCE(fh.session_id, '') AS session_id,
  COALESCE(fh.principal, '') AS principal,
  fh.header_name
FROM forwarded_header_usage fh;
`;

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerOr(value: number | undefined, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : fallback;
}

function textOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function rowToBreakdown(row: Record<string, unknown>): EventStoreBreakdownRow {
  return {
    name: textOr(row.name, "(unknown)"),
    calls: numberOr(row.calls),
    errors: numberOr(row.errors),
    avgDurationMs: numberOr(row.avgDurationMs),
    bytesIn: numberOr(row.bytesIn),
    bytesOut: numberOr(row.bytesOut),
    lastCallAt: textOr(row.lastCallAt),
  };
}

export class EventStore {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;
  private readonly retentionMs: number;
  private readonly pruneEvery: number;
  private readonly now: () => number;
  private insertsSincePrune = 0;

  private readonly insertEvent: StatementSync;
  private readonly insertTarget: StatementSync;
  private readonly insertForwardedHeader: StatementSync;
  private readonly pruneAgeStmt: StatementSync;
  private readonly pruneRowsStmt: StatementSync;
  private readonly totalsStmt: StatementSync;
  private readonly serverBreakdownStmt: StatementSync;
  private readonly toolBreakdownStmt: StatementSync;
  private readonly sessionBreakdownStmt: StatementSync;
  private readonly forwardedHeaderStmt: StatementSync;

  constructor(options: EventStoreOptions, Database: DatabaseSyncConstructor) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.maxRows = options.maxRows ?? DEFAULT_EVENT_STORE_MAX_ROWS;
    this.retentionMs = (options.retentionDays ?? DEFAULT_EVENT_STORE_RETENTION_DAYS) * 24 * 60 * 60_000;
    this.pruneEvery = options.pruneEvery ?? DEFAULT_EVENT_STORE_PRUNE_EVERY;
    this.now = options.now ?? Date.now;
    this.db = new Database(options.path);
    this.db.exec(SCHEMA_SQL);
    this.insertEvent = this.db.prepare(`
      INSERT INTO call_events (
        ts_ms, ts, server, tool, target_tool, session_id, principal, duration_ms,
        ok, status, error_class, bytes_in, bytes_out, cache_hit, tool_kind,
        operation, downstream_calls
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertTarget = this.db.prepare(`
      INSERT INTO call_event_targets (event_id, server, tool, count)
      VALUES (?, ?, ?, ?)
    `);
    this.insertForwardedHeader = this.db.prepare(`
      INSERT INTO forwarded_header_usage (
        event_id, ts_ms, ts, server, tool, session_id, principal, header_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.pruneAgeStmt = this.db.prepare("DELETE FROM call_events WHERE ts_ms < ?");
    this.pruneRowsStmt = this.db.prepare(`
      DELETE FROM call_events
      WHERE id IN (
        SELECT id FROM call_events
        ORDER BY ts_ms DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `);
    this.totalsStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(ROUND(AVG(duration_ms)), 0) AS avgDurationMs,
        COALESCE(SUM(bytes_in), 0) AS bytesIn,
        COALESCE(SUM(bytes_out), 0) AS bytesOut
      FROM call_events
      WHERE ts_ms >= ? AND ts_ms <= ?
    `);
    this.serverBreakdownStmt = this.db.prepare(`
      WITH server_events AS (
        SELECT DISTINCT
          t.server AS server,
          e.id AS event_id,
          e.ok AS ok,
          e.duration_ms AS duration_ms,
          e.bytes_in AS bytes_in,
          e.bytes_out AS bytes_out,
          e.ts AS ts
        FROM call_events e
        JOIN call_event_targets t ON t.event_id = e.id
        WHERE e.ts_ms >= ? AND e.ts_ms <= ? AND t.server IS NOT NULL
      )
      SELECT
        COALESCE(NULLIF(server, ''), '(unknown)') AS name,
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(ROUND(AVG(duration_ms)), 0) AS avgDurationMs,
        COALESCE(SUM(bytes_in), 0) AS bytesIn,
        COALESCE(SUM(bytes_out), 0) AS bytesOut,
        MAX(ts) AS lastCallAt
      FROM server_events
      GROUP BY server
      ORDER BY calls DESC, name ASC
      LIMIT ?
    `);
    this.toolBreakdownStmt = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(t.tool, ''), e.tool) AS name,
        COUNT(DISTINCT e.id) AS calls,
        COALESCE(SUM(CASE WHEN e.ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(ROUND(AVG(e.duration_ms)), 0) AS avgDurationMs,
        COALESCE(SUM(e.bytes_in), 0) AS bytesIn,
        COALESCE(SUM(e.bytes_out), 0) AS bytesOut,
        MAX(e.ts) AS lastCallAt
      FROM call_events e
      LEFT JOIN call_event_targets t ON t.event_id = e.id
      WHERE e.ts_ms >= ? AND e.ts_ms <= ?
      GROUP BY name
      ORDER BY calls DESC, name ASC
      LIMIT ?
    `);
    this.sessionBreakdownStmt = this.db.prepare(`
      SELECT
        COALESCE(NULLIF(session_id, ''), '(none)') AS name,
        COUNT(*) AS calls,
        COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(ROUND(AVG(duration_ms)), 0) AS avgDurationMs,
        COALESCE(SUM(bytes_in), 0) AS bytesIn,
        COALESCE(SUM(bytes_out), 0) AS bytesOut,
        MAX(ts) AS lastCallAt
      FROM call_events
      WHERE ts_ms >= ? AND ts_ms <= ?
      GROUP BY COALESCE(NULLIF(session_id, ''), '(none)')
      ORDER BY calls DESC, name ASC
      LIMIT ?
    `);
    this.forwardedHeaderStmt = this.db.prepare(`
      SELECT
        server,
        tool,
        COALESCE(NULLIF(session_id, ''), '(none)') AS sessionId,
        COALESCE(NULLIF(principal, ''), '(anonymous)') AS principal,
        header_name AS headerName,
        COUNT(*) AS calls,
        MAX(ts) AS lastSeenAt
      FROM audit_forwarded_headers
      WHERE ts_ms >= ? AND ts_ms <= ?
      GROUP BY server, tool, sessionId, principal, header_name
      ORDER BY calls DESC, lastSeenAt DESC
      LIMIT ?
    `);
  }

  recordCall(sample: EventStoreCallSample): void {
    const tsMs = sample.timestampMs ?? this.now();
    const ts = new Date(tsMs).toISOString();
    const targets = this.normalizeTargets(sample);
    const forwardedHeaders = [...new Set((sample.forwardedHeaders ?? []).map((h) => h.toLowerCase()))]
      .filter(Boolean)
      .sort();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.insertEvent.run(
        tsMs,
        ts,
        sample.server ?? null,
        sample.tool,
        sample.targetTool ?? null,
        sample.sessionId ?? null,
        sample.principal ?? null,
        integerOr(sample.durationMs),
        sample.ok ? 1 : 0,
        sample.status ?? null,
        sample.errorClass ?? null,
        integerOr(sample.bytesIn),
        integerOr(sample.bytesOut),
        sample.cacheHit ? 1 : 0,
        sample.toolKind ?? null,
        sample.operation ?? null,
        integerOr(sample.downstreamCalls)
      );
      const eventId = Number(result.lastInsertRowid);
      for (const target of targets) {
        this.insertTarget.run(eventId, target.server ?? null, target.tool, integerOr(target.count, 1));
      }
      for (const target of targets) {
        if (!target.server) continue;
        for (const header of forwardedHeaders) {
          this.insertForwardedHeader.run(
            eventId,
            tsMs,
            ts,
            target.server,
            target.tool,
            sample.sessionId ?? null,
            sample.principal ?? null,
            header
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= this.pruneEvery) {
      this.prune();
    }
  }

  queryDrilldown(options: {
    fromMs?: number;
    toMs?: number;
    limit?: number;
  } = {}): EventStoreDrilldown {
    const toMs = options.toMs ?? this.now();
    const fromMs = options.fromMs ?? toMs - 60 * 60_000;
    const limit = Math.max(1, Math.min(500, Math.round(options.limit ?? 25)));
    const totals = this.totalsStmt.get(fromMs, toMs) ?? {};
    return {
      totals: {
        calls: numberOr(totals.calls),
        errors: numberOr(totals.errors),
        avgDurationMs: numberOr(totals.avgDurationMs),
        bytesIn: numberOr(totals.bytesIn),
        bytesOut: numberOr(totals.bytesOut),
      },
      byServer: this.serverBreakdownStmt.all(fromMs, toMs, limit).map(rowToBreakdown),
      byTool: this.toolBreakdownStmt.all(fromMs, toMs, limit).map(rowToBreakdown),
      bySession: this.sessionBreakdownStmt.all(fromMs, toMs, limit).map(rowToBreakdown),
      forwardedHeaders: this.forwardedHeaderStmt.all(fromMs, toMs, limit).map((row) => ({
        server: textOr(row.server),
        tool: textOr(row.tool),
        sessionId: textOr(row.sessionId),
        principal: textOr(row.principal),
        headerName: textOr(row.headerName),
        calls: numberOr(row.calls),
        lastSeenAt: textOr(row.lastSeenAt),
      })),
    };
  }

  prune(now: number = this.now()): void {
    this.insertsSincePrune = 0;
    if (this.retentionMs > 0) {
      this.pruneAgeStmt.run(now - this.retentionMs);
    }
    if (this.maxRows > 0) {
      this.pruneRowsStmt.run(this.maxRows);
    }
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.prune();
    this.checkpoint();
    this.db.close();
  }

  private normalizeTargets(sample: EventStoreCallSample): EventTargetSample[] {
    const targets = new Map<string, EventTargetSample>();
    const addTarget = (target: EventTargetSample) => {
      const tool = target.tool || sample.targetTool || sample.tool;
      const key = `${target.server ?? ""}\0${tool}`;
      const existing = targets.get(key);
      if (existing) {
        existing.count = (existing.count ?? 0) + (target.count ?? 1);
      } else {
        targets.set(key, {
          ...(target.server ? { server: target.server } : {}),
          tool,
          count: target.count ?? 1,
        });
      }
    };

    for (const target of sample.targets ?? []) {
      addTarget(target);
    }
    if (targets.size === 0) {
      addTarget({
        ...(sample.server ? { server: sample.server } : {}),
        tool: sample.targetTool ?? sample.tool,
        count: Math.max(1, sample.downstreamCalls ?? 1),
      });
    }

    return [...targets.values()];
  }
}

export async function openEventStore(options: EventStoreOptions): Promise<EventStore> {
  const sqlite = await import("node:sqlite");
  return new EventStore(options, sqlite.DatabaseSync);
}
