import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { UpstreamManager } from "./upstream.js";
import { formatCommandForDisplay, redactUrl } from "./redact.js";
import { isHttpServerConfig } from "./types.js";
import type { CallmuxConfig, ConfigFormat, ServerConfig } from "./types.js";
import {
  isPlaintextBearerTokenConfig,
  parseScryptTokenHash,
} from "./auth.js";

type DoctorReportFormat = ConfigFormat | "missing" | "invalid";

interface DoctorServerReport {
  name: string;
  command: string;
  status: "ok" | "error";
  executablePath?: string;
  toolCount?: number;
  issues: string[];
}

interface DoctorReport {
  ok: boolean;
  configPath: string;
  format: DoctorReportFormat;
  serverCount: number;
  cacheTtlSeconds: number;
  maxConcurrency: number;
  issues: string[];
  servers: DoctorServerReport[];
}

interface ListenerDoctorReport {
  ok: boolean;
  url: string;
  mcpUrl: string;
  healthUrl: string;
  cwd?: string;
  health?: {
    status: number;
    ok: boolean;
    body?: unknown;
  };
  initialize?: {
    status: number;
    ok: boolean;
    sessionId?: string;
    body?: unknown;
  };
  status?: {
    ok: boolean;
    body?: unknown;
  };
  issues: string[];
}

interface ListenerDoctorOptions {
  url: string;
  cwd?: string;
  headers?: Record<string, string>;
}

interface ServerInspectionReport {
  name: string;
  command: string;
  status: "ok" | "error";
  executablePath?: string;
  tools: string[];
  issues: string[];
}

interface ServerTestReport extends ServerInspectionReport {
  requestedTool?: string;
  requestedToolFound?: boolean;
}

const WINDOWS_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat", ".com"];
const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(command: string): Promise<string | undefined> {
  const candidates: string[] = [];

  if (command.includes("/") || command.includes("\\")) {
    candidates.push(isAbsolute(command) ? command : resolve(command));
  } else {
    const pathParts = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const base of pathParts) {
      candidates.push(join(base, command));
      if (process.platform === "win32") {
        for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
          candidates.push(join(base, `${command}${ext}`));
        }
      }
    }
  }

  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function probeServer(
  name: string,
  config: ServerConfig
): Promise<{ tools?: string[]; issue?: string }> {
  const upstream = new UpstreamManager();

  try {
    const [connection] = await upstream.connect({ [name]: config });
    return {
      tools: connection?.tools.map((tool) => tool.name).sort() ?? [],
    };
  } catch (error) {
    return {
      issue: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await upstream.close();
  }
}

async function inspectServer(
  name: string,
  config: ServerConfig
): Promise<ServerInspectionReport> {
  const issues: string[] = [];
  let tools: string[] = [];
  let executablePath: string | undefined;

  if (isHttpServerConfig(config)) {
    const probe = await probeServer(name, config);
    if (probe.issue) {
      issues.push(`connect failed: ${probe.issue}`);
    } else {
      tools = probe.tools ?? [];
    }

    return {
      name,
      command: redactUrl(config.url),
      status: issues.length > 0 ? "error" : "ok",
      tools,
      issues,
    };
  }

  executablePath = await resolveExecutable(config.command);

  if (!executablePath) {
    issues.push(`command "${config.command}" was not found on PATH`);
  } else {
    const probe = await probeServer(name, config);
    if (probe.issue) {
      issues.push(`connect/list-tools failed: ${probe.issue}`);
    } else {
      tools = probe.tools ?? [];
    }
  }

  return {
    name,
    command: formatCommandForDisplay(config.command, config.args),
    status: issues.length > 0 ? "error" : "ok",
    ...(executablePath ? { executablePath } : {}),
    tools,
    issues,
  };
}

export async function runServerTest(
  name: string,
  config: ServerConfig,
  requestedTool?: string
): Promise<ServerTestReport> {
  const report = await inspectServer(name, config);

  if (!requestedTool) {
    return report;
  }

  const requestedToolFound = report.tools.includes(requestedTool);
  const issues = [...report.issues];

  if (report.status === "ok" && !requestedToolFound) {
    issues.push(`tool "${requestedTool}" was not exposed by "${name}"`);
  }

  return {
    ...report,
    status: issues.length > 0 ? "error" : "ok",
    issues,
    requestedTool,
    requestedToolFound,
  };
}

export async function runDoctor(
  configPath: string,
  loaded: { config: CallmuxConfig; format: ConfigFormat }
): Promise<DoctorReport> {
  const servers = await Promise.all(
    Object.entries(loaded.config.servers).map(async ([name, server]) => {
      const report = await inspectServer(name, server);
      return {
        name: report.name,
        command: report.command,
        status: report.status,
        ...(report.executablePath ? { executablePath: report.executablePath } : {}),
        toolCount: report.tools.length,
        issues: report.issues,
      } satisfies DoctorServerReport;
    })
  );

  const issues = [
    ...collectSecurityIssues(loaded.config),
    ...servers.flatMap((server) =>
    server.issues.map((issue) => `${server.name}: ${issue}`)
  ),
  ];

  return {
    ok: issues.length === 0,
    configPath,
    format: loaded.format,
    serverCount: Object.keys(loaded.config.servers).length,
    cacheTtlSeconds: loaded.config.cacheTtlSeconds ?? 0,
    maxConcurrency: loaded.config.maxConcurrency ?? 20,
    issues,
    servers,
  };
}

function listenerUrls(input: string): { mcpUrl: string; healthUrl: string } {
  const mcp = new URL(input);
  if (mcp.pathname === "" || mcp.pathname === "/") {
    mcp.pathname = "/mcp";
  }
  const health = new URL(mcp.href);
  health.pathname = "/health";
  health.search = "";
  health.hash = "";
  return { mcpUrl: mcp.href, healthUrl: health.href };
}

async function parseHttpBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  if (contentType.includes("text/event-stream")) {
    const text = await response.text();
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: "));
    return dataLine ? JSON.parse(dataLine.slice(6)) : text;
  }
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractToolPayload(body: unknown): unknown {
  if (!isRecord(body)) return undefined;
  const result = body.result;
  if (!isRecord(result)) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is { type: string; text: string } =>
      isRecord(item) && item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function hasJsonRpcError(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body.error)) return undefined;
  const message = body.error.message;
  return typeof message === "string" ? message : "JSON-RPC error";
}

export async function runListenerDoctor(
  options: ListenerDoctorOptions
): Promise<ListenerDoctorReport> {
  const { mcpUrl, healthUrl } = listenerUrls(options.url);
  const issues: string[] = [];
  const baseHeaders = options.headers ?? {};
  const mcpHeaders = {
    ...baseHeaders,
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT_HEADER,
    ...(options.cwd ? { "x-callmux-cwd": options.cwd } : {}),
  };

  let health: ListenerDoctorReport["health"];
  try {
    const response = await fetch(healthUrl, { headers: baseHeaders });
    const body = await parseHttpBody(response);
    health = { status: response.status, ok: response.ok, body };
    if (!response.ok) {
      issues.push(`/health returned HTTP ${response.status}`);
    }
  } catch (error) {
    issues.push(`/health failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  let initialize: ListenerDoctorReport["initialize"];
  let status: ListenerDoctorReport["status"];

  try {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "callmux-doctor", version: "1.0" },
        },
        id: 1,
      }),
    });
    const body = await parseHttpBody(response);
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    const jsonRpcError = hasJsonRpcError(body);
    initialize = {
      status: response.status,
      ok: response.ok && !jsonRpcError && Boolean(sessionId),
      ...(sessionId ? { sessionId } : {}),
      body,
    };
    if (!response.ok) {
      issues.push(`/mcp initialize returned HTTP ${response.status}`);
    } else if (jsonRpcError) {
      issues.push(`/mcp initialize failed: ${jsonRpcError}`);
    } else if (!sessionId) {
      issues.push(`/mcp initialize did not return mcp-session-id`);
    }

    if (sessionId) {
      const statusResponse = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          ...mcpHeaders,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "callmux_status",
            arguments: { sessions: true, recommendations: false },
          },
          id: 2,
        }),
      });
      const statusBody = await parseHttpBody(statusResponse);
      const statusPayload = extractToolPayload(statusBody);
      const jsonRpcStatusError = hasJsonRpcError(statusBody);
      status = {
        ok: statusResponse.ok && !jsonRpcStatusError,
        body: statusPayload ?? statusBody,
      };
      if (!statusResponse.ok) {
        issues.push(`callmux_status returned HTTP ${statusResponse.status}`);
      } else if (jsonRpcStatusError) {
        issues.push(`callmux_status failed: ${jsonRpcStatusError}`);
      }

      if (options.cwd && isRecord(statusPayload)) {
        const listener = statusPayload.listener;
        const sessions = isRecord(listener) && Array.isArray(listener.sessions)
          ? listener.sessions
          : [];
        const matched = sessions.some((session) =>
          isRecord(session) && session.id === sessionId && session.cwd === options.cwd
        );
        if (!matched) {
          issues.push(`session cwd diagnostics did not report "${options.cwd}"`);
        }
      }
    }
  } catch (error) {
    issues.push(`/mcp smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ok: issues.length === 0,
    url: options.url,
    mcpUrl,
    healthUrl,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(health ? { health } : {}),
    ...(initialize ? { initialize } : {}),
    ...(status ? { status } : {}),
    issues,
  };
}

function collectSecurityIssues(config: CallmuxConfig): string[] {
  const issues: string[] = [];

  if (config.allowInsecureRemoteListener) {
    issues.push(
      "allowInsecureRemoteListener is enabled (remote listener startup can bypass auth)"
    );
  }

  const auth = config.auth;
  if (config.authorization && !auth) {
    issues.push(
      "authorization is configured without auth; all tool calls will be denied (no principal context)"
    );
  }
  if (!auth) return issues;

  if (auth.mode === "oidc_jwt") {
    const normalizedIssuer = auth.issuer.trim();
    if (!normalizedIssuer.startsWith("https://")) {
      issues.push(`auth.issuer should use https:// in production ("${auth.issuer}")`);
    }

    if (!isLocalUrl(auth.jwksUri) && !auth.jwksUri.startsWith("https://")) {
      issues.push(`auth.jwksUri should use https:// in production ("${auth.jwksUri}")`);
    }

    if ((auth.algorithms ?? []).includes("none")) {
      issues.push(`auth.algorithms must not include "none"`);
    }

    return issues;
  }

  const tokenIds = new Set<string>();
  for (const token of auth.tokens) {
    if (tokenIds.has(token.id)) {
      issues.push(`auth.tokens contains duplicate token id "${token.id}"`);
    }
    tokenIds.add(token.id);

    if (isPlaintextBearerTokenConfig(token)) {
      issues.push(
        `auth.tokens["${token.id}"] uses plaintext token; migrate to hash`
      );
      continue;
    }

    if (!("hash" in token)) {
      issues.push(
        `auth.tokens["${token.id}"] should resolve to a hash/token during config load`
      );
      continue;
    }

    if (!parseScryptTokenHash(token.hash)) {
      issues.push(`auth.tokens["${token.id}"] has invalid scrypt hash format`);
    }
  }

  return issues;
}

function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function createDoctorFailureReport(
  configPath: string,
  format: Exclude<DoctorReportFormat, ConfigFormat>,
  issue: string
): DoctorReport {
  return {
    ok: false,
    configPath,
    format,
    serverCount: 0,
    cacheTtlSeconds: 0,
    maxConcurrency: 0,
    issues: [issue],
    servers: [],
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Status: ${report.ok ? "ok" : "issues found"}`,
    `Config: ${report.configPath}`,
    `Format: ${report.format}`,
    `Servers: ${report.serverCount}`,
    `Cache TTL: ${report.cacheTtlSeconds}s`,
    `Max concurrency: ${report.maxConcurrency}`,
  ];

  if (report.servers.length === 0) {
    if (report.issues.length > 0) {
      lines.push("");
      for (const issue of report.issues) {
        lines.push(`Issue: ${issue}`);
      }
    } else {
      lines.push("", "No downstream servers configured.");
    }
    return lines.join("\n");
  }

  for (const server of report.servers) {
    lines.push("", `[${server.status}] ${server.name}`);
    lines.push(`  command: ${server.command}`);
    if (server.executablePath) {
      lines.push(`  executable: ${server.executablePath}`);
    }
    if (server.toolCount !== undefined) {
      lines.push(`  tools: ${server.toolCount}`);
    }
    for (const issue of server.issues) {
      lines.push(`  issue: ${issue}`);
    }
  }

  return lines.join("\n");
}

export function formatListenerDoctorReport(report: ListenerDoctorReport): string {
  const lines = [
    `Status: ${report.ok ? "ok" : "issues found"}`,
    `Listener: ${report.url}`,
    `Health URL: ${report.healthUrl}`,
    `MCP URL: ${report.mcpUrl}`,
  ];

  if (report.cwd) {
    lines.push(`CWD: ${report.cwd}`);
  }

  if (report.health) {
    lines.push(`Health: HTTP ${report.health.status}`);
  }

  if (report.initialize) {
    lines.push(
      `Initialize: HTTP ${report.initialize.status}${report.initialize.sessionId ? ` session=${report.initialize.sessionId}` : ""}`
    );
  }

  if (report.status) {
    lines.push(`Status tool: ${report.status.ok ? "ok" : "issues found"}`);
  }

  for (const issue of report.issues) {
    lines.push(`Issue: ${issue}`);
  }

  return lines.join("\n");
}

export function formatServerTestReport(report: ServerTestReport): string {
  const lines = [
    `Status: ${report.status === "ok" ? "ok" : "issues found"}`,
    `Server: ${report.name}`,
    `Command: ${report.command}`,
  ];

  if (report.executablePath) {
    lines.push(`Executable: ${report.executablePath}`);
  }

  lines.push(`Tools: ${report.tools.length}`);

  if (report.requestedTool) {
    lines.push(
      `Requested tool: ${report.requestedTool} (${report.requestedToolFound ? "found" : "missing"})`
    );
  }

  if (report.tools.length > 0) {
    lines.push("", ...report.tools.map((tool) => `- ${tool}`));
  }

  if (report.issues.length > 0) {
    lines.push("", ...report.issues.map((issue) => `Issue: ${issue}`));
  }

  return lines.join("\n");
}

export function formatServerTestReports(reports: ServerTestReport[]): string {
  if (reports.length === 0) {
    return "No downstream servers configured.";
  }

  const okCount = reports.filter((report) => report.status === "ok").length;
  const lines = [
    `Status: ${okCount === reports.length ? "ok" : "issues found"}`,
    `Servers tested: ${reports.length}`,
    `Passed: ${okCount}`,
    `Failed: ${reports.length - okCount}`,
    "",
    reports.map((report) => formatServerTestReport(report)).join("\n\n"),
  ];

  return lines.join("\n");
}
