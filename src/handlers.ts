import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager } from "./upstream.js";
import type { CallCache } from "./cache.js";
import { errorResult, jsonResult } from "./results.js";
import type {
  ParallelCall,
  ParallelResult,
  BatchItem,
  BatchResult,
  PipelineStep,
  PipelineResult,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolErrorResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function successResult(payload: Record<string, unknown>): CallToolResult {
  return jsonResult(payload);
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function resolveMapping(text: string, expr: string): unknown {
  if (expr === "$text") return text;

  if (expr === "$json" || expr.startsWith("$json.")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return undefined;
    }

    if (expr === "$json") return parsed;

    const path = expr.slice(6).split(".");
    let current: unknown = parsed;
    for (const key of path) {
      if (current == null || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  return expr;
}

function validateConcurrency(maxConcurrency: number): CallToolResult | null {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    return errorResult(
      "invalid_arguments",
      "maxConcurrency must be a positive integer",
      { maxConcurrency }
    );
  }

  return null;
}

function validateToolName(
  value: unknown,
  field: string
): string | CallToolResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return errorResult("invalid_arguments", `${field} must be a non-empty string`, {
      field,
    });
  }

  return value;
}

function validateArgumentsObject(
  value: unknown,
  field: string
): Record<string, unknown> | undefined | CallToolResult {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return errorResult("invalid_arguments", `${field} must be an object`, {
      field,
    });
  }

  return value;
}

function validateParallelArgs(
  args: unknown
): { calls: ParallelCall[] } | CallToolResult {
  if (!isRecord(args) || !Array.isArray(args.calls)) {
    return errorResult("invalid_arguments", `"calls" must be an array`, {
      field: "calls",
    });
  }

  const calls: ParallelCall[] = [];
  for (let index = 0; index < args.calls.length; index++) {
    const call = args.calls[index];
    if (!isRecord(call)) {
      return errorResult("invalid_arguments", `calls[${index}] must be an object`, {
        field: `calls[${index}]`,
      });
    }

    const tool = validateToolName(call.tool, `calls[${index}].tool`);
    if (typeof tool !== "string") return tool;

    const server =
      call.server === undefined
        ? undefined
        : validateToolName(call.server, `calls[${index}].server`);
    if (server !== undefined && typeof server !== "string") return server;

    const parsedArgs = validateArgumentsObject(
      call.arguments,
      `calls[${index}].arguments`
    );
    if (parsedArgs !== undefined && !isRecord(parsedArgs)) return parsedArgs;

    calls.push({
      tool,
      ...(typeof server === "string" ? { server } : {}),
      ...(parsedArgs ? { arguments: parsedArgs } : {}),
    });
  }

  return { calls };
}

function validateBatchArgs(
  args: unknown
): { server?: string; tool: string; items: BatchItem[] } | CallToolResult {
  if (!isRecord(args) || !Array.isArray(args.items)) {
    return errorResult("invalid_arguments", `"items" must be an array`, {
      field: "items",
    });
  }

  const tool = validateToolName(args.tool, "tool");
  if (typeof tool !== "string") return tool;

  const server =
    args.server === undefined ? undefined : validateToolName(args.server, "server");
  if (server !== undefined && typeof server !== "string") return server;

  const items: BatchItem[] = [];
  for (let index = 0; index < args.items.length; index++) {
    const item = args.items[index];
    if (!isRecord(item)) {
      return errorResult("invalid_arguments", `items[${index}] must be an object`, {
        field: `items[${index}]`,
      });
    }

    const parsedArgs = validateArgumentsObject(item.arguments, `items[${index}].arguments`);
    if (!parsedArgs || !isRecord(parsedArgs)) {
      return parsedArgs ?? errorResult(
        "invalid_arguments",
        `items[${index}].arguments must be an object`,
        { field: `items[${index}].arguments` }
      );
    }

    items.push({ arguments: parsedArgs });
  }

  return {
    tool,
    items,
    ...(typeof server === "string" ? { server } : {}),
  };
}

function validatePipelineArgs(
  args: unknown
): { steps: PipelineStep[] } | CallToolResult {
  if (!isRecord(args) || !Array.isArray(args.steps)) {
    return errorResult("invalid_arguments", `"steps" must be an array`, {
      field: "steps",
    });
  }

  if (args.steps.length === 0) {
    return errorResult("invalid_arguments", `"steps" must contain at least one step`, {
      field: "steps",
    });
  }

  const steps: PipelineStep[] = [];
  for (let index = 0; index < args.steps.length; index++) {
    const step = args.steps[index];
    if (!isRecord(step)) {
      return errorResult("invalid_arguments", `steps[${index}] must be an object`, {
        field: `steps[${index}]`,
      });
    }

    const tool = validateToolName(step.tool, `steps[${index}].tool`);
    if (typeof tool !== "string") return tool;

    const server =
      step.server === undefined
        ? undefined
        : validateToolName(step.server, `steps[${index}].server`);
    if (server !== undefined && typeof server !== "string") return server;

    const parsedArgs = validateArgumentsObject(
      step.arguments,
      `steps[${index}].arguments`
    );
    if (parsedArgs !== undefined && !isRecord(parsedArgs)) return parsedArgs;

    let inputMapping: Record<string, string> | undefined;
    if (step.inputMapping !== undefined) {
      if (!isRecord(step.inputMapping)) {
        return errorResult(
          "invalid_arguments",
          `steps[${index}].inputMapping must be an object of string expressions`,
          { field: `steps[${index}].inputMapping` }
        );
      }

      const entries = Object.entries(step.inputMapping);
      if (!entries.every(([, value]) => typeof value === "string")) {
        return errorResult(
          "invalid_arguments",
          `steps[${index}].inputMapping must be an object of string expressions`,
          { field: `steps[${index}].inputMapping` }
        );
      }

      inputMapping = Object.fromEntries(entries) as Record<string, string>;
    }

    steps.push({
      tool,
      ...(typeof server === "string" ? { server } : {}),
      ...(parsedArgs ? { arguments: parsedArgs } : {}),
      ...(inputMapping ? { inputMapping } : {}),
    });
  }

  return { steps };
}

function validateCacheClearArgs(
  args: unknown
): { tool?: string; server?: string } | CallToolResult {
  if (args === undefined) return {};
  if (!isRecord(args)) {
    return errorResult("invalid_arguments", "cache clear arguments must be an object", {
      field: "arguments",
    });
  }

  const tool = args.tool === undefined ? undefined : validateToolName(args.tool, "tool");
  if (tool !== undefined && typeof tool !== "string") return tool;

  const server =
    args.server === undefined ? undefined : validateToolName(args.server, "server");
  if (server !== undefined && typeof server !== "string") return server;

  return {
    ...(typeof tool === "string" ? { tool } : {}),
    ...(typeof server === "string" ? { server } : {}),
  };
}

export async function handleParallel(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  maxConcurrency: number
): Promise<CallToolResult> {
  const concurrencyError = validateConcurrency(maxConcurrency);
  if (concurrencyError) return concurrencyError;

  const parsedArgs = validateParallelArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { calls } = parsedArgs;

  const globalSemaphore = new Semaphore(maxConcurrency);
  const serverSemaphores = new Map<string, Semaphore>();

  const getServerSemaphore = (server: string | undefined): Semaphore | undefined => {
    if (!server) return undefined;
    let sem = serverSemaphores.get(server);
    if (sem) return sem;
    const limit = upstream.getServerConcurrency(server);
    if (limit === undefined) return undefined;
    sem = new Semaphore(limit);
    serverSemaphores.set(server, sem);
    return sem;
  };

  const promises = calls.map(async (call) => {
    const serverSem = getServerSemaphore(call.server);
    await globalSemaphore.acquire();
    if (serverSem) await serverSem.acquire();
    const callStart = Date.now();
    try {
      const cached = cache.get(call.tool, call.arguments, call.server);
      if (cached) {
        return { call, result: cached, durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(call.tool, call.arguments, call.server);
      cache.set(call.tool, call.arguments, result, call.server);
      return { call, result, durationMs: Date.now() - callStart };
    } catch (err) {
      return {
        call,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      };
    } finally {
      if (serverSem) serverSem.release();
      globalSemaphore.release();
    }
  });

  const results = await Promise.all(promises);
  const output: ParallelResult = {
    results,
    totalDurationMs: Date.now() - startTime,
  };

  return successResult(output as unknown as Record<string, unknown>);
}

export async function handleBatch(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  maxConcurrency: number
): Promise<CallToolResult> {
  const concurrencyError = validateConcurrency(maxConcurrency);
  if (concurrencyError) return concurrencyError;

  const parsedArgs = validateBatchArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { server, tool, items } = parsedArgs;

  const serverLimit = server ? upstream.getServerConcurrency(server) : undefined;
  const effectiveLimit = serverLimit !== undefined
    ? Math.min(maxConcurrency, serverLimit)
    : maxConcurrency;
  const semaphore = new Semaphore(effectiveLimit);
  let succeeded = 0;
  let failed = 0;

  const promises = items.map(async (item, index) => {
    await semaphore.acquire();
    const callStart = Date.now();
    try {
      const cached = cache.get(tool, item.arguments, server);
      if (cached) {
        succeeded++;
        return { index, result: cached, durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(tool, item.arguments, server);
      cache.set(tool, item.arguments, result, server);
      if (result.isError) failed++;
      else succeeded++;
      return { index, result, durationMs: Date.now() - callStart };
    } catch (err) {
      failed++;
      return {
        index,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      };
    } finally {
      semaphore.release();
    }
  });

  const results = await Promise.all(promises);
  const output: BatchResult = {
    results,
    totalDurationMs: Date.now() - startTime,
    succeeded,
    failed,
  };

  return successResult(output as unknown as Record<string, unknown>);
}

export async function handlePipeline(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown
): Promise<CallToolResult> {
  const parsedArgs = validatePipelineArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { steps } = parsedArgs;
  const stepResults: PipelineResult["steps"] = [];
  let previousText = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const callStart = Date.now();

    const mergedArgs: Record<string, unknown> = { ...(step.arguments ?? {}) };

    if (step.inputMapping && i > 0) {
      for (const [argName, expr] of Object.entries(step.inputMapping)) {
        const value = resolveMapping(previousText, expr);
        if (value !== undefined) {
          mergedArgs[argName] = value;
        }
      }
    }

    try {
      const cached = cache.get(step.tool, mergedArgs, step.server);
      const result = cached ?? await upstream.callTool(step.tool, mergedArgs, step.server);

      if (!cached) {
        cache.set(step.tool, mergedArgs, result, step.server);
      }

      const durationMs = Date.now() - callStart;
      stepResults.push({ step: i, tool: step.tool, result, durationMs });

      if (result.isError) {
        const output: PipelineResult = {
          steps: stepResults,
          totalDurationMs: Date.now() - startTime,
        };
        return successResult(output as unknown as Record<string, unknown>);
      }

      previousText = extractText(result);
    } catch (err) {
      stepResults.push({
        step: i,
        tool: step.tool,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      });

      const output: PipelineResult = {
        steps: stepResults,
        totalDurationMs: Date.now() - startTime,
      };
      return successResult(output as unknown as Record<string, unknown>);
    }
  }

  const output: PipelineResult = {
    steps: stepResults,
    finalResult: stepResults[stepResults.length - 1]?.result,
    totalDurationMs: Date.now() - startTime,
  };

  return successResult(output as unknown as Record<string, unknown>);
}

export async function handleCall(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown
): Promise<CallToolResult> {
  if (!isRecord(args)) {
    return errorResult("invalid_arguments", '"tool" must be a non-empty string', {
      field: "tool",
    });
  }

  const tool = validateToolName(args.tool, "tool");
  if (typeof tool !== "string") return tool;

  const server =
    args.server === undefined ? undefined : validateToolName(args.server, "server");
  if (server !== undefined && typeof server !== "string") return server;

  const parsedArgs = validateArgumentsObject(args.arguments, "arguments");
  if (parsedArgs !== undefined && !isRecord(parsedArgs)) return parsedArgs;

  const resolved = upstream.resolveServer(tool, server);
  if (!resolved) {
    const available = server
      ? upstream.getServerTools(server)
      : upstream.getServerNames().flatMap((s) => upstream.getServerTools(s));
    return errorResult("tool_not_found", `tool "${tool}" not found`, {
      tool,
      available,
    });
  }
  if ("error" in resolved) return resolved.error;

  const cached = cache.get(tool, parsedArgs, server);
  if (cached) return cached;

  const result = await upstream.callTool(tool, parsedArgs, server);
  cache.set(tool, parsedArgs, result, server);
  return result;
}

export function handleCacheClear(
  cache: CallCache,
  args: unknown
): CallToolResult {
  const parsedArgs = validateCacheClearArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const before = cache.size;
  cache.invalidate(parsedArgs.tool, parsedArgs.server);
  const cleared = before - cache.size;

  if (parsedArgs.tool && parsedArgs.server) {
    return jsonResult({
      cleared,
      tool: parsedArgs.tool,
      server: parsedArgs.server,
      scope: "tool-server",
    });
  }

  if (parsedArgs.tool) {
    return jsonResult({
      cleared,
      tool: parsedArgs.tool,
      scope: "tool",
    });
  }

  if (parsedArgs.server) {
    return jsonResult({
      cleared,
      server: parsedArgs.server,
      scope: "server",
    });
  }

  return jsonResult({
    cleared,
    scope: "all",
    previousSize: before,
  });
}

export function handleStatus(
  upstream: UpstreamManager,
  cache: CallCache,
  maxConcurrency: number,
  metaOnly: boolean,
  defaultDescriptionMaxLength: number | undefined,
  args: unknown
): CallToolResult {
  const parsed = isRecord(args) ? args : {};
  const serverFilter = typeof parsed.server === "string" ? parsed.server : undefined;
  const includeDescriptions = parsed.descriptions === true;
  const descriptionMaxLength =
    typeof parsed.descriptionMaxLength === "number" && parsed.descriptionMaxLength > 0
      ? parsed.descriptionMaxLength
      : defaultDescriptionMaxLength && defaultDescriptionMaxLength > 0
        ? defaultDescriptionMaxLength
        : undefined;

  const serverNames = upstream.getServerNames();
  const failedServers = upstream.getFailedServers();

  const truncate = (desc: string | undefined): string | undefined => {
    if (!desc) return desc;
    if (!descriptionMaxLength || desc.length <= descriptionMaxLength) return desc;
    return desc.slice(0, descriptionMaxLength) + "...";
  };

  const servers = serverNames
    .filter((name) => !serverFilter || name === serverFilter)
    .map((name) => {
      const info = upstream.getServerInfo(name);
      const base: Record<string, unknown> = { name };

      if (info) {
        base.transport = info.transport;
        base.state = info.state;
        base.connectDurationMs = info.connectDurationMs;
        if (info.toolFilter) base.toolFilter = info.toolFilter;
        if (info.totalTools !== info.exposedTools) base.totalTools = info.totalTools;
        if (info.maxConcurrency) base.maxConcurrency = info.maxConcurrency;
      }

      if (includeDescriptions) {
        const toolsWithDesc = upstream.getToolsWithDescriptions(name).map((t) => ({
          name: t.name,
          ...(t.description !== undefined
            ? { description: truncate(t.description) }
            : {}),
        }));
        base.tools = toolsWithDesc;
        base.toolCount = toolsWithDesc.length;
      } else {
        const tools = upstream.getServerTools(name);
        base.tools = tools;
        base.toolCount = tools.length;
      }

      return base;
    });

  const failed = failedServers
    .filter((failure) => !serverFilter || failure.name === serverFilter)
    .map((failure) => {
      const info = upstream.getServerInfo(failure.name);
      return {
        name: failure.name,
        error: failure.error,
        ...(info ? {
          transport: info.transport,
          connectDurationMs: info.connectDurationMs,
        } : {}),
      };
    });

  if (serverFilter && servers.length === 0 && failed.length === 0) {
    return errorResult(
      "server_not_found",
      `server "${serverFilter}" not found`,
      { available: [...serverNames, ...failedServers.map((failure) => failure.name)] }
    );
  }

  return jsonResult({
    status: failedServers.length > 0 ? "degraded" : "ok",
    mode: metaOnly ? "meta-only" : "standard",
    servers,
    failedServers: failed,
    totalTools: servers.reduce((sum, s) => sum + (s.toolCount as number), 0),
    cache: cache.stats(),
    maxConcurrency,
  });
}

// ─── Simple concurrency limiter ────────────────────────────────

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private max: number) {}

  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.current--;
    }
  }
}
