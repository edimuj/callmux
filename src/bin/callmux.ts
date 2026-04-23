#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallmuxProxy } from "../proxy.js";
import {
  attachClaudeConfig,
  attachCodexConfig,
  detachClaudeConfig,
  detachCodexConfig,
  formatClientStatus,
  getDefaultClientConfigPath,
  getClaudeConfigStatus,
  getCodexConfigStatus,
  renderClientAttachPreview,
  type ClientKind,
} from "../client-config.js";
import {
  loadConfig,
  configFromArgs,
  findDefaultConfig,
  getDefaultConfigPath,
  loadManagedConfig,
  loadConfigWithMetadata,
  saveManagedConfig,
} from "../config.js";
import {
  applyServerMutation,
  createEmptyConfig,
  formatServerList,
  parseServerMutationArgs,
  parseServerDefinitionArgs,
  renderClientSnippet,
  serializeServers,
} from "../cli.js";
import {
  createDoctorFailureReport,
  formatDoctorReport,
  formatServerTestReports,
  formatServerTestReport,
  runDoctor,
  runServerTest,
} from "../doctor.js";
import { runSetup } from "../setup.js";
import * as p from "@clack/prompts";
import { UpstreamManager } from "../upstream.js";
import type { ServerConfig } from "../types.js";

const HELP = `
callmux — Multiplexer for MCP tool calls

Wraps any MCP server and adds parallel execution, batching, caching,
and pipelining. Claude (or any MCP client) connects to callmux, which
proxies to downstream servers and exposes meta-tools alongside them.

Usage:
  callmux                                    Auto-detect config file
  callmux --config <path>                    Explicit config file
  callmux [options] -- <command> [args...]   Single-server mode
  callmux setup [--config <path>]            Interactive setup wizard
  callmux init [--config <path>] [--force]
  callmux doctor [--config <path>] [--json]
  callmux server add <name> [options] -- <command> [args...]
  callmux server set <name> [options] [-- <command> [args...]]
  callmux server edit <name> [options] [-- <command> [args...]]
  callmux server test <name> [--tool <tool>] [--json]
  callmux server test --all [--tool <tool>] [--json]
  callmux server remove <name> [--config <path>]
  callmux server list [--config <path>] [--json]
  callmux client print <claude|codex> [--config <path>] [--name <id>]
  callmux client attach <claude|codex> [--config <path>] [--name <id>] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client detach <claude|codex> [--name <id>] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client status [claude|codex] [--config <path>] [--name <id>] [--file <path>] [--json]

Options:
  --config <path>       Path to callmux config or .mcp.json file
  --tools <list>        Comma-separated tool whitelist (single-server mode)
  --env KEY=VALUE       Environment variable for downstream server (repeatable)
  --cache <seconds>     Cache TTL for read operations (default: 0 = off)
  --cache-max-entries <n> Max cache entries before oldest entries are evicted (default: 1000)
  --cache-allow <list>  Comma-separated cache allowlist for single-server mode
  --cache-deny <list>   Comma-separated cache denylist for single-server mode
  --concurrency <n>     Max parallel calls (default: 20)
  --connect-timeout <ms> Timeout for downstream startup connect/list-tools (default: 30000)
  --call-timeout <ms>   Timeout for downstream tool calls (default: 30000)
  --strict-startup      Fail startup if any downstream server fails (default: degraded)
  --help, -h            Show this help
  --version, -v         Show version

Server Add Options:
  --tools <list>        Comma-separated downstream tool whitelist
  --env KEY=VALUE       Environment variable for the downstream server (repeatable)
  --cwd <path>          Working directory for the downstream server
  --cache-allow <list>  Per-server cache allowlist
  --cache-deny <list>   Per-server cache denylist

Server Set/Edit Options:
  --tools <list>        Replace downstream tool whitelist
  --add-tool <name>     Add one exposed tool (repeatable)
  --remove-tool <name>  Remove one exposed tool (repeatable)
  --clear-tools         Remove any explicit tool whitelist
  --env KEY=VALUE       Set one environment variable (repeatable)
  --remove-env <key>    Remove one environment variable (repeatable)
  --clear-env           Remove all environment variables
  --cwd <path>          Replace working directory
  --clear-cwd           Remove explicit working directory
  --cache-allow <list>  Replace per-server cache allowlist
  --cache-deny <list>   Replace per-server cache denylist
  --clear-cache-policy  Remove per-server cache policy

Config auto-discovery (checked in order):
  1. $CALLMUX_CONFIG environment variable
  2. ~/.config/callmux/config.json

Config file format:
  {
    "$schema": "https://raw.githubusercontent.com/edimuj/callmux/main/schema.json",
    "servers": {
      "github": {
        "command": "gh-mcp",
        "args": ["--token", "..."],
        "tools": ["create_issue", "search"],
        "cachePolicy": { "allowTools": ["search"] }
      },
      "jira":   { "command": "jira-mcp" }
    },
    "cacheTtlSeconds": 60,
    "cachePolicy": { "denyTools": ["create_*"] },
    "maxConcurrency": 20,
    "maxCacheEntries": 1000,
    "connectTimeoutMs": 30000,
    "callTimeoutMs": 30000,
    "strictStartup": false
  }

Also accepts MCP-compatible format:
  { "mcpServers": { ... } }

Examples:
  callmux --config callmux.json
  callmux --cache 60 -- node my-mcp-server.js
  callmux --cache 60 --cache-allow get_*,list_* -- npx -y @modelcontextprotocol/server-github
  callmux -- npx -y @modelcontextprotocol/server-github
  callmux --tools create_issue,search -- npx -y @modelcontextprotocol/server-github
  callmux init
  callmux server add github --tools get_issue,list_issues -- npx -y @modelcontextprotocol/server-github
  callmux server set github --add-tool search_repositories --cache-deny create_*
  callmux server list
  callmux server test --all
  callmux server test github --tool get_issue
  callmux doctor
  callmux client print codex
  callmux client status
  callmux client attach codex
  callmux client attach codex --yes
  callmux client print claude --name github

Meta-tools exposed:
  callmux_parallel      Execute N tool calls concurrently
  callmux_batch         Apply one tool across many items
  callmux_pipeline      Chain tool calls with output mapping
  callmux_cache_clear   Clear result cache

See https://github.com/edimuj/callmux for full documentation.
`.trim();

function extractConfigPath(args: string[]): {
  remainingArgs: string[];
  configPath?: string;
} {
  const remainingArgs: string[] = [];
  let configPath: string | undefined;
  const dashDash = args.indexOf("--");
  const optionsLimit = dashDash === -1 ? args.length : dashDash;

  for (let i = 0; i < args.length; i++) {
    if (i < optionsLimit && args[i] === "--config") {
      if (i + 1 >= optionsLimit) {
        throw new Error("Missing value for --config");
      }
      configPath = args[++i];
      continue;
    }
    remainingArgs.push(args[i]);
  }

  return { remainingArgs, configPath };
}

function extractFlag(
  args: string[],
  flag: string
): { remainingArgs: string[]; present: boolean } {
  const remainingArgs: string[] = [];
  let present = false;
  const dashDash = args.indexOf("--");
  const optionsLimit = dashDash === -1 ? args.length : dashDash;

  for (let i = 0; i < args.length; i++) {
    if (i < optionsLimit && args[i] === flag) {
      present = true;
      continue;
    }
    remainingArgs.push(args[i]);
  }

  return { remainingArgs, present };
}

async function readTextFileIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function loadOrCreateManagedConfig(configPath: string) {
  return (await loadManagedConfig(configPath)) ?? createEmptyConfig();
}

async function handleInit(configPath: string, force: boolean): Promise<void> {
  const existing = await loadManagedConfig(configPath);
  if (existing && !force) {
    throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
  }

  await saveManagedConfig(configPath, createEmptyConfig());
  console.log(`Initialized callmux config at ${configPath}`);
}

async function handleServerCommand(
  args: string[],
  configPath: string
): Promise<void> {
  const action = args[0];

  if (action === "list") {
    const extracted = extractFlag(args.slice(1), "--json");
    if (extracted.remainingArgs.length > 0) {
      throw new Error("Usage: callmux server list [--json]");
    }
    const config = await loadOrCreateManagedConfig(configPath);
    if (extracted.present) {
      console.log(JSON.stringify({ servers: serializeServers(config) }, null, 2));
    } else {
      console.log(formatServerList(config));
    }
    return;
  }

  if (action === "add") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: callmux server add <name> [options] -- <command> [args...]");
    }

    const extracted = extractFlag(args.slice(2), "--json");
    const config = await loadOrCreateManagedConfig(configPath);
    const serverDef = parseServerDefinitionArgs(extracted.remainingArgs);

    if (!serverDef.tools && !extracted.present && process.stdout.isTTY) {
      const discovered = await discoverServerTools(name, serverDef);
      if (discovered) {
        serverDef.tools = discovered;
      }
    }

    config.servers[name] = serverDef;
    await saveManagedConfig(configPath, config);
    if (extracted.present) {
      console.log(
        JSON.stringify(
          {
            action: "added",
            configPath,
            server: serializeServers({
              ...config,
              servers: { [name]: config.servers[name] },
            })[0],
          },
          null,
          2
        )
      );
    } else {
      console.log(`Added server "${name}" to ${configPath}`);
    }
    return;
  }

  if (action === "set" || action === "edit") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: callmux server set <name> [options] [-- <command> [args...]]");
    }

    const extracted = extractFlag(args.slice(2), "--json");
    const config = await loadManagedConfig(configPath);
    if (!config || !config.servers[name]) {
      throw new Error(`Server "${name}" not found in ${configPath}`);
    }

    const mutation = parseServerMutationArgs(extracted.remainingArgs);
    config.servers[name] = applyServerMutation(config.servers[name], mutation);
    await saveManagedConfig(configPath, config);
    if (extracted.present) {
      console.log(
        JSON.stringify(
          {
            action: "updated",
            configPath,
            server: serializeServers({
              ...config,
              servers: { [name]: config.servers[name] },
            })[0],
          },
          null,
          2
        )
      );
    } else {
      console.log(`Updated server "${name}" in ${configPath}`);
    }
    return;
  }

  if (action === "test") {
    let requestedTool: string | undefined;
    let json = false;
    let all = false;
    let name: string | undefined;

    if (args[1] === "--all") {
      all = true;
    } else {
      name = args[1];
    }

    if (!all && !name) {
      throw new Error("Usage: callmux server test <name>|--all [--tool <tool>] [--json]");
    }

    for (let i = all ? 2 : 2; i < args.length; i++) {
      if (args[i] === "--tool" && i + 1 < args.length) {
        requestedTool = args[++i];
      } else if (args[i] === "--json") {
        json = true;
      } else {
        throw new Error(`Unknown server test option "${args[i]}"`);
      }
    }

    const config = await loadManagedConfig(configPath);
    if (!config) {
      throw new Error(`No native callmux config found at ${configPath}`);
    }

    if (!all && name && !config.servers[name]) {
      throw new Error(`Server "${name}" not found in ${configPath}`);
    }

    const reports = all
      ? await Promise.all(
          Object.entries(config.servers).map(([serverName, server]) =>
            runServerTest(serverName, server, requestedTool)
          )
        )
      : [await runServerTest(name!, config.servers[name!], requestedTool)];

    if (json) {
      console.log(
        JSON.stringify(
          all
            ? {
                ok: reports.every((report) => report.status === "ok"),
                serverCount: reports.length,
                reports,
              }
            : reports[0],
          null,
          2
        )
      );
    } else {
      console.log(all ? formatServerTestReports(reports) : formatServerTestReport(reports[0]));
    }
    if (reports.some((report) => report.status !== "ok")) {
      process.exitCode = 1;
    }
    return;
  }

  if (action === "remove") {
    const name = args[1];
    if (!name) {
      throw new Error("Usage: callmux server remove <name>");
    }

    const extracted = extractFlag(args.slice(2), "--json");
    if (extracted.remainingArgs.length > 0) {
      throw new Error("Usage: callmux server remove <name> [--json]");
    }
    const config = await loadManagedConfig(configPath);
    if (!config || !config.servers[name]) {
      throw new Error(`Server "${name}" not found in ${configPath}`);
    }

    delete config.servers[name];
    await saveManagedConfig(configPath, config);
    if (extracted.present) {
      console.log(JSON.stringify({ action: "removed", configPath, serverName: name }, null, 2));
    } else {
      console.log(`Removed server "${name}" from ${configPath}`);
    }
    return;
  }

  throw new Error("Usage: callmux server <add|set|edit|test|remove|list> ...");
}

function validateClientKind(value: string | undefined): ClientKind {
  if (value !== "claude" && value !== "codex") {
    throw new Error('Usage: callmux client <print|attach|detach> <claude|codex> [...]');
  }
  return value;
}

async function handleClientMutation(
  action: "attach" | "detach",
  client: ClientKind,
  args: string[],
  configPath: string
): Promise<void> {
  let name = "callmux";
  let filePath = getDefaultClientConfigPath(client);
  let yes = false;
  let dryRun = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (args[i] === "--yes") {
      yes = true;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown client ${action} option "${args[i]}"`);
    }
  }

  const source = await readTextFileIfExists(filePath);
  const mutation =
    client === "claude"
      ? action === "attach"
        ? attachClaudeConfig({ source, configPath, serverName: name })
        : detachClaudeConfig({ source, serverName: name })
      : action === "attach"
        ? attachCodexConfig({ source, configPath, serverName: name })
        : detachCodexConfig({ source, serverName: name });
  const shouldWrite = yes && !dryRun;
  const preview =
    action === "attach"
      ? renderClientAttachPreview(client, {
          configPath,
          serverName: name,
        })
      : client === "claude"
        ? `Remove mcpServers.${name}`
        : `Remove CALLMUX-managed [mcp_servers.${name}] block`;

  if (shouldWrite) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, mutation.content, "utf-8");
  }

  const payload = {
    action,
    client,
    path: filePath,
    serverName: name,
    changed: mutation.changed,
    wrote: shouldWrite,
    dryRun: !shouldWrite,
    ...(mutation.changed ? { preview } : {}),
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!mutation.changed) {
    console.log(`No changes needed for "${name}" in ${filePath}`);
    return;
  }

  if (!shouldWrite) {
    console.log(`Preview only for ${client} at ${filePath}. Re-run with --yes to write.`);
    console.log("");
    console.log(preview);
    return;
  }

  console.log(`${action === "attach" ? "Attached" : "Detached"} "${name}" ${action === "attach" ? "in" : "from"} ${filePath}`);
}

async function handleClientCommand(
  args: string[],
  configPath: string
): Promise<void> {
  const action = args[0];
  if (action === "attach" || action === "detach") {
    const client = validateClientKind(args[1]);
    await handleClientMutation(action, client, args.slice(2), configPath);
    return;
  }

  if (action === "status") {
    let client: ClientKind | undefined;
    let name = "callmux";
    let filePath: string | undefined;
    let json = false;

    if (args[1] === "claude" || args[1] === "codex") {
      client = args[1];
    }

    for (let i = client ? 2 : 1; i < args.length; i++) {
      if (args[i] === "--name" && i + 1 < args.length) {
        name = args[++i];
      } else if (args[i] === "--file" && i + 1 < args.length) {
        filePath = args[++i];
      } else if (args[i] === "--json") {
        json = true;
      } else {
        throw new Error(`Unknown client status option "${args[i]}"`);
      }
    }

    if (!client && filePath) {
      throw new Error("Usage: callmux client status <claude|codex> [--file <path>] [--name <id>] [--json]");
    }

    const clients = client ? [client] : (["claude", "codex"] as ClientKind[]);
    const statuses = await Promise.all(
      clients.map(async (kind) => {
        const path = filePath ?? getDefaultClientConfigPath(kind);
        const source = await readTextFileIfExists(path);
        const status =
          kind === "claude"
            ? getClaudeConfigStatus({ source, configPath, serverName: name })
            : getCodexConfigStatus({ source, configPath, serverName: name });
        return { ...status, path };
      })
    );

    if (json) {
      console.log(JSON.stringify(client ? statuses[0] : { statuses }, null, 2));
    } else {
      console.log(statuses.map((status) => formatClientStatus(status)).join("\n\n"));
    }
    return;
  }

  if (action !== "print") {
    throw new Error("Usage: callmux client <print|attach|detach|status> <claude|codex> [...]");
  }

  const client = validateClientKind(args[1]);
  let name = "callmux";
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else {
      throw new Error(`Unknown client print option "${args[i]}"`);
    }
  }

  console.log(
    renderClientSnippet(client, {
      configPath,
      serverName: name,
    })
  );
}

async function handleDoctorCommand(
  args: string[],
  configPath: string
): Promise<void> {
  let json = false;

  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown doctor option "${arg}"`);
    }
  }

  let report;

  try {
    const loaded = await loadConfigWithMetadata(configPath);
    report = await runDoctor(configPath, loaded);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? createDoctorFailureReport(
            configPath,
            "missing",
            `config file not found: ${configPath}`
          )
        : createDoctorFailureReport(configPath, "invalid", message);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }

  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function discoverServerTools(
  name: string,
  config: ServerConfig
): Promise<string[] | undefined> {
  const s = p.spinner();
  s.start(`Probing ${name} for available tools...`);

  const upstream = new UpstreamManager();
  try {
    const [connection] = await upstream.connect({ [name]: config });
    const tools = connection?.tools.map((t) => t.name).sort() ?? [];
    s.stop(`${name}: found ${tools.length} tool${tools.length === 1 ? "" : "s"}`);

    if (tools.length === 0) return undefined;

    const choice = await p.select({
      message: `Expose all ${tools.length} tools, or pick individually?`,
      options: [
        { value: "all", label: `All ${tools.length} tools`, hint: tools.slice(0, 5).join(", ") + (tools.length > 5 ? "..." : "") },
        { value: "pick", label: "Pick individually" },
      ],
    });

    if (p.isCancel(choice) || choice === "all") return undefined;

    const picked = await p.multiselect({
      message: `Select tools from ${name}:`,
      options: tools.map((t) => ({ value: t, label: t })),
      required: true,
    });

    if (p.isCancel(picked)) return undefined;
    return picked;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    s.stop(`${name}: could not probe (${msg})`);
    return undefined;
  } finally {
    await upstream.close();
  }
}

async function main(): Promise<void> {
  const extracted = extractConfigPath(process.argv.slice(2));
  const args = extracted.remainingArgs;
  const configPath = extracted.configPath ?? getDefaultConfigPath();

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    const pkgPath = resolve(fileURLToPath(import.meta.url), "../../../package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    console.log(pkg.version);
    process.exit(0);
  }

  if (args[0] === "setup") {
    await runSetup(extracted.configPath);
    return;
  }

  if (args[0] === "init") {
    await handleInit(configPath, args.includes("--force"));
    return;
  }

  if (args[0] === "server") {
    await handleServerCommand(args.slice(1), configPath);
    return;
  }

  if (args[0] === "doctor") {
    await handleDoctorCommand(args.slice(1), configPath);
    return;
  }

  if (args[0] === "client") {
    await handleClientCommand(args.slice(1), configPath);
    return;
  }

  let config;

  if (extracted.configPath) {
    config = await loadConfig(extracted.configPath);
  } else if (args.includes("--")) {
    config = configFromArgs(args);
  } else {
    const defaultPath = await findDefaultConfig();
    if (defaultPath) {
      config = await loadConfig(defaultPath);
    } else {
      console.error("Error: specify --config <path> or -- <command> [args...]");
      console.error("Or create ~/.config/callmux/config.json");
      console.error("Run callmux --help for usage.");
      process.exit(1);
    }
  }

  const proxy = new CallmuxProxy(config);
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await proxy.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await proxy.close();
    process.exit(0);
  });

  await proxy.start(transport);
}

main().catch((err) => {
  console.error(`[callmux] Fatal: ${err.message}`);
  process.exit(1);
});
