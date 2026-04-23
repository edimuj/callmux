#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

interface ToolDefinition {
  name: string;
  description?: string;
}

function numberFromEnv(name: string): number {
  const value = process.env[name];
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function toolsFromEnv(): ToolDefinition[] {
  const raw = process.env.FAKE_MCP_TOOLS;
  const definitions = raw
    ? (JSON.parse(raw) as ToolDefinition[])
    : [{ name: "get_item", description: "Get a fake item" }];

  return definitions;
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

const tools = toolsFromEnv();
const startDelayMs = numberFromEnv("FAKE_MCP_START_DELAY_MS");
const callDelayMs = numberFromEnv("FAKE_MCP_CALL_DELAY_MS");
const failStart = process.env.FAKE_MCP_FAIL_START === "1";
const failCall = process.env.FAKE_MCP_FAIL_CALL === "1";

const server = new McpServer(
  {
    name: process.env.FAKE_MCP_NAME ?? "fake-mcp-server",
    version: "0.1.0",
  }
);

for (const tool of tools) {
  server.registerTool(tool.name, {
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: {
      id: z.number().optional(),
    },
  }, async (args) => {
    if (callDelayMs > 0) await delay(callDelayMs);
    if (failCall) throw new Error("fake callTool failure");
    return textResult(
      JSON.stringify({
        server: process.env.FAKE_MCP_NAME ?? "fake-mcp-server",
        tool: tool.name,
        arguments: args,
      })
    );
  });
}

if (startDelayMs > 0) await delay(startDelayMs);
if (failStart) {
  process.exit(1);
}

process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
