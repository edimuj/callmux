import type { MetricsConfig } from "./types.js";

const DEFAULT_METRICS_PATH = "/metrics";

interface CounterMap {
  [labelKey: string]: number;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

function labelKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

function parseLabelKey(value: string): Record<string, string> {
  if (value.length === 0) return {};
  const labels: Record<string, string> = {};
  for (const part of value.split("|")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    labels[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return labels;
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  const pairs = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${pairs.join(",")}}`;
}

function normalizeConfig(config: MetricsConfig | undefined): Required<MetricsConfig> {
  return {
    enabled: config?.enabled ?? true,
    path: normalizePath(config?.path ?? DEFAULT_METRICS_PATH),
    allowUnauthenticated: config?.allowUnauthenticated ?? false,
  };
}

export class PrometheusMetrics {
  private config: Required<MetricsConfig>;
  private inflightRequests = 0;
  private requestsTotal: CounterMap = {};
  private requestDurationSecondsSum: CounterMap = {};
  private requestDurationSecondsCount: CounterMap = {};

  constructor(config: MetricsConfig | undefined) {
    this.config = normalizeConfig(config);
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getPath(): string {
    return this.config.path;
  }

  allowUnauthenticated(): boolean {
    return this.config.allowUnauthenticated;
  }

  onRequestStart(): void {
    if (!this.config.enabled) return;
    this.inflightRequests += 1;
  }

  onRequestComplete(input: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
  }): void {
    if (!this.config.enabled) return;
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);

    const labels = {
      method: input.method.toUpperCase(),
      path: input.path,
      status: String(input.status),
    };
    const key = labelKey(labels);
    this.requestsTotal[key] = (this.requestsTotal[key] ?? 0) + 1;

    const durationSeconds = input.durationMs / 1000;
    this.requestDurationSecondsSum[key] =
      (this.requestDurationSecondsSum[key] ?? 0) + durationSeconds;
    this.requestDurationSecondsCount[key] =
      (this.requestDurationSecondsCount[key] ?? 0) + 1;
  }

  renderPrometheusText(): string {
    const lines: string[] = [];

    lines.push("# HELP callmux_http_inflight_requests Current in-flight HTTP requests");
    lines.push("# TYPE callmux_http_inflight_requests gauge");
    lines.push(`callmux_http_inflight_requests ${this.inflightRequests}`);

    lines.push("# HELP callmux_http_requests_total Total HTTP requests by method/path/status");
    lines.push("# TYPE callmux_http_requests_total counter");
    for (const [key, value] of Object.entries(this.requestsTotal)) {
      lines.push(
        `callmux_http_requests_total${formatLabels(parseLabelKey(key))} ${value}`
      );
    }

    lines.push(
      "# HELP callmux_http_request_duration_seconds_sum Total request duration seconds by method/path/status"
    );
    lines.push("# TYPE callmux_http_request_duration_seconds_sum counter");
    for (const [key, value] of Object.entries(this.requestDurationSecondsSum)) {
      lines.push(
        `callmux_http_request_duration_seconds_sum${formatLabels(
          parseLabelKey(key)
        )} ${value}`
      );
    }

    lines.push(
      "# HELP callmux_http_request_duration_seconds_count Total completed requests used for duration aggregation"
    );
    lines.push("# TYPE callmux_http_request_duration_seconds_count counter");
    for (const [key, value] of Object.entries(this.requestDurationSecondsCount)) {
      lines.push(
        `callmux_http_request_duration_seconds_count${formatLabels(
          parseLabelKey(key)
        )} ${value}`
      );
    }

    return `${lines.join("\n")}\n`;
  }
}
