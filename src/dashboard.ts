import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_DASHBOARD_PATH = "/dashboard";
const DEFAULT_MAX_EVENTS = 500;
const DASHBOARD_FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#05070a"/>
  <path d="M43 18a18 18 0 1 0 0 28" fill="none" stroke="#38bdf8" stroke-width="7" stroke-linecap="round"/>
  <path d="M43 18H32m11 0v11" fill="none" stroke="#38bdf8" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`
)}`;

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
      recentErrors: this.events.filter(isDashboardRuntimeError).length,
    };
  }

  subscribe(callback: (event: RuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private evictOldest(): void {
    while (this.events.length > this.maxEvents) {
      this.events.shift();
    }
  }
}

export function renderDashboardHtml(config: Required<DashboardConfig>): string {
  const configuredPath = config.path;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href=${JSON.stringify(DASHBOARD_FAVICON_HREF)}>
  <title>callmux dashboard</title>
  <script>
    (function () {
      try {
        var stored = localStorage.getItem("callmux-dashboard-theme");
        var theme = stored || (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.setAttribute("data-theme", theme);
      } catch (e) {
        document.documentElement.setAttribute("data-theme", "light");
      }
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      /* Light (default) */
      --bg: #f7f8fa; --fg: #17202a; --muted: #667085;
      --panel-bg: #ffffff; --border: #d9dee7; --header-bg: #ffffff;
      --sidebar-bg: #102033; --sidebar-fg: #ffffff; --sidebar-faint: #c9d5e3; --sidebar-hover: rgba(255,255,255,0.08);
      --accent: #38bdf8; --accent-fg: #06101d;
      --row-hover: #f0f4f8; --row-selected: #e8f2ff; --surface: #f8fbff; --track: #e8edf5;
      --ok: #167447; --warn: #b54708; --bad: #b42318;
      --chip-bg: #eef5ff; --chip-border: #c8def9; --chip-fg: #194b7d;
      --input-bg: #ffffff; --input-border: #d9dee7;
      --btn-bg: #102033; --btn-fg: #ffffff;
      --code-bg: #0f1720; --code-fg: #dbeafe;
      --grid: #e4e7ec; --chart-label: #667085;
      --series-meta: #38bdf8; --series-pass: #34d399; --series-down: #a78bfa;
    }
    [data-theme="sand"] {
      color-scheme: light;
      --bg: #f4efe4; --fg: #393225; --muted: #857a64;
      --panel-bg: #fffdf6; --border: #e6ddc8; --header-bg: #fffdf6;
      --sidebar-bg: #2c2518; --sidebar-fg: #f7f1e3; --sidebar-faint: #cabfa3; --sidebar-hover: rgba(255,255,255,0.08);
      --accent: #e08a3c; --accent-fg: #2a1804;
      --row-hover: #f0e9d7; --row-selected: #f7ead0; --surface: #faf5e9; --track: #e9e0ca;
      --ok: #4d7a2c; --warn: #a96a16; --bad: #b23a28;
      --chip-bg: #f4ebd7; --chip-border: #ddca9f; --chip-fg: #6a531f;
      --input-bg: #fffdf6; --input-border: #e6ddc8;
      --btn-bg: #2c2518; --btn-fg: #f7f1e3;
      --code-bg: #2c2518; --code-fg: #f1e7cf;
      --grid: #e6ddc8; --chart-label: #857a64;
      --series-meta: #e08a3c; --series-pass: #6a9a3c; --series-down: #b06ba6;
    }
    [data-theme="dark"] {
      color-scheme: dark;
      --bg: #101418; --fg: #e5edf5; --muted: #a7b0be;
      --panel-bg: #161c23; --border: #303946; --header-bg: #161c23;
      --sidebar-bg: #07111d; --sidebar-fg: #ffffff; --sidebar-faint: #a7b7ca; --sidebar-hover: rgba(255,255,255,0.08);
      --accent: #38bdf8; --accent-fg: #06101d;
      --row-hover: #1e2936; --row-selected: #17304a; --surface: #101820; --track: #263241;
      --ok: #5fd99a; --warn: #f0b46a; --bad: #ff9b8f;
      --chip-bg: #13283f; --chip-border: #26547d; --chip-fg: #b9dcff;
      --input-bg: #101820; --input-border: #303946;
      --btn-bg: #1e2a3a; --btn-fg: #e5edf5;
      --code-bg: #0b1119; --code-fg: #dbeafe;
      --grid: #303946; --chart-label: #a7b0be;
      --series-meta: #38bdf8; --series-pass: #34d399; --series-down: #a78bfa;
    }
    [data-theme="midnight"] {
      color-scheme: dark;
      --bg: #0c0e1a; --fg: #e6e8f5; --muted: #9aa0c8;
      --panel-bg: #14172b; --border: #272c4a; --header-bg: #14172b;
      --sidebar-bg: #090a17; --sidebar-fg: #ffffff; --sidebar-faint: #a6abcf; --sidebar-hover: rgba(255,255,255,0.08);
      --accent: #8b7cf6; --accent-fg: #0c0a1a;
      --row-hover: #1c2040; --row-selected: #232a54; --surface: #101428; --track: #272c4a;
      --ok: #5fd99a; --warn: #f0b46a; --bad: #ff8fb0;
      --chip-bg: #1e1f44; --chip-border: #3a3f72; --chip-fg: #c9c2ff;
      --input-bg: #101228; --input-border: #272c4a;
      --btn-bg: #2a2c55; --btn-fg: #e6e8f5;
      --code-bg: #090a17; --code-fg: #d8dcff;
      --grid: #272c4a; --chart-label: #9aa0c8;
      --series-meta: #8b7cf6; --series-pass: #34d399; --series-down: #f472b6;
    }
    * { transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease; }
    body { margin: 0; background: var(--bg); color: var(--fg); }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    .app-shell { display: flex; min-height: 100vh; }
    .sidebar { background: var(--sidebar-bg); color: var(--sidebar-fg); display: flex; flex-direction: column; min-height: 100vh; position: sticky; top: 0; width: 230px; }
    .brand { border-bottom: 1px solid rgba(255,255,255,0.12); padding: 18px 18px 16px; }
    .brand-mark { align-items: center; display: flex; gap: 10px; }
    .brand-icon { align-items: center; background: #05070a; border: 1px solid rgba(56,189,248,0.35); border-radius: 8px; color: var(--accent); display: inline-flex; font-weight: 800; height: 32px; justify-content: center; width: 32px; }
    .brand-title { font-size: 16px; font-weight: 700; }
    .nav { display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; }
    .nav-button { align-items: center; background: transparent; border: 0; border-radius: 6px; color: var(--sidebar-faint); cursor: pointer; display: flex; font: inherit; gap: 10px; padding: 9px 10px; text-align: left; }
    .nav-button:hover { background: var(--sidebar-hover); color: white; }
    .nav-button.active { background: var(--accent); color: var(--accent-fg); font-weight: 700; }
    .nav-icon { font-size: 16px; line-height: 1; width: 18px; }
    .sidebar-footer { border-top: 1px solid rgba(255,255,255,0.12); color: var(--sidebar-faint); font-size: 12px; margin-top: auto; padding: 14px 18px; }
    .health-strip { display: grid; gap: 7px; margin-top: 12px; }
    .health-row { align-items: center; display: flex; justify-content: space-between; gap: 10px; }
    .health-pill { border-radius: 999px; font-size: 11px; font-weight: 700; padding: 2px 7px; text-transform: uppercase; }
    .health-pill.ok { background: rgba(22,116,71,0.18); color: #8ff0b9; }
    .health-pill.warn { background: rgba(181,71,8,0.20); color: #ffd19a; }
    .health-pill.bad { background: rgba(180,35,24,0.20); color: #ffb4ab; }
    .mobile-nav { background: var(--sidebar-bg); border-bottom: 1px solid rgba(255,255,255,0.12); display: none; gap: 6px; overflow-x: auto; padding: 8px; position: sticky; top: 0; z-index: 5; }
    .content { flex: 1; min-width: 0; }
    header { background: var(--header-bg); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .header-controls { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; }
    .theme-pick { align-items: center; color: var(--muted); display: inline-flex; font-size: 12px; font-weight: 600; gap: 6px; }
    .theme-pick select { background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 6px; color: var(--fg); font: inherit; font-size: 12px; padding: 5px 7px; }
    main { padding: 20px 24px 32px; max-width: 1240px; margin: 0 auto; }
    .view { display: none; }
    .view.active { display: block; }
    .view-header { align-items: baseline; display: none; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .panel { background: var(--panel-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
    .metric { font-size: 28px; font-weight: 700; margin-top: 6px; }
    .diagram { display: grid; gap: 12px; }
    .flow { align-items: stretch; display: grid; gap: 10px; grid-template-columns: 1fr 34px 1fr 34px 1fr; }
    .flow-node { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 5px; min-height: 92px; padding: 12px; }
    .flow-node strong { font-size: 14px; }
    .flow-arrow { align-items: center; color: var(--muted); display: flex; font-size: 24px; font-weight: 700; justify-content: center; }
    .mini-table { display: grid; gap: 5px; margin-top: 4px; }
    .mini-row { display: grid; gap: 12px; grid-template-columns: minmax(0, 1fr) auto; }
    .mini-row span:first-child { color: var(--muted); }
    .mini-row strong { font-size: 13px; text-align: right; }
    .bar-list { display: grid; gap: 9px; }
    .bar-row { display: grid; gap: 6px; }
    .bar-meta { align-items: center; display: flex; font-size: 12px; justify-content: space-between; }
    .bar-track { background: var(--track); border-radius: 999px; height: 9px; overflow: hidden; }
    .bar-fill { background: var(--accent); border-radius: inherit; height: 100%; min-width: 2px; }
    .bar-fill.ok { background: var(--ok); }
    .bar-fill.bad { background: var(--bad); }
    .diagram-grid { display: grid; gap: 18px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
    td { overflow-wrap: anywhere; }
    th { color: var(--muted); font-weight: 600; }
    .events-table { table-layout: fixed; }
    .events-table th:nth-child(1) { width: 82px; }
    .events-table th:nth-child(2) { width: 110px; }
    .events-table th:nth-child(3) { width: 28%; }
    .events-table th:nth-child(4) { width: 82px; }
    .events-table th:nth-child(5) { width: 104px; }
    tr.event-row { cursor: pointer; }
    tr.event-row:hover { background: var(--row-hover); }
    tr.selected { background: var(--row-selected); }
    tr.event-detail-row td { background: var(--surface); padding: 12px; }
    .ok { color: var(--ok); font-weight: 600; }
    .warn { color: var(--warn); font-weight: 600; }
    .bad { color: var(--bad); font-weight: 600; }
    .muted { color: var(--muted); }
    .toolbar { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; margin-bottom: 10px; }
    .toolbar h2 { margin: 0; }
    .toggle { align-items: center; color: var(--muted); display: inline-flex; font-size: 13px; gap: 7px; user-select: none; }
    .toggle input { margin: 0; }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 8px; }
    .detail-item { border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
    .detail-label { color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .detail-value { font-size: 13px; overflow-wrap: anywhere; }
    .pill-format { background: var(--chip-bg); border: 1px solid var(--chip-border); border-radius: 999px; color: var(--chip-fg); font-size: 11px; font-weight: 700; letter-spacing: 0.03em; padding: 1px 7px; text-transform: uppercase; }
    .split { display: grid; gap: 18px; grid-template-columns: minmax(0, 1fr) 340px; }
    .server-row { cursor: pointer; }
    .server-row:hover { background: var(--row-hover); }
    .server-row.selected { background: var(--row-selected); }
    .filters { align-items: end; display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(130px, 1fr)); margin-bottom: 12px; }
    .search-field { grid-column: 1 / -1; }
    .filter-field { display: grid; gap: 4px; }
    .filter-field label { color: var(--muted); font-size: 12px; font-weight: 600; }
    .filter-field input, .filter-field select { background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 6px; color: inherit; font: inherit; padding: 7px 8px; }
    .button { background: var(--btn-bg); border: 1px solid var(--btn-bg); border-radius: 6px; color: var(--btn-fg); cursor: pointer; font: inherit; font-size: 12px; font-weight: 650; padding: 6px 9px; }
    .button.secondary { background: transparent; color: var(--fg); border-color: var(--border); }
    .button.danger { background: #b42318; border-color: #b42318; color: #ffffff; }
    .button:disabled { cursor: not-allowed; opacity: 0.45; }
    .inline-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .management-grid { display: grid; gap: 14px; }
    .management-form { align-items: end; display: grid; gap: 10px; grid-template-columns: minmax(180px, 1fr) auto; }
    .notice { border: 1px solid var(--border); border-radius: 6px; margin-top: 10px; padding: 8px 10px; }
    .notice.ok { background: color-mix(in srgb, var(--ok) 10%, transparent); border-color: color-mix(in srgb, var(--ok) 30%, transparent); color: var(--ok); }
    .notice.bad { background: color-mix(in srgb, var(--bad) 10%, transparent); border-color: color-mix(in srgb, var(--bad) 30%, transparent); color: var(--bad); }
    .tools-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .tool-chip { background: var(--chip-bg); border: 1px solid var(--chip-border); border-radius: 999px; color: var(--chip-fg); font-size: 12px; padding: 3px 8px; }
    .suite-card { display: grid; gap: 10px; }
    .suite-card + .suite-card { margin-top: 12px; }
    .runtime-json { background: var(--code-bg); border-radius: 8px; color: var(--code-fg); font-size: 12px; margin: 0; max-height: 68vh; overflow: auto; padding: 12px; white-space: pre-wrap; }
    .traffic-chart { display: grid; gap: 6px; }
    .traffic-chart svg { display: block; height: 200px; width: 100%; }
    .chart-grid { stroke: var(--grid); stroke-dasharray: 3 3; stroke-width: 0.5; }
    .chart-label { fill: var(--chart-label); font-family: ui-sans-serif, system-ui, sans-serif; font-size: 9px; }
    .chart-line-meta { fill: none; stroke: var(--series-meta); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .chart-line-passthrough { fill: none; stroke: var(--series-pass); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .chart-line-downstream { fill: none; stroke: var(--series-down); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .chart-area-meta { fill: color-mix(in srgb, var(--series-meta) 12%, transparent); }
    .chart-area-passthrough { fill: color-mix(in srgb, var(--series-pass) 12%, transparent); }
    .chart-area-downstream { fill: color-mix(in srgb, var(--series-down) 10%, transparent); }
    .chart-legend { display: flex; gap: 16px; justify-content: center; }
    .chart-legend-item { align-items: center; color: var(--muted); display: flex; font-size: 12px; gap: 5px; }
    .chart-legend-dot { border-radius: 50%; display: inline-block; height: 8px; width: 8px; }
    .active-calls { display: grid; gap: 8px; }
    .active-call { align-items: start; border: 1px solid var(--border); border-radius: 6px; display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) auto; padding: 9px; }
    .active-call-meta { color: var(--muted); font-size: 12px; margin-top: 3px; overflow-wrap: anywhere; }
    @media (max-width: 960px) {
      .split { grid-template-columns: 1fr; }
      .diagram-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) {
      .app-shell { display: block; }
      .sidebar { display: none; }
      .mobile-nav { display: flex; }
      .nav-button { flex: 0 0 auto; padding: 8px 10px; }
      header { align-items: stretch; flex-direction: column; padding: 14px 16px; }
      .header-controls { justify-content: flex-start; }
      main { padding: 14px 12px 24px; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .panel { padding: 12px; }
      .metric { font-size: 22px; }
      .events-table, .events-table thead, .events-table tbody, .events-table tr, .events-table td,
      .data-table, .data-table thead, .data-table tbody, .data-table tr, .data-table td { display: block; width: 100%; }
      .events-table thead, .data-table thead { display: none; }
      .events-table tr.event-row, .data-table tbody tr { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 10px; padding: 8px 10px; }
      .events-table td, .data-table td { border-bottom: 0; box-sizing: border-box; display: grid; gap: 6px; grid-template-columns: 92px minmax(0, 1fr); padding: 4px 0; }
      .events-table td::before, .data-table td[data-label]::before { content: attr(data-label); color: var(--muted); font-size: 12px; font-weight: 600; }
      .events-table td[data-label="Detail"] { display: block; padding-top: 7px; }
      .events-table td[data-label="Detail"]::before { display: block; margin-bottom: 3px; }
      .data-table td[data-label="Actions"] { display: block; padding-top: 7px; }
      .data-table td[data-label="Actions"]::before { display: block; margin-bottom: 4px; }
      .event-detail-row td { display: block; }
      .event-detail-row td::before { content: ""; display: none; }
      .detail-grid { grid-template-columns: 1fr; }
      .split { grid-template-columns: 1fr; }
      .filters { grid-template-columns: 1fr; }
      .management-form { grid-template-columns: 1fr; }
      .search-field { grid-column: auto; }
      .flow { grid-template-columns: 1fr; }
      .flow-arrow { min-height: 10px; transform: rotate(90deg); }
      .diagram-grid { grid-template-columns: 1fr; }
      .view-header { display: flex; }
    }
    @media (max-width: 480px) {
      .grid { grid-template-columns: 1fr; }
      .metric { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><span class="brand-icon">C</span><span class="brand-title">callmux</span></div>
      </div>
      <nav class="nav" aria-label="Dashboard sections">
        <button class="nav-button active" data-view-button="overview"><span class="nav-icon">O</span>Overview</button>
        <button class="nav-button" data-view-button="servers"><span class="nav-icon">S</span>Servers</button>
        <button class="nav-button" data-view-button="management"><span class="nav-icon">M</span>Management</button>
        <button class="nav-button" data-view-button="tools"><span class="nav-icon">T</span>Tool Suites</button>
        <button class="nav-button" data-view-button="diagrams"><span class="nav-icon">D</span>Diagrams</button>
        <button class="nav-button" data-view-button="events"><span class="nav-icon">E</span>Events</button>
        <button class="nav-button" data-view-button="runtime"><span class="nav-icon">{} </span>Runtime</button>
      </nav>
      <div class="sidebar-footer">
        <div id="sidebar-status">Connecting...</div>
        <div id="health-strip" class="health-strip"></div>
      </div>
    </aside>
    <div class="content">
      <div class="mobile-nav" aria-label="Dashboard sections">
        <button class="nav-button active" data-view-button="overview">Overview</button>
        <button class="nav-button" data-view-button="servers">Servers</button>
        <button class="nav-button" data-view-button="management">Management</button>
        <button class="nav-button" data-view-button="tools">Tools</button>
        <button class="nav-button" data-view-button="diagrams">Diagrams</button>
        <button class="nav-button" data-view-button="events">Events</button>
        <button class="nav-button" data-view-button="runtime">Runtime</button>
      </div>
      <header>
        <h1 id="view-title">Overview</h1>
        <div class="header-controls">
          <label class="theme-pick">Theme
            <select id="theme-select">
              <option value="light">Light</option>
              <option value="sand">Sand</option>
              <option value="dark">Dark</option>
              <option value="midnight">Midnight</option>
            </select>
          </label>
        </div>
      </header>
      <main>
        <section id="view-overview" class="view active">
          <div class="view-header"><h2>Overview</h2></div>
          <section class="grid" id="summary"></section>
          <section class="panel" style="margin-bottom:18px">
            <h2>In-Flight Tool Calls</h2>
            <div id="active-calls" class="active-calls"></div>
          </section>
          <section class="panel">
            <h2>Runtime Flow</h2>
            <div id="overview-flow" class="diagram"></div>
          </section>
        </section>
        <section id="view-servers" class="view">
          <div class="view-header"><h2>Servers</h2></div>
          <div class="split">
            <section class="panel">
              <table class="data-table"><thead><tr><th>Server</th><th>State</th><th>Transport</th><th>Tools</th><th>Latency</th></tr></thead><tbody id="servers"></tbody></table>
            </section>
            <section class="panel">
              <div id="server-detail" class="muted">Select a server for details.</div>
            </section>
          </div>
        </section>
        <section id="view-tools" class="view">
          <div class="view-header"><h2>Tool Suites</h2></div>
          <section id="tool-suites"></section>
        </section>
        <section id="view-management" class="view">
          <div class="view-header"><h2>Management</h2></div>
          <section class="management-grid">
            <section class="panel">
              <div class="management-form">
                <div class="filter-field"><label for="management-token">Management token</label><input id="management-token" type="password" autocomplete="off" placeholder="Bearer token for write actions"></div>
                <button id="management-token-save" class="button" type="button">Save</button>
              </div>
              <div id="management-status" class="notice muted">No management action yet.</div>
            </section>
            <section class="panel">
              <table class="data-table"><thead><tr><th>Server</th><th>State</th><th>Tools</th><th>Managed</th><th>Actions</th></tr></thead><tbody id="management-servers"></tbody></table>
            </section>
          </section>
        </section>
        <section id="view-diagrams" class="view">
          <div class="view-header"><h2>Runtime Diagrams</h2></div>
          <section id="runtime-diagrams" class="diagram-grid"></section>
        </section>
        <section id="view-events" class="view">
          <div class="toolbar">
            <h2>Recent Events</h2>
            <div style="display:flex;gap:12px;flex-wrap:wrap">
              <label class="toggle"><input id="hide-agent-status" type="checkbox" checked> Hide agent status</label>
              <label class="toggle"><input id="hide-transport" type="checkbox" checked> Hide transport HTTP</label>
            </div>
          </div>
          <section class="panel filters">
            <div class="filter-field"><label for="event-filter-type">Type</label><select id="event-filter-type"><option value="">All</option><option value="tool_call">Tool call</option><option value="tool_call_lifecycle">Tool lifecycle</option><option value="http_request">HTTP</option><option value="tool_suite_changed">Tool suite</option><option value="config_reload">Config reload</option></select></div>
            <div class="filter-field"><label for="event-filter-status">Status</label><select id="event-filter-status"><option value="">All</option><option value="ok">OK</option><option value="in_flight">In flight</option><option value="client_aborted">Client aborted</option><option value="downstream_error">Downstream error</option><option value="error">Error</option></select></div>
            <div class="filter-field"><label for="event-filter-server">Server</label><select id="event-filter-server"><option value="">All</option></select></div>
            <div class="filter-field search-field"><label for="event-filter-search">Search</label><input id="event-filter-search" type="search" placeholder="Tool, path, error"></div>
          </section>
          <section class="panel">
            <table class="events-table"><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Duration</th><th>Status</th><th>Detail</th></tr></thead><tbody id="events"></tbody></table>
          </section>
        </section>
        <section id="view-runtime" class="view">
          <div class="view-header"><h2>Runtime</h2></div>
          <section class="panel">
            <pre id="runtime-json" class="runtime-json">{}</pre>
          </section>
        </section>
      </main>
    </div>
  </div>
  <script>
    const configuredPath = ${JSON.stringify(configuredPath)};
    function dashboardEndpoint(name) {
      const path = window.location.pathname || configuredPath || "/";
      const base = path.endsWith("/") ? path : path + "/";
      return new URL(name, window.location.origin + base).pathname;
    }
    const dataUrl = dashboardEndpoint("data");
    const eventsUrl = dashboardEndpoint("events");
    const viewTitles = { overview: "Overview", servers: "Servers", management: "Management", tools: "Tool Suites", diagrams: "Runtime Diagrams", events: "Recent Events", runtime: "Runtime" };
    let snapshot = null;
    let pendingSnapshot = null;
    let selectedEventKey = null;
    let selectedServerName = null;
    let hideAgentStatus = true;
    let hideTransportHttp = true;
    let eventFilters = { type: "", status: "", server: "", search: "" };
    let currentView = loadView();
    let managementToken = loadManagementToken();
    let managementMessage = { kind: "muted", text: "No management action yet." };

    function loadView() {
      try {
        return localStorage.getItem("callmux-dashboard-view") || "overview";
      } catch {
        return "overview";
      }
    }
    function saveView(view) {
      try {
        localStorage.setItem("callmux-dashboard-view", view);
      } catch {}
    }
    function loadManagementToken() {
      try {
        return localStorage.getItem("callmux-management-token") || "";
      } catch {
        return "";
      }
    }
    function saveManagementToken(value) {
      managementToken = value;
      try {
        if (value) localStorage.setItem("callmux-management-token", value);
        else localStorage.removeItem("callmux-management-token");
      } catch {}
    }
    function setManagementMessage(kind, text) {
      managementMessage = { kind, text };
      const target = document.getElementById("management-status");
      if (target) {
        target.className = "notice " + kind;
        target.textContent = text;
      }
    }
    function managementBasePath() {
      return snapshot?.management?.path || "/management/v1";
    }
    function externalMountPrefix() {
      const pagePath = (window.location.pathname || configuredPath || "/").replace(/\\/+$/, "") || "/";
      const dashboardPath = (configuredPath || "/").replace(/\\/+$/, "") || "/";
      if (dashboardPath === "/") {
        return pagePath === "/" ? "" : pagePath;
      }
      return pagePath.endsWith(dashboardPath)
        ? pagePath.slice(0, -dashboardPath.length).replace(/\\/+$/, "")
        : "";
    }
    function managementUrl(path) {
      const base = managementBasePath().replace(/\\/+$/, "");
      const prefix = externalMountPrefix();
      const normalized = prefix + base + (path ? "/" + path.replace(/^\\/+/, "") : "");
      return new URL(normalized, window.location.origin).toString();
    }
    async function managementRequest(path, options = {}) {
      const url = managementUrl(path);
      const method = options.method || "GET";
      const headers = { "Accept": "application/json", ...(options.headers || {}) };
      if (managementToken) headers.Authorization = "Bearer " + managementToken;
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const text = await res.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = text || {};
      }
      if (!res.ok) {
        const message = payload && typeof payload === "object" && typeof payload.error === "string"
          ? payload.error
          : typeof payload === "string" && payload
            ? payload
            : "HTTP " + res.status;
        throw new Error(method + " " + url + " -> HTTP " + res.status + ": " + message);
      }
      return payload;
    }
    function switchView(view) {
      if (!viewTitles[view]) return;
      currentView = view;
      saveView(view);
      document.querySelectorAll(".view").forEach(section => section.classList.toggle("active", section.id === "view-" + view));
      document.querySelectorAll("[data-view-button]").forEach(button => button.classList.toggle("active", button.dataset.viewButton === view));
      document.getElementById("view-title").textContent = viewTitles[view];
    }
    function cell(value, className = "", label = "") {
      return "<td" + (className ? " class=\\"" + className + "\\"" : "") + (label ? " data-label=\\"" + esc(label) + "\\"" : "") + ">" + String(value ?? "") + "</td>";
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[c]));
    }
    function compactCount(value) {
      const count = Number(value ?? 0);
      if (!Number.isFinite(count) || count < 1000) return String(value ?? 0);
      return Math.floor(count / 1000) + "K+";
    }
    function fanoutCount(metaCalls, downstreamCalls) {
      return compactCount(metaCalls) + " / " + compactCount(downstreamCalls);
    }
    function cacheEntriesText(cache) {
      if (cache && cache.enabled === false) return "disabled";
      return compactCount(cache?.entries ?? 0);
    }
    function formatDateTime(value) {
      if (!value) return "none";
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }
    function truncateText(value, maxLength = 180) {
      const text = String(value ?? "");
      return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
    }
    function eventKey(event) {
      return [event.timestamp, event.type, event.requestId || event.tool || event.path || ""].join("|");
    }
    function targetText(event) {
      if (event.type === "tool_call") return (event.server ? event.server + "__" : "") + (event.targetTool || event.tool);
      if (event.type === "tool_call_lifecycle") return (event.server ? event.server + "__" : "") + (event.targetTool || event.tool);
      if (event.type === "tool_suite_changed") return event.server;
      return event.jsonRpcTool || event.path || "config";
    }
    function downstreamCallCount(event) {
      return Number(event.totalDownstreamToolCalls ?? event.realToolCalls ?? event.callmuxDownstreamToolCalls ?? 0);
    }
    function eventDurationText(event) {
      return event.durationMs !== undefined ? event.durationMs + "ms" : "";
    }
    function detailText(event) {
      if (event.error) return event.error;
      if (event.type === "tool_call_lifecycle") return event.lifecycle === "client_aborted" ? "client disconnected before completion" : "call exceeded timeout while still in flight";
      if (event.status === "error" || event.success === false) return "error";
      if (event.status === "downstream_error") return "downstream error";
      if (event.type === "tool_call" && event.toolKind === "callmux_meta") {
        const downstream = downstreamCallCount(event);
        return downstream > 1 ? downstream + " downstream calls" : "";
      }
      if (event.type === "tool_suite_changed") {
        return ["gen " + event.generation, event.addedTools?.length ? "+" + event.addedTools.join(",") : "", event.removedTools?.length ? "-" + event.removedTools.join(",") : ""].filter(Boolean).join(" · ");
      }
      return "";
    }
    function statusText(event, ok) {
      return String(event.status ?? (ok ? "ok" : "error")).replace(/_/g, " ");
    }
    function statusClass(event, ok) {
      if (event.status === "downstream_error") return "warn";
      if (event.status === "in_flight" || event.status === "client_aborted") return "warn";
      return ok ? "ok" : "bad";
    }
    function eventStatus(event) {
      const ok = event.type === "http_request" ? event.status < 400 : event.status !== "error" && event.success !== false;
      return statusText(event, ok);
    }
    function eventMatchesFilters(event) {
      if (hideAgentStatus && isAgentStatusEvent(event)) return false;
      if (hideTransportHttp && isTransportHttpEvent(event)) return false;
      if (eventFilters.type && event.type !== eventFilters.type) return false;
      if (eventFilters.status && eventStatus(event) !== eventFilters.status.replace(/_/g, " ")) return false;
      if (eventFilters.server) {
        const targets = Array.isArray(event.downstreamTargets) ? event.downstreamTargets : [];
        const matchesServer =
          event.server === eventFilters.server ||
          targets.some(target => target.server === eventFilters.server) ||
          (event.type === "tool_suite_changed" && event.server === eventFilters.server);
        if (!matchesServer) return false;
      }
      if (eventFilters.search) {
        const needle = eventFilters.search.toLowerCase();
        const haystack = [event.type, targetText(event), detailText(event), event.error, event.jsonRpcMethod, event.jsonRpcTool]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    }
    function hasActiveTextSelection() {
      const selection = window.getSelection ? window.getSelection() : null;
      return Boolean(selection && !selection.isCollapsed && selection.toString());
    }
    function updateUpdatedClock() {
      document.getElementById("sidebar-status").textContent = snapshot ? "Live - " + new Date().toLocaleTimeString() : "Connecting...";
    }
    function renderHealthStrip(status, servers) {
      const statusValue = String(status.status || "unknown");
      const stateClass = statusValue === "ok" ? "ok" : statusValue === "degraded" ? "warn" : "bad";
      const downCount = servers.filter(server => server.state && server.state !== "connected").length + (status.failedServers?.length ?? 0);
      document.getElementById("health-strip").innerHTML = [
        '<div class="health-row"><span>Readiness</span><span class="health-pill ' + stateClass + '">' + esc(statusValue) + '</span></div>',
        '<div class="health-row"><span>Downstream</span><span>' + esc(downCount) + ' issue' + (downCount === 1 ? '' : 's') + '</span></div>',
        '<div class="health-row"><span>Tool suite</span><span>gen ' + esc(status.toolSuiteGeneration ?? 0) + '</span></div>',
      ].join("");
    }
    function isTransportHttpEvent(event) {
      if (event.type !== "http_request" || !["/mcp", "/sse", "/messages"].includes(event.path)) return false;
      const status = Number(event.status ?? 0);
      if (status < 400) return true;
      return status === 499 && (event.path === "/sse" || (event.path === "/mcp" && event.method === "GET"));
    }
    function isAgentStatusEvent(event) {
      const text = [event.type, targetText(event), detailText(event), event.error, event.jsonRpcMethod, event.jsonRpcTool]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (/\\bagent\\s+(ready|idle|busy)\\b/.test(text)) return true;
      return event.type === "http_request" &&
        Number(event.status ?? 0) < 400 &&
        !event.jsonRpcTool &&
        ["initialize", "notifications/initialized", "tools/list"].includes(event.jsonRpcMethod);
    }
    function detailItem(label, value) {
      return "<div class=\\"detail-item\\"><div class=\\"detail-label\\">" + esc(label) + "</div><div class=\\"detail-value\\">" + esc(value ?? "") + "</div></div>";
    }
    function targetList(targets) {
      if (!Array.isArray(targets) || targets.length === 0) return "None";
      return targets.map(target => (target.server ? target.server + "__" : "") + target.tool + (target.count === 0 ? " planned, 0 calls" : " x" + target.count)).join(", ");
    }
    function eventDetailHtml(event) {
      if (!event) return "";
      const rows = [];
      // Only render fields that carry a value, so the panel shows signal not a wall of empties.
      const add = (label, value) => {
        if (value === undefined || value === null || value === "") return;
        if (typeof value === "number" && value === 0) return;
        rows.push(detailItem(label, value));
      };
      rows.push(detailItem("Type", event.type));
      rows.push(detailItem("Status", statusText(event, event.success !== false)));
      add("Request id", event.requestId);
      add("Session id", event.sessionId);
      add("HTTP", event.method ? event.method + " " + (event.path || "") : "");
      add("Lifecycle", event.lifecycle);
      add("JSON-RPC", [event.jsonRpcMethod, event.jsonRpcTool].filter(Boolean).join(" / "));
      add("Tool kind", event.toolKind === "callmux_meta" ? "callmux meta" : event.toolKind);
      add("Operation", event.operation);
      if (event.outputFormat) {
        rows.push('<div class="detail-item"><div class="detail-label">Output format</div><div class="detail-value"><span class="pill-format">' + esc(event.outputFormat) + '</span></div></div>');
      }
      if (event.cacheHit) rows.push(detailItem("Cache", "hit"));
      add("Passthrough tool calls", event.passthroughToolCalls);
      add("Callmux meta tool calls", event.callmuxMetaToolCalls ?? event.callmuxToolCalls);
      add("Callmux downstream calls", event.callmuxDownstreamToolCalls);
      add("Total downstream calls", event.totalDownstreamToolCalls ?? event.realToolCalls);
      if (Array.isArray(event.downstreamTargets) && event.downstreamTargets.length) {
        rows.push(detailItem("Downstream targets", targetList(event.downstreamTargets)));
      }
      add("Added tools", Array.isArray(event.addedTools) && event.addedTools.length ? event.addedTools.join(", ") : "");
      add("Removed tools", Array.isArray(event.removedTools) && event.removedTools.length ? event.removedTools.join(", ") : "");
      add("Tool suite generation", event.generation);
      if (event.durationMs !== undefined) rows.push(detailItem("Duration", event.durationMs + "ms"));
      add("Error", event.error);
      return '<div><h3 style="margin:0 0 8px">Event details</h3><div class="detail-grid">' + rows.join("") + '</div></div>';
    }
    function toolChips(tools) {
      if (!Array.isArray(tools) || tools.length === 0) return '<span class="muted">No exposed tools</span>';
      return '<div class="tools-list">' + tools.map(tool => '<span class="tool-chip">' + esc(typeof tool === "string" ? tool : tool.name) + '</span>').join("") + '</div>';
    }
    function renderServerDetail(server) {
      const detail = document.getElementById("server-detail");
      if (!server) {
        detail.className = "muted";
        detail.innerHTML = "Select a server for details.";
        return;
      }
      detail.className = "";
      detail.innerHTML = '<h3 style="margin:0 0 8px">' + esc(server.name) + '</h3><div class="detail-grid">' + [
        detailItem("State", server.state),
        detailItem("Transport", server.transport),
        detailItem("Tools", (server.toolCount ?? server.exposedTools ?? 0) + "/" + (server.totalTools ?? server.toolCount ?? server.exposedTools ?? 0)),
        detailItem("Latency", server.connectDurationMs !== undefined ? server.connectDurationMs + "ms" : ""),
        detailItem("Last connected", formatDateTime(server.lastConnectedAt)),
        detailItem("Last failure", formatDateTime(server.lastFailureAt)),
        detailItem("Next retry", formatDateTime(server.nextRetryAt)),
        detailItem("Last error", server.lastError ?? server.error),
      ].join("") + '</div><h4 style="margin:14px 0 6px">Tools</h4>' + toolChips(server.tools);
    }
    function renderManagement(servers) {
      const target = document.getElementById("management-servers");
      setManagementMessage(managementMessage.kind, managementMessage.text);
      if (!snapshot?.management?.enabled) {
        target.innerHTML = '<tr><td colspan="5" class="muted">Management API is disabled.</td></tr>';
        return;
      }
      target.innerHTML = servers.map(server => {
        const runtime = server.runtime || {};
        const config = server.config || {};
        const state = runtime.state || server.state || (config.disabled ? "disabled" : "unknown");
        const disabled = config.disabled === true || state === "disabled";
        const tools = Array.isArray(server.tools) ? server.tools.length : (server.toolCount ?? 0);
        return '<tr>' +
          cell(esc(server.name), "", "Server") +
          cell(esc(state), disabled ? "warn" : state === "connected" ? "ok" : "bad", "State") +
          cell(esc(tools), "", "Tools") +
          cell(esc(server.managed ? "Override" : "base"), "", "Managed") +
          '<td data-label="Actions"><div class="inline-actions">' +
            '<button class="button secondary" data-management-action="restart" data-server="' + esc(server.name) + '"' + (disabled ? ' disabled title="Enable this server before restarting"' : '') + '>Restart</button>' +
            '<button class="button secondary" data-management-action="' + (disabled ? "enable" : "disable") + '" data-server="' + esc(server.name) + '">' + (disabled ? "Enable" : "Disable") + '</button>' +
            '<button class="button danger" data-management-action="delete" data-server="' + esc(server.name) + '">Remove</button>' +
          '</div></td>' +
        '</tr>';
      }).join("") || '<tr><td colspan="5" class="muted">No servers configured.</td></tr>';
      document.querySelectorAll("[data-management-action]").forEach(button => {
        button.addEventListener("click", async () => {
          const name = button.dataset.server;
          const action = button.dataset.managementAction;
          try {
            if (action === "restart") await managementRequest("servers/" + encodeURIComponent(name) + "/restart", { method: "POST" });
            if (action === "enable") await managementRequest("servers/" + encodeURIComponent(name), { method: "PATCH", body: { disabled: false } });
            if (action === "disable") await managementRequest("servers/" + encodeURIComponent(name), { method: "PATCH", body: { disabled: true } });
            if (action === "delete") await managementRequest("servers/" + encodeURIComponent(name), { method: "DELETE" });
            setManagementMessage("ok", action.charAt(0).toUpperCase() + action.slice(1) + " completed for " + name + ".");
            await refresh();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setManagementMessage("bad", message);
            alert(message);
          }
        });
      });
    }
    function renderToolSuites(status, servers, events) {
      const changes = events.filter(event => event.type === "tool_suite_changed").slice(-20).reverse();
      document.getElementById("tool-suites").innerHTML = servers.map(server => {
        const tools = Array.isArray(server.tools) ? server.tools : [];
        const added = Array.isArray(server.addedTools) ? server.addedTools : [];
        const removed = Array.isArray(server.removedTools) ? server.removedTools : [];
        var showAdded = added.length > 0 && added.length < tools.length;
        return '<section class="panel suite-card"><div><strong>' + esc(server.name) + '</strong><span class="muted"> - gen ' + esc(server.toolSuiteGeneration ?? status.toolSuiteGeneration ?? 0) + '</span></div>' +
          '<div class="muted">Last change: ' + esc(formatDateTime(server.lastToolSuiteChangeAt ?? status.lastToolSuiteChangeAt)) + '</div>' +
          '<div>' + toolChips(tools) + '</div>' +
          (showAdded ? '<div><span class="ok">Added</span> ' + esc(added.join(", ")) + '</div>' : '') +
          (removed.length ? '<div><span class="bad">Removed</span> ' + esc(removed.join(", ")) + '</div>' : '') +
        '</section>';
      }).join("") + '<section class="panel" style="margin-top:18px"><h3 style="margin:0 0 8px">Recent tool-suite changes</h3>' +
        (changes.length ? changes.map(change => '<div class="detail-item"><strong>' + esc(change.server) + '</strong><div class="muted">' + esc(formatDateTime(change.timestamp)) + ' - gen ' + esc(change.generation) + '</div><div>' + esc(detailText(change)) + '</div></div>').join("") : '<div class="muted">No tool-suite changes recorded.</div>') +
        '</section>';
    }
    function updateServerFilterOptions(servers) {
      const select = document.getElementById("event-filter-server");
      const current = select.value;
      select.innerHTML = '<option value="">All</option>' + servers.map(server => '<option value="' + esc(server.name) + '">' + esc(server.name) + '</option>').join("");
      select.value = servers.some(server => server.name === current) ? current : "";
      eventFilters.server = select.value;
    }
    function barRow(label, value, max, className = "") {
      const percent = max > 0 ? Math.max(2, Math.min(100, Math.round((Number(value || 0) / max) * 100))) : 0;
      return '<div class="bar-row"><div class="bar-meta"><span>' + esc(label) + '</span><strong>' + esc(compactCount(value || 0)) + '</strong></div><div class="bar-track"><div class="bar-fill ' + esc(className) + '" style="width:' + percent + '%"></div></div></div>';
    }
    function miniRows(rows, emptyText = "No activity") {
      const visible = rows.filter(row => Number(row[1] ?? 0) > 0);
      if (visible.length === 0) return '<div class="muted">' + esc(emptyText) + '</div>';
      return '<div class="mini-table">' + visible.map(row => '<div class="mini-row"><span>' + esc(row[0]) + '</span><strong>' + esc(compactCount(row[1])) + '</strong></div>').join("") + '</div>';
    }
    function clientRows(status) {
      const sessions = Array.isArray(status.listener?.sessions) ? status.listener.sessions : [];
      const bridge = sessions.filter(session => session.clientKind === "stdio-bridge").length;
      const sse = sessions.filter(session => session.transport === "sse").length;
      const http = sessions.filter(session => session.transport === "streamable-http" && session.clientKind !== "stdio-bridge").length;
      return [["HTTP", http], ["SSE", sse], ["STDIO Bridge", bridge]];
    }
    function renderTrafficChart(events) {
      const now = Date.now();
      const bucketMs = 5000;
      const bucketCount = 24;
      const metaBuckets = Array.from({ length: bucketCount }, () => 0);
      const passthroughBuckets = Array.from({ length: bucketCount }, () => 0);
      const downstreamBuckets = Array.from({ length: bucketCount }, () => 0);
      for (const event of events) {
        if (event.type !== "tool_call") continue;
        const ts = new Date(event.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        const age = now - ts;
        if (age < 0 || age >= bucketMs * bucketCount) continue;
        const i = bucketCount - 1 - Math.floor(age / bucketMs);
        if (event.toolKind === "callmux_meta") {
          metaBuckets[i] += 1;
        } else {
          passthroughBuckets[i] += 1;
        }
        downstreamBuckets[i] += Number(event.totalDownstreamToolCalls ?? event.realToolCalls ?? 1);
      }
      const L = 38, R = 308, T = 12, B = 142, W = R - L, H = B - T;
      const rawMax = Math.max(1, ...metaBuckets, ...passthroughBuckets, ...downstreamBuckets);
      function niceNum(v) {
        if (v <= 0) return 1;
        const exp = Math.floor(Math.log10(v));
        const f = v / Math.pow(10, exp);
        return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * Math.pow(10, exp);
      }
      const ticks = 4;
      const step = Math.max(1, niceNum(rawMax / ticks));
      const nMax = step * ticks;
      function toXY(buckets) {
        return buckets.map(function(v, j) {
          return [(L + j * W / Math.max(1, bucketCount - 1)).toFixed(1), (B - v / nMax * H).toFixed(1)];
        });
      }
      function poly(pts) { return pts.map(function(p) { return p[0] + "," + p[1]; }).join(" "); }
      function filled(pts) { return L + "," + B + " " + poly(pts) + " " + R + "," + B; }
      var grid = "";
      for (var t = 0; t <= ticks; t++) {
        var val = t * step;
        var y = (B - val / nMax * H).toFixed(1);
        grid += '<line class="chart-grid" x1="' + L + '" y1="' + y + '" x2="' + R + '" y2="' + y + '"/>';
        grid += '<text class="chart-label" x="' + (L - 4) + '" y="' + (Number(y) + 3).toFixed(1) + '" text-anchor="end">' + val + '</text>';
      }
      var xMarks = [[0, "2m"], [6, "90s"], [12, "1m"], [18, "30s"], [bucketCount - 1, "now"]];
      var xSvg = "";
      for (var m = 0; m < xMarks.length; m++) {
        var x = (L + xMarks[m][0] * W / Math.max(1, bucketCount - 1)).toFixed(1);
        xSvg += '<text class="chart-label" x="' + x + '" y="' + (B + 14) + '" text-anchor="middle">' + xMarks[m][1] + '</text>';
      }
      var series = [
        { b: downstreamBuckets, lc: "chart-line-downstream", ac: "chart-area-downstream", label: "Downstream", color: "#a78bfa" },
        { b: passthroughBuckets, lc: "chart-line-passthrough", ac: "chart-area-passthrough", label: "Passthrough", color: "#34d399" },
        { b: metaBuckets, lc: "chart-line-meta", ac: "chart-area-meta", label: "Meta", color: "#38bdf8" },
      ];
      var sSvg = "";
      for (var s = 0; s < series.length; s++) {
        var pts = toXY(series[s].b);
        sSvg += '<polygon class="' + series[s].ac + '" points="' + filled(pts) + '"/>';
        sSvg += '<polyline class="' + series[s].lc + '" points="' + poly(pts) + '"/>';
      }
      var legendItems = series.slice().reverse();
      var legend = '<div class="chart-legend">';
      for (var li = 0; li < legendItems.length; li++) {
        var total = legendItems[li].b.reduce(function(a, b) { return a + b; }, 0);
        legend += '<div class="chart-legend-item"><span class="chart-legend-dot" style="background:' + legendItems[li].color + '"></span>' + legendItems[li].label + ' <span class="muted">(' + total + ')</span></div>';
      }
      legend += '</div>';
      return '<div class="traffic-chart"><svg viewBox="0 0 320 165" role="img" aria-label="Tool call traffic">' + grid + xSvg + sSvg + '</svg>' + legend + '</div>';
    }
    function renderFlowDiagram(status, servers, summary) {
      const passthroughCalls = summary.passthroughToolCalls ?? 0;
      const metaCalls = summary.callmuxMetaToolCalls ?? summary.callmuxToolCalls ?? 0;
      const metaDownstreamCalls = summary.callmuxDownstreamToolCalls ?? 0;
      return '<div class="flow">' +
        '<div class="flow-node"><strong>Clients</strong>' + miniRows(clientRows(status), "No active clients") + '</div>' +
        '<div class="flow-arrow">→</div>' +
        '<div class="flow-node"><strong>callmux</strong>' + miniRows([["Passthrough", passthroughCalls], ["Meta calls", metaCalls]]) + '</div>' +
        '<div class="flow-arrow">→</div>' +
        '<div class="flow-node"><strong>MCP Servers</strong>' + miniRows([["Passthrough", passthroughCalls], ["Meta calls", metaDownstreamCalls]]) + '</div>' +
      '</div>';
    }
    function activeToolCallRows(status) {
      const calls = Array.isArray(status.listener?.activeToolCalls) ? status.listener.activeToolCalls : [];
      if (calls.length === 0) return '<div class="muted">No active tool calls</div>';
      return calls.map(call => {
        const target = (call.server ? call.server + "__" : "") + (call.targetTool || call.tool);
        const statusClassName = call.status === "client_aborted" ? "warn" : "ok";
        const meta = [
          call.requestId ? "request " + call.requestId : "",
          call.sessionId ? "session " + call.sessionId : "",
          call.cwd || "",
          targetList(call.downstreamTargets),
        ].filter(Boolean).join(" · ");
        return '<div class="active-call"><div><strong>' + esc(target) + '</strong><div class="active-call-meta">' + esc(meta) + '</div></div><div><span class="' + statusClassName + '">' + esc(String(call.status || "in_flight").replace(/_/g, " ")) + '</span><div class="active-call-meta">' + esc(call.durationMs ?? 0) + 'ms</div></div></div>';
      }).join("");
    }
    function renderRuntimeDiagrams(status, servers, summary, events) {
      const maxCalls = Math.max(1, summary.totalDownstreamToolCalls ?? summary.realToolCalls ?? 0, summary.passthroughToolCalls ?? 0, summary.callmuxDownstreamToolCalls ?? 0);
      const connected = servers.filter(server => server.state === "connected").length;
      const degraded = servers.length - connected + (status.failedServers?.length ?? 0);
      const cacheEntries = status.cache?.entries ?? 0;
      const storedRefs = status.responseStore?.entries ?? 0;
      document.getElementById("runtime-diagrams").innerHTML = [
        '<section class="panel"><h2>Tool Call Traffic</h2>' + renderTrafficChart(events) + '</section>',
        '<section class="panel"><h2>Tool Call Mix</h2><div class="bar-list">' +
          barRow("Passthrough", summary.passthroughToolCalls ?? 0, maxCalls) +
          barRow("Meta fan-out", summary.callmuxDownstreamToolCalls ?? 0, maxCalls) +
          barRow("Total downstream", summary.totalDownstreamToolCalls ?? summary.realToolCalls ?? 0, maxCalls) +
        '</div></section>',
        '<section class="panel"><h2>Runtime Buffers</h2><div class="bar-list">' +
          barRow("Cache entries", cacheEntries, Math.max(1, status.cache?.maxEntries ?? cacheEntries)) +
          barRow("Stored refs", storedRefs, Math.max(1, status.responseStore?.maxEntries ?? storedRefs)) +
        '</div></section>',
        '<section class="panel"><h2>Downstream Health</h2><div class="bar-list">' +
          barRow("Connected", connected, Math.max(1, servers.length + (status.failedServers?.length ?? 0)), "ok") +
          barRow("Degraded/down", degraded, Math.max(1, servers.length + (status.failedServers?.length ?? 0)), "bad") +
        '</div></section>',
      ].join("");
    }
    function render(data) {
      snapshot = data;
      updateUpdatedClock();
      const status = data.status || {};
      const cache = status.cache || {};
      const responseStore = status.responseStore || {};
      const servers = Array.isArray(status.servers)
        ? status.servers
        : Object.entries(status.servers || {}).map(([name, server]) => ({ name, ...server }));
      const allEvents = Array.isArray(data.events) ? data.events : [];
      const managementServers = Array.isArray(data.managementServers) ? data.managementServers : servers;
      if (!selectedServerName && servers.length > 0) selectedServerName = servers[0].name;
      renderHealthStrip(status, servers);
      updateServerFilterOptions(servers);
      document.getElementById("summary").innerHTML = [
        ["Servers", servers.length],
        ["Sessions", status.listener?.activeSessions ?? 0],
        ["In-flight", status.listener?.activeToolCallCount ?? 0],
        ["Cache entries", cacheEntriesText(cache)],
        ["Stored refs", responseStore.entries ?? 0],
        ["Events", compactCount(data.summary.totalEvents ?? data.summary.eventCount)],
        ["Passthrough calls", compactCount(data.summary.passthroughToolCalls ?? 0)],
        ["Meta calls / downstream", fanoutCount(data.summary.callmuxMetaToolCalls ?? data.summary.callmuxToolCalls, data.summary.callmuxDownstreamToolCalls ?? 0)],
        ["Total downstream", compactCount(data.summary.totalDownstreamToolCalls ?? data.summary.realToolCalls)],
        ["Recent errors", data.summary.recentErrors],
      ].map(([label, value]) => "<div class=\\"panel\\"><div class=\\"muted\\">" + esc(label) + "</div><div class=\\"metric\\">" + esc(value) + "</div></div>").join("");
      document.getElementById("active-calls").innerHTML = activeToolCallRows(status);
      document.getElementById("overview-flow").innerHTML = renderFlowDiagram(status, servers, data.summary);
      document.getElementById("servers").innerHTML = servers.map((server) => {
        const stateClass = server.state === "connected" ? "ok" : "bad";
        const toolCount = server.toolCount ?? server.exposedTools ?? (Array.isArray(server.tools) ? server.tools.length : 0);
        const totalTools = server.totalTools ?? toolCount;
        const latency = server.connectDurationMs === undefined ? "" : server.connectDurationMs + "ms";
        const selected = server.name === selectedServerName ? " selected" : "";
        return '<tr class="server-row' + selected + '" data-server="' + esc(server.name) + '">' + cell(esc(server.name), "", "Server") + cell(esc(server.state), stateClass, "State") + cell(esc(server.transport), "", "Transport") + cell(esc(toolCount + "/" + totalTools), "", "Tools") + cell(esc(latency), "", "Latency") + "</tr>";
      }).join("");
      document.querySelectorAll("tr.server-row").forEach(row => {
        row.addEventListener("click", () => {
          selectedServerName = row.dataset.server;
          render(data);
        });
      });
      renderServerDetail(servers.find(server => server.name === selectedServerName));
      renderManagement(managementServers);
      renderToolSuites(status, servers, allEvents);
      renderRuntimeDiagrams(status, servers, data.summary, allEvents);
      document.getElementById("runtime-json").textContent = JSON.stringify(status, null, 2);
      const displayedEvents = allEvents.filter(eventMatchesFilters).slice(-80).reverse();
      document.getElementById("events").innerHTML = displayedEvents.map((event, index) => {
        const key = eventKey(event);
        const ok = event.type === "http_request" ? event.status < 400 : event.status !== "error" && event.success !== false;
        const selected = key === selectedEventKey ? " selected" : "";
        const row = "<tr class=\\"event-row" + selected + "\\" data-event-index=\\"" + index + "\\">" +
          cell(esc(new Date(event.timestamp).toLocaleTimeString()), "", "Time") +
          cell(esc(event.type), "", "Type") +
          cell(esc(targetText(event)), "", "Target") +
          cell(esc(eventDurationText(event)), "", "Duration") +
          cell(esc(statusText(event, ok)), statusClass(event, ok), "Status") +
          cell(esc(truncateText(detailText(event))), "muted", "Detail") +
          "</tr>";
        return selected ? row + '<tr class="event-detail-row"><td colspan="6">' + eventDetailHtml(event) + '</td></tr>' : row;
      }).join("");
      document.querySelectorAll("tr.event-row").forEach(row => {
        row.addEventListener("click", () => {
          const event = displayedEvents[Number(row.dataset.eventIndex)];
          const key = eventKey(event);
          selectedEventKey = selectedEventKey === key ? null : key;
          render(data);
        });
      });
    }
    function renderWhenSelectionAllows(data) {
      if (hasActiveTextSelection()) {
        pendingSnapshot = data;
        return;
      }
      pendingSnapshot = null;
      render(data);
    }
    document.addEventListener("selectionchange", () => {
      if (!hasActiveTextSelection() && pendingSnapshot) {
        const data = pendingSnapshot;
        pendingSnapshot = null;
        render(data);
      }
    });
    document.getElementById("hide-transport").addEventListener("change", event => {
      hideTransportHttp = event.target.checked;
      if (snapshot) render(snapshot);
    });
    document.getElementById("hide-agent-status").addEventListener("change", event => {
      hideAgentStatus = event.target.checked;
      if (snapshot) render(snapshot);
    });
    document.getElementById("event-filter-type").addEventListener("change", event => {
      eventFilters.type = event.target.value;
      if (snapshot) render(snapshot);
    });
    document.getElementById("event-filter-status").addEventListener("change", event => {
      eventFilters.status = event.target.value;
      if (snapshot) render(snapshot);
    });
    document.getElementById("event-filter-server").addEventListener("change", event => {
      eventFilters.server = event.target.value;
      if (snapshot) render(snapshot);
    });
    document.getElementById("event-filter-search").addEventListener("input", event => {
      eventFilters.search = event.target.value;
      if (snapshot) render(snapshot);
    });
    document.getElementById("management-token").value = managementToken;
    document.getElementById("management-token-save").addEventListener("click", () => {
      saveManagementToken(document.getElementById("management-token").value.trim());
    });
    document.querySelectorAll("[data-view-button]").forEach(button => {
      button.addEventListener("click", () => switchView(button.dataset.viewButton));
    });
    (function () {
      const select = document.getElementById("theme-select");
      if (!select) return;
      select.value = document.documentElement.getAttribute("data-theme") || "light";
      select.addEventListener("change", () => {
        const theme = select.value;
        document.documentElement.setAttribute("data-theme", theme);
        try { localStorage.setItem("callmux-dashboard-theme", theme); } catch {}
      });
    })();
    async function refresh() {
      const res = await fetch(dataUrl, { headers: { "Accept": "application/json" } });
      if (res.ok) renderWhenSelectionAllows(await res.json());
    }
    switchView(currentView);
    refresh();
    setInterval(updateUpdatedClock, 1000);
    const stream = new EventSource(eventsUrl);
    stream.onmessage = () => refresh();
    stream.onerror = () => setTimeout(refresh, 1500);
  </script>
</body>
</html>`;
}
