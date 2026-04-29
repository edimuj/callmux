import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
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

const DEFAULT_REQUEST_BODY_MAX_BYTES = 1024 * 1024; // 1 MiB
const REQUEST_BODY_OVERRIDE_HEADER = "x-callmux-max-body-bytes";

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
  private globalRequestBodyMaxBytes: number;
  private allowRequestBodyMaxOverride: boolean;
  private preReadMaxBytes: number | undefined;
  private authConfig: CallmuxConfig["auth"];

  constructor(options: ListenerOptions) {
    this.options = options;
    this.authConfig = options.config.auth;
    this.globalRequestBodyMaxBytes =
      options.config.requestBodyMaxBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
    this.allowRequestBodyMaxOverride =
      options.config.allowRequestBodyMaxOverride ?? false;
    this.preReadMaxBytes = this.computePreReadMaxBytes();
    this.validateSecurityPosture();
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
      if (!this.isAuthorized(req, path)) {
        this.writeUnauthorized(res);
        return;
      }

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
      if (error instanceof PayloadTooLargeError) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      if (error instanceof InvalidRequestBodyOverrideError) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
        return;
      }
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
    const requestedLimit = this.parsePerRequestLimitOverride(req);
    const readLimit = requestedLimit === undefined
      ? this.preReadMaxBytes
      : requestedLimit === 0
        ? undefined
        : requestedLimit;
    const { body, bytes } = await readBody(req, readLimit);
    const parsed = body ? JSON.parse(body) : undefined;
    const effectiveLimit = this.resolveEffectiveRequestBodyMaxBytes(parsed, requestedLimit);
    if (effectiveLimit !== undefined && bytes > effectiveLimit) {
      throw new PayloadTooLargeError(effectiveLimit);
    }

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

    const requestedLimit = this.parsePerRequestLimitOverride(req);
    const readLimit = requestedLimit === undefined
      ? this.preReadMaxBytes
      : requestedLimit === 0
        ? undefined
        : requestedLimit;
    const { body, bytes } = await readBody(req, readLimit);
    const parsed = body ? JSON.parse(body) : undefined;
    const effectiveLimit = this.resolveEffectiveRequestBodyMaxBytes(parsed, requestedLimit);
    if (effectiveLimit !== undefined && bytes > effectiveLimit) {
      throw new PayloadTooLargeError(effectiveLimit);
    }
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

  private validateSecurityPosture(): void {
    const host = this.options.host ?? "127.0.0.1";
    const isRemote = !isLoopbackHost(host);
    const allowInsecureRemoteListener =
      this.options.config.allowInsecureRemoteListener ?? false;
    if (isRemote && !this.authConfig && !allowInsecureRemoteListener) {
      throw new Error(
        `Refusing insecure remote listener on "${host}". Configure "auth" or set allowInsecureRemoteListener=true to bypass (unsafe).`
      );
    }

    if (isRemote && !this.authConfig && allowInsecureRemoteListener) {
      process.stderr.write(
        `[callmux] WARNING: insecure remote listener enabled on "${host}" (no auth configured)\n`
      );
    }
  }

  private isAuthorized(req: IncomingMessage, path: string): boolean {
    const auth = this.authConfig;
    if (!auth) return true;

    if (path === "/health" && auth.allowUnauthenticatedHealth) {
      return true;
    }

    const rawAuthorization = headerValue(req.headers.authorization);
    if (!rawAuthorization) return false;
    const token = parseBearerToken(rawAuthorization);
    if (!token) return false;

    return auth.tokens.some((candidate) => constantTimeEquals(token, candidate.token));
  }

  private writeUnauthorized(res: ServerResponse): void {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="callmux"',
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  private computePreReadMaxBytes(): number | undefined {
    const limits: number[] = [this.globalRequestBodyMaxBytes];
    for (const server of Object.values(this.options.config.servers)) {
      if (server.requestBodyMaxBytes !== undefined) {
        limits.push(server.requestBodyMaxBytes);
      }
    }

    if (limits.some((limit) => limit === 0)) return undefined;
    return Math.max(...limits);
  }

  private parsePerRequestLimitOverride(req: IncomingMessage): number | undefined {
    const raw = headerValue(req.headers[REQUEST_BODY_OVERRIDE_HEADER]);
    if (raw === undefined) return undefined;

    if (!this.allowRequestBodyMaxOverride) {
      throw new InvalidRequestBodyOverrideError(
        `${REQUEST_BODY_OVERRIDE_HEADER} is not allowed by configuration`
      );
    }

    if (!/^\d+$/.test(raw)) {
      throw new InvalidRequestBodyOverrideError(
        `${REQUEST_BODY_OVERRIDE_HEADER} must be a non-negative integer`
      );
    }

    return Number(raw);
  }

  private resolveEffectiveRequestBodyMaxBytes(
    parsed: unknown,
    overrideLimit: number | undefined
  ): number | undefined {
    if (overrideLimit !== undefined) {
      return overrideLimit === 0 ? undefined : overrideLimit;
    }

    const serverTargets = this.extractServerTargets(parsed);
    if (serverTargets.length === 0) {
      return this.globalRequestBodyMaxBytes === 0
        ? undefined
        : this.globalRequestBodyMaxBytes;
    }

    const perTargetLimits = serverTargets.map((server) => {
      const config = this.options.config.servers[server];
      return config?.requestBodyMaxBytes ?? this.globalRequestBodyMaxBytes;
    });
    const finiteLimits = perTargetLimits.filter((limit) => limit > 0);
    if (finiteLimits.length === 0) return undefined;
    return Math.min(...finiteLimits);
  }

  private extractServerTargets(parsed: unknown): string[] {
    if (!isRecord(parsed)) return [];
    if (parsed.method !== "tools/call") return [];
    if (!isRecord(parsed.params)) return [];

    const name = typeof parsed.params.name === "string" ? parsed.params.name : undefined;
    if (!name) return [];
    const args = parsed.params.arguments;

    const targets = new Set<string>();
    const addTarget = (target: unknown): void => {
      if (typeof target === "string" && target.length > 0) {
        targets.add(target);
      }
    };
    const addQualifiedToolTarget = (toolName: unknown): void => {
      if (typeof toolName !== "string") return;
      const target = inferServerFromQualifiedToolName(toolName);
      if (target) targets.add(target);
    };

    if (name === "callmux_call" && isRecord(args)) {
      addTarget(args.server);
      addQualifiedToolTarget(args.tool);
    } else if (name === "callmux_batch" && isRecord(args)) {
      addTarget(args.server);
      addQualifiedToolTarget(args.tool);
    } else if (name === "callmux_parallel" && isRecord(args) && Array.isArray(args.calls)) {
      for (const call of args.calls) {
        if (!isRecord(call)) continue;
        addTarget(call.server);
        addQualifiedToolTarget(call.tool);
      }
    } else if (name === "callmux_pipeline" && isRecord(args) && Array.isArray(args.steps)) {
      for (const step of args.steps) {
        if (!isRecord(step)) continue;
        addTarget(step.server);
        addQualifiedToolTarget(step.tool);
      }
    } else {
      addQualifiedToolTarget(name);
    }

    return Array.from(targets);
  }
}

// ─── Helpers ───────────────────────────────────────────────────

class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`payload exceeds ${limitBytes} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

class InvalidRequestBodyOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestBodyOverrideError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inferServerFromQualifiedToolName(toolName: string): string | undefined {
  const separator = toolName.indexOf("__");
  if (separator <= 0) return undefined;
  return toolName.slice(0, separator);
}

function headerValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}

function parseBearerToken(authorization: string): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1];
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function readBody(
  req: IncomingMessage,
  maxBytes?: number
): Promise<{ body: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;
    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      totalBytes += chunk.length;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        exceeded = true;
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      resolve({ body: Buffer.concat(chunks).toString("utf-8"), bytes: totalBytes });
    });
    req.on("error", reject);
  });
}
