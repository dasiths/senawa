import { createHash, timingSafeEqual } from "node:crypto";
import type { SupervisorClock, SupervisorRandom } from "./contracts.js";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const MAX_PORTAL_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;
export const MAX_ACTIVE_PORTAL_SESSIONS = 1_024;

interface BootstrapRecord {
  readonly expiresAt: number;
  used: boolean;
}

interface SessionRecord {
  readonly expiresAt: number;
  csrfDigest?: Buffer;
}

export interface PortalBootstrapCapability {
  readonly token: string;
  readonly expiresAt: number;
}

export interface PortalSession {
  readonly token: string;
  readonly expiresAt: number;
}

export interface PortalSessionState {
  readonly expiresAt: number;
  readonly csrfMode: "available" | "read-only";
}

export interface PortalSessionSecurityOptions {
  readonly clock: SupervisorClock;
  readonly random: SupervisorRandom;
  readonly bootstrapLifetimeMs?: number;
  readonly sessionLifetimeMs?: number;
}

export class PortalSessionSecurity {
  readonly #clock: SupervisorClock;
  readonly #random: SupervisorRandom;
  readonly #bootstrapLifetimeMs: number;
  readonly #sessionLifetimeMs: number;
  readonly #bootstraps = new Map<string, BootstrapRecord>();
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(options: PortalSessionSecurityOptions) {
    this.#clock = options.clock;
    this.#random = options.random;
    this.#bootstrapLifetimeMs = options.bootstrapLifetimeMs ?? 60_000;
    this.#sessionLifetimeMs = options.sessionLifetimeMs ?? MAX_PORTAL_SESSION_LIFETIME_MS;
    if (this.#bootstrapLifetimeMs <= 0 || this.#bootstrapLifetimeMs > 60_000) {
      throw new TypeError("Portal bootstrap lifetime must be between 1 and 60000 milliseconds");
    }
    if (this.#sessionLifetimeMs <= 0 || this.#sessionLifetimeMs > MAX_PORTAL_SESSION_LIFETIME_MS) {
      throw new TypeError(
        `Portal session lifetime must be between 1 and ${MAX_PORTAL_SESSION_LIFETIME_MS} milliseconds`,
      );
    }
  }

  createBootstrap(): PortalBootstrapCapability {
    this.#purgeExpired();
    const token = this.#token();
    const expiresAt = this.#clock.now() + this.#bootstrapLifetimeMs;
    this.#bootstraps.set(digestKey(token), { expiresAt, used: false });
    return Object.freeze({ token, expiresAt });
  }

  consumeBootstrap(token: string): PortalSession | undefined {
    this.#purgeExpired();
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const key = digestKey(token);
    const record = this.#bootstraps.get(key);
    if (record === undefined || record.used || record.expiresAt <= this.#clock.now())
      return undefined;
    if (this.#sessions.size >= MAX_ACTIVE_PORTAL_SESSIONS) return undefined;
    record.used = true;
    const sessionToken = this.#token();
    const expiresAt = this.#clock.now() + this.#sessionLifetimeMs;
    this.#sessions.set(digestKey(sessionToken), { expiresAt });
    return Object.freeze({ token: sessionToken, expiresAt });
  }

  validateSession(token: string | undefined): boolean {
    return this.sessionExpiresAt(token) !== undefined;
  }

  sessionExpiresAt(token: string | undefined): number | undefined {
    this.#purgeExpired();
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const record = this.#sessions.get(digestKey(token));
    return record !== undefined && record.expiresAt > this.#clock.now()
      ? record.expiresAt
      : undefined;
  }

  sessionRemainingMs(token: string | undefined): number | undefined {
    const expiresAt = this.sessionExpiresAt(token);
    return expiresAt === undefined ? undefined : Math.max(0, expiresAt - this.#clock.now());
  }

  sessionState(token: string | undefined): PortalSessionState | undefined {
    this.#purgeExpired();
    if (token === undefined || !TOKEN_PATTERN.test(token)) return undefined;
    const record = this.#sessions.get(digestKey(token));
    if (record === undefined || record.expiresAt <= this.#clock.now()) return undefined;
    return Object.freeze({
      expiresAt: record.expiresAt,
      csrfMode: record.csrfDigest === undefined ? "available" : "read-only",
    });
  }

  issueCsrf(sessionToken: string): string | undefined {
    this.#purgeExpired();
    const record = TOKEN_PATTERN.test(sessionToken)
      ? this.#sessions.get(digestKey(sessionToken))
      : undefined;
    if (
      record === undefined ||
      record.expiresAt <= this.#clock.now() ||
      record.csrfDigest !== undefined
    ) {
      return undefined;
    }
    const csrf = this.#token();
    record.csrfDigest = digest(csrf);
    return csrf;
  }

  validateCsrf(sessionToken: string, csrf: string | undefined): boolean {
    this.#purgeExpired();
    if (!TOKEN_PATTERN.test(sessionToken) || csrf === undefined || !TOKEN_PATTERN.test(csrf)) {
      return false;
    }
    const expected = this.#sessions.get(digestKey(sessionToken))?.csrfDigest;
    if (expected === undefined) return false;
    return timingSafeEqual(expected, digest(csrf));
  }

  #token(): string {
    const bytes = this.#random.bytes(TOKEN_BYTES);
    if (bytes.length !== TOKEN_BYTES) throw new Error("Random source must return exactly 32 bytes");
    return Buffer.from(bytes).toString("base64url");
  }

  #purgeExpired(): void {
    const now = this.#clock.now();
    for (const [key, record] of this.#bootstraps) {
      if (record.expiresAt <= now) this.#bootstraps.delete(key);
    }
    for (const [key, record] of this.#sessions) {
      if (record.expiresAt <= now) this.#sessions.delete(key);
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(separator + 1).trim();
  }
  return found;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "ascii").digest();
}

function digestKey(value: string): string {
  return digest(value).toString("hex");
}
