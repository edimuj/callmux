import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  CallmuxConfig,
  SchemaCompressionConfig,
  SchemaCompressionMode,
} from "./types.js";

const DEFAULT_MODE: SchemaCompressionMode = "balanced";
const DEFAULT_MAX_DESCRIPTION_CHARS = 160;
const AMBIGUOUS_FIELDS = new Set([
  "after",
  "anchor",
  "before",
  "cursor",
  "direction",
  "format",
  "market",
  "mode",
  "order",
  "outputFormat",
  "ref",
  "sha",
  "sort",
  "state_reason",
  "status",
  "transport",
  "type",
]);

interface EffectiveSchemaCompressionConfig {
  enabled: boolean;
  mode: SchemaCompressionMode;
  maxDescriptionChars: number;
}

export interface SchemaCompressionDiagnostics {
  enabled: boolean;
  mode: SchemaCompressionMode;
  maxDescriptionChars: number;
  tools: number;
  compressedTools: number;
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  savedPercent: number;
  servers?: Record<string, Omit<SchemaCompressionDiagnostics, "servers">>;
}

export function resolveSchemaCompressionConfig(
  globalConfig?: SchemaCompressionConfig,
  serverConfig?: SchemaCompressionConfig
): EffectiveSchemaCompressionConfig {
  const mode = serverConfig?.mode ?? globalConfig?.mode ?? DEFAULT_MODE;
  const enabled = mode !== "off" && (
    serverConfig?.enabled ?? globalConfig?.enabled ?? true
  );
  return {
    enabled,
    mode: enabled ? mode : "off",
    maxDescriptionChars:
      serverConfig?.maxDescriptionChars ??
      globalConfig?.maxDescriptionChars ??
      DEFAULT_MAX_DESCRIPTION_CHARS,
  };
}

export function compressToolForExposure(
  tool: Tool,
  globalConfig?: SchemaCompressionConfig,
  serverConfig?: SchemaCompressionConfig
): Tool {
  const effective = resolveSchemaCompressionConfig(globalConfig, serverConfig);
  if (!effective.enabled) return { ...tool };

  const compressed: Tool = { ...tool };
  const description = compressDescription(
    tool.description,
    tool.name,
    effective
  );
  if (description === undefined) {
    delete compressed.description;
  } else {
    compressed.description = description;
  }

  compressed.inputSchema = compressSchemaNode(
    tool.inputSchema,
    effective
  ) as Tool["inputSchema"];
  return compressed;
}

export function schemaCompressionDiagnostics(
  config: CallmuxConfig,
  tools: Array<{ server?: string; tool: Tool }>
): SchemaCompressionDiagnostics {
  const totals = createStats(
    resolveSchemaCompressionConfig(config.schemaCompression)
  );
  const byServer = new Map<string, SchemaCompressionDiagnostics>();

  for (const item of tools) {
    const serverConfig = item.server
      ? config.servers[item.server]?.schemaCompression
      : undefined;
    const effective = resolveSchemaCompressionConfig(
      config.schemaCompression,
      serverConfig
    );
    const compressed = compressToolForExposure(
      item.tool,
      config.schemaCompression,
      serverConfig
    );
    addToolStats(totals, item.tool, compressed, effective);

    if (item.server) {
      const existing = byServer.get(item.server) ?? createStats(effective);
      addToolStats(existing, item.tool, compressed, effective);
      byServer.set(item.server, existing);
    }
  }

  finalizeStats(totals);
  if (byServer.size > 0) {
    totals.servers = Object.fromEntries(
      Array.from(byServer.entries()).map(([server, stats]) => {
        finalizeStats(stats);
        return [server, stats];
      })
    );
  }
  return totals;
}

function createStats(
  effective: EffectiveSchemaCompressionConfig
): SchemaCompressionDiagnostics {
  return {
    enabled: effective.enabled,
    mode: effective.mode,
    maxDescriptionChars: effective.maxDescriptionChars,
    tools: 0,
    compressedTools: 0,
    originalBytes: 0,
    compressedBytes: 0,
    savedBytes: 0,
    savedPercent: 0,
  };
}

function addToolStats(
  stats: SchemaCompressionDiagnostics,
  original: Tool,
  compressed: Tool,
  effective: EffectiveSchemaCompressionConfig
): void {
  const originalBytes = Buffer.byteLength(JSON.stringify(original));
  const compressedBytes = Buffer.byteLength(JSON.stringify(compressed));
  stats.tools += 1;
  stats.originalBytes += originalBytes;
  stats.compressedBytes += compressedBytes;
  if (effective.enabled && compressedBytes < originalBytes) {
    stats.compressedTools += 1;
  }
}

function finalizeStats(stats: SchemaCompressionDiagnostics): void {
  stats.savedBytes = Math.max(0, stats.originalBytes - stats.compressedBytes);
  stats.savedPercent = stats.originalBytes === 0
    ? 0
    : Math.round((stats.savedBytes / stats.originalBytes) * 1000) / 10;
}

function compressSchemaNode(
  value: unknown,
  effective: EffectiveSchemaCompressionConfig,
  fieldName?: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compressSchemaNode(item, effective, fieldName));
  }
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "description" && typeof nested === "string") {
      const description = compressDescription(nested, fieldName, effective);
      if (description !== undefined) next.description = description;
      continue;
    }
    if (key === "properties" && isRecord(nested)) {
      next.properties = Object.fromEntries(
        Object.entries(nested).map(([property, schema]) => [
          property,
          compressSchemaNode(schema, effective, property),
        ])
      );
      continue;
    }
    next[key] = compressSchemaNode(nested, effective, fieldName);
  }
  return next;
}

function compressDescription(
  description: string | undefined,
  name: string | undefined,
  effective: EffectiveSchemaCompressionConfig
): string | undefined {
  if (!description) return undefined;
  const normalized = description.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;

  const ambiguous = name ? AMBIGUOUS_FIELDS.has(name) : false;
  if (effective.mode === "aggressive" && !ambiguous) return undefined;
  if (!ambiguous && isObviousDescription(normalized, name)) return undefined;
  return truncateDescription(normalized, effective.maxDescriptionChars);
}

function isObviousDescription(description: string, name: string | undefined): boolean {
  if (!name) return false;
  const desc = tokenize(description);
  if (desc.length === 0 || desc.length > 6) return false;
  const nameTokens = expandedNameTokens(name);
  return nameTokens.length > 0 && nameTokens.every((token) => desc.includes(token));
}

function expandedNameTokens(name: string): string[] {
  const tokens = tokenize(name);
  const aliases = new Map<string, string[]>([
    ["repo", ["repository"]],
    ["per", ["per"]],
    ["page", ["page", "pagination"]],
  ]);
  return tokens.flatMap((token) => aliases.get(token) ?? [token]);
}

function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function truncateDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) return description;
  if (maxChars <= 3) return description.slice(0, maxChars);
  return `${description.slice(0, maxChars - 3).trimEnd()}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
