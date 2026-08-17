import { timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { SupervisorRandom } from "./contracts.js";
import { ensurePrivateRuntimeDirectory, loadOrCreateLocalCredential } from "./local-security.js";

/** What a worker holding this credential is allowed to act on. */
export interface WorkerCredentialScope {
  readonly repositoryId: string;
  readonly runId: string;
  readonly dispatchId: string;
  readonly contextId: string;
  readonly principalId: string;
  readonly capabilities: readonly string[];
  readonly expiresAt: number;
  readonly maxSubmissions: number;
}

export interface MintWorkerCredentialInput extends WorkerCredentialScope {
  readonly runtimeDirectory: string;
  readonly random: SupervisorRandom;
}

export interface MintedWorkerCredential {
  readonly path: string;
  readonly scope: WorkerCredentialScope;
}

export type WorkerCredentialRefusal =
  | "unknown-credential"
  | "expired-credential"
  | "submission-budget-exhausted"
  | "capability-denied";

export interface WorkerCredentialResolution {
  readonly scope: WorkerCredentialScope;
}

export class WorkerCredentialError extends Error {
  readonly reason: WorkerCredentialRefusal;

  constructor(reason: WorkerCredentialRefusal, message: string) {
    super(message);
    this.name = "WorkerCredentialError";
    this.reason = reason;
  }
}

/**
 * Per-dispatch credentials for worker processes.
 *
 * A worker must never hold the operator credential, because that would let it
 * approve its own phase and make every gate decorative. This mints a separate
 * token whose authority is one dispatch and a fixed capability list, and which
 * can be withdrawn from a running process by unlinking its file.
 */
export class WorkerCredentialStore {
  readonly #byDigest = new Map<string, { scope: WorkerCredentialScope; used: number }>();
  readonly #paths = new Map<string, string>();
  readonly #sha256: { digest(bytes: Uint8Array): string };
  readonly #now: () => number;

  constructor(options: {
    readonly sha256: { digest(bytes: Uint8Array): string };
    readonly now: () => number;
  }) {
    this.#sha256 = options.sha256;
    this.#now = options.now;
  }

  /**
   * Writes a credential for one dispatch and records what it may do.
   *
   * The token travels as a file path rather than an environment value: an
   * environment variable cannot be withdrawn from a process that already read
   * it, propagates to every descendant, and a value in argv is world-readable.
   */
  mint(input: MintWorkerCredentialInput): MintedWorkerCredential {
    // Each level is created privately in turn: the shared helper does not make
    // parents, and a permissive intermediate directory would defeat the mode.
    const runtime = ensurePrivateRuntimeDirectory(input.runtimeDirectory);
    ensurePrivateRuntimeDirectory(resolve(runtime, "dispatches"));
    const directory = ensurePrivateRuntimeDirectory(
      resolve(runtime, "dispatches", input.dispatchId),
    );
    const credential = loadOrCreateLocalCredential(directory, input.random, "credential");
    const scope: WorkerCredentialScope = Object.freeze({
      repositoryId: input.repositoryId,
      runId: input.runId,
      dispatchId: input.dispatchId,
      contextId: input.contextId,
      principalId: input.principalId,
      capabilities: Object.freeze([...input.capabilities].sort()),
      expiresAt: input.expiresAt,
      maxSubmissions: input.maxSubmissions,
    });
    const path = resolve(directory, "credential");
    this.#byDigest.set(this.#digest(credential.token), { scope, used: 0 });
    this.#paths.set(input.dispatchId, path);
    return { path, scope };
  }

  /** Resolves a presented token to its dispatch, refusing anything unscoped. */
  resolve(token: string, capability: string): WorkerCredentialResolution {
    const record = this.#byDigest.get(this.#digest(token));
    if (record === undefined) {
      throw new WorkerCredentialError("unknown-credential", "Worker credential is not recognized");
    }
    if (this.#now() >= record.scope.expiresAt) {
      this.revoke(record.scope.dispatchId);
      throw new WorkerCredentialError("expired-credential", "Worker credential has expired");
    }
    if (record.used >= record.scope.maxSubmissions) {
      throw new WorkerCredentialError(
        "submission-budget-exhausted",
        "Worker credential has no submissions left",
      );
    }
    if (!record.scope.capabilities.includes(capability)) {
      throw new WorkerCredentialError(
        "capability-denied",
        `Worker credential does not carry ${capability}`,
      );
    }
    record.used += 1;
    return { scope: record.scope };
  }

  /** Withdraws a credential, including from a process that already read it. */
  revoke(dispatchId: string): void {
    for (const [digest, record] of this.#byDigest) {
      if (record.scope.dispatchId === dispatchId) this.#byDigest.delete(digest);
    }
    const path = this.#paths.get(dispatchId);
    if (path !== undefined) {
      rmSync(path, { force: true });
      this.#paths.delete(dispatchId);
    }
  }

  #digest(token: string): string {
    return this.#sha256.digest(new TextEncoder().encode(token));
  }
}

/** Compares two tokens without leaking their difference through timing. */
export function sameWorkerToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "ascii");
  const rightBytes = Buffer.from(right, "ascii");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
