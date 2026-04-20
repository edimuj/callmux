import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { UpstreamManager } from "./upstream.js";
import { isHttpServerConfig } from "./types.js";
import type { CallmuxConfig, ConfigFormat, ServerConfig } from "./types.js";

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
      command: config.url,
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
    command: [config.command, ...(config.args ?? [])].join(" "),
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

  const issues = servers.flatMap((server) =>
    server.issues.map((issue) => `${server.name}: ${issue}`)
  );

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
