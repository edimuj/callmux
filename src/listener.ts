import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
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
  handleSearchTools,
  handleGetResult,
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
import { isOutputFormat, type OutputFormat } from "./output-format.js";
import { authenticateBearerToken } from "./auth.js";
import { OidcJwtVerifier } from "./oidc.js";
import {
  evaluateToolAuthorization,
  type AuthorizationPrincipal,
} from "./authorization.js";
import { errorResult, textFirstResultForNonJson } from "./results.js";
import { META_TOOLS } from "./meta-tools.js";
import { AbuseController } from "./abuse.js";
import { AuditLogger } from "./audit.js";
import { PrometheusMetrics } from "./metrics.js";
import {
  createResponseStore,
  ResponseStore,
  resolveResponseShieldOptions,
  shieldToolResult,
  type ResponseShieldTarget,
} from "./response-store.js";
import {
  classifyDashboardToolStatus,
  extractToolError,
  normalizeDashboardConfig,
  renderDashboardHtml,
  RuntimeEventStore,
  type DashboardSnapshot,
  type DashboardMetricsSnapshot,
} from "./dashboard.js";
import { MetricsStore, type MetricsRange } from "./metrics-store.js";
import {
  applyManagementOverlay,
  assertServerConfig,
  assertStringArray,
  deleteOverlayServer,
  loadManagementOverlay,
  normalizeManagementConfig,
  redactConfig,
  saveManagementOverlay,
  setOverlayServer,
  type ManagementOverlay,
  type NormalizedManagementConfig,
} from "./management.js";
import type { ServerConfig } from "./types.js";
import {
  compressToolForExposure,
  schemaCompressionDiagnostics,
} from "./schema-compression.js";

const DEFAULT_REQUEST_BODY_MAX_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_LISTENER_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000;
const TOOL_CALL_TIMEOUT_OVERRUN_GRACE_MS = 1_000;
const REQUEST_BODY_OVERRIDE_HEADER = "x-callmux-max-body-bytes";
const METRICS_FLUSH_INTERVAL_MS = 15_000;
const METRICS_RANGES: MetricsRange[] = ["1h", "today", "yesterday", "7d", "30d"];
const REQUEST_ID_HEADER = "x-request-id";
const CWD_HEADER = "x-callmux-cwd";
const CLIENT_HEADER = "x-callmux-client";

async function settleWithin<T>(
  promise: Promise<T> | T | undefined,
  timeoutMs: number
): Promise<void> {
  if (promise === undefined) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(promise).then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SessionEntry {
  transport: Transport;
  server: Server;
  cwd?: string;
  cwdSource?: "header" | "meta" | "roots";
  clientKind?: "stdio-bridge";
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

interface DashboardDownstreamTarget {
  server?: string;
  tool: string;
  count: number;
}

interface DashboardToolCallSummary {
  toolKind: "callmux_meta" | "downstream";
  operation: string;
  passthroughToolCalls: number;
  callmuxMetaToolCalls: number;
  callmuxDownstreamToolCalls: number;
  totalDownstreamToolCalls: number;
  callmuxToolCalls: number;
  realToolCalls: number;
  downstreamTargets: DashboardDownstreamTarget[];
}

interface ActiveToolCallEntry {
  id: string;
  requestId: string;
  sessionId?: string;
  tool: string;
  server?: string;
  targetTool?: string;
  toolKind?: "callmux_meta" | "downstream";
  operation?: string;
  startedAt: number;
  startedAtIso: string;
  status: "in_flight" | "client_aborted";
  timeoutMs?: number;
  timeoutOverrunAt?: string;
  timeoutOverrunRecorded?: boolean;
  timeoutOverrunTimer?: ReturnType<typeof setTimeout>;
  cwd?: string;
  principal?: string;
  clientAbortedAt?: string;
  downstreamTargets?: DashboardDownstreamTarget[];
}

const DOWNSTREAM_CAPABLE_META_TOOLS = new Set([
  "callmux_call",
  "callmux_batch",
  "callmux_parallel",
  "callmux_pipeline",
  "callmux_recipe_run",
]);

export interface ListenerOptions {
  port: number;
  host?: string;
  config: CallmuxConfig;
  configPath?: string;
  managementBaseConfig?: CallmuxConfig;
  managementOverlay?: ManagementOverlay;
  upstream: UpstreamManager;
  cache: CallCache;
  responseStore?: ResponseStore;
  allTools: Tool[];
  maxConcurrency: number;
  onManagementConfigChange?: (
    config: CallmuxConfig,
    trigger: string,
    overlay?: ManagementOverlay
  ) => Promise<void>;
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
  private requestContext = new AsyncLocalStorage<RequestContext>();
  private abuseController: AbuseController | undefined;
  private auditLogger: AuditLogger;
  private metrics: PrometheusMetrics;
  private responseStore: ResponseStore;
  private dashboardConfig: ReturnType<typeof normalizeDashboardConfig>;
  private managementConfig: NormalizedManagementConfig;
  private managementBaseConfig: CallmuxConfig;
  private managementOverlay: ManagementOverlay;
  /** Serializes management mutations so concurrent add/patch/delete can't clobber each other's overlay write. */
  private managementMutation: Promise<unknown> = Promise.resolve();
  private runtimeEvents: RuntimeEventStore;
  private metricsStore = new MetricsStore();
  private metricsPath: string | undefined;
  private metricsDirty = false;
  private metricsFlushTimer: ReturnType<typeof setInterval> | undefined;
  private metricsLoaded = false;
  private activeToolCalls = new Map<string, ActiveToolCallEntry>();
  private unsubscribeToolSuiteChanges: (() => void) | undefined;
  private lastReloadAt: string | undefined;
  private lastReloadError: string | undefined;

  constructor(options: ListenerOptions) {
    this.options = options;
    this.responseStore = options.responseStore ?? createResponseStore(options.config);
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
    this.dashboardConfig = normalizeDashboardConfig(options.config.dashboard);
    this.managementConfig = normalizeManagementConfig(
      options.config.management,
      options.configPath
    );
    this.managementBaseConfig = options.managementBaseConfig ?? options.config;
    this.managementOverlay = options.managementOverlay ?? { version: 1 };
    this.runtimeEvents = new RuntimeEventStore(this.dashboardConfig.maxEvents);
    this.metricsPath = this.resolveMetricsPath(options.configPath);
    this.subscribeToolSuiteChanges(options.upstream);
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
    const nextDashboardConfig = normalizeDashboardConfig(config.dashboard);
    const nextManagementConfig = normalizeManagementConfig(
      config.management,
      this.options.configPath
    );

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
    this.dashboardConfig = nextDashboardConfig;
    this.managementConfig = nextManagementConfig;
    this.runtimeEvents.setMaxEvents(nextDashboardConfig.maxEvents);
    this.preReadMaxBytes = this.computePreReadMaxBytes();
  }

  applyReloadedState(next: {
    config: CallmuxConfig;
    upstream: UpstreamManager;
    cache: CallCache;
    allTools: Tool[];
    maxConcurrency: number;
    managementBaseConfig?: CallmuxConfig;
    managementOverlay?: ManagementOverlay;
  }): void {
    this.applyRuntimeConfig(next.config);
    this.responseStore.setMaxEntries(next.config.responseShield?.maxStoredResults);
    this.unsubscribeToolSuiteChanges?.();
    this.options = {
      ...this.options,
      config: next.config,
      upstream: next.upstream,
      cache: next.cache,
      responseStore: this.responseStore,
      allTools: next.allTools,
      maxConcurrency: next.maxConcurrency,
    };
    this.managementBaseConfig = next.managementBaseConfig ?? next.config;
    this.managementOverlay = next.managementOverlay ?? { version: 1 };
    this.subscribeToolSuiteChanges(next.upstream);
  }

  private subscribeToolSuiteChanges(upstream: UpstreamManager): void {
    this.unsubscribeToolSuiteChanges = upstream.subscribeToolSuiteChanges((event) => {
      this.runtimeEvents.append({
        type: "tool_suite_changed",
        timestamp: event.changedAt,
        server: event.server,
        generation: event.generation,
        addedTools: event.addedTools,
        removedTools: event.removedTools,
      });
    });
  }

  recordConfigReload(result: { ok: boolean; error?: string }): void {
    this.lastReloadAt = new Date().toISOString();
    this.lastReloadError = result.ok ? undefined : result.error;
    this.runtimeEvents.append({
      type: "config_reload",
      timestamp: this.lastReloadAt,
      success: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  getRuntimeDiagnostics(): ListenerRuntimeDiagnostics {
    const scopedClients = this.options.upstream.getScopedStdioClientDiagnostics();
    const byServer: Record<string, number> = {};
    for (const client of scopedClients) {
      byServer[client.server] = (byServer[client.server] ?? 0) + 1;
    }

    return {
      ...((this.lastReloadAt || this.lastReloadError)
        ? {
            configReload: {
              ...(this.lastReloadAt ? { lastReloadAt: this.lastReloadAt } : {}),
              ...(this.lastReloadError ? { lastReloadError: this.lastReloadError } : {}),
            },
          }
        : {}),
      activeSessions: this.sessions.size,
      activeToolCallCount: this.activeToolCalls.size,
      activeToolCalls: this.activeToolCallDiagnostics(),
      sessions: Array.from(this.sessions.entries())
        .map(([id, session]) => {
          const clientName = session.server.getClientVersion()?.name;
          const clientRoots = Boolean(session.server.getClientCapabilities()?.roots);
          return {
            id,
            transport: this.transportName(session.transport),
            ...(session.cwd ? { cwd: session.cwd } : {}),
            ...(session.cwdSource ? { cwdSource: session.cwdSource } : {}),
            ...(session.clientKind ? { clientKind: session.clientKind } : {}),
            ...(clientName ? { client: clientName } : {}),
            clientRoots,
            rootsAttempted: session.rootsAttempted === true,
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id)),
      scopedStdioClients: {
        total: scopedClients.length,
        byServer,
        items: scopedClients,
      },
      ...((): { unresolvedSessionCwd?: Record<string, number> } => {
        const counts = this.options.upstream.getUnresolvedSessionCwdCounts();
        return counts ? { unresolvedSessionCwd: counts } : {};
      })(),
    };
  }

  async start(): Promise<void> {
    const { port, host = "127.0.0.1" } = this.options;

    // Load persisted metrics before accepting traffic so early calls accrue
    // onto the restored history instead of a fresh empty store.
    await this.loadMetrics();
    if (this.metricsPath) {
      this.metricsFlushTimer = setInterval(() => {
        void this.flushMetrics();
      }, METRICS_FLUSH_INTERVAL_MS);
      this.metricsFlushTimer.unref?.();
    }

    this.httpServer = createServer((req, res) => this.handleRequest(req, res));
    const server = this.httpServer;

    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error) => reject(err);
      server.once("error", onStartupError);
      server.listen(port, host, () => {
        server.removeListener("error", onStartupError);
        resolve();
      });
    });

    // Persistent handler so a post-startup socket error (bad TLS frame,
    // client reset) is logged instead of bubbling to an uncaught crash.
    server.on("error", (err: Error) => {
      process.stderr.write(`[callmux] http server error: ${err.message}\n`);
    });

    process.stderr.write(
      `[callmux] Listening on http://${host}:${port}\n` +
      `[callmux]   Streamable HTTP: POST/GET/DELETE /mcp\n` +
      `[callmux]   SSE (legacy):    GET /sse, POST /messages\n` +
      (this.managementConfig.enabled
        ? `[callmux]   Management API: ${this.managementConfig.path}\n`
        : "")
    );
  }

  async close(): Promise<void> {
    if (this.metricsFlushTimer) {
      clearInterval(this.metricsFlushTimer);
      this.metricsFlushTimer = undefined;
    }
    await this.flushMetrics();
    this.unsubscribeToolSuiteChanges?.();
    this.unsubscribeToolSuiteChanges = undefined;
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();

    const closeSessions = Promise.allSettled(
      sessions.map(([, session]) =>
        Promise.allSettled([
          settleWithin(session.transport.close?.(), DEFAULT_LISTENER_CLOSE_TIMEOUT_MS),
          settleWithin(session.server.close(), DEFAULT_LISTENER_CLOSE_TIMEOUT_MS),
        ])
      )
    );

    const server = this.httpServer;
    this.httpServer = undefined;
    if (!server) {
      await closeSessions;
      return;
    }

    const closeServer = new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };

      server.close(() => finish());
      timer = setTimeout(() => {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
        finish();
      }, DEFAULT_LISTENER_CLOSE_TIMEOUT_MS);
    });

    await Promise.allSettled([closeSessions, closeServer]);
  }

  private handleReady(res: ServerResponse, context: RequestContext): void {
    const status = handleStatus(
      this.options.upstream,
      this.options.cache,
      this.options.maxConcurrency,
      this.options.config.metaOnly ?? false,
      this.options.config.descriptionMaxLength,
      this.options.upstream.getInstanceIdentity(),
      { sessions: true, recommendations: false },
      this.getRuntimeDiagnostics(),
      this.options.config.recipes,
      this.responseStore,
      undefined,
      this.schemaCompressionDiagnostics()
    ).structuredContent as Record<string, unknown>;
    const wrappedServers = Array.isArray(status.wrappedServers) ? status.wrappedServers : [];
    const servers = Array.isArray(status.servers) ? status.servers : [];
    const state = status.status === "ok"
      ? "ok"
      : servers.length === 0 && wrappedServers.length > 0
        ? "down"
        : "degraded";
    this.writeJson(res, state === "ok" ? 200 : 503, context, {
      status: state,
      sessions: this.sessions.size,
      downstream: status,
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

      await this.requestContext.run(context, async () => {
        await this.authzContext.run(principal ?? undefined, async () => {
          if (path === "/mcp") {
            await this.handleStreamableHttp(req, res, context);
          } else if (
            this.metrics.isEnabled() &&
            path === this.metrics.getPath() &&
            method === "GET"
          ) {
            this.handleMetrics(res, context);
          } else if (this.isManagementPath(path)) {
            await this.handleManagement(req, res, path, context);
          } else if (this.isDashboardPath(path)) {
            this.handleDashboard(req, res, path, context);
          } else if (path === "/sse" && req.method === "GET") {
            await this.handleSseConnect(req, res, context);
          } else if (path === "/messages" && req.method === "POST") {
            await this.handleSseMessage(req, res, url, context);
          } else if (path === "/health" && req.method === "GET") {
            this.writeJson(res, 200, context, { status: "ok", sessions: this.sessions.size });
          } else if (path === "/ready" && req.method === "GET") {
            this.handleReady(res, context);
          } else {
            this.writeJson(res, 404, context, { error: "Not found" });
          }
        });
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
      if (error instanceof RequestBodyAbortedError) {
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

  private isDashboardPath(path: string): boolean {
    if (!this.dashboardConfig.enabled) return false;
    const base = this.dashboardConfig.path;
    return (
      this.isDashboardBasePath(path, base) ||
      path === this.dashboardChildPath(base, "data") ||
      path === this.dashboardChildPath(base, "events") ||
      path === this.dashboardChildPath(base, "series")
    );
  }

  private isManagementPath(path: string): boolean {
    if (!this.managementConfig.enabled) return false;
    const base = this.managementConfig.path;
    return path === base || path.startsWith(`${base}/`);
  }

  private async handleManagement(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    context: RequestContext
  ): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const write = method !== "GET";
    if (!(await this.authenticateManagementRequest(req, context, write))) {
      this.writeJson(res, write ? 401 : 403, context, {
        error: write
          ? "Management auth is required for mutations"
          : "Management read access is not allowed",
      });
      return;
    }

    const route = this.managementRoute(path);
    try {
      if (method === "GET" && route === "status") {
        this.writeJson(res, 200, context, this.createManagementStatus());
        return;
      }
      if (method === "GET" && route === "config/effective") {
        this.writeJson(res, 200, context, redactConfig(this.options.config));
        return;
      }
      if (method === "GET" && route === "servers") {
        this.writeJson(res, 200, context, { servers: this.managementServers() });
        return;
      }
      if (method === "POST" && route === "servers") {
        const body = await this.readManagementJson(req, context);
        const result = await this.managementAddServer(body);
        this.writeJson(res, result.dryRun ? 200 : 201, context, result);
        return;
      }
      const serverRoute = route.match(/^servers\/([^/]+)(?:\/(restart))?$/);
      if (serverRoute) {
        const serverName = decodeURIComponent(serverRoute[1]);
        const action = serverRoute[2];
        if (method === "PATCH" && !action) {
          const body = await this.readManagementJson(req, context);
          this.writeJson(res, 200, context, await this.managementPatchServer(serverName, body));
          return;
        }
        if (method === "DELETE" && !action) {
          const dryRun = new URL(req.url ?? "/", "http://localhost").searchParams.get("dryRun") === "true";
          this.writeJson(res, 200, context, await this.managementDeleteServer(serverName, dryRun));
          return;
        }
        if (method === "POST" && action === "restart") {
          const server = this.options.config.servers[serverName];
          if (!server) {
            this.writeJson(res, 404, context, { error: `server "${serverName}" not found` });
            return;
          }
          if (server.disabled) {
            this.writeJson(res, 409, context, {
              error: `server "${serverName}" is disabled; enable it before restarting`,
            });
            return;
          }
          await this.applyManagedConfig(this.options.config, `management restart ${serverName}`);
          this.writeJson(res, 200, context, { action: "restarted", server: serverName });
          return;
        }
      }
      if (method === "POST" && route === "cache/clear") {
        const body = await this.readManagementJson(req, context);
        const parsed = isRecord(body) ? body : {};
        const tool = typeof parsed.tool === "string" ? parsed.tool : undefined;
        const server = typeof parsed.server === "string" ? parsed.server : undefined;
        this.options.cache.invalidate(tool, server);
        this.writeJson(res, 200, context, {
          action: "cache_cleared",
          ...(tool ? { tool } : {}),
          ...(server ? { server } : {}),
          cache: this.options.cache.stats(),
        });
        return;
      }
      this.writeJson(res, 404, context, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "not found" throws are 404; the rest are treated as bad requests.
      const status = /\bnot found\b/i.test(message) ? 404 : 400;
      this.writeJson(res, status, context, { error: message });
    }
  }

  private async authenticateManagementRequest(
    req: IncomingMessage,
    context: RequestContext,
    write: boolean
  ): Promise<boolean> {
    const auth = this.managementConfig.auth;
    if (auth) {
      const token = this.extractManagementBearerToken(req);
      if (token && (await authenticateBearerToken(token, auth))) return true;
      return !write && this.managementConfig.allowUnauthenticatedRead;
    }
    if (write) return false;
    if (this.managementConfig.allowUnauthenticatedRead) return true;
    // A globally authenticated MCP principal is only granted management read
    // when explicitly opted in — tool-call access does not imply config access.
    return this.managementConfig.allowAuthenticatedRead && Boolean(context.principal);
  }

  private extractManagementBearerToken(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (typeof header === "string") {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match) return match[1];
    }
    const explicit = req.headers["x-callmux-management-token"];
    return typeof explicit === "string" ? explicit : undefined;
  }

  private managementRoute(path: string): string {
    const base = this.managementConfig.path;
    if (path === base) return "status";
    return path.slice(base.length + 1).replace(/\/+$/, "");
  }

  private async readManagementJson(
    req: IncomingMessage,
    context: RequestContext
  ): Promise<unknown> {
    const { body } = await readBody(req, this.globalRequestBodyMaxBytes);
    const parsed = this.parseJsonBody(body);
    context.payload = parsed;
    return parsed;
  }

  private createManagementStatus(): Record<string, unknown> {
    return {
      management: {
        enabled: true,
        path: this.managementConfig.path,
        statePath: this.managementConfig.statePath,
        persistent: Boolean(this.managementConfig.statePath),
        overlayUpdatedAt: this.managementOverlay.updatedAt,
        overlayServers: Object.keys(this.managementOverlay.servers ?? {}).sort(),
      },
      runtime: this.createDashboardSnapshot().status,
      servers: this.managementServers(),
    };
  }

  private managementServers(): Array<Record<string, unknown>> {
    return Object.entries(this.options.config.servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, config]) => {
        const info = this.options.upstream.getServerInfo(name);
        return {
          name,
          config: redactConfig({ servers: { [name]: config } }).servers[name],
          managed: this.managementOverlay.servers?.[name] !== undefined,
          ...(info ? { runtime: info } : {}),
          tools: this.options.upstream.getServerTools(name),
        };
      });
  }

  /**
   * Run a management mutation in a serialized critical section so the
   * read-overlay → compute-next → commit sequence is atomic across
   * concurrent requests. The internal chain never rejects (so one failed
   * mutation can't poison later ones); the real result/rejection is
   * returned to the caller.
   */
  private withManagementLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.managementMutation.then(fn, fn);
    this.managementMutation = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private managementAddServer(body: unknown): Promise<Record<string, unknown>> {
    return this.withManagementLock(async () => {
      if (!isRecord(body) || typeof body.name !== "string" || body.name.trim().length === 0) {
        throw new Error("name is required");
      }
      assertServerConfig(body.config, "config");
      const dryRun = body.dryRun === true;
      const nextOverlay = setOverlayServer(this.managementOverlay, body.name, body.config);
      const nextConfig = applyManagementOverlay(this.managementBaseConfig, nextOverlay);
      if (dryRun) {
        return { dryRun: true, action: "add_server", server: body.name, config: redactConfig(nextConfig) };
      }
      await this.commitManagementOverlay(nextOverlay, nextConfig, `management add ${body.name}`);
      return { action: "added", server: body.name };
    });
  }

  private managementPatchServer(
    name: string,
    body: unknown
  ): Promise<Record<string, unknown>> {
    return this.withManagementLock(async () => {
    const current = this.options.config.servers[name];
    if (!current) throw new Error(`server "${name}" not found`);
    if (!isRecord(body)) throw new Error("request body must be an object");
    const dryRun = body.dryRun === true;
    let nextServer: ServerConfig;
    if (body.config !== undefined) {
      assertServerConfig(body.config, "config");
      nextServer = body.config;
    } else {
      nextServer = { ...current };
      if (body.tools !== undefined) {
        assertStringArray(body.tools, "tools");
        nextServer.tools = body.tools.length > 0 ? body.tools : undefined;
      }
      if (body.addTools !== undefined) {
        assertStringArray(body.addTools, "addTools");
        nextServer.tools = Array.from(new Set([...(nextServer.tools ?? []), ...body.addTools]));
      }
      if (body.removeTools !== undefined) {
        assertStringArray(body.removeTools, "removeTools");
        const removals = new Set(body.removeTools);
        nextServer.tools = (nextServer.tools ?? []).filter((tool) => !removals.has(tool));
        if (nextServer.tools.length === 0) delete nextServer.tools;
      }
      if (body.disabled !== undefined) {
        if (typeof body.disabled !== "boolean") throw new Error("disabled must be a boolean");
        nextServer.disabled = body.disabled;
      }
    }
    const nextOverlay = setOverlayServer(this.managementOverlay, name, nextServer);
    const nextConfig = applyManagementOverlay(this.managementBaseConfig, nextOverlay);
    if (dryRun) {
      return { dryRun: true, action: "patch_server", server: name, config: redactConfig(nextConfig) };
    }
    await this.commitManagementOverlay(nextOverlay, nextConfig, `management patch ${name}`);
    return { action: "updated", server: name };
    });
  }

  private managementDeleteServer(
    name: string,
    dryRun: boolean
  ): Promise<Record<string, unknown>> {
    return this.withManagementLock(async () => {
      if (!this.options.config.servers[name]) throw new Error(`server "${name}" not found`);
      const nextOverlay = deleteOverlayServer(this.managementOverlay, name);
      const nextConfig = applyManagementOverlay(this.managementBaseConfig, nextOverlay);
      if (dryRun) {
        return { dryRun: true, action: "delete_server", server: name, config: redactConfig(nextConfig) };
      }
      await this.commitManagementOverlay(nextOverlay, nextConfig, `management delete ${name}`);
      return { action: "deleted", server: name };
    });
  }

  private async commitManagementOverlay(
    nextOverlay: ManagementOverlay,
    nextConfig: CallmuxConfig,
    trigger: string
  ): Promise<void> {
    await this.applyManagedConfig(nextConfig, trigger, nextOverlay);
    await saveManagementOverlay(this.managementConfig.statePath, nextOverlay);
    this.managementOverlay = await loadManagementOverlay(this.managementConfig.statePath);
  }

  private async applyManagedConfig(
    config: CallmuxConfig,
    trigger: string,
    overlay?: ManagementOverlay
  ): Promise<void> {
    if (!this.options.onManagementConfigChange) {
      throw new Error("management mutations require listener runtime apply support");
    }
    await this.options.onManagementConfigChange(config, trigger, overlay);
  }

  private handleDashboard(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    context: RequestContext
  ): void {
    if (req.method !== "GET") {
      this.writeJson(res, 405, context, { error: "Method not allowed" });
      return;
    }

    const base = this.dashboardConfig.path;
    if (this.isDashboardBasePath(path, base)) {
      const html = renderDashboardHtml(this.dashboardConfig);
      // The dashboard ships as a single self-contained HTML doc that changes
      // on every release. Without this, browsers heuristically cache it and
      // users keep seeing the old UI after an upgrade until a manual purge.
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      });
      res.end(html);
      return;
    }

    if (path === this.dashboardChildPath(base, "data")) {
      this.writeJson(res, 200, context, this.createDashboardSnapshot());
      return;
    }

    if (path === this.dashboardChildPath(base, "events")) {
      this.handleDashboardEvents(res);
      return;
    }

    if (path === this.dashboardChildPath(base, "series")) {
      this.handleDashboardSeries(req, res, context);
      return;
    }

    this.writeJson(res, 404, context, { error: "Not found" });
  }

  private isDashboardBasePath(path: string, base: string): boolean {
    if (base === "/") return path === "/";
    return path === base || path === `${base}/`;
  }

  private dashboardChildPath(base: string, child: string): string {
    return base === "/" ? `/${child}` : `${base}/${child}`;
  }

  private createDashboardSnapshot(): DashboardSnapshot {
    const status = handleStatus(
      this.options.upstream,
      this.options.cache,
      this.options.maxConcurrency,
      this.options.config.metaOnly ?? false,
      this.options.config.descriptionMaxLength,
      this.options.upstream.getInstanceIdentity(),
      { sessions: true, recommendations: false },
      this.getRuntimeDiagnostics(),
      this.options.config.recipes,
      this.responseStore,
      undefined,
      this.schemaCompressionDiagnostics()
    ).structuredContent;

    return {
      generatedAt: new Date().toISOString(),
      summary: this.runtimeEvents.stats(),
      status,
      management: {
        enabled: this.managementConfig.enabled,
        path: this.managementConfig.path,
      },
      managementServers: this.managementConfig.enabled ? this.managementServers() : [],
      ...(this.metricsSnapshot() ? { metrics: this.metricsSnapshot() } : {}),
      events: this.runtimeEvents.list(),
    };
  }

  private metricsSnapshot(): DashboardMetricsSnapshot | undefined {
    if (!this.dashboardConfig.enabled) return undefined;
    return {
      startedAt: this.metricsStore.startedAtMs(),
      totals: this.metricsStore.totals() as unknown as Record<string, number>,
      servers: this.metricsStore.serverStats(),
    };
  }

  private handleDashboardSeries(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext
  ): void {
    const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("range");
    const range: MetricsRange = METRICS_RANGES.includes(raw as MetricsRange)
      ? (raw as MetricsRange)
      : "1h";
    this.writeJson(res, 200, context, {
      range,
      startedAt: this.metricsStore.startedAtMs(),
      totals: this.metricsStore.totals(),
      servers: this.metricsStore.serverStats(),
      series: this.metricsStore.series(range),
    });
  }

  private resolveMetricsPath(configPath: string | undefined): string | undefined {
    if (!this.dashboardConfig.enabled) return undefined;
    const dir = configPath
      ? dirname(resolvePath(configPath))
      : join(homedir(), ".config", "callmux");
    return join(dir, "callmux-metrics.json");
  }

  private async loadMetrics(): Promise<void> {
    if (this.metricsLoaded) return;
    this.metricsLoaded = true;
    if (!this.metricsPath) return;
    try {
      const raw = await readFile(this.metricsPath, "utf8");
      this.metricsStore = MetricsStore.fromJSON(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        process.stderr.write(
          `[callmux] could not load metrics from ${this.metricsPath}: ${(error as Error).message}\n`
        );
      }
    }
  }

  /** Persist metrics atomically (temp file + rename) so a crash can't corrupt it. */
  private async flushMetrics(): Promise<void> {
    if (!this.metricsPath || !this.metricsDirty) return;
    this.metricsDirty = false;
    const payload = JSON.stringify(this.metricsStore.toJSON());
    try {
      await mkdir(dirname(this.metricsPath), { recursive: true });
      const tmp = `${this.metricsPath}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.metricsPath);
    } catch (error) {
      this.metricsDirty = true; // leave dirty so the next tick retries
      process.stderr.write(
        `[callmux] could not persist metrics to ${this.metricsPath}: ${(error as Error).message}\n`
      );
    }
  }

  private handleDashboardEvents(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    let active = true;
    let unsubscribe = () => {};
    const stop = () => {
      if (!active) return;
      active = false;
      unsubscribe();
    };
    // A write to a half-closed socket emits 'error' on res; without this
    // guard + handler an unhandled error would crash the daemon (EPIPE).
    const safeWrite = (chunk: string) => {
      if (!active || !res.writable) return;
      try {
        res.write(chunk);
      } catch {
        stop();
      }
    };
    res.on("close", stop);
    res.on("error", stop);
    unsubscribe = this.runtimeEvents.subscribe((event) => {
      safeWrite(`data: ${JSON.stringify(event)}\n\n`);
    });
    safeWrite(
      `event: snapshot\ndata: ${JSON.stringify(this.createDashboardSnapshot())}\n\n`
    );
  }

  // ─── Streamable HTTP ────────────────────────────────────────────

  private async handleStreamableHttp(
    req: IncomingMessage,
    res: ServerResponse,
    context: RequestContext
  ): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method !== "POST") {
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!;
        if (!(session.transport instanceof StreamableHTTPServerTransport)) {
          this.writeJsonRpcError(
            res,
            400,
            context,
            -32000,
            "Session uses different transport"
          );
          return;
        }
        this.setSessionCwdFromHeader(session, req);
        await session.transport.handleRequest(req, res);
        return;
      }

      if (sessionId) {
        this.writeJsonRpcError(
          res,
          400,
          context,
          -32000,
          "Bad Request: Unknown session. Re-initialize and retry with a new MCP-Session-Id."
        );
        return;
      }

      this.writeJsonRpcError(
        res,
        400,
        context,
        -32000,
        "Bad Request: No valid session. Send initialize first, then include MCP-Session-Id."
      );
      return;
    }

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
  ): Pick<SessionEntry, "cwd" | "cwdSource" | "clientKind"> {
    const cwd = this.normalizeSessionCwd(headerValue(req.headers[CWD_HEADER]));
    const clientKind = headerValue(req.headers[CLIENT_HEADER]) === "stdio-bridge"
      ? "stdio-bridge"
      : undefined;
    return {
      ...(cwd ? { cwd, cwdSource: "header" as const } : {}),
      ...(clientKind ? { clientKind } : {}),
    };
  }

  private setSessionCwdFromHeader(session: SessionEntry, req: IncomingMessage): void {
    const cwd = this.normalizeSessionCwd(headerValue(req.headers[CWD_HEADER]));
    if (!cwd) return;
    session.cwd = cwd;
    session.cwdSource = "header";
    if (headerValue(req.headers[CLIENT_HEADER]) === "stdio-bridge") {
      session.clientKind = "stdio-bridge";
    }
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

    if (
      name === "callmux_status" ||
      name === "callmux_search_tools" ||
      name === "callmux_get_result" ||
      name === "callmux_cache_clear"
    ) {
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
    const server = new Server(
      { name: "callmux", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.currentTools(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { upstream, cache, maxConcurrency, config } = this.options;
      const name = request.params.name;
      const args = request.params.arguments;
      const startedAt = Date.now();
      let cacheHit = false;
      let target: ResponseShieldTarget | undefined;
      const principal = this.authzContext.getStore();
      const session = extra.sessionId ? this.sessions.get(extra.sessionId) : undefined;
      const active = this.beginActiveToolCall(
        name,
        args,
        session,
        extra.sessionId,
        this.toolCallTimeoutBudgetMs(name, args)
      );
      try {
        const authz = this.authorizeToolCall(name, args, principal);
        if (!authz.allowed) {
          const denied = errorResult("authorization_denied", "Authorization policy denied tool call", {
            code: authz.code,
            reason: authz.reason,
            ...(authz.ruleId ? { ruleId: authz.ruleId } : {}),
            ...(authz.tool ? { tool: authz.tool } : {}),
          });
          this.recordToolCallEvent(name, target, denied, startedAt, false, args);
          return denied;
        }
        const toolContext = this.toolRequestNeedsSessionCwd(upstream, name, args)
          ? await this.resolveToolCallContext(session, server, extra)
          : this.bareToolCallContext(extra);
        this.updateActiveToolCall(active.id, {
          ...(toolContext.cwd ? { cwd: toolContext.cwd } : {}),
        });

      let result: CallToolResult;
      switch (name) {
        case "callmux_parallel":
          target = { tool: name };
          result = this.shieldResult(
            target,
            await handleParallel(
              upstream,
              cache,
              args,
              maxConcurrency,
              toolContext,
              config.outputFormat
            ),
            this.outputFormatFor(args)
          );
          break;
        case "callmux_batch":
          target = { tool: name };
          result = this.shieldResult(
            target,
            await handleBatch(
              upstream,
              cache,
              args,
              maxConcurrency,
              toolContext,
              config.outputFormat
            ),
            this.outputFormatFor(args)
          );
          break;
        case "callmux_pipeline":
          target = { tool: name };
          result = this.shieldResult(
            target,
            await handlePipeline(
              upstream,
              cache,
              args,
              toolContext,
              config.outputFormat
            ),
            this.outputFormatFor(args)
          );
          break;
        case "callmux_call":
          if (isCallmuxGetResultCall(args)) {
            target = { tool: "callmux_get_result" };
            result = handleGetResult(
              this.responseStore,
              args.arguments,
              this.outputFormatFor(args)
            );
          } else {
            target = this.responseShieldTarget(upstream, name, args);
            result = this.shieldResult(
              target,
              await handleCall(
                upstream,
                cache,
                args,
                toolContext,
                config.outputFormat
              ),
              this.outputFormatFor(args)
            );
          }
          break;
        case "callmux_search_tools":
          result = handleSearchTools(
            upstream,
            config.descriptionMaxLength,
            args,
            config.outputFormat
          );
          break;
        case "callmux_get_result":
          target = { tool: name };
          result = handleGetResult(this.responseStore, args, config.outputFormat);
          break;
        case "callmux_cache_clear":
          result = handleCacheClear(cache, args);
          break;
        case "callmux_dry_run":
          result = await handleDryRun(
            upstream,
            cache,
            args,
            toolContext,
            config.outputFormat
          );
          break;
        case "callmux_recipe_run":
          target = { tool: name };
          result = this.shieldResult(
            target,
            await handleRecipeRun(
              upstream,
              cache,
              config.recipes,
              args,
              maxConcurrency,
              toolContext,
              config.outputFormat
            ),
            this.outputFormatFor(args)
          );
          break;
        case "callmux_recipe_dry_run":
          result = await handleRecipeDryRun(
            upstream,
            cache,
            config.recipes,
            args,
            toolContext,
            config.outputFormat
          );
          break;
        case "callmux_status":
          result = handleStatus(
            upstream,
            cache,
            maxConcurrency,
            config.metaOnly ?? false,
            config.descriptionMaxLength,
            upstream.getInstanceIdentity(),
            args,
            this.getRuntimeDiagnostics(),
            config.recipes,
            this.responseStore,
            config.outputFormat,
            this.schemaCompressionDiagnostics()
          );
          break;
        default: {
          target = this.responseShieldTarget(upstream, name, args);
          const prepared = await upstream.prepareToolCall(name, args);
          if ("error" in prepared) {
            result = prepared.error;
            break;
          }
          const cacheScope = upstream.cacheScopeForCall(name, prepared.server, toolContext);
          const cached = cache.get(name, prepared.resolvedArguments, prepared.server, cacheScope);
          if (cached) {
            cacheHit = true;
            result = this.shieldResult(target, cached);
          } else {
            const upstreamResult = await upstream.callTool(name, prepared.resolvedArguments, prepared.server, {
              ...toolContext,
              retryOnReconnect: cache.isSafeToRetry(name, prepared.server),
            });
            cache.set(name, prepared.resolvedArguments, upstreamResult, prepared.server, cacheScope);
            result = this.shieldResult(target, upstreamResult);
          }
          break;
        }
      }

      if (name.startsWith("callmux_")) {
        result = this.finalizeOutputFormat(result, this.outputFormatFor(args));
      }
      this.recordToolCallEvent(name, target, result, startedAt, cacheHit, args);
      return result;
      } finally {
        this.completeActiveToolCall(active.id);
      }
    });

    return server;
  }

  private currentTools(): Tool[] {
    const metaTools = META_TOOLS.map((tool) =>
      compressToolForExposure(tool, this.options.config.schemaCompression)
    );
    if (this.options.config.metaOnly) return metaTools;
    const proxiedTools = this.options.upstream.getTools().map(({ qualifiedName, server, tool }) => {
      const serverCfg = this.options.config.servers[server];
      const eager = serverCfg?.alwaysLoad;
      const base = eager?.includes(tool.name)
        ? { ...tool, name: qualifiedName, _meta: { ...tool._meta, "anthropic/alwaysLoad": true } }
        : { ...tool, name: qualifiedName };
      return compressToolForExposure(
        base,
        this.options.config.schemaCompression,
        serverCfg?.schemaCompression
      );
    });
    return [...proxiedTools, ...metaTools];
  }

  private schemaCompressionDiagnostics() {
    const upstream = this.options.upstream as UpstreamManager & {
      getTools?: () => Array<{ qualifiedName: string; server: string; tool: Tool }>;
    };
    const downstreamTools = typeof upstream.getTools === "function"
      ? upstream.getTools()
      : [];
    return schemaCompressionDiagnostics(this.options.config, [
      ...downstreamTools.map(({ qualifiedName, server, tool }) => ({
        server,
        tool: { ...tool, name: qualifiedName },
      })),
      ...META_TOOLS.map((tool) => ({ tool })),
    ]);
  }

  private responseShieldTarget(
    upstream: UpstreamManager,
    tool: string,
    args?: Record<string, unknown>
  ): ResponseShieldTarget {
    if (tool === "callmux_call" && args && typeof args.tool === "string") {
      const server = typeof args.server === "string" ? args.server : undefined;
      const resolved = upstream.resolveServer(args.tool, server);
      if (resolved && !("error" in resolved)) {
        return { tool: resolved.actualName, server: resolved.server };
      }
      return { tool: args.tool, ...(server ? { server } : {}) };
    }

    const separatorIndex = tool.indexOf("__");
    if (separatorIndex > 0) {
      return {
        tool: tool.slice(separatorIndex + 2),
        server: tool.slice(0, separatorIndex),
      };
    }

    const resolved = upstream.resolveServer(tool);
    if (resolved && !("error" in resolved)) {
      return { tool: resolved.actualName, server: resolved.server };
    }

    return { tool };
  }

  private shieldResult(
    target: ResponseShieldTarget,
    result: CallToolResult,
    outputFormat?: OutputFormat
  ): CallToolResult {
    return shieldToolResult(
      this.responseStore,
      target,
      result,
      {
        ...resolveResponseShieldOptions(this.options.config, target),
        outputFormat: outputFormat ?? this.options.config.outputFormat,
      }
    );
  }

  private finalizeOutputFormat(
    result: CallToolResult,
    outputFormat?: OutputFormat
  ): CallToolResult {
    if (outputFormat === undefined || outputFormat === "json") return result;
    return textFirstResultForNonJson(result);
  }

  private outputFormatFor(args: unknown): OutputFormat | undefined {
    return isRecord(args) && isOutputFormat(args.outputFormat)
      ? args.outputFormat
      : this.options.config.outputFormat;
  }

  private toolCallTimeoutBudgetMs(tool: string, args: unknown): number | undefined {
    const downstreamTimeout = (targetTool: unknown, server: unknown, override?: unknown) => {
      const explicit = positiveTimeoutMs(override);
      if (explicit !== undefined) return explicit;
      if (typeof targetTool !== "string") return this.defaultToolCallTimeoutMs();

      const serverHint = typeof server === "string" ? server : undefined;
      const resolved = this.options.upstream.resolveServer(targetTool, serverHint);
      const resolvedServer = resolved && !("error" in resolved) ? resolved.server : serverHint;
      if (resolvedServer) {
        const serverConfig = this.options.config.servers[resolvedServer];
        if (serverConfig?.callTimeoutMs !== undefined) return serverConfig.callTimeoutMs;
      }
      return this.defaultToolCallTimeoutMs();
    };

    if (tool === "callmux_call") {
      if (!isRecord(args) || isCallmuxGetResultCall(args)) return undefined;
      return downstreamTimeout(args.tool, args.server, args.timeoutMs);
    }

    if (tool === "callmux_parallel") {
      if (!isRecord(args) || !Array.isArray(args.calls)) return undefined;
      return sumDefined(
        ...args.calls
          .filter(isRecord)
          .map((call) => downstreamTimeout(call.tool, call.server, call.timeoutMs))
      );
    }

    if (tool === "callmux_batch") {
      if (!isRecord(args) || !Array.isArray(args.items)) return undefined;
      const batchTimeout = downstreamTimeout(args.tool, args.server, args.timeoutMs);
      return sumDefined(
        ...args.items
          .filter(isRecord)
          .map((item) => positiveTimeoutMs(item.timeoutMs) ?? batchTimeout)
      );
    }

    if (tool === "callmux_pipeline") {
      if (!isRecord(args) || !Array.isArray(args.steps)) return undefined;
      return sumDefined(
        ...args.steps
          .filter(isRecord)
          .map((step) => downstreamTimeout(step.tool, step.server, step.timeoutMs))
      );
    }

    if (tool === "callmux_recipe_run") {
      const expanded = expandRecipeInvocation(this.options.config.recipes, args);
      if (isRecord(expanded) && isRecord(expanded.args)) {
        const mode = expanded.args.mode;
        if (mode === "call") return this.toolCallTimeoutBudgetMs("callmux_call", expanded.args);
        if (mode === "parallel") return this.toolCallTimeoutBudgetMs("callmux_parallel", expanded.args);
        if (mode === "batch") return this.toolCallTimeoutBudgetMs("callmux_batch", expanded.args);
        if (mode === "pipeline") return this.toolCallTimeoutBudgetMs("callmux_pipeline", expanded.args);
      }
      return undefined;
    }

    if (
      tool === "callmux_status" ||
      tool === "callmux_search_tools" ||
      tool === "callmux_get_result" ||
      tool === "callmux_cache_clear" ||
      tool === "callmux_dry_run" ||
      tool === "callmux_recipe_dry_run"
    ) {
      return undefined;
    }

    return downstreamTimeout(tool, undefined);
  }

  private defaultToolCallTimeoutMs(): number {
    return this.options.config.callTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
  }

  private beginActiveToolCall(
    tool: string,
    args: unknown,
    session: SessionEntry | undefined,
    sessionId: string | undefined,
    timeoutMs: number | undefined
  ): ActiveToolCallEntry {
    const context = this.requestContext.getStore();
    const principal = this.authzContext.getStore();
    const target = this.responseShieldTarget(
      this.options.upstream,
      tool,
      isRecord(args) ? args : undefined
    );
    const summary = this.summarizeDashboardToolCall(tool, args, undefined, target);
    const entry: ActiveToolCallEntry = {
      id: randomUUID(),
      requestId: context?.requestId ?? randomUUID(),
      ...(sessionId ? { sessionId } : {}),
      tool,
      ...(target.server ? { server: target.server } : {}),
      ...(target.tool ? { targetTool: target.tool } : {}),
      toolKind: summary.toolKind,
      operation: summary.operation,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString(),
      status: "in_flight",
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(session?.cwd ? { cwd: session.cwd } : {}),
      ...(principal ? { principal: `${principal.kind}:${principal.id}` } : {}),
      ...(summary.downstreamTargets.length > 0
        ? { downstreamTargets: summary.downstreamTargets }
        : {}),
    };
    this.activeToolCalls.set(entry.id, entry);
    this.scheduleActiveToolCallTimeoutOverrun(entry.id);
    return entry;
  }

  private updateActiveToolCall(id: string, updates: Partial<ActiveToolCallEntry>): void {
    const entry = this.activeToolCalls.get(id);
    if (!entry) return;
    this.activeToolCalls.set(id, { ...entry, ...updates });
  }

  private completeActiveToolCall(id: string): void {
    const entry = this.activeToolCalls.get(id);
    if (entry?.timeoutOverrunTimer) clearTimeout(entry.timeoutOverrunTimer);
    this.activeToolCalls.delete(id);
  }

  private scheduleActiveToolCallTimeoutOverrun(id: string): void {
    const entry = this.activeToolCalls.get(id);
    if (!entry?.timeoutMs) return;

    const delay = Math.min(
      Number.MAX_SAFE_INTEGER,
      entry.timeoutMs + TOOL_CALL_TIMEOUT_OVERRUN_GRACE_MS
    );
    entry.timeoutOverrunTimer = setTimeout(() => {
      this.recordActiveToolCallTimeoutOverrun(id);
    }, delay);
    entry.timeoutOverrunTimer.unref?.();
  }

  private recordActiveToolCallTimeoutOverrun(id: string): void {
    const entry = this.activeToolCalls.get(id);
    if (
      !entry ||
      entry.status !== "in_flight" ||
      entry.timeoutOverrunRecorded ||
      entry.timeoutMs === undefined
    ) {
      return;
    }

    const durationMs = Date.now() - entry.startedAt;
    if (durationMs < entry.timeoutMs) return;

    const overrunAt = new Date().toISOString();
    entry.timeoutOverrunAt = overrunAt;
    entry.timeoutOverrunRecorded = true;
    this.runtimeEvents.append({
      type: "tool_call_lifecycle",
      lifecycle: "timeout_overrun",
      timestamp: overrunAt,
      requestId: entry.requestId,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      tool: entry.tool,
      ...(entry.server ? { server: entry.server } : {}),
      ...(entry.targetTool ? { targetTool: entry.targetTool } : {}),
      ...(entry.toolKind ? { toolKind: entry.toolKind } : {}),
      ...(entry.operation ? { operation: entry.operation } : {}),
      ...(entry.downstreamTargets ? { downstreamTargets: entry.downstreamTargets } : {}),
      durationMs,
      timeoutMs: entry.timeoutMs,
      status: "error",
      success: false,
      error: `tool call exceeded ${entry.timeoutMs}ms timeout and is still in flight`,
    });
  }

  private markActiveToolCallsForRequestAborted(requestId: string): void {
    const abortedAt = new Date().toISOString();
    for (const entry of this.activeToolCalls.values()) {
      if (entry.requestId !== requestId || entry.status === "client_aborted") continue;
      entry.status = "client_aborted";
      entry.clientAbortedAt = abortedAt;
      if (entry.timeoutOverrunTimer) clearTimeout(entry.timeoutOverrunTimer);
      this.runtimeEvents.append({
        type: "tool_call_lifecycle",
        lifecycle: "client_aborted",
        timestamp: abortedAt,
        requestId: entry.requestId,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        tool: entry.tool,
        ...(entry.server ? { server: entry.server } : {}),
        ...(entry.targetTool ? { targetTool: entry.targetTool } : {}),
        ...(entry.toolKind ? { toolKind: entry.toolKind } : {}),
        ...(entry.operation ? { operation: entry.operation } : {}),
        ...(entry.downstreamTargets ? { downstreamTargets: entry.downstreamTargets } : {}),
        durationMs: Date.now() - entry.startedAt,
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
        status: "client_aborted",
        success: false,
      });
    }
  }

  private activeToolCallDiagnostics(): ListenerRuntimeDiagnostics["activeToolCalls"] {
    return Array.from(this.activeToolCalls.values())
      .map((entry) => ({
        id: entry.id,
        requestId: entry.requestId,
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
        tool: entry.tool,
        ...(entry.server ? { server: entry.server } : {}),
        ...(entry.targetTool ? { targetTool: entry.targetTool } : {}),
        ...(entry.toolKind ? { toolKind: entry.toolKind } : {}),
        ...(entry.operation ? { operation: entry.operation } : {}),
        startedAt: entry.startedAtIso,
        durationMs: Date.now() - entry.startedAt,
        status: entry.status,
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(entry.principal ? { principal: entry.principal } : {}),
        ...(entry.clientAbortedAt ? { clientAbortedAt: entry.clientAbortedAt } : {}),
        ...(entry.timeoutOverrunAt ? { timeoutOverrunAt: entry.timeoutOverrunAt } : {}),
        ...(entry.downstreamTargets ? { downstreamTargets: entry.downstreamTargets } : {}),
      }))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  private recordToolCallEvent(
    tool: string,
    target: ResponseShieldTarget | undefined,
    result: CallToolResult,
    startedAt: number,
    cacheHit?: boolean,
    args?: unknown
  ): void {
    const summary = this.summarizeDashboardToolCall(tool, args, result, target);
    const status = classifyDashboardToolStatus(result, {
      callmuxToolCalls: summary.callmuxToolCalls,
      realToolCalls: summary.totalDownstreamToolCalls,
    });
    const isMeta = tool.startsWith("callmux_");
    const requestedFormat = this.outputFormatFor(args);
    // Only json/toon are concrete; "auto" picks per-payload deep in the
    // handlers and isn't surfaced here. Format applies to meta-tool output.
    const format =
      isMeta && (requestedFormat === "toon" || requestedFormat === "json")
        ? requestedFormat
        : undefined;
    const durationMs = Date.now() - startedAt;
    this.runtimeEvents.append({
      type: "tool_call",
      timestamp: new Date().toISOString(),
      tool,
      ...(target?.server ? { server: target.server } : {}),
      ...(target?.tool ? { targetTool: target.tool } : {}),
      ...summary,
      durationMs,
      status,
      success: status !== "error",
      ...(cacheHit ? { cacheHit } : {}),
      ...(format ? { outputFormat: format } : {}),
      ...(result.isError ? { error: extractToolError(result) } : {}),
    });
    if (this.dashboardConfig.enabled) {
      this.metricsStore.record({
        ...(target?.server ? { server: target.server } : {}),
        downstreamTargets: summary.downstreamTargets,
        meta: isMeta,
        downstreamCalls: summary.totalDownstreamToolCalls,
        cacheHit: Boolean(cacheHit),
        error: status === "error",
        bytesIn: jsonByteLength(args),
        bytesOut: jsonByteLength(result),
        durationMs,
        ...(format ? { format } : {}),
      });
      this.metricsDirty = true;
    }
  }

  private summarizeHttpRequestPayload(payload: unknown): Partial<{
    jsonRpcMethod: string;
    jsonRpcTool: string;
    jsonRpcRequestCount: number;
    passthroughToolCalls: number;
    callmuxMetaToolCalls: number;
    callmuxDownstreamToolCalls: number;
    totalDownstreamToolCalls: number;
    callmuxToolCalls: number;
    realToolCalls: number;
    downstreamTargets: DashboardDownstreamTarget[];
  }> {
    const requests = (Array.isArray(payload) ? payload : [payload]).filter(isRecord);
    if (requests.length === 0) return {};

    const methods = [...new Set(
      requests
        .map((request) => typeof request.method === "string" ? request.method : undefined)
        .filter((method): method is string => method !== undefined)
    )];
    let passthroughToolCalls = 0;
    let callmuxMetaToolCalls = 0;
    let callmuxDownstreamToolCalls = 0;
    let totalDownstreamToolCalls = 0;
    let callmuxToolCalls = 0;
    let realToolCalls = 0;
    const targets: DashboardDownstreamTarget[] = [];
    const tools: string[] = [];

    for (const request of requests) {
      if (request.method !== "tools/call" || !isRecord(request.params)) continue;
      const name = typeof request.params.name === "string" ? request.params.name : undefined;
      if (!name) continue;
      tools.push(name);
      const summary = this.summarizeDashboardToolCall(
        name,
        request.params.arguments,
        undefined,
        undefined
      );
      passthroughToolCalls += summary.passthroughToolCalls;
      callmuxMetaToolCalls += summary.callmuxMetaToolCalls;
      callmuxDownstreamToolCalls += summary.callmuxDownstreamToolCalls;
      totalDownstreamToolCalls += summary.totalDownstreamToolCalls;
      callmuxToolCalls += summary.callmuxToolCalls;
      realToolCalls += summary.realToolCalls;
      targets.push(...summary.downstreamTargets);
    }

    return {
      ...(methods.length > 0 ? { jsonRpcMethod: methods.join(", ") } : {}),
      ...(tools.length > 0 ? { jsonRpcTool: [...new Set(tools)].join(", ") } : {}),
      jsonRpcRequestCount: requests.length,
      ...(passthroughToolCalls > 0 ? { passthroughToolCalls } : {}),
      ...(callmuxMetaToolCalls > 0 ? { callmuxMetaToolCalls } : {}),
      ...(callmuxDownstreamToolCalls > 0 ? { callmuxDownstreamToolCalls } : {}),
      ...(totalDownstreamToolCalls > 0 ? { totalDownstreamToolCalls } : {}),
      ...(callmuxToolCalls > 0 ? { callmuxToolCalls } : {}),
      ...(realToolCalls > 0 ? { realToolCalls } : {}),
      ...(targets.length > 0 ? { downstreamTargets: this.aggregateDashboardTargets(targets) } : {}),
    };
  }

  private summarizeDashboardToolCall(
    name: string,
    args: unknown,
    result?: CallToolResult,
    target?: ResponseShieldTarget
  ): DashboardToolCallSummary {
    const isMeta = name.startsWith("callmux_");
    const countMetaCall = DOWNSTREAM_CAPABLE_META_TOOLS.has(name);
    const downstreamTargets = this.dashboardTargetsForToolCall(name, args, result, target);
    const downstreamCalls = downstreamTargets.reduce((sum, item) => sum + item.count, 0);
    return {
      toolKind: isMeta ? "callmux_meta" : "downstream",
      operation: isMeta ? name.slice("callmux_".length) : "direct",
      passthroughToolCalls: isMeta ? 0 : downstreamCalls,
      callmuxMetaToolCalls: countMetaCall ? 1 : 0,
      callmuxDownstreamToolCalls: isMeta ? downstreamCalls : 0,
      totalDownstreamToolCalls: downstreamCalls,
      callmuxToolCalls: countMetaCall ? 1 : 0,
      realToolCalls: downstreamCalls,
      downstreamTargets,
    };
  }

  private dashboardTargetsForToolCall(
    name: string,
    args: unknown,
    result?: CallToolResult,
    target?: ResponseShieldTarget
  ): DashboardDownstreamTarget[] {
    const upstream = this.options.upstream;
    const resolvedTarget = (
      toolName: unknown,
      serverHint: unknown,
      count = 1
    ): DashboardDownstreamTarget[] => {
      if (typeof toolName !== "string" || toolName.length === 0 || count < 0) {
        return [];
      }
      const server = typeof serverHint === "string" && serverHint.length > 0
        ? serverHint
        : undefined;
      const resolved = upstream.resolveServer(toolName, server);
      if (resolved && !("error" in resolved)) {
        return [{ server: resolved.server, tool: resolved.actualName, count }];
      }
      return [];
    };

    if (name === "callmux_call") {
      if (!isRecord(args)) return [];
      return resolvedTarget(args.tool, args.server);
    }

    if (name === "callmux_batch") {
      if (!isRecord(args)) return [];
      return resolvedTarget(
        args.tool,
        args.server,
        Array.isArray(args.items) ? args.items.length : 0
      );
    }

    if (name === "callmux_parallel") {
      if (!isRecord(args) || !Array.isArray(args.calls)) return [];
      const targets: DashboardDownstreamTarget[] = [];
      for (const call of args.calls) {
        if (!isRecord(call)) continue;
        targets.push(...resolvedTarget(call.tool, call.server));
      }
      return this.aggregateDashboardTargets(targets);
    }

    if (name === "callmux_pipeline") {
      if (!isRecord(args) || !Array.isArray(args.steps)) return [];
      const structured = isRecord(result?.structuredContent) ? result.structuredContent : undefined;
      const actualStepCount = Array.isArray(structured?.steps)
        ? structured.steps.length
        : args.steps.length;
      const targets: DashboardDownstreamTarget[] = [];
      for (const step of args.steps.slice(0, actualStepCount)) {
        if (!isRecord(step)) continue;
        targets.push(...resolvedTarget(step.tool, step.server));
      }
      return this.aggregateDashboardTargets(targets);
    }

    if (name === "callmux_recipe_run" && isRecord(args)) {
      const expanded = expandRecipeInvocation(this.options.config.recipes, args);
      if (!isRecord(expanded) || !isRecord(expanded.args) || typeof expanded.args.mode !== "string") {
        return [];
      }
      const expandedTool = expanded.args.mode === "call"
        ? "callmux_call"
        : `callmux_${expanded.args.mode}`;
      return this.dashboardTargetsForToolCall(expandedTool, expanded.args, result);
    }

    if (name.startsWith("callmux_")) return [];

    if (target?.tool) {
      return [{ server: target.server, tool: target.tool, count: 1 }];
    }

    return resolvedTarget(name, undefined);
  }

  private aggregateDashboardTargets(
    targets: DashboardDownstreamTarget[]
  ): DashboardDownstreamTarget[] {
    const byKey = new Map<string, DashboardDownstreamTarget>();
    for (const target of targets) {
      const key = `${target.server ?? ""}\0${target.tool}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += target.count;
      } else {
        byKey.set(key, { ...target });
      }
    }
    return [...byKey.values()].sort((left, right) =>
      `${left.server ?? ""}__${left.tool}`.localeCompare(`${right.server ?? ""}__${right.tool}`)
    );
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
      return (await authenticateBearerToken(token, auth)) ?? null;
    }

    if (!this.oidcVerifier) return null;
    return (await this.oidcVerifier.verify(token)) ?? null;
  }

  private resolveRequestId(req: IncomingMessage): string {
    const incoming = headerValue(req.headers[REQUEST_ID_HEADER]);
    if (incoming) {
      const trimmed = incoming.trim();
      // Only accept a safe, bounded token. The value is reflected in a
      // response header and written to logs, so reject anything that could
      // carry CR/LF (header/log injection) or unbounded length.
      if (/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) {
        return trimmed;
      }
    }
    return randomUUID();
  }

  private attachRequestCompletion(
    res: ServerResponse,
    context: RequestContext
  ): void {
    let completed = false;
    const finalize = (reason: "finish" | "close") => {
      if (completed) return;
      completed = true;
      const aborted = reason === "close" && !res.writableEnded;
      if (aborted) {
        this.markActiveToolCallsForRequestAborted(context.requestId);
      }
      const durationMs = Date.now() - context.startTimeMs;
      const status = aborted ? 499 : res.statusCode;
      this.metrics.onRequestComplete({
        method: context.method,
        path: context.path,
        status,
        durationMs,
      });
      this.auditLogger.writeRequestEvent({
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        status,
        durationMs,
        ...(context.remoteIp ? { remoteIp: context.remoteIp } : {}),
        ...(context.principal ? { principal: context.principal } : {}),
        ...(context.payload !== undefined ? { payload: context.payload } : {}),
      });
      if (this.isDashboardPath(context.path)) return;
      this.runtimeEvents.append({
        type: "http_request",
        timestamp: new Date().toISOString(),
        requestId: context.requestId,
        method: context.method,
        path: context.path,
        status,
        durationMs,
        ...this.summarizeHttpRequestPayload(context.payload),
        ...(context.principal ? { principal: `${context.principal.kind}:${context.principal.id}` } : {}),
      });
    };

    res.once("finish", () => finalize("finish"));
    res.once("close", () => finalize("close"));
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

      const resolved = this.options.upstream.resolveServer(toolName);
      if (!resolved || "error" in resolved) {
        // Canonicalization failed. For an already-qualified name, fall back to
        // the literal so explicit server__tool rules still match disconnected
        // servers; otherwise propagate the resolution outcome.
        if (toolName.includes("__")) return toolName;
        if (!resolved) return null;
        const message = extractStructuredErrorMessage(resolved.error);
        if (message.includes("ambiguous")) return undefined;
        return null;
      }
      // Always canonicalize to the real server key so a prefix alias (e.g.
      // gh__search_code) can't dodge an authorization rule written against the
      // real name (github__search_code).
      return `${resolved.server}__${resolved.actualName}`;
    };

    if (
      name === "callmux_status" ||
      name === "callmux_search_tools" ||
      name === "callmux_cache_clear"
    ) {
      return [];
    }

    if (name === "callmux_get_result") {
      return ["callmux_get_result"];
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
      if (isCallmuxGetResultCall(args)) return ["callmux_get_result"];
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
    payload: unknown
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

    if (
      name === "callmux_status" ||
      name === "callmux_search_tools" ||
      name === "callmux_get_result" ||
      name === "callmux_cache_clear"
    ) {
      return [];
    }

    if (name === "callmux_call" && isCallmuxGetResultCall(args)) {
      return [];
    } else if (name === "callmux_call" && isRecord(args)) {
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

class RequestBodyAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyAbortedError";
  }
}

/** Serialized byte size of a value, for per-call payload accounting. */
function jsonByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, (total ?? 0) + value);
  }
  return total;
}

function isCallmuxGetResultCall(args: unknown): args is { arguments?: unknown } {
  return (
    isRecord(args) &&
    args.tool === "callmux_get_result" &&
    (args.server === undefined || args.server === "callmux")
  );
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

export function readBody(
  req: IncomingMessage,
  maxBytes?: number
): Promise<{ body: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onClose);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onData = (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (maxBytes !== undefined && totalBytes > maxBytes) {
        settle(() => reject(new PayloadTooLargeError(maxBytes)));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      settle(() => {
        resolve({ body: Buffer.concat(chunks).toString("utf-8"), bytes: totalBytes });
      });
    };
    const onError = (error: Error) => {
      settle(() => reject(error));
    };
    const onAborted = () => {
      settle(() => reject(new RequestBodyAbortedError("request body aborted")));
    };
    const onClose = () => {
      if (req.complete) return;
      settle(() => reject(new RequestBodyAbortedError("request body closed before end")));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    req.on("close", onClose);
  });
}
