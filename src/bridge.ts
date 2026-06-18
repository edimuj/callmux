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

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }

  return value;
}

function toolListFingerprint(tools: Tool[]): string {
  const normalized = tools
    .map((tool) => stableValue(tool) as Record<string, unknown>)
    .sort((left, right) => {
      const leftName = typeof left.name === "string" ? left.name : "";
      const rightName = typeof right.name === "string" ? right.name : "";
      return leftName.localeCompare(rightName) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right));
    });
  return JSON.stringify(normalized);
}

function sameToolList(left: Tool[], right: Tool[]): boolean {
  return toolListFingerprint(left) === toolListFingerprint(right);
}

export class CallmuxBridge {
  private server: Server;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private reconnectPromise: Promise<void> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private cachedTools: Tool[] = [];
  private hasReturnedTools = false;
  private lastConnectError: string | undefined;
  private closed = false;

  constructor(private options: BridgeOptions) {
    this.server = new Server(
      { name: "callmux-bridge", version: "0.1.0" },
      { capabilities: { tools: { listChanged: true } } }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        const result = await this.withReconnect((client) => client.listTools());
        const changed = this.hasReturnedTools && !sameToolList(result.tools, this.cachedTools);
        this.cachedTools = result.tools;
        this.hasReturnedTools = true;
        if (changed) {
          await this.server.sendToolListChanged().catch(() => undefined);
        }
        return result;
      } catch {
        this.scheduleReconnect();
        this.hasReturnedTools = true;
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
        if (code === "bridge_upstream_unavailable") {
          // Warm the connection in the background with backoff so the next
          // call is more likely to land on a live upstream.
          this.scheduleReconnect();
        }
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
        await this.refreshToolList();
      })().finally(() => {
        this.reconnectPromise = undefined;
      });
    }

    await this.reconnectPromise;
  }

  private async refreshToolList(): Promise<void> {
    if (!this.client || !this.hasReturnedTools) return;
    try {
      const result = await this.client.listTools();
      if (!sameToolList(result.tools, this.cachedTools)) {
        this.cachedTools = result.tools;
        await this.server.sendToolListChanged().catch(() => undefined);
      }
    } catch {
      // Non-fatal — next tools/list call will pick up changes
    }
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
    return addTimeoutOverhead(
      positiveTimeoutMs(args.timeoutMs) ??
        downstreamArgumentTimeoutMs(args.arguments) ??
        defaultChildTimeoutMs
    );
  }

  if (toolName === "callmux_parallel" && Array.isArray(args.calls)) {
    const childTimeouts = args.calls
      .filter(isRecord)
      .map((call) =>
        positiveTimeoutMs(call.timeoutMs) ??
        downstreamArgumentTimeoutMs(call.arguments) ??
        defaultChildTimeoutMs
      );
    return addTimeoutOverhead(sumDefined(...childTimeouts));
  }

  if (toolName === "callmux_batch" && Array.isArray(args.items)) {
    const batchTimeout = positiveTimeoutMs(args.timeoutMs) ?? defaultChildTimeoutMs;
    const totalChildTimeout = args.items
      .filter(isRecord)
      .map((item) =>
        positiveTimeoutMs(item.timeoutMs) ??
        downstreamArgumentTimeoutMs(item.arguments) ??
        batchTimeout
      )
      .reduce<number | undefined>((total, timeout) => {
        if (timeout === undefined) return total;
        return (total ?? 0) + timeout;
      }, undefined);
    return addTimeoutOverhead(totalChildTimeout);
  }

  if (toolName === "callmux_pipeline" && Array.isArray(args.steps)) {
    const totalChildTimeout = args.steps
      .filter(isRecord)
      .map((step) =>
        positiveTimeoutMs(step.timeoutMs) ??
        downstreamArgumentTimeoutMs(step.arguments) ??
        defaultChildTimeoutMs
      )
      .reduce<number | undefined>((total, timeout) => {
        if (timeout === undefined) return total;
        return (total ?? 0) + timeout;
      }, undefined);
    return addTimeoutOverhead(totalChildTimeout);
  }

  return addTimeoutOverhead(downstreamArgumentTimeoutMs(args));
}

function positiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function downstreamArgumentTimeoutMs(args: unknown): number | undefined {
  if (!isRecord(args)) return undefined;
  return positiveTimeoutMs(args.timeoutMs) ?? positiveTimeoutMs(args.timeout);
}

function maxDefined(...values: Array<number | undefined>): number | undefined {
  let max: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    max = max === undefined ? value : Math.max(max, value);
  }
  return max;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  let total: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, (total ?? 0) + value);
  }
  return total;
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
