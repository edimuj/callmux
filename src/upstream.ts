import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./results.js";
import { isHttpServerConfig } from "./types.js";
import type {
  ServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  UpstreamConnection,
  UpstreamConnectionFailure,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

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
  allTools: Tool[];
  tools: Tool[];
}

interface UpstreamConnectOptions {
  maxConcurrency?: number;
  connectTimeoutMs?: number;
  strictStartup?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  private toolMap = new Map<string, { server: string; tool: Tool }>();
  private exposedToolsByServer = new Map<string, Set<string>>();
  private failedConnections: UpstreamConnectionFailure[] = [];

  constructor(private callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS) {}

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

  private createStdioTransport(config: StdioServerConfig): Transport {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      cwd: config.cwd,
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
  ): Promise<{ transport: Transport; client: Client }> {
    if (config.transport) {
      const transport = this.createHttpTransport(config);
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        `"${name}" connect`
      );
      return { transport, client };
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
      return { transport, client };
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
      return { transport: sseTransport, client: sseClient };
    }
  }

  private async connectOne(
    name: string,
    config: ServerConfig,
    connectTimeoutMs: number
  ): Promise<ConnectedServer> {
    let transport: Transport | undefined;
    let client: Client | undefined;
    try {
      if (isHttpServerConfig(config)) {
        ({ transport, client } = await this.connectWithFallback(
          name,
          config,
          connectTimeoutMs
        ));
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

      return { name, config, client, transport, allTools, tools };
    } catch (error) {
      await this.closeQuietly(client, transport);
      throw error;
    }
  }

  async connect(
    servers: Record<string, ServerConfig>,
    options: UpstreamConnectOptions = {}
  ): Promise<UpstreamConnection[]> {
    const entries = Object.entries(servers);
    const multiServer = entries.length > 1;
    const maxConcurrency = options.maxConcurrency ?? 20;
    const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const strictStartup = options.strictStartup ?? false;
    this.failedConnections = [];

    const results = await mapBounded(entries, maxConcurrency, async ([name, config]) => {
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

    for (const { name, config, client, transport, allTools, tools } of connected) {
      this.exposedToolsByServer.set(
        name,
        new Set(tools.map((tool) => tool.name))
      );

      for (const tool of tools) {
        const qualifiedName = multiServer
          ? `${name}__${tool.name}`
          : tool.name;
        this.toolMap.set(qualifiedName, { server: name, tool });
      }

      this.clients.set(name, client);
      this.transports.set(name, transport);
      connections.push({ name, config, tools });

      const filtered = config.tools ? ` (filtered from ${allTools.length})` : "";
      const transportLabel = isHttpServerConfig(config) ? ` [${config.transport ?? "http"}]` : "";
      process.stderr.write(`[callmux] Connected to "${name}"${transportLabel}: ${tools.length} tools${filtered}\n`);
    }

    for (const failure of this.failedConnections) {
      process.stderr.write(
        `[callmux] Warning: failed to connect "${failure.name}": ${failure.error}\n`
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

  private resolutionError(message: string): CallToolResult {
    return errorResult("tool_resolution_failed", message);
  }

  resolveServer(
    toolName: string,
    serverHint?: string
  ): { client: Client; actualName: string } | { error: CallToolResult } | null {
    if (serverHint) {
      const client = this.clients.get(serverHint);
      if (!client) {
        return {
          error: this.resolutionError(`server "${serverHint}" not found`),
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

      return { client, actualName };
    }

    const entry = this.toolMap.get(toolName);
    if (entry) {
      const client = this.clients.get(entry.server);
      if (!client) return null;
      return { client, actualName: entry.tool.name };
    }

    const matches = Array.from(this.toolMap.values()).filter(
      ({ tool }) => tool.name === toolName
    );

    if (matches.length === 1) {
      const match = matches[0];
      const client = this.clients.get(match.server);
      if (client) {
        return { client, actualName: match.tool.name };
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

  async callTool(
    toolName: string,
    args?: Record<string, unknown>,
    serverHint?: string
  ): Promise<CallToolResult> {
    const resolved = this.resolveServer(toolName, serverHint);
    if (!resolved) {
      return this.toolNotFound(toolName);
    }

    if ("error" in resolved) {
      return resolved.error;
    }

    try {
      return await withTimeout(
        resolved.client.callTool({
          name: resolved.actualName,
          arguments: args,
        }) as Promise<CallToolResult>,
        this.callTimeoutMs,
        `tool "${toolName}"`
      );
    } catch (error) {
      return errorResult("tool_call_failed", errorMessage(error), {
        tool: toolName,
        ...(serverHint ? { server: serverHint } : {}),
      });
    }
  }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  getFailedServers(): UpstreamConnectionFailure[] {
    return this.failedConnections.map((failure) => ({ ...failure }));
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
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        process.stderr.write(`[callmux] Warning: error closing "${name}"\n`);
      }
    }
    this.clients.clear();
    this.transports.clear();
    this.toolMap.clear();
    this.exposedToolsByServer.clear();
    this.failedConnections = [];
  }
}
