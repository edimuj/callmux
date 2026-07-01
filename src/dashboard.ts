import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_DASHBOARD_PATH = "/dashboard";
const DEFAULT_MAX_EVENTS = 500;

type RuntimeEvent =
  | {
      type: "http_request";
      timestamp: string;
      requestId: string;
      method: string;
      path: string;
      status: number;
      durationMs: number;
      principal?: string;
      // Set when the 404 was a stale/unknown Mcp-Session-Id rejection — expected
      // re-init churn (e.g. a burst after a restart), not a real error.
      sessionReinit?: boolean;
      jsonRpcMethod?: string;
      jsonRpcTool?: string;
      jsonRpcRequestCount?: number;
      passthroughToolCalls?: number;
      callmuxMetaToolCalls?: number;
      callmuxDownstreamToolCalls?: number;
      totalDownstreamToolCalls?: number;
      callmuxToolCalls?: number;
      realToolCalls?: number;
      downstreamTargets?: DashboardDownstreamTarget[];
    }
  | {
      type: "tool_call_lifecycle";
      lifecycle: "client_aborted" | "timeout_overrun";
      timestamp: string;
      requestId: string;
      sessionId?: string;
      tool: string;
      server?: string;
      targetTool?: string;
      toolKind?: "callmux_meta" | "downstream";
      operation?: string;
      downstreamTargets?: DashboardDownstreamTarget[];
      durationMs: number;
      timeoutMs?: number;
      status: "client_aborted" | "error";
      success: boolean;
      error?: string;
    }
  | {
      type: "tool_call";
      timestamp: string;
      tool: string;
      server?: string;
      targetTool?: string;
      toolKind?: "callmux_meta" | "downstream";
      operation?: string;
      passthroughToolCalls?: number;
      callmuxMetaToolCalls?: number;
      callmuxDownstreamToolCalls?: number;
      totalDownstreamToolCalls?: number;
      callmuxToolCalls?: number;
      realToolCalls?: number;
      downstreamTargets?: DashboardDownstreamTarget[];
      durationMs: number;
      status?: DashboardToolStatus;
      success: boolean;
      cacheHit?: boolean;
      outputFormat?: "json" | "toon";
      error?: string;
    }
  | {
      type: "config_reload";
      timestamp: string;
      success: boolean;
      error?: string;
    }
  | {
      type: "tool_suite_changed";
      timestamp: string;
      server: string;
      generation: number;
      addedTools: string[];
      removedTools: string[];
    };

export interface DashboardConfig {
  enabled?: boolean;
  path?: string;
  maxEvents?: number;
}

interface DashboardDownstreamTarget {
  server?: string;
  tool: string;
  count: number;
}

interface DashboardRuntimeSummary {
  eventCount: number;
  totalEvents: number;
  passthroughToolCalls: number;
  callmuxMetaToolCalls: number;
  callmuxDownstreamToolCalls: number;
  totalDownstreamToolCalls: number;
  callmuxToolCalls: number;
  realToolCalls: number;
  maxEvents: number;
  recentErrors: number;
}

type DashboardToolStatus = "ok" | "downstream_error" | "error";

const CALLMUX_ERROR_CODES = new Set([
  "argument_resolution_failed",
  "authorization_denied",
  "bridge_tool_call_failed",
  "invalid_arguments",
  "recipe_not_found",
  "result_not_found",
  "result_path_not_found",
  "server_not_found",
  "tool_call_failed",
  "tool_not_found",
  "tool_resolution_failed",
]);

const CALLMUX_ERROR_CODES_WITH_DOWNSTREAM_TARGET = new Set([
  "argument_resolution_failed",
  "authorization_denied",
  "bridge_tool_call_failed",
  "tool_call_failed",
  "tool_not_found",
  "tool_resolution_failed",
]);

const CALLMUX_FAILURE_CATEGORIES = new Set([
  "protocol",
  "session",
  "timeout",
  "transport",
]);

interface DashboardToolStatusContext {
  callmuxToolCalls?: number;
  realToolCalls?: number;
}

export interface DashboardMetricsSnapshot {
  startedAt: number;
  totals: Record<string, number>;
  servers: {
    server: string;
    calls: number;
    errors: number;
    downstream: number;
    bytesOut: number;
    totalDurationMs: number;
    lastCallAt?: number;
  }[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  dashboard?: {
    enabled: boolean;
    path: string;
  };
  summary: DashboardRuntimeSummary;
  status: unknown;
  management?: {
    enabled: boolean;
    path: string;
  };
  managementServers?: unknown[];
  metrics?: DashboardMetricsSnapshot;
  events: RuntimeEvent[];
}

function normalizePath(path: string | undefined): string {
  if (!path || path.trim().length === 0) return DEFAULT_DASHBOARD_PATH;
  const trimmed = path.trim();
  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (absolute === "/") return absolute;
  return absolute.replace(/\/+$/, "");
}

export function normalizeDashboardConfig(
  config: DashboardConfig | undefined
): Required<DashboardConfig> {
  return {
    enabled: config?.enabled ?? false,
    path: normalizePath(config?.path),
    maxEvents: config?.maxEvents ?? DEFAULT_MAX_EVENTS,
  };
}

export function extractToolError(result: CallToolResult): string | undefined {
  if (!result.isError) return undefined;
  const structured = result.structuredContent as
    | { error?: { message?: unknown; code?: unknown } }
    | undefined;
  if (typeof structured?.error?.message === "string") {
    return structured.error.message;
  }
  const text = result.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || (typeof structured?.error?.code === "string" ? structured.error.code : "tool error");
}

export function classifyDashboardToolStatus(
  result: CallToolResult,
  context: DashboardToolStatusContext = {}
): DashboardToolStatus {
  if (!result.isError) return "ok";

  const structured = result.structuredContent as
    | { error?: { code?: unknown; details?: { category?: unknown } } }
    | undefined;
  const code = structured?.error?.code;
  if (typeof code === "string" && CALLMUX_ERROR_CODES.has(code)) {
    if (
      (context.realToolCalls ?? 0) > 0 &&
      !CALLMUX_ERROR_CODES_WITH_DOWNSTREAM_TARGET.has(code)
    ) {
      return "downstream_error";
    }
    return "error";
  }

  const category = structured?.error?.details?.category;
  if (typeof category === "string" && CALLMUX_FAILURE_CATEGORIES.has(category)) {
    return "error";
  }

  return "downstream_error";
}

function isDashboardRuntimeError(event: RuntimeEvent): boolean {
  if (event.type === "http_request") {
    if (event.sessionReinit) return false;
    return event.status >= 400 && !isRoutineTransportHttpClose(event);
  }
  if (event.type === "tool_call_lifecycle") return event.success === false;
  if (event.type === "tool_call") {
    return event.status === "error" || (event.status === undefined && !event.success);
  }
  if (event.type === "config_reload") return !event.success;
  return false;
}

function isRoutineTransportHttpClose(event: RuntimeEvent): boolean {
  return (
    event.type === "http_request" &&
    event.status === 499 &&
    (event.path === "/sse" || (event.path === "/mcp" && event.method === "GET"))
  );
}

export class RuntimeEventStore {
  private events: RuntimeEvent[] = [];
  private totalEvents = 0;
  private passthroughToolCalls = 0;
  private callmuxMetaToolCalls = 0;
  private callmuxDownstreamToolCalls = 0;
  private totalDownstreamToolCalls = 0;
  private callmuxToolCalls = 0;
  private realToolCalls = 0;
  private recentErrors = 0;
  private subscribers = new Set<(event: RuntimeEvent) => void>();

  constructor(private maxEvents = DEFAULT_MAX_EVENTS) {}

  setMaxEvents(maxEvents = DEFAULT_MAX_EVENTS): void {
    this.maxEvents = maxEvents;
    this.evictOldest();
  }

  append(event: RuntimeEvent): void {
    this.totalEvents += 1;
    if (event.type === "tool_call") {
      this.passthroughToolCalls += event.passthroughToolCalls ?? 0;
      this.callmuxMetaToolCalls += event.callmuxMetaToolCalls ?? event.callmuxToolCalls ?? 0;
      this.callmuxDownstreamToolCalls += event.callmuxDownstreamToolCalls ?? (
        event.toolKind === "callmux_meta" ? event.realToolCalls ?? 0 : 0
      );
      this.totalDownstreamToolCalls += event.totalDownstreamToolCalls ?? event.realToolCalls ?? 0;
      this.callmuxToolCalls += event.callmuxToolCalls ?? 0;
      this.realToolCalls += event.realToolCalls ?? 0;
    }
    if (isDashboardRuntimeError(event)) this.recentErrors += 1;
    this.events.push(event);
    this.evictOldest();
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  list(limit = this.maxEvents): RuntimeEvent[] {
    return this.events.slice(-Math.max(0, limit));
  }

  stats(): DashboardRuntimeSummary {
    return {
      eventCount: this.events.length,
      totalEvents: this.totalEvents,
      passthroughToolCalls: this.passthroughToolCalls,
      callmuxMetaToolCalls: this.callmuxMetaToolCalls,
      callmuxDownstreamToolCalls: this.callmuxDownstreamToolCalls,
      totalDownstreamToolCalls: this.totalDownstreamToolCalls,
      callmuxToolCalls: this.callmuxToolCalls,
      realToolCalls: this.realToolCalls,
      maxEvents: this.maxEvents,
      recentErrors: this.recentErrors,
    };
  }

  subscribe(callback: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private evictOldest(): void {
    const excess = this.events.length - this.maxEvents;
    if (excess <= 0) return;
    // Single bulk removal instead of repeated O(n) shift(); keep the
    // recentErrors counter in sync with what falls out of the ring.
    const removed = this.events.splice(0, excess);
    for (const event of removed) {
      if (isDashboardRuntimeError(event)) this.recentErrors -= 1;
    }
  }
}

// The dashboard ships as a single self-contained HTML doc, built from the
// dashboard/ Vite+React+shadcn SPA via `npm run build:dashboard`, which writes
// the bundle to assets/dashboard.html. The listener reads that prebuilt file
// instead of rendering an HTML string. Resolution is relative to the compiled
// module (dist/dashboard.js -> ../assets/dashboard.html), which holds in both
// the source checkout and the published npm tarball (dist/ and assets/ are
// siblings in both). The result is cached after first read.
let cachedDashboardHtml: string | undefined;

const DASHBOARD_ASSET_URL = new URL("../assets/dashboard.html", import.meta.url);

const DASHBOARD_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>callmux dashboard</title></head>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#101418;color:#e5edf5;margin:0;display:grid;place-items:center;min-height:100vh">
  <main style="max-width:520px;padding:32px;text-align:center">
    <h1 style="margin:0 0 12px">callmux dashboard</h1>
    <p style="color:#a7b0be;line-height:1.5">The dashboard bundle has not been built yet. Run <code style="background:#0b1119;padding:2px 6px;border-radius:4px">npm run build:dashboard</code> from the repository root, then reload. Published installs ship the prebuilt bundle automatically.</p>
  </main>
</body>
</html>`;

/**
 * Read the prebuilt single-file dashboard HTML. Falls back to a minimal notice
 * page when the asset is missing (e.g. a source checkout where the dashboard
 * has not been built). The served document is always self-contained.
 */
export function loadDashboardHtml(): string {
  if (cachedDashboardHtml !== undefined) return cachedDashboardHtml;
  try {
    cachedDashboardHtml = readFileSync(fileURLToPath(DASHBOARD_ASSET_URL), "utf8");
  } catch {
    cachedDashboardHtml = DASHBOARD_FALLBACK_HTML;
  }
  return cachedDashboardHtml;
}
