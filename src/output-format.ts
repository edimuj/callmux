import { encode } from "@toon-format/toon";

export type OutputFormat = "json" | "toon" | "auto";

interface ToolTextFormatOptions {
  format?: OutputFormat;
  autoMinJsonBytes?: number;
  autoMinSavingsRatio?: number;
  encoder?: (value: unknown) => string;
}

const OUTPUT_FORMATS = new Set<OutputFormat>(["json", "toon", "auto"]);
const AUTO_MIN_JSON_BYTES = 512;
const AUTO_MIN_SAVINGS_RATIO = 0.15;
const TABULAR_KEYS = new Set(["data", "items", "results", "nodes", "edges"]);

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && OUTPUT_FORMATS.has(value as OutputFormat);
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function formatToolText(
  value: unknown,
  options: ToolTextFormatOptions = {}
): string {
  const json = formatJson(value);
  const format = options.format ?? "json";
  if (format === "json") return json;

  if (format === "auto" && !shouldTryAutoToon(value, json, options)) {
    return json;
  }

  const toon = tryFormatToon(value, options);
  if (!toon) return json;

  if (format === "auto" && !meetsSavingsThreshold(toon, json, options)) {
    return json;
  }

  return toon;
}

function tryFormatToon(
  value: unknown,
  options: ToolTextFormatOptions
): string | null {
  try {
    return (options.encoder ?? encode)(value);
  } catch {
    return null;
  }
}

function shouldTryAutoToon(
  value: unknown,
  json: string,
  options: ToolTextFormatOptions
): boolean {
  const minBytes = options.autoMinJsonBytes ?? AUTO_MIN_JSON_BYTES;
  return Buffer.byteLength(json, "utf8") >= minBytes && hasTabularShape(value);
}

function meetsSavingsThreshold(
  toon: string,
  json: string,
  options: ToolTextFormatOptions
): boolean {
  const minSavingsRatio =
    options.autoMinSavingsRatio ?? AUTO_MIN_SAVINGS_RATIO;
  const jsonBytes = Buffer.byteLength(json, "utf8");
  const toonBytes = Buffer.byteLength(toon, "utf8");
  return toonBytes <= jsonBytes * (1 - minSavingsRatio);
}

function hasTabularShape(value: unknown, depth = 0): boolean {
  if (isUniformPrimitiveRecordArray(value)) return true;
  if (!isRecord(value) || depth >= 2) return false;

  return Object.entries(value).some(([key, child]) => {
    if (TABULAR_KEYS.has(key) && isUniformPrimitiveRecordArray(child)) {
      return true;
    }
    return hasTabularShape(child, depth + 1);
  });
}

function isUniformPrimitiveRecordArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every(isRecord)) return false;

  const keys = Object.keys(value[0]);
  if (keys.length === 0) return false;
  return value.every((item) => {
    const itemKeys = Object.keys(item);
    return (
      itemKeys.length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(item, key)) &&
      keys.every((key) => isPrimitiveOrPrimitiveArray(item[key]))
    );
  });
}

function isPrimitiveOrPrimitiveArray(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isJsonPrimitive);
  return isJsonPrimitive(value);
}

function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
