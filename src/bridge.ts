import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorResult } from "./results.js";

const BRIDGE_CWD_HEADER = "x-callmux-cwd";

interface BridgeOptions {
  url: string;
  cwd: string;
  headers?: Record<string, string>;
  callTimeoutMs?: number;
}

function bridgeHeaders(options: BridgeOptions): Record<string, string> {
  return {
    ...(options.headers ?? {}),
    [BRIDGE_CWD_HEADER]: options.cwd,
  };
}

export class CallmuxBridge {
  private server: Server;
  private client: Client | undefined;
  private transport: Transport | undefined;

  constructor(private options: BridgeOptions) {
    this.server = new Server(
      { name: "callmux-bridge", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      if (!this.client) return { tools: [] };
      return this.client.listTools();
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.client) {
        return errorResult("bridge_not_connected", "bridge is not connected to upstream MCP server", {
          url: this.options.url,
        });
      }

      try {
        return await this.client.callTool(
          {
            name: request.params.name,
            arguments: request.params.arguments,
          },
          undefined,
          this.options.callTimeoutMs && this.options.callTimeoutMs > 0
            ? { timeout: this.options.callTimeoutMs }
            : undefined
        ) as unknown as CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult("bridge_tool_call_failed", message, {
          tool: request.params.name,
          url: this.options.url,
        });
      }
    });
  }

  async start(clientTransport: Transport): Promise<void> {
    const url = new URL(this.options.url);
    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: bridgeHeaders(this.options),
      },
    });
    this.client = new Client(
      { name: "callmux-bridge", version: "0.1.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
    await this.server.connect(clientTransport);
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.client?.close();
    await this.transport?.close?.();
  }
}
