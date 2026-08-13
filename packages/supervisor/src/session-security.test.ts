import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateLocalCredential,
  ensurePrivateRuntimeDirectory,
  loadOrCreateLocalCredential,
} from "./local-security.js";
import { PortalSessionSecurity } from "./session-security.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local supervisor security", () => {
  it("creates and reuses an exact private credential", () => {
    const root = temporaryRoot();
    const runtime = join(root, "runtime");
    const random = sequentialRandom();
    ensurePrivateRuntimeDirectory(runtime);
    const first = loadOrCreateLocalCredential(runtime, random);
    const second = loadOrCreateLocalCredential(runtime, random);

    expect(second).toEqual(first);
    expect(readFileSync(join(runtime, "credential"), "ascii")).toBe(first.token);
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    expect(statSync(join(runtime, "credential")).mode & 0o777).toBe(0o600);
    expect(authenticateLocalCredential(`Bearer ${first.token}`, first)).toBe(true);
    expect(authenticateLocalCredential(`Bearer ${"A".repeat(43)}`, first)).toBe(false);
  });

  it("refuses a symbolic-link runtime path component", () => {
    const root = temporaryRoot();
    const privateDirectory = join(root, "private");
    ensurePrivateRuntimeDirectory(privateDirectory);
    symlinkSync(privateDirectory, join(root, "linked"));
    expect(() => ensurePrivateRuntimeDirectory(join(root, "linked"))).toThrow("symbolic links");
  });
});

describe("portal session security", () => {
  it("consumes a bootstrap once and delivers one CSRF token for the resulting session", () => {
    let now = 1_000;
    const sessions = new PortalSessionSecurity({
      clock: { now: () => now },
      random: sequentialRandom(),
    });
    const bootstrap = sessions.createBootstrap();
    const session = sessions.consumeBootstrap(bootstrap.token);
    expect(session).toBeDefined();
    expect(sessions.consumeBootstrap(bootstrap.token)).toBeUndefined();
    expect(sessions.validateSession(session?.token)).toBe(true);
    const csrf = sessions.issueCsrf(session?.token ?? "");
    expect(csrf).toBeDefined();
    expect(sessions.issueCsrf(session?.token ?? "")).toBeUndefined();
    expect(sessions.validateCsrf(session?.token ?? "", csrf)).toBe(true);
    expect(sessions.validateCsrf(session?.token ?? "", "A".repeat(43))).toBe(false);

    now += 8 * 60 * 60 * 1_000;
    expect(sessions.validateSession(session?.token)).toBe(false);
  });

  it("expires an unused bootstrap within the configured sixty-second ceiling", () => {
    let now = 5_000;
    const sessions = new PortalSessionSecurity({
      clock: { now: () => now },
      random: sequentialRandom(),
      bootstrapLifetimeMs: 60_000,
    });
    const bootstrap = sessions.createBootstrap();
    now = bootstrap.expiresAt;
    expect(sessions.consumeBootstrap(bootstrap.token)).toBeUndefined();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "senawa-local-security-"));
  roots.push(root);
  return root;
}

function sequentialRandom(): { bytes(length: number): Uint8Array } {
  let seed = 0;
  return {
    bytes(length) {
      seed += 1;
      return Uint8Array.from({ length }, (_, index) => (seed + index) % 256);
    },
  };
}
