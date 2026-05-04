import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
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
  handleDryRun,
  handleRecipeRun,
  handleRecipeDryRun,
  expandRecipeInvocation,
  handleCacheClear,
  handleStatus,
} from "./handlers.js";
import type { CallmuxConfig } from "./types.js";
import type { ToolCallContext } from "./types.js";
import type { ListenerRuntimeDiagnostics } from "./types.js";
import { authenticateBearerToken } from "./auth.js";
import { OidcJwtVerifier } from "./oidc.js";
import {
  evaluateToolAuthorization,
  type AuthorizationPrincipal,
} from "./authorization.js";
import { errorResult } from "./results.js";
import { AbuseController } from "./abuse.js";
import { AuditLogger } from "./audit.js";
import { PrometheusMetrics } from "./metrics.js";

const DEFAULT_REQUEST_BODY_MAX_BYTES = 1024 * 1024; // 1 MiB
const REQUEST_BODY_OVERRIDE_HEADER = "x-callmux-max-body-bytes";
const REQUEST_ID_HEADER = "x-request-id";
const CWD_HEADER = "x-callmux-cwd";

interface SessionEntry {
  transport: Transport;
  server: Server;
  cwd?: string;
  cwdSource?: "header" | "meta" | "roots";
  rootsAttempted?: boolean;
}

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  startTimeMs: number;
  remoteIp?: string;
  principal?: AuthorizationPrincipal;
  payload?: unknown;
}

type JsonRpcId = string | number | null;

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
  private oidcVerifier: OidcJwtVerifier | undefined;
  private authzContext = new AsyncLocalStorage<AuthorizationPrincipal | undefined>();
  private abuseController: AbuseController | undefined;
  private auditLogger: AuditLogger;
  private metrics: PrometheusMetrics;

  constructor(options: ListenerOptions) {
    this.options = options;
    this.authConfig = options.config.auth;
    this.globalRequestBodyMaxBytes =
      options.config.requestBodyMaxBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
    this.allowRequestBodyMaxOverride =
      options.config.allowRequestBodyMaxOverride ?? false;
    if (this.authConfig?.mode === "oidc_jwt") {
      this.oidcVerifier = new OidcJwtVerifier(this.authConfig);
    }
    if (options.config.abuseControls) {
      this.abuseController = new AbuseController(options.config.abuseControls);
    }
    this.auditLogger = new AuditLogger(options.config.auditLog);
    this.metrics = new PrometheusMetrics(options.config.metrics);
    this.preReadMaxBytes = this.computePreReadMaxBytes();
    this.validateSecurityPosture(options.config, this.authConfig);
  }

  applyRuntimeConfig(config: CallmuxConfig): void {
    const nextAuthConfig = config.auth;
    const nextGlobalRequestBodyMaxBytes =
      config.requestBodyMaxBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
    const nextAllowRequestBodyMaxOverride =
      config.allowRequestBodyMaxOverride ?? false;
    const nextOidcVerifier =
      nextAuthConfig?.mode === "oidc_jwt"
        ? new OidcJwtVerifier(nextAuthConfig)
        : undefined;
    const nextAbuseController = config.abuseControls
      ? new AbuseController(config.abuseControls)
      : undefined;
    const nextAuditLogger = new AuditLogger(config.auditLog);
    const nextMetrics = new PrometheusMetrics(config.metrics);

    this.validateSecurityPosture(config, nextAuthConfig);

    this.options = {
      ...this.options,
      config,
    };
    this.authConfig = nextAuthConfig;
    this.globalRequestBodyMaxBytes = nextGlobalRequestBodyMaxBytes;
    this.allowRequestBodyMaxOverride = nextAllowRequestBodyMaxOverride;
    this.oidcVerifier = nextOidcVerifier;
    this.abuseController = nextAbuseController;
    this.auditLogger = nextAuditLogger;
    this.metrics = nextMetrics;
    this.preReadMaxBytes = this.computePreReadMaxBytes();
  }

  getRuntimeDiagnostics(): ListenerRuntimeDiagnostics {
    const scopedClients = this.options.upstream.getScopedStdioClientDiagnostics();
    const byServer: Record<string, number> = {};
    for (const client of scopedClients) {
      byServer[client.server] = (byServer[client.server] ?? 0) + 1;
    }

    return {
      activeSessions: this.sessions.size,
      sessions: Array.from(this.sessions.entries())
        .map(([id, session]) => ({
          id,
          transport: this.transportName(session.transport),
          ...(session.cwd ? { cwd: session.cwd } : {}),
          ...(session.cwdSource ? { cwdSource: session.cwdSource } : {}),
          rootsAttempted: session.rootsAttempted === true,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      scopedStdioClients: {
        total: scopedClients.length,
        byServer,
        items: scopedClients,
      },
    };
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
    const requestId = this.resolveRequestId(req);
    const method = (req.method ?? "GET").toUpperCase();
    const context: RequestContext = {
      requestId,
      method,
      path,
      startTimeMs: Date.now(),
      remoteIp: req.socket.remoteAddress ?? undefined,
    };

    this.metrics.onRequestStart();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    this.attachRequestCompletion(res, context);

    try {
      if (!this.isSourceIpAllowed(req)) {
        this.writeForbidden(res, context, "Source IP is not allowed");
        return;
      }

      const preAuthAbuseLease = this.acquireAbuseLease(req, path, undefined, {
        includeGlobalRate: true,
        includePrincipalLimits: false,
      });
      if (!preAuthAbuseLease.allowed) {
        this.writeTooManyRequests(
          res,
          context,
          preAuthAbuseLease.reason,
          preAuthAbuseLease.retryAfterSeconds
        );
        return;
      }

      const principal = await this.authenticateRequest(req, path);
      if (principal === null) {
        this.writeUnauthorized(res, context);
        return;
      }
      context.principal = principal ?? undefined;

      const postAuthAbuseLease = this.acquireAbuseLease(req, path, principal, {
        includeGlobalRate: false,
        includePrincipalLimits: true,
      });
      if (!postAuthAbuseLease.allowed) {
        this.writeTooManyRequests(
          res,
          context,
          postAuthAbuseLease.reason,
          postAuthAbuseLease.retryAfterSeconds
        );
        return;
      }
      if (postAuthAbuseLease.release) {
        this.attachLeaseRelease(res, postAuthAbuseLease.release);
      }

      await this.authzContext.run(principal ?? undefined, async () => {
        if (path === "/mcp") {
          await this.handleStreamableHttp(req, res, context);
        } else if (
          this.metrics.isEnabled() &&
          path === this.metrics.getPath() &&
          method === "GET"
        ) {
          this.handleMetrics(res, context);
        } else if (path === "/sse" && req.method === "GET") {
          await this.handleSseConnect(req, res, context);
        } else if (path === "/messages" && req.method === "POST") {
          await this.handleSseMessage(req, res, url, context);
        } else if (path === "/health" && req.method === "GET") {
          this.writeJson(res, 200, context, { status: "ok", sessions: this.sessions.size });
        } else {
          this.writeJson(res, 404, context, { error: "Not found" });
        }
      });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        this.writeJson(res, 413, context, {
          error: "Payload too large",
          requestId: context.requestId,
        });
        return;
      }
      if (error instanceof InvalidRequestBodyOverrideError) {
        this.writeJson(res, 400, context, {
          error: error.message,
          requestId: context.requestId,
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[callmux] HTTP error (${context.requestId}): ${message}\n`
      );
      if (!res.headersSent) {
        this.writeJsonRpcError(res, 500, context, -32603, "Internal server error");
      }
    }
  }

  // ─── Streamable HTTP ────────────────────────────────────────────

  private async handleStreamableHttp(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext
  ): Promise<void> {
    const requestedLimit = this.parsePerRequestLimitOverride(req);
    const readLimit = requestedLimit === undefined
      ? this.preReadMaxBytes
      : requestedLimit === 0
        ? undefined
        : requestedLimit;
    const { body, bytes } = await readBody(req, readLimit);
    const parsed = this.parseJsonBody(body);
    if (parsed === INVALID_JSON_BODY) {
      this.writeJsonRpcError(res, 400, context, -32700, "Parse error");
      return;
    }
    const jsonRpcId = this.extractJsonRpcId(parsed);
    context.payload = parsed;
    const effectiveLimit = this.resolveEffectiveRequestBodyMaxBytes(parsed, requestedLimit);
    if (effectiveLimit !== undefined && bytes > effectiveLimit) {
      throw new PayloadTooLargeError(effectiveLimit);
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      if (!(session.transport instanceof StreamableHTTPServerTransport)) {
        this.writeJsonRpcError(
          res,
          400,
          context,
          -32000,
          "Session uses different transport",
          jsonRpcId
        );
        return;
      }
      this.setSessionCwdFromHeader(session, req);
      await session.transport.handleRequest(req, res, parsed);
      return;
    }

    if (sessionId && !this.sessions.has(sessionId)) {
      this.writeJsonRpcError(
        res,
        400,
        context,
        -32000,
        "Bad Request: Unknown session. Re-initialize and retry with a new MCP-Session-Id.",
        jsonRpcId
      );
      return;
    }

    if (!sessionId && req.method === "POST" && isInitializeRequest(parsed)) {
      let server: Server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          this.sessions.set(sid, {
            transport,
            server,
            ...this.sessionCwdFromHeader(req),
          });
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

    this.writeJsonRpcError(
      res,
      400,
      context,
      -32000,
      "Bad Request: No valid session. Send initialize first, then include MCP-Session-Id.",
      jsonRpcId
    );
  }

  private transportName(transport: Transport): "streamable-http" | "sse" | "unknown" {
    if (transport instanceof StreamableHTTPServerTransport) return "streamable-http";
    if (transport instanceof SSEServerTransport) return "sse";
    return "unknown";
  }

  // ─── SSE (legacy) ──────────────────────────────────────────────

  private async handleSseConnect(
    req: IncomingMessage,
    res: ServerResponse,
    _context: RequestContext
  ): Promise<void> {
    const transport = new SSEServerTransport("/messages", res);
    const server = this.createSession(transport);
    this.sessions.set(transport.sessionId, {
      transport,
      server,
      ...this.sessionCwdFromHeader(req),
    });

    res.on("close", () => {
      this.sessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  }

  private async handleSseMessage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    context: RequestContext
  ): Promise<void> {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      this.writeJson(res, 400, context, {
        error: "Missing sessionId",
        requestId: context.requestId,
      });
      return;
    }

    const session = this.sessions.get(sessionId);
    if (!session || !(session.transport instanceof SSEServerTransport)) {
      this.writeJson(res, 400, context, {
        error: "Invalid session",
        requestId: context.requestId,
      });
      return;
    }
    this.setSessionCwdFromHeader(session, req);

    const requestedLimit = this.parsePerRequestLimitOverride(req);
    const readLimit = requestedLimit === undefined
      ? this.preReadMaxBytes
      : requestedLimit === 0
        ? undefined
        : requestedLimit;
    const { body, bytes } = await readBody(req, readLimit);
    const parsed = this.parseJsonBody(body);
    if (parsed === INVALID_JSON_BODY) {
      this.writeJson(res, 400, context, {
        error: "Invalid JSON body",
        requestId: context.requestId,
      });
      return;
    }
    context.payload = parsed;
    const effectiveLimit = this.resolveEffectiveRequestBodyMaxBytes(parsed, requestedLimit);
    if (effectiveLimit !== undefined && bytes > effectiveLimit) {
      throw new PayloadTooLargeError(effectiveLimit);
    }
    await session.transport.handlePostMessage(req, res, parsed);
  }

  private normalizeSessionCwd(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed || !isAbsolute(trimmed)) return undefined;
    return trimmed;
  }

  private sessionCwdFromHeader(
    req: IncomingMessage
  ): Pick<SessionEntry, "cwd" | "cwdSource"> {
    const cwd = this.normalizeSessionCwd(headerValue(req.headers[CWD_HEADER]));
    return cwd ? { cwd, cwdSource: "header" } : {};
  }

  private setSessionCwdFromHeader(session: SessionEntry, req: IncomingMessage): void {
    const cwd = this.normalizeSessionCwd(headerValue(req.headers[CWD_HEADER]));
    if (!cwd) return;
    session.cwd = cwd;
    session.cwdSource = "header";
  }

  private cwdFromMeta(meta: unknown): string | undefined {
    if (!isRecord(meta)) return undefined;
    const callmux = isRecord(meta.callmux) ? meta.callmux : undefined;
    return this.normalizeSessionCwd(
      callmux?.cwd ?? meta["callmux.cwd"] ?? meta.cwd ?? meta.workingDirectory
    );
  }

  private cwdFromRoots(roots: unknown): string | undefined {
    if (!Array.isArray(roots)) return undefined;
    for (const root of roots) {
      if (!isRecord(root) || typeof root.uri !== "string") continue;
      if (!root.uri.startsWith("file:")) continue;
      try {
        const cwd = this.normalizeSessionCwd(fileURLToPath(root.uri));
        if (cwd) return cwd;
      } catch {}
    }
    return undefined;
  }

  private async resolveToolCallContext(
    session: SessionEntry | undefined,
    server: Server,
    extra: { _meta?: unknown; sessionId?: string; sendRequest?: unknown }
  ): Promise<ToolCallContext> {
    const context: ToolCallContext = {
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    };

    const metaCwd = this.cwdFromMeta(extra._meta);
    if (session && metaCwd) {
      session.cwd = metaCwd;
      session.cwdSource = "meta";
    }

    if (session?.cwd) {
      return { ...context, cwd: session.cwd };
    }

    if (!session || session.rootsAttempted || !server.getClientCapabilities()?.roots) {
      return context;
    }

    session.rootsAttempted = true;
    try {
      const result = await server.listRoots(undefined, { timeout: 1_000 });
      const cwd = this.cwdFromRoots(result.roots);
      if (cwd) {
        session.cwd = cwd;
        session.cwdSource = "roots";
        return { ...context, cwd };
      }
    } catch {}

    return context;
  }

  private bareToolCallContext(extra: { sessionId?: string }): ToolCallContext {
    return {
      ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    };
  }

  private toolRequestNeedsSessionCwd(
    upstream: UpstreamManager,
    name: string,
    args: unknown
  ): boolean {
    const targetUsesSessionCwd = (tool: unknown, server: unknown): boolean => {
      if (typeof tool !== "string" || tool.length === 0) return false;
      return upstream.usesSessionCwd(
        tool,
        typeof server === "string" && server.length > 0 ? server : undefined
      );
    };

    if (name === "callmux_status" || name === "callmux_cache_clear") {
      return false;
    }

    if (name === "callmux_call") {
      return isRecord(args) && targetUsesSessionCwd(args.tool, args.server);
    }

    if (name === "callmux_parallel") {
      if (!isRecord(args) || !Array.isArray(args.calls)) return false;
      return args.calls.some((call) =>
        isRecord(call) && targetUsesSessionCwd(call.tool, call.server)
      );
    }

    if (name === "callmux_batch") {
      return isRecord(args) && targetUsesSessionCwd(args.tool, args.server);
    }

    if (name === "callmux_pipeline") {
      if (!isRecord(args) || !Array.isArray(args.steps)) return false;
      return args.steps.some((step) =>
        isRecord(step) && targetUsesSessionCwd(step.tool, step.server)
      );
    }

    if (name === "callmux_dry_run") {
      if (!isRecord(args)) return false;
      if (targetUsesSessionCwd(args.tool, args.server)) return true;
      if (Array.isArray(args.calls)) {
        return args.calls.some((call) =>
          isRecord(call) && targetUsesSessionCwd(call.tool, call.server)
        );
      }
      if (Array.isArray(args.steps)) {
        return args.steps.some((step) =>
          isRecord(step) && targetUsesSessionCwd(step.tool, step.server)
        );
      }
      return false;
    }

    if (name === "callmux_recipe_run" || name === "callmux_recipe_dry_run") {
      const expanded = expandRecipeInvocation(this.options.config.recipes, args);
      if (!isRecord(expanded) || !isRecord(expanded.args)) return false;
      const recipeArgs = expanded.args;
      if (targetUsesSessionCwd(recipeArgs.tool, recipeArgs.server)) return true;
      if (Array.isArray(recipeArgs.calls)) {
        return recipeArgs.calls.some((call) =>
          isRecord(call) && targetUsesSessionCwd(call.tool, call.server)
        );
      }
      if (Array.isArray(recipeArgs.steps)) {
        return recipeArgs.steps.some((step) =>
          isRecord(step) && targetUsesSessionCwd(step.tool, step.server)
        );
      }
      return false;
    }

    return upstream.usesSessionCwd(name);
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

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const args = request.params.arguments;
      const principal = this.authzContext.getStore();
      const authz = this.authorizeToolCall(name, args, principal);
      if (!authz.allowed) {
        return errorResult("authorization_denied", "Authorization policy denied tool call", {
          code: authz.code,
          reason: authz.reason,
          ...(authz.ruleId ? { ruleId: authz.ruleId } : {}),
          ...(authz.tool ? { tool: authz.tool } : {}),
        });
      }
      const session = extra.sessionId ? this.sessions.get(extra.sessionId) : undefined;
      const toolContext = this.toolRequestNeedsSessionCwd(upstream, name, args)
        ? await this.resolveToolCallContext(session, server, extra)
        : this.bareToolCallContext(extra);

      switch (name) {
        case "callmux_parallel":
          return handleParallel(upstream, cache, args, maxConcurrency, toolContext);
        case "callmux_batch":
          return handleBatch(upstream, cache, args, maxConcurrency, toolContext);
        case "callmux_pipeline":
          return handlePipeline(upstream, cache, args, toolContext);
        case "callmux_call":
          return handleCall(upstream, cache, args, toolContext);
        case "callmux_cache_clear":
          return handleCacheClear(cache, args);
        case "callmux_dry_run":
          return handleDryRun(upstream, cache, args, toolContext);
        case "callmux_recipe_run":
          return handleRecipeRun(
            upstream,
            cache,
            config.recipes,
            args,
            maxConcurrency,
            toolContext
          );
        case "callmux_recipe_dry_run":
          return handleRecipeDryRun(
            upstream,
            cache,
            config.recipes,
            args,
            toolContext
          );
        case "callmux_status":
          return handleStatus(
            upstream,
            cache,
            maxConcurrency,
            config.metaOnly ?? false,
            config.descriptionMaxLength,
            upstream.getInstanceIdentity(),
            args,
            this.getRuntimeDiagnostics(),
            config.recipes
          );
      }

      // Proxied tool — check cache first
      const cacheScope = upstream.cacheScopeForCall(name, undefined, toolContext);
      const cached = cache.get(name, args, undefined, cacheScope);
      if (cached) return cached;

      const result = await upstream.callTool(name, args, undefined, toolContext);
      cache.set(name, args, result, undefined, cacheScope);
      return result;
    });

    return server;
  }

  private validateSecurityPosture(
    config: CallmuxConfig,
    authConfig: CallmuxConfig["auth"]
  ): void {
    const host = this.options.host ?? "127.0.0.1";
    const isRemote = !isLoopbackHost(host);
    const allowInsecureRemoteListener =
      config.allowInsecureRemoteListener ?? false;
    if (isRemote && !authConfig && !allowInsecureRemoteListener) {
      throw new Error(
        `Refusing insecure remote listener on "${host}". Configure "auth" or set allowInsecureRemoteListener=true to bypass (unsafe).`
      );
    }

    if (isRemote && !authConfig && allowInsecureRemoteListener) {
      process.stderr.write(
        `[callmux] WARNING: insecure remote listener enabled on "${host}" (no auth configured)\n`
      );
    }
  }

  private async authenticateRequest(
    req: IncomingMessage,
    path: string
  ): Promise<AuthorizationPrincipal | undefined | null> {
    const auth = this.authConfig;
    if (!auth) return undefined;

    const allowUnauthenticatedMetrics =
      this.metrics.isEnabled() &&
      this.metrics.allowUnauthenticated() &&
      path === this.metrics.getPath();
    if (
      (path === "/health" && auth.allowUnauthenticatedHealth) ||
      allowUnauthenticatedMetrics
    ) {
      return undefined;
    }

    const rawAuthorization = headerValue(req.headers.authorization);
    if (!rawAuthorization) return null;
    const token = parseBearerToken(rawAuthorization);
    if (!token) return null;

    if (auth.mode === "bearer") {
      return authenticateBearerToken(token, auth) ?? null;
    }

    if (!this.oidcVerifier) return null;
    return (await this.oidcVerifier.verify(token)) ?? null;
  }

  private resolveRequestId(req: IncomingMessage): string {
    const incoming = headerValue(req.headers[REQUEST_ID_HEADER]);
    if (incoming && incoming.trim().length > 0) {
      return incoming.trim();
    }
    return randomUUID();
  }

  private attachRequestCompletion(
    res: ServerResponse,
    context: RequestContext
  ): void {
    let completed = false;
    const finalize = () => {
      if (completed) return;
      completed = true;
      const durationMs = Date.now() - context.startTimeMs;
      this.metrics.onRequestComplete({
        method: context.method,
        path: context.path,
        status: res.statusCode,
        durationMs,
      });
      this.auditLogger.writeRequestEvent({
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        status: res.statusCode,
        durationMs,
        ...(context.remoteIp ? { remoteIp: context.remoteIp } : {}),
        ...(context.principal ? { principal: context.principal } : {}),
        ...(context.payload !== undefined ? { payload: context.payload } : {}),
      });
    };

    res.once("finish", finalize);
    res.once("close", finalize);
  }

  private authorizeToolCall(
    name: string,
    args: unknown,
    principal: AuthorizationPrincipal | undefined
  ) {
    if (!this.options.config.authorization) {
      return {
        allowed: true,
        code: "authorization_disabled",
        reason: "Authorization policy is not configured",
      };
    }

    const targets = this.extractAuthorizationTargets(name, args);
    if (!targets) {
      return {
        allowed: false,
        code: "authorization_ambiguous_target",
        reason: "Unable to resolve concrete tool targets for authorization",
      };
    }

    return evaluateToolAuthorization(
      this.options.config.authorization,
      principal,
      targets
    );
  }

  private extractAuthorizationTargets(
    name: string,
    args: unknown
  ): string[] | undefined {
    const resolveTarget = (
      toolName: unknown,
      serverHint: unknown
    ): string | null | undefined => {
      if (typeof toolName !== "string" || toolName.trim().length === 0) return undefined;
      if (typeof serverHint === "string" && serverHint.length > 0) {
        const prefix = `${serverHint}__`;
        const actualName = toolName.startsWith(prefix)
          ? toolName.slice(prefix.length)
          : toolName;
        return `${serverHint}__${actualName}`;
      }

      if (toolName.includes("__")) {
        return toolName;
      }

      const resolved = this.options.upstream.resolveServer(toolName);
      if (!resolved || "error" in resolved) {
        if (!resolved) return null;
        const message = extractStructuredErrorMessage(resolved.error);
        if (message.includes("ambiguous")) return undefined;
        return null;
      }
      return `${resolved.server}__${resolved.actualName}`;
    };

    if (name === "callmux_status" || name === "callmux_cache_clear") {
      return [];
    }

    if (name === "callmux_recipe_run" || name === "callmux_recipe_dry_run") {
      const expanded = expandRecipeInvocation(this.options.config.recipes, args);
      if (!isRecord(expanded) || !isRecord(expanded.args)) return [];
      return this.extractAuthorizationTargets(
        expanded.args.mode === "call" ? "callmux_call" : `callmux_${expanded.args.mode}`,
        expanded.args
      );
    }

    if (name === "callmux_dry_run") {
      if (!isRecord(args)) return [];
      const mode = args.mode;
      if ((mode === undefined || mode === "call") && typeof args.tool === "string") {
        const target = resolveTarget(args.tool, args.server);
        if (target === undefined) return undefined;
        if (target === null) return [];
        return [target];
      }
      if ((mode === undefined || mode === "parallel") && Array.isArray(args.calls)) {
        const targets: string[] = [];
        for (const call of args.calls) {
          if (!isRecord(call)) continue;
          const target = resolveTarget(call.tool, call.server);
          if (!target) return undefined;
          targets.push(target);
        }
        return targets;
      }
      if ((mode === undefined || mode === "batch") && typeof args.tool === "string") {
        const target = resolveTarget(args.tool, args.server);
        if (target === undefined) return undefined;
        if (target === null) return [];
        return [target];
      }
      if ((mode === undefined || mode === "pipeline") && Array.isArray(args.steps)) {
        const targets: string[] = [];
        for (const step of args.steps) {
          if (!isRecord(step)) continue;
          const target = resolveTarget(step.tool, step.server);
          if (!target) return undefined;
          targets.push(target);
        }
        return targets;
      }
      return [];
    }

    if (name === "callmux_call") {
      if (!isRecord(args)) return [];
      const target = resolveTarget(args.tool, args.server);
      if (target === undefined) return undefined;
      if (target === null) return [];
      return [target];
    }

    if (name === "callmux_batch") {
      if (!isRecord(args)) return [];
      const target = resolveTarget(args.tool, args.server);
      if (target === undefined) return undefined;
      if (target === null) return [];
      return [target];
    }

    if (name === "callmux_parallel") {
      if (!isRecord(args) || !Array.isArray(args.calls)) return [];
      const targets: string[] = [];
      for (const call of args.calls) {
        if (!isRecord(call)) continue;
        const target = resolveTarget(call.tool, call.server);
        if (!target) return undefined;
        targets.push(target);
      }
      return targets;
    }

    if (name === "callmux_pipeline") {
      if (!isRecord(args) || !Array.isArray(args.steps)) return [];
      const targets: string[] = [];
      for (const step of args.steps) {
        if (!isRecord(step)) continue;
        const target = resolveTarget(step.tool, step.server);
        if (!target) return undefined;
        targets.push(target);
      }
      return targets;
    }

    const directTarget = resolveTarget(name, undefined);
    if (directTarget === undefined) return undefined;
    if (directTarget === null) return [];
    return [directTarget];
  }

  private writeUnauthorized(res: ServerResponse, context: RequestContext): void {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="callmux"',
    });
    res.end(JSON.stringify({ error: "Unauthorized", requestId: context.requestId }));
  }

  private writeForbidden(
    res: ServerResponse,
    context: RequestContext,
    message: string
  ): void {
    this.writeJson(res, 403, context, { error: message, requestId: context.requestId });
  }

  private writeTooManyRequests(
    res: ServerResponse,
    context: RequestContext,
    message: string,
    retryAfterSeconds?: number
  ): void {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(retryAfterSeconds);
    }
    res.writeHead(429, headers);
    res.end(
      JSON.stringify({
        error: "Too many requests",
        reason: message,
        requestId: context.requestId,
      })
    );
  }

  private handleMetrics(res: ServerResponse, _context: RequestContext): void {
    const text = this.metrics.renderPrometheusText();
    res.writeHead(200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(text);
  }

  private writeJson(
    res: ServerResponse,
    status: number,
    _context: RequestContext,
    payload: Record<string, unknown>
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  private writeJsonRpcError(
    res: ServerResponse,
    status: number,
    context: RequestContext,
    code: number,
    message: string,
    id: JsonRpcId = null
  ): void {
    this.writeJson(res, status, context, {
      jsonrpc: "2.0",
      error: {
        code,
        message,
        data: {
          requestId: context.requestId,
        },
      },
      id,
    });
  }

  private extractJsonRpcId(parsed: unknown): JsonRpcId {
    if (!parsed || typeof parsed !== "object") return null;
    if (!("id" in parsed)) return null;
    const candidate = (parsed as { id?: unknown }).id;
    if (typeof candidate === "string" || typeof candidate === "number") {
      return candidate;
    }
    return null;
  }

  private isSourceIpAllowed(req: IncomingMessage): boolean {
    if (!this.abuseController) return true;
    const remoteAddress = req.socket.remoteAddress;
    return this.abuseController.isIpAllowed(remoteAddress);
  }

  private acquireAbuseLease(
    req: IncomingMessage,
    path: string,
    principal: AuthorizationPrincipal | undefined,
    options: {
      includeGlobalRate: boolean;
      includePrincipalLimits: boolean;
    }
  ): {
    allowed: boolean;
    reason: string;
    retryAfterSeconds?: number;
    release?: () => void;
  } {
    if (!this.abuseController) {
      return { allowed: true, reason: "No abuse controller configured" };
    }

    const method = (req.method ?? "GET").toUpperCase();
    const shouldApply =
      (path === "/mcp" && method === "POST") ||
      (path === "/messages" && method === "POST") ||
      (path === "/sse" && method === "GET");
    if (!shouldApply) {
      return { allowed: true, reason: "Endpoint excluded from abuse controls" };
    }

    const { result, lease } = this.abuseController.acquire(principal, options);
    return {
      allowed: result.allowed,
      reason: result.reason,
      ...(result.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: result.retryAfterSeconds }
        : {}),
      ...(lease ? { release: lease.release } : {}),
    };
  }

  private attachLeaseRelease(res: ServerResponse, release: () => void): void {
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", releaseOnce);
    res.once("close", releaseOnce);
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
    const addResolvedToolTarget = (
      toolName: unknown,
      serverHint: unknown
    ): void => {
      if (typeof serverHint === "string" && serverHint.length > 0) {
        targets.add(serverHint);
        return;
      }
      if (typeof toolName !== "string" || toolName.length === 0) return;
      const qualified = inferServerFromQualifiedToolName(toolName);
      if (qualified) {
        targets.add(qualified);
        return;
      }
      const resolved = this.options.upstream.resolveServer(toolName);
      if (!resolved || "error" in resolved) return;
      targets.add(resolved.server);
    };

    if (name === "callmux_call" && isRecord(args)) {
      addResolvedToolTarget(args.tool, args.server);
    } else if (name === "callmux_batch" && isRecord(args)) {
      addResolvedToolTarget(args.tool, args.server);
    } else if (name === "callmux_parallel" && isRecord(args) && Array.isArray(args.calls)) {
      for (const call of args.calls) {
        if (!isRecord(call)) continue;
        addResolvedToolTarget(call.tool, call.server);
      }
    } else if (name === "callmux_pipeline" && isRecord(args) && Array.isArray(args.steps)) {
      for (const step of args.steps) {
        if (!isRecord(step)) continue;
        addResolvedToolTarget(step.tool, step.server);
      }
    } else if (
      (name === "callmux_recipe_run" || name === "callmux_recipe_dry_run") &&
      isRecord(args)
    ) {
      const expanded = expandRecipeInvocation(this.options.config.recipes, args);
      if (isRecord(expanded) && isRecord(expanded.args)) {
        const recipeName = expanded.args.mode === "call"
          ? "callmux_call"
          : `callmux_${expanded.args.mode}`;
        for (const target of this.extractServerTargets({
          method: "tools/call",
          params: { name: recipeName, arguments: expanded.args },
        })) {
          targets.add(target);
        }
      }
    } else {
      addResolvedToolTarget(name, undefined);
    }

    return Array.from(targets);
  }

  private parseJsonBody(body: string | undefined): unknown {
    if (!body) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return INVALID_JSON_BODY;
    }
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

const INVALID_JSON_BODY = Symbol("invalid_json_body");

function extractStructuredErrorMessage(result: unknown): string {
  if (!isRecord(result)) return "";
  if (!isRecord(result.structuredContent)) return "";
  if (!isRecord(result.structuredContent.error)) return "";
  return typeof result.structuredContent.error.message === "string"
    ? result.structuredContent.error.message
    : "";
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
