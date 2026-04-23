import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { UpstreamManager } from "./upstream.js";
import { CallCache } from "./cache.js";
import { META_TOOLS } from "./meta-tools.js";
import {
  handleParallel,
  handleBatch,
  handlePipeline,
  handleCall,
  handleCacheClear,
  handleStatus,
} from "./handlers.js";
import type { CallmuxConfig } from "./types.js";

export class CallmuxProxy {
  private server: Server;
  private upstream: UpstreamManager;
  private cache: CallCache;
  private maxConcurrency: number;
  private allTools: Tool[] = [];

  constructor(private config: CallmuxConfig) {
    this.upstream = new UpstreamManager();
    this.cache = new CallCache(
      config.cacheTtlSeconds ?? 0,
      config.cachePolicy,
      Object.fromEntries(
        Object.entries(config.servers).map(([name, server]) => [
          name,
          server.cachePolicy,
        ])
      )
    );
    this.maxConcurrency = config.maxConcurrency ?? 20;

    this.server = new Server(
      { name: "callmux", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.allTools,
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleToolCall(
        request.params.name,
        request.params.arguments
      );
    });
  }

  async start(transport: Transport): Promise<void> {
    const connections = await this.upstream.connect(this.config.servers);

    const proxiedTools = this.upstream.getTools().map(({ qualifiedName, tool }) => ({
      ...tool,
      name: qualifiedName,
    }));

    const totalTools = proxiedTools.length;
    const serverCount = connections.length;

    if (this.config.metaOnly) {
      this.allTools = [...META_TOOLS];
      process.stderr.write(
        `[callmux] Meta-only mode: ${META_TOOLS.length} meta-tools (${totalTools} tools available via callmux_call/parallel/batch from ${serverCount} server(s))\n`
      );
    } else {
      this.allTools = [...proxiedTools, ...META_TOOLS];
      process.stderr.write(
        `[callmux] Proxying ${totalTools} tools from ${serverCount} server(s) + ${META_TOOLS.length} meta-tools\n`
      );
    }

    await this.server.connect(transport);
  }

  private async handleToolCall(
    name: string,
    args?: Record<string, unknown>
  ): Promise<CallToolResult> {
    // Meta-tools
    switch (name) {
      case "callmux_parallel":
        return handleParallel(
          this.upstream,
          this.cache,
          args,
          this.maxConcurrency
        );

      case "callmux_batch":
        return handleBatch(
          this.upstream,
          this.cache,
          args,
          this.maxConcurrency
        );

      case "callmux_pipeline":
        return handlePipeline(
          this.upstream,
          this.cache,
          args
        );

      case "callmux_call":
        return handleCall(
          this.upstream,
          this.cache,
          args
        );

      case "callmux_cache_clear":
        return handleCacheClear(
          this.cache,
          args
        );

      case "callmux_status":
        return handleStatus(
          this.upstream,
          this.cache,
          this.maxConcurrency,
          this.config.metaOnly ?? false,
          this.config.descriptionMaxLength,
          args
        );
    }

    // Proxied tool — check cache first
    const cached = this.cache.get(name, args);
    if (cached) return cached;

    const result = await this.upstream.callTool(name, args);
    this.cache.set(name, args, result);
    return result;
  }

  async close(): Promise<void> {
    await this.upstream.close();
    await this.server.close();
  }
}
