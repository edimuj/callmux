import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { UpstreamManager } from "./upstream.js";
import type { CallCache } from "./cache.js";
import {
  handleParallel,
  handleBatch,
  handlePipeline,
  handleCall,
  handleCacheClear,
  handleStatus,
} from "./handlers.js";
import type { CallmuxConfig } from "./types.js";

interface SessionEntry {
  transport: Transport;
  server: Server;
}

export interface ListenerOptions {
  port: number;
  host?: string;
  config: CallmuxConfig;
  upstream: UpstreamManager;
  cache: CallCache;
  allTools: Tool[];
  maxConcurrency: number;
}

export class CallmuxListener {
  private sessions = new Map<string, SessionEntry>();
  private httpServer: ReturnType<typeof createServer> | undefined;
  private options: ListenerOptions;

  constructor(options: ListenerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { port, host = "127.0.0.1" } = this.options;

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(port, host, () => resolve());
      this.httpServer!.once("error", reject);
    });

    process.stderr.write(
      `[callmux] Listening on http://${host}:${port}\n` +
      `[callmux]   Streamable HTTP: POST/GET/DELETE /mcp\n` +
      `[callmux]   SSE (legacy):    GET /sse, POST /messages\n`
    );
  }

  async close(): Promise<void> {
    for (const [id, session] of this.sessions) {
      await session.transport.close?.();
      await session.server.close();
      this.sessions.delete(id);
    }
    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    try {
      if (path === "/mcp") {
        await this.handleStreamableHttp(req, res);
      } else if (path === "/sse" && req.method === "GET") {
        await this.handleSseConnect(req, res);
      } else if (path === "/messages" && req.method === "POST") {
        await this.handleSseMessage(req, res, url);
      } else if (path === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessions: this.sessions.size }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[callmux] HTTP error: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
      }
    }
  }

  // ─── Streamable HTTP ────────────────────────────────────────────

  private async handleStreamableHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : undefined;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (!(session.transport instanceof StreamableHTTPServerTransport)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session uses different transport" }, id: null }));
        return;
      }
      await session.transport.handleRequest(req, res, parsed);
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(parsed)) {
      let server: Server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          this.sessions.set(sid, { transport, server });
        },
      });

      transport.onclose = () => {
        const sid = (transport as StreamableHTTPServerTransport).sessionId;
        if (sid) this.sessions.delete(sid);
      };

      server = this.createSession(transport);
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: No valid session" }, id: null }));
  }

  // ─── SSE (legacy) ──────────────────────────────────────────────

  private async handleSseConnect(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const transport = new SSEServerTransport("/messages", res);
    const server = this.createSession(transport);
    this.sessions.set(transport.sessionId, { transport, server });

    res.on("close", () => {
      this.sessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  }

  private async handleSseMessage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing sessionId");
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !(session.transport instanceof SSEServerTransport)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid session");
      return;
    }

    const body = await readBody(req);
    const parsed = body ? JSON.parse(body) : undefined;
    await session.transport.handlePostMessage(req, res, parsed);
  }

  // ─── Session factory ───────────────────────────────────────────

  private createSession(transport: Transport): Server {
    const { upstream, cache, allTools, maxConcurrency, config } = this.options;

    const server = new Server(
      { name: "callmux", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: allTools,
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments;

      switch (name) {
        case "callmux_parallel":
          return handleParallel(upstream, cache, args, maxConcurrency);
        case "callmux_batch":
          return handleBatch(upstream, cache, args, maxConcurrency);
        case "callmux_pipeline":
          return handlePipeline(upstream, cache, args);
        case "callmux_call":
          return handleCall(upstream, cache, args);
        case "callmux_cache_clear":
          return handleCacheClear(cache, args);
        case "callmux_status":
          return handleStatus(upstream, cache, maxConcurrency, config.metaOnly ?? false, config.descriptionMaxLength, args);
      }

      // Proxied tool — check cache first
      const cached = cache.get(name, args);
      if (cached) return cached;

      const result = await upstream.callTool(name, args);
      cache.set(name, args, result);
      return result;
    });

    return server;
  }
}

// ─── Helpers ───────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
