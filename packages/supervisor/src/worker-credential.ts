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

/** One minted credential as it is kept between processes. */
export interface WorkerCredentialRecord {
  readonly scope: WorkerCredentialScope;
  readonly used: number;
  readonly path: string;
}

/**
 * Where minted credentials live.
 *
 * A credential is minted by whichever process dispatches and presented to
 * whichever process serves the agent channel, and those are not the same
 * process. Keeping the records behind a port lets the supervisor stay free of
 * storage while the daemon backs them with the same durable state as
 * everything else.
 */
export interface WorkerCredentialRecords {
  read(tokenDigest: string): WorkerCredentialRecord | undefined;
  write(tokenDigest: string, record: WorkerCredentialRecord): void;
  spend(tokenDigest: string): void;
  forget(dispatchId: string): readonly string[];
}

/** The default records, which live only as long as the process that mints. */
export class InMemoryWorkerCredentialRecords implements WorkerCredentialRecords {
  readonly #byDigest = new Map<string, WorkerCredentialRecord>();

  read(tokenDigest: string): WorkerCredentialRecord | undefined {
    return this.#byDigest.get(tokenDigest);
  }

  write(tokenDigest: string, record: WorkerCredentialRecord): void {
    this.#byDigest.set(tokenDigest, record);
  }

  spend(tokenDigest: string): void {
    const record = this.#byDigest.get(tokenDigest);
    if (record === undefined) return;
    this.#byDigest.set(tokenDigest, { ...record, used: record.used + 1 });
  }

  forget(dispatchId: string): readonly string[] {
    const paths: string[] = [];
    for (const [digest, record] of this.#byDigest) {
      if (record.scope.dispatchId !== dispatchId) continue;
      paths.push(record.path);
      this.#byDigest.delete(digest);
    }
    return paths;
  }
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
  readonly #records: WorkerCredentialRecords;
  readonly #sha256: { digest(bytes: Uint8Array): string };
  readonly #now: () => number;

  constructor(options: {
    readonly sha256: { digest(bytes: Uint8Array): string };
    readonly now: () => number;
    readonly records?: WorkerCredentialRecords;
  }) {
    this.#sha256 = options.sha256;
    this.#now = options.now;
    this.#records = options.records ?? new InMemoryWorkerCredentialRecords();
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
    this.#records.write(this.#digest(credential.token), { scope, used: 0, path });
    return { path, scope };
  }

  /**
   * Resolves a presented token without spending its submission budget.
   *
   * Authentication happens before the handler knows which operation was asked
   * for, so identity has to be separable from the act of submitting.
   */
  identify(token: string): WorkerCredentialScope | undefined {
    const record = this.#records.read(this.#digest(token));
    if (record === undefined) return undefined;
    if (this.#now() >= record.scope.expiresAt) {
      this.revoke(record.scope.dispatchId);
      return undefined;
    }
    return record.scope;
  }

  /** Resolves a presented token to its dispatch, refusing anything unscoped. */
  resolve(token: string, capability: string): WorkerCredentialResolution {
    const tokenDigest = this.#digest(token);
    const record = this.#records.read(tokenDigest);
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
    this.#records.spend(tokenDigest);
    return { scope: record.scope };
  }

  /** Withdraws a credential, including from a process that already read it. */
  revoke(dispatchId: string): void {
    for (const path of this.#records.forget(dispatchId)) {
      rmSync(path, { force: true });
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
