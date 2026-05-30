import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, jsonResult } from "./results.js";
import type {
  CallmuxConfig,
  ResponseShieldConfig,
  ServerConfig,
} from "./types.js";
import { isOutputFormat, type OutputFormat } from "./output-format.js";

const DEFAULT_MAX_RESULT_BYTES = 64 * 1024;
const DEFAULT_MAX_STRING_CHARS = 8192;
const DEFAULT_MAX_ARRAY_ITEMS = 50;
const DEFAULT_MAX_STORED_RESULTS = 100;
const DEFAULT_RESULT_PAGE_LIMIT = 50;
const MAX_RESULT_PAGE_LIMIT = 100;
const MAX_SHAPE_KEYS = 20;
const MAX_SHAPE_PATHS = 8;
const MAX_SHAPE_DEPTH = 5;

interface StoredResponse {
  ref: string;
  tool: string;
  createdAt: number;
  byteSize: number;
  result: CallToolResult;
}

interface ResponseShieldOptions {
  enabled?: boolean;
  maxResultBytes?: number;
  maxStringChars?: number;
  maxArrayItems?: number;
  allowTools?: string[];
  denyTools?: string[];
  outputFormat?: OutputFormat;
}

export interface ResponseShieldTarget {
  tool: string;
  server?: string;
}

interface CompactResult {
  value: unknown;
  truncated: boolean;
}

interface ResultQueryArgs {
  ref: string;
  path?: string;
  offset?: number;
  limit?: number;
  fields?: string[];
  search?: string;
  outputFormat?: OutputFormat;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function escapeRegexCharacter(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegex(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, escapeRegexCharacter))
    .join(".*");
  return new RegExp(`^${source}$`);
}

function patternMatches(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  return patternToRegex(pattern).test(value);
}

function matchesPolicy(patterns: string[], candidates: string[]): boolean {
  return patterns.some((pattern) =>
    candidates.some((candidate) => patternMatches(pattern, candidate))
  );
}

function normalizeToolName(tool: string): string {
  // Use the LAST separator so a server name containing "__" still yields the
  // bare tool name — matches cache.ts so shield and cache policies agree.
  const separatorIndex = tool.lastIndexOf("__");
  return separatorIndex === -1 ? tool : tool.slice(separatorIndex + 2);
}

function shieldCandidates(target: ResponseShieldTarget): string[] {
  const candidates = new Set<string>();
  const normalized = normalizeToolName(target.tool);
  candidates.add(target.tool);
  candidates.add(normalized);
  if (target.server) {
    candidates.add(`${target.server}__${normalized}`);
  }
  return Array.from(candidates);
}

function mergeShieldConfig(
  globalConfig?: ResponseShieldConfig,
  serverConfig?: ResponseShieldConfig
): ResponseShieldOptions {
  return {
    enabled: serverConfig?.enabled ?? globalConfig?.enabled ?? true,
    maxResultBytes:
      serverConfig?.maxResultBytes ??
      globalConfig?.maxResultBytes ??
      DEFAULT_MAX_RESULT_BYTES,
    maxStringChars:
      serverConfig?.maxStringChars ??
      globalConfig?.maxStringChars ??
      DEFAULT_MAX_STRING_CHARS,
    maxArrayItems:
      serverConfig?.maxArrayItems ??
      globalConfig?.maxArrayItems ??
      DEFAULT_MAX_ARRAY_ITEMS,
    allowTools: [
      ...(globalConfig?.allowTools ?? []),
      ...(serverConfig?.allowTools ?? []),
    ],
    denyTools: [
      ...(globalConfig?.denyTools ?? []),
      ...(serverConfig?.denyTools ?? []),
    ],
  };
}

function serverResponseShieldConfig(
  serverConfig: ServerConfig | undefined
): ResponseShieldConfig | undefined {
  return serverConfig?.responseShield;
}

export function createResponseStore(config: CallmuxConfig): ResponseStore {
  return new ResponseStore(config.responseShield?.maxStoredResults);
}

export function resolveResponseShieldOptions(
  config: CallmuxConfig,
  target: ResponseShieldTarget
): ResponseShieldOptions {
  const serverConfig = target.server
    ? serverResponseShieldConfig(config.servers[target.server])
    : undefined;
  const merged = mergeShieldConfig(config.responseShield, serverConfig);

  if (merged.enabled === false) return { ...merged, enabled: false };

  const candidates = shieldCandidates(target);
  if (merged.denyTools && merged.denyTools.length > 0) {
    if (matchesPolicy(merged.denyTools, candidates)) {
      return { ...merged, enabled: false };
    }
  }

  if (merged.allowTools && merged.allowTools.length > 0) {
    if (!matchesPolicy(merged.allowTools, candidates)) {
      return { ...merged, enabled: false };
    }
  }

  return merged;
}

function compactValue(
  value: unknown,
  options: Required<Pick<ResponseShieldOptions, "maxResultBytes" | "maxStringChars" | "maxArrayItems">>
): CompactResult {
  if (typeof value === "string") {
    if (value.length <= options.maxStringChars) {
      return { value, truncated: false };
    }
    return {
      value:
        value.slice(0, options.maxStringChars) +
        `\n[...TRUNCATED: ${value.length - options.maxStringChars} more chars]`,
      truncated: true,
    };
  }

  if (Array.isArray(value)) {
    let truncated = false;
    const source =
      value.length > options.maxArrayItems
        ? value.slice(0, options.maxArrayItems)
        : value;
    if (source.length !== value.length) truncated = true;

    const items = source.map((item) => {
      const compacted = compactValue(item, options);
      if (compacted.truncated) truncated = true;
      return compacted.value;
    });

    if (source.length !== value.length) {
      items.push({
        _callmuxTruncated: true,
        totalItems: value.length,
        shownItems: source.length,
        remainingItems: value.length - source.length,
      });
    }

    return { value: items, truncated };
  }

  if (isRecord(value)) {
    let truncated = false;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const compacted = compactValue(child, options);
      if (compacted.truncated) truncated = true;
      result[key] = compacted.value;
    }
    return { value: result, truncated };
  }

  return { value, truncated: false };
}

function parseTextPayload(result: CallToolResult): unknown {
  const textItems = result.content.filter(
    (item): item is { type: "text"; text: string } => item.type === "text"
  );
  if (textItems.length === 1) {
    const text = textItems[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return result;
}

function dataFromResult(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  return parseTextPayload(result);
}

function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isRecord(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sampleKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).slice(0, MAX_SHAPE_KEYS);
  return keys.length > 0 ? keys : undefined;
}

function arrayShape(path: string, value: unknown[]): Record<string, unknown> {
  const first = value[0];
  const keys = sampleKeys(first);
  return {
    ...(path ? { path } : {}),
    type: "array",
    total: value.length,
    ...(keys ? { sampleKeys: keys } : {}),
  };
}

function collectArrayShapes(
  value: unknown,
  path: string,
  depth: number,
  result: Array<Record<string, unknown>>
): void {
  if (result.length >= MAX_SHAPE_PATHS || depth > MAX_SHAPE_DEPTH) return;

  if (Array.isArray(value)) {
    result.push(arrayShape(path, value));
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (result.length >= MAX_SHAPE_PATHS) return;
    const childPath = path ? `${path}.${key}` : key;
    if (Array.isArray(child)) {
      result.push(arrayShape(childPath, child));
    } else if (isRecord(child)) {
      collectArrayShapes(child, childPath, depth + 1, result);
    }
  }
}

function summarizeDataShape(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return {
      ...arrayShape("", data),
      paging: {
        offsetUnit: "items",
        defaultLimit: DEFAULT_RESULT_PAGE_LIMIT,
        maxLimit: MAX_RESULT_PAGE_LIMIT,
      },
    };
  }

  if (typeof data === "string") {
    return {
      type: "string",
      totalChars: data.length,
      paging: {
        offsetUnit: "characters",
        limitUnit: "about 200 characters per limit unit",
        defaultLimit: DEFAULT_RESULT_PAGE_LIMIT,
        maxLimit: MAX_RESULT_PAGE_LIMIT,
      },
    };
  }

  if (isRecord(data)) {
    const arrays: Array<Record<string, unknown>> = [];
    collectArrayShapes(data, "", 0, arrays);
    return {
      type: "object",
      keys: Object.keys(data).slice(0, MAX_SHAPE_KEYS),
      ...(arrays.length > 0 ? { arrays, suggestedPath: arrays[0].path } : {}),
      paging: {
        offsetUnit: arrays.length > 0 ? "items at selected path" : "single value",
        defaultLimit: DEFAULT_RESULT_PAGE_LIMIT,
        maxLimit: MAX_RESULT_PAGE_LIMIT,
      },
    };
  }

  return { type: data === null ? "null" : typeof data };
}

function retrievalHint(ref: string, shape: Record<string, unknown>): Record<string, unknown> {
  const suggestedPath =
    typeof shape.suggestedPath === "string" && shape.suggestedPath.length > 0
      ? shape.suggestedPath
      : undefined;
  return {
    tool: "callmux_get_result",
    arguments: {
      ref,
      ...(suggestedPath ? { path: suggestedPath } : {}),
      offset: 0,
      limit: DEFAULT_RESULT_PAGE_LIMIT,
    },
    viaCallmuxCall: {
      tool: "callmux_call",
      arguments: {
        tool: "callmux_get_result",
        arguments: {
          ref,
          ...(suggestedPath ? { path: suggestedPath } : {}),
          offset: 0,
          limit: DEFAULT_RESULT_PAGE_LIMIT,
        },
      },
    },
    supports: {
      path: "dot path inside the stored result, for example items or preview.items",
      offset: "array item offset, or character offset for string results",
      limit: `array item count, or about limit * 200 characters for strings; max ${MAX_RESULT_PAGE_LIMIT}`,
      fields: "optional field projection for arrays of objects",
      search: "optional case-insensitive filter before pagination",
    },
  };
}

function projectFields(item: unknown, fields: string[] | undefined): unknown {
  if (!fields || fields.length === 0 || !isRecord(item)) return item;
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in item) projected[field] = item[field];
  }
  return projected;
}

function validateResultQueryArgs(args: unknown): ResultQueryArgs | CallToolResult {
  if (!isRecord(args)) {
    return errorResult("invalid_arguments", '"ref" must be a non-empty string', {
      field: "ref",
    });
  }

  if (typeof args.ref !== "string" || args.ref.trim().length === 0) {
    return errorResult("invalid_arguments", '"ref" must be a non-empty string', {
      field: "ref",
    });
  }

  if (args.path !== undefined && typeof args.path !== "string") {
    return errorResult("invalid_arguments", "path must be a string", {
      field: "path",
    });
  }

  const validateNonNegativeInteger = (
    value: unknown,
    field: string
  ): number | undefined | CallToolResult => {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return errorResult("invalid_arguments", `${field} must be a non-negative integer`, {
        field,
      });
    }
    return value;
  };

  const offset = validateNonNegativeInteger(args.offset, "offset");
  if (offset !== undefined && typeof offset !== "number") return offset;

  const limit = validateNonNegativeInteger(args.limit, "limit");
  if (limit !== undefined && typeof limit !== "number") return limit;
  if (typeof limit === "number" && limit > MAX_RESULT_PAGE_LIMIT) {
    return errorResult(
      "invalid_arguments",
      `limit must be <= ${MAX_RESULT_PAGE_LIMIT}`,
      { field: "limit", max: MAX_RESULT_PAGE_LIMIT }
    );
  }

  if (
    args.fields !== undefined &&
    (
      !Array.isArray(args.fields) ||
      !args.fields.every((field) => typeof field === "string" && field.length > 0)
    )
  ) {
    return errorResult("invalid_arguments", "fields must be an array of strings", {
      field: "fields",
    });
  }

  if (args.search !== undefined && typeof args.search !== "string") {
    return errorResult("invalid_arguments", "search must be a string", {
      field: "search",
    });
  }
  if (args.outputFormat !== undefined && !isOutputFormat(args.outputFormat)) {
    return errorResult(
      "invalid_arguments",
      'outputFormat must be "json", "toon", or "auto"',
      { field: "outputFormat" }
    );
  }

  return {
    ref: args.ref,
    ...(typeof args.path === "string" ? { path: args.path } : {}),
    ...(typeof offset === "number" ? { offset } : {}),
    ...(typeof limit === "number" ? { limit } : {}),
    ...(Array.isArray(args.fields) ? { fields: args.fields } : {}),
    ...(typeof args.search === "string" ? { search: args.search } : {}),
    ...(isOutputFormat(args.outputFormat) ? { outputFormat: args.outputFormat } : {}),
  };
}

export class ResponseStore {
  private entries = new Map<string, StoredResponse>();
  private totalStored = 0;

  constructor(private maxEntries = DEFAULT_MAX_STORED_RESULTS) {}

  setMaxEntries(maxEntries = DEFAULT_MAX_STORED_RESULTS): void {
    this.maxEntries = maxEntries;
    this.evictOldest();
  }

  store(tool: string, result: CallToolResult): StoredResponse {
    const ref = `r_${randomUUID()}`;
    const entry: StoredResponse = {
      ref,
      tool,
      createdAt: Date.now(),
      byteSize: byteLength(result),
      result,
    };
    this.entries.set(ref, entry);
    this.totalStored++;
    this.evictOldest();
    return entry;
  }

  get(ref: string): StoredResponse | undefined {
    return this.entries.get(ref);
  }

  stats(): { entries: number; maxEntries: number; storedBytes: number; totalStored: number } {
    let storedBytes = 0;
    for (const entry of this.entries.values()) {
      storedBytes += entry.byteSize;
    }
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      storedBytes,
      totalStored: this.totalStored,
    };
  }

  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }

  query(args: unknown, defaultOutputFormat?: OutputFormat): CallToolResult {
    const parsed = validateResultQueryArgs(args);
    if (isCallToolResult(parsed)) return parsed;
    const outputFormat = parsed.outputFormat ?? defaultOutputFormat;

    const entry = this.entries.get(parsed.ref);
    if (!entry) {
      return errorResult("result_not_found", `result "${parsed.ref}" not found or expired`, {
        ref: parsed.ref,
      });
    }

    const data = valueAtPath(dataFromResult(entry.result), parsed.path);
    if (data === undefined) {
      return errorResult("result_path_not_found", "path not found in stored result", {
        ref: parsed.ref,
        path: parsed.path,
      });
    }

    const offset = parsed.offset ?? 0;
    const limit = parsed.limit ?? DEFAULT_RESULT_PAGE_LIMIT;

    if (Array.isArray(data)) {
      let items = data;
      if (parsed.search) {
        const needle = parsed.search.toLowerCase();
        items = items.filter((item) =>
          JSON.stringify(item).toLowerCase().includes(needle)
        );
      }
      const page = items
        .slice(offset, offset + limit)
        .map((item) => projectFields(item, parsed.fields));
      return jsonResult({
        ref: parsed.ref,
        tool: entry.tool,
        type: "array",
        total: items.length,
        offset,
        count: page.length,
        hasMore: offset + page.length < items.length,
        data: page,
      }, { outputFormat });
    }

    if (typeof data === "string") {
      const source = parsed.search
        ? data
          .split("\n")
          .filter((line) => line.toLowerCase().includes(parsed.search!.toLowerCase()))
          .join("\n")
        : data;
      const chunk = source.slice(offset, offset + limit * 200);
      return jsonResult({
        ref: parsed.ref,
        tool: entry.tool,
        type: "string",
        total: source.length,
        offset,
        count: chunk.length,
        hasMore: offset + chunk.length < source.length,
        data: chunk,
      }, { outputFormat });
    }

    return jsonResult({
      ref: parsed.ref,
      tool: entry.tool,
      type: Array.isArray(data) ? "array" : typeof data,
      total: 1,
      offset: 0,
      count: 1,
      hasMore: false,
      data: parsed.fields ? projectFields(data, parsed.fields) : data,
    }, { outputFormat });
  }
}

export function shieldToolResult(
  store: ResponseStore,
  target: string | ResponseShieldTarget,
  result: CallToolResult,
  options: ResponseShieldOptions = {}
): CallToolResult {
  if (result.isError) return result;
  if (options.enabled === false) return result;

  const shieldTarget = typeof target === "string" ? { tool: target } : target;

  const resolvedOptions: Required<Pick<ResponseShieldOptions, "maxResultBytes" | "maxStringChars" | "maxArrayItems">> = {
    maxResultBytes: options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    maxStringChars: options.maxStringChars ?? DEFAULT_MAX_STRING_CHARS,
    maxArrayItems: options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS,
  };

  const originalBytes = byteLength(result);
  const compacted = compactValue(result, resolvedOptions);
  const compactedBytes = byteLength(compacted.value);
  const shouldShield =
    compacted.truncated || originalBytes > resolvedOptions.maxResultBytes;

  if (!shouldShield) return result;

  const entry = store.store(shieldTarget.tool, result);
  const shape = summarizeDataShape(dataFromResult(result));
  const preview =
    compactedBytes <= resolvedOptions.maxResultBytes
      ? compacted.value
      : {
        content: [
          {
            type: "text",
            text: `[callmux truncated preview: original result was ${originalBytes} bytes]`,
          },
        ],
      };

  return jsonResult({
    _callmux: {
      truncated: true,
      ref: entry.ref,
      tool: shieldTarget.tool,
      ...(shieldTarget.server ? { server: shieldTarget.server } : {}),
      originalBytes,
      previewBytes: byteLength(preview),
      shape,
      retrieval: retrievalHint(entry.ref, shape),
      message:
        `Response was truncated. Use callmux_get_result with ref "${entry.ref}" to page through the full result. ` +
        `Use the _callmux.retrieval.arguments object for the first page; if that tool is deferred, call callmux_call with _callmux.retrieval.viaCallmuxCall.arguments.`,
    },
    preview,
  }, { outputFormat: options.outputFormat });
}
