import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createHash } from "node:crypto";
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
  handleSearchTools,
  handleGetResult,
  handleDryRun,
  handleRecipeRun,
  handleRecipeDryRun,
  handleCacheClear,
  handleStatus,
} from "./handlers.js";
import type { CallmuxConfig, InstanceIdentity, ServerConfig } from "./types.js";
import { isOutputFormat, type OutputFormat } from "./output-format.js";
import {
  createResponseStore,
  ResponseStore,
  resolveResponseShieldOptions,
  shieldToolResult,
  type ResponseShieldTarget,
} from "./response-store.js";
import { textFirstResultForNonJson } from "./results.js";
import {
  compressToolForExposure,
  schemaCompressionDiagnostics,
} from "./schema-compression.js";
import { VERSION } from "./version.js";

function positiveTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function downstreamArgumentTimeoutMs(args?: Record<string, unknown>): number | undefined {
  if (!args) return undefined;
  return positiveTimeoutMs(args.timeoutMs) ?? positiveTimeoutMs(args.timeout);
}

export class CallmuxProxy {
  private server: Server;
  private upstream: UpstreamManager;
  private cache: CallCache;
  private maxConcurrency: number;
  private connectTimeoutMs: number;
  private allTools: Tool[] = [];
  private instanceIdentity: InstanceIdentity;
  private responseStore: ResponseStore;

  private static buildInstanceId(config: CallmuxConfig): string {
    const serverFingerprint = Object.entries(config.servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => ({
        name,
        ...(CallmuxProxy.fingerprintServerConfig(server)),
      }));
    const fingerprint = {
      serverFingerprint,
      metaOnly: config.metaOnly ?? false,
      strictStartup: config.strictStartup ?? false,
      cwd: process.cwd(),
    };
    return createHash("sha256")
      .update(JSON.stringify(fingerprint))
      .digest("hex")
      .slice(0, 12);
  }

  private static fingerprintServerConfig(config: ServerConfig): Record<string, unknown> {
    if ("command" in config) {
      return {
        type: "stdio",
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        tools: config.tools ?? [],
      };
    }

    return {
      type: "http",
      url: config.url,
      transport: config.transport,
      tools: config.tools ?? [],
    };
  }

  constructor(private config: CallmuxConfig) {
    this.upstream = new UpstreamManager(config.callTimeoutMs ?? 180_000);
    this.cache = new CallCache(
      config.cacheTtlSeconds ?? 0,
      config.cachePolicy,
      Object.fromEntries(
        Object.entries(config.servers).map(([name, server]) => [
          name,
          server.cachePolicy,
        ])
      ),
      config.maxCacheEntries ?? 1000
    );
    this.maxConcurrency = config.maxConcurrency ?? 20;
    this.connectTimeoutMs = config.connectTimeoutMs ?? 30_000;
    this.responseStore = createResponseStore(config);
    this.instanceIdentity = {
      namespace: process.env.CALLMUX_NAMESPACE,
      instanceId: CallmuxProxy.buildInstanceId(config),
    };
    this.upstream.setInstanceIdentity(this.instanceIdentity);

    this.server = new Server(
      { name: "callmux", version: VERSION },
      { capabilities: { tools: {} } }
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.currentTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return this.handleToolCall(
        request.params.name,
        request.params.arguments
      );
    });
  }

  /** Connect to all downstream servers and build the tool list. Does not bind a client transport. */
  async connectUpstreams(): Promise<void> {
    const connections = await this.upstream.connect(
      this.config.servers,
      {
        maxConcurrency: this.maxConcurrency,
        connectTimeoutMs: this.connectTimeoutMs,
        reconnectPolicy: this.config.reconnectPolicy,
        sessionCwdIdleTtlSeconds: this.config.sessionCwdIdleTtlSeconds,
        strictStartup: this.config.strictStartup ?? false,
      }
    );

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
  }

  async start(transport: Transport): Promise<void> {
    await this.connectUpstreams();
    await this.server.connect(transport);
  }

  /** Shared state accessors for listener mode */
  getUpstream(): UpstreamManager { return this.upstream; }
  getCache(): CallCache { return this.cache; }
  getResponseStore(): ResponseStore { return this.responseStore; }
  getMaxConcurrency(): number { return this.maxConcurrency; }
  getTools(): Tool[] { return this.currentTools(); }
  getConfig(): CallmuxConfig { return this.config; }

  private currentTools(): Tool[] {
    const metaTools = META_TOOLS.map((tool) =>
      compressToolForExposure(tool, this.config.schemaCompression)
    );
    if (this.config.metaOnly) return metaTools;
    const proxiedTools = this.upstream.getTools().map(({ qualifiedName, server, tool }) => {
      const serverCfg = this.config.servers[server];
      const eager = serverCfg?.alwaysLoad;
      const base = eager?.includes(tool.name)
        ? { ...tool, name: qualifiedName, _meta: { ...tool._meta, "anthropic/alwaysLoad": true } }
        : { ...tool, name: qualifiedName };
      return compressToolForExposure(
        base,
        this.config.schemaCompression,
        serverCfg?.schemaCompression
      );
    });
    return [...proxiedTools, ...metaTools];
  }

  private schemaCompressionDiagnostics() {
    const upstream = this.upstream as UpstreamManager & {
      getTools?: () => Array<{ qualifiedName: string; server: string; tool: Tool }>;
    };
    const downstreamTools = typeof upstream.getTools === "function"
      ? upstream.getTools()
      : [];
    return schemaCompressionDiagnostics(this.config, [
      ...downstreamTools.map(({ qualifiedName, server, tool }) => ({
        server,
        tool: { ...tool, name: qualifiedName },
      })),
      ...META_TOOLS.map((tool) => ({ tool })),
    ]);
  }

  private async handleToolCall(
    name: string,
    args?: Record<string, unknown>
  ): Promise<CallToolResult> {
    // Meta-tools
    switch (name) {
      case "callmux_parallel":
        return this.shieldResult(
          { tool: name },
          await handleParallel(
            this.upstream,
            this.cache,
            args,
            this.maxConcurrency,
            undefined,
            this.config.outputFormat
          ),
          this.outputFormatFor(args)
        );

      case "callmux_batch":
        return this.shieldResult(
          { tool: name },
          await handleBatch(
            this.upstream,
            this.cache,
            args,
            this.maxConcurrency,
            undefined,
            this.config.outputFormat
          ),
          this.outputFormatFor(args)
        );

      case "callmux_pipeline":
        return this.shieldResult(
          { tool: name },
          await handlePipeline(
            this.upstream,
            this.cache,
            args,
            undefined,
            this.config.outputFormat
          ),
          this.outputFormatFor(args)
        );

      case "callmux_call":
        if (isCallmuxGetResultCall(args)) {
          return this.finalizeOutputFormat(handleGetResult(
            this.responseStore,
            args.arguments,
            this.outputFormatFor(args)
          ), this.outputFormatFor(args));
        }
        return this.shieldResult(
          this.responseShieldTarget(name, args),
          await handleCall(
            this.upstream,
            this.cache,
            args,
            undefined,
            this.config.outputFormat
          ),
          this.outputFormatFor(args)
        );

      case "callmux_search_tools":
        return this.finalizeOutputFormat(handleSearchTools(
          this.upstream,
          this.config.descriptionMaxLength,
          args,
          this.config.outputFormat
        ), this.outputFormatFor(args));

      case "callmux_get_result":
        return this.finalizeOutputFormat(handleGetResult(
          this.responseStore,
          args,
          this.config.outputFormat
        ), this.outputFormatFor(args));

      case "callmux_cache_clear":
        return this.finalizeOutputFormat(handleCacheClear(
          this.cache,
          args
        ), this.outputFormatFor(args));

      case "callmux_dry_run":
        return this.finalizeOutputFormat(await handleDryRun(
          this.upstream,
          this.cache,
          args,
          undefined,
          this.config.outputFormat
        ), this.outputFormatFor(args));

      case "callmux_recipe_run":
        return this.shieldResult(
          { tool: name },
          await handleRecipeRun(
            this.upstream,
            this.cache,
            this.config.recipes,
            args,
            this.maxConcurrency,
            undefined,
            this.config.outputFormat
          ),
          this.outputFormatFor(args)
        );

      case "callmux_recipe_dry_run":
        return this.finalizeOutputFormat(await handleRecipeDryRun(
          this.upstream,
          this.cache,
          this.config.recipes,
          args,
          undefined,
          this.config.outputFormat
        ), this.outputFormatFor(args));

      case "callmux_status":
        return this.finalizeOutputFormat(handleStatus(
          this.upstream,
          this.cache,
          this.maxConcurrency,
          this.config.metaOnly ?? false,
          this.config.descriptionMaxLength,
          this.instanceIdentity,
          args,
          undefined,
          this.config.recipes,
          this.responseStore,
          this.config.outputFormat,
          this.schemaCompressionDiagnostics()
        ), this.outputFormatFor(args));
    }

    const target = this.responseShieldTarget(name, args);
    const maybePrepare = this.upstream as UpstreamManager & {
      prepareToolCall?: (
        toolName: string,
        args?: Record<string, unknown>,
        serverHint?: string
      ) => ReturnType<UpstreamManager["prepareToolCall"]>;
    };
    const prepared = typeof maybePrepare.prepareToolCall === "function"
      ? await maybePrepare.prepareToolCall(name, args)
      : undefined;
    if (prepared && "error" in prepared) return prepared.error;
    const cacheArgs = prepared?.resolvedArguments ?? args;
    const cacheServer = prepared?.server;

    // Proxied tool — check cache after resolving file references
    const maybeScoped = this.upstream as UpstreamManager & {
      cacheScopeForCall?: UpstreamManager["cacheScopeForCall"];
    };
    const cacheScope = typeof maybeScoped.cacheScopeForCall === "function"
      ? maybeScoped.cacheScopeForCall(name, cacheServer)
      : undefined;
    const cached = this.cache.get(name, cacheArgs, cacheServer, cacheScope);
    if (cached) return this.shieldResult(target, cached);

    const downstreamTimeoutMs = downstreamArgumentTimeoutMs(cacheArgs);
    const result = await this.upstream.callTool(name, cacheArgs, cacheServer, {
      ...(downstreamTimeoutMs !== undefined ? { timeoutMs: downstreamTimeoutMs } : {}),
      retryOnReconnect: this.cache.isSafeToRetry(name, cacheServer),
    });
    this.cache.set(name, cacheArgs, result, cacheServer, cacheScope);
    return this.shieldResult(target, result);
  }

  private responseShieldTarget(
    tool: string,
    args?: Record<string, unknown>
  ): ResponseShieldTarget {
    if (tool === "callmux_call" && args && typeof args.tool === "string") {
      const server = typeof args.server === "string" ? args.server : undefined;
      const resolved = this.upstream.resolveServer(args.tool, server);
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

    const maybeResolvable = this.upstream as UpstreamManager & {
      resolveServer?: UpstreamManager["resolveServer"];
    };
    if (typeof maybeResolvable.resolveServer !== "function") {
      return { tool };
    }

    const resolved = maybeResolvable.resolveServer(tool);
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
    const effectiveOutputFormat = outputFormat ?? this.config.outputFormat;
    return this.finalizeOutputFormat(shieldToolResult(
      this.responseStore,
      target,
      result,
      {
        ...resolveResponseShieldOptions(this.config, target),
        outputFormat: effectiveOutputFormat,
      }
    ), effectiveOutputFormat);
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
      : this.config.outputFormat;
  }

  async close(): Promise<void> {
    await this.upstream.close();
    await this.server.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCallmuxGetResultCall(args: unknown): args is { arguments?: unknown } {
  return (
    isRecord(args) &&
    args.tool === "callmux_get_result" &&
    (args.server === undefined || args.server === "callmux")
  );
}
