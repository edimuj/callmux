import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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
  ToolCallContext,
  UpstreamConnection,
  UpstreamConnectionFailure,
  ListenerRuntimeDiagnostics,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS = 600;
const DEFAULT_FILE_REF_MAX_BYTES = 1_000_000; // 1 MB
const HARD_FILE_REF_MAX_BYTES = 10_000_000; // 10 MB

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
  private serverConfigs = new Map<string, ServerConfig>();
  private toolMap = new Map<string, { server: string; tool: Tool }>();
  private unqualifiedToolMap = new Map<string, { server: string; tool: Tool } | null>();
  private exposedToolsByServer = new Map<string, Set<string>>();
  private failedConnections: UpstreamConnectionFailure[] = [];
  private serverInfoMap = new Map<string, ServerInfo>();
  private serverConcurrency = new Map<string, number>();
  private instanceIdentity: InstanceIdentity = { instanceId: "unknown" };
  private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  private sessionCwdIdleTtlMs = DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS * 1000;

  constructor(private callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS) {}

  setInstanceIdentity(identity: InstanceIdentity): void {
    this.instanceIdentity = identity;
  }

  getInstanceIdentity(): InstanceIdentity {
    return this.instanceIdentity;
  }

  private async resetConnectionState(): Promise<void> {
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
    this.serverConfigs.clear();
    this.toolMap.clear();
    this.unqualifiedToolMap.clear();
    this.exposedToolsByServer.clear();
    this.serverInfoMap.clear();
    this.serverConcurrency.clear();
  }

  private async closeQuietly(client?: Client, transport?: Transport): Promise<void> {
    if (client) {
      try {
        await client.close();
        return;
      } catch {}
    }
    if (transport) {
      try {
        await transport.close();
      } catch {}
    }
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
    context?: ToolCallContext
  ): Promise<Client | undefined> {
    if (this.shouldUseSessionCwd(server, context)) {
      const scoped = await this.getSessionClient(server, context.cwd);
      if (scoped) return scoped.client;
    }

    return this.clients.get(server);
  }

  async connect(
    servers: Record<string, ServerConfig>,
    options: UpstreamConnectOptions = {}
  ): Promise<UpstreamConnection[]> {
    await this.resetConnectionState();

    const entries = Object.entries(servers);
    this.serverConfigs = new Map(entries);
    const multiServer = entries.length > 1;
    const maxConcurrency = options.maxConcurrency ?? 20;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.connectTimeoutMs = connectTimeoutMs;
    this.sessionCwdIdleTtlMs =
      (options.sessionCwdIdleTtlSeconds ?? DEFAULT_SESSION_CWD_IDLE_TTL_SECONDS) * 1000;
    const strictStartup = options.strictStartup ?? false;
    this.failedConnections = [];

    const startTimes = new Map<string, number>();
    const results = await mapBounded(entries, maxConcurrency, async ([name, config]) => {
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

    for (const { name, config, client, transport, resolvedTransport, allTools, tools, connectDurationMs } of connected) {
      this.exposedToolsByServer.set(
        name,
        new Set(tools.map((tool) => tool.name))
      );

      for (const tool of tools) {
        const qualifiedName = multiServer
          ? `${name}__${tool.name}`
          : tool.name;
        this.toolMap.set(qualifiedName, { server: name, tool });
        this.indexUnqualifiedTool(name, tool);
      }

      client.onclose = () => {
        process.stderr.write(`[callmux] Server "${name}" disconnected\n`);
        const info = this.serverInfoMap.get(name);
        if (info) {
          this.serverInfoMap.set(name, { ...info, state: "disconnected" });
        }
      };

      client.onerror = (err) => {
        process.stderr.write(`[callmux] Server "${name}" error: ${err.message}\n`);
      };

      this.clients.set(name, client);
      this.transports.set(name, transport);
      connections.push({ name, config, tools });

      if (config.maxConcurrency) {
        this.serverConcurrency.set(name, config.maxConcurrency);
      }

      this.serverInfoMap.set(name, {
        transport: resolvedTransport,
        state: "connected",
        connectDurationMs,
        totalTools: allTools.length,
        exposedTools: tools.length,
        ...(config.tools ? { toolFilter: config.tools } : {}),
        ...(config.maxConcurrency ? { maxConcurrency: config.maxConcurrency } : {}),
      });

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
      });
      process.stderr.write(
        `[callmux] Warning: failed to connect "${failure.name}": ${failure.error} (${failDuration}ms)\n`
      );
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
    return errorResult("tool_not_found", `tool "${toolName}" not found`, {
      tool: toolName,
    });
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
        ...this.failedConnections.map((failure) => failure.name),
      ])
    ).sort();
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
  ): { client: Client; actualName: string; server: string } | { error: CallToolResult } | null {
    if (serverHint) {
      const client = this.clients.get(serverHint);
      if (!client) {
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

      if (!exposedTools?.has(actualName)) {
        return {
          error: this.resolutionError(
            `tool "${actualName}" is not exposed on server "${serverHint}"`
          ),
        };
      }

      return { client, actualName, server: serverHint };
    }

    const entry = this.toolMap.get(toolName);
    if (entry) {
      const client = this.clients.get(entry.server);
      if (!client) return null;
      return { client, actualName: entry.tool.name, server: entry.server };
    }

    const unqualified = this.unqualifiedToolMap.get(toolName);
    if (unqualified === undefined) {
      // Legacy fallback for harnesses that mutate toolMap directly in tests or integrations.
      const matches = Array.from(this.toolMap.values()).filter(
        ({ tool }) => tool.name === toolName
      );

      if (matches.length === 1) {
        const match = matches[0];
        const client = this.clients.get(match.server);
        if (client) {
          return { client, actualName: match.tool.name, server: match.server };
        }
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
      const client = this.clients.get(unqualified.server);
      if (client) {
        return { client, actualName: unqualified.tool.name, server: unqualified.server };
      }
    }

    if (unqualified === null) {
      return {
        error: this.resolutionError(
          `tool "${toolName}" is ambiguous across multiple servers; specify "server" or use a qualified tool name`
        ),
      };
    }

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

    try {
      const client = await this.clientForCall(prepared.server, context);
      if (!client) {
        return this.toolNotFound(toolName);
      }
      const result = await client.callTool(
        {
          name: prepared.actualName,
          arguments: prepared.resolvedArguments,
        },
        undefined,
        this.callTimeoutMs > 0 ? { timeout: this.callTimeoutMs } : undefined
      );
      return result as unknown as CallToolResult;
    } catch (error) {
      const normalized = normalizeToolCallFailure(error);
      return errorResult("tool_call_failed", normalized.message, {
        tool: toolName,
        ...(serverHint ? { server: serverHint } : {}),
        category: normalized.category,
        rootCause: normalized.rootCause,
        retryable: normalized.retryable,
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
    for (const scoped of this.sessionClients.values()) {
      if (scoped.idleTimer) clearTimeout(scoped.idleTimer);
    }
    await Promise.all([
      ...Array.from(this.clients.entries()).map(async ([name, client]) => {
        try {
          await client.close();
        } catch {
          process.stderr.write(`[callmux] Warning: error closing "${name}"\n`);
        }
      }),
      ...Array.from(this.sessionClients.entries()).map(async ([key, { client }]) => {
        try {
          await client.close();
        } catch {
          const [name] = key.split("\0", 1);
          process.stderr.write(`[callmux] Warning: error closing session-scoped "${name}"\n`);
        }
      }),
    ]);
    this.clients.clear();
    this.transports.clear();
    this.sessionClients.clear();
    this.sessionClientConnects.clear();
    this.serverConfigs.clear();
    this.toolMap.clear();
    this.unqualifiedToolMap.clear();
    this.exposedToolsByServer.clear();
    this.serverInfoMap.clear();
    this.serverConcurrency.clear();
    this.failedConnections = [];
  }
}
