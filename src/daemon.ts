import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MANAGED_MARKER = "callmux-managed-daemon";
const DEFAULT_DAEMON_NAME = "callmux";
const DEFAULT_PORT = 4860;

export type DaemonAction =
  | "install"
  | "uninstall"
  | "start"
  | "stop"
  | "restart"
  | "enable"
  | "disable"
  | "status"
  | "logs";

export type DaemonScope = "user" | "system";
type DaemonKind = "systemd" | "launchd" | "unsupported";

interface DaemonOptions {
  action: DaemonAction;
  configPath: string;
  name?: string;
  port?: number;
  host?: string;
  scope?: DaemonScope;
  binaryPath?: string;
  start?: boolean;
  enable?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

interface DaemonEnvironment {
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  hasSystemctl?: boolean;
}

interface DaemonFilePlan {
  path: string;
  content: string;
}

interface DaemonPlan {
  action: DaemonAction;
  kind: DaemonKind;
  scope: DaemonScope;
  supported: boolean;
  name: string;
  label: string;
  uid?: number;
  serviceFilePath?: string;
  configPath: string;
  port: number;
  host?: string;
  binaryPath: string;
  file?: DaemonFilePlan;
  commands: string[][];
  warnings: string[];
  manualCommand: string;
}

export async function detectDaemonEnvironment(): Promise<DaemonEnvironment> {
  let hasSystemctl: boolean | undefined;
  if (process.platform === "linux") {
    try {
      await execFileAsync("systemctl", ["--version"]);
      hasSystemctl = true;
    } catch {
      hasSystemctl = false;
    }
  }
  return {
    platform: process.platform,
    homeDir: homedir(),
    uid: process.getuid?.(),
    ...(hasSystemctl !== undefined ? { hasSystemctl } : {}),
  };
}

interface DaemonExecutionResult {
  plan: DaemonPlan;
  output: string;
}

function quoteSystemdArg(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function daemonProgramArgs(binaryPath: string): string[] {
  return binaryPath.endsWith(".js") ? [process.execPath, binaryPath] : [binaryPath];
}

function normalizeServiceName(name: string | undefined): string {
  const normalized = (name ?? DEFAULT_DAEMON_NAME).trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("--name must contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function normalizePort(port: number | undefined): number {
  const value = port ?? DEFAULT_PORT;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  return value;
}

function normalizeScope(
  platform: NodeJS.Platform,
  requested: DaemonScope | undefined,
  uid: number | undefined
): DaemonScope {
  if (requested) return requested;
  if (platform === "darwin") return "user";
  if (platform === "linux" && uid === 0) return "system";
  return "user";
}

function systemdArgs(scope: DaemonScope, args: string[]): string[] {
  return scope === "user" ? ["--user", ...args] : args;
}

function serviceFilePath(
  kind: DaemonKind,
  scope: DaemonScope,
  name: string,
  home: string
): string | undefined {
  if (kind === "systemd") {
    return scope === "user"
      ? join(home, ".config", "systemd", "user", `${name}.service`)
      : join("/etc", "systemd", "system", `${name}.service`);
  }
  if (kind === "launchd") {
    return join(home, "Library", "LaunchAgents", `dev.callmux.${name}.plist`);
  }
  return undefined;
}

function renderSystemdUnit(options: {
  name: string;
  scope: DaemonScope;
  configPath: string;
  port: number;
  host?: string;
  binaryPath: string;
}): string {
  const execArgs = [
    ...daemonProgramArgs(options.binaryPath).map(quoteSystemdArg),
    "--config",
    quoteSystemdArg(options.configPath),
    "--listen",
    String(options.port),
    ...(options.host ? ["--host", quoteSystemdArg(options.host)] : []),
  ];

  return [
    `# ${MANAGED_MARKER}`,
    "[Unit]",
    "Description=callmux shared MCP listener",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execArgs.join(" ")}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    `WantedBy=${options.scope === "user" ? "default.target" : "multi-user.target"}`,
    "",
  ].join("\n");
}

function renderLaunchAgent(options: {
  label: string;
  home: string;
  configPath: string;
  port: number;
  host?: string;
  binaryPath: string;
}): string {
  const args = [
    ...daemonProgramArgs(options.binaryPath),
    "--config",
    options.configPath,
    "--listen",
    String(options.port),
    ...(options.host ? ["--host", options.host] : []),
  ];
  const programArguments = args
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    `<dict><!-- ${MANAGED_MARKER} -->`,
    "  <key>Label</key>",
    `  <string>${xmlEscape(options.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${xmlEscape(join(options.home, "Library", "Logs", "callmux.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xmlEscape(join(options.home, "Library", "Logs", "callmux.err.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function commandForAction(plan: Omit<DaemonPlan, "commands">, action: DaemonAction): string[][] {
  if (plan.kind === "systemd") {
    const unit = `${plan.name}.service`;
    switch (action) {
      case "start":
        return [["systemctl", ...systemdArgs(plan.scope, ["start", unit])]];
      case "stop":
        return [["systemctl", ...systemdArgs(plan.scope, ["stop", unit])]];
      case "restart":
        return [["systemctl", ...systemdArgs(plan.scope, ["restart", unit])]];
      case "enable":
        return [["systemctl", ...systemdArgs(plan.scope, ["enable", unit])]];
      case "disable":
        return [["systemctl", ...systemdArgs(plan.scope, ["disable", unit])]];
      case "status":
        return [["systemctl", ...systemdArgs(plan.scope, ["status", unit, "--no-pager", "-l"])]];
      case "logs":
        return [["journalctl", ...systemdArgs(plan.scope, ["-u", unit, "-n", "100", "--no-pager"])]];
      case "uninstall":
        return [["systemctl", ...systemdArgs(plan.scope, ["disable", "--now", unit])]];
      case "install":
        return [];
    }
  }

  if (plan.kind === "launchd") {
    const domain = `gui/${plan.uid ?? 0}`;
    const target = `${domain}/${plan.label}`;
    switch (action) {
      case "start":
        return [["launchctl", "kickstart", "-k", target]];
      case "stop":
        return [["launchctl", "kill", "TERM", target]];
      case "restart":
        return [
          ["launchctl", "kill", "TERM", target],
          ["launchctl", "kickstart", "-k", target],
        ];
      case "enable":
        return [["launchctl", "enable", target]];
      case "disable":
        return [["launchctl", "disable", target]];
      case "status":
        return [["launchctl", "print", target]];
      case "logs":
        return [["tail", "-n", "100", join(dirname(dirname(plan.serviceFilePath ?? homedir())), "Logs", "callmux.err.log")]];
      case "uninstall":
        return [["launchctl", "bootout", domain, plan.serviceFilePath ?? ""]];
      case "install":
        return [];
    }
  }

  return [];
}

export function createDaemonPlan(
  options: DaemonOptions,
  env: DaemonEnvironment = {}
): DaemonPlan {
  const platform = env.platform ?? process.platform;
  const home = env.homeDir ?? homedir();
  const uid = env.uid ?? process.getuid?.();
  const name = normalizeServiceName(options.name);
  const port = normalizePort(options.port);
  const scope = normalizeScope(platform, options.scope, uid);
  const configPath = resolve(options.configPath);
  const rawBinaryPath = options.binaryPath ?? process.argv[1] ?? "callmux";
  const binaryPath = rawBinaryPath.startsWith("/") ? resolve(rawBinaryPath) : rawBinaryPath;
  const warnings: string[] = [];
  const manualCommand = `${daemonProgramArgs(binaryPath).join(" ")} --config ${configPath} --listen ${port}${options.host ? ` --host ${options.host}` : ""}`;

  let kind: DaemonKind = "unsupported";
  if (platform === "linux" && env.hasSystemctl !== false) {
    kind = "systemd";
  } else if (platform === "darwin" && scope === "user") {
    kind = "launchd";
  }

  if (platform === "darwin" && scope === "system") {
    warnings.push("System LaunchDaemons are not managed yet; use a user LaunchAgent or install manually.");
    kind = "unsupported";
  }
  if (platform === "linux" && env.hasSystemctl === false) {
    warnings.push("systemctl was not detected; install manually with the rendered command.");
  }

  const label = kind === "launchd" ? `dev.callmux.${name}` : name;
  const path = serviceFilePath(kind, scope, name, home);
  const basePlan = {
    action: options.action,
    kind,
    scope,
    supported: kind !== "unsupported",
    name,
    label,
    ...(uid !== undefined ? { uid } : {}),
    ...(path ? { serviceFilePath: path } : {}),
    configPath,
    port,
    ...(options.host ? { host: options.host } : {}),
    binaryPath,
    warnings,
    manualCommand,
  };

  let file: DaemonFilePlan | undefined;
  if (options.action === "install" && kind === "systemd") {
    file = {
      path: path!,
      content: renderSystemdUnit({
        name,
        scope,
        configPath,
        port,
        ...(options.host ? { host: options.host } : {}),
        binaryPath,
      }),
    };
  } else if (options.action === "install" && kind === "launchd") {
    file = {
      path: path!,
      content: renderLaunchAgent({
        label,
        home,
        configPath,
        port,
        ...(options.host ? { host: options.host } : {}),
        binaryPath,
      }),
    };
  }

  const commands =
    options.action === "install" && kind === "systemd"
      ? [
          ["systemctl", ...systemdArgs(scope, ["daemon-reload"])],
          ...(options.enable ? [["systemctl", ...systemdArgs(scope, ["enable", `${name}.service`])]] : []),
          ...(options.start ? [["systemctl", ...systemdArgs(scope, ["start", `${name}.service`])]] : []),
        ]
      : options.action === "install" && kind === "launchd"
        ? [
            ["launchctl", "bootstrap", `gui/${uid ?? 0}`, path!],
            ...(options.enable ? [["launchctl", "enable", `gui/${uid ?? 0}/${label}`]] : []),
            ...(options.start ? [["launchctl", "kickstart", "-k", `gui/${uid ?? 0}/${label}`]] : []),
          ]
        : commandForAction(basePlan, options.action);

  return {
    ...basePlan,
    ...(file ? { file } : {}),
    commands,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

export async function executeDaemonPlan(
  plan: DaemonPlan,
  options: { dryRun?: boolean; force?: boolean } = {}
): Promise<DaemonExecutionResult> {
  if (!plan.supported) {
    return {
      plan,
      output: formatDaemonPlan(plan),
    };
  }

  if (options.dryRun) {
    return {
      plan,
      output: formatDaemonPlan(plan),
    };
  }

  const output: string[] = [];

  if (plan.action === "install" && plan.file) {
    const existing = await readIfExists(plan.file.path);
    if (existing && !existing.includes(MANAGED_MARKER) && !options.force) {
      throw new Error(`Refusing to overwrite unmanaged daemon file: ${plan.file.path}`);
    }
    await mkdir(dirname(plan.file.path), { recursive: true });
    await writeFile(plan.file.path, plan.file.content, "utf-8");
    output.push(`Wrote ${plan.file.path}`);
  }

  if (plan.action === "uninstall" && plan.serviceFilePath) {
    if (await pathExists(plan.serviceFilePath)) {
      const existing = await readIfExists(plan.serviceFilePath);
      if (existing && !existing.includes(MANAGED_MARKER) && !options.force) {
        throw new Error(`Refusing to remove unmanaged daemon file: ${plan.serviceFilePath}`);
      }
    }
  }

  for (const command of plan.commands) {
    try {
      const { stdout, stderr } = await execFileAsync(command[0], command.slice(1));
      output.push(`$ ${command.join(" ")}`);
      if (stdout.trim()) output.push(stdout.trim());
      if (stderr.trim()) output.push(stderr.trim());
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      output.push(`$ ${command.join(" ")}`);
      if (err.stdout?.trim()) output.push(err.stdout.trim());
      if (err.stderr?.trim()) output.push(err.stderr.trim());
      throw new Error(output.join("\n") || err.message);
    }
  }

  if (plan.action === "uninstall" && plan.serviceFilePath) {
    const existing = await readIfExists(plan.serviceFilePath);
    if (existing?.includes(MANAGED_MARKER)) {
      await rm(plan.serviceFilePath, { force: true });
      output.push(`Removed ${plan.serviceFilePath}`);
      if (plan.kind === "systemd") {
        const command = ["systemctl", ...systemdArgs(plan.scope, ["daemon-reload"])];
        const { stdout, stderr } = await execFileAsync(command[0], command.slice(1));
        output.push(`$ ${command.join(" ")}`);
        if (stdout.trim()) output.push(stdout.trim());
        if (stderr.trim()) output.push(stderr.trim());
      }
    }
  }

  return {
    plan,
    output: output.join("\n") || formatDaemonPlan(plan),
  };
}

export function formatDaemonPlan(plan: DaemonPlan): string {
  const lines: string[] = [];
  lines.push(`Daemon backend: ${plan.supported ? `${plan.kind} (${plan.scope})` : "unsupported"}`);
  lines.push(`Name: ${plan.name}`);
  lines.push(`Config: ${plan.configPath}`);
  lines.push(`Listen: ${plan.host ?? "127.0.0.1"}:${plan.port}`);
  if (plan.serviceFilePath) lines.push(`Service file: ${plan.serviceFilePath}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  if (plan.file) {
    lines.push("");
    lines.push(`Would write ${plan.file.path}:`);
    lines.push(plan.file.content.trimEnd());
  }
  if (plan.commands.length > 0) {
    lines.push("");
    lines.push("Commands:");
    for (const command of plan.commands) lines.push(`  ${command.join(" ")}`);
  }
  if (!plan.supported) {
    lines.push("");
    lines.push("Manual command:");
    lines.push(`  ${plan.manualCommand}`);
  }
  return lines.join("\n");
}
