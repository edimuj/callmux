import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { errorResult } from "./results.js";

const BRIDGE_CWD_HEADER = "x-callmux-cwd";
const BRIDGE_CLIENT_HEADER = "x-callmux-client";
const META_TOOL_TIMEOUT_OVERHEAD_MS = 5_000;

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
    [BRIDGE_CLIENT_HEADER]: "stdio-bridge",
  };
}

export class CallmuxBridge {
  private server: Server;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private reconnectPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private cachedTools: Tool[] = [];
  private lastConnectError: string | undefined;
  private closed = false;

  constructor(private options: BridgeOptions) {
    this.server = new Server(
      { name: "callmux-bridge", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        const result = await this.withReconnect((client) => client.listTools());
        this.cachedTools = result.tools;
        return result;
      } catch {
        this.scheduleReconnect();
        return { tools: this.cachedTools };
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.withReconnect((client) => client.callTool(
          request.params,
          undefined,
          deriveBridgeCallOptions(
            request.params.name,
            request.params.arguments,
            this.options.callTimeoutMs
          )
        )) as unknown as CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = isReconnectableBridgeError(error)
          ? "bridge_upstream_unavailable"
          : "bridge_tool_call_failed";
        return errorResult(code, message, {
          tool: request.params.name,
          url: this.options.url,
          retryable: code === "bridge_upstream_unavailable",
          ...(this.lastConnectError ? { lastConnectError: this.lastConnectError } : {}),
        });
      }
    });
  }

  async start(clientTransport: Transport): Promise<void> {
    try {
      await this.connectUpstream();
    } catch (error) {
      this.lastConnectError = error instanceof Error ? error.message : String(error);
      this.scheduleReconnect();
    }
    await this.server.connect(clientTransport);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.server.close();
    await this.reconnectPromise?.catch(() => undefined);
    await this.closeUpstream();
  }

  private async withReconnect<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.ensureUpstream();
    try {
      return await operation(client);
    } catch (error) {
      if (!isReconnectableBridgeError(error)) {
        throw error;
      }

      await this.reconnectUpstream();
      return operation(await this.ensureUpstream());
    }
  }

  private async ensureUpstream(): Promise<Client> {
    if (this.client) return this.client;
    await this.reconnectUpstream();
    if (!this.client) {
      throw new Error("bridge is not connected to upstream MCP server");
    }
    return this.client;
  }

  private async reconnectUpstream(): Promise<void> {
    if (!this.reconnectPromise) {
      this.reconnectPromise = (async () => {
        await this.closeUpstream();
        await this.connectUpstream();
        this.reconnectAttempts = 0;
      })().finally(() => {
        this.reconnectPromise = undefined;
      });
    }

    await this.reconnectPromise;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.client || this.reconnectPromise || this.reconnectTimer) return;
    const delayMs = Math.min(10_000, 250 * (2 ** Math.max(0, this.reconnectAttempts)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAttempts++;
      this.reconnectUpstream().catch((error) => {
        this.lastConnectError = error instanceof Error ? error.message : String(error);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private async connectUpstream(): Promise<void> {
    if (this.closed) {
      throw new Error("bridge is closed");
    }

    const url = new URL(this.options.url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: bridgeHeaders(this.options),
      },
    });
    const client = new Client(
      { name: "callmux-bridge", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close?.().catch(() => undefined);
      throw error;
    }

    this.client = client;
    this.transport = transport;
    this.lastConnectError = undefined;
  }

  private async closeUpstream(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;

    await transport?.terminateSession().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await transport?.close?.().catch(() => undefined);
  }

}

export function deriveBridgeCallOptions(
  toolName: string,
  args: unknown,
  configuredTimeoutMs?: number
): { timeout: number } | undefined {
  const configured = positiveTimeoutMs(configuredTimeoutMs);
  const metaTimeout = derivedMetaToolRequestTimeoutMs(toolName, args, configured);
  const timeout = maxDefined(configured, metaTimeout);
  return timeout === undefined ? undefined : { timeout };
}

function derivedMetaToolRequestTimeoutMs(
  toolName: string,
  args: unknown,
  defaultChildTimeoutMs: number | undefined
): number | undefined {
  if (!isRecord(args)) return undefined;

  if (toolName === "callmux_call") {
    return addTimeoutOverhead(positiveTimeoutMs(args.timeoutMs) ?? defaultChildTimeoutMs);
  }

  if (toolName === "callmux_parallel" && Array.isArray(args.calls)) {
    const childTimeouts = args.calls
      .filter(isRecord)
      .map((call) => positiveTimeoutMs(call.timeoutMs) ?? defaultChildTimeoutMs);
    return addTimeoutOverhead(maxDefined(...childTimeouts));
  }

  if (toolName === "callmux_batch" && Array.isArray(args.items)) {
    const batchTimeout = positiveTimeoutMs(args.timeoutMs) ?? defaultChildTimeoutMs;
    const totalChildTimeout = args.items
      .filter(isRecord)
      .map((item) => positiveTimeoutMs(item.timeoutMs) ?? batchTimeout)
      .reduce<number | undefined>((total, timeout) => {
        if (timeout === undefined) return total;
        return (total ?? 0) + timeout;
      }, undefined);
    return addTimeoutOverhead(totalChildTimeout);
  }

  if (toolName === "callmux_pipeline" && Array.isArray(args.steps)) {
    const totalChildTimeout = args.steps
      .filter(isRecord)
      .map((step) => positiveTimeoutMs(step.timeoutMs) ?? defaultChildTimeoutMs)
      .reduce<number | undefined>((total, timeout) => {
        if (timeout === undefined) return total;
        return (total ?? 0) + timeout;
      }, undefined);
    return addTimeoutOverhead(totalChildTimeout);
  }

  return undefined;
}

function positiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    max = max === undefined ? value : Math.max(max, value);
  }
  return max;
}

function addTimeoutOverhead(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, timeoutMs + META_TOOL_TIMEOUT_OVERHEAD_MS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReconnectableBridgeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /unknown session/i,
    /re-initialize/i,
    /connection closed/i,
    /socket hang up/i,
    /econnrefused/i,
    /econnreset/i,
    /fetch failed/i,
    /transport.*closed/i,
    /not connected/i,
  ].some((pattern) => pattern.test(message));
}
