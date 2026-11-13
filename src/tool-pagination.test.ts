import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallmuxProxy } from "./proxy.js";
import { CallmuxBridge } from "./bridge.js";
import { listAllTools } from "./tool-discovery.js";
import { UpstreamManager } from "./upstream.js";
import type { ServerConfig } from "./types.js";

function paginatedServer() {
  const server = new Server(
    { name: "paged", version: "1" },
    { capabilities: { tools: { listChanged: true } } }
  );
  let tools: Tool[] = ["first", "second", "third"].map((name) => ({
    name, inputSchema: { type: "object" },
  }));
  const cursors: Array<string | undefined> = [];
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    cursors.push(cursor);
    const index = cursor === undefined ? 0 : ["", "opaque-two", "opaque-three"].indexOf(cursor);
    assert.ok(index >= 0, `unexpected cursor ${cursor}`);
    return {
      tools: [tools[index]],
      ...(index < 2 ? { nextCursor: ["opaque-two", "opaque-three"][index] } : {}),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: request.params.name }],
  }));
  return {
    server, cursors,
    changeLastTool() {
      tools = [...tools.slice(0, 2), { name: "replacement", inputSchema: { type: "object" } }];
    },
  };
}

function nextChange(client: Client): Promise<void> {
  return new Promise((resolve) => {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve());
  });
}

test("proxy discovers three pages at startup and refreshes changes on the last page", { timeout: 10_000 }, async () => {
  const fixture = paginatedServer();
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fixture.server.connect(serverTransport);
  const proxy = new CallmuxProxy({ servers: { paged: { command: "paged" } } });
  (proxy.getUpstream() as any).createStdioTransport = async () => transport;
  const client = new Client({ name: "proxy-pagination", version: "1" });
  const [clientTransport, proxyTransport] = InMemoryTransport.createLinkedPair();
  try {
    await proxy.start(proxyTransport);
    await client.connect(clientTransport);
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
    const initialNames = await names();
    for (const name of ["first", "second", "third"]) assert.ok(initialNames.includes(name));
    assert.deepEqual(fixture.cursors, [undefined, "opaque-two", "opaque-three"]);
    assert.notEqual((await client.callTool({ name: "third", arguments: {} })).isError, true);
    const changed = nextChange(client);
    fixture.changeLastTool();
    await fixture.server.sendToolListChanged();
    await changed;
    assert.ok((await names()).includes("replacement"));
    assert.ok(!(await names()).includes("third"));
    const call = await client.callTool({ name: "replacement", arguments: {} });
    assert.notEqual(call.isError, true);
    assert.deepEqual(fixture.cursors, [undefined, "opaque-two", "opaque-three", undefined, "opaque-two", "opaque-three"]);
  } finally {
    await client.close();
    await proxy.close();
    await fixture.server.close();
  }
});

for (const mode of ["repeat", "cycle", "unbounded", "empty-cursor", "later-error"] as const) {
  test(`tool discovery handles ${mode} pagination`, { timeout: 10_000 }, async () => {
    const server = new Server({ name: "pagination-edge", version: "1" }, { capabilities: { tools: {} } });
    let requests = 0;
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      requests++;
      if (requests > 1_000) throw new Error("fixture request budget exhausted");
      const cursor = request.params?.cursor;
      if (mode === "later-error" && cursor !== undefined) throw new Error("later page unavailable");
      const nextCursor = mode === "unbounded" ? `page-${requests}`
        : mode === "empty-cursor" ? (cursor === undefined ? "" : undefined)
        : mode === "cycle" ? (cursor === "a" ? "b" : "a")
        : "a";
      return { tools: [{ name: `tool_${requests}`, inputSchema: { type: "object" as const } }], nextCursor };
    });
    const client = new Client({ name: "pagination-edge-client", version: "1" });
    const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(transport);
    try {
      if (mode === "empty-cursor") {
        assert.deepEqual((await listAllTools(client)).tools.map((tool) => tool.name), ["tool_1", "tool_2"]);
        assert.equal(requests, 2);
      } else {
        const message = mode === "unbounded" ? /tools\/list pagination exceeded 1000 pages/
          : mode === "later-error" ? /later page unavailable/
          : /tools\/list pagination repeated cursor "a"/;
        await assert.rejects(listAllTools(client), message);
        assert.equal(requests, mode === "unbounded" ? 1_000 : mode === "cycle" ? 3 : 2);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
}

test("startup reports a cursor loop instead of exposing a partial catalog", { timeout: 10_000 }, async () => {
  const fixture = paginatedServer();
  fixture.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "partial", inputSchema: { type: "object" as const } }],
    nextCursor: "loop",
  }));
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fixture.server.connect(serverTransport);
  const upstream = new UpstreamManager();
  (upstream as any).createStdioTransport = async () => transport;
  try {
    await assert.rejects(
      upstream.connect({ paged: { command: "paged" } }, { strictStartup: true }),
      /downstream startup failed: paged: tools\/list pagination repeated cursor "loop"/
    );
    assert.deepEqual(upstream.getTools(), []);
  } finally {
    await upstream.close();
    await fixture.server.close();
  }
});

for (const scope of ["cwd", "headers"] as const) {
  test(`scoped ${scope} connections discover tools on later pages`, { timeout: 10_000 }, async () => {
    const fixtures: ReturnType<typeof paginatedServer>[] = [];
    const transports: InMemoryTransport[] = [];
    // One real SDK server for the catalog connection and one for the scoped call.
    for (let i = 0; i < 2; i++) {
      const fixture = paginatedServer();
      const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
      await fixture.server.connect(serverTransport);
      fixtures.push(fixture);
      transports.push(transport);
    }
    const upstream = new UpstreamManager();
    let connections = 0;
    const createTransport = () => {
      assert.ok(connections < transports.length, "unexpected extra connection");
      return transports[connections++];
    };
    (upstream as any).createStdioTransport = async () => createTransport();
    (upstream as any).createHttpTransport = createTransport;
    const config: ServerConfig = scope === "cwd"
      ? { command: "paged", cwdMode: "session" }
      : { url: "http://unused.invalid/mcp", transport: "streamable-http", forwardHeaders: ["x-session"] };
    try {
      await upstream.connect({ paged: config }, { strictStartup: true });
      const context = scope === "cwd"
        ? { cwd: process.cwd(), sessionId: "paged-session" }
        : { forwardedHeaders: { "x-session": "paged-session" } };
      const result = await upstream.callTool("third", {}, undefined, context);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(connections, 2);
      for (const fixture of fixtures) {
        assert.deepEqual(fixture.cursors, [undefined, "opaque-two", "opaque-three"]);
      }
    } finally {
      await upstream.close();
      for (const fixture of fixtures) await fixture.server.close();
    }
  });
}

test("bridge forwards opaque cursors and refreshes the whole paginated catalog", { timeout: 10_000 }, async () => {
  const fixture = paginatedServer();
  const upstreamClient = new Client({ name: "bridge-upstream", version: "1" });
  const [upstreamTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await fixture.server.connect(serverTransport);
  await upstreamClient.connect(upstreamTransport);
  const bridge = new CallmuxBridge({ url: "http://unused.invalid/mcp", cwd: process.cwd() });
  (bridge as any).connectUpstream = async () => {
    (bridge as any).client = upstreamClient;
    (bridge as any).installUpstreamNotificationHandlers(upstreamClient);
  };
  const client = new Client({ name: "bridge-pagination", version: "1" });
  const [clientTransport, bridgeTransport] = InMemoryTransport.createLinkedPair();
  let notifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { notifications++; });
  const readPages = async () => {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await client.listTools(cursor === undefined ? undefined : { cursor });
      names.push(...result.tools.map((tool) => tool.name));
      cursor = result.nextCursor;
      if (cursor === undefined) return names;
    }
    assert.fail("bridge pagination did not terminate");
  };
  try {
    await bridge.start(bridgeTransport);
    await client.connect(clientTransport);
    assert.deepEqual(await readPages(), ["first", "second", "third"]);
    await client.ping();
    assert.equal(notifications, 0, "browsing pages must not announce a catalog change");
    assert.deepEqual(fixture.cursors, [undefined, "opaque-two", "opaque-three"]);
    const changed = nextChange(client);
    fixture.changeLastTool();
    await fixture.server.sendToolListChanged();
    await changed;
    assert.deepEqual(await readPages(), ["first", "second", "replacement"]);

    // Each fallback must preserve the page and its continuation cursor.
    upstreamClient.listTools = async () => { throw new Error("offline"); };
    assert.deepEqual(await readPages(), ["first", "second", "replacement"]);
  } finally {
    await client.close();
    await bridge.close();
    await fixture.server.close();
  }
});
