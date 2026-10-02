import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCredentialError, WorkerCredentialStore } from "./worker-credential.js";

const roots = new Set<string>();
const sha256 = {
  digest(bytes: Uint8Array): string {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const random = { bytes: (length: number) => new Uint8Array(length).fill(3) };

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("worker credential", () => {
  it("mints a private per-dispatch credential a worker can read", () => {
    const { store, minted } = mint();
    const metadata = statSync(minted.path);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(readFileSync(minted.path, "ascii")).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(minted.scope.dispatchId).toBe("dispatch_one");
    store.revoke("dispatch_one");
  });

  it("permits a capability the dispatch carries and refuses one it does not", () => {
    const { store, minted, token } = mint();
    expect(store.resolve(token, "worker.submit.phase-output").scope.runId).toBe("run_one");
    expect(() => store.resolve(token, "worker.submit.amendment-proposal")).toThrowError(
      WorkerCredentialError,
    );
    expect(minted.scope.capabilities).not.toContain("worker.submit.amendment-proposal");
  });

  it("refuses a credential it never issued", () => {
    const { store } = mint();
    expect(() => store.resolve("not-a-real-token", "worker.submit.completion")).toThrowError(
      /not recognized/u,
    );
  });

  it("stops accepting a credential once its submission budget is spent", () => {
    const { store, token } = mint({ maxSubmissions: 2 });
    store.resolve(token, "worker.submit.completion");
    store.resolve(token, "worker.submit.completion");
    expect(() => store.resolve(token, "worker.submit.completion")).toThrowError(/no submissions/u);
  });

  it("stops accepting a credential after it expires", () => {
    let now = 1_000;
    const { store, token } = mint({ now: () => now, expiresAt: 2_000 });
    expect(store.resolve(token, "worker.submit.completion").scope.dispatchId).toBe("dispatch_one");
    now = 2_000;
    expect(() => store.resolve(token, "worker.submit.completion")).toThrowError(/expired/u);
  });

  it("withdraws a credential from a process that already read it", () => {
    const { store, minted, token } = mint();
    store.revoke("dispatch_one");
    // Unlinking is the point: an environment variable could not be taken back.
    expect(() => statSync(minted.path)).toThrow();
    expect(() => store.resolve(token, "worker.submit.completion")).toThrowError(/not recognized/u);
  });
});

function mint(
  overrides: {
    readonly maxSubmissions?: number;
    readonly expiresAt?: number;
    readonly now?: () => number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "senawa-worker-credential-"));
  roots.add(root);
  const store = new WorkerCredentialStore({
    sha256,
    now: overrides.now ?? (() => 0),
  });
  const minted = store.mint({
    runtimeDirectory: join(root, "runtime"),
    random,
    repositoryId: "repository_one",
    runId: "run_one",
    dispatchId: "dispatch_one",
    contextId: "context_one",
    principalId: "principal_one",
    capabilities: ["worker.submit.completion", "worker.submit.phase-output"],
    expiresAt: overrides.expiresAt ?? Number.MAX_SAFE_INTEGER,
    maxSubmissions: overrides.maxSubmissions ?? 8,
  });
  return { store, minted, token: readFileSync(minted.path, "ascii") };
}
