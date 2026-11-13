import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallmuxProxy } from "./proxy.js";
import type { ServerConfig, StdioServerConfig } from "./types.js";

test("proxy keeps list_changed while another downstream is still starting", async () => {
  const fast = new Server(
    { name: "fast", version: "1.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  const slow = new Server(
    { name: "slow", version: "1.0" },
    { capabilities: { tools: {} } }
  );
  let fastTools: Tool[] = [{ name: "original_tool", inputSchema: { type: "object" } }];
  let fastLists = 0;
  fast.setRequestHandler(ListToolsRequestSchema, async () => {
    fastLists++;
    return { tools: fastTools };
  });
  fast.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: request.params.name }],
  }));
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  let markSlowStarting!: () => void;
  const slowStarting = new Promise<void>((resolve) => { markSlowStarting = resolve; });
  slow.setRequestHandler(ListToolsRequestSchema, async () => {
    markSlowStarting();
    await slowGate;
    return { tools: [] };
  });
  const [fastTransport, fastServerTransport] = InMemoryTransport.createLinkedPair();
  const [slowTransport, slowServerTransport] = InMemoryTransport.createLinkedPair();
  await fast.connect(fastServerTransport);
  await slow.connect(slowServerTransport);

  const proxy = new CallmuxProxy({
    servers: { fast: { command: "fast" }, slow: { command: "slow" } },
    metaOnly: true,
  });
  const upstream = proxy.getUpstream();
  const harness = upstream as unknown as {
    createStdioTransport: (config: StdioServerConfig) => Promise<InMemoryTransport>;
    connectOne: (name: string, config: ServerConfig, timeout: number) => Promise<unknown>;
  };
  harness.createStdioTransport = async (config) =>
    config.command === "fast" ? fastTransport : slowTransport;
  // Observe the real fast connection finishing, without installing it early.
  const connectOne = harness.connectOne.bind(upstream);
  let markFastConnected!: () => void;
  const fastConnected = new Promise<void>((resolve) => { markFastConnected = resolve; });
  harness.connectOne = async (name, config, timeout) => {
    const connected = await connectOne(name, config, timeout);
    if (name === "fast") markFastConnected();
    return connected;
  };

  const client = new Client({ name: "startup-test", version: "1.0" }, { capabilities: {} });
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
  const starting = proxy.start(proxyTransport);
  try {
    await Promise.all([fastConnected, slowStarting]);
    assert.equal(upstream.getServerInfo("fast")?.state, "starting");
    assert.equal(upstream.getServerInfo("slow")?.state, "starting");

    assert.equal(fastLists, 1);
    fastTools = [...fastTools, { name: "added_tool", inputSchema: { type: "object" } }];
    await fast.sendToolListChanged();
    await fast.sendToolListChanged();
    // A round trip ensures the notification arrived before slow is released.
    await fast.ping();
    assert.equal(fastLists, 1);
    releaseSlow();
    await starting;
    await client.connect(clientTransport);

    const search = await client.callTool({
      name: "callmux_search_tools",
      arguments: { query: "added_tool" },
    }) as CallToolResult;
    const found = (search.structuredContent as { results: Array<{ tool: string }> }).results;
    assert.ok(found.some((result) => result.tool === "fast__added_tool"));

    const call = await client.callTool({
      name: "callmux_call",
      arguments: { tool: "added_tool", arguments: {} },
    }) as CallToolResult;
    assert.notEqual(call.isError, true);
    assert.match(JSON.stringify(call.content), /added_tool/);
    assert.equal(fastLists, 2);
  } finally {
    releaseSlow();
    await starting.catch(() => undefined);
    await client.close();
    await proxy.close();
    await fast.close();
    await slow.close();
  }
});
