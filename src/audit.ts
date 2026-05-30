import type { AuditLogConfig } from "./types.js";
import type { AuthorizationPrincipal } from "./authorization.js";

const DEFAULT_MAX_PAYLOAD_CHARS = 4096;
const SECRET_KEY_PATTERN =
  /(?:^|[-_])(token|secret|password|passwd|api[-_]?key|authorization|credential|auth|cookie)(?:$|[-_])/i;

interface HttpAuditEvent {
  event: "http_request";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  remoteIp?: string;
  principal?: {
    kind: string;
    id: string;
    subject?: string;
    scopes?: string[];
    groups?: string[];
  };
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfig(config: AuditLogConfig | undefined): Required<AuditLogConfig> {
  return {
    enabled: config?.enabled ?? false,
    includeRequestBody: config?.includeRequestBody ?? false,
    maxPayloadChars: config?.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS,
    redactKeys: config?.redactKeys ?? [],
  };
}

function shouldRedactKey(key: string, extraPatterns: RegExp[]): boolean {
  if (SECRET_KEY_PATTERN.test(key)) return true;
  return extraPatterns.some((pattern) => pattern.test(key));
}

function redactPayload(
  value: unknown,
  extraPatterns: RegExp[]
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactPayload(entry, extraPatterns));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (shouldRedactKey(key, extraPatterns)) {
        result[key] = "[redacted]";
      } else {
        result[key] = redactPayload(nested, extraPatterns);
      }
    }
    return result;
  }
  return value;
}

function truncatePayload(payload: unknown, maxChars: number): unknown {
  if (maxChars === 0) return undefined;
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length <= maxChars) return payload;
    return {
      truncated: true,
      preview: serialized.slice(0, maxChars),
    };
  } catch {
    return payload;
  }
}

export class AuditLogger {
  private config: Required<AuditLogConfig>;
  private redactPatterns: RegExp[];

  constructor(config: AuditLogConfig | undefined) {
    this.config = normalizeConfig(config);
    // Compile extra redact patterns once, not per key on every request.
    this.redactPatterns = this.config.redactKeys.map(
      (pattern) =>
        new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    );
  }

  writeRequestEvent(input: {
    requestId: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    remoteIp?: string;
    principal?: AuthorizationPrincipal;
    payload?: unknown;
  }): void {
    if (!this.config.enabled) return;

    const event: HttpAuditEvent = {
      event: "http_request",
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      status: input.status,
      durationMs: input.durationMs,
      ...(input.remoteIp ? { remoteIp: input.remoteIp } : {}),
      ...(input.principal
        ? {
            principal: {
              kind: input.principal.kind,
              id: input.principal.id,
              ...(input.principal.subject
                ? { subject: input.principal.subject }
                : {}),
              ...(input.principal.scopes.length > 0
                ? { scopes: input.principal.scopes }
                : {}),
              ...(input.principal.groups.length > 0
                ? { groups: input.principal.groups }
                : {}),
            },
          }
        : {}),
    };

    if (this.config.includeRequestBody && input.payload !== undefined) {
      const redacted = redactPayload(input.payload, this.redactPatterns);
      event.payload = truncatePayload(redacted, this.config.maxPayloadChars);
    }

    process.stderr.write(`${JSON.stringify(event)}\n`);
  }
}
