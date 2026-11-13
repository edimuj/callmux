import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonResult } from "./results.js";
import { retrievalCall } from "./response-store.js";
import type { OutputFormat } from "./output-format.js";

/**
 * Stores a full callmux result and returns its ref, or undefined when the
 * store declined it (for example over its size limits). The caller binds the
 * response owner, so handlers stay unaware of sessions.
 */
export type ResultRetainer = (tool: string, result: CallToolResult) => string | undefined;

export interface BriefLimits {
  /** Hard bound on the serialized brief CallToolResult. */
  maxResultBytes: number;
  maxStringChars: number;
  /** Most failure entries kept inline. */
  maxArrayItems: number;
}

/** Everything detail:"brief" needs: one retention and the response-shield limits. */
export interface BriefSink {
  retain: ResultRetainer;
  limits: BriefLimits;
}

/** Full batch/parallel output; `results[i]` is the call or item at index i. */
export interface FanOutPayload extends Record<string, unknown> {
  results: Array<Record<string, unknown>>;
  failedIndexes: number[];
  warnings?: Array<Record<string, unknown>>;
}

interface FailureEntry {
  index: number;
  tool?: string;
  code: string;
  message: string;
  chars: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinedText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  return value.content
    .filter((part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** code + uncapped message of one failed entry, without parsing large texts. */
function describeFailure(entry: Record<string, unknown>): { code: string; message: string } {
  if (typeof entry.error === "string") return { code: "call_failed", message: entry.error };
  const result = entry.result;
  const structuredError = isRecord(result) && isRecord(result.structuredContent)
    ? result.structuredContent.error
    : undefined;
  if (isRecord(structuredError) && typeof structuredError.code === "string") {
    return {
      code: structuredError.code,
      message: typeof structuredError.message === "string" ? structuredError.message : "",
    };
  }
  // Plain-text tool errors are unwrapped to { error, isError }.
  if (isRecord(result) && typeof result.error === "string") {
    return { code: "tool_error", message: result.error };
  }
  return { code: "tool_error", message: joinedText(result) };
}

function capChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let capped = value.slice(0, maxChars);
  // Never end on half of a surrogate pair.
  const last = capped.charCodeAt(capped.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) capped = capped.slice(0, -1);
  return capped;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * detail:"brief" for callmux_batch/callmux_parallel.
 *
 * Retains the full payload exactly once (so `full.ref` cannot be evicted by
 * this call), then builds an envelope whose serialized CallToolResult fits
 * `maxResultBytes`: complete failedIndexes and counts, plus compact entries for
 * the lowest-index failures. The envelope itself is never stored or shielded.
 * Only when the index list alone exceeds the bound does it stay larger.
 */
export function briefFanOutResult(
  tool: "callmux_batch" | "callmux_parallel",
  full: FanOutPayload,
  outputFormat: OutputFormat | undefined,
  sink: BriefSink
): CallToolResult {
  const { maxResultBytes, maxStringChars, maxArrayItems } = sink.limits;
  // structuredContent alone is what callmux_get_result pages; skip rendering text.
  const ref = sink.retain(tool, { content: [], structuredContent: full });

  const { results, warnings: fullWarnings, ...summary } = full;
  const failed = full.failedIndexes.length;
  const maxEntries = Math.max(0, Math.min(failed, maxArrayItems));
  // The payload appears twice in a result (structuredContent and text).
  const maxMessageChars = Math.max(
    0,
    Math.min(maxStringChars, Math.floor(maxResultBytes / (2 * Math.max(1, maxArrayItems))))
  );
  const entries: FailureEntry[] = full.failedIndexes.slice(0, maxEntries).map((index) => {
    const entry = results[index] ?? {};
    const { code, message } = describeFailure(entry);
    const call = entry.call;
    return {
      index,
      ...(tool === "callmux_parallel" && isRecord(call) && typeof call.tool === "string"
        ? { tool: call.tool }
        : {}),
      code,
      message: capChars(message, maxMessageChars),
      chars: message.length,
    };
  });

  const warnings = [
    ...(fullWarnings ?? []),
    ...(ref
      ? []
      : [{
          code: "full_result_not_retained",
          message:
            "The full result exceeded the result store limits and was not retained; successes are counted but not retrievable.",
        }]),
  ];
  const build = (keep: number): CallToolResult => jsonResult({
    ...summary,
    detail: "brief",
    failures: entries.slice(0, keep),
    ...(keep < failed ? { failuresOmitted: failed - keep } : {}),
    ...(ref
      ? { full: { ref, failurePath: "results.{index}", retrieval: retrievalCall(ref, "results") } }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }, { outputFormat });

  let keep = entries.length;
  let result = build(keep);
  let bytes = byteLength(result);
  while (bytes > maxResultBytes && keep > 0) {
    keep = Math.max(0, Math.min(keep - 1, Math.floor((keep * maxResultBytes) / bytes)));
    result = build(keep);
    bytes = byteLength(result);
  }
  return result;
}
