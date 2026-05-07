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

export interface DashboardSnapshot {
  generatedAt: string;
  summary: DashboardRuntimeSummary;
  status: unknown;
  events: RuntimeEvent[];
}

function normalizePath(path: string | undefined): string {
  if (!path || path.trim().length === 0) return DEFAULT_DASHBOARD_PATH;
  const trimmed = path.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
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
  if (event.type === "http_request") return event.status >= 400;
  if (event.type === "tool_call") {
    return event.status === "error" || (event.status === undefined && !event.success);
  }
  if (event.type === "config_reload") return !event.success;
  return false;
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
  const basePath = config.path;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href=${JSON.stringify(DASHBOARD_FAVICON_HREF)}>
  <title>callmux dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fa; color: #17202a; }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    .app-shell { display: flex; min-height: 100vh; }
    .sidebar { background: #102033; color: white; display: flex; flex-direction: column; min-height: 100vh; position: sticky; top: 0; width: 230px; }
    .brand { border-bottom: 1px solid rgba(255,255,255,0.12); padding: 18px 18px 16px; }
    .brand-mark { align-items: center; display: flex; gap: 10px; }
    .brand-icon { align-items: center; background: #05070a; border: 1px solid rgba(56,189,248,0.35); border-radius: 8px; color: #38bdf8; display: inline-flex; font-weight: 800; height: 32px; justify-content: center; width: 32px; }
    .brand-title { font-size: 16px; font-weight: 700; }
    .nav { display: flex; flex-direction: column; gap: 4px; padding: 12px 10px; }
    .nav-button { align-items: center; background: transparent; border: 0; border-radius: 6px; color: #c9d5e3; cursor: pointer; display: flex; font: inherit; gap: 10px; padding: 9px 10px; text-align: left; }
    .nav-button:hover { background: rgba(255,255,255,0.08); color: white; }
    .nav-button.active { background: #38bdf8; color: #06101d; font-weight: 700; }
    .nav-icon { font-size: 16px; line-height: 1; width: 18px; }
    .sidebar-footer { border-top: 1px solid rgba(255,255,255,0.12); color: #a7b7ca; font-size: 12px; margin-top: auto; padding: 14px 18px; }
    .mobile-nav { background: #102033; border-bottom: 1px solid rgba(255,255,255,0.12); display: none; gap: 6px; overflow-x: auto; padding: 8px; position: sticky; top: 0; z-index: 5; }
    .content { flex: 1; min-width: 0; }
    header { background: white; border-bottom: 1px solid #d9dee7; padding: 16px 24px; display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    main { padding: 20px 24px 32px; max-width: 1240px; margin: 0 auto; }
    .view { display: none; }
    .view.active { display: block; }
    .view-header { align-items: baseline; display: flex; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .panel { background: white; border: 1px solid #d9dee7; border-radius: 8px; padding: 14px; }
    .metric { font-size: 28px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e4e7ec; vertical-align: top; }
    td { overflow-wrap: anywhere; }
    th { color: #536070; font-weight: 600; }
    .events-table { table-layout: fixed; }
    .events-table th:nth-child(1) { width: 82px; }
    .events-table th:nth-child(2) { width: 110px; }
    .events-table th:nth-child(3) { width: 28%; }
    .events-table th:nth-child(4) { width: 72px; }
    tr.event-row { cursor: pointer; }
    tr.event-row:hover { background: #f0f4f8; }
    tr.selected { background: #e8f2ff; }
    .ok { color: #167447; font-weight: 600; }
    .warn { color: #b54708; font-weight: 600; }
    .bad { color: #b42318; font-weight: 600; }
    .muted { color: #667085; }
    .toolbar { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; margin-bottom: 10px; }
    .toolbar h2 { margin: 0; }
    .toggle { align-items: center; color: #536070; display: inline-flex; font-size: 13px; gap: 7px; user-select: none; }
    .toggle input { margin: 0; }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 8px; }
    .detail-item { border: 1px solid #e4e7ec; border-radius: 6px; padding: 8px; }
    .detail-label { color: #667085; font-size: 12px; margin-bottom: 4px; }
    .detail-value { font-size: 13px; overflow-wrap: anywhere; }
    .runtime-json { background: #0f1720; border-radius: 8px; color: #dbeafe; font-size: 12px; margin: 0; max-height: 68vh; overflow: auto; padding: 12px; white-space: pre-wrap; }
    @media (prefers-color-scheme: dark) {
      body { background: #101418; color: #e5edf5; }
      header { background: #161c23; border-bottom-color: #303946; }
      .sidebar, .mobile-nav { background: #07111d; }
      .panel { background: #161c23; border-color: #303946; }
      th, td { border-bottom-color: #303946; }
      tr.event-row:hover { background: #1e2936; }
      tr.selected { background: #17304a; }
      .detail-item { border-color: #303946; }
      th, .muted, .toggle { color: #a7b0be; }
    }
    @media (max-width: 720px) {
      .app-shell { display: block; }
      .sidebar { display: none; }
      .mobile-nav { display: flex; }
      .nav-button { flex: 0 0 auto; padding: 8px 10px; }
      header { align-items: flex-start; flex-direction: column; padding: 14px 16px; }
      main { padding: 14px 12px 24px; }
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      .panel { padding: 12px; }
      .metric { font-size: 22px; }
      .events-table, .events-table thead, .events-table tbody, .events-table tr, .events-table td { display: block; width: 100%; }
      .events-table thead { display: none; }
      .events-table tr.event-row { border: 1px solid #e4e7ec; border-radius: 8px; margin-bottom: 10px; padding: 8px 10px; }
      .events-table td { border-bottom: 0; box-sizing: border-box; display: grid; gap: 6px; grid-template-columns: 68px minmax(0, 1fr); padding: 4px 0; }
      .events-table td::before { content: attr(data-label); color: #667085; font-size: 12px; font-weight: 600; }
      .events-table td[data-label="Detail"] { display: block; padding-top: 7px; }
      .events-table td[data-label="Detail"]::before { display: block; margin-bottom: 3px; }
      .detail-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 720px) and (prefers-color-scheme: dark) {
      .events-table tr.event-row { border-color: #303946; }
      .events-table td::before { color: #a7b0be; }
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
        <button class="nav-button" data-view-button="events"><span class="nav-icon">E</span>Events</button>
        <button class="nav-button" data-view-button="runtime"><span class="nav-icon">{} </span>Runtime</button>
      </nav>
      <div class="sidebar-footer">
        <div id="sidebar-status">Connecting...</div>
      </div>
    </aside>
    <div class="content">
      <div class="mobile-nav" aria-label="Dashboard sections">
        <button class="nav-button active" data-view-button="overview">Overview</button>
        <button class="nav-button" data-view-button="servers">Servers</button>
        <button class="nav-button" data-view-button="events">Events</button>
        <button class="nav-button" data-view-button="runtime">Runtime</button>
      </div>
      <header>
        <h1 id="view-title">Overview</h1>
        <div id="updated" class="muted">Connecting...</div>
      </header>
      <main>
        <section id="view-overview" class="view active">
          <div class="view-header"><h2>Overview</h2><span class="muted">Live proxy activity</span></div>
          <section class="grid" id="summary"></section>
        </section>
        <section id="view-servers" class="view">
          <div class="view-header"><h2>Servers</h2><span class="muted">Downstream health and tool exposure</span></div>
          <section class="panel">
            <table><thead><tr><th>Server</th><th>State</th><th>Transport</th><th>Tools</th><th>Latency</th></tr></thead><tbody id="servers"></tbody></table>
          </section>
        </section>
        <section id="view-events" class="view">
          <div class="toolbar">
            <h2>Recent Events</h2>
            <label class="toggle"><input id="hide-transport" type="checkbox" checked> Hide transport HTTP</label>
          </div>
          <section class="panel">
            <table class="events-table"><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Status</th><th>Detail</th></tr></thead><tbody id="events"></tbody></table>
          </section>
          <section class="panel" style="margin-top:18px">
            <div id="event-detail" class="muted">Select an event for details.</div>
          </section>
        </section>
        <section id="view-runtime" class="view">
          <div class="view-header"><h2>Runtime</h2><span class="muted">Current status payload</span></div>
          <section class="panel">
            <pre id="runtime-json" class="runtime-json">{}</pre>
          </section>
        </section>
      </main>
    </div>
  </div>
  <script>
    const dataUrl = ${JSON.stringify(`${basePath}/data`)};
    const eventsUrl = ${JSON.stringify(`${basePath}/events`)};
    const viewTitles = { overview: "Overview", servers: "Servers", events: "Recent Events", runtime: "Runtime" };
    let snapshot = null;
    let pendingSnapshot = null;
    let selectedEventKey = null;
    let hideTransportHttp = true;
    let currentView = loadView();

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
    function truncateText(value, maxLength = 180) {
      const text = String(value ?? "");
      return text.length > maxLength ? text.slice(0, maxLength - 3) + "..." : text;
    }
    function eventKey(event) {
      return [event.timestamp, event.type, event.requestId || event.tool || event.path || ""].join("|");
    }
    function targetText(event) {
      if (event.type === "tool_call") return (event.server ? event.server + "__" : "") + (event.targetTool || event.tool);
      if (event.type === "tool_suite_changed") return event.server;
      return event.jsonRpcTool || event.path || "config";
    }
    function detailText(event) {
      if (event.error) return event.error;
      if (event.type === "tool_suite_changed") {
        return ["gen " + event.generation, event.addedTools?.length ? "+" + event.addedTools.join(",") : "", event.removedTools?.length ? "-" + event.removedTools.join(",") : ""].filter(Boolean).join(" · ");
      }
      const totalDownstream = event.totalDownstreamToolCalls ?? event.realToolCalls;
      const passthrough = event.passthroughToolCalls ?? (
        event.toolKind === "downstream" ? event.realToolCalls : undefined
      );
      const meta = event.callmuxMetaToolCalls ?? event.callmuxToolCalls;
      const metaDownstream = event.callmuxDownstreamToolCalls ?? (
        event.toolKind === "callmux_meta" ? event.realToolCalls : undefined
      );
      const calls = totalDownstream !== undefined
        ? ["downstream " + totalDownstream, passthrough ? "pass " + passthrough : "", meta ? "meta " + meta + "/" + (metaDownstream ?? 0) : ""].filter(Boolean).join(" · ")
        : "";
      if (event.type === "http_request") return [event.method + " " + event.durationMs + "ms", event.jsonRpcMethod, calls].filter(Boolean).join(" · ");
      return [event.operation, event.durationMs ? event.durationMs + "ms" : "", calls].filter(Boolean).join(" · ");
    }
    function statusText(event, ok) {
      return String(event.status ?? (ok ? "ok" : "error")).replace(/_/g, " ");
    }
    function statusClass(event, ok) {
      if (event.status === "downstream_error") return "warn";
      return ok ? "ok" : "bad";
    }
    function hasActiveTextSelection() {
      const selection = window.getSelection ? window.getSelection() : null;
      return Boolean(selection && !selection.isCollapsed && selection.toString());
    }
    function updateUpdatedClock() {
      const updated = document.getElementById("updated");
      updated.textContent = snapshot ? "Updated " + new Date().toLocaleTimeString() : "Connecting...";
      document.getElementById("sidebar-status").textContent = snapshot ? "Live - " + new Date().toLocaleTimeString() : "Connecting...";
    }
    function isTransportHttpEvent(event) {
      return event.type === "http_request" && ["/mcp", "/sse", "/messages"].includes(event.path) && Number(event.status ?? 0) < 400;
    }
    function detailItem(label, value) {
      return "<div class=\\"detail-item\\"><div class=\\"detail-label\\">" + esc(label) + "</div><div class=\\"detail-value\\">" + esc(value ?? "") + "</div></div>";
    }
    function targetList(targets) {
      if (!Array.isArray(targets) || targets.length === 0) return "None";
      return targets.map(target => (target.server ? target.server + "__" : "") + target.tool + (target.count === 0 ? " planned, 0 calls" : " x" + target.count)).join(", ");
    }
    function renderEventDetail(event) {
      const detail = document.getElementById("event-detail");
      if (!event) {
        detail.className = "muted";
        detail.innerHTML = "Select an event for details.";
        return;
      }
      detail.className = "";
      detail.innerHTML = "<h3 style=\\"margin:0 0 8px\\">Event details</h3><div class=\\"detail-grid\\">" + [
        detailItem("Type", event.type),
        detailItem("Status", statusText(event, event.success !== false)),
        detailItem("Request id", event.requestId),
        detailItem("HTTP", event.method ? event.method + " " + (event.path || "") : ""),
        detailItem("JSON-RPC", [event.jsonRpcMethod, event.jsonRpcTool].filter(Boolean).join(" / ")),
        detailItem("Tool kind", event.toolKind),
        detailItem("Operation", event.operation),
        detailItem("Passthrough tool calls", event.passthroughToolCalls),
        detailItem("Callmux meta tool calls", event.callmuxMetaToolCalls ?? event.callmuxToolCalls),
        detailItem("Callmux downstream calls", event.callmuxDownstreamToolCalls),
        detailItem("Total downstream calls", event.totalDownstreamToolCalls ?? event.realToolCalls),
        detailItem("Downstream targets", targetList(event.downstreamTargets)),
        detailItem("Added tools", Array.isArray(event.addedTools) ? event.addedTools.join(", ") : ""),
        detailItem("Removed tools", Array.isArray(event.removedTools) ? event.removedTools.join(", ") : ""),
        detailItem("Tool suite generation", event.generation),
        detailItem("Duration", event.durationMs !== undefined ? event.durationMs + "ms" : ""),
        detailItem("Error", event.error),
      ].join("") + "</div>";
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
      document.getElementById("summary").innerHTML = [
        ["Servers", servers.length],
        ["Sessions", status.listener?.activeSessions ?? 0],
        ["Cache entries", cacheEntriesText(cache)],
        ["Stored refs", responseStore.entries ?? 0],
        ["Events", compactCount(data.summary.totalEvents ?? data.summary.eventCount)],
        ["Passthrough calls", compactCount(data.summary.passthroughToolCalls ?? 0)],
        ["Meta calls / downstream", fanoutCount(data.summary.callmuxMetaToolCalls ?? data.summary.callmuxToolCalls, data.summary.callmuxDownstreamToolCalls ?? 0)],
        ["Total downstream", compactCount(data.summary.totalDownstreamToolCalls ?? data.summary.realToolCalls)],
        ["Recent errors", data.summary.recentErrors],
      ].map(([label, value]) => "<div class=\\"panel\\"><div class=\\"muted\\">" + esc(label) + "</div><div class=\\"metric\\">" + esc(value) + "</div></div>").join("");
      document.getElementById("servers").innerHTML = servers.map((server) => {
        const stateClass = server.state === "connected" ? "ok" : "bad";
        const toolCount = server.toolCount ?? server.exposedTools ?? (Array.isArray(server.tools) ? server.tools.length : 0);
        const totalTools = server.totalTools ?? toolCount;
        const latency = server.connectDurationMs === undefined ? "" : server.connectDurationMs + "ms";
        return "<tr>" + cell(esc(server.name)) + cell(esc(server.state), stateClass) + cell(esc(server.transport)) + cell(esc(toolCount + "/" + totalTools)) + cell(esc(latency)) + "</tr>";
      }).join("");
      document.getElementById("runtime-json").textContent = JSON.stringify(status, null, 2);
      const displayedEvents = data.events.filter(event => !hideTransportHttp || !isTransportHttpEvent(event)).slice(-80).reverse();
      document.getElementById("events").innerHTML = displayedEvents.map((event, index) => {
        const key = eventKey(event);
        const ok = event.type === "http_request" ? event.status < 400 : event.status !== "error" && event.success !== false;
        const selected = key === selectedEventKey ? " selected" : "";
        return "<tr class=\\"event-row" + selected + "\\" data-event-index=\\"" + index + "\\">" + cell(esc(new Date(event.timestamp).toLocaleTimeString()), "", "Time") + cell(esc(event.type), "", "Type") + cell(esc(targetText(event)), "", "Target") + cell(esc(statusText(event, ok)), statusClass(event, ok), "Status") + cell(esc(truncateText(detailText(event))), "muted", "Detail") + "</tr>";
      }).join("");
      document.querySelectorAll("tr.event-row").forEach(row => {
        row.addEventListener("click", () => {
          const event = displayedEvents[Number(row.dataset.eventIndex)];
          selectedEventKey = eventKey(event);
          renderEventDetail(event);
          render(data);
        });
      });
      renderEventDetail(displayedEvents.find(event => eventKey(event) === selectedEventKey));
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
    document.querySelectorAll("[data-view-button]").forEach(button => {
      button.addEventListener("click", () => switchView(button.dataset.viewButton));
    });
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
