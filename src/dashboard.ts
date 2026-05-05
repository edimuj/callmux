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
    }
  | {
      type: "tool_call";
      timestamp: string;
      tool: string;
      server?: string;
      targetTool?: string;
      durationMs: number;
      success: boolean;
      cacheHit?: boolean;
      error?: string;
    }
  | {
      type: "config_reload";
      timestamp: string;
      success: boolean;
      error?: string;
    };

export interface DashboardConfig {
  enabled?: boolean;
  path?: string;
  maxEvents?: number;
}

interface DashboardRuntimeSummary {
  eventCount: number;
  maxEvents: number;
  recentErrors: number;
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

export class RuntimeEventStore {
  private events: RuntimeEvent[] = [];
  private subscribers = new Set<(event: RuntimeEvent) => void>();

  constructor(private maxEvents = DEFAULT_MAX_EVENTS) {}

  setMaxEvents(maxEvents = DEFAULT_MAX_EVENTS): void {
    this.maxEvents = maxEvents;
    this.evictOldest();
  }

  append(event: RuntimeEvent): void {
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
      maxEvents: this.maxEvents,
      recentErrors: this.events.filter((event) =>
        event.type === "http_request"
          ? event.status >= 400
          : event.type === "tool_call"
            ? !event.success
            : event.type === "config_reload"
              ? !event.success
              : false
      ).length,
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
  <title>callmux dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f8fa; color: #17202a; }
    header { background: #102033; color: white; padding: 18px 24px; display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    main { padding: 20px 24px 32px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .panel { background: white; border: 1px solid #d9dee7; border-radius: 8px; padding: 14px; }
    .metric { font-size: 28px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e4e7ec; vertical-align: top; }
    th { color: #536070; font-weight: 600; }
    .ok { color: #167447; font-weight: 600; }
    .bad { color: #b42318; font-weight: 600; }
    .muted { color: #667085; }
    @media (prefers-color-scheme: dark) {
      body { background: #101418; color: #e5edf5; }
      header { background: #07111d; }
      .panel { background: #161c23; border-color: #303946; }
      th, td { border-bottom-color: #303946; }
      th, .muted { color: #a7b0be; }
    }
  </style>
</head>
<body>
  <header>
    <h1>callmux dashboard</h1>
    <div id="updated" class="muted">Connecting...</div>
  </header>
  <main>
    <section class="grid" id="summary"></section>
    <section class="panel">
      <h2>Servers</h2>
      <table><thead><tr><th>Server</th><th>State</th><th>Transport</th><th>Tools</th><th>Latency</th></tr></thead><tbody id="servers"></tbody></table>
    </section>
    <section class="panel" style="margin-top:18px">
      <h2>Recent Events</h2>
      <table><thead><tr><th>Time</th><th>Type</th><th>Target</th><th>Status</th><th>Detail</th></tr></thead><tbody id="events"></tbody></table>
    </section>
  </main>
  <script>
    const dataUrl = ${JSON.stringify(`${basePath}/data`)};
    const eventsUrl = ${JSON.stringify(`${basePath}/events`)};
    let snapshot = null;

    function cell(value, className = "") {
      return "<td" + (className ? " class=\\"" + className + "\\"" : "") + ">" + String(value ?? "") + "</td>";
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[c]));
    }
    function render(data) {
      snapshot = data;
      document.getElementById("updated").textContent = "Updated " + new Date(data.generatedAt).toLocaleTimeString();
      const status = data.status || {};
      const cache = status.cache || {};
      const responseStore = status.responseStore || {};
      document.getElementById("summary").innerHTML = [
        ["Servers", Object.keys(status.servers || {}).length],
        ["Sessions", status.listener?.activeSessions ?? 0],
        ["Cache entries", cache.entries ?? 0],
        ["Stored refs", responseStore.entries ?? 0],
        ["Events", data.summary.eventCount],
        ["Recent errors", data.summary.recentErrors],
      ].map(([label, value]) => "<div class=\\"panel\\"><div class=\\"muted\\">" + esc(label) + "</div><div class=\\"metric\\">" + esc(value) + "</div></div>").join("");
      document.getElementById("servers").innerHTML = Object.entries(status.servers || {}).map(([name, server]) => {
        const stateClass = server.state === "connected" ? "ok" : "bad";
        return "<tr>" + cell(esc(name)) + cell(esc(server.state), stateClass) + cell(esc(server.transport)) + cell(esc((server.exposedTools ?? 0) + "/" + (server.totalTools ?? 0))) + cell(esc((server.connectDurationMs ?? "") + "ms")) + "</tr>";
      }).join("");
      document.getElementById("events").innerHTML = data.events.slice(-80).reverse().map(event => {
        const ok = event.type === "http_request" ? event.status < 400 : event.success !== false;
        const target = event.type === "tool_call" ? (event.server ? event.server + "__" : "") + (event.targetTool || event.tool) : event.path || "config";
        const detail = event.error || (event.type === "http_request" ? event.method + " " + event.durationMs + "ms" : event.durationMs ? event.durationMs + "ms" : "");
        return "<tr>" + cell(esc(new Date(event.timestamp).toLocaleTimeString())) + cell(esc(event.type)) + cell(esc(target)) + cell(esc(event.status ?? (ok ? "ok" : "error")), ok ? "ok" : "bad") + cell(esc(detail), "muted") + "</tr>";
      }).join("");
    }
    async function refresh() {
      const res = await fetch(dataUrl, { headers: { "Accept": "application/json" } });
      if (res.ok) render(await res.json());
    }
    refresh();
    const stream = new EventSource(eventsUrl);
    stream.onmessage = () => refresh();
    stream.onerror = () => setTimeout(refresh, 1500);
  </script>
</body>
</html>`;
}
