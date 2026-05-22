import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./results.js";
import { isHttpServerConfig, isStdioServerConfig } from "./types.js";
import type {
  InstanceIdentity,
  ServerConfig,
  ServerInfo,
  StdioServerConfig,
  HttpServerConfig,
  ReconnectPolicyConfig,
  ToolCallContext,
  UpstreamConnection,
  UpstreamConnectionFailure,
  ListenerRuntimeDiagnostics,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 180_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS = 600;
const DEFAULT_FILE_REF_MAX_BYTES = 1_000_000; // 1 MB
const HARD_FILE_REF_MAX_BYTES = 10_000_000; // 10 MB
const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_JITTER_RATIO = 0.2;

interface EffectiveReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  maxAttempts: number | null;
  fastFailDuringBackoff: boolean;
}

export async function mapBounded<T, R>(
  items: T[],
  maxConcurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive integer");
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index], index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

interface ConnectedServer {
  name: string;
  config: ServerConfig;
  client: Client;
  transport: Transport;
  resolvedTransport: "stdio" | "streamable-http" | "sse";
  allTools: Tool[];
  tools: Tool[];
  connectDurationMs: number;
}

interface UpstreamConnectOptions {
  maxConcurrency?: number;
  connectTimeoutMs?: number;
  reconnectPolicy?: ReconnectPolicyConfig;
  sessionCwdIdleTtlSeconds?: number;
  strictStartup?: boolean;
}

interface PreparedToolCall {
  toolName: string;
  server: string;
  actualName: string;
  resolvedArguments?: Record<string, unknown>;
}

interface ScopedClient {
  client: Client;
  transport: Transport;
  tools: Set<string>;
  activeCalls: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ToolCallFailureCategory =
  | "timeout"
  | "protocol"
  | "transport"
  | "session"
  | "authorization"
  | "unknown";

interface NormalizedToolCallFailure {
  message: string;
  category: ToolCallFailureCategory;
  rootCause: string;
  retryable: boolean;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function collectErrorMessages(error: unknown): string[] {
  const seen = new Set<unknown>();
  const out: string[] = [];

  function visit(value: unknown): void {
    if (value === null || value === undefined) return;
    if (seen.has(value)) return;
    if (typeof value === "object") seen.add(value);

    if (value instanceof Error) {
      if (value.message) out.push(value.message);
      visit((value as { cause?: unknown }).cause);
      return;
    }

    if (typeof value === "string") {
      out.push(value);
      return;
    }

    if (isPlainObject(value)) {
      const maybeMessage = value.message;
      if (typeof maybeMessage === "string") {
        out.push(maybeMessage);
      }
      visit(value.cause);
      return;
    }

    out.push(String(value));
  }

  visit(error);
  return out.map((message) => normalizeWhitespace(message)).filter((message) => message.length > 0);
}

function stripErrorNoise(message: string): string {
  return message
    .replace(/tool call error:\s*/gi, "")
    .replace(/tool call failed for [`'"].+?[`'"]\s*:?/gi, "")
    .replace(/caused by:\s*/gi, "")
    .replace(/transport send error:\s*/gi, "")
    .replace(/\[[^\]]*?\]\s*error:\s*/gi, "")
    .replace(/transport\s+error:\s*/gi, "")
    .replace(/deserialize error:\s*/gi, "")
    .replace(/^\s*:\s*/, "")
    .trim();
}

function classifyToolCallFailure(text: string): ToolCallFailureCategory {
  const lower = text.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  if (
    lower.includes("jsonrpcmessage") ||
    lower.includes("json-rpc") ||
    lower.includes("jsonrpc") ||
    lower.includes("deserialize error") ||
    lower.includes("parse error") ||
    lower.includes("invalid response frame")
  ) {
    return "protocol";
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("permission denied") ||
    lower.includes("authentication failed")
  ) {
    return "authorization";
  }
  if (
    lower.includes("transport send error") ||
    lower.includes("connection reset") ||
    lower.includes("socket hang up") ||
    lower.includes("broken pipe") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("ehostunreach")
  ) {
    return "transport";
  }
  if (
    lower.includes("session not found") ||
    lower.includes("unknown session") ||
    lower.includes("session closed") ||
    lower.includes("session expired")
  ) {
    return "session";
  }
  return "unknown";
}

function defaultCategoryMessage(category: ToolCallFailureCategory): string {
  switch (category) {
    case "timeout":
      return "downstream call timed out";
    case "protocol":
      return "downstream protocol error";
    case "transport":
      return "downstream transport error";
    case "session":
      return "downstream session error";
    case "authorization":
      return "downstream authorization error";
    default:
      return "downstream tool call failed";
  }
}

function isRetryableToolCallFailure(category: ToolCallFailureCategory): boolean {
  return (
    category === "timeout" ||
    category === "transport" ||
    category === "session" ||
    category === "protocol"
  );
}

function normalizeToolCallFailure(error: unknown): NormalizedToolCallFailure {
  const rawMessages = collectErrorMessages(error);
  const joined = rawMessages.join(" | ");
  const category = classifyToolCallFailure(joined);

  const rootCandidates = rawMessages
    .flatMap((message) => message.split(/\s+\|\s+|\n+/))
    .map((message) => stripErrorNoise(message))
    .filter((message) => message.length > 0);
  const rootCause = rootCandidates[rootCandidates.length - 1] ?? "unknown failure";

  let message = rootCause;
  if (category !== "unknown" && !rootCause.toLowerCase().includes("timed out")) {
    message = `${defaultCategoryMessage(category)}: ${rootCause}`;
  }

  return {
    message,
    category,
    rootCause,
    retryable: isRetryableToolCallFailure(category),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Manages connections to downstream MCP servers.
 * "Upstream" from callmux's perspective — these are the servers we proxy to.
 */
export class UpstreamManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private sessionClients = new Map<string, ScopedClient>();
  private sessionClientConnects = new Map<string, Promise<ScopedClient>>();
  private reconnects = new Map<string, Promise<boolean>>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private reconnectAttempts = new Map<string, number>();
  private immediateReconnectServers = new Set<string>();
  private connectionGenerations = new Map<string, number>();
  private serverConfigs = new Map<string, ServerConfig>();
  private toolsByServer = new Map<string, Tool[]>();
  private toolMap = new Map<string, { server: string; tool: Tool }>();
  private unqualifiedToolMap = new Map<string, { server: string; tool: Tool } | null>();
  private exposedToolsByServer = new Map<string, Set<string>>();
  private failedConnections: UpstreamConnectionFailure[] = [];
  private serverInfoMap = new Map<string, ServerInfo>();
  private serverConcurrency = new Map<string, number>();
  private toolSuiteGeneration = 0;
  private lastToolSuiteChangeAt: string | undefined;
  private removedTools = new Map<string, { server: string; tool: string; lastSeenAt: string; removedAt: string; alternatives: string[] }>();
  private toolSuiteSubscribers = new Set<(event: {
    server: string;
    generation: number;
    changedAt: string;
    addedTools: string[];
    removedTools: string[];
  }) => void>();
  private instanceIdentity: InstanceIdentity = { instanceId: "unknown" };
  private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  private reconnectPolicy: EffectiveReconnectPolicy = {
    initialDelayMs: RECONNECT_INITIAL_DELAY_MS,
    maxDelayMs: RECONNECT_MAX_DELAY_MS,
    jitterRatio: RECONNECT_JITTER_RATIO,
    maxAttempts: null,
    fastFailDuringBackoff: true,
  };
  private sessionCwdIdleTtlMs = DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS * 1000;
  private closing = false;
  private lifecycleGeneration = 0;

  constructor(private callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS) {}

  private effectiveCallTimeoutMs(server: string, context?: ToolCallContext): number {
    return context?.timeoutMs ?? this.serverConfigs.get(server)?.callTimeoutMs ?? this.callTimeoutMs;
  }

  private normalizeReconnectPolicy(
    policy?: ReconnectPolicyConfig
  ): EffectiveReconnectPolicy {
    const initialDelayMs = policy?.initialDelayMs ?? RECONNECT_INITIAL_DELAY_MS;
    const maxDelayMs = policy?.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    return {
      initialDelayMs,
      maxDelayMs: Math.max(initialDelayMs, maxDelayMs),
      jitterRatio: policy?.jitterRatio ?? RECONNECT_JITTER_RATIO,
      maxAttempts: policy?.maxAttempts === undefined ? null : policy.maxAttempts,
      fastFailDuringBackoff: policy?.fastFailDuringBackoff ?? true,
    };
  }

  subscribeToolSuiteChanges(callback: (event: {
    server: string;
    generation: number;
    changedAt: string;
    addedTools: string[];
    removedTools: string[];
  }) => void): () => void {
    this.toolSuiteSubscribers.add(callback);
    return () => {
      this.toolSuiteSubscribers.delete(callback);
    };
  }

  private emitToolSuiteChange(event: {
    server: string;
    generation: number;
    changedAt: string;
    addedTools: string[];
    removedTools: string[];
  }): void {
    for (const subscriber of this.toolSuiteSubscribers) {
      subscriber(event);
    }
  }

  setInstanceIdentity(identity: InstanceIdentity): void {
    this.instanceIdentity = identity;
  }

  getInstanceIdentity(): InstanceIdentity {
    return this.instanceIdentity;
  }

  private async resetConnectionState(): Promise<void> {
    this.closing = true;
    this.lifecycleGeneration++;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const scoped of this.sessionClients.values()) {
      if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
    }
    await Promise.all(
      [
        ...Array.from(this.clients.entries()).map(([name, client]) =>
          this.closeQuietly(client, this.transports.get(name))
        ),
        ...Array.from(this.sessionClients.values()).map(({ client, transport }) =>
          this.closeQuietly(client, transport)
        ),
      ]
    );
    this.clients.clear();
    this.transports.clear();
    this.sessionClients.clear();
    this.sessionClientConnects.clear();
    this.reconnects.clear();
    this.reconnectAttempts.clear();
    this.immediateReconnectServers.clear();
    this.connectionGenerations.clear();
    this.serverConfigs.clear();
    this.toolsByServer.clear();
    this.toolMap.clear();
    this.unqualifiedToolMap.clear();
    this.exposedToolsByServer.clear();
    this.removedTools.clear();
    this.serverInfoMap.clear();
    this.serverConcurrency.clear();
    this.closing = false;
  }

  private async closeQuietly(client?: Client, transport?: Transport): Promise<void> {
    const stdioChild = this.stdioChildProcess(transport);
    const closeClient = (client as { close?: () => Promise<void> | void } | undefined)?.close;
    if (closeClient) {
      try {
        await withTimeout(
          Promise.resolve(closeClient.call(client)),
          DEFAULT_CLOSE_TIMEOUT_MS,
          "downstream client close"
        );
        if (!this.isChildProcessAlive(stdioChild)) return;
      } catch {
        await this.forceCloseStdioChild(stdioChild);
      }
    }
    const closeTransport = (transport as { close?: () => Promise<void> | void } | undefined)?.close;
    if (closeTransport) {
      try {
        await withTimeout(
          Promise.resolve(closeTransport.call(transport)),
          DEFAULT_CLOSE_TIMEOUT_MS,
          "downstream transport close"
        );
      } catch {
        await this.forceCloseStdioChild(stdioChild);
      }
    }
    await this.forceCloseStdioChild(stdioChild);
  }

  private stdioChildProcess(transport?: Transport): ChildProcess | undefined {
    const candidate = (transport as { _process?: ChildProcess } | undefined)?._process;
    return candidate && typeof candidate.kill === "function" ? candidate : undefined;
  }

  private isChildProcessAlive(child?: ChildProcess): boolean {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  private async forceCloseStdioChild(child?: ChildProcess): Promise<void> {
    if (!this.isChildProcessAlive(child)) return;
    try {
      child?.stdin?.end();
    } catch {}

    try {
      child?.kill("SIGTERM");
    } catch {}
    await this.waitForChildClose(child, 250);

    if (!this.isChildProcessAlive(child)) return;
    try {
      child?.kill("SIGKILL");
    } catch {}
    await this.waitForChildClose(child, 250);
  }

  private async waitForChildClose(child: ChildProcess | undefined, timeoutMs: number): Promise<void> {
    if (!this.isChildProcessAlive(child)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        child?.once("close", () => resolve());
        child?.once("exit", () => resolve());
      }),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private createStdioTransport(config: StdioServerConfig, cwd?: string): Transport {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      cwd: cwd ?? config.cwd,
      stderr: "inherit",
    });
  }

  private createHttpTransport(config: HttpServerConfig): Transport {
    const url = new URL(config.url);
    const opts = config.headers
      ? { requestInit: { headers: config.headers } }
      : undefined;

    if (config.transport === "sse") {
      return new SSEClientTransport(url, opts);
    }

    return new StreamableHTTPClientTransport(url, opts);
  }

  private async connectWithFallback(
    name: string,
    config: HttpServerConfig,
    connectTimeoutMs: number
  ): Promise<{ transport: Transport; client: Client; resolvedTransport: "streamable-http" | "sse" }> {
    if (config.transport) {
      const transport = this.createHttpTransport(config);
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `"${name}" connect`
      );
      return { transport, client, resolvedTransport: config.transport };
    }

    // Try streamable-http first, fall back to SSE
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      );
      client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `"${name}" streamable-http connect`
      );
      return { transport, client, resolvedTransport: "streamable-http" };
    } catch {
      await this.closeQuietly(client, transport);
      process.stderr.write(`[callmux] "${name}": streamable-http failed, trying SSE fallback\n`);
      const sseTransport = new SSEClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      );
      const sseClient = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await withTimeout(
        sseClient.connect(sseTransport),
        connectTimeoutMs,
        `"${name}" SSE connect`
      );
      return { transport: sseTransport, client: sseClient, resolvedTransport: "sse" };
    }
  }

  private async connectOne(
    name: string,
    config: ServerConfig,
    connectTimeoutMs: number
  ): Promise<ConnectedServer> {
    const startTime = performance.now();
    let transport: Transport | undefined;
    let client: Client | undefined;
    let resolvedTransport: "stdio" | "streamable-http" | "sse" = "stdio";
    try {
      if (isHttpServerConfig(config)) {
        const result = await this.connectWithFallback(name, config, connectTimeoutMs);
        transport = result.transport;
        client = result.client;
        resolvedTransport = result.resolvedTransport;
      } else {
        transport = this.createStdioTransport(config);
        client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
        await withTimeout(
          client.connect(transport),
          connectTimeoutMs,
          `"${name}" connect`
        );
      }

      const { tools: allTools } = await withTimeout(
        client.listTools(),
        connectTimeoutMs,
        `"${name}" listTools`
      );

      const allowSet = config.tools ? new Set(config.tools) : null;
      const tools = allowSet
        ? allTools.filter((t) => allowSet.has(t.name))
        : allTools;

      const connectDurationMs = Math.round(performance.now() - startTime);
      return { name, config, client, transport, resolvedTransport, allTools, tools, connectDurationMs };
    } catch (error) {
      await this.closeQuietly(client, transport);
      throw error;
    }
  }

  private resolvedTransportFor(
    config: ServerConfig,
    resolvedTransport?: "stdio" | "streamable-http" | "sse"
  ): "stdio" | "streamable-http" | "sse" {
    if (resolvedTransport) return resolvedTransport;
    if (!isHttpServerConfig(config)) return "stdio";
    return config.transport ?? "streamable-http";
  }

  private rebuildToolIndexes(): void {
    this.toolMap.clear();
    this.unqualifiedToolMap.clear();
    const multiServer = this.serverConfigs.size > 1;

    for (const [server, tools] of this.toolsByServer) {
      for (const tool of tools) {
        const qualifiedName = multiServer
          ? `${server}__${tool.name}`
          : tool.name;
        this.toolMap.set(qualifiedName, { server, tool });
        this.indexUnqualifiedTool(server, tool);
      }
    }
  }

  private upsertFailedConnection(
    name: string,
    config: ServerConfig,
    error: string
  ): void {
    const existing = this.failedConnections.findIndex((failure) => failure.name === name);
    const next = { name, config, error };
    if (existing === -1) {
      this.failedConnections.push(next);
    } else {
      this.failedConnections[existing] = next;
    }
  }

  private clearFailedConnection(name: string): void {
    this.failedConnections = this.failedConnections.filter((failure) => failure.name !== name);
  }

  private installConnectedServer(connected: ConnectedServer): void {
    const {
      name,
      config,
      client,
      transport,
      resolvedTransport,
      allTools,
      tools,
      connectDurationMs,
    } = connected;
    const oldClient = this.clients.get(name);
    const oldTransport = this.transports.get(name);
    const previousTools = new Set(this.toolsByServer.get(name)?.map((tool) => tool.name) ?? []);
    const nextTools = new Set(tools.map((tool) => tool.name));
    const addedTools = Array.from(nextTools).filter((tool) => !previousTools.has(tool)).sort();
    const removedTools = Array.from(previousTools).filter((tool) => !nextTools.has(tool)).sort();
    const suiteChanged = previousTools.size === 0 || addedTools.length > 0 || removedTools.length > 0;
    const changedAt = suiteChanged ? new Date().toISOString() : undefined;
    if (suiteChanged) {
      this.toolSuiteGeneration += 1;
      this.lastToolSuiteChangeAt = changedAt;
      for (const tool of addedTools) {
        this.removedTools.delete(`${name}__${tool}`);
      }
      for (const tool of removedTools) {
        this.removedTools.set(`${name}__${tool}`, {
          server: name,
          tool,
          lastSeenAt: this.serverInfoMap.get(name)?.lastConnectedAt ?? changedAt ?? new Date().toISOString(),
          removedAt: changedAt ?? new Date().toISOString(),
          alternatives: Array.from(nextTools).sort(),
        });
      }
    }
    const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
    this.connectionGenerations.set(name, generation);

    client.onclose = () => {
      if (this.closing || this.connectionGenerations.get(name) !== generation) return;
      process.stderr.write(`[callmux] Server "${name}" disconnected\n`);
      const info = this.serverInfoMap.get(name);
      if (info) {
        this.serverInfoMap.set(name, {
          ...info,
          state: "disconnected",
          error: "transport closed",
          lastError: "transport closed",
          lastFailureAt: new Date().toISOString(),
          consecutiveFailures: (info.consecutiveFailures ?? 0) + 1,
        });
      }
      this.immediateReconnectServers.add(name);
      this.scheduleReconnect(name);
    };

    client.onerror = (err) => {
      process.stderr.write(`[callmux] Server "${name}" error: ${err.message}\n`);
    };

    this.clients.set(name, client);
    this.transports.set(name, transport);
    this.toolsByServer.set(name, tools);
    this.exposedToolsByServer.set(
      name,
      new Set(tools.map((tool) => tool.name))
    );
    if (config.maxConcurrency) {
      this.serverConcurrency.set(name, config.maxConcurrency);
    } else {
      this.serverConcurrency.delete(name);
    }
    this.serverInfoMap.set(name, {
      transport: this.resolvedTransportFor(config, resolvedTransport),
      state: "connected",
      connectDurationMs: connectDurationMs ?? 0,
      totalTools: allTools.length,
      exposedTools: tools.length,
      ...(config.tools ? { toolFilter: config.tools } : {}),
      ...(config.maxConcurrency ? { maxConcurrency: config.maxConcurrency } : {}),
      lastConnectedAt: new Date().toISOString(),
      consecutiveFailures: 0,
      toolSuiteGeneration: this.toolSuiteGeneration,
      ...(this.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: this.lastToolSuiteChangeAt } : {}),
      ...(addedTools.length > 0 ? { addedTools } : {}),
      ...(removedTools.length > 0 ? { removedTools } : {}),
    });
    this.clearFailedConnection(name);
    this.reconnectAttempts.delete(name);
    this.immediateReconnectServers.delete(name);
    this.rebuildToolIndexes();

    if (oldClient && oldClient !== client) {
      void this.closeQuietly(oldClient, oldTransport);
    }
    if (suiteChanged && changedAt && (addedTools.length > 0 || removedTools.length > 0)) {
      this.emitToolSuiteChange({
        server: name,
        generation: this.toolSuiteGeneration,
        changedAt,
        addedTools,
        removedTools,
      });
    }
  }

  private reconnectDelayMs(attempts: number): number {
    const base = Math.min(
      this.reconnectPolicy.maxDelayMs,
      this.reconnectPolicy.initialDelayMs * (2 ** Math.max(0, attempts))
    );
    if (this.reconnectPolicy.jitterRatio <= 0) return base;
    const jitter = base * this.reconnectPolicy.jitterRatio;
    return Math.max(0, Math.round(base - jitter + Math.random() * jitter * 2));
  }

  private scheduleReconnect(name: string): void {
    if (this.closing) return;
    if (this.reconnects.has(name) || this.reconnectTimers.has(name)) return;
    const config = this.serverConfigs.get(name);
    if (!config) return;

    const attempts = this.reconnectAttempts.get(name) ?? 0;
    if (
      this.reconnectPolicy.maxAttempts !== null &&
      attempts >= this.reconnectPolicy.maxAttempts
    ) {
      const info = this.serverInfoMap.get(name);
      this.serverInfoMap.set(name, {
        transport: info?.transport ?? this.resolvedTransportFor(config),
        state: "failed",
        connectDurationMs: info?.connectDurationMs ?? 0,
        totalTools: info?.totalTools ?? 0,
        exposedTools: info?.exposedTools ?? 0,
        ...(info?.toolFilter ? { toolFilter: info.toolFilter } : {}),
        ...(info?.maxConcurrency ? { maxConcurrency: info.maxConcurrency } : {}),
        error: info?.error ?? "reconnect attempts exhausted",
        lastError: info?.lastError ?? info?.error ?? "reconnect attempts exhausted",
        ...(info?.lastConnectedAt ? { lastConnectedAt: info.lastConnectedAt } : {}),
        lastFailureAt: info?.lastFailureAt ?? new Date().toISOString(),
        consecutiveFailures: info?.consecutiveFailures ?? attempts,
        reconnectAttempts: attempts,
      });
      return;
    }

    const delayMs = this.reconnectDelayMs(attempts);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    const info = this.serverInfoMap.get(name);
    this.serverInfoMap.set(name, {
      transport: info?.transport ?? this.resolvedTransportFor(config),
      state: "reconnecting",
      connectDurationMs: info?.connectDurationMs ?? 0,
      totalTools: info?.totalTools ?? 0,
      exposedTools: info?.exposedTools ?? 0,
      ...(info?.toolFilter ? { toolFilter: info.toolFilter } : {}),
      ...(info?.maxConcurrency ? { maxConcurrency: info.maxConcurrency } : {}),
      ...(info?.error ? { error: info.error } : {}),
      ...(info?.lastError ? { lastError: info.lastError } : {}),
      ...(info?.lastConnectedAt ? { lastConnectedAt: info.lastConnectedAt } : {}),
      ...(info?.lastFailureAt ? { lastFailureAt: info.lastFailureAt } : {}),
      ...(info?.consecutiveFailures ? { consecutiveFailures: info.consecutiveFailures } : {}),
      ...(info?.toolSuiteGeneration ? { toolSuiteGeneration: info.toolSuiteGeneration } : {}),
      ...(info?.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: info.lastToolSuiteChangeAt } : {}),
      reconnectAttempts: attempts,
      nextRetryAt,
    });

    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name);
      void this.reconnectServer(name, "background");
    }, delayMs);
    timer.unref?.();
    this.reconnectTimers.set(name, timer);
  }

  private retireFailedCallClient(
    server: string,
    client: Client | undefined,
    category: ToolCallFailureCategory,
    message: string,
    scopedKey?: string
  ): void {
    if (!client) return;
    if (!["timeout", "transport", "session", "protocol"].includes(category)) return;

    if (scopedKey) {
      const scoped = this.sessionClients.get(scopedKey);
      if (!scoped || scoped.client !== client) return;
      if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
      this.sessionClients.delete(scopedKey);
      void this.closeQuietly(scoped.client, scoped.transport);
      return;
    }

    if (this.clients.get(server) !== client) return;
    const transport = this.transports.get(server);
    this.connectionGenerations.set(
      server,
      (this.connectionGenerations.get(server) ?? 0) + 1
    );

    const config = this.serverConfigs.get(server);
    const info = this.serverInfoMap.get(server);
    if (info || config) {
      const failedAt = new Date().toISOString();
      this.serverInfoMap.set(server, {
        transport: info?.transport ?? (config ? this.resolvedTransportFor(config) : "stdio"),
        state: "disconnected",
        connectDurationMs: info?.connectDurationMs ?? 0,
        totalTools: info?.totalTools ?? 0,
        exposedTools: info?.exposedTools ?? 0,
        ...(info?.toolFilter ? { toolFilter: info.toolFilter } : {}),
        ...(info?.maxConcurrency ? { maxConcurrency: info.maxConcurrency } : {}),
        error: message,
        lastError: message,
        ...(info?.lastConnectedAt ? { lastConnectedAt: info.lastConnectedAt } : {}),
        lastFailureAt: failedAt,
        consecutiveFailures: (info?.consecutiveFailures ?? 0) + 1,
        ...(info?.reconnectAttempts ? { reconnectAttempts: info.reconnectAttempts } : {}),
        ...(info?.toolSuiteGeneration ? { toolSuiteGeneration: info.toolSuiteGeneration } : {}),
        ...(info?.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: info.lastToolSuiteChangeAt } : {}),
      });
    }

    void this.closeQuietly(client, transport);
    this.immediateReconnectServers.add(server);
    this.scheduleReconnect(server);
  }

  private async reconnectServer(
    name: string,
    trigger: "background" | "call"
  ): Promise<boolean> {
    const existing = this.reconnects.get(name);
    if (existing) return existing;

    const config = this.serverConfigs.get(name);
    if (!config) return false;

    const timer = this.reconnectTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(name);
    }
    const lifecycleGeneration = this.lifecycleGeneration;

    const promise = (async () => {
      let attempts = this.reconnectAttempts.get(name) ?? 0;
      if (
        this.reconnectPolicy.maxAttempts !== null &&
        attempts >= this.reconnectPolicy.maxAttempts &&
        trigger === "background"
      ) {
        return false;
      }
      if (
        this.reconnectPolicy.maxAttempts !== null &&
        attempts >= this.reconnectPolicy.maxAttempts &&
        trigger === "call"
      ) {
        attempts = 0;
      }

      attempts++;
      this.reconnectAttempts.set(name, attempts);
      const previous = this.serverInfoMap.get(name);
      this.serverInfoMap.set(name, {
        transport: previous?.transport ?? this.resolvedTransportFor(config),
        state: "reconnecting",
        connectDurationMs: previous?.connectDurationMs ?? 0,
        totalTools: previous?.totalTools ?? 0,
        exposedTools: previous?.exposedTools ?? 0,
        ...(previous?.toolFilter ? { toolFilter: previous.toolFilter } : {}),
        ...(previous?.maxConcurrency ? { maxConcurrency: previous.maxConcurrency } : {}),
        ...(previous?.error ? { error: previous.error } : {}),
        ...(previous?.lastError ? { lastError: previous.lastError } : {}),
        ...(previous?.lastConnectedAt ? { lastConnectedAt: previous.lastConnectedAt } : {}),
        ...(previous?.lastFailureAt ? { lastFailureAt: previous.lastFailureAt } : {}),
        ...(previous?.consecutiveFailures ? { consecutiveFailures: previous.consecutiveFailures } : {}),
        ...(previous?.toolSuiteGeneration ? { toolSuiteGeneration: previous.toolSuiteGeneration } : {}),
        ...(previous?.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: previous.lastToolSuiteChangeAt } : {}),
        reconnectAttempts: attempts,
      });

      let shouldSchedule = false;
      try {
        const connected = await this.connectOne(name, config, this.connectTimeoutMs);
        if (this.closing || this.lifecycleGeneration !== lifecycleGeneration) {
          await this.closeQuietly(connected.client, connected.transport);
          return false;
        }
        this.installConnectedServer(connected);
        const info = this.serverInfoMap.get(name);
        process.stderr.write(
          `[callmux] Reconnected "${name}": ${info?.exposedTools ?? connected.tools.length} tools\n`
        );
        return true;
      } catch (error) {
        const message = errorMessage(error);
        if (this.closing || this.lifecycleGeneration !== lifecycleGeneration) {
          return false;
        }
        const exhausted =
          this.reconnectPolicy.maxAttempts !== null &&
          attempts >= this.reconnectPolicy.maxAttempts;
        const previousInfo = this.serverInfoMap.get(name);
        const failedAt = new Date().toISOString();
        this.serverInfoMap.set(name, {
          transport: previousInfo?.transport ?? this.resolvedTransportFor(config),
          state: exhausted ? "failed" : "disconnected",
          connectDurationMs: previousInfo?.connectDurationMs ?? 0,
          totalTools: previousInfo?.totalTools ?? 0,
          exposedTools: previousInfo?.exposedTools ?? 0,
          ...(previousInfo?.toolFilter ? { toolFilter: previousInfo.toolFilter } : {}),
          ...(previousInfo?.maxConcurrency ? { maxConcurrency: previousInfo.maxConcurrency } : {}),
          error: message,
          lastError: message,
          ...(previousInfo?.lastConnectedAt ? { lastConnectedAt: previousInfo.lastConnectedAt } : {}),
          lastFailureAt: failedAt,
          consecutiveFailures: (previousInfo?.consecutiveFailures ?? 0) + 1,
          ...(previousInfo?.toolSuiteGeneration ? { toolSuiteGeneration: previousInfo.toolSuiteGeneration } : {}),
          ...(previousInfo?.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: previousInfo.lastToolSuiteChangeAt } : {}),
          reconnectAttempts: attempts,
        });
        this.upsertFailedConnection(name, config, message);
        shouldSchedule = !exhausted;
        process.stderr.write(
          `[callmux] Warning: reconnect failed "${name}": ${message}\n`
        );
        return false;
      } finally {
        this.reconnects.delete(name);
        if (shouldSchedule && !this.closing) {
          this.scheduleReconnect(name);
        }
      }
    })();

    this.reconnects.set(name, promise);
    return promise;
  }

  private downstreamUnavailable(server: string, toolName: string): CallToolResult {
    const info = this.serverInfoMap.get(server);
    return errorResult(
      "downstream_unavailable",
      `server "${server}" is not available for tool "${toolName}"`,
      {
        server,
        tool: toolName,
        retryable: true,
        ...(info?.state ? { state: info.state } : {}),
        ...(info?.lastError ?? info?.error ? { lastError: info.lastError ?? info.error } : {}),
        ...(info?.lastFailureAt ? { lastFailureAt: info.lastFailureAt } : {}),
        ...(info?.lastConnectedAt ? { lastConnectedAt: info.lastConnectedAt } : {}),
        ...(info?.consecutiveFailures !== undefined
          ? { consecutiveFailures: info.consecutiveFailures }
          : {}),
        ...(info?.reconnectAttempts !== undefined
          ? { reconnectAttempts: info.reconnectAttempts }
          : {}),
        ...(info?.nextRetryAt ? { nextRetryAt: info.nextRetryAt } : {}),
      }
    );
  }

  private sessionClientKey(server: string, cwd: string): string {
    return `${server}\0${cwd}`;
  }

  private serverUsesSessionCwd(server: string): boolean {
    const config = this.serverConfigs.get(server);
    return Boolean(config && isStdioServerConfig(config) && config.cwdMode !== "global");
  }

  private shouldUseSessionCwd(server: string, context?: ToolCallContext): context is ToolCallContext & { cwd: string } {
    return Boolean(context?.cwd && this.serverUsesSessionCwd(server));
  }

  usesSessionCwd(toolName: string, serverHint?: string): boolean {
    const resolved = this.resolveServer(toolName, serverHint);
    if (!resolved || "error" in resolved) return false;
    return this.serverUsesSessionCwd(resolved.server);
  }

  cacheScopeForCall(
    toolName: string,
    serverHint?: string,
    context?: ToolCallContext
  ): string | undefined {
    return context?.cwd && this.usesSessionCwd(toolName, serverHint)
      ? context.cwd
      : undefined;
  }

  getScopedStdioClientDiagnostics(): ListenerRuntimeDiagnostics["scopedStdioClients"]["items"] {
    return Array.from(this.sessionClients.entries())
      .map(([key, scoped]) => {
        const separator = key.indexOf("\0");
        const server = separator === -1 ? key : key.slice(0, separator);
        const cwd = separator === -1 ? "" : key.slice(separator + 1);
        return {
          server,
          cwd,
          activeCalls: scoped.activeCalls,
          idle: scoped.activeCalls === 0,
        };
      })
      .sort((left, right) =>
        left.server === right.server
          ? left.cwd.localeCompare(right.cwd)
          : left.server.localeCompare(right.server)
      );
  }

  private refreshSessionClientIdleTimer(
    key: string,
    server: string,
    cwd: string,
    scoped: ScopedClient
  ): void {
    if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
    if (this.sessionCwdIdleTtlMs <= 0) return;

    scoped.idleTimer = setTimeout(() => {
      if (this.sessionClients.get(key) !== scoped) return;
      if (scoped.activeCalls > 0) return;
      this.sessionClients.delete(key);
      void this.closeQuietly(scoped.client, scoped.transport);
      process.stderr.write(`[callmux] Session-scoped server "${server}" idle timeout (${cwd})\n`);
    }, this.sessionCwdIdleTtlMs);
    scoped.idleTimer.unref?.();
  }

  private closeSessionClientAfterCall(
    key: string,
    scoped: ScopedClient
  ): void {
    if (this.sessionCwdIdleTtlMs !== 0) return;
    if (scoped.activeCalls > 0) return;
    this.sessionClients.delete(key);
    void this.closeQuietly(scoped.client, scoped.transport);
  }

  private acquireSessionClient(scoped: ScopedClient): void {
    if (scoped.idleTimer) {
      clearTimeout(scoped.idleTimer);
      scoped.idleTimer = undefined;
    }
    scoped.activeCalls++;
  }

  private releaseSessionClient(scoped: ScopedClient): void {
    scoped.activeCalls = Math.max(0, scoped.activeCalls - 1);
  }

  private validateSessionToolSurface(
    server: string,
    cwd: string,
    allTools: Tool[]
  ): Set<string> {
    const available = new Set(allTools.map((tool) => tool.name));
    const expected = this.exposedToolsByServer.get(server);
    if (!expected) return available;

    const missing = Array.from(expected).filter((tool) => !available.has(tool));
    if (missing.length > 0) {
      throw new Error(
        `session-scoped server "${server}" at cwd "${cwd}" did not expose expected tool(s): ${missing.join(", ")}`
      );
    }

    return available;
  }

  private async getSessionClient(
    server: string,
    cwd: string
  ): Promise<ScopedClient | null> {
    const config = this.serverConfigs.get(server);
    if (!config || !isStdioServerConfig(config)) return null;

    const key = this.sessionClientKey(server, cwd);
    const existing = this.sessionClients.get(key);
    if (existing) {
      this.acquireSessionClient(existing);
      return existing;
    }

    const connecting = this.sessionClientConnects.get(key);
    if (connecting) {
      const scoped = await connecting;
      this.acquireSessionClient(scoped);
      return scoped;
    }

    const promise = (async () => {
      const transport = this.createStdioTransport(config, cwd);
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      try {
        await withTimeout(
          client.connect(transport),
          this.connectTimeoutMs,
          `"${server}" connect (${cwd})`
        );
        const { tools: allTools } = await withTimeout(
          client.listTools(),
          this.connectTimeoutMs,
          `"${server}" listTools (${cwd})`
        );
        const tools = this.validateSessionToolSurface(server, cwd, allTools);
        const scoped: ScopedClient = { client, transport, tools, activeCalls: 0 };
        this.sessionClients.set(key, scoped);

        client.onclose = () => {
          if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
          this.sessionClients.delete(key);
          process.stderr.write(`[callmux] Session-scoped server "${server}" disconnected (${cwd})\n`);
        };
        client.onerror = (err) => {
          process.stderr.write(`[callmux] Session-scoped server "${server}" error (${cwd}): ${err.message}\n`);
        };

        return scoped;
      } catch (error) {
        await this.closeQuietly(client, transport);
        throw error;
      } finally {
        this.sessionClientConnects.delete(key);
      }
    })();

    this.sessionClientConnects.set(key, promise);
    const scoped = await promise;
    this.acquireSessionClient(scoped);
    return scoped;
  }

  private async clientForCall(
    server: string,
    toolName: string,
    context?: ToolCallContext
  ): Promise<Client | { error: CallToolResult } | undefined> {
    if (this.shouldUseSessionCwd(server, context)) {
      const scoped = await this.getSessionClient(server, context.cwd);
      if (scoped) return scoped.client;
    }

    const info = this.serverInfoMap.get(server);
    const allowImmediateReconnect = this.immediateReconnectServers.delete(server);
    if (info && info.state !== "connected") {
      if (
        this.reconnectPolicy.fastFailDuringBackoff &&
        !context?.forceReconnect &&
        !allowImmediateReconnect &&
        info.nextRetryAt &&
        Date.parse(info.nextRetryAt) > Date.now() &&
        info.error !== "transport closed"
      ) {
        return { error: this.downstreamUnavailable(server, toolName) };
      }
      const reconnected = await this.reconnectServer(server, "call");
      if (!reconnected) {
        return { error: this.downstreamUnavailable(server, toolName) };
      }
    }

    return this.clients.get(server);
  }

  async connect(
    servers: Record<string, ServerConfig>,
    options: UpstreamConnectOptions = {}
  ): Promise<UpstreamConnection[]> {
    await this.resetConnectionState();

    const entries = Object.entries(servers);
    const activeEntries = entries.filter(([, config]) => !config.disabled);
    this.serverConfigs = new Map(entries);
    const maxConcurrency = options.maxConcurrency ?? 20;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.connectTimeoutMs = connectTimeoutMs;
    this.reconnectPolicy = this.normalizeReconnectPolicy(options.reconnectPolicy);
    this.sessionCwdIdleTtlMs =
      (options.sessionCwdIdleTtlSeconds ?? DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS) * 1000;
    const strictStartup = options.strictStartup ?? false;
    this.failedConnections = [];

    const startTimes = new Map<string, number>();
    for (const [name, config] of entries) {
      if (config.disabled) {
        this.serverInfoMap.set(name, {
          transport: this.resolvedTransportFor(config),
          state: "disabled",
          connectDurationMs: 0,
          totalTools: 0,
          exposedTools: 0,
          ...(config.tools ? { toolFilter: config.tools } : {}),
          ...(config.maxConcurrency ? { maxConcurrency: config.maxConcurrency } : {}),
          toolSuiteGeneration: this.toolSuiteGeneration,
        });
        continue;
      }
      this.serverInfoMap.set(name, {
        transport: this.resolvedTransportFor(config),
        state: "starting",
        connectDurationMs: 0,
        totalTools: 0,
        exposedTools: 0,
        ...(config.tools ? { toolFilter: config.tools } : {}),
        ...(config.maxConcurrency ? { maxConcurrency: config.maxConcurrency } : {}),
        toolSuiteGeneration: this.toolSuiteGeneration,
      });
    }
    const results = await mapBounded(activeEntries, maxConcurrency, async ([name, config]) => {
      startTimes.set(name, performance.now());
      try {
        return {
          status: "fulfilled" as const,
          value: await this.connectOne(name, config, connectTimeoutMs),
        };
      } catch (error) {
        return {
          status: "rejected" as const,
          reason: {
            name,
            config,
            error: errorMessage(error),
          } satisfies UpstreamConnectionFailure,
        };
      }
    });

    const connected = results
      .filter((result): result is { status: "fulfilled"; value: ConnectedServer } =>
        result.status === "fulfilled"
      )
      .map((result) => result.value);
    this.failedConnections = results
      .filter((result): result is { status: "rejected"; reason: UpstreamConnectionFailure } =>
        result.status === "rejected"
      )
      .map((result) => result.reason);

    if (strictStartup && this.failedConnections.length > 0) {
      await Promise.all(
        connected.map(({ client, transport }) => this.closeQuietly(client, transport))
      );
      const summary = this.failedConnections
        .map((failure) => `${failure.name}: ${failure.error}`)
        .join("; ");
      throw new Error(`downstream startup failed: ${summary}`);
    }

    const connections: UpstreamConnection[] = [];

    for (const connectedServer of connected) {
      const { name, config, allTools, tools, connectDurationMs, resolvedTransport } = connectedServer;
      this.installConnectedServer(connectedServer);
      connections.push({ name, config, tools });

      const filtered = config.tools ? ` (filtered from ${allTools.length})` : "";
      const transportLabel = isHttpServerConfig(config) ? ` [${resolvedTransport}]` : "";
      process.stderr.write(`[callmux] Connected to "${name}"${transportLabel}: ${tools.length} tools${filtered} (${connectDurationMs}ms)\n`);
    }

    for (const failure of this.failedConnections) {
      const failDuration = Math.round(performance.now() - (startTimes.get(failure.name) ?? 0));
      const failedTransport: "stdio" | "streamable-http" | "sse" = isHttpServerConfig(failure.config)
        ? (failure.config.transport ?? "streamable-http")
        : "stdio";
      this.serverInfoMap.set(failure.name, {
        transport: failedTransport,
        state: "failed",
        connectDurationMs: failDuration,
        totalTools: 0,
        exposedTools: 0,
        ...(failure.config.tools ? { toolFilter: failure.config.tools } : {}),
        error: failure.error,
        lastError: failure.error,
        lastFailureAt: new Date().toISOString(),
        consecutiveFailures: 1,
        reconnectAttempts: 0,
        toolSuiteGeneration: this.toolSuiteGeneration,
      });
      process.stderr.write(
        `[callmux] Warning: failed to connect "${failure.name}": ${failure.error} (${failDuration}ms)\n`
      );
      this.scheduleReconnect(failure.name);
    }

    return connections;
  }

  getTools(): Array<{ qualifiedName: string; server: string; tool: Tool }> {
    return Array.from(this.toolMap.entries()).map(([qualifiedName, { server, tool }]) => ({
      qualifiedName,
      server,
      tool,
    }));
  }

  private toolNotFound(toolName: string): CallToolResult {
    const removed = this.removedToolErrorFor(toolName);
    if (removed) return removed;
    return errorResult("tool_not_found", `tool "${toolName}" not found`, {
      tool: toolName,
    });
  }

  private removedToolErrorFor(toolName: string, serverHint?: string): CallToolResult | undefined {
    const candidates = serverHint
      ? [`${serverHint}__${toolName.startsWith(`${serverHint}__`) ? toolName.slice(serverHint.length + 2) : toolName}`]
      : toolName.includes("__")
        ? [toolName]
        : Array.from(this.removedTools.keys()).filter((key) => key.endsWith(`__${toolName}`));
    if (candidates.length !== 1) return undefined;
    const removed = this.removedTools.get(candidates[0]);
    if (!removed) return undefined;
    return errorResult(
      "tool_removed_after_reconnect",
      `tool "${removed.tool}" was removed from server "${removed.server}" after reconnect`,
      {
        server: removed.server,
        tool: removed.tool,
        lastSeenAt: removed.lastSeenAt,
        removedAt: removed.removedAt,
        currentTools: removed.alternatives,
      }
    );
  }

  private resolutionError(
    message: string,
    details?: Record<string, unknown>
  ): CallToolResult {
    return errorResult("tool_resolution_failed", message, details);
  }

  private getKnownServerNames(): string[] {
    return Array.from(
      new Set([
        ...Array.from(this.clients.keys()),
        ...Array.from(this.serverConfigs.keys()),
        ...this.failedConnections.map((failure) => failure.name),
      ])
    ).sort();
  }

  private splitKnownQualifiedToolName(
    toolName: string
  ): { server: string; actualName: string } | undefined {
    for (const server of this.getKnownServerNames().sort((a, b) => b.length - a.length)) {
      const prefix = `${server}__`;
      if (toolName.startsWith(prefix)) {
        return { server, actualName: toolName.slice(prefix.length) };
      }
    }
    return undefined;
  }

  private indexUnqualifiedTool(server: string, tool: Tool): void {
    const existing = this.unqualifiedToolMap.get(tool.name);
    if (existing === undefined) {
      this.unqualifiedToolMap.set(tool.name, { server, tool });
      return;
    }

    if (existing === null) return;
    if (existing.server !== server) {
      this.unqualifiedToolMap.set(tool.name, null);
    }
  }

  private async resolveFileReferences(
    value: unknown,
    path: string
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(
        value.map((item, index) => this.resolveFileReferences(item, `${path}[${index}]`))
      );
    }

    if (!isPlainObject(value)) {
      return value;
    }

    if ("$file" in value) {
      const allowedKeys = new Set(["$file", "maxBytes"]);
      const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(
          `invalid $file reference at ${path}: unexpected keys [${unexpectedKeys.join(", ")}]`
        );
      }

      const filePath = value.$file;
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error(`invalid $file reference at ${path}: "$file" must be a non-empty string`);
      }

      const requestedMaxBytesRaw = value.maxBytes;
      let requestedMaxBytes: number | undefined;
      if (requestedMaxBytesRaw !== undefined) {
        if (
          typeof requestedMaxBytesRaw !== "number" ||
          !Number.isInteger(requestedMaxBytesRaw) ||
          requestedMaxBytesRaw <= 0 ||
          requestedMaxBytesRaw > HARD_FILE_REF_MAX_BYTES
        ) {
          throw new Error(
            `invalid $file reference at ${path}: "maxBytes" must be a positive integer <= ${HARD_FILE_REF_MAX_BYTES}`
          );
        }
        requestedMaxBytes = requestedMaxBytesRaw;
      }
      const maxBytes = requestedMaxBytes ?? DEFAULT_FILE_REF_MAX_BYTES;

      const fileStats = await stat(filePath);
      if (fileStats.size > maxBytes) {
        throw new Error(
          `file reference at ${path} exceeds maxBytes (${fileStats.size} > ${maxBytes}): ${filePath}`
        );
      }

      const content = await readFile(filePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > maxBytes) {
        throw new Error(
          `file reference at ${path} exceeds maxBytes after read: ${filePath}`
        );
      }
      return content;
    }

    if ("$jsonFile" in value || "$yamlFile" in value) {
      const refKey = "$jsonFile" in value ? "$jsonFile" : "$yamlFile";
      const allowedKeys = new Set([refKey, "maxBytes"]);
      const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(
          `invalid ${refKey} reference at ${path}: unexpected keys [${unexpectedKeys.join(", ")}]`
        );
      }

      const filePath = value[refKey];
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error(`invalid ${refKey} reference at ${path}: "${refKey}" must be a non-empty string`);
      }

      const requestedMaxBytesRaw = value.maxBytes;
      let requestedMaxBytes: number | undefined;
      if (requestedMaxBytesRaw !== undefined) {
        if (
          typeof requestedMaxBytesRaw !== "number" ||
          !Number.isInteger(requestedMaxBytesRaw) ||
          requestedMaxBytesRaw <= 0 ||
          requestedMaxBytesRaw > HARD_FILE_REF_MAX_BYTES
        ) {
          throw new Error(
            `invalid ${refKey} reference at ${path}: "maxBytes" must be a positive integer <= ${HARD_FILE_REF_MAX_BYTES}`
          );
        }
        requestedMaxBytes = requestedMaxBytesRaw;
      }
      const maxBytes = requestedMaxBytes ?? DEFAULT_FILE_REF_MAX_BYTES;

      const fileStats = await stat(filePath);
      if (fileStats.size > maxBytes) {
        throw new Error(
          `${refKey} reference at ${path} exceeds maxBytes (${fileStats.size} > ${maxBytes}): ${filePath}`
        );
      }

      const content = await readFile(filePath, "utf8");
      if (Buffer.byteLength(content, "utf8") > maxBytes) {
        throw new Error(
          `${refKey} reference at ${path} exceeds maxBytes after read: ${filePath}`
        );
      }

      try {
        if (refKey === "$jsonFile") {
          return JSON.parse(content) as unknown;
        }
        return parseYaml(content) as unknown;
      } catch (error) {
        throw new Error(
          `failed to parse ${refKey} at ${path} (${filePath}): ${errorMessage(error)}`
        );
      }
    }

    if ("$text" in value) {
      const allowedKeys = new Set(["$text"]);
      const unexpectedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(
          `invalid $text reference at ${path}: unexpected keys [${unexpectedKeys.join(", ")}]`
        );
      }

      const textSpec = value.$text;
      if (typeof textSpec === "string") {
        return textSpec;
      }

      if (!isPlainObject(textSpec)) {
        throw new Error(
          `invalid $text reference at ${path}: "$text" must be a string or { lines, join? } object`
        );
      }

      const allowedTextSpecKeys = new Set(["lines", "join"]);
      const unexpectedTextSpecKeys = Object.keys(textSpec).filter(
        (key) => !allowedTextSpecKeys.has(key)
      );
      if (unexpectedTextSpecKeys.length > 0) {
        throw new Error(
          `invalid $text reference at ${path}: unexpected $text keys [${unexpectedTextSpecKeys.join(", ")}]`
        );
      }

      if (!("lines" in textSpec) || !Array.isArray(textSpec.lines)) {
        throw new Error(
          `invalid $text reference at ${path}: "$text.lines" must be an array of strings`
        );
      }

      if (!textSpec.lines.every((line) => typeof line === "string")) {
        throw new Error(
          `invalid $text reference at ${path}: "$text.lines" must contain only strings`
        );
      }

      const join = textSpec.join ?? "\n";
      if (typeof join !== "string") {
        throw new Error(
          `invalid $text reference at ${path}: "$text.join" must be a string`
        );
      }

      return textSpec.lines.join(join);
    }

    const resolvedEntries = await Promise.all(
      Object.entries(value).map(async ([key, nested]) => [
        key,
        await this.resolveFileReferences(nested, `${path}.${key}`),
      ] as const)
    );
    return Object.fromEntries(resolvedEntries);
  }

  async resolveToolArguments(
    args?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    if (!args) return args;
    const resolved = await this.resolveFileReferences(args, "arguments");
    return resolved as Record<string, unknown>;
  }

  async prepareToolCall(
    toolName: string,
    args?: Record<string, unknown>,
    serverHint?: string
  ): Promise<PreparedToolCall | { error: CallToolResult }> {
    const resolved = this.resolveServer(toolName, serverHint);
    if (!resolved) {
      return { error: this.toolNotFound(toolName) };
    }
    if ("error" in resolved) {
      return resolved;
    }

    try {
      const resolvedArguments = await this.resolveToolArguments(args);
      return {
        toolName,
        server: resolved.server,
        actualName: resolved.actualName,
        ...(resolvedArguments ? { resolvedArguments } : {}),
      };
    } catch (error) {
      return {
        error: errorResult("argument_resolution_failed", errorMessage(error), {
          tool: toolName,
          ...(serverHint ? { server: serverHint } : {}),
        }),
      };
    }
  }

  resolveServer(
    toolName: string,
    serverHint?: string
  ): { actualName: string; server: string } | { error: CallToolResult } | null {
    if (serverHint) {
      const config = this.serverConfigs.get(serverHint);
      const knownClient = this.clients.has(serverHint);
      if (!config && !knownClient) {
        const availableServers = this.getKnownServerNames();
        const namespaceText = this.instanceIdentity.namespace
          ? ` (namespace: ${this.instanceIdentity.namespace})`
          : "";
        const wrappedText =
          availableServers.length > 0
            ? ` This instance wraps: [${availableServers.join(", ")}].`
            : " This instance has no connected or known downstream servers.";
        return {
          error: this.resolutionError(
            `server "${serverHint}" not found in this callmux instance${namespaceText}.${wrappedText}`,
            {
              server: serverHint,
              availableServers,
              ...(this.instanceIdentity.namespace
                ? { namespace: this.instanceIdentity.namespace }
                : {}),
              instanceId: this.instanceIdentity.instanceId,
            }
          ),
        };
      }

      const exposedTools = this.exposedToolsByServer.get(serverHint);
      const qualifiedPrefix = `${serverHint}__`;
      const actualName = toolName.startsWith(qualifiedPrefix)
        ? toolName.slice(qualifiedPrefix.length)
        : toolName;

      const removed = this.removedToolErrorFor(actualName, serverHint);
      if (removed) return { error: removed };

      const configuredTools = config?.tools ? new Set(config.tools) : undefined;
      if (!exposedTools && configuredTools && !configuredTools.has(actualName)) {
        return {
          error: this.resolutionError(
            `tool "${actualName}" is not exposed on server "${serverHint}"`
          ),
        };
      }

      if (!exposedTools?.has(actualName)) {
        if (!this.clients.has(serverHint)) {
          return { actualName, server: serverHint };
        }
        return {
          error: this.resolutionError(
            `tool "${actualName}" is not exposed on server "${serverHint}"`
          ),
        };
      }

      return { actualName, server: serverHint };
    }

    const entry = this.toolMap.get(toolName);
    if (entry) {
      return { actualName: entry.tool.name, server: entry.server };
    }

    const knownQualified = this.splitKnownQualifiedToolName(toolName);
    if (knownQualified) {
      return this.resolveServer(knownQualified.actualName, knownQualified.server);
    }

    const unqualified = this.unqualifiedToolMap.get(toolName);
    if (unqualified === undefined) {
      // Legacy fallback for harnesses that mutate toolMap directly in tests or integrations.
      const matches = Array.from(this.toolMap.values()).filter(
        ({ tool }) => tool.name === toolName
      );

      if (matches.length === 1) {
        const match = matches[0];
        return { actualName: match.tool.name, server: match.server };
      }

      if (matches.length > 1) {
        return {
          error: this.resolutionError(
            `tool "${toolName}" is ambiguous across multiple servers; specify "server" or use a qualified tool name`
          ),
        };
      }
      return null;
    }

    if (unqualified && unqualified !== null) {
      return { actualName: unqualified.tool.name, server: unqualified.server };
    }

    if (unqualified === null) {
      return {
        error: this.resolutionError(
          `tool "${toolName}" is ambiguous across multiple servers; specify "server" or use a qualified tool name`
        ),
      };
    }

    const removed = this.removedToolErrorFor(toolName);
    if (removed) return { error: removed };
    return null;
  }

  async callTool(
    toolName: string,
    args?: Record<string, unknown>,
    serverHint?: string,
    context?: ToolCallContext
  ): Promise<CallToolResult> {
    const prepared = await this.prepareToolCall(toolName, args, serverHint);
    if ("error" in prepared) return prepared.error;
    const scopedKey = this.shouldUseSessionCwd(prepared.server, context)
      ? this.sessionClientKey(prepared.server, context.cwd)
      : undefined;
    let callClient: Client | undefined;

    try {
      const invoke = async (forceReconnect = false): Promise<CallToolResult> => {
        const client = await this.clientForCall(
          prepared.server,
          prepared.actualName,
          forceReconnect ? { ...context, forceReconnect: true } : context
        );
        if (client && "error" in client) return client.error;
        if (!client) {
          return this.toolNotFound(toolName);
        }
        callClient = client;
        const timeoutMs = this.effectiveCallTimeoutMs(prepared.server, context);
        const result = await withTimeout(
          client.callTool(
            {
              name: prepared.actualName,
              arguments: prepared.resolvedArguments,
            },
            undefined,
            timeoutMs > 0 ? { timeout: timeoutMs } : undefined
          ),
          timeoutMs,
          `"${prepared.server}" tool "${prepared.actualName}" call`
        );
        return result as unknown as CallToolResult;
      };

      const result = await invoke();
      return result;
    } catch (error) {
      const normalized = normalizeToolCallFailure(error);
      if (normalized.retryable) {
        this.retireFailedCallClient(
          prepared.server,
          callClient,
          normalized.category,
          normalized.message,
          scopedKey
        );
        if (context?.retryOnReconnect) {
          const reconnected = await this.reconnectServer(prepared.server, "call");
          if (reconnected) {
            try {
              return await (async () => {
                const client = await this.clientForCall(
                  prepared.server,
                  prepared.actualName,
                  { ...context, forceReconnect: true }
                );
                if (client && "error" in client) return client.error;
                if (!client) return this.toolNotFound(toolName);
                callClient = client;
                const timeoutMs = this.effectiveCallTimeoutMs(prepared.server, context);
                const result = await withTimeout(
                  client.callTool(
                    {
                      name: prepared.actualName,
                      arguments: prepared.resolvedArguments,
                    },
                    undefined,
                    timeoutMs > 0 ? { timeout: timeoutMs } : undefined
                  ),
                  timeoutMs,
                  `"${prepared.server}" tool "${prepared.actualName}" retry call`
                );
                return result as unknown as CallToolResult;
              })();
            } catch (retryError) {
              const retryNormalized = normalizeToolCallFailure(retryError);
              return errorResult("tool_call_failed", retryNormalized.message, {
                tool: toolName,
                ...(serverHint ? { server: serverHint } : {}),
                category: retryNormalized.category,
                rootCause: retryNormalized.rootCause,
                retryable: retryNormalized.retryable,
                retryAttempted: true,
              });
            }
          }
        }
      }
      return errorResult("tool_call_failed", normalized.message, {
        tool: toolName,
        ...(serverHint ? { server: serverHint } : {}),
        category: normalized.category,
        rootCause: normalized.rootCause,
        retryable: normalized.retryable,
        ...(context?.retryOnReconnect ? { retryAttempted: true } : {}),
      });
    } finally {
      if (scopedKey) {
        const scoped = this.sessionClients.get(scopedKey);
        if (scoped) {
          this.releaseSessionClient(scoped);
          if (this.sessionCwdIdleTtlMs === 0) {
            this.closeSessionClientAfterCall(scopedKey, scoped);
          } else {
            this.refreshSessionClientIdleTimer(
              scopedKey,
              prepared.server,
              context?.cwd ?? "",
              scoped
            );
          }
        }
      }
    }
  }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  getFailedServers(): UpstreamConnectionFailure[] {
    return this.failedConnections.map((failure) => ({ ...failure }));
  }

  getServerInfo(server: string): ServerInfo | undefined {
    return this.serverInfoMap.get(server);
  }

  getToolSuiteStats(): { generation: number; lastChangeAt?: string } {
    return {
      generation: this.toolSuiteGeneration,
      ...(this.lastToolSuiteChangeAt ? { lastChangeAt: this.lastToolSuiteChangeAt } : {}),
    };
  }

  getServerConcurrency(server: string): number | undefined {
    return this.serverConcurrency.get(server);
  }

  getServerTools(server: string): string[] {
    const exposed = this.exposedToolsByServer.get(server);
    return exposed ? Array.from(exposed).sort() : [];
  }

  getToolsWithDescriptions(
    server: string
  ): Array<{ name: string; description?: string }> {
    const exposed = this.exposedToolsByServer.get(server);
    if (!exposed) return [];

    const result: Array<{ name: string; description?: string }> = [];
    for (const [, { server: srv, tool }] of this.toolMap) {
      if (srv === server && exposed.has(tool.name)) {
        result.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.lifecycleGeneration++;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const scoped of this.sessionClients.values()) {
      if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
    }
    await Promise.all([
      ...Array.from(this.clients.entries()).map(([name, client]) =>
        this.closeQuietly(client, this.transports.get(name))
      ),
      ...Array.from(this.sessionClients.values()).map(({ client, transport }) =>
        this.closeQuietly(client, transport)
      ),
    ]);
    this.clients.clear();
    this.transports.clear();
    this.sessionClients.clear();
    this.sessionClientConnects.clear();
    this.reconnects.clear();
    this.reconnectAttempts.clear();
    this.immediateReconnectServers.clear();
    this.connectionGenerations.clear();
    this.serverConfigs.clear();
    this.toolsByServer.clear();
    this.toolMap.clear();
    this.unqualifiedToolMap.clear();
    this.exposedToolsByServer.clear();
    this.removedTools.clear();
    this.serverInfoMap.clear();
    this.serverConcurrency.clear();
    this.failedConnections = [];
    this.closing = false;
  }
}
