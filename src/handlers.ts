import { isAbsolute } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager } from "./upstream.js";
import type { CallCache } from "./cache.js";
import type { ResponseStore } from "./response-store.js";
import { errorResult, jsonResult } from "./results.js";
import type {
  ParallelCall,
  BatchItem,
  PipelineStep,
  InstanceIdentity,
  RecipeConfig,
  ToolCallContext,
  ListenerRuntimeDiagnostics,
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

function cacheScopeForCall(
  upstream: UpstreamManager,
  tool: string,
  server: string | undefined,
  context?: ToolCallContext
): string | undefined {
  const maybeScoped = upstream as UpstreamManager & {
    cacheScopeForCall?: (
      toolName: string,
      serverHint?: string,
      context?: ToolCallContext
    ) => string | undefined;
  };
  return typeof maybeScoped.cacheScopeForCall === "function"
    ? maybeScoped.cacheScopeForCall(tool, server, context)
    : context?.cwd;
}

function resolveMapping(text: string, expr: string): unknown {
  const resolved = resolveMappingWithDiagnostics(text, expr);
  return resolved.matched ? resolved.value : undefined;
}

function resolveMappingWithDiagnostics(
  text: string,
  expr: string
): { matched: true; value: unknown } | { matched: false; reason: string } {
  if (expr === "$text") return { matched: true, value: text };

  if (expr === "$json" || expr.startsWith("$json.")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { matched: false, reason: "previous_result_not_json" };
    }

    if (expr === "$json") return { matched: true, value: parsed };

    const path = expr.slice(6).split(".");
    let current: unknown = parsed;
    for (const key of path) {
      if (current == null || typeof current !== "object" || !(key in current)) {
        return { matched: false, reason: "path_not_found" };
      }
      current = (current as Record<string, unknown>)[key];
    }
    return { matched: true, value: current };
  }

  return { matched: true, value: expr };
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

function validatePositiveInteger(
  value: unknown,
  field: string,
  max: number
): number | undefined | CallToolResult {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return errorResult("invalid_arguments", `${field} must be a positive integer`, {
      field,
    });
  }
  if (value > max) {
    return errorResult("invalid_arguments", `${field} must be <= ${max}`, {
      field,
      max,
    });
  }
  return value;
}

function validateTimeoutMs(
  value: unknown,
  field: string
): number | undefined | CallToolResult {
  return validatePositiveInteger(value, field, Number.MAX_SAFE_INTEGER);
}

function validateCwd(
  value: unknown,
  field: string
): string | undefined | CallToolResult {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    return errorResult("invalid_arguments", `${field} must be a non-empty absolute path`, {
      field,
    });
  }
  const cwd = value.trim();
  if (!isAbsolute(cwd)) {
    return errorResult("invalid_arguments", `${field} must be an absolute path`, {
      field,
    });
  }
  return cwd;
}

function contextWithCallOverrides(
  context: ToolCallContext | undefined,
  overrides: { timeoutMs?: number; cwd?: string }
): ToolCallContext | undefined {
  if (overrides.timeoutMs === undefined && overrides.cwd === undefined) return context;
  return {
    ...context,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
  };
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
    const timeoutMs = validateTimeoutMs(call.timeoutMs, `calls[${index}].timeoutMs`);
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") return timeoutMs;
    const cwd = validateCwd(call.cwd, `calls[${index}].cwd`);
    if (cwd !== undefined && typeof cwd !== "string") return cwd;

    calls.push({
      tool,
      ...(typeof server === "string" ? { server } : {}),
      ...(parsedArgs ? { arguments: parsedArgs } : {}),
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
    });
  }

  return { calls };
}

function validateBatchArgs(
  args: unknown
): { server?: string; tool: string; items: BatchItem[]; timeoutMs?: number; cwd?: string } | CallToolResult {
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
  const timeoutMs = validateTimeoutMs(args.timeoutMs, "timeoutMs");
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return timeoutMs;
  const cwd = validateCwd(args.cwd, "cwd");
  if (cwd !== undefined && typeof cwd !== "string") return cwd;

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
    const itemTimeoutMs = validateTimeoutMs(item.timeoutMs, `items[${index}].timeoutMs`);
    if (itemTimeoutMs !== undefined && typeof itemTimeoutMs !== "number") {
      return itemTimeoutMs;
    }
    const itemCwd = validateCwd(item.cwd, `items[${index}].cwd`);
    if (itemCwd !== undefined && typeof itemCwd !== "string") {
      return itemCwd;
    }

    items.push({
      arguments: parsedArgs,
      ...(typeof itemTimeoutMs === "number" ? { timeoutMs: itemTimeoutMs } : {}),
      ...(typeof itemCwd === "string" ? { cwd: itemCwd } : {}),
    });
  }

  return {
    tool,
    items,
    ...(typeof server === "string" ? { server } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
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
    const timeoutMs = validateTimeoutMs(step.timeoutMs, `steps[${index}].timeoutMs`);
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") return timeoutMs;
    const cwd = validateCwd(step.cwd, `steps[${index}].cwd`);
    if (cwd !== undefined && typeof cwd !== "string") return cwd;

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
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(typeof cwd === "string" ? { cwd } : {}),
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

function resolveServerForConcurrency(
  upstream: UpstreamManager,
  tool: string,
  explicitServer?: string
): string | undefined {
  const inferred = inferServerFromQualifiedTool(tool, explicitServer);
  if (inferred) return inferred;

  const maybeResolve = (upstream as unknown as {
    resolveServer?: (
      toolName: string,
      serverHint?: string
    ) => { server: string } | { error: CallToolResult } | null;
  }).resolveServer;
  if (typeof maybeResolve !== "function") return undefined;

  const resolved = maybeResolve.call(upstream, tool, explicitServer);
  if (!resolved || "error" in resolved) return undefined;
  return resolved.server;
}

type DryRunMode = "call" | "parallel" | "batch" | "pipeline";

type RecipeArgs = { recipe: string; arguments?: Record<string, unknown> };

type ExpandedRecipeInvocation = {
  recipeName: string;
  recipe: RecipeConfig;
  args: Record<string, unknown>;
};

interface DryRunCall {
  tool: string;
  server?: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  cwd?: string;
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
    const timeoutMs = validateTimeoutMs(args.timeoutMs, "timeoutMs");
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") return timeoutMs;
    const cwd = validateCwd(args.cwd, "cwd");
    if (cwd !== undefined && typeof cwd !== "string") return cwd;
    return {
      mode: "call",
      calls: [{
        tool,
        ...(typeof server === "string" ? { server } : {}),
        ...(parsedArgs ? { arguments: parsedArgs } : {}),
        ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
        ...(typeof cwd === "string" ? { cwd } : {}),
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
        ...((item.timeoutMs ?? validated.timeoutMs) !== undefined
          ? { timeoutMs: item.timeoutMs ?? validated.timeoutMs }
          : {}),
        ...((item.cwd ?? validated.cwd) !== undefined
          ? { cwd: item.cwd ?? validated.cwd }
          : {}),
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
      ...(step.timeoutMs ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.cwd ? { cwd: step.cwd } : {}),
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

function validateRecipeArgs(args: unknown): RecipeArgs | CallToolResult {
  if (!isRecord(args)) {
    return errorResult("invalid_arguments", '"recipe" must be a non-empty string', {
      field: "recipe",
    });
  }

  const recipe = validateToolName(args.recipe, "recipe");
  if (typeof recipe !== "string") return recipe;

  const parsedArgs = validateArgumentsObject(args.arguments, "arguments");
  if (parsedArgs !== undefined && !isRecord(parsedArgs)) return parsedArgs;

  return {
    recipe,
    ...(parsedArgs ? { arguments: parsedArgs } : {}),
  };
}

function substituteRecipeValue(
  value: unknown,
  provided: Record<string, unknown>,
  path: string
): unknown | CallToolResult {
  if (Array.isArray(value)) {
    const replaced: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const nested = substituteRecipeValue(value[index], provided, `${path}[${index}]`);
      if (isToolErrorResult(nested)) return nested;
      replaced.push(nested);
    }
    return replaced;
  }

  if (!isRecord(value)) return value;

  const entries = Object.entries(value);
  if (entries.length === 1 && entries[0][0] === "$param") {
    const name = entries[0][1];
    if (typeof name !== "string" || name.trim().length === 0) {
      return errorResult(
        "invalid_arguments",
        `${path}.$param must be a non-empty string`,
        { field: `${path}.$param` }
      );
    }
    if (!Object.prototype.hasOwnProperty.call(provided, name)) {
      return errorResult(
        "invalid_arguments",
        `recipe argument "${name}" is required`,
        { field: `arguments.${name}`, parameter: name }
      );
    }
    return provided[name];
  }

  const replaced: Record<string, unknown> = {};
  for (const [key, nestedValue] of entries) {
    const nested = substituteRecipeValue(
      nestedValue,
      provided,
      path ? `${path}.${key}` : key
    );
    if (isToolErrorResult(nested)) return nested;
    replaced[key] = nested;
  }
  return replaced;
}

export function expandRecipeInvocation(
  recipes: Record<string, RecipeConfig> | undefined,
  args: unknown
): ExpandedRecipeInvocation | CallToolResult {
  const parsed = validateRecipeArgs(args);
  if (isToolErrorResult(parsed)) return parsed;

  const recipe = recipes?.[parsed.recipe];
  if (!recipe) {
    return errorResult("recipe_not_found", `recipe "${parsed.recipe}" not found`, {
      recipe: parsed.recipe,
      availableRecipes: Object.keys(recipes ?? {}).sort(),
    });
  }

  const substituted = substituteRecipeValue(
    recipe,
    parsed.arguments ?? {},
    `recipes.${parsed.recipe}`
  );
  if (isToolErrorResult(substituted)) return substituted;

  const expandedRecipe = substituted as RecipeConfig;
  const expandedArgs: Record<string, unknown> = { mode: expandedRecipe.mode };
  if (expandedRecipe.server !== undefined) expandedArgs.server = expandedRecipe.server;
  if (expandedRecipe.tool !== undefined) expandedArgs.tool = expandedRecipe.tool;
  if (expandedRecipe.arguments !== undefined) expandedArgs.arguments = expandedRecipe.arguments;
  if (expandedRecipe.timeoutMs !== undefined) expandedArgs.timeoutMs = expandedRecipe.timeoutMs;
  if (expandedRecipe.cwd !== undefined) expandedArgs.cwd = expandedRecipe.cwd;
  if (expandedRecipe.calls !== undefined) expandedArgs.calls = expandedRecipe.calls;
  if (expandedRecipe.items !== undefined) expandedArgs.items = expandedRecipe.items;
  if (expandedRecipe.steps !== undefined) expandedArgs.steps = expandedRecipe.steps;

  return {
    recipeName: parsed.recipe,
    recipe,
    args: expandedArgs,
  };
}

export async function handleParallel(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  maxConcurrency: number,
  context?: ToolCallContext
): Promise<CallToolResult> {
  const concurrencyError = validateConcurrency(maxConcurrency);
  if (concurrencyError) return concurrencyError;

  const parsedArgs = validateParallelArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { calls } = parsedArgs;
  const callsWithLimits = calls.map((call) => ({
    call,
    serverForLimit: resolveServerForConcurrency(upstream, call.tool, call.server),
  }));

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

  const promises = callsWithLimits.map(async ({ call, serverForLimit }) => {
    const serverSem = getServerSemaphore(serverForLimit);
    await globalSemaphore.acquire();
    if (serverSem) await serverSem.acquire();
    const callStart = Date.now();
    try {
      const callContext = contextWithCallOverrides(context, {
        timeoutMs: call.timeoutMs,
        cwd: call.cwd,
      });
      const cacheScope = cacheScopeForCall(upstream, call.tool, call.server, callContext);
      const cached = cache.get(call.tool, call.arguments, call.server, cacheScope);
      if (cached) {
        return { call, result: unwrapResult(cached), durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(
        call.tool,
        call.arguments,
        call.server,
        callContext
      );
      cache.set(call.tool, call.arguments, result, call.server, cacheScope);
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
  const failedIndexes = results.flatMap((result, index) => {
    if (result.error || (isRecord(result.result) && result.result.isError === true)) {
      return [index];
    }
    return [];
  });
  const failed = failedIndexes.length;
  const output = {
    status: failed === 0 ? "completed" : "partial",
    results,
    totalDurationMs: Date.now() - startTime,
    succeeded: results.length - failed,
    failed,
    failedIndexes,
  };

  return successResult(output as unknown as Record<string, unknown>);
}

export async function handleBatch(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  maxConcurrency: number,
  context?: ToolCallContext
): Promise<CallToolResult> {
  const concurrencyError = validateConcurrency(maxConcurrency);
  if (concurrencyError) return concurrencyError;

  const parsedArgs = validateBatchArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { server, tool, items, timeoutMs, cwd } = parsedArgs;

  const serverForLimit = resolveServerForConcurrency(upstream, tool, server);
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
      const callContext = contextWithCallOverrides(context, {
        timeoutMs: item.timeoutMs ?? timeoutMs,
        cwd: item.cwd ?? cwd,
      });
      const cacheScope = cacheScopeForCall(upstream, tool, server, callContext);
      const cached = cache.get(tool, item.arguments, server, cacheScope);
      if (cached) {
        succeeded++;
        return { index, result: unwrapResult(cached), durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(
        tool,
        item.arguments,
        server,
        callContext
      );
      cache.set(tool, item.arguments, result, server, cacheScope);
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
  const failedIndexes = results.flatMap((result) => {
    if (result.error || (isRecord(result.result) && result.result.isError === true)) {
      return [result.index];
    }
    return [];
  });
  const output = {
    status: failed === 0 ? "completed" : "partial",
    results,
    totalDurationMs: Date.now() - startTime,
    succeeded,
    failed,
    failedIndexes,
  };

  return successResult(output as unknown as Record<string, unknown>);
}

export async function handlePipeline(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  context?: ToolCallContext
): Promise<CallToolResult> {
  const parsedArgs = validatePipelineArgs(args);
  if (isToolErrorResult(parsedArgs)) return parsedArgs;

  const startTime = Date.now();
  const { steps } = parsedArgs;
  const stepResults: Array<{
    step: number;
    tool: string;
    mappedArguments?: Record<string, unknown>;
    skippedMappings?: Array<{ argument: string; expression: string; reason: string }>;
    result?: unknown;
    error?: string;
    durationMs: number;
  }> = [];
  let previousText = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const callStart = Date.now();

    const mergedArgs: Record<string, unknown> = { ...(step.arguments ?? {}) };
    const mappedArguments: Record<string, unknown> = {};
    const skippedMappings: Array<{ argument: string; expression: string; reason: string }> = [];

    if (step.inputMapping && i > 0) {
      for (const [argName, expr] of Object.entries(step.inputMapping)) {
        const resolved = resolveMappingWithDiagnostics(previousText, expr);
        if (resolved.matched) {
          mergedArgs[argName] = resolved.value;
          mappedArguments[argName] = resolved.value;
        } else {
          skippedMappings.push({
            argument: argName,
            expression: expr,
            reason: resolved.reason,
          });
        }
      }
    }

    try {
      const callContext = contextWithCallOverrides(context, {
        timeoutMs: step.timeoutMs,
        cwd: step.cwd,
      });
      const cacheScope = cacheScopeForCall(upstream, step.tool, step.server, callContext);
      const cached = cache.get(step.tool, mergedArgs, step.server, cacheScope);
      const result = cached ?? await upstream.callTool(
        step.tool,
        mergedArgs,
        step.server,
        callContext
      );

      if (!cached) {
        cache.set(step.tool, mergedArgs, result, step.server, cacheScope);
      }

      const durationMs = Date.now() - callStart;
      stepResults.push({
        step: i,
        tool: step.tool,
        ...(Object.keys(mappedArguments).length > 0 ? { mappedArguments } : {}),
        ...(skippedMappings.length > 0 ? { skippedMappings } : {}),
        result: unwrapResult(result),
        durationMs,
      });

      if (result.isError) {
        return successResult({
          status: "failed",
          failedStep: i,
          steps: stepResults,
          totalDurationMs: Date.now() - startTime,
        });
      }

      previousText = extractText(result);
    } catch (err) {
      stepResults.push({
        step: i,
        tool: step.tool,
        ...(Object.keys(mappedArguments).length > 0 ? { mappedArguments } : {}),
        ...(skippedMappings.length > 0 ? { skippedMappings } : {}),
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      });

      return successResult({
        status: "failed",
        failedStep: i,
        steps: stepResults,
        totalDurationMs: Date.now() - startTime,
      });
    }
  }

  return successResult({
    status: "completed",
    steps: stepResults,
    finalResult: stepResults[stepResults.length - 1]?.result,
    totalDurationMs: Date.now() - startTime,
  });
}

export async function handleDryRun(
  upstream: UpstreamManager,
  cache: CallCache,
  args: unknown,
  context?: ToolCallContext
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

    const callContext = contextWithCallOverrides(context, {
      timeoutMs: call.timeoutMs,
      cwd: call.cwd,
    });
    const cacheScope = cacheScopeForCall(upstream, call.tool, call.server, callContext);
    const cacheHit = cache.get(call.tool, call.arguments, call.server, cacheScope) !== null;
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
      ...(call.timeoutMs ? { timeoutMs: call.timeoutMs } : {}),
      ...(call.cwd ? { cwd: call.cwd } : {}),
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
  args: unknown,
  context?: ToolCallContext
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
  const timeoutMs = validateTimeoutMs(args.timeoutMs, "timeoutMs");
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") return timeoutMs;
  const cwd = validateCwd(args.cwd, "cwd");
  if (cwd !== undefined && typeof cwd !== "string") return cwd;
  const forceReconnect = args.forceReconnect === undefined
    ? false
    : typeof args.forceReconnect === "boolean"
      ? args.forceReconnect
      : undefined;
  if (forceReconnect === undefined) {
    return errorResult("invalid_arguments", '"forceReconnect" must be a boolean', {
      field: "forceReconnect",
    });
  }

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

  const callContext = contextWithCallOverrides(context, {
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
  });
  const cacheScope = cacheScopeForCall(upstream, tool, server, callContext);
  const cached = cache.get(tool, parsedArgs, server, cacheScope);
  if (cached) return cached;

  const result = await upstream.callTool(tool, parsedArgs, server, {
    ...callContext,
    forceReconnect,
    retryOnReconnect: cache.isSafeToRetry(tool, server),
  });
  cache.set(tool, parsedArgs, result, server, cacheScope);
  return result;
}

interface SearchableTool {
  qualifiedName: string;
  name: string;
  server: string;
  description?: string;
  inputFields: string[];
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim();
}

function searchTokens(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function extractInputFields(schema: unknown): string[] {
  if (!isRecord(schema)) return [];

  if (isRecord(schema.properties)) {
    return Object.keys(schema.properties).sort();
  }

  const nested = schema.inputSchema;
  if (isRecord(nested)) {
    return extractInputFields(nested);
  }

  return [];
}

function getSearchableTools(upstream: UpstreamManager): SearchableTool[] {
  const withCatalog = upstream as UpstreamManager & {
    getTools?: () => Array<{ qualifiedName: string; server: string; tool: Tool }>;
  };

  if (typeof withCatalog.getTools === "function") {
    return withCatalog.getTools()
      .map(({ qualifiedName, server, tool }) => ({
        qualifiedName,
        name: tool.name,
        server,
        ...(tool.description ? { description: tool.description } : {}),
        inputFields: extractInputFields(tool.inputSchema),
      }))
      .sort((a, b) =>
        a.server.localeCompare(b.server) || a.name.localeCompare(b.name)
      );
  }

  return upstream.getServerNames().flatMap((server) =>
    upstream.getToolsWithDescriptions(server).map((tool) => ({
      qualifiedName: `${server}__${tool.name}`,
      name: tool.name,
      server,
      ...(tool.description ? { description: tool.description } : {}),
      inputFields: [],
    }))
  );
}

function scoreToolSearchResult(tool: SearchableTool, query: string): number {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return 0;

  const name = normalizeSearchText(tool.name);
  const qualifiedName = normalizeSearchText(tool.qualifiedName);
  const server = normalizeSearchText(tool.server);
  const description = normalizeSearchText(tool.description ?? "");
  const inputFields = normalizeSearchText(tool.inputFields.join(" "));
  const haystack = `${qualifiedName} ${name} ${server} ${description} ${inputFields}`;

  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 12;
    if (name.startsWith(token)) score += 8;
    if (name.includes(token)) score += 6;
    if (qualifiedName.includes(token)) score += 5;
    if (inputFields.split(/\s+/).includes(token)) score += 4;
    if (server === token || server.includes(token)) score += 3;
    if (description.includes(token)) score += 2;
    if (haystack.includes(token)) score += 1;
  }

  const queryNormalized = normalizeSearchText(query);
  if (name.includes(queryNormalized)) score += 10;
  if (qualifiedName.includes(queryNormalized)) score += 6;
  if (description.includes(queryNormalized)) score += 3;

  return score;
}

export function handleSearchTools(
  upstream: UpstreamManager,
  defaultDescriptionMaxLength: number | undefined,
  args: unknown
): CallToolResult {
  if (args !== undefined && !isRecord(args)) {
    return errorResult("invalid_arguments", "arguments must be an object", {
      field: "arguments",
    });
  }

  const parsed = isRecord(args) ? args : {};
  if (parsed.query !== undefined && typeof parsed.query !== "string") {
    return errorResult("invalid_arguments", "query must be a string", {
      field: "query",
    });
  }

  const server =
    parsed.server === undefined ? undefined : validateToolName(parsed.server, "server");
  if (server !== undefined && typeof server !== "string") return server;

  const limit = validatePositiveInteger(parsed.limit, "limit", 50);
  if (limit !== undefined && typeof limit !== "number") return limit;

  let descriptionMaxLength =
    defaultDescriptionMaxLength && defaultDescriptionMaxLength > 0
      ? defaultDescriptionMaxLength
      : undefined;
  if (parsed.descriptionMaxLength !== undefined) {
    if (
      typeof parsed.descriptionMaxLength !== "number" ||
      !Number.isInteger(parsed.descriptionMaxLength) ||
      parsed.descriptionMaxLength < 0
    ) {
      return errorResult(
        "invalid_arguments",
        "descriptionMaxLength must be a non-negative integer",
        { field: "descriptionMaxLength" }
      );
    }
    descriptionMaxLength =
      parsed.descriptionMaxLength > 0 ? parsed.descriptionMaxLength : undefined;
  }

  const query = typeof parsed.query === "string" ? parsed.query : "";
  const allTools = getSearchableTools(upstream);
  const serverTools = server
    ? allTools.filter((tool) => tool.server === server)
    : allTools;

  if (server && !upstream.getServerNames().includes(server)) {
    return errorResult("server_not_found", `server "${server}" not found`, {
      server,
      availableServers: upstream.getServerNames(),
    });
  }

  const queryTokenCount = searchTokens(query).length;
  const matches = serverTools
    .map((tool) => ({ tool, score: scoreToolSearchResult(tool, query) }))
    .filter((entry) => queryTokenCount === 0 || entry.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      a.tool.server.localeCompare(b.tool.server) ||
      a.tool.name.localeCompare(b.tool.name)
    );

  const resultLimit = limit ?? 10;
  const truncate = (description: string | undefined): string | undefined => {
    if (!description) return description;
    if (!descriptionMaxLength || description.length <= descriptionMaxLength) {
      return description;
    }
    return description.slice(0, descriptionMaxLength) + "...";
  };

  return jsonResult({
    query,
    ...(server ? { server } : {}),
    totalTools: serverTools.length,
    found: matches.length,
    limit: resultLimit,
    results: matches.slice(0, resultLimit).map(({ tool, score }) => ({
      tool: tool.qualifiedName,
      name: tool.name,
      server: tool.server,
      score,
      ...(tool.description !== undefined
        ? { description: truncate(tool.description) }
        : {}),
      ...(tool.inputFields.length > 0 ? { inputFields: tool.inputFields } : {}),
    })),
  });
}

export function handleGetResult(
  responseStore: ResponseStore,
  args: unknown
): CallToolResult {
  return responseStore.query(args);
}

export async function handleRecipeRun(
  upstream: UpstreamManager,
  cache: CallCache,
  recipes: Record<string, RecipeConfig> | undefined,
  args: unknown,
  maxConcurrency: number,
  context?: ToolCallContext
): Promise<CallToolResult> {
  const expanded = expandRecipeInvocation(recipes, args);
  if (isToolErrorResult(expanded)) return expanded;

  switch (expanded.recipe.mode) {
    case "call":
      return handleCall(upstream, cache, expanded.args, context);
    case "parallel":
      return handleParallel(upstream, cache, expanded.args, maxConcurrency, context);
    case "batch":
      return handleBatch(upstream, cache, expanded.args, maxConcurrency, context);
    case "pipeline":
      return handlePipeline(upstream, cache, expanded.args, context);
  }
}

export async function handleRecipeDryRun(
  upstream: UpstreamManager,
  cache: CallCache,
  recipes: Record<string, RecipeConfig> | undefined,
  args: unknown,
  context?: ToolCallContext
): Promise<CallToolResult> {
  const expanded = expandRecipeInvocation(recipes, args);
  if (isToolErrorResult(expanded)) return expanded;

  const result = await handleDryRun(upstream, cache, expanded.args, context);
  if (result.isError || !isRecord(result.structuredContent)) return result;

  return jsonResult({
    recipe: expanded.recipeName,
    ...result.structuredContent,
  });
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
  args: unknown,
  listenerDiagnostics?: ListenerRuntimeDiagnostics,
  recipes?: Record<string, RecipeConfig>,
  responseStore?: ResponseStore
): CallToolResult {
  const parsed = isRecord(args) ? args : {};
  const serverFilter = typeof parsed.server === "string" ? parsed.server : undefined;
  const includeDescriptions = parsed.descriptions === true;
  const includeRecommendations = parsed.recommendations !== false;
  const includeSessions = parsed.sessions === true;
  const descriptionMaxLength =
    typeof parsed.descriptionMaxLength === "number" && parsed.descriptionMaxLength > 0
      ? parsed.descriptionMaxLength
      : defaultDescriptionMaxLength && defaultDescriptionMaxLength > 0
        ? defaultDescriptionMaxLength
        : undefined;

  const serverNames = upstream.getServerNames();
  const failedServers = upstream.getFailedServers();
  const maybeToolSuite = upstream as UpstreamManager & {
    getToolSuiteStats?: () => { generation: number; lastChangeAt?: string };
  };
  const toolSuite = typeof maybeToolSuite.getToolSuiteStats === "function"
    ? maybeToolSuite.getToolSuiteStats()
    : { generation: 0 };

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
        if (info.error) base.error = info.error;
        if (info.lastError) base.lastError = info.lastError;
        if (info.lastConnectedAt) base.lastConnectedAt = info.lastConnectedAt;
        if (info.lastFailureAt) base.lastFailureAt = info.lastFailureAt;
        if (info.consecutiveFailures !== undefined) base.consecutiveFailures = info.consecutiveFailures;
        if (info.reconnectAttempts !== undefined) base.reconnectAttempts = info.reconnectAttempts;
        if (info.nextRetryAt) base.nextRetryAt = info.nextRetryAt;
        if (info.toolSuiteGeneration !== undefined) base.toolSuiteGeneration = info.toolSuiteGeneration;
        if (info.lastToolSuiteChangeAt) base.lastToolSuiteChangeAt = info.lastToolSuiteChangeAt;
        if (info.addedTools) base.addedTools = info.addedTools;
        if (info.removedTools) base.removedTools = info.removedTools;
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
          state: info.state,
          connectDurationMs: info.connectDurationMs,
          ...(info.lastError ? { lastError: info.lastError } : {}),
          ...(info.lastConnectedAt ? { lastConnectedAt: info.lastConnectedAt } : {}),
          ...(info.lastFailureAt ? { lastFailureAt: info.lastFailureAt } : {}),
          ...(info.consecutiveFailures !== undefined ? { consecutiveFailures: info.consecutiveFailures } : {}),
          ...(info.reconnectAttempts !== undefined ? { reconnectAttempts: info.reconnectAttempts } : {}),
          ...(info.nextRetryAt ? { nextRetryAt: info.nextRetryAt } : {}),
          ...(info.toolSuiteGeneration !== undefined ? { toolSuiteGeneration: info.toolSuiteGeneration } : {}),
          ...(info.lastToolSuiteChangeAt ? { lastToolSuiteChangeAt: info.lastToolSuiteChangeAt } : {}),
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
  const unhealthyServers = servers.filter((server) => server.state && server.state !== "connected");

  const recommendations: Array<{ when: string; use: string; note: string }> = [];
  const recipeSummaries = Object.entries(recipes ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, recipe]) => ({
      name,
      mode: recipe.mode,
      ...(recipe.description ? { description: recipe.description } : {}),
    }));

  if (metaOnly) {
    recommendations.push({
      when: "Find the right downstream tool by task or keyword",
      use: "callmux_search_tools",
      note: "Search tool names, descriptions, servers, and input field hints.",
    });
    recommendations.push({
      when: "Single downstream call in meta-only mode",
      use: "callmux_call",
      note: "Call one proxied tool by name with optional server hint.",
    });
  }
  recommendations.push(
    {
      when: "A response includes _callmux.ref",
      use: "callmux_get_result",
      note: "Page through the full stored result with optional search and field projection.",
    },
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
  if (recipeSummaries.length > 0) {
    recommendations.push({
      when: "Repeat a configured multi-call workflow",
      use: "callmux_recipe_run",
      note: "Invoke named config recipes with runtime arguments.",
    });
  }
  if (wrappedServers.length > 1 && !serverFilter) {
    recommendations.push({
      when: "Avoid ambiguity across multiple wrapped servers",
      use: "server hint or qualified tool names",
      note: "Set server in meta-calls or use names like github__get_issue.",
    });
  }

  return jsonResult({
    status: failedServers.length > 0 || unhealthyServers.length > 0 ? "degraded" : "ok",
    mode: metaOnly ? "meta-only" : "standard",
    ...(instanceIdentity.namespace ? { namespace: instanceIdentity.namespace } : {}),
    instanceId: instanceIdentity.instanceId,
    wrappedServers,
    servers,
    failedServers: failed,
    toolSuiteGeneration: toolSuite.generation,
    ...(toolSuite.lastChangeAt ? { lastToolSuiteChangeAt: toolSuite.lastChangeAt } : {}),
    totalTools: servers.reduce((sum, s) => sum + (s.toolCount as number), 0),
    cache: cache.stats(),
    ...(responseStore ? { responseStore: responseStore.stats() } : {}),
    maxConcurrency,
    ...(recipeSummaries.length > 0
      ? { recipes: recipeSummaries, recipeCount: recipeSummaries.length }
      : {}),
    ...(includeSessions && listenerDiagnostics ? { listener: listenerDiagnostics } : {}),
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
