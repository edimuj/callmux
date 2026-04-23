import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "./results.js";
import { isHttpServerConfig } from "./types.js";
import type { ServerConfig, StdioServerConfig, HttpServerConfig, UpstreamConnection } from "./types.js";

/**
 * Manages connections to downstream MCP servers.
 * "Upstream" from callmux's perspective — these are the servers we proxy to.
 */
export class UpstreamManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, Transport>();
  private toolMap = new Map<string, { server: string; tool: Tool }>();
  private exposedToolsByServer = new Map<string, Set<string>>();

  private createStdioTransport(config: StdioServerConfig): Transport {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      cwd: config.cwd,
      stderr: "pipe",
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

  private async connectWithFallback(name: string, config: HttpServerConfig): Promise<{ transport: Transport; client: Client }> {
    if (config.transport) {
      const transport = this.createHttpTransport(config);
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await client.connect(transport);
      return { transport, client };
    }

    // Try streamable-http first, fall back to SSE
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      );
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await client.connect(transport);
      return { transport, client };
    } catch {
      process.stderr.write(`[callmux] "${name}": streamable-http failed, trying SSE fallback\n`);
      const transport = new SSEClientTransport(
        new URL(config.url),
        config.headers ? { requestInit: { headers: config.headers } } : undefined
      );
      const client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
      await client.connect(transport);
      return { transport, client };
    }
  }

  async connect(servers: Record<string, ServerConfig>): Promise<UpstreamConnection[]> {
    const connections: UpstreamConnection[] = [];

    for (const [name, config] of Object.entries(servers)) {
      let transport: Transport;
      let client: Client;

      if (isHttpServerConfig(config)) {
        ({ transport, client } = await this.connectWithFallback(name, config));
      } else {
        transport = this.createStdioTransport(config);
        client = new Client({ name: "callmux", version: "0.2.0" }, { capabilities: {} });
        await client.connect(transport);
      }

      const { tools: allTools } = await client.listTools();

      const allowSet = config.tools ? new Set(config.tools) : null;
      const tools = allowSet
        ? allTools.filter((t) => allowSet.has(t.name))
        : allTools;

      this.exposedToolsByServer.set(
        name,
        new Set(tools.map((tool) => tool.name))
      );

      for (const tool of tools) {
        const qualifiedName = Object.keys(servers).length > 1
          ? `${name}__${tool.name}`
          : tool.name;
        this.toolMap.set(qualifiedName, { server: name, tool });
      }

      this.clients.set(name, client);
      this.transports.set(name, transport);
      connections.push({ name, config, tools });

      const filtered = allowSet ? ` (filtered from ${allTools.length})` : "";
      const transportLabel = isHttpServerConfig(config) ? ` [${config.transport ?? "http"}]` : "";
      process.stderr.write(`[callmux] Connected to "${name}"${transportLabel}: ${tools.length} tools${filtered}\n`);
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

    const result = await resolved.client.callTool({
      name: resolved.actualName,
      arguments: args,
    });

    return result as CallToolResult;
  }

  getServerNames(): string[] {
    return Array.from(this.clients.keys());
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
  }
}
