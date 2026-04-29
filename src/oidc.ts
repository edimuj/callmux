import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { OidcJwtAuthConfig } from "./types.js";
import type { AuthorizationPrincipal } from "./authorization.js";

const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const DEFAULT_JWKS_CACHE_TTL_SECONDS = 300;
const DEFAULT_JWKS_FETCH_TIMEOUT_MS = 5000;

const ALGORITHM_TO_VERIFY_HASH: Record<string, string> = {
  RS256: "RSA-SHA256",
  RS384: "RSA-SHA384",
  RS512: "RSA-SHA512",
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
};

interface ParsedJwt {
  signingInput: string;
  signature: Buffer;
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
}

interface CachedJwks {
  expiresAt: number;
  keysByKid: Map<string, Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeBase64UrlJson<T extends Record<string, unknown>>(
  value: string
): T | undefined {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf-8");
    const parsed = JSON.parse(decoded);
    return isRecord(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

function parseJwt(token: string): ParsedJwt | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = decodeBase64UrlJson(headerSegment);
  const payload = decodeBase64UrlJson(payloadSegment);
  if (!header || !payload) return undefined;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureSegment, "base64url");
  } catch {
    return undefined;
  }
  if (signature.length === 0) return undefined;

  return {
    signingInput: `${headerSegment}.${payloadSegment}`,
    signature,
    header,
    payload,
  };
}

function normalizeAudience(
  audience: string | string[]
): Set<string> {
  return new Set(Array.isArray(audience) ? audience : [audience]);
}

function payloadMatchesAudience(
  payloadAudience: unknown,
  acceptedAudiences: Set<string>
): boolean {
  if (typeof payloadAudience === "string") {
    return acceptedAudiences.has(payloadAudience);
  }

  if (!Array.isArray(payloadAudience)) return false;
  return payloadAudience.some(
    (aud) => typeof aud === "string" && acceptedAudiences.has(aud)
  );
}

function readNumericClaim(
  payload: Record<string, unknown>,
  claim: string
): number | undefined {
  const value = payload[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function isSupportedAlgorithm(algorithm: string): boolean {
  return ALGORITHM_TO_VERIFY_HASH[algorithm] !== undefined;
}

function jwtAllowedAlgorithms(config: OidcJwtAuthConfig): Set<string> {
  const configured = config.algorithms ?? ["RS256"];
  return new Set(configured);
}

function jwksCacheTtlMs(config: OidcJwtAuthConfig): number {
  const ttlSeconds = config.jwksCacheTtlSeconds ?? DEFAULT_JWKS_CACHE_TTL_SECONDS;
  return ttlSeconds * 1000;
}

function jwksFetchTimeoutMs(config: OidcJwtAuthConfig): number {
  return config.jwksFetchTimeoutMs ?? DEFAULT_JWKS_FETCH_TIMEOUT_MS;
}

function clockSkewSeconds(config: OidcJwtAuthConfig): number {
  return config.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
}

export class OidcJwtVerifier {
  private config: OidcJwtAuthConfig;
  private acceptedAudiences: Set<string>;
  private allowedAlgorithms: Set<string>;
  private cachedJwks: CachedJwks | undefined;
  private inflightFetch: Promise<CachedJwks | undefined> | undefined;

  constructor(config: OidcJwtAuthConfig) {
    this.config = config;
    this.acceptedAudiences = normalizeAudience(config.audience);
    this.allowedAlgorithms = jwtAllowedAlgorithms(config);
  }

  async verify(token: string): Promise<AuthorizationPrincipal | undefined> {
    const parsed = parseJwt(token);
    if (!parsed) return undefined;

    const algorithm =
      typeof parsed.header.alg === "string" ? parsed.header.alg : undefined;
    const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : undefined;
    if (!algorithm || !kid) return undefined;
    if (!this.allowedAlgorithms.has(algorithm)) return undefined;
    if (!isSupportedAlgorithm(algorithm)) return undefined;

    const principal = this.extractPrincipal(parsed.payload);
    if (!principal) {
      return undefined;
    }

    const jwk =
      (await this.getJwkByKid(kid, false)) ??
      (await this.getJwkByKid(kid, true));
    if (!jwk) return undefined;

    if (!verifyJwtSignature(parsed, algorithm, jwk)) {
      return undefined;
    }

    return principal;
  }

  private extractPrincipal(
    payload: Record<string, unknown>
  ): AuthorizationPrincipal | undefined {
    const skew = clockSkewSeconds(this.config);
    const nowSeconds = Date.now() / 1000;

    if (payload.iss !== this.config.issuer) return undefined;
    if (!payloadMatchesAudience(payload.aud, this.acceptedAudiences)) return undefined;

    const exp = readNumericClaim(payload, "exp");
    if (exp === undefined || nowSeconds > exp + skew) return undefined;

    const nbf = readNumericClaim(payload, "nbf");
    if (nbf !== undefined && nowSeconds + skew < nbf) return undefined;

    const subject = typeof payload.sub === "string" ? payload.sub : undefined;
    if (!subject || subject.length === 0) return undefined;

    return {
      kind: "oidc_jwt",
      id: subject,
      subject,
      scopes: extractScopes(payload.scope, payload.scopes),
      groups: extractGroups(payload.groups),
    };
  }

  private async getJwkByKid(
    kid: string,
    forceRefresh: boolean
  ): Promise<Record<string, unknown> | undefined> {
    const cache = await this.loadJwks(forceRefresh);
    if (!cache) return undefined;
    return cache.keysByKid.get(kid);
  }

  private async loadJwks(forceRefresh: boolean): Promise<CachedJwks | undefined> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedJwks &&
      this.cachedJwks.expiresAt > now
    ) {
      return this.cachedJwks;
    }

    if (this.inflightFetch && !forceRefresh) {
      return this.inflightFetch;
    }

    const fetchPromise = this.fetchJwks();
    if (!forceRefresh) {
      this.inflightFetch = fetchPromise;
    }

    try {
      const fetched = await fetchPromise;
      if (fetched) {
        this.cachedJwks = fetched;
      }
      return this.cachedJwks;
    } finally {
      if (!forceRefresh) {
        this.inflightFetch = undefined;
      }
    }
  }

  private async fetchJwks(): Promise<CachedJwks | undefined> {
    const timeoutMs = jwksFetchTimeoutMs(this.config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(this.config.jwksUri, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;

      const body = await response.json();
      if (!isRecord(body) || !Array.isArray(body.keys)) return undefined;

      const keysByKid = new Map<string, Record<string, unknown>>();
      for (const key of body.keys) {
        if (!isRecord(key)) continue;
        const kid = typeof key.kid === "string" ? key.kid : undefined;
        if (!kid) continue;
        if (key.use !== undefined && key.use !== "sig") continue;
        keysByKid.set(kid, key);
      }

      return {
        keysByKid,
        expiresAt: Date.now() + jwksCacheTtlMs(this.config),
      };
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractScopes(
  scopeClaim: unknown,
  scopesClaim: unknown
): string[] {
  if (typeof scopeClaim === "string") {
    return scopeClaim
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (Array.isArray(scopesClaim)) {
    return scopesClaim.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function extractGroups(groupsClaim: unknown): string[] {
  if (Array.isArray(groupsClaim)) {
    return groupsClaim.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof groupsClaim === "string" && groupsClaim.length > 0) {
    return [groupsClaim];
  }
  return [];
}

function verifyJwtSignature(
  parsed: ParsedJwt,
  algorithm: string,
  jwk: Record<string, unknown>
): boolean {
  const verifyAlgorithm = ALGORITHM_TO_VERIFY_HASH[algorithm];
  if (!verifyAlgorithm) return false;

  const jwkAlgorithm = typeof jwk.alg === "string" ? jwk.alg : undefined;
  if (jwkAlgorithm && jwkAlgorithm !== algorithm) {
    return false;
  }

  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    return verifySignature(
      verifyAlgorithm,
      Buffer.from(parsed.signingInput, "utf-8"),
      key,
      parsed.signature
    );
  } catch {
    return false;
  }
}
