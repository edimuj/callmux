import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamManager } from "./upstream.js";
import type { CallCache } from "./cache.js";
import type {
  ParallelCall,
  ParallelResult,
  BatchItem,
  BatchResult,
  PipelineStep,
  PipelineResult,
} from "./types.js";

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
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

export async function handleParallel(
  upstream: UpstreamManager,
  cache: CallCache,
  args: { calls: ParallelCall[] },
  maxConcurrency: number
): Promise<CallToolResult> {
  const startTime = Date.now();
  const { calls } = args;

  const semaphore = new Semaphore(maxConcurrency);

  const promises = calls.map(async (call) => {
    await semaphore.acquire();
    const callStart = Date.now();
    try {
      const cached = cache.get(call.tool, call.arguments);
      if (cached) {
        return { call, result: cached, durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(call.tool, call.arguments, call.server);
      cache.set(call.tool, call.arguments, result);
      return { call, result, durationMs: Date.now() - callStart };
    } catch (err) {
      return {
        call,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - callStart,
      };
    } finally {
      semaphore.release();
    }
  });

  const results = await Promise.all(promises);
  const output: ParallelResult = {
    results,
    totalDurationMs: Date.now() - startTime,
  };

  return textResult(JSON.stringify(output, null, 2));
}

export async function handleBatch(
  upstream: UpstreamManager,
  cache: CallCache,
  args: { server?: string; tool: string; items: BatchItem[] },
  maxConcurrency: number
): Promise<CallToolResult> {
  const startTime = Date.now();
  const { server, tool, items } = args;

  const semaphore = new Semaphore(maxConcurrency);
  let succeeded = 0;
  let failed = 0;

  const promises = items.map(async (item, index) => {
    await semaphore.acquire();
    const callStart = Date.now();
    try {
      const cached = cache.get(tool, item.arguments);
      if (cached) {
        succeeded++;
        return { index, result: cached, durationMs: Date.now() - callStart };
      }

      const result = await upstream.callTool(tool, item.arguments, server);
      cache.set(tool, item.arguments, result);
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

  return textResult(JSON.stringify(output, null, 2));
}

export async function handlePipeline(
  upstream: UpstreamManager,
  cache: CallCache,
  args: { steps: PipelineStep[] }
): Promise<CallToolResult> {
  const startTime = Date.now();
  const { steps } = args;
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
      const result = await upstream.callTool(step.tool, mergedArgs, step.server);
      const durationMs = Date.now() - callStart;
      stepResults.push({ step: i, tool: step.tool, result, durationMs });

      if (result.isError) {
        const output: PipelineResult = {
          steps: stepResults,
          totalDurationMs: Date.now() - startTime,
        };
        return textResult(JSON.stringify(output, null, 2));
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
      return textResult(JSON.stringify(output, null, 2));
    }
  }

  const output: PipelineResult = {
    steps: stepResults,
    finalResult: stepResults[stepResults.length - 1]?.result,
    totalDurationMs: Date.now() - startTime,
  };

  return textResult(JSON.stringify(output, null, 2));
}

export function handleCacheClear(
  cache: CallCache,
  args: { tool?: string }
): CallToolResult {
  const before = cache.size;
  cache.invalidate(args.tool);
  const cleared = before - cache.size;
  return textResult(
    args.tool
      ? `Cleared ${cleared} cached entries for "${args.tool}"`
      : `Cleared all ${before} cached entries`
  );
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
