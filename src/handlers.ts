import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager } from "./upstream.js";
import type { CallCache } from "./cache.js";
import { errorResult, jsonResult } from "./results.js";
import type {
  ParallelCall,
  BatchItem,
  PipelineStep,
  InstanceIdentity,
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

function unwrapResult(result: CallToolResult): unknown {
  const text = extractText(result);
  if (result.isError) return { error: text, isError: true };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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

function inferServerFromQualifiedTool(
  tool: string,
  explicitServer?: string
): string | undefined {
  if (explicitServer) return explicitServer;

  const separator = tool.indexOf("__");
  if (separator <= 0) return undefined;

  return tool.slice(0, separator);
}

type DryRunMode = "call" | "parallel" | "batch" | "pipeline";

interface DryRunCall {
  tool: string;
  server?: string;
  arguments?: Record<string, unknown>;
  source:
    | { mode: "call" }
    | { mode: "parallel"; index: number }
    | { mode: "batch"; index: number }
    | { mode: "pipeline"; step: number; hasInputMapping: boolean };
}

function validateDryRunArgs(
  args: unknown
): { mode: DryRunMode; calls: DryRunCall[] } | CallToolResult {
  if (!isRecord(args)) {
    return errorResult("invalid_arguments", "dry run arguments must be an object", {
      field: "arguments",
    });
  }

  const modeRaw = args.mode;
  const mode = modeRaw === undefined
    ? undefined
    : validateToolName(modeRaw, "mode");
  if (mode !== undefined && typeof mode !== "string") return mode;

  const normalizedMode = mode as DryRunMode | undefined;
  if (
    normalizedMode !== undefined &&
    normalizedMode !== "call" &&
    normalizedMode !== "parallel" &&
    normalizedMode !== "batch" &&
    normalizedMode !== "pipeline"
  ) {
    return errorResult(
      "invalid_arguments",
      '"mode" must be one of "call", "parallel", "batch", or "pipeline"',
      { field: "mode" }
    );
  }

  const inferredMode: DryRunMode | undefined = normalizedMode
    ?? (Array.isArray(args.calls)
      ? "parallel"
      : Array.isArray(args.items)
        ? "batch"
        : Array.isArray(args.steps)
          ? "pipeline"
          : typeof args.tool === "string"
            ? "call"
            : undefined);

  if (!inferredMode) {
    return errorResult(
      "invalid_arguments",
      'unable to infer dry run mode; provide "mode" or one of: calls/items/steps/tool',
      { field: "mode" }
    );
  }

  if (inferredMode === "call") {
    const tool = validateToolName(args.tool, "tool");
    if (typeof tool !== "string") return tool;
    const server =
      args.server === undefined ? undefined : validateToolName(args.server, "server");
    if (server !== undefined && typeof server !== "string") return server;
    const parsedArgs = validateArgumentsObject(args.arguments, "arguments");
    if (parsedArgs !== undefined && !isRecord(parsedArgs)) return parsedArgs;
    return {
      mode: "call",
      calls: [{
        tool,
        ...(typeof server === "string" ? { server } : {}),
        ...(parsedArgs ? { arguments: parsedArgs } : {}),
        source: { mode: "call" },
      }],
    };
  }

  if (inferredMode === "parallel") {
    const validated = validateParallelArgs(args);
    if (isToolErrorResult(validated)) return validated;
    return {
      mode: "parallel",
      calls: validated.calls.map((call, index) => ({
        ...call,
        source: { mode: "parallel", index },
      })),
    };
  }

  if (inferredMode === "batch") {
    const validated = validateBatchArgs(args);
    if (isToolErrorResult(validated)) return validated;
    return {
      mode: "batch",
      calls: validated.items.map((item, index) => ({
        tool: validated.tool,
        ...(validated.server ? { server: validated.server } : {}),
        arguments: item.arguments,
        source: { mode: "batch", index },
      })),
    };
  }

  const validated = validatePipelineArgs(args);
  if (isToolErrorResult(validated)) return validated;
  return {
    mode: "pipeline",
    calls: validated.steps.map((step, stepIndex) => ({
      tool: step.tool,
      ...(step.server ? { server: step.server } : {}),
      ...(step.arguments ? { arguments: step.arguments } : {}),
      source: {
        mode: "pipeline",
        step: stepIndex,
        hasInputMapping: !!step.inputMapping,
      },
    })),
  };
}

function extractStructuredError(result: CallToolResult): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  const structured = result.structuredContent as
    | { error?: { code?: unknown; message?: unknown; details?: unknown } }
    | undefined;
  const maybe = structured?.error;
  if (maybe && typeof maybe.message === "string") {
    return {
      code: typeof maybe.code === "string" ? maybe.code : "unknown_error",
      message: maybe.message,
      ...(isRecord(maybe.details) ? { details: maybe.details } : {}),
    };
  }
  return {
    code: "unknown_error",
    message: extractText(result) || "unknown error",
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
    const serverForLimit = inferServerFromQualifiedTool(call.tool, call.server);
    const serverSem = getServerSemaphore(serverForLimit);
    await globalSemaphore.acquire();
    if (serverSem) await serverSem.acquire();
    const callStart = Date.now();
    try {
      const cached = cache.get(call.tool, call.arguments, call.server);
      if (cached) {
        return { call, result: unwrapResult(cached), durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(call.tool, call.arguments, call.server);
      cache.set(call.tool, call.arguments, result, call.server);
      return { call, result: unwrapResult(result), durationMs: Date.now() - callStart };
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
  const output = {
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

  const serverForLimit = inferServerFromQualifiedTool(tool, server);
  const serverLimit = serverForLimit
    ? upstream.getServerConcurrency(serverForLimit)
    : undefined;
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
        return { index, result: unwrapResult(cached), durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(tool, item.arguments, server);
      cache.set(tool, item.arguments, result, server);
      if (result.isError) failed++;
      else succeeded++;
      return { index, result: unwrapResult(result), durationMs: Date.now() - callStart };
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
  const output = {
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
  const stepResults: Array<{ step: number; tool: string; result?: unknown; error?: string; durationMs: number }> = [];
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
      stepResults.push({ step: i, tool: step.tool, result: unwrapResult(result), durationMs });

      if (result.isError) {
        return successResult({
          steps: stepResults,
          totalDurationMs: Date.now() - startTime,
        });
      }

      previousText = extractText(result);
    } catch (err) {
      stepResults.push({
        step: i,
        tool: step.tool,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      });

      return successResult({
        steps: stepResults,
        totalDurationMs: Date.now() - startTime,
      });
    }
  }

  return successResult({
    steps: stepResults,
    finalResult: stepResults[stepResults.length - 1]?.result,
    totalDurationMs: Date.now() - startTime,
  });
}

export async function handleDryRun(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown
): Promise<CallToolResult> {
  const parsed = validateDryRunArgs(args);
  if (isToolErrorResult(parsed)) return parsed;

  const items: Array<Record<string, unknown>> = [];
  let estimatedResolvedArgumentBytes = 0;
  let cacheHitCandidates = 0;
  let invalidCalls = 0;

  for (const call of parsed.calls) {
    const prepare = await upstream.prepareToolCall(
      call.tool,
      call.arguments,
      call.server
    );

    if ("error" in prepare) {
      invalidCalls++;
      items.push({
        source: call.source,
        tool: call.tool,
        ...(call.server ? { server: call.server } : {}),
        error: extractStructuredError(prepare.error),
      });
      continue;
    }

    const cacheHit = cache.get(call.tool, call.arguments, call.server) !== null;
    if (cacheHit) cacheHitCandidates++;

    const resolvedArguments = prepare.resolvedArguments;
    const resolvedArgumentBytes = resolvedArguments
      ? Buffer.byteLength(JSON.stringify(resolvedArguments), "utf8")
      : 0;
    estimatedResolvedArgumentBytes += resolvedArgumentBytes;

    items.push({
      source: call.source,
      tool: call.tool,
      ...(call.server ? { serverHint: call.server } : {}),
      resolved: {
        server: prepare.server,
        actualTool: prepare.actualName,
        qualifiedTool: `${prepare.server}__${prepare.actualName}`,
      },
      ...(resolvedArguments ? { resolvedArguments } : {}),
      resolvedArgumentBytes,
      cacheHitCandidate: cacheHit,
      ...(call.source.mode === "pipeline" && call.source.hasInputMapping
        ? { note: "inputMapping not applied in dry run (depends on previous step output)" }
        : {}),
    });
  }

  const totalCalls = parsed.calls.length;
  const validCalls = totalCalls - invalidCalls;
  return successResult({
    mode: parsed.mode,
    valid: invalidCalls === 0,
    items,
    summary: {
      totalCalls,
      validCalls,
      invalidCalls,
      cacheHitCandidates,
      estimatedResolvedArgumentBytes,
    },
  });
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
  instanceIdentity: InstanceIdentity,
  args: unknown
): CallToolResult {
  const parsed = isRecord(args) ? args : {};
  const serverFilter = typeof parsed.server === "string" ? parsed.server : undefined;
  const includeDescriptions = parsed.descriptions === true;
  const includeRecommendations = parsed.recommendations !== false;
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
    const availableServers = [...serverNames, ...failedServers.map((failure) => failure.name)];
    const namespaceText = instanceIdentity.namespace
      ? ` (namespace: ${instanceIdentity.namespace})`
      : "";
    return errorResult(
      "server_not_found",
      `server "${serverFilter}" not found in this callmux instance${namespaceText}`,
      {
        server: serverFilter,
        availableServers,
        ...(instanceIdentity.namespace ? { namespace: instanceIdentity.namespace } : {}),
        instanceId: instanceIdentity.instanceId,
      }
    );
  }

  const wrappedServers = [...new Set([
    ...serverNames,
    ...failedServers.map((failure) => failure.name),
  ])].sort();

  const recommendations: Array<{ when: string; use: string; note: string }> = [];
  if (metaOnly) {
    recommendations.push({
      when: "Single downstream call in meta-only mode",
      use: "callmux_call",
      note: "Call one proxied tool by name with optional server hint.",
    });
  }
  recommendations.push(
    {
      when: "Independent calls to different tools",
      use: "callmux_parallel",
      note: "Run unrelated calls concurrently.",
    },
    {
      when: "Same tool repeated with different arguments",
      use: "callmux_batch",
      note: "Fan out one tool across many input items.",
    },
    {
      when: "Later call depends on earlier output",
      use: "callmux_pipeline",
      note: "Map prior results into next-step arguments.",
    },
    {
      when: "Validate routing/arguments before execution",
      use: "callmux_dry_run",
      note: "Resolve refs and detect ambiguity without running downstream tools.",
    }
  );
  if (wrappedServers.length > 1 && !serverFilter) {
    recommendations.push({
      when: "Avoid ambiguity across multiple wrapped servers",
      use: "server hint or qualified tool names",
      note: "Set server in meta-calls or use names like github__get_issue.",
    });
  }

  return jsonResult({
    status: failedServers.length > 0 ? "degraded" : "ok",
    mode: metaOnly ? "meta-only" : "standard",
    ...(instanceIdentity.namespace ? { namespace: instanceIdentity.namespace } : {}),
    instanceId: instanceIdentity.instanceId,
    wrappedServers,
    servers,
    failedServers: failed,
    totalTools: servers.reduce((sum, s) => sum + (s.toolCount as number), 0),
    cache: cache.stats(),
    maxConcurrency,
    ...(includeRecommendations ? { recommendations } : {}),
  });
}

// ─── Simple concurrency limiter ────────────────────────────────

class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];
  private queueHead = 0;

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
    const next = this.queue[this.queueHead];
    if (next) {
      this.queueHead++;
      // Periodically compact resolved waiters to avoid unbounded sparse arrays.
      if (this.queueHead >= 64 && this.queueHead * 2 >= this.queue.length) {
        this.queue = this.queue.slice(this.queueHead);
        this.queueHead = 0;
      }
      next();
    } else {
      if (this.queueHead > 0) {
        this.queue = [];
        this.queueHead = 0;
      }
      this.current--;
    }
  }
}
