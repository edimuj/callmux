#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallmuxProxy } from "../proxy.js";
import { loadConfig, configFromArgs } from "../config.js";

const HELP = `
callmux — Multiplexer for MCP tool calls

Wraps any MCP server and adds parallel execution, batching, caching,
and pipelining. Claude (or any MCP client) connects to callmux, which
proxies to downstream servers and exposes meta-tools alongside them.

Usage:
  callmux --config <path>                    Config file mode
  callmux [options] -- <command> [args...]   Single-server mode

Options:
  --config <path>       Path to callmux config or .mcp.json file
  --cache <seconds>     Cache TTL for read operations (default: 0 = off)
  --concurrency <n>     Max parallel calls (default: 20)
  --help, -h            Show this help

Config file format:
  {
    "servers": {
      "github": { "command": "gh-mcp", "args": ["--token", "..."] },
      "jira":   { "command": "jira-mcp" }
    },
    "cacheTtlSeconds": 60,
    "maxConcurrency": 20
  }

Also accepts MCP-compatible format:
  { "mcpServers": { ... } }

Examples:
  callmux --config callmux.json
  callmux --cache 60 -- node my-mcp-server.js
  callmux -- npx -y @modelcontextprotocol/server-github

Meta-tools exposed:
  callmux_parallel      Execute N tool calls concurrently
  callmux_batch         Apply one tool across many items
  callmux_pipeline      Chain tool calls with output mapping
  callmux_cache_clear   Clear result cache

See https://github.com/edimuj/callmux for full documentation.
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  let config;

  const configIdx = args.indexOf("--config");
  if (configIdx !== -1 && configIdx + 1 < args.length) {
    config = await loadConfig(args[configIdx + 1]);
  } else if (args.includes("--")) {
    config = configFromArgs(args);
  } else {
    console.error("Error: specify --config <path> or -- <command> [args...]");
    console.error("Run callmux --help for usage.");
    process.exit(1);
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
