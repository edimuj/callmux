import {
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;
import type {
  BearerAuthConfig,
  BearerAuthTokenConfig,
  BearerAuthTokenPlaintextConfig,
} from "./types.js";
import type { AuthorizationPrincipal } from "./authorization.js";

const DEFAULT_SCRYPT_N = 16_384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_SCRYPT_KEY_LENGTH = 32;
const DEFAULT_SALT_BYTES = 16;
const SCRYPT_HASH_PREFIX = "scrypt";
const MAX_SCRYPT_N = 1_048_576;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

interface ParsedScryptTokenHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  derivedKey: Buffer;
}

function constantTimeBufferEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function deriveScryptKey(
  token: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLength: number
): Buffer {
  // Node rejects scrypt parameters when maxmem is too low.
  const maxmem = 256 * N * r + 1024 * 1024;
  return scryptSync(token, salt, keyLength, { N, r, p, maxmem });
}

async function deriveScryptKeyAsync(
  token: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
  keyLength: number
): Promise<Buffer> {
  // Run on the libuv threadpool so per-request verification doesn't block
  // the event loop (scrypt at N=16384 is ~50-100ms of CPU).
  const maxmem = 256 * N * r + 1024 * 1024;
  return scryptAsync(token, salt, keyLength, { N, r, p, maxmem });
}

export function parseScryptTokenHash(
  serializedHash: string
): ParsedScryptTokenHash | undefined {
  const parts = serializedHash.split("$");
  if (parts.length !== 6) return undefined;
  if (parts[0] !== SCRYPT_HASH_PREFIX) return undefined;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N <= 1) return undefined;
  if (!Number.isInteger(r) || r <= 0) return undefined;
  if (!Number.isInteger(p) || p <= 0) return undefined;
  if ((N & (N - 1)) !== 0) return undefined;
  if (N > MAX_SCRYPT_N || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) return undefined;

  let salt: Buffer;
  let derivedKey: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    derivedKey = Buffer.from(parts[5], "base64url");
  } catch {
    return undefined;
  }

  if (salt.length === 0 || derivedKey.length === 0) {
    return undefined;
  }

  return { N, r, p, salt, derivedKey };
}

export function hashBearerToken(token: string): string {
  if (token.length === 0) {
    throw new Error("token must be non-empty");
  }

  const salt = randomBytes(DEFAULT_SALT_BYTES);
  const derivedKey = deriveScryptKey(
    token,
    salt,
    DEFAULT_SCRYPT_N,
    DEFAULT_SCRYPT_R,
    DEFAULT_SCRYPT_P,
    DEFAULT_SCRYPT_KEY_LENGTH
  );

  return [
    SCRYPT_HASH_PREFIX,
    String(DEFAULT_SCRYPT_N),
    String(DEFAULT_SCRYPT_R),
    String(DEFAULT_SCRYPT_P),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

async function verifyBearerTokenHash(
  token: string,
  serializedHash: string
): Promise<boolean> {
  const parsed = parseScryptTokenHash(serializedHash);
  if (!parsed) return false;

  let candidateKey: Buffer;
  try {
    candidateKey = await deriveScryptKeyAsync(
      token,
      parsed.salt,
      parsed.N,
      parsed.r,
      parsed.p,
      parsed.derivedKey.length
    );
  } catch {
    return false;
  }

  return constantTimeBufferEquals(candidateKey, parsed.derivedKey);
}

export function isPlaintextBearerTokenConfig(
  token: BearerAuthTokenConfig
): token is BearerAuthTokenPlaintextConfig {
  return "token" in token;
}

async function verifyBearerToken(
  token: string,
  configuredToken: BearerAuthTokenConfig
): Promise<boolean> {
  if ("hash" in configuredToken) {
    return verifyBearerTokenHash(token, configuredToken.hash);
  }
  if (!("token" in configuredToken)) {
    return false;
  }

  const left = Buffer.from(token);
  const right = Buffer.from(configuredToken.token);
  return constantTimeBufferEquals(left, right);
}

export async function authenticateBearerToken(
  token: string,
  config: BearerAuthConfig
): Promise<AuthorizationPrincipal | undefined> {
  for (const candidate of config.tokens) {
    if (!(await verifyBearerToken(token, candidate))) {
      continue;
    }

    return {
      kind: "bearer",
      id: candidate.id,
      scopes: [],
      groups: [],
    };
  }

  return undefined;
}
