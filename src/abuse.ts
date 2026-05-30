import { isIP } from "node:net";
import type {
  AbuseControlsConfig,
} from "./types.js";
import type { AuthorizationPrincipal } from "./authorization.js";

const RATE_LIMIT_WINDOW_MS = 60_000;

interface ParsedCidr {
  version: 4 | 6;
  network: bigint;
  prefixBits: number;
}

interface RateState {
  windowStartMs: number;
  count: number;
}

interface AbuseLimitResult {
  allowed: boolean;
  code: string;
  reason: string;
  retryAfterSeconds?: number;
}

interface AbuseLease {
  release: () => void;
}

interface AcquireOptions {
  includeGlobalRate?: boolean;
  includePrincipalLimits?: boolean;
}

function normalizeIpAddress(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

function ipv4ToBigInt(ip: string): bigint | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return undefined;
    value = (value << 8n) + BigInt(octet);
  }
  return value;
}

function parseIpv6Hextets(ip: string): string[] | undefined {
  const zoneSeparator = ip.indexOf("%");
  const withoutZone = zoneSeparator >= 0 ? ip.slice(0, zoneSeparator) : ip;
  if (withoutZone.length === 0) return undefined;

  const split = withoutZone.split("::");
  if (split.length > 2) return undefined;

  const parseSide = (side: string): string[] => {
    if (side.length === 0) return [];
    return side.split(":");
  };

  const left = parseSide(split[0]);
  const right = split.length === 2 ? parseSide(split[1]) : [];

  const maybeExpandEmbeddedIpv4 = (parts: string[]): string[] | undefined => {
    if (parts.length === 0) return parts;
    const last = parts[parts.length - 1];
    if (!last.includes(".")) return parts;
    const ipv4 = ipv4ToBigInt(last);
    if (ipv4 === undefined) return undefined;
    const hi = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const lo = Number(ipv4 & 0xffffn).toString(16);
    return [...parts.slice(0, -1), hi, lo];
  };

  const normalizedLeft = maybeExpandEmbeddedIpv4(left);
  const normalizedRight = maybeExpandEmbeddedIpv4(right);
  if (!normalizedLeft || !normalizedRight) return undefined;

  let parts: string[] = [];
  if (split.length === 1) {
    parts = normalizedLeft;
    if (parts.length !== 8) return undefined;
  } else {
    const missing = 8 - (normalizedLeft.length + normalizedRight.length);
    if (missing < 1) return undefined;
    parts = [
      ...normalizedLeft,
      ...new Array(missing).fill("0"),
      ...normalizedRight,
    ];
  }

  if (parts.length !== 8) return undefined;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
  }
  return parts;
}

function ipv6ToBigInt(ip: string): bigint | undefined {
  const parts = parseIpv6Hextets(ip);
  if (!parts) return undefined;
  let value = 0n;
  for (const part of parts) {
    value = (value << 16n) + BigInt(parseInt(part, 16));
  }
  return value;
}

function parseIpToBigInt(ip: string): { version: 4 | 6; value: bigint } | undefined {
  const normalized = normalizeIpAddress(ip);
  const version = isIP(normalized);
  if (version === 4) {
    const value = ipv4ToBigInt(normalized);
    if (value === undefined) return undefined;
    return { version: 4, value };
  }
  if (version === 6) {
    const value = ipv6ToBigInt(normalized);
    if (value === undefined) return undefined;
    return { version: 6, value };
  }
  return undefined;
}

function prefixMask(bits: number, prefixBits: number): bigint {
  if (prefixBits <= 0) return 0n;
  if (prefixBits >= bits) return (1n << BigInt(bits)) - 1n;
  const hostBits = bits - prefixBits;
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(hostBits)) - 1n);
}

function parseCidr(value: string): ParsedCidr | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const slash = trimmed.indexOf("/");
  const address = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const parsedIp = parseIpToBigInt(address);
  if (!parsedIp) return undefined;

  const bits = parsedIp.version === 4 ? 32 : 128;
  const prefixBits = (() => {
    if (slash === -1) return bits;
    const raw = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(raw)) return -1;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > bits) return -1;
    return parsed;
  })();
  if (prefixBits < 0) return undefined;

  return {
    version: parsedIp.version,
    network: parsedIp.value & prefixMask(bits, prefixBits),
    prefixBits,
  };
}

function ipMatchesCidr(ip: string, cidr: ParsedCidr): boolean {
  const parsedIp = parseIpToBigInt(ip);
  if (!parsedIp || parsedIp.version !== cidr.version) return false;
  const bits = cidr.version === 4 ? 32 : 128;
  const mask = prefixMask(bits, cidr.prefixBits);
  return (parsedIp.value & mask) === cidr.network;
}

export function isValidCidrOrIp(value: string): boolean {
  return parseCidr(value) !== undefined;
}

function principalRateKey(principal: AuthorizationPrincipal | undefined): string {
  if (!principal) return "anonymous";
  return `${principal.kind}:${principal.id}`;
}

export class AbuseController {
  private config: AbuseControlsConfig;
  private globalRates = new Map<string, RateState>();
  private principalRates = new Map<string, RateState>();
  private principalInflight = new Map<string, number>();
  private allowlist: ParsedCidr[] | undefined;
  private acquireCount = 0;

  constructor(config: AbuseControlsConfig) {
    this.config = config;
    this.allowlist = config.cidrAllowlist?.map((entry) => parseCidr(entry))
      .filter((entry): entry is ParsedCidr => entry !== undefined);
  }

  isIpAllowed(remoteIp: string | undefined): boolean {
    if (!this.allowlist || this.allowlist.length === 0) return true;
    if (!remoteIp) return false;
    return this.allowlist.some((cidr) => ipMatchesCidr(remoteIp, cidr));
  }

  acquire(
    principal: AuthorizationPrincipal | undefined,
    options: AcquireOptions = {}
  ): { result: AbuseLimitResult; lease?: AbuseLease } {
    const now = Date.now();
    this.maybePrune(now);
    const principalKey = principalRateKey(principal);
    const includeGlobalRate = options.includeGlobalRate ?? true;
    const includePrincipalLimits = options.includePrincipalLimits ?? true;

    let globalConsumed = false;
    const globalLimit = this.config.globalRequestsPerMinute;
    if (includeGlobalRate && globalLimit && globalLimit > 0) {
      const result = this.consumeRate(
        this.globalRates,
        "global",
        globalLimit,
        now
      );
      if (!result.allowed) {
        return { result };
      }
      globalConsumed = true;
    }

    let principalConsumed = false;
    const principalLimit = this.config.principalRequestsPerMinute;
    if (includePrincipalLimits && principalLimit && principalLimit > 0) {
      const result = this.consumeRate(
        this.principalRates,
        principalKey,
        principalLimit,
        now
      );
      if (!result.allowed) {
        // The request never ran — give back the global slot so a single
        // principal hitting its own limit can't drain the global budget.
        if (globalConsumed) this.refundRate(this.globalRates, "global");
        return { result };
      }
      principalConsumed = true;
    }

    const inFlightLimit = this.config.principalMaxInFlight;
    if (includePrincipalLimits && inFlightLimit && inFlightLimit > 0) {
      const current = this.principalInflight.get(principalKey) ?? 0;
      if (current >= inFlightLimit) {
        // Rejected before running — return the consumed rate slots.
        if (globalConsumed) this.refundRate(this.globalRates, "global");
        if (principalConsumed) this.refundRate(this.principalRates, principalKey);
        return {
          result: {
            allowed: false,
            code: "abuse_principal_inflight_limit",
            reason: "Too many concurrent in-flight requests for principal",
          },
        };
      }
      this.principalInflight.set(principalKey, current + 1);
      return {
        result: {
          allowed: true,
          code: "ok",
          reason: "Allowed",
        },
        lease: {
          release: () => {
            const active = this.principalInflight.get(principalKey) ?? 0;
            if (active <= 1) this.principalInflight.delete(principalKey);
            else this.principalInflight.set(principalKey, active - 1);
          },
        },
      };
    }

    return {
      result: {
        allowed: true,
        code: "ok",
        reason: "Allowed",
      },
    };
  }

  private consumeRate(
    rates: Map<string, RateState>,
    key: string,
    limit: number,
    nowMs: number
  ): AbuseLimitResult {
    const existing = rates.get(key);
    if (!existing || nowMs - existing.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
      rates.set(key, { windowStartMs: nowMs, count: 1 });
      return { allowed: true, code: "ok", reason: "Allowed" };
    }

    if (existing.count >= limit) {
      const retryAfterMs = RATE_LIMIT_WINDOW_MS - (nowMs - existing.windowStartMs);
      return {
        allowed: false,
        code: "abuse_rate_limit",
        reason: "Request rate exceeded configured limit",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    existing.count += 1;
    rates.set(key, existing);
    return { allowed: true, code: "ok", reason: "Allowed" };
  }

  private refundRate(rates: Map<string, RateState>, key: string): void {
    const existing = rates.get(key);
    if (existing && existing.count > 0) existing.count -= 1;
  }

  /**
   * Periodically drop rate-window entries that have fully expired, so a
   * stream of unique principal keys can't grow the maps without bound.
   * Runs every 1000 acquires — cheap, no timers to leak in tests/shutdown.
   */
  private maybePrune(nowMs: number): void {
    this.acquireCount += 1;
    if (this.acquireCount % 1000 !== 0) return;
    for (const [key, state] of this.globalRates) {
      if (nowMs - state.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
        this.globalRates.delete(key);
      }
    }
    for (const [key, state] of this.principalRates) {
      if (nowMs - state.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
        this.principalRates.delete(key);
      }
    }
  }
}
