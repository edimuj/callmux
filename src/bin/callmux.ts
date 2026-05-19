#!/usr/bin/env node

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallmuxBridge } from "../bridge.js";
import { CallmuxProxy } from "../proxy.js";
import { CallmuxListener } from "../listener.js";
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
  formatListenerDoctorReport,
  formatDoctorReport,
  formatServerTestReports,
  formatServerTestReport,
  runListenerDoctor,
  runDoctor,
  runServerTest,
} from "../doctor.js";
import {
  createDaemonPlan,
  detectDaemonEnvironment,
  executeDaemonPlan,
  formatDaemonPlan,
  type DaemonAction,
  type DaemonScope,
} from "../daemon.js";
import { runSetup } from "../setup.js";
import {
  renderAgentInstructions,
  type AgentInstructionsMode,
  type AgentInstructionsProfile,
} from "../instructions.js";
import { shutdownAfterFatalListenerError } from "../fatal.js";
import * as p from "@clack/prompts";
import { UpstreamManager } from "../upstream.js";
import type { CallmuxConfig, ServerConfig } from "../types.js";

const HELP = `
callmux — Multiplexer for MCP tool calls

Wraps any MCP server and adds parallel execution, batching, caching,
and pipelining. Claude (or any MCP client) connects to callmux, which
proxies to downstream servers and exposes meta-tools alongside them.

Usage:
  callmux                                    Auto-detect config file
  callmux --config <path>                    Explicit config file
  callmux --listen <port>                    Shared server mode (SSE/HTTP)
  callmux bridge --url <listener-url>        Stdio bridge to shared HTTP listener with cwd header
  callmux [options] -- <command> [args...]   Single-server mode
  callmux setup [--config <path>]            Interactive setup wizard
  callmux init [--config <path>] [--force]
  callmux doctor [--config <path>] [--json]
  callmux doctor --url <listener-url> [--cwd <path>] [--header Name:Value] [--json]
  callmux server add <name> [options] -- <command> [args...]
  callmux server set <name> [options] [-- <command> [args...]]
  callmux server edit <name> [options] [-- <command> [args...]]
  callmux server test <name> [--tool <tool>] [--json]
  callmux server test --all [--tool <tool>] [--json]
  callmux server remove <name> [--config <path>]
  callmux server list [--config <path>] [--json]
  callmux client print <claude|codex> [--config <path>] [--name <id>] [--url <listener-url>] [--bridge]
  callmux client attach <claude|codex> [--config <path>] [--name <id>] [--url <listener-url>] [--bridge] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client detach <claude|codex> [--name <id>] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client status [claude|codex] [--config <path>] [--name <id>] [--url <listener-url>] [--bridge] [--file <path>] [--json]
  callmux daemon <install|uninstall|start|stop|restart|enable|disable|status|logs> [options]
  callmux instructions [--profile generic|codex|claude] [--mode standard|meta-only]

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
  --call-timeout <ms>   Timeout for downstream tool calls (default: 180000)
  --request-body-max-bytes <n> Max inbound request payload bytes (0 = unlimited, default: 1048576)
  --allow-request-body-override Allow per-request x-callmux-max-body-bytes override header
  --allow-insecure-remote-listener Allow remote --listen without auth (unsafe)
  --strict-startup      Fail startup if any downstream server fails (default: degraded)
  --listen <port>       Run as shared HTTP/SSE server (multiple clients connect via URL)
  --host <addr>         Bind address for --listen (default: 127.0.0.1)
                         Config files are watched and hot-reloaded in listener mode
  --help, -h            Show this help
  --version, -v         Show version

Instructions Options:
  --profile <name>      Instruction profile: generic, codex, or claude (default: generic)
  --format markdown     Output format (only markdown is currently supported)
  --mode <mode>         Runtime mode guidance: standard or meta-only (default: standard)

Bridge Options:
  --url <listener-url>  Shared Streamable HTTP MCP endpoint (for example http://localhost:4860/mcp)
  --cwd <path>          Project cwd to send as x-callmux-cwd (default: process cwd)
  --header Name:Value   Extra HTTP header for the shared listener (repeatable)
  --call-timeout <ms>   Timeout for forwarded tool calls (default: SDK default)

Daemon Options:
  --port <n>            Listener port for install (default: 4860)
  --host <addr>         Listener host for install (default: 127.0.0.1)
  --name <id>           Service name (default: callmux)
  --user                Install/control a user-scoped daemon (default)
  --system              Install/control a system-scoped daemon where supported
  --start               Start after install
  --enable              Enable after install / at login
  --binary <path>       callmux binary path for generated daemon file
  --dry-run             Print daemon file and commands without changing anything
  --force               Overwrite/remove unmanaged daemon files
  --yes                 Skip confirmation prompts
  --json                Print daemon plan/result as JSON

Server Add Options:
  --tools <list>        Comma-separated downstream tool whitelist
  --env KEY=VALUE       Environment variable for the downstream server (repeatable)
  --cwd <path>          Working directory for the downstream server
  --cache-allow <list>  Per-server cache allowlist
  --cache-deny <list>   Per-server cache denylist
  --call-timeout <ms>   Per-server downstream tool call timeout (omit = use global)
  --request-body-max-bytes <n> Per-server inbound payload cap (0 = unlimited, omit = use global)

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
  --call-timeout <ms>   Replace per-server downstream tool call timeout
  --clear-call-timeout  Remove per-server downstream tool call timeout
  --request-body-max-bytes <n> Replace per-server inbound payload cap (0 = unlimited)
  --clear-request-body-max-bytes Remove per-server inbound payload cap

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
    "callTimeoutMs": 180000,
    "reconnectPolicy": {
      "initialDelayMs": 250,
      "maxDelayMs": 10000,
      "jitterRatio": 0.2,
      "maxAttempts": null,
      "fastFailDuringBackoff": true
    },
    "requestBodyMaxBytes": 1048576,
    "allowRequestBodyMaxOverride": false,
    "allowInsecureRemoteListener": false,
    "auth": {
      "mode": "bearer",
      "tokens": [
        { "id": "ops", "hash": "scrypt$16384$8$1$<salt>$<derivedKey>" },
        { "id": "ops", "hashRef": "env:CALLMUX_OPS_HASH" }
      ],
      "allowUnauthenticatedHealth": false
    },
    "authorization": {
      "defaultEffect": "deny",
      "rules": [
        { "id": "ops", "effect": "allow", "principals": ["bearer:ops"], "tools": ["*"] }
      ]
    },
    "abuseControls": {
      "globalRequestsPerMinute": 1200,
      "principalRequestsPerMinute": 240,
      "principalMaxInFlight": 20,
      "cidrAllowlist": ["127.0.0.1/32", "::1/128"]
    },
    "auditLog": {
      "enabled": false,
      "includeRequestBody": false,
      "maxPayloadChars": 4096
    },
    "metrics": {
      "enabled": true,
      "path": "/metrics",
      "allowUnauthenticated": false
    },
    "strictStartup": false
  }

Auth modes:
  bearer:
    "auth": {
      "mode": "bearer",
      "tokens": [{ "id": "ops", "hash": "scrypt$16384$8$1$<salt>$<derivedKey>" }]
    }
  oidc_jwt:
    "auth": {
      "mode": "oidc_jwt",
      "issuer": "https://id.example.com",
      "audience": "callmux",
      "jwksUri": "https://id.example.com/.well-known/jwks.json"
    }

Also accepts MCP-compatible format:
  { "mcpServers": { ... } }

Examples:
  callmux --listen 4860
  callmux --listen 4860 --config callmux.json
  callmux bridge --url http://localhost:4860/mcp
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
  callmux doctor --url http://localhost:4860/mcp --cwd "$PWD"
  callmux client print codex
  callmux client print codex --url http://localhost:4860/mcp
  callmux client print codex --url http://localhost:4860/mcp --bridge
  callmux client status
  callmux client attach codex
  callmux client attach codex --yes
  callmux client print claude --name github
  callmux daemon install --config ~/.config/callmux/config.json --start --enable
  callmux daemon status

Meta-tools exposed:
  callmux_parallel      Execute N tool calls concurrently
  callmux_batch         Apply one tool across many items
  callmux_pipeline      Chain tool calls with output mapping
  callmux_search_tools  Search downstream tools by task or keyword
  callmux_get_result    Page/filter/project a stored truncated response
  callmux_call          Call one downstream tool; can also invoke callmux_get_result
  callmux_dry_run       Validate and preview calls without execution
  callmux_recipe_run    Run a named config recipe
  callmux_recipe_dry_run Preview a named config recipe without execution
  callmux_cache_clear   Clear result cache
  callmux_status        Report callmux/downstream health and diagnostics

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
  let url: string | undefined;
  let bridge = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (args[i] === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === "--bridge") {
      bridge = true;
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
        ? attachClaudeConfig({ source, configPath, serverName: name, url, bridge })
        : detachClaudeConfig({ source, serverName: name })
      : action === "attach"
        ? attachCodexConfig({ source, configPath, serverName: name, url, bridge })
        : detachCodexConfig({ source, serverName: name });
  const shouldWrite = yes && !dryRun;
  const preview =
    action === "attach"
      ? renderClientAttachPreview(client, {
          configPath,
          serverName: name,
          url,
          bridge,
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
    ...(url ? { url } : {}),
    ...(bridge ? { bridge } : {}),
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
    let url: string | undefined;
    let bridge = false;

    if (args[1] === "claude" || args[1] === "codex") {
      client = args[1];
    }

    for (let i = client ? 2 : 1; i < args.length; i++) {
      if (args[i] === "--name" && i + 1 < args.length) {
        name = args[++i];
      } else if (args[i] === "--file" && i + 1 < args.length) {
        filePath = args[++i];
      } else if (args[i] === "--url" && i + 1 < args.length) {
        url = args[++i];
      } else if (args[i] === "--bridge") {
        bridge = true;
      } else if (args[i] === "--json") {
        json = true;
      } else {
        throw new Error(`Unknown client status option "${args[i]}"`);
      }
    }

    if (!client && (filePath || url || bridge)) {
      throw new Error("Usage: callmux client status <claude|codex> [--file <path>] [--name <id>] [--url <listener-url>] [--bridge] [--json]");
    }

    const clients = client ? [client] : (["claude", "codex"] as ClientKind[]);
    const statuses = await Promise.all(
      clients.map(async (kind) => {
        const path = filePath ?? getDefaultClientConfigPath(kind);
        const source = await readTextFileIfExists(path);
        const status =
          kind === "claude"
            ? getClaudeConfigStatus({ source, configPath, serverName: name, url, bridge })
            : getCodexConfigStatus({ source, configPath, serverName: name, url, bridge });
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
  let url: string | undefined;
  let bridge = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === "--bridge") {
      bridge = true;
    } else {
      throw new Error(`Unknown client print option "${args[i]}"`);
    }
  }

  console.log(
    renderClientSnippet(client, {
      configPath,
      serverName: name,
      url,
      bridge,
    })
  );
}

async function handleDoctorCommand(
  args: string[],
  configPath: string
): Promise<void> {
  let json = false;
  let listenerUrl: string | undefined;
  let cwd: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--url" && i + 1 < args.length) {
      listenerUrl = args[++i];
    } else if (arg === "--cwd" && i + 1 < args.length) {
      cwd = args[++i];
    } else if (arg === "--header" && i + 1 < args.length) {
      const raw = args[++i];
      const separator = raw.indexOf(":");
      if (separator <= 0) {
        throw new Error("--header must use Name:Value format");
      }
      headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
    } else {
      throw new Error(`Unknown doctor option "${arg}"`);
    }
  }

  if (listenerUrl) {
    const report = await runListenerDoctor({
      url: listenerUrl,
      ...(cwd ? { cwd } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatListenerDoctorReport(report));
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
    return;
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

async function handleBridgeCommand(args: string[]): Promise<void> {
  let url: string | undefined;
  let cwd = process.cwd();
  let callTimeoutMs: number | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (arg === "--cwd" && i + 1 < args.length) {
      cwd = resolve(args[++i]);
    } else if (arg === "--header" && i + 1 < args.length) {
      const raw = args[++i];
      const separator = raw.indexOf(":");
      if (separator <= 0) {
        throw new Error("--header must use Name:Value format");
      }
      headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
    } else if (arg === "--call-timeout" && i + 1 < args.length) {
      callTimeoutMs = parseInt(args[++i], 10);
      if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 0) {
        throw new Error("--call-timeout must be a non-negative integer");
      }
    } else {
      throw new Error(`Unknown bridge option "${arg}"`);
    }
  }

  if (!url) {
    throw new Error("Usage: callmux bridge --url <listener-url> [--cwd <path>] [--header Name:Value]");
  }

  const bridge = new CallmuxBridge({
    url,
    cwd,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
  });
  const transport = new StdioServerTransport();

  process.on("SIGINT", async () => {
    await bridge.close();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await bridge.close();
    process.exit(0);
  });

  await bridge.start(transport);
}

function handleInstructionsCommand(args: string[]): void {
  let profile: AgentInstructionsProfile = "generic";
  let mode: AgentInstructionsMode = "standard";
  let format = "markdown";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--profile" && i + 1 < args.length) {
      const value = args[++i];
      if (value !== "generic" && value !== "codex" && value !== "claude") {
        throw new Error("--profile must be one of: generic, codex, claude");
      }
      profile = value;
    } else if (arg === "--mode" && i + 1 < args.length) {
      const value = args[++i];
      if (value !== "standard" && value !== "meta-only") {
        throw new Error("--mode must be one of: standard, meta-only");
      }
      mode = value;
    } else if (arg === "--format" && i + 1 < args.length) {
      format = args[++i];
      if (format !== "markdown") {
        throw new Error("--format currently supports only markdown");
      }
    } else {
      throw new Error(`Unknown instructions option "${arg}"`);
    }
  }

  process.stdout.write(renderAgentInstructions({ profile, mode }));
}

function parseDaemonAction(value: string | undefined): DaemonAction {
  const actions = new Set<DaemonAction>([
    "install",
    "uninstall",
    "start",
    "stop",
    "restart",
    "enable",
    "disable",
    "status",
    "logs",
  ]);
  if (!value || !actions.has(value as DaemonAction)) {
    throw new Error(
      "Usage: callmux daemon <install|uninstall|start|stop|restart|enable|disable|status|logs> [options]"
    );
  }
  return value as DaemonAction;
}

async function handleDaemonCommand(
  args: string[],
  configPath: string
): Promise<void> {
  const action = parseDaemonAction(args[0]);
  let name: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let scope: DaemonScope | undefined;
  let binaryPath: string | undefined;
  let start = false;
  let enable = false;
  let dryRun = false;
  let force = false;
  let yes = false;
  let json = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg === "--port" && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (arg === "--host" && i + 1 < args.length) {
      host = args[++i];
    } else if (arg === "--user") {
      scope = "user";
    } else if (arg === "--system") {
      scope = "system";
    } else if (arg === "--binary" && i + 1 < args.length) {
      binaryPath = args[++i];
    } else if (arg === "--start") {
      start = true;
    } else if (arg === "--enable") {
      enable = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--yes") {
      yes = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      throw new Error(`Unknown daemon option "${arg}"`);
    }
  }

  if (action === "install") {
    await loadConfig(configPath);
  }

  const env = await detectDaemonEnvironment();
  const plan = createDaemonPlan(
    {
      action,
      configPath,
      ...(name ? { name } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(host ? { host } : {}),
      ...(scope ? { scope } : {}),
      ...(binaryPath ? { binaryPath } : {}),
      start,
      enable,
      force,
      dryRun,
    },
    env
  );

  if (!dryRun && !json && (action === "install" || action === "uninstall") && !yes) {
    const confirmed = await p.confirm({
      message:
        action === "install"
          ? `Install ${plan.kind} ${plan.scope} daemon "${plan.name}"?`
          : `Uninstall daemon "${plan.name}"?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Daemon command cancelled.");
      process.exit(0);
    }
  }

  const result = await executeDaemonPlan(plan, { dryRun, force });
  if (json) {
    console.log(JSON.stringify({ plan: result.plan, output: result.output }, null, 2));
  } else {
    console.log(dryRun ? formatDaemonPlan(plan) : result.output);
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

  if (args[0] === "bridge") {
    await handleBridgeCommand(args.slice(1));
    return;
  }

  if (args[0] === "instructions") {
    handleInstructionsCommand(args.slice(1));
    return;
  }

  if (args[0] === "client") {
    await handleClientCommand(args.slice(1), configPath);
    return;
  }

  if (args[0] === "daemon") {
    await handleDaemonCommand(args.slice(1), configPath);
    return;
  }

  // Extract --listen and --host before config resolution
  let listenPort: number | undefined;
  let listenHost = "127.0.0.1";
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--listen" && i + 1 < args.length) {
      listenPort = parseInt(args[++i], 10);
      if (!Number.isFinite(listenPort) || listenPort < 1 || listenPort > 65535) {
        console.error("Error: --listen requires a valid port (1-65535)");
        process.exit(2);
      }
    } else if (args[i] === "--host" && i + 1 < args.length) {
      listenHost = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  let config: CallmuxConfig;
  let activeConfigPath: string | undefined;

  if (extracted.configPath) {
    config = await loadConfig(extracted.configPath);
    activeConfigPath = resolve(extracted.configPath);
  } else if (filteredArgs.includes("--")) {
    config = configFromArgs(filteredArgs);
  } else {
    const defaultPath = await findDefaultConfig();
    if (defaultPath) {
      config = await loadConfig(defaultPath);
      activeConfigPath = resolve(defaultPath);
    } else {
      console.error("Error: specify --config <path> or -- <command> [args...]");
      console.error("Or create ~/.config/callmux/config.json");
      console.error("Run callmux --help for usage.");
      process.exit(1);
    }
  }

  let proxy = new CallmuxProxy(config);

  if (listenPort) {
    // Shared server mode: connect upstreams, then start HTTP listener
    await proxy.connectUpstreams();

    const listener = new CallmuxListener({
      port: listenPort,
      host: listenHost,
      config,
      upstream: proxy.getUpstream(),
      cache: proxy.getCache(),
      responseStore: proxy.getResponseStore(),
      allTools: proxy.getTools(),
      maxConcurrency: proxy.getMaxConcurrency(),
    });

    await listener.start();

    // Sentinel keeps the event loop alive even if every other ref is dropped
    // (all child transports closed, no active HTTP connections, etc.)
    const keepalive = setInterval(() => {}, 30_000);
    const staleProxyCloseDelayMs = 30_000;
    let configWatcher: FSWatcher | undefined;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let reloadInProgress = false;
    let reloadQueued = false;

    const closeStaleProxyLater = (staleProxy: CallmuxProxy): void => {
      const timer = setTimeout(() => {
        staleProxy.close().catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`[callmux] Stale upstream close failed: ${message}\n`);
        });
      }, staleProxyCloseDelayMs);
      timer.unref?.();
    };

    const reloadConfig = async (trigger: string): Promise<void> => {
      if (!activeConfigPath) return;
      if (reloadInProgress) {
        reloadQueued = true;
        return;
      }

      reloadInProgress = true;
      let nextProxy: CallmuxProxy | undefined;
      try {
        const nextConfig = await loadConfig(activeConfigPath);
        nextProxy = new CallmuxProxy(nextConfig);
        await nextProxy.connectUpstreams();

        const previousProxy = proxy;
        listener.applyReloadedState({
          config: nextConfig,
          upstream: nextProxy.getUpstream(),
          cache: nextProxy.getCache(),
          allTools: nextProxy.getTools(),
          maxConcurrency: nextProxy.getMaxConcurrency(),
        });
        listener.recordConfigReload({ ok: true });
        proxy = nextProxy;
        nextProxy = undefined;
        config = nextConfig;
        closeStaleProxyLater(previousProxy);
        process.stderr.write(
          `[callmux] Reloaded config from ${activeConfigPath} (${trigger})\n`
        );
      } catch (error) {
        if (nextProxy) {
          try { await nextProxy.close(); } catch {}
        }
        const message = error instanceof Error ? error.message : String(error);
        listener.recordConfigReload({ ok: false, error: message });
        process.stderr.write(
          `[callmux] Config reload failed (${activeConfigPath}, ${trigger}): ${message}\n`
        );
      } finally {
        reloadInProgress = false;
        if (reloadQueued) {
          reloadQueued = false;
          void reloadConfig("queued");
        }
      }
    };

    const scheduleReload = (trigger: string): void => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void reloadConfig(trigger);
      }, 250);
      reloadTimer.unref?.();
    };

    let shuttingDown = false;
    const closeListenerResources = async () => {
      clearInterval(keepalive);
      if (reloadTimer) clearTimeout(reloadTimer);
      configWatcher?.close();
      await Promise.allSettled([
        listener.close(),
        proxy.close(),
      ]);
    };

    let fatalShutdownInProgress = false;
    const fatalShutdown = (kind: "uncaughtException" | "unhandledRejection", reason: unknown) => {
      if (fatalShutdownInProgress) return;
      fatalShutdownInProgress = true;
      shuttingDown = true;
      void shutdownAfterFatalListenerError(kind, reason, {
        close: closeListenerResources,
      });
    };

    process.on("uncaughtException", (err) => {
      fatalShutdown("uncaughtException", err);
    });

    process.on("unhandledRejection", (reason) => {
      fatalShutdown("unhandledRejection", reason);
    });

    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`[callmux] ${signal} received, shutting down\n`);
      await closeListenerResources();
      process.exit(0);
    };

    if (activeConfigPath) {
      try {
        configWatcher = watch(activeConfigPath, (eventType) => {
          if (eventType === "change" || eventType === "rename") {
            scheduleReload(`file ${eventType}`);
          }
        });
        configWatcher.on("error", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[callmux] Config watcher failed (${activeConfigPath}): ${message}\n`
          );
        });
        process.stderr.write(`[callmux] Watching config for hot reload: ${activeConfigPath}\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[callmux] Config watcher unavailable (${activeConfigPath}): ${message}\n`
        );
      }

      process.on("SIGHUP", () => {
        void reloadConfig("SIGHUP");
      });
    }

    process.on("SIGINT", () => { shutdown("SIGINT"); });
    process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  } else {
    // Stdio mode (default)
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
}

main().catch((err) => {
  console.error(`[callmux] Fatal: ${err.message}`);
  process.exit(1);
});
