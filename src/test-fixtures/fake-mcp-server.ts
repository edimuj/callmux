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

type CallMode = "ok" | "throw" | "tool_error" | "exit" | "hang" | "large_result";

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
const callModeEnv = process.env.FAKE_MCP_CALL_MODE;
const callMode: CallMode = (
  callModeEnv === "ok" ||
  callModeEnv === "throw" ||
  callModeEnv === "tool_error" ||
  callModeEnv === "exit" ||
  callModeEnv === "hang" ||
  callModeEnv === "large_result"
)
  ? callModeEnv
  : (failCall ? "throw" : "ok");
const toolErrorMessage = process.env.FAKE_MCP_TOOL_ERROR_MESSAGE ?? "fake tool error";
const largeResultItemCount = numberFromEnv("FAKE_MCP_LARGE_ITEM_COUNT") || 120;

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
    if (callMode === "hang") {
      return await new Promise<CallToolResult>(() => {});
    }
    if (callMode === "exit") {
      process.exit(1);
    }
    if (callMode === "throw") throw new Error("fake callTool failure");
    if (callMode === "tool_error") return {
      isError: true,
      content: [{ type: "text", text: toolErrorMessage }],
    };
    if (callMode === "large_result") {
      const items = Array.from({ length: largeResultItemCount }, (_, index) => ({
        id: index + 1,
        name: `item-${index + 1}`,
        body: "x".repeat(200),
      }));
      return textResult(JSON.stringify(items));
    }
    return textResult(
      JSON.stringify({
        server: process.env.FAKE_MCP_NAME ?? "fake-mcp-server",
        tool: tool.name,
        arguments: args,
        cwd: process.cwd(),
      })
    );
  });
}

// FAKE_MCP_MUTABLE=1 exposes `mutate_tools`, which changes the catalog at
// runtime; McpServer then sends notifications/tools/list_changed itself.
if (process.env.FAKE_MCP_MUTABLE === "1") {
  const echo = (tool: string) => async (args: unknown) => textResult(
    JSON.stringify({ server: process.env.FAKE_MCP_NAME ?? "fake-mcp-server", tool, arguments: args })
  );
  const mutable = server.registerTool("mutable_tool", {
    description: "Tool whose schema can change",
    inputSchema: { id: z.number().optional() },
  }, echo("mutable_tool"));
  server.registerTool("mutate_tools", {
    inputSchema: { action: z.enum(["add_tool", "change_schema"]) },
  }, async ({ action }) => {
    if (action === "add_tool") {
      server.registerTool("added_tool", {
        description: "Tool added after connect",
        inputSchema: { query: z.string() },
      }, echo("added_tool"));
    } else {
      mutable.update({ paramsSchema: { id: z.number().optional(), label: z.string() } });
    }
    return textResult(action);
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
