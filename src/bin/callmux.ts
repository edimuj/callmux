#!/usr/bin/env node

import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallmuxBridge } from "../bridge.js";
import { CallmuxProxy } from "../proxy.js";
import { VERSION } from "../version.js";
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
  DEFAULT_PORT,
  type DaemonAction,
  type DaemonScope,
} from "../daemon.js";
import { callListenerTool, extractListenerToolPayload, listenerRequest } from "../listener-client.js";
import {
  describeClientTokenSource,
  getManagedClientTokenPath,
  resolveClientToken,
  resolveClientTokenDetailed,
  withBearerToken,
  writeManagedClientToken,
  type ClientTokenSources,
  type ResolvedClientToken,
} from "../cli-auth.js";
import { formatToolText, isOutputFormat, type OutputFormat } from "../output-format.js";
import { runSetup } from "../setup.js";
import {
  renderAgentInstructions,
  type AgentInstructionsMode,
  type AgentInstructionsProfile,
} from "../instructions.js";
import { shutdownAfterFatalListenerError } from "../fatal.js";
import { drainAndCloseProxy } from "../reload-drain.js";
import {
  applyManagementOverlay,
  loadManagementOverlay,
  normalizeManagementConfig,
  type ManagementOverlay,
} from "../management.js";
import * as p from "@clack/prompts";
import { UpstreamManager } from "../upstream.js";
import type { CallmuxConfig, ServerConfig } from "../types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

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
  callmux call <tool> [json] [--file <path>] [--url <listener-url>]
                                              Call one tool against a running listener (tools/call)
                                              Exit codes: 1 = tool error, 2 = usage/transport error
  callmux parallel '<tool> <argsJSON>' ... [--file <path>] [--url <listener-url>]
                                              Sugar for callmux_parallel: fan out N tool calls
  callmux batch '<tool> <argsJSON>' ... [--file <path>] [--url <listener-url>]
                                              Sugar for callmux_batch: apply one tool across many items
  callmux pipeline '<tool> <argsJSON>' ... [--file <path>] [--url <listener-url>]
                                              Sugar for callmux_pipeline: chain tool calls in order
  callmux tools list [--server <name>] [--json] [--url <listener-url>]
                                              List hosted tool names + one-line descriptions (tools/list)
  callmux tools schema <tool> [--json] [--url <listener-url>]
                                              Print the full input schema for one tool
  callmux tools search <query> [--server <name>] [--json] [--url <listener-url>]
                                              Substring-match tool names/descriptions
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
  callmux client attach <claude|codex> [--config <path>] [--name <id>] [--url <listener-url>] [--bridge] [--token <t>] [--token-file <path>] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client detach <claude|codex> [--name <id>] [--file <path>] [--dry-run] [--yes] [--json]
  callmux client status [claude|codex] [--config <path>] [--name <id>] [--url <listener-url>] [--bridge] [--file <path>] [--json]
  callmux daemon <install|uninstall|start|stop|restart|enable|disable|status|logs> [options]
  callmux instructions [--profile generic|codex|claude] [--mode standard|meta-only]

Options:
  --config <path>       Path to callmux config or .mcp.json file
  --tools <list>        Comma-separated tool whitelist (single-server mode)
  --env KEY=VALUE       Environment variable for downstream server (repeatable)
  --cache <seconds>     Cache TTL; requires readOnlyHint or allowlist (default: 0 = off)
  --cache-max-entries <n> Max cache entries before oldest entries are evicted (default: 1000)
  --cache-allow <list>  Comma-separated cache allowlist for single-server mode
  --cache-deny <list>   Comma-separated cache denylist for single-server mode
  --concurrency <n>     Max parallel calls (default: 20)
  --connect-timeout <ms> Timeout for downstream startup connect/list-tools (default: 30000)
  --call-timeout <ms>   Timeout for downstream tool calls (default: 180000)
  --output-format <fmt> Model-facing structured output text: json, toon, or auto
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
  --token <t>           Client->callmux bearer token (loopback needs none)
  --token-file <path>   Read the bearer token from a file (keeps it out of ps/history)

Call Options:
  --url <listener-url>  Shared Streamable HTTP MCP endpoint (default: http://127.0.0.1:4860/mcp)
  --cwd <path>          Project cwd to send as x-callmux-cwd (default: process cwd)
  --header Name:Value   Extra HTTP header for the shared listener, e.g. Authorization (repeatable)
  --file <path>         Read the JSON args payload from a file instead of the command line
  --call-timeout <ms>   Timeout for the forwarded tool call
  --output-format <fmt> Render the result as json, toon, or auto (default: json)
  --token <t>           Client->callmux bearer token. Precedence: CALLMUX_TOKEN
                         env > --token > --token-file > managed store. Loopback
                         daemons need no token.
  --token-file <path>   Read the bearer token from a file (keeps it out of ps/history)
  --verbose             Print the listener URL and token source tier to stderr before calling
  Exit codes: 1 = the downstream tool reported an error, 2 = usage/transport error.

Parallel/Batch/Pipeline Options:
  Same options as Call Options above. Each '<tool> <argsJSON>' argument is
  split on its FIRST space into a tool name and a JSON args object; the
  resulting list is assembled into the calls/items/steps array expected by
  callmux_parallel/_batch/_pipeline and forwarded as one tool call.
  batch requires every argument to name the SAME tool (one tool, many items).
  --file <path>         Read the full callmux_parallel/_batch/_pipeline args
                         object from a file instead of building it from argv.
                         Use this for anything beyond "list of tool + args"
                         (per-call timeouts/cwd, pipeline inputMapping, etc).

Tools Options:
  --url <listener-url>  Shared Streamable HTTP MCP endpoint (default: http://127.0.0.1:4860/mcp)
  --cwd <path>          Project cwd to send as x-callmux-cwd (default: process cwd)
  --header Name:Value   Extra HTTP header for the shared listener (repeatable)
  --server <name>       Filter to tools qualified with the "<name>__" prefix (list/search)
  --call-timeout <ms>   Timeout for the tools/list request
  --token <t>           Client->callmux bearer token (see Call Options precedence)
  --token-file <path>   Read the bearer token from a file (keeps it out of ps/history)
  --json                Machine-readable output instead of the human-readable default
  --quiet               Suppress the "no tools found" message on an empty result (list/search)
  --verbose             Print the listener URL and token source tier to stderr before calling
  Exit codes: 2 = usage/transport error (tools/list has no per-tool "error" result to report as 1).

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
    "outputFormat": "json",
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
  callmux call github__search_issues '{"query":"is:open"}'
  callmux call callmux_parallel '{"calls":[{"tool":"github__issue_read","arguments":{"number":1}}]}'
  callmux call github__create_issue --file payload.json --url http://localhost:4860/mcp
  callmux parallel 'github__issue_read {"number":1}' 'github__issue_read {"number":2}'
  callmux batch 'github__issue_read {"number":1}' 'github__issue_read {"number":2}'
  callmux pipeline 'github__issue_read {"number":1}' 'github__create_comment {"body":"ack"}'
  callmux pipeline --file plan.json --url http://localhost:4860/mcp
  callmux call callmux_get_result '{"ref":"r_...","offset":50,"limit":50}'
  callmux tools list --url http://localhost:4860/mcp
  callmux tools list --server github --json
  callmux tools schema github__create_issue
  callmux tools search issue
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

async function requireManagedConfig(configPath: string) {
  const config = await loadManagedConfig(configPath);
  if (!config) {
    throw new Error(
      `No callmux config found at ${configPath}. Run \`callmux init\` to create one.`
    );
  }
  return config;
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
    const config = await requireManagedConfig(configPath);
    if (!config.servers[name]) {
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

    const config = await requireManagedConfig(configPath);

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
    const config = await requireManagedConfig(configPath);
    if (!config.servers[name]) {
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
  let token: string | undefined;
  let tokenFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (args[i] === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === "--bridge") {
      bridge = true;
    } else if (args[i] === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (args[i] === "--token-file" && i + 1 < args.length) {
      tokenFile = args[++i];
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

  if ((token !== undefined || tokenFile !== undefined) && action !== "attach") {
    throw new Error("--token/--token-file are only valid with client attach");
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

  // Resolve the CLI token straight from the flags (env: "" skips the env var,
  // skipManagedStore skips reading back what we're about to write) so this
  // reflects exactly what the user passed this run — an `attach --yes` with no
  // token flags stashes nothing instead of silently re-writing the existing
  // managed token and reporting it as freshly "Stashed".
  const attachToken =
    action === "attach"
      ? await resolveClientToken({
          env: "",
          skipManagedStore: true,
          ...(token !== undefined ? { token } : {}),
          ...(tokenFile !== undefined ? { tokenFile } : {}),
        })
      : undefined;

  if (shouldWrite) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, mutation.content, "utf-8");
  }

  let tokenStorePath: string | undefined;
  if (shouldWrite && attachToken) {
    tokenStorePath = await writeManagedClientToken(attachToken);
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
    ...(attachToken ? { tokenStashed: shouldWrite } : {}),
    ...(tokenStorePath ? { tokenStorePath } : {}),
    ...(mutation.changed ? { preview } : {}),
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!mutation.changed) {
    console.log(`No changes needed for "${name}" in ${filePath}`);
    if (tokenStorePath) {
      console.log(`Stashed CLI token in ${tokenStorePath}`);
    }
    return;
  }

  if (!shouldWrite) {
    console.log(`Preview only for ${client} at ${filePath}. Re-run with --yes to write.`);
    if (attachToken) {
      console.log(`(--yes would also stash the CLI token in ${getManagedClientTokenPath()})`);
    }
    console.log("");
    console.log(preview);
    return;
  }

  console.log(`${action === "attach" ? "Attached" : "Detached"} "${name}" ${action === "attach" ? "in" : "from"} ${filePath}`);
  if (tokenStorePath) {
    console.log(`Stashed CLI token in ${tokenStorePath}`);
  }
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
  let token: string | undefined;
  let tokenFile: string | undefined;
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
      callTimeoutMs = Number(args[++i]);
      if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 0) {
        throw new Error("--call-timeout must be a non-negative integer");
      }
    } else if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (arg === "--token-file" && i + 1 < args.length) {
      tokenFile = args[++i];
    } else {
      throw new Error(`Unknown bridge option "${arg}"`);
    }
  }

  if (!url) {
    throw new Error("Usage: callmux bridge --url <listener-url> [--cwd <path>] [--header Name:Value] [--token <t>] [--token-file <path>]");
  }

  const resolvedToken = await resolveClientToken({
    ...(token !== undefined ? { token } : {}),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
  });
  const bridgeHeaders = withBearerToken(headers, resolvedToken);

  const bridge = new CallmuxBridge({
    url,
    cwd,
    ...(Object.keys(bridgeHeaders).length > 0 ? { headers: bridgeHeaders } : {}),
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

interface ListenerCallOptions {
  url?: string;
  cwd: string;
  callTimeoutMs?: number;
  filePath?: string;
  outputFormat?: OutputFormat;
  headers: Record<string, string>;
  token?: string;
  tokenFile?: string;
  verbose?: boolean;
  positionals: string[];
}

/** Value-taking flags for `call`/`parallel`/`batch`/`pipeline` — a bare trailing flag names itself instead of reading as "unknown option". */
const LISTENER_CALL_VALUE_FLAGS = new Set([
  "--url",
  "--cwd",
  "--header",
  "--call-timeout",
  "--file",
  "--token",
  "--token-file",
  "--output-format",
]);

/**
 * Parses the flags shared by `call`, `parallel`, `batch`, and `pipeline`
 * (--url, --cwd, --header, --call-timeout, --file, --output-format,
 * --token, --token-file), leaving positional (non-flag) arguments for the
 * caller to interpret.
 */
function parseListenerCallOptions(args: string[], commandLabel: string): ListenerCallOptions {
  let url: string | undefined;
  let cwd = process.cwd();
  let callTimeoutMs: number | undefined;
  let filePath: string | undefined;
  let outputFormat: OutputFormat | undefined;
  let token: string | undefined;
  let tokenFile: string | undefined;
  let verbose = false;
  const headers: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (arg === "--cwd" && i + 1 < args.length) {
      cwd = resolve(args[++i]);
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--header" && i + 1 < args.length) {
      const raw = args[++i];
      const separator = raw.indexOf(":");
      if (separator <= 0) {
        throw new Error("--header must use Name:Value format");
      }
      headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
    } else if (arg === "--call-timeout" && i + 1 < args.length) {
      callTimeoutMs = Number(args[++i]);
      if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 0) {
        throw new Error("--call-timeout must be a non-negative integer");
      }
    } else if (arg === "--file" && i + 1 < args.length) {
      filePath = args[++i];
    } else if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (arg === "--token-file" && i + 1 < args.length) {
      tokenFile = args[++i];
    } else if (arg === "--output-format" && i + 1 < args.length) {
      const value = args[++i];
      if (!isOutputFormat(value)) {
        throw new Error("--output-format must be one of: json, toon, auto");
      }
      outputFormat = value;
    } else if (arg.startsWith("--")) {
      if (LISTENER_CALL_VALUE_FLAGS.has(arg)) {
        throw new Error(`missing value for ${arg}`);
      }
      throw new Error(`Unknown ${commandLabel} option "${arg}"`);
    } else {
      positionals.push(arg);
    }
  }

  return { url, cwd, callTimeoutMs, filePath, outputFormat, headers, token, tokenFile, verbose, positionals };
}

async function readJsonObjectPayload(source: string, label: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * On a 401, name which precedence tier actually sent the token (env/flag/
 * token-file/managed-store/none) so a stale `CALLMUX_TOKEN` env var beating a
 * correct `--token` flag doesn't read as an unexplained bare "HTTP 401".
 */
function describeListenerCallError(
  error: string | undefined,
  httpStatus: number | undefined,
  resolvedToken: ResolvedClientToken,
  tokenSources: ClientTokenSources
): string {
  const base = error ?? "call failed";
  if (httpStatus !== 401) return base;
  return `${base} (${describeClientTokenSource(resolvedToken, tokenSources)})`;
}

/** `--verbose` diagnostic line: which listener and token tier a request is about to use. */
function logVerboseListenerRequest(
  label: string,
  listenerUrl: string,
  resolvedToken: ResolvedClientToken,
  tokenSources: ClientTokenSources
): void {
  console.error(`[callmux] ${label} ${listenerUrl} (${describeClientTokenSource(resolvedToken, tokenSources)})`);
}

/**
 * Calls a tool on a running listener and prints/exits like the `call` CLI
 * verb: exit 1 when the downstream tool reports an error, exit 2 on
 * usage/transport failure.
 */
async function runListenerToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  options: Pick<ListenerCallOptions, "url" | "cwd" | "callTimeoutMs" | "outputFormat" | "headers" | "token" | "tokenFile" | "verbose">
): Promise<void> {
  const listenerUrl = options.url ?? `http://127.0.0.1:${DEFAULT_PORT}/mcp`;

  const tokenSources: ClientTokenSources = {
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.tokenFile !== undefined ? { tokenFile: options.tokenFile } : {}),
  };
  // Token resolution can throw (missing/empty --token-file, unreadable managed
  // store). Catch it here as a usage failure (exit 2) rather than letting it
  // reach main().catch, which exits 1 — the "downstream tool errored" code.
  let resolvedToken: Awaited<ReturnType<typeof resolveClientTokenDetailed>>;
  try {
    resolvedToken = await resolveClientTokenDetailed(tokenSources);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }
  const headers = withBearerToken(options.headers, resolvedToken.token);
  if (options.verbose) {
    logVerboseListenerRequest(`tools/call ${toolName} via`, listenerUrl, resolvedToken, tokenSources);
  }

  const outcome = await callListenerTool(listenerUrl, toolName, toolArgs, {
    cwd: options.cwd,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options.callTimeoutMs !== undefined ? { timeoutMs: options.callTimeoutMs } : {}),
  });

  if (!outcome.ok || !outcome.result) {
    console.error(
      `Error: ${describeListenerCallError(outcome.error, outcome.httpStatus, resolvedToken, tokenSources)}`
    );
    process.exitCode = 2;
    return;
  }

  const payload = extractListenerToolPayload(outcome.result);
  console.log(formatToolText(payload, { format: options.outputFormat }));

  if (outcome.result.isError) {
    process.exitCode = 1;
    return;
  }

  // parallel/batch/pipeline report per-call failures as DATA, not isError, so
  // without this a failed fan-out would exit 0 and any script gating on the
  // exit code would treat it as success.
  if (META_FANOUT_TOOLS.has(toolName)) {
    const code = metaFanoutExitCode(payload);
    if (code !== 0) {
      process.exitCode = code;
    }
  }
}

/** Meta tools whose result encodes per-call failure as data (see metaFanoutExitCode). */
const META_FANOUT_TOOLS = new Set(["callmux_parallel", "callmux_batch", "callmux_pipeline"]);

/**
 * Maps a parallel/batch/pipeline result payload onto the documented CLI exit
 * codes:
 *   1 — the fan-out ran but a downstream tool reported a tool-level error
 *       (parallel/batch `status: "partial"`, or a pipeline step whose own
 *       result was an error).
 *   2 — execution halted before completion for a structural reason: a pipeline
 *       step threw or a required `inputMapping` could not be satisfied (the
 *       failing step carries an `error` string rather than a tool `result`).
 *   0 — everything succeeded.
 * The caller only invokes this for known meta tools, so the payload shape is
 * always a meta result (no risk of a plain tool output being misread).
 */
function metaFanoutExitCode(payload: unknown): 0 | 1 | 2 {
  if (!isRecordValue(payload)) return 0;
  const status = payload.status;

  if (status === "failed") {
    const steps = Array.isArray(payload.steps) ? payload.steps : [];
    const failedStep = typeof payload.failedStep === "number" ? payload.failedStep : undefined;
    const step =
      failedStep !== undefined
        ? steps.find((s) => isRecordValue(s) && s.step === failedStep)
        : undefined;
    if (isRecordValue(step) && typeof step.error === "string") return 2;
    return 1;
  }

  if (status === "partial") return 1;
  if (typeof payload.failed === "number" && payload.failed > 0) return 1;
  if (Array.isArray(payload.failedIndexes) && payload.failedIndexes.length > 0) return 1;

  return 0;
}

/**
 * Exit codes: 1 = the downstream tool reported an error (`isError: true`).
 * 2 = usage error or transport/connection failure (couldn't reach the
 * listener, bad JSON payload, unknown flag, ...).
 */
async function handleCallCommand(args: string[]): Promise<void> {
  const toolName = args[0];
  if (!toolName) {
    console.error(
      "Usage: callmux call <tool> [json] [--file <path>] [--url <listener-url>] [--cwd <path>] [--header Name:Value] [--call-timeout <ms>] [--output-format json|toon|auto]"
    );
    process.exitCode = 2;
    return;
  }

  let options: ListenerCallOptions;
  try {
    options = parseListenerCallOptions(args.slice(1), "call");
    if (options.positionals.length > 1) {
      throw new Error("Usage: callmux call <tool> [json] — only one JSON payload argument is allowed");
    }
    if (options.positionals.length > 0 && options.filePath) {
      throw new Error("Provide the JSON payload as an argument or via --file, not both");
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  let payloadText: string;
  try {
    payloadText = options.filePath
      ? await readFile(resolve(options.filePath), "utf-8")
      : (options.positionals[0] ?? "{}");
  } catch (error) {
    console.error(`Error: failed to read --file: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = await readJsonObjectPayload(payloadText, "payload");
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  await runListenerToolCall(toolName, toolArgs, options);
}

type MetaSugarVerb = "parallel" | "batch" | "pipeline";

const META_SUGAR_TOOL: Record<MetaSugarVerb, string> = {
  parallel: "callmux_parallel",
  batch: "callmux_batch",
  pipeline: "callmux_pipeline",
};

function metaSugarUsage(verb: MetaSugarVerb): string {
  return (
    `Usage: callmux ${verb} '<tool> <argsJSON>' ['<tool> <argsJSON>' ...] [--file <path>] ` +
    "[--url <listener-url>] [--cwd <path>] [--header Name:Value] [--call-timeout <ms>] [--output-format json|toon|auto]"
  );
}

/**
 * Splits each `<tool> <argsJSON>` argument on its FIRST space into a tool
 * name and a JSON payload. This is intentionally dumb argv->JSON sugar —
 * anything more structured than "list of tool + args" belongs in --file.
 */
function parseMetaSugarEntries(
  entries: string[]
): Array<{ tool: string; arguments: Record<string, unknown> }> {
  return entries.map((entry) => {
    const spaceIndex = entry.indexOf(" ");
    const tool = spaceIndex === -1 ? entry : entry.slice(0, spaceIndex);
    const jsonText = spaceIndex === -1 ? "{}" : entry.slice(spaceIndex + 1).trim() || "{}";
    if (!tool) {
      throw new Error(`Invalid call "${entry}" — expected "<tool> <argsJSON>"`);
    }
    let parsed: Record<string, unknown>;
    try {
      const candidate = JSON.parse(jsonText);
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("args payload must be a JSON object");
      }
      parsed = candidate;
    } catch (error) {
      throw new Error(
        `Invalid JSON args for tool "${tool}": ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { tool, arguments: parsed };
  });
}

function buildMetaSugarToolArgs(
  verb: MetaSugarVerb,
  entries: Array<{ tool: string; arguments: Record<string, unknown> }>
): Record<string, unknown> {
  if (verb === "parallel") {
    return { calls: entries.map(({ tool, arguments: toolArguments }) => ({ tool, arguments: toolArguments })) };
  }
  if (verb === "pipeline") {
    return { steps: entries.map(({ tool, arguments: toolArguments }) => ({ tool, arguments: toolArguments })) };
  }

  const tool = entries[0]?.tool;
  for (const entry of entries) {
    if (entry.tool !== tool) {
      throw new Error(
        `callmux batch applies one tool across many items — got both "${tool}" and "${entry.tool}". ` +
          "Use --file for plans that call different tools."
      );
    }
  }
  return {
    tool,
    items: entries.map(({ arguments: toolArguments }) => ({ arguments: toolArguments })),
  };
}

/**
 * `callmux parallel|batch|pipeline '<tool> <argsJSON>' ...` — pure argv->JSON
 * sugar that assembles the same request shape callmux_parallel/_batch/_pipeline
 * expect and forwards it through the same callListenerTool path as `call`.
 */
async function handleMetaSugarCommand(verb: MetaSugarVerb, args: string[]): Promise<void> {
  let options: ListenerCallOptions;
  try {
    options = parseListenerCallOptions(args, verb);
    if (options.positionals.length > 0 && options.filePath) {
      throw new Error("Provide calls as arguments or via --file, not both");
    }
    if (options.positionals.length === 0 && !options.filePath) {
      throw new Error(metaSugarUsage(verb));
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  let toolArgs: Record<string, unknown>;
  try {
    if (options.filePath) {
      const payloadText = await readFile(resolve(options.filePath), "utf-8");
      toolArgs = await readJsonObjectPayload(payloadText, "payload");
    } else {
      toolArgs = buildMetaSugarToolArgs(verb, parseMetaSugarEntries(options.positionals));
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  await runListenerToolCall(META_SUGAR_TOOL[verb], toolArgs, options);
}

const MAX_TOOLS_LIST_DESCRIPTION_LENGTH = 100;

interface ToolsCommandOptions {
  url: string;
  cwd: string;
  headers: Record<string, string>;
  callTimeoutMs?: number;
  server?: string;
  token?: string;
  tokenFile?: string;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  positionals: string[];
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Value-taking flags for `tools list|schema|search` — a bare trailing flag names itself instead of reading as "unknown option". */
const TOOLS_COMMAND_VALUE_FLAGS = new Set([
  "--url",
  "--cwd",
  "--server",
  "--header",
  "--call-timeout",
  "--token",
  "--token-file",
]);

/**
 * Shared flag parsing for `callmux tools list|schema|search` — all three
 * talk to the same daemon `tools/list` endpoint via listenerRequest.
 */
function parseToolsCommandArgs(args: string[]): ToolsCommandOptions | { error: string } {
  let url: string | undefined;
  let cwd = process.cwd();
  let callTimeoutMs: number | undefined;
  let server: string | undefined;
  let token: string | undefined;
  let tokenFile: string | undefined;
  let json = false;
  let quiet = false;
  let verbose = false;
  const headers: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (arg === "--cwd" && i + 1 < args.length) {
      cwd = resolve(args[++i]);
    } else if (arg === "--server" && i + 1 < args.length) {
      server = args[++i];
    } else if (arg === "--quiet") {
      quiet = true;
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--header" && i + 1 < args.length) {
      const raw = args[++i];
      const separator = raw.indexOf(":");
      if (separator <= 0) {
        return { error: "--header must use Name:Value format" };
      }
      headers[raw.slice(0, separator).trim()] = raw.slice(separator + 1).trim();
    } else if (arg === "--call-timeout" && i + 1 < args.length) {
      callTimeoutMs = Number(args[++i]);
      if (!Number.isInteger(callTimeoutMs) || callTimeoutMs < 0) {
        return { error: "--call-timeout must be a non-negative integer" };
      }
    } else if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (arg === "--token-file" && i + 1 < args.length) {
      tokenFile = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      if (TOOLS_COMMAND_VALUE_FLAGS.has(arg)) {
        return { error: `missing value for ${arg}` };
      }
      return { error: `Unknown tools option "${arg}"` };
    } else {
      positionals.push(arg);
    }
  }

  return {
    url: url ?? `http://127.0.0.1:${DEFAULT_PORT}/mcp`,
    cwd,
    headers,
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    ...(server !== undefined ? { server } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(tokenFile !== undefined ? { tokenFile } : {}),
    json,
    quiet,
    verbose,
    positionals,
  };
}

async function fetchToolList(
  options: ToolsCommandOptions
): Promise<Tool[] | { error: string }> {
  const tokenSources: ClientTokenSources = {
    ...(options.token !== undefined ? { token: options.token } : {}),
    ...(options.tokenFile !== undefined ? { tokenFile: options.tokenFile } : {}),
  };
  // Token resolution can throw (missing/empty --token-file); surface it as an
  // error outcome so the caller exits 2 instead of it reaching main().catch.
  let resolvedToken: Awaited<ReturnType<typeof resolveClientTokenDetailed>>;
  try {
    resolvedToken = await resolveClientTokenDetailed(tokenSources);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const headers = withBearerToken(options.headers, resolvedToken.token);
  if (options.verbose) {
    logVerboseListenerRequest("tools/list via", options.url, resolvedToken, tokenSources);
  }

  const outcome = await listenerRequest(options.url, "tools/list", {}, {
    cwd: options.cwd,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(options.callTimeoutMs !== undefined ? { timeoutMs: options.callTimeoutMs } : {}),
  });

  if (!outcome.ok) {
    return {
      error: describeListenerCallError(outcome.error ?? "tools/list failed", outcome.httpStatus, resolvedToken, tokenSources),
    };
  }

  const tools =
    isRecordValue(outcome.result) && Array.isArray(outcome.result.tools)
      ? (outcome.result.tools as Tool[])
      : undefined;
  if (!tools) {
    return { error: "tools/list response did not include a tools array" };
  }
  return tools;
}

/** Matches the `<prefix>__<toolName>` convention servers are qualified with. */
function toolMatchesServer(toolName: string, server: string): boolean {
  return toolName === server || toolName.startsWith(`${server}__`);
}

function oneLineToolDescription(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  const firstLine = description.split("\n")[0]?.trim();
  if (!firstLine) return undefined;
  return firstLine.length > MAX_TOOLS_LIST_DESCRIPTION_LENGTH
    ? `${firstLine.slice(0, MAX_TOOLS_LIST_DESCRIPTION_LENGTH - 1)}…`
    : firstLine;
}

function printToolSummaries(
  tools: Tool[],
  json: boolean,
  emptyMessage: string,
  quiet = false
): void {
  const summaries = tools.map((tool) => ({
    name: tool.name,
    description: oneLineToolDescription(tool.description),
  }));

  if (json) {
    console.log(JSON.stringify({ count: summaries.length, tools: summaries }, null, 2));
    return;
  }

  if (summaries.length === 0) {
    // --quiet drops the human "nothing found" sentence so scripts parsing
    // stdout see truly empty output instead of a line they'd have to filter.
    if (!quiet) console.log(emptyMessage);
    return;
  }

  console.log(
    summaries
      .map((tool) => (tool.description ? `${tool.name}  ${tool.description}` : tool.name))
      .join("\n")
  );
}

/**
 * `callmux tools list` — cheap discovery: names + one-line descriptions from
 * the daemon's tools/list. Full schemas are fetched on demand via `tools schema`.
 */
async function handleToolsListCommand(args: string[]): Promise<void> {
  const parsed = parseToolsCommandArgs(args);
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.positionals.length > 0) {
    console.error(
      `Error: Unknown argument "${parsed.positionals[0]}" — usage: callmux tools list [--server <name>] [--json] [--url <listener-url>]`
    );
    process.exitCode = 2;
    return;
  }

  const tools = await fetchToolList(parsed);
  if ("error" in tools) {
    console.error(`Error: ${tools.error}`);
    process.exitCode = 2;
    return;
  }

  const filtered = parsed.server
    ? tools.filter((tool) => toolMatchesServer(tool.name, parsed.server!))
    : tools;

  printToolSummaries(
    filtered,
    parsed.json,
    parsed.server ? `No tools found for server "${parsed.server}".` : "No tools available.",
    parsed.quiet
  );
}

/** `callmux tools schema <tool>` — full input schema for one tool, on demand. */
async function handleToolsSchemaCommand(args: string[]): Promise<void> {
  const parsed = parseToolsCommandArgs(args);
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.positionals.length !== 1) {
    console.error("Usage: callmux tools schema <tool> [--json] [--url <listener-url>]");
    process.exitCode = 2;
    return;
  }
  const toolName = parsed.positionals[0];

  const tools = await fetchToolList(parsed);
  if ("error" in tools) {
    console.error(`Error: ${tools.error}`);
    process.exitCode = 2;
    return;
  }

  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) {
    console.error(`Error: tool "${toolName}" not found`);
    process.exitCode = 2;
    return;
  }

  if (parsed.json) {
    console.log(JSON.stringify(tool, null, 2));
    return;
  }

  console.log(tool.description ? `${tool.name} — ${tool.description}` : tool.name);
  console.log("");
  console.log(JSON.stringify(tool.inputSchema ?? {}, null, 2));
}

/** `callmux tools search <query>` — substring match over names + descriptions. */
async function handleToolsSearchCommand(args: string[]): Promise<void> {
  const parsed = parseToolsCommandArgs(args);
  if ("error" in parsed) {
    console.error(`Error: ${parsed.error}`);
    process.exitCode = 2;
    return;
  }
  if (parsed.positionals.length !== 1) {
    console.error("Usage: callmux tools search <query> [--server <name>] [--json] [--url <listener-url>]");
    process.exitCode = 2;
    return;
  }
  const query = parsed.positionals[0];

  const tools = await fetchToolList(parsed);
  if ("error" in tools) {
    console.error(`Error: ${tools.error}`);
    process.exitCode = 2;
    return;
  }

  const scoped = parsed.server
    ? tools.filter((tool) => toolMatchesServer(tool.name, parsed.server!))
    : tools;
  const needle = query.toLowerCase();
  const matches = scoped.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) ||
      (typeof tool.description === "string" && tool.description.toLowerCase().includes(needle))
  );

  printToolSummaries(matches, parsed.json, `No tools matched "${query}".`, parsed.quiet);
}

async function handleToolsCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "list") {
    await handleToolsListCommand(args.slice(1));
    return;
  }
  if (sub === "schema") {
    await handleToolsSchemaCommand(args.slice(1));
    return;
  }
  if (sub === "search") {
    await handleToolsSearchCommand(args.slice(1));
    return;
  }
  console.error(
    "Usage: callmux tools <list|schema <tool>|search <query>> [--server <name>] [--json] [--url <listener-url>]"
  );
  process.exitCode = 2;
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
      port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be a valid port (1-65535)");
      }
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

interface RuntimeConfigState {
  baseConfig: CallmuxConfig;
  effectiveConfig: CallmuxConfig;
  managementOverlay: ManagementOverlay;
}

async function loadRuntimeConfigState(
  configPath: string,
  baseConfig?: CallmuxConfig
): Promise<RuntimeConfigState> {
  const loadedBase = baseConfig ?? await loadConfig(configPath);
  const management = normalizeManagementConfig(loadedBase.management, configPath);
  const managementOverlay = management.enabled
    ? await loadManagementOverlay(management.statePath)
    : { version: 1 as const };
  return {
    baseConfig: loadedBase,
    managementOverlay,
    effectiveConfig: applyManagementOverlay(loadedBase, managementOverlay),
  };
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
    console.log(VERSION);
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

  if (args[0] === "call") {
    await handleCallCommand(args.slice(1));
    return;
  }

  if (args[0] === "parallel" || args[0] === "batch" || args[0] === "pipeline") {
    await handleMetaSugarCommand(args[0], args.slice(1));
    return;
  }

  if (args[0] === "tools") {
    await handleToolsCommand(args.slice(1));
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
      listenPort = Number(args[++i]);
      if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
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
  let baseConfig: CallmuxConfig;
  let managementOverlay: ManagementOverlay = { version: 1 };
  let activeConfigPath: string | undefined;

  if (extracted.configPath) {
    activeConfigPath = resolve(extracted.configPath);
    const runtimeState = await loadRuntimeConfigState(activeConfigPath);
    baseConfig = runtimeState.baseConfig;
    config = runtimeState.effectiveConfig;
    managementOverlay = runtimeState.managementOverlay;
  } else if (filteredArgs.includes("--")) {
    config = configFromArgs(filteredArgs);
    baseConfig = config;
  } else {
    const defaultPath = await findDefaultConfig();
    if (defaultPath) {
      activeConfigPath = resolve(defaultPath);
      const runtimeState = await loadRuntimeConfigState(activeConfigPath);
      baseConfig = runtimeState.baseConfig;
      config = runtimeState.effectiveConfig;
      managementOverlay = runtimeState.managementOverlay;
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
      configPath: activeConfigPath,
      managementBaseConfig: baseConfig,
      managementOverlay,
      upstream: proxy.getUpstream(),
      cache: proxy.getCache(),
      responseStore: proxy.getResponseStore(),
      allTools: proxy.getTools(),
      maxConcurrency: proxy.getMaxConcurrency(),
      onManagementConfigChange: async (nextConfig, trigger, nextOverlay) => {
        await applyRuntimeConfig(
          nextConfig,
          trigger,
          baseConfig,
          nextOverlay ?? managementOverlay
        );
      },
    });

    await listener.start();

    // Sentinel keeps the event loop alive even if every other ref is dropped
    // (all child transports closed, no active HTTP connections, etc.)
    const keepalive = setInterval(() => {}, 30_000);
    const staleProxyClosures = new Map<Promise<void>, AbortController>();
    let configWatcher: FSWatcher | undefined;
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let reloadInProgress = false;
    let reloadQueued = false;

    const closeStaleProxyWhenDrained = (
      staleProxy: CallmuxProxy,
      staleConfig: CallmuxConfig
    ): void => {
      const controller = new AbortController();
      const closure = drainAndCloseProxy(
        listener,
        staleProxy,
        staleConfig,
        (message) => process.stderr.write(`[callmux] ${message}\n`),
        controller.signal
      ).finally(() => {
        staleProxyClosures.delete(closure);
      });
      staleProxyClosures.set(closure, controller);
    };

    const applyRuntimeConfig = async (
      nextConfig: CallmuxConfig,
      trigger: string,
      nextBaseConfig = baseConfig,
      nextManagementOverlay = managementOverlay
    ): Promise<void> => {
      let nextProxy: CallmuxProxy | undefined;
      try {
        nextProxy = new CallmuxProxy(nextConfig);
        await nextProxy.connectUpstreams();

        const previousProxy = proxy;
        const previousConfig = config;
        listener.applyReloadedState({
          config: nextConfig,
          upstream: nextProxy.getUpstream(),
          cache: nextProxy.getCache(),
          allTools: nextProxy.getTools(),
          maxConcurrency: nextProxy.getMaxConcurrency(),
          managementBaseConfig: nextBaseConfig,
          managementOverlay: nextManagementOverlay,
        });
        listener.recordConfigReload({ ok: true });
        proxy = nextProxy;
        nextProxy = undefined;
        config = nextConfig;
        baseConfig = nextBaseConfig;
        managementOverlay = nextManagementOverlay;
        closeStaleProxyWhenDrained(previousProxy, previousConfig);
        const source = activeConfigPath ?? "runtime";
        process.stderr.write(
          `[callmux] Reloaded config from ${source} (${trigger})\n`
        );
      } catch (error) {
        if (nextProxy) {
          try { await nextProxy.close(); } catch {}
        }
        const message = error instanceof Error ? error.message : String(error);
        listener.recordConfigReload({ ok: false, error: message });
        const source = activeConfigPath ?? "runtime";
        process.stderr.write(
          `[callmux] Config reload failed (${source}, ${trigger}): ${message}\n`
        );
        throw error;
      }
    };

    const reloadConfig = async (trigger: string): Promise<void> => {
      if (!activeConfigPath) return;
      if (reloadInProgress) {
        reloadQueued = true;
        return;
      }

      reloadInProgress = true;
      let applyStarted = false;
      try {
        const runtimeState = await loadRuntimeConfigState(activeConfigPath);
        applyStarted = true;
        await applyRuntimeConfig(
          runtimeState.effectiveConfig,
          trigger,
          runtimeState.baseConfig,
          runtimeState.managementOverlay
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!applyStarted) {
          listener.recordConfigReload({ ok: false, error: message });
          process.stderr.write(
            `[callmux] Config reload failed (${activeConfigPath}, ${trigger}): ${message}\n`
          );
        }
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
      for (const controller of staleProxyClosures.values()) controller.abort();
      await Promise.allSettled([
        listener.close(),
        proxy.close(),
        ...staleProxyClosures.keys(),
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
        const watchedConfigName = basename(activeConfigPath);
        // Watch the containing directory so atomic temp-file renames do not
        // leave us attached to the replaced config inode.
        configWatcher = watch(dirname(activeConfigPath), (eventType, filename) => {
          if (
            (filename === null || filename.toString() === watchedConfigName) &&
            (eventType === "change" || eventType === "rename")
          ) {
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

    process.on("SIGINT", () => { void shutdown("SIGINT"); });
    process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
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
