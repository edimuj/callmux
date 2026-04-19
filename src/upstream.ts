import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig, UpstreamConnection } from "./types.js";

/**
 * Manages connections to downstream MCP servers.
 * "Upstream" from callmux's perspective — these are the servers we proxy to.
 */
export class UpstreamManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, StdioClientTransport>();
  private toolMap = new Map<string, { server: string; tool: Tool }>();

  async connect(servers: Record<string, ServerConfig>): Promise<UpstreamConnection[]> {
    const connections: UpstreamConnection[] = [];

    for (const [name, config] of Object.entries(servers)) {
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
        cwd: config.cwd,
        stderr: "pipe",
      });

      const client = new Client(
        { name: "callmux", version: "0.1.0" },
        { capabilities: {} }
      );

      await client.connect(transport);

      const { tools } = await client.listTools();

      for (const tool of tools) {
        const qualifiedName = Object.keys(servers).length > 1
          ? `${name}__${tool.name}`
          : tool.name;
        this.toolMap.set(qualifiedName, { server: name, tool });
      }

      this.clients.set(name, client);
      this.transports.set(name, transport);
      connections.push({ name, config, tools });

      process.stderr.write(`[callmux] Connected to "${name}": ${tools.length} tools\n`);
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

  resolveServer(toolName: string, serverHint?: string): { client: Client; actualName: string } | null {
    if (serverHint) {
      const client = this.clients.get(serverHint);
      if (!client) return null;
      return { client, actualName: toolName };
    }

    const entry = this.toolMap.get(toolName);
    if (entry) {
      const client = this.clients.get(entry.server);
      if (!client) return null;
      return { client, actualName: entry.tool.name };
    }

    // Try unqualified match across all servers
    for (const [, { server, tool }] of this.toolMap) {
      if (tool.name === toolName) {
        const client = this.clients.get(server);
        if (client) return { client, actualName: tool.name };
      }
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
      return {
        content: [{ type: "text", text: `Error: tool "${toolName}" not found` }],
        isError: true,
      };
    }

    const result = await resolved.client.callTool({
      name: resolved.actualName,
      arguments: args,
    });

    return result as CallToolResult;
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
  }
}
