import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import type {
  AbuseControlsConfig,
  AuditLogConfig,
  AuthConfig,
  AuthorizationConfig,
  AuthorizationRuleConfig,
  BearerAuthTokenConfig,
  CachePolicyConfig,
  CallmuxConfig,
  ConfigFormat,
  MetricsConfig,
  DashboardConfig,
  ManagementConfig,
  ReconnectPolicyConfig,
  RecipeConfig,
  RecipeMode,
  ResponseShieldConfig,
  SchemaCompressionConfig,
  ServerConfig,
} from "./types.js";
import { hashBearerToken, parseScryptTokenHash } from "./auth.js";
import { isValidCidrOrIp } from "./abuse.js";
import { isOutputFormat } from "./output-format.js";

const SUPPORTED_OIDC_JWT_ALGORITHMS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);

function parseNonNegativeInteger(value: unknown, optionName: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }

  return value as number;
}

function parsePositiveInteger(value: unknown, optionName: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }

  return value as number;
}

function parseIntegerOption(
  value: string,
  optionName: string,
  allowZero: boolean
): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${optionName} must be ${allowZero ? "a non-negative" : "a positive"} integer`
    );
  }

  const parsed = Number(value);
  return allowZero
    ? parseNonNegativeInteger(parsed, optionName)
    : parsePositiveInteger(parsed, optionName);
}

function readOptionValue(
  args: string[],
  index: number,
  optionsLimit: number,
  optionName: string
): string {
  if (index + 1 >= optionsLimit) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return args[index + 1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStringArray(
  value: unknown,
  optionName: string
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${optionName} must be an array of strings`);
  }
  return value;
}

function parseStringRecord(
  value: unknown,
  optionName: string
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object of string values`);
  }

  const entries = Object.entries(value);
  if (!entries.every(([, nested]) => typeof nested === "string")) {
    throw new Error(`${optionName} must be an object of string values`);
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function parseCachePolicy(
  value: unknown,
  optionName: string
): CachePolicyConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const allowTools = parseStringArray(
    value.allowTools,
    `${optionName}.allowTools`
  );
  const denyTools = parseStringArray(
    value.denyTools,
    `${optionName}.denyTools`
  );

  if (!allowTools && !denyTools) {
    return undefined;
  }

  return {
    ...(allowTools ? { allowTools } : {}),
    ...(denyTools ? { denyTools } : {}),
  };
}

function parseResponseShieldConfig(
  value: unknown,
  optionName: string,
  allowMaxStoredResults: boolean
): (ResponseShieldConfig & { maxStoredResults?: number }) | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const maxResultBytes = value.maxResultBytes !== undefined
    ? parsePositiveInteger(value.maxResultBytes, `${optionName}.maxResultBytes`)
    : undefined;
  const maxStringChars = value.maxStringChars !== undefined
    ? parsePositiveInteger(value.maxStringChars, `${optionName}.maxStringChars`)
    : undefined;
  const maxArrayItems = value.maxArrayItems !== undefined
    ? parsePositiveInteger(value.maxArrayItems, `${optionName}.maxArrayItems`)
    : undefined;
  const allowTools = parseStringArray(value.allowTools, `${optionName}.allowTools`);
  const denyTools = parseStringArray(value.denyTools, `${optionName}.denyTools`);
  const maxStoredResults = value.maxStoredResults !== undefined
    ? allowMaxStoredResults
      ? parsePositiveInteger(value.maxStoredResults, `${optionName}.maxStoredResults`)
      : (() => {
          throw new Error(`${optionName}.maxStoredResults is only supported in global responseShield`);
        })()
    : undefined;

  if (
    enabled === undefined &&
    maxResultBytes === undefined &&
    maxStringChars === undefined &&
    maxArrayItems === undefined &&
    !allowTools &&
    !denyTools &&
    maxStoredResults === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(maxResultBytes !== undefined ? { maxResultBytes } : {}),
    ...(maxStringChars !== undefined ? { maxStringChars } : {}),
    ...(maxArrayItems !== undefined ? { maxArrayItems } : {}),
    ...(allowTools ? { allowTools } : {}),
    ...(denyTools ? { denyTools } : {}),
    ...(maxStoredResults !== undefined ? { maxStoredResults } : {}),
  };
}

function parseSchemaCompressionConfig(
  value: unknown,
  optionName: string
): SchemaCompressionConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const mode = value.mode === undefined
    ? undefined
    : value.mode === "off" || value.mode === "balanced" || value.mode === "aggressive"
      ? value.mode
      : (() => {
          throw new Error(`${optionName}.mode must be "off", "balanced", or "aggressive"`);
        })();
  const maxDescriptionChars = value.maxDescriptionChars !== undefined
    ? parsePositiveInteger(value.maxDescriptionChars, `${optionName}.maxDescriptionChars`)
    : undefined;

  if (
    enabled === undefined &&
    mode === undefined &&
    maxDescriptionChars === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(maxDescriptionChars !== undefined ? { maxDescriptionChars } : {}),
  };
}

function parseBooleanOption(
  value: unknown,
  optionName: string
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${optionName} must be a boolean`);
  }
  return value;
}

function parseOutputFormat(value: unknown, optionName: string) {
  if (value === undefined) return undefined;
  if (isOutputFormat(value)) return value;
  throw new Error(`${optionName} must be "json", "toon", or "auto"`);
}

function parseAuthAllowUnauthenticatedHealth(
  value: unknown,
  optionName: string
): boolean | undefined {
  return parseBooleanOption(value, `${optionName}.allowUnauthenticatedHealth`);
}

async function resolveSecretRefValue(
  ref: unknown,
  optionName: string,
  configBaseDir?: string
): Promise<string> {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty string`);
  }

  if (ref.startsWith("env:")) {
    const envName = ref.slice(4).trim();
    if (envName.length === 0) {
      throw new Error(`${optionName} env reference must include a variable name`);
    }
    const value = process.env[envName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${optionName} references missing or empty environment variable "${envName}"`);
    }
    return value;
  }

  if (ref.startsWith("file:")) {
    const rawPath = ref.slice(5).trim();
    if (rawPath.length === 0) {
      throw new Error(`${optionName} file reference must include a path`);
    }
    const resolvedPath = configBaseDir
      ? resolve(configBaseDir, rawPath)
      : resolve(rawPath);
    let raw: string;
    try {
      raw = await readFile(resolvedPath, "utf-8");
    } catch (err) {
      throw new Error(
        `${optionName} could not read secret file "${resolvedPath}": ${(err as Error).message}`
      );
    }
    const value = raw.trim();
    if (value.length === 0) {
      throw new Error(`${optionName} resolved to an empty value from file "${resolvedPath}"`);
    }
    return value;
  }

  throw new Error(
    `${optionName} must use supported secret refs: env:<NAME> or file:<PATH>`
  );
}

function parseAuthorizationConfig(
  value: unknown,
  optionName: string
): AuthorizationConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  if (!Array.isArray(value.rules)) {
    throw new Error(`${optionName}.rules must be an array`);
  }
  if (value.rules.length === 0) {
    throw new Error(`${optionName}.rules must contain at least one rule`);
  }

  const defaultEffect =
    value.defaultEffect === undefined
      ? undefined
      : value.defaultEffect === "allow" || value.defaultEffect === "deny"
        ? value.defaultEffect
        : (() => {
            throw new Error(`${optionName}.defaultEffect must be "allow" or "deny"`);
          })();

  const rules = value.rules.map((rule, index): AuthorizationRuleConfig => {
    if (!isRecord(rule)) {
      throw new Error(`${optionName}.rules[${index}] must be an object`);
    }

    const id =
      rule.id === undefined
        ? undefined
        : typeof rule.id === "string" && rule.id.trim().length > 0
          ? rule.id
          : (() => {
              throw new Error(`${optionName}.rules[${index}].id must be a non-empty string`);
            })();

    const effect =
      rule.effect === "allow" || rule.effect === "deny"
        ? rule.effect
        : (() => {
            throw new Error(`${optionName}.rules[${index}].effect must be "allow" or "deny"`);
          })();

    const principals = parseStringArray(
      rule.principals,
      `${optionName}.rules[${index}].principals`
    );
    const tools = parseStringArray(
      rule.tools,
      `${optionName}.rules[${index}].tools`
    );

    return {
      ...(id ? { id } : {}),
      effect,
      ...(principals ? { principals } : {}),
      ...(tools ? { tools } : {}),
    };
  });

  return {
    ...(defaultEffect ? { defaultEffect } : {}),
    rules,
  };
}

function parseAbuseControlsConfig(
  value: unknown,
  optionName: string
): AbuseControlsConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const globalRequestsPerMinute =
    value.globalRequestsPerMinute === undefined
      ? undefined
      : parsePositiveInteger(
          value.globalRequestsPerMinute,
          `${optionName}.globalRequestsPerMinute`
        );
  const principalRequestsPerMinute =
    value.principalRequestsPerMinute === undefined
      ? undefined
      : parsePositiveInteger(
          value.principalRequestsPerMinute,
          `${optionName}.principalRequestsPerMinute`
        );
  const principalMaxInFlight =
    value.principalMaxInFlight === undefined
      ? undefined
      : parsePositiveInteger(
          value.principalMaxInFlight,
          `${optionName}.principalMaxInFlight`
        );
  const cidrAllowlist = parseStringArray(
    value.cidrAllowlist,
    `${optionName}.cidrAllowlist`
  );
  if (cidrAllowlist && !cidrAllowlist.every((entry) => isValidCidrOrIp(entry))) {
    throw new Error(
      `${optionName}.cidrAllowlist entries must be valid CIDR or IP values`
    );
  }

  if (
    globalRequestsPerMinute === undefined &&
    principalRequestsPerMinute === undefined &&
    principalMaxInFlight === undefined &&
    cidrAllowlist === undefined
  ) {
    return undefined;
  }

  return {
    ...(globalRequestsPerMinute !== undefined
      ? { globalRequestsPerMinute }
      : {}),
    ...(principalRequestsPerMinute !== undefined
      ? { principalRequestsPerMinute }
      : {}),
    ...(principalMaxInFlight !== undefined ? { principalMaxInFlight } : {}),
    ...(cidrAllowlist ? { cidrAllowlist } : {}),
  };
}

function parseAuditLogConfig(
  value: unknown,
  optionName: string
): AuditLogConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const includeRequestBody = parseBooleanOption(
    value.includeRequestBody,
    `${optionName}.includeRequestBody`
  );
  const maxPayloadChars =
    value.maxPayloadChars === undefined
      ? undefined
      : parseNonNegativeInteger(value.maxPayloadChars, `${optionName}.maxPayloadChars`);
  const redactKeys = parseStringArray(value.redactKeys, `${optionName}.redactKeys`);

  if (
    enabled === undefined &&
    includeRequestBody === undefined &&
    maxPayloadChars === undefined &&
    redactKeys === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(includeRequestBody !== undefined ? { includeRequestBody } : {}),
    ...(maxPayloadChars !== undefined ? { maxPayloadChars } : {}),
    ...(redactKeys ? { redactKeys } : {}),
  };
}

function parseMetricsConfig(
  value: unknown,
  optionName: string
): MetricsConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const allowUnauthenticated = parseBooleanOption(
    value.allowUnauthenticated,
    `${optionName}.allowUnauthenticated`
  );
  const path =
    value.path === undefined
      ? undefined
      : typeof value.path === "string" && value.path.trim().length > 0
        ? value.path.startsWith("/")
          ? value.path
          : `/${value.path}`
        : (() => {
            throw new Error(`${optionName}.path must be a non-empty string`);
          })();

  if (
    enabled === undefined &&
    allowUnauthenticated === undefined &&
    path === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(path ? { path } : {}),
    ...(allowUnauthenticated !== undefined ? { allowUnauthenticated } : {}),
  };
}

function parseDashboardConfig(
  value: unknown,
  optionName: string
): DashboardConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const path =
    value.path === undefined
      ? undefined
      : typeof value.path === "string" && value.path.trim().length > 0
        ? value.path.startsWith("/")
          ? value.path
          : `/${value.path}`
        : (() => {
            throw new Error(`${optionName}.path must be a non-empty string`);
          })();
  const maxEvents = value.maxEvents !== undefined
    ? parsePositiveInteger(value.maxEvents, `${optionName}.maxEvents`)
    : undefined;

  if (enabled === undefined && path === undefined && maxEvents === undefined) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(path ? { path } : {}),
    ...(maxEvents !== undefined ? { maxEvents } : {}),
  };
}

async function parseManagementConfig(
  value: unknown,
  optionName: string,
  configBaseDir?: string
): Promise<ManagementConfig | undefined> {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const enabled = parseBooleanOption(value.enabled, `${optionName}.enabled`);
  const path =
    value.path === undefined
      ? undefined
      : typeof value.path === "string" && value.path.trim().length > 0
        ? value.path.startsWith("/")
          ? value.path
          : `/${value.path}`
        : (() => {
            throw new Error(`${optionName}.path must be a non-empty string`);
          })();
  const statePath =
    value.statePath === undefined
      ? undefined
      : typeof value.statePath === "string" && value.statePath.trim().length > 0
        ? value.statePath
        : (() => {
            throw new Error(`${optionName}.statePath must be a non-empty string`);
          })();
  const allowUnauthenticatedRead = parseBooleanOption(
    value.allowUnauthenticatedRead,
    `${optionName}.allowUnauthenticatedRead`
  );
  const allowAuthenticatedRead = parseBooleanOption(
    value.allowAuthenticatedRead,
    `${optionName}.allowAuthenticatedRead`
  );
  const auth = await parseAuthConfig(value.auth, `${optionName}.auth`, configBaseDir);
  if (auth && auth.mode !== "bearer") {
    throw new Error(`${optionName}.auth only supports bearer mode`);
  }

  if (
    enabled === undefined &&
    path === undefined &&
    statePath === undefined &&
    allowUnauthenticatedRead === undefined &&
    allowAuthenticatedRead === undefined &&
    auth === undefined
  ) {
    return undefined;
  }

  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(path ? { path } : {}),
    ...(statePath ? { statePath } : {}),
    ...(auth ? { auth } : {}),
    ...(allowUnauthenticatedRead !== undefined ? { allowUnauthenticatedRead } : {}),
    ...(allowAuthenticatedRead !== undefined ? { allowAuthenticatedRead } : {}),
  };
}

function parseReconnectPolicyConfig(
  value: unknown,
  optionName: string
): ReconnectPolicyConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const initialDelayMs = value.initialDelayMs !== undefined
    ? parsePositiveInteger(value.initialDelayMs, `${optionName}.initialDelayMs`)
    : undefined;
  const maxDelayMs = value.maxDelayMs !== undefined
    ? parsePositiveInteger(value.maxDelayMs, `${optionName}.maxDelayMs`)
    : undefined;
  const jitterRatio = value.jitterRatio !== undefined
    ? (typeof value.jitterRatio === "number" && Number.isFinite(value.jitterRatio) && value.jitterRatio >= 0 && value.jitterRatio <= 1
      ? value.jitterRatio
      : (() => { throw new Error(`${optionName}.jitterRatio must be a number between 0 and 1`); })())
    : undefined;
  const maxAttempts = value.maxAttempts !== undefined
    ? (value.maxAttempts === null
      ? null
      : parsePositiveInteger(value.maxAttempts, `${optionName}.maxAttempts`))
    : undefined;
  const fastFailDuringBackoff = parseBooleanOption(
    value.fastFailDuringBackoff,
    `${optionName}.fastFailDuringBackoff`
  );

  if (
    initialDelayMs === undefined &&
    maxDelayMs === undefined &&
    jitterRatio === undefined &&
    maxAttempts === undefined &&
    fastFailDuringBackoff === undefined
  ) {
    return undefined;
  }

  return {
    ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
    ...(maxDelayMs !== undefined ? { maxDelayMs } : {}),
    ...(jitterRatio !== undefined ? { jitterRatio } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(fastFailDuringBackoff !== undefined ? { fastFailDuringBackoff } : {}),
  };
}

function parseNonEmptyString(value: unknown, optionName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${optionName} must be a non-empty string`);
  }
  return value;
}

function parseAbsoluteCwd(value: unknown, optionName: string): string {
  const cwd = parseNonEmptyString(value, optionName).trim();
  if (!isAbsolute(cwd)) {
    throw new Error(`${optionName} must be an absolute path`);
  }
  return cwd;
}

function parseArgumentsRecord(
  value: unknown,
  optionName: string
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }
  return value;
}

function parseRecipeMode(value: unknown, optionName: string): RecipeMode {
  if (
    value !== "call" &&
    value !== "parallel" &&
    value !== "batch" &&
    value !== "pipeline"
  ) {
    throw new Error(
      `${optionName} must be one of "call", "parallel", "batch", or "pipeline"`
    );
  }
  return value;
}

function parseRecipeConfig(
  value: unknown,
  optionName: string
): RecipeConfig {
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const description =
    value.description === undefined
      ? undefined
      : parseNonEmptyString(value.description, `${optionName}.description`);
  const mode = parseRecipeMode(value.mode, `${optionName}.mode`);
  const server =
    value.server === undefined
      ? undefined
      : parseNonEmptyString(value.server, `${optionName}.server`);
  const timeoutMs = value.timeoutMs === undefined
    ? undefined
    : parsePositiveInteger(value.timeoutMs, `${optionName}.timeoutMs`);
  const cwd = value.cwd === undefined
    ? undefined
    : parseAbsoluteCwd(value.cwd, `${optionName}.cwd`);

  if (mode === "call") {
    const tool = parseNonEmptyString(value.tool, `${optionName}.tool`);
    const args = parseArgumentsRecord(value.arguments, `${optionName}.arguments`);
    return {
      ...(description ? { description } : {}),
      mode,
      ...(server ? { server } : {}),
      tool,
      ...(args ? { arguments: args } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cwd ? { cwd } : {}),
    };
  }

  if (mode === "parallel") {
    if (!Array.isArray(value.calls)) {
      throw new Error(`${optionName}.calls must be an array`);
    }
    const calls = value.calls.map((call, index) => {
      if (!isRecord(call)) {
        throw new Error(`${optionName}.calls[${index}] must be an object`);
      }
      const tool = parseNonEmptyString(call.tool, `${optionName}.calls[${index}].tool`);
      const callServer =
        call.server === undefined
          ? undefined
          : parseNonEmptyString(call.server, `${optionName}.calls[${index}].server`);
      const args = parseArgumentsRecord(
        call.arguments,
        `${optionName}.calls[${index}].arguments`
      );
      const callTimeoutMs = call.timeoutMs === undefined
        ? undefined
        : parsePositiveInteger(
            call.timeoutMs,
            `${optionName}.calls[${index}].timeoutMs`
          );
      const callCwd = call.cwd === undefined
        ? undefined
        : parseAbsoluteCwd(call.cwd, `${optionName}.calls[${index}].cwd`);
      return {
        tool,
        ...(callServer ? { server: callServer } : {}),
        ...(args ? { arguments: args } : {}),
        ...((callTimeoutMs ?? timeoutMs) !== undefined
          ? { timeoutMs: callTimeoutMs ?? timeoutMs }
          : {}),
        ...((callCwd ?? cwd) !== undefined
          ? { cwd: callCwd ?? cwd }
          : {}),
      };
    });
    return {
      ...(description ? { description } : {}),
      mode,
      calls,
    };
  }

  if (mode === "batch") {
    const tool = parseNonEmptyString(value.tool, `${optionName}.tool`);
    if (!Array.isArray(value.items)) {
      throw new Error(`${optionName}.items must be an array`);
    }
    const items = value.items.map((item, index) => {
      if (!isRecord(item)) {
        throw new Error(`${optionName}.items[${index}] must be an object`);
      }
      const args = parseArgumentsRecord(
        item.arguments,
        `${optionName}.items[${index}].arguments`
      );
      if (!args) {
        throw new Error(`${optionName}.items[${index}].arguments must be an object`);
      }
      const itemTimeoutMs = item.timeoutMs === undefined
        ? undefined
        : parsePositiveInteger(
            item.timeoutMs,
            `${optionName}.items[${index}].timeoutMs`
          );
      const itemCwd = item.cwd === undefined
        ? undefined
        : parseAbsoluteCwd(item.cwd, `${optionName}.items[${index}].cwd`);
      return {
        arguments: args,
        ...(itemTimeoutMs !== undefined ? { timeoutMs: itemTimeoutMs } : {}),
        ...(itemCwd !== undefined ? { cwd: itemCwd } : {}),
      };
    });
    return {
      ...(description ? { description } : {}),
      mode,
      ...(server ? { server } : {}),
      tool,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      items,
    };
  }

  if (!Array.isArray(value.steps)) {
    throw new Error(`${optionName}.steps must be an array`);
  }
  if (value.steps.length === 0) {
    throw new Error(`${optionName}.steps must contain at least one step`);
  }
  const steps = value.steps.map((step, index) => {
    if (!isRecord(step)) {
      throw new Error(`${optionName}.steps[${index}] must be an object`);
    }
    const tool = parseNonEmptyString(step.tool, `${optionName}.steps[${index}].tool`);
    const stepServer =
      step.server === undefined
        ? undefined
        : parseNonEmptyString(step.server, `${optionName}.steps[${index}].server`);
    const args = parseArgumentsRecord(
      step.arguments,
      `${optionName}.steps[${index}].arguments`
    );
    const stepTimeoutMs = step.timeoutMs === undefined
      ? undefined
      : parsePositiveInteger(
          step.timeoutMs,
          `${optionName}.steps[${index}].timeoutMs`
        );
    const stepCwd = step.cwd === undefined
      ? undefined
      : parseAbsoluteCwd(step.cwd, `${optionName}.steps[${index}].cwd`);
    let inputMapping: Record<string, string> | undefined;
    if (step.inputMapping !== undefined) {
      if (!isRecord(step.inputMapping)) {
        throw new Error(`${optionName}.steps[${index}].inputMapping must be an object of string expressions`);
      }
      const entries = Object.entries(step.inputMapping);
      if (!entries.every(([, nested]) => typeof nested === "string")) {
        throw new Error(`${optionName}.steps[${index}].inputMapping must be an object of string expressions`);
      }
      inputMapping = Object.fromEntries(entries) as Record<string, string>;
    }
    let onMappingMissing: "continue" | "fail" | undefined;
    if (step.onMappingMissing !== undefined) {
      if (step.onMappingMissing !== "continue" && step.onMappingMissing !== "fail") {
        throw new Error(`${optionName}.steps[${index}].onMappingMissing must be "continue" or "fail"`);
      }
      onMappingMissing = step.onMappingMissing;
    }
    return {
      tool,
      ...(stepServer ? { server: stepServer } : {}),
      ...(args ? { arguments: args } : {}),
      ...((stepTimeoutMs ?? timeoutMs) !== undefined
        ? { timeoutMs: stepTimeoutMs ?? timeoutMs }
        : {}),
      ...((stepCwd ?? cwd) !== undefined
        ? { cwd: stepCwd ?? cwd }
        : {}),
      ...(inputMapping ? { inputMapping } : {}),
      ...(onMappingMissing ? { onMappingMissing } : {}),
    };
  });
  return {
    ...(description ? { description } : {}),
    mode,
    steps,
  };
}

function parseRecipesConfig(
  value: unknown,
  optionName: string
): Record<string, RecipeConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;

  return Object.fromEntries(
    entries.map(([name, recipe]) => {
      if (name.trim().length === 0) {
        throw new Error(`${optionName} recipe names must be non-empty strings`);
      }
      return [name, parseRecipeConfig(recipe, `${optionName}.${name}`)];
    })
  );
}

async function parseAuthConfig(
  value: unknown,
  optionName: string,
  configBaseDir?: string
): Promise<AuthConfig | undefined> {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  if (value.mode === "bearer") {
    if (!Array.isArray(value.tokens)) {
      throw new Error(`${optionName}.tokens must be an array`);
    }

    if (value.tokens.length === 0) {
      throw new Error(`${optionName}.tokens must contain at least one token`);
    }

    const tokens = await Promise.all(
      value.tokens.map(async (token, index): Promise<BearerAuthTokenConfig> => {
      if (!isRecord(token)) {
        throw new Error(`${optionName}.tokens[${index}] must be an object`);
      }
      if (typeof token.id !== "string" || token.id.trim().length === 0) {
        throw new Error(`${optionName}.tokens[${index}].id must be a non-empty string`);
      }

      const hasToken = token.token !== undefined;
      const hasHash = token.hash !== undefined;
      const hasTokenRef = token.tokenRef !== undefined;
      const hasHashRef = token.hashRef !== undefined;
      const configuredCount = Number(hasToken) + Number(hasHash) + Number(hasTokenRef) + Number(hasHashRef);
      if (configuredCount > 1) {
        throw new Error(
          `${optionName}.tokens[${index}] must include exactly one of "hash", "hashRef", "token", or "tokenRef"`
        );
      }
      if (configuredCount === 0) {
        throw new Error(
          `${optionName}.tokens[${index}] must include one of "hash", "hashRef", "token", or "tokenRef"`
        );
      }

      if (hasHash || hasHashRef) {
        const hashValue = hasHash
          ? token.hash
          : await resolveSecretRefValue(
              token.hashRef,
              `${optionName}.tokens[${index}].hashRef`,
              configBaseDir
            );
        if (typeof hashValue !== "string" || hashValue.length === 0) {
          throw new Error(
            `${optionName}.tokens[${index}].${hasHash ? "hash" : "hashRef"} must resolve to a non-empty string`
          );
        }
        if (!parseScryptTokenHash(hashValue)) {
          throw new Error(
            `${optionName}.tokens[${index}].${hasHash ? "hash" : "hashRef"} must be a valid scrypt hash`
          );
        }
        return {
          id: token.id,
          hash: hashValue,
        };
      }

      const plaintextToken = hasToken
        ? token.token
        : await resolveSecretRefValue(
            token.tokenRef,
            `${optionName}.tokens[${index}].tokenRef`,
            configBaseDir
          );
      if (typeof plaintextToken !== "string" || plaintextToken.length === 0) {
        throw new Error(
          `${optionName}.tokens[${index}].${hasToken ? "token" : "tokenRef"} must resolve to a non-empty string`
        );
      }
      if (hasToken) {
        return {
          id: token.id,
          token: plaintextToken,
        };
      }

      return {
        id: token.id,
        hash: hashBearerToken(plaintextToken),
      };
    })
    );

    const allowUnauthenticatedHealth = parseAuthAllowUnauthenticatedHealth(
      value.allowUnauthenticatedHealth,
      optionName
    );

    return {
      mode: "bearer",
      tokens,
      ...(allowUnauthenticatedHealth !== undefined
        ? { allowUnauthenticatedHealth }
        : {}),
    };
  }

  if (value.mode === "oidc_jwt") {
    if (typeof value.issuer !== "string" || value.issuer.trim().length === 0) {
      throw new Error(`${optionName}.issuer must be a non-empty string`);
    }
    if (typeof value.jwksUri !== "string" || value.jwksUri.trim().length === 0) {
      throw new Error(`${optionName}.jwksUri must be a non-empty string`);
    }
    let jwksProtocol: string;
    try {
      jwksProtocol = new URL(value.jwksUri).protocol;
    } catch {
      throw new Error(`${optionName}.jwksUri must be a valid URL`);
    }
    if (jwksProtocol !== "https:") {
      const allowInsecure =
        value.allowInsecureJwksUri === true ||
        new URL(value.jwksUri).hostname === "localhost" ||
        new URL(value.jwksUri).hostname === "127.0.0.1";
      if (!allowInsecure) {
        throw new Error(
          `${optionName}.jwksUri must use https:// (set "allowInsecureJwksUri": true to override for local/dev)`
        );
      }
    }

    const audience = (() => {
      if (typeof value.audience === "string" && value.audience.trim().length > 0) {
        return value.audience;
      }
      if (
        Array.isArray(value.audience) &&
        value.audience.length > 0 &&
        value.audience.every(
          (entry) => typeof entry === "string" && entry.trim().length > 0
        )
      ) {
        return value.audience as string[];
      }
      throw new Error(
        `${optionName}.audience must be a non-empty string or non-empty string array`
      );
    })();

    const algorithms = parseStringArray(value.algorithms, `${optionName}.algorithms`);
    if (
      algorithms &&
      !algorithms.every((algorithm) => SUPPORTED_OIDC_JWT_ALGORITHMS.has(algorithm))
    ) {
      throw new Error(
        `${optionName}.algorithms must contain only RS256, RS384, RS512, ES256, ES384, or ES512`
      );
    }
    const allowUnauthenticatedHealth = parseAuthAllowUnauthenticatedHealth(
      value.allowUnauthenticatedHealth,
      optionName
    );
    const clockSkewSeconds =
      value.clockSkewSeconds === undefined
        ? undefined
        : parseNonNegativeInteger(value.clockSkewSeconds, `${optionName}.clockSkewSeconds`);
    const jwksCacheTtlSeconds =
      value.jwksCacheTtlSeconds === undefined
        ? undefined
        : parseNonNegativeInteger(
            value.jwksCacheTtlSeconds,
            `${optionName}.jwksCacheTtlSeconds`
          );
    const jwksFetchTimeoutMs =
      value.jwksFetchTimeoutMs === undefined
        ? undefined
        : parsePositiveInteger(
            value.jwksFetchTimeoutMs,
            `${optionName}.jwksFetchTimeoutMs`
          );

    return {
      mode: "oidc_jwt",
      issuer: value.issuer,
      audience,
      jwksUri: value.jwksUri,
      ...(algorithms ? { algorithms } : {}),
      ...(clockSkewSeconds !== undefined ? { clockSkewSeconds } : {}),
      ...(jwksCacheTtlSeconds !== undefined ? { jwksCacheTtlSeconds } : {}),
      ...(jwksFetchTimeoutMs !== undefined ? { jwksFetchTimeoutMs } : {}),
      ...(allowUnauthenticatedHealth !== undefined
        ? { allowUnauthenticatedHealth }
        : {}),
    };
  }

  throw new Error(`${optionName}.mode must be "bearer" or "oidc_jwt"`);
}

function parseServerConfig(value: unknown, serverName: string): ServerConfig {
  if (!isRecord(value)) {
    throw new Error(`servers.${serverName} must be an object`);
  }

  const hasUrl = typeof value.url === "string" && value.url.length > 0;
  const hasCommand = typeof value.command === "string" && value.command.length > 0;

  if (!hasUrl && !hasCommand) {
    throw new Error(`servers.${serverName} must have either "command" (stdio) or "url" (http/sse)`);
  }

  if (hasUrl && hasCommand) {
    throw new Error(`servers.${serverName} cannot have both "command" and "url"`);
  }

  const tools = parseStringArray(value.tools, `servers.${serverName}.tools`);
  const cachePolicy = parseCachePolicy(
    value.cachePolicy,
    `servers.${serverName}.cachePolicy`
  );
  const responseShield = parseResponseShieldConfig(
    value.responseShield,
    `servers.${serverName}.responseShield`,
    false
  );
  const schemaCompression = parseSchemaCompressionConfig(
    value.schemaCompression,
    `servers.${serverName}.schemaCompression`
  );
  const maxConcurrency = value.maxConcurrency !== undefined
    ? parsePositiveInteger(value.maxConcurrency, `servers.${serverName}.maxConcurrency`)
    : undefined;
  const callTimeoutMs = value.callTimeoutMs !== undefined
    ? parsePositiveInteger(value.callTimeoutMs, `servers.${serverName}.callTimeoutMs`)
    : undefined;
  const requestBodyMaxBytes = value.requestBodyMaxBytes !== undefined
    ? parseNonNegativeInteger(
        value.requestBodyMaxBytes,
        `servers.${serverName}.requestBodyMaxBytes`
      )
    : undefined;
  const disabled = parseBooleanOption(value.disabled, `servers.${serverName}.disabled`);

  const shared = {
    ...(tools ? { tools } : {}),
    ...(cachePolicy ? { cachePolicy } : {}),
    ...(responseShield ? { responseShield } : {}),
    ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    ...(requestBodyMaxBytes !== undefined ? { requestBodyMaxBytes } : {}),
    ...(schemaCompression ? { schemaCompression } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };

  if (hasUrl) {
    const transport = value.transport === undefined
      ? undefined
      : (["streamable-http", "sse"].includes(value.transport as string)
        ? value.transport as "streamable-http" | "sse"
        : (() => { throw new Error(`servers.${serverName}.transport must be "streamable-http" or "sse"`); })());
    const headers = parseStringRecord(value.headers, `servers.${serverName}.headers`);

    return {
      url: value.url as string,
      ...(transport ? { transport } : {}),
      ...(headers ? { headers } : {}),
      ...shared,
    };
  }

  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new Error(`servers.${serverName}.args must be an array of strings`);
  }

  const args = parseStringArray(value.args, `servers.${serverName}.args`);
  const env = parseStringRecord(value.env, `servers.${serverName}.env`);
  const cwd =
    value.cwd === undefined
      ? undefined
      : typeof value.cwd === "string"
        ? value.cwd
        : (() => {
            throw new Error(`servers.${serverName}.cwd must be a string`);
          })();
  const cwdMode =
    value.cwdMode === undefined
      ? undefined
      : value.cwdMode === "global" || value.cwdMode === "session"
        ? value.cwdMode
        : (() => {
            throw new Error(`servers.${serverName}.cwdMode must be "global" or "session"`);
          })();

  return {
    command: value.command as string,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(cwd ? { cwd } : {}),
    ...(cwdMode ? { cwdMode } : {}),
    ...shared,
  };
}

function parseServers(
  value: unknown,
  optionName: string
): Record<string, ServerConfig> {
  if (!isRecord(value)) {
    throw new Error(`${optionName} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, config]) => [name, parseServerConfig(config, name)])
  );
}

async function parseConfigDocument(
  parsed: Record<string, unknown>,
  sourcePath?: string
): Promise<{
  config: CallmuxConfig;
  format: ConfigFormat;
}> {
  const configBaseDir = sourcePath ? dirname(resolve(sourcePath)) : undefined;
  const parseSharedFields = async () => {
    const cachePolicy = parseCachePolicy(parsed.cachePolicy, "cachePolicy");
    const responseShield = parseResponseShieldConfig(
      parsed.responseShield,
      "responseShield",
      true
    );
    const schemaCompression = parseSchemaCompressionConfig(
      parsed.schemaCompression,
      "schemaCompression"
    );
    const auth = await parseAuthConfig(parsed.auth, "auth", configBaseDir);
    const authorization = parseAuthorizationConfig(
      parsed.authorization,
      "authorization"
    );
    const abuseControls = parseAbuseControlsConfig(
      parsed.abuseControls,
      "abuseControls"
    );
    const auditLog = parseAuditLogConfig(parsed.auditLog, "auditLog");
    const metrics = parseMetricsConfig(parsed.metrics, "metrics");
    const dashboard = parseDashboardConfig(parsed.dashboard, "dashboard");
    const management = await parseManagementConfig(
      parsed.management,
      "management",
      configBaseDir
    );
    const reconnectPolicy = parseReconnectPolicyConfig(
      parsed.reconnectPolicy,
      "reconnectPolicy"
    );
    const recipes = parseRecipesConfig(parsed.recipes, "recipes");
    return {
      cacheTtlSeconds:
        parsed.cacheTtlSeconds === undefined
          ? 0
          : parseNonNegativeInteger(parsed.cacheTtlSeconds, "cacheTtlSeconds"),
      ...(cachePolicy ? { cachePolicy } : {}),
      ...(responseShield ? { responseShield } : {}),
      ...(schemaCompression ? { schemaCompression } : {}),
      maxConcurrency:
        parsed.maxConcurrency === undefined
          ? 20
          : parsePositiveInteger(parsed.maxConcurrency, "maxConcurrency"),
      ...(parsed.connectTimeoutMs !== undefined
        ? {
            connectTimeoutMs: parsePositiveInteger(
              parsed.connectTimeoutMs,
              "connectTimeoutMs"
            ),
          }
        : {}),
      ...(parsed.callTimeoutMs !== undefined
        ? {
            callTimeoutMs: parsePositiveInteger(
              parsed.callTimeoutMs,
              "callTimeoutMs"
            ),
          }
        : {}),
      ...(reconnectPolicy ? { reconnectPolicy } : {}),
      ...(parsed.sessionCwdIdleTtlSeconds !== undefined
        ? {
            sessionCwdIdleTtlSeconds: parseNonNegativeInteger(
              parsed.sessionCwdIdleTtlSeconds,
              "sessionCwdIdleTtlSeconds"
            ),
          }
        : {}),
      ...(parsed.strictStartup !== undefined
        ? {
            strictStartup:
              typeof parsed.strictStartup === "boolean"
                ? parsed.strictStartup
                : (() => { throw new Error("strictStartup must be a boolean"); })(),
          }
        : {}),
      ...(parsed.maxCacheEntries !== undefined
        ? {
            maxCacheEntries: parsePositiveInteger(
              parsed.maxCacheEntries,
              "maxCacheEntries"
            ),
          }
        : {}),
      ...(parsed.metaOnly !== undefined
        ? {
            metaOnly:
              typeof parsed.metaOnly === "boolean"
                ? parsed.metaOnly
                : (() => { throw new Error("metaOnly must be a boolean"); })(),
          }
        : {}),
      ...(parsed.descriptionMaxLength !== undefined
        ? {
            descriptionMaxLength: parsePositiveInteger(
              parsed.descriptionMaxLength,
              "descriptionMaxLength"
            ),
          }
        : {}),
      ...(parsed.outputFormat !== undefined
        ? {
            outputFormat: parseOutputFormat(
              parsed.outputFormat,
              "outputFormat"
            ),
          }
        : {}),
      ...(parsed.requestBodyMaxBytes !== undefined
        ? {
            requestBodyMaxBytes: parseNonNegativeInteger(
              parsed.requestBodyMaxBytes,
              "requestBodyMaxBytes"
            ),
          }
        : {}),
      ...(parsed.allowRequestBodyMaxOverride !== undefined
        ? {
            allowRequestBodyMaxOverride:
              typeof parsed.allowRequestBodyMaxOverride === "boolean"
                ? parsed.allowRequestBodyMaxOverride
                : (() => {
                    throw new Error("allowRequestBodyMaxOverride must be a boolean");
                  })(),
          }
        : {}),
      ...(auth ? { auth } : {}),
      ...(authorization ? { authorization } : {}),
      ...(abuseControls ? { abuseControls } : {}),
      ...(auditLog ? { auditLog } : {}),
      ...(metrics ? { metrics } : {}),
      ...(dashboard ? { dashboard } : {}),
      ...(management ? { management } : {}),
      ...(recipes ? { recipes } : {}),
      ...(parsed.allowInsecureRemoteListener !== undefined
        ? {
            allowInsecureRemoteListener:
              typeof parsed.allowInsecureRemoteListener === "boolean"
                ? parsed.allowInsecureRemoteListener
                : (() => {
                    throw new Error(
                      "allowInsecureRemoteListener must be a boolean"
                    );
                  })(),
          }
        : {}),
    };
  };

  const hasServers = parsed.servers && typeof parsed.servers === "object";
  const hasMcpServers = parsed.mcpServers && typeof parsed.mcpServers === "object";
  if (hasServers && hasMcpServers) {
    throw new Error(
      'Invalid config: specify either "servers" or "mcpServers", not both'
    );
  }

  if (hasServers) {
    const sharedFields = await parseSharedFields();
    return {
      config: {
        servers: parseServers(parsed.servers, "servers"),
        ...sharedFields,
      },
      format: "native",
    };
  }

  if (hasMcpServers) {
    const sharedFields = await parseSharedFields();
    return {
      config: {
        servers: parseServers(parsed.mcpServers, "mcpServers"),
        ...sharedFields,
      },
      format: "mcpCompatible",
    };
  }

  throw new Error(
    "Invalid config: expected { servers: {...} } or { mcpServers: {...} }"
  );
}

/**
 * Resolve the default config file path, checking in order:
 * 1. $CALLMUX_CONFIG env var
 * 2. ~/.config/callmux/config.json (cross-platform)
 *
 * Returns the path if the file exists, undefined otherwise.
 */
export async function findDefaultConfig(): Promise<string | undefined> {
  const candidates: string[] = [];

  if (process.env.CALLMUX_CONFIG) {
    candidates.push(resolve(process.env.CALLMUX_CONFIG));
  }

  candidates.push(getDefaultConfigPath());

  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {}
  }
  return undefined;
}

export function getDefaultConfigPath(): string {
  return join(homedir(), ".config", "callmux", "config.json");
}

/**
 * Load callmux config from a JSON file or inline MCP server definitions.
 *
 * Accepts two formats:
 *
 * 1. Full callmux config:
 * {
 *   "servers": { "github": { "command": "...", "args": [...] } },
 *   "cacheTtlSeconds": 60
 * }
 *
 * 2. MCP-compatible mcpServers format (from .mcp.json / Claude Code settings):
 * {
 *   "mcpServers": { "github": { "command": "...", "args": [...] } }
 * }
 */
export async function loadConfig(configPath: string): Promise<CallmuxConfig> {
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return (await parseConfigDocument(parsed, resolvedPath)).config;
}

export async function loadConfigWithMetadata(configPath: string): Promise<{
  config: CallmuxConfig;
  format: ConfigFormat;
}> {
  const resolvedPath = resolve(configPath);
  const raw = await readFile(resolvedPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return await parseConfigDocument(parsed, resolvedPath);
}

export async function loadManagedConfig(
  configPath: string
): Promise<CallmuxConfig | null> {
  const resolvedPath = resolve(configPath);

  try {
    const { config, format } = await loadConfigWithMetadata(resolvedPath);
    if (format === "mcpCompatible") {
      throw new Error(
        "Managed server commands require native callmux config with a top-level \"servers\" object"
      );
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export const CONFIG_SCHEMA_URL =
  "https://raw.githubusercontent.com/edimuj/callmux/main/schema.json";

export async function saveManagedConfig(
  configPath: string,
  config: CallmuxConfig
): Promise<void> {
  const resolvedPath = resolve(configPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const withSchema = { $schema: CONFIG_SCHEMA_URL, ...config };
  await writeFile(
    resolvedPath,
    `${JSON.stringify(withSchema, null, 2)}\n`,
    "utf-8"
  );
}

/**
 * Build config from CLI arguments for single-server mode.
 * callmux -- command arg1 arg2
 * callmux --url https://mcp.example.com/sse
 */
export function configFromArgs(args: string[]): CallmuxConfig {
  let cacheTtl = 0;
  let maxConcurrency = 20;
  let maxCacheEntries: number | undefined;
  let connectTimeoutMs: number | undefined;
  let callTimeoutMs: number | undefined;
  let strictStartup = false;
  let metaOnly = false;
  let descriptionMaxLength: number | undefined;
  let outputFormat: CallmuxConfig["outputFormat"];
  let requestBodyMaxBytes: number | undefined;
  let allowRequestBodyMaxOverride = false;
  let allowInsecureRemoteListener = false;
  let tools: string[] | undefined;
  let cacheAllowTools: string[] | undefined;
  let cacheDenyTools: string[] | undefined;
  let url: string | undefined;
  let transport: "streamable-http" | "sse" | undefined;
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};

  const dashDash = args.indexOf("--");
  const optionsLimit = dashDash === -1 ? args.length : dashDash;

  for (let i = 0; i < optionsLimit; i++) {
    if (args[i] === "--cache") {
      const raw = readOptionValue(args, i, optionsLimit, "--cache");
      cacheTtl = parseIntegerOption(raw, "--cache", true);
      i++;
    } else if (args[i] === "--concurrency") {
      const raw = readOptionValue(args, i, optionsLimit, "--concurrency");
      maxConcurrency = parseIntegerOption(raw, "--concurrency", false);
      i++;
    } else if (args[i] === "--cache-max-entries") {
      const raw = readOptionValue(args, i, optionsLimit, "--cache-max-entries");
      maxCacheEntries = parseIntegerOption(raw, "--cache-max-entries", false);
      i++;
    } else if (args[i] === "--connect-timeout") {
      const raw = readOptionValue(args, i, optionsLimit, "--connect-timeout");
      connectTimeoutMs = parseIntegerOption(raw, "--connect-timeout", false);
      i++;
    } else if (args[i] === "--call-timeout") {
      const raw = readOptionValue(args, i, optionsLimit, "--call-timeout");
      callTimeoutMs = parseIntegerOption(raw, "--call-timeout", false);
      i++;
    } else if (args[i] === "--tools") {
      tools = readOptionValue(args, i, optionsLimit, "--tools").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--cache-allow") {
      cacheAllowTools = readOptionValue(args, i, optionsLimit, "--cache-allow").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--cache-deny") {
      cacheDenyTools = readOptionValue(args, i, optionsLimit, "--cache-deny").split(",").map((t) => t.trim()).filter(Boolean);
      i++;
    } else if (args[i] === "--env") {
      const pair = readOptionValue(args, i, optionsLimit, "--env");
      i++;
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        throw new Error(`Invalid --env value "${pair}": must be KEY=VALUE`);
      }
      env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
    } else if (args[i] === "--meta-only") {
      metaOnly = true;
    } else if (args[i] === "--strict-startup") {
      strictStartup = true;
    } else if (args[i] === "--description-max-length") {
      const raw = readOptionValue(args, i, optionsLimit, "--description-max-length");
      descriptionMaxLength = parseIntegerOption(raw, "--description-max-length", false);
      i++;
    } else if (args[i] === "--output-format") {
      const raw = readOptionValue(args, i, optionsLimit, "--output-format");
      outputFormat = parseOutputFormat(raw, "--output-format");
      i++;
    } else if (args[i] === "--request-body-max-bytes") {
      const raw = readOptionValue(args, i, optionsLimit, "--request-body-max-bytes");
      requestBodyMaxBytes = parseIntegerOption(raw, "--request-body-max-bytes", true);
      i++;
    } else if (args[i] === "--allow-request-body-override") {
      allowRequestBodyMaxOverride = true;
    } else if (args[i] === "--allow-insecure-remote-listener") {
      allowInsecureRemoteListener = true;
    } else if (args[i] === "--url") {
      url = readOptionValue(args, i, optionsLimit, "--url");
      i++;
    } else if (args[i] === "--transport") {
      const t = readOptionValue(args, i, optionsLimit, "--transport");
      i++;
      if (t !== "streamable-http" && t !== "sse") {
        throw new Error(`--transport must be "streamable-http" or "sse"`);
      }
      transport = t;
    } else if (args[i] === "--header") {
      const pair = readOptionValue(args, i, optionsLimit, "--header");
      i++;
      const colonIdx = pair.indexOf(":");
      if (colonIdx === -1) {
        throw new Error(`Invalid --header value "${pair}": must be Name:Value`);
      }
      headers[pair.slice(0, colonIdx).trim()] = pair.slice(colonIdx + 1).trim();
    } else {
      throw new Error(`Unknown option "${args[i]}"`);
    }
  }

  const cachePolicy =
    cacheAllowTools?.length || cacheDenyTools?.length
      ? {
          ...(cacheAllowTools?.length ? { allowTools: cacheAllowTools } : {}),
          ...(cacheDenyTools?.length ? { denyTools: cacheDenyTools } : {}),
        }
      : undefined;

  if (url) {
    if (dashDash !== -1) {
      throw new Error("Cannot use both --url and -- command");
    }
    return {
      servers: {
        default: {
          url,
          ...(transport ? { transport } : {}),
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(tools ? { tools } : {}),
          ...(cachePolicy ? { cachePolicy } : {}),
        },
      },
      cacheTtlSeconds: cacheTtl,
      maxConcurrency,
      ...(maxCacheEntries !== undefined ? { maxCacheEntries } : {}),
      ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
      ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
      ...(strictStartup ? { strictStartup } : {}),
      ...(metaOnly ? { metaOnly } : {}),
      ...(descriptionMaxLength ? { descriptionMaxLength } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(requestBodyMaxBytes !== undefined ? { requestBodyMaxBytes } : {}),
      ...(allowRequestBodyMaxOverride ? { allowRequestBodyMaxOverride } : {}),
      ...(allowInsecureRemoteListener ? { allowInsecureRemoteListener } : {}),
    };
  }

  if (dashDash === -1 || dashDash === args.length - 1) {
    throw new Error("Usage: callmux [options] -- command [args...] OR callmux --url <url>");
  }

  const command = args[dashDash + 1];
  const commandArgs = args.slice(dashDash + 2);

  return {
    servers: {
      default: {
        command,
        args: commandArgs,
        tools,
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(cachePolicy ? { cachePolicy } : {}),
      },
    },
    cacheTtlSeconds: cacheTtl,
    maxConcurrency,
    ...(maxCacheEntries !== undefined ? { maxCacheEntries } : {}),
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
    ...(callTimeoutMs !== undefined ? { callTimeoutMs } : {}),
    ...(strictStartup ? { strictStartup } : {}),
    ...(metaOnly ? { metaOnly } : {}),
    ...(descriptionMaxLength ? { descriptionMaxLength } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(requestBodyMaxBytes !== undefined ? { requestBodyMaxBytes } : {}),
    ...(allowRequestBodyMaxOverride ? { allowRequestBodyMaxOverride } : {}),
    ...(allowInsecureRemoteListener ? { allowInsecureRemoteListener } : {}),
  };
}
