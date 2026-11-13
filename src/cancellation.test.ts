import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CallmuxBridge } from "./bridge.js";
import { createListener } from "./library.js";
import { CallmuxProxy } from "./proxy.js";
import type { CallmuxConfig } from "./types.js";

const call = { tool: "slow", arguments: {} };
const requests = [
  { name: "slow", arguments: {}, activeCalls: 1 },
  { name: "callmux_call", arguments: call, activeCalls: 1 },
  { name: "callmux_parallel", arguments: { calls: [call, call] }, activeCalls: 2 },
  { name: "callmux_batch", arguments: { tool: "slow", items: [{ arguments: {} }, { arguments: {} }] }, activeCalls: 2 },
  { name: "callmux_pipeline", arguments: { steps: [call, { tool: "finish", arguments: {} }] }, activeCalls: 1 },
];

for (const path of ["proxy", "bridge"] as const) {
  for (const request of requests) {
    test(`${path} propagates client cancellation for ${request.name}`, { timeout: 15_000 }, async (t) => {
      const cleanups: Array<() => Promise<void>> = [];
      t.after(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
      });
      const events = new EventEmitter();
      let started = 0;
      let cancelled = 0;
      let finished = 0;
      const downstream = new Server(
        { name: "cancellation-downstream", version: "1.0" },
        { capabilities: { tools: {} } }
      );
      downstream.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: ["slow", "finish"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      }));
      downstream.setRequestHandler(CallToolRequestSchema, async (incoming, extra) => {
        if (incoming.params.name === "finish") {
          finished++;
          return { content: [{ type: "text", text: "finished" }] };
        }
        const aborted = once(extra.signal, "abort");
        if (++started === request.activeCalls) events.emit("started");
        await aborted;
        if (++cancelled === request.activeCalls) events.emit("cancelled");
        return { content: [{ type: "text", text: "cancelled" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await downstream.connect(transport);
      const http = createServer((req, res) => {
        void transport.handleRequest(req, res).catch((error) => res.destroy(error));
      });
      cleanups.push(async () => {
        await downstream.close();
        http.closeAllConnections();
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      const address = http.address();
      assert.ok(address && typeof address === "object");
      const config: CallmuxConfig = {
        servers: { downstream: { url: `http://127.0.0.1:${address.port}/mcp` } },
        cacheTtlSeconds: 0,
        dashboard: { enabled: false },
      };
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      if (path === "proxy") {
        const proxy = new CallmuxProxy(config);
        cleanups.push(() => proxy.close());
        await proxy.start(serverTransport);
      } else {
        const listener = await createListener({ port: 0, config });
        cleanups.push(() => listener.stop());
        const bridge = new CallmuxBridge({ url: listener.mcpUrl, cwd: process.cwd() });
        cleanups.push(() => bridge.close());
        await bridge.start(serverTransport);
      }
      const client = new Client({ name: "cancellation-client", version: "1.0" });
      cleanups.push(() => client.close());
      await client.connect(clientTransport);

      const allStarted = once(events, "started", { signal: t.signal });
      const allCancelled = once(events, "cancelled", { signal: t.signal });
      // Attach the rejection handler before cancelling; the client's rejection
      // alone cannot prove that downstream execution stopped.
      const controller = new AbortController();
      const pending = client.callTool(
        { name: request.name, arguments: request.arguments },
        undefined,
        { signal: controller.signal }
      );
      const rejected = assert.rejects(pending, /client cancelled the call/);
      await allStarted;
      controller.abort(new Error("client cancelled the call"));
      await rejected;
      await allCancelled;
      assert.equal(cancelled, request.activeCalls);

      // A subsequent round trip also proves cancellation left the connection usable.
      const result = await client.callTool({ name: "finish", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.equal(finished, 1, "a cancelled pipeline must not execute its next step");
    });
  }
}
