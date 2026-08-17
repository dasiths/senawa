import { type CanonicalValue, canonicalDigest, canonicalValue } from "@senawa/kernel";
import type { JsonValue } from "@senawa/protocol";
import { type WorkerApi, WorkerApiError, type WorkerCredentialScope } from "@senawa/supervisor";

/** What a dispatched agent is allowed to read back about its own work. */
export interface WorkerDispatchRecord {
  readonly context: CanonicalValue;
  readonly outputSchema: CanonicalValue;
}

/** The kinds of submission the worker channel accepts, in canonical form. */
export type WorkerSubmission =
  | { readonly kind: "phase-output"; readonly outputName: string; readonly value: CanonicalValue }
  | { readonly kind: "completion"; readonly summary: string; readonly evidence: CanonicalValue }
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "escalation"; readonly reason: string };

export interface AcceptedWorkerSubmission {
  readonly submissionId: string;
  readonly scope: WorkerCredentialScope;
  readonly submission: WorkerSubmission;
}

/** Where accepted submissions go. The channel never decides anything itself. */
export interface WorkerSubmissionSink {
  accept(accepted: AcceptedWorkerSubmission): Promise<JsonValue>;
}

/**
 * The worker side of the local API.
 *
 * The agent gets exactly three verbs and no route to a human authority
 * operation, so a compromised or over-eager worker cannot approve its own
 * phase, mark a member done, steer, or end the run.
 */
export class SenawaWorkerApi implements WorkerApi {
  readonly #records = new Map<string, WorkerDispatchRecord>();
  readonly #sink: WorkerSubmissionSink;
  readonly #sha256: { digest(bytes: Uint8Array): string };

  constructor(options: {
    readonly sink: WorkerSubmissionSink;
    readonly sha256: { digest(bytes: Uint8Array): string };
  }) {
    this.#sink = options.sink;
    this.#sha256 = options.sha256;
  }

  /** Publishes what one dispatch may read. Called when the dispatch registers. */
  register(dispatchId: string, record: WorkerDispatchRecord): void {
    this.#records.set(dispatchId, record);
  }

  /** Drops a dispatch's readable state once its phase can no longer use it. */
  forget(dispatchId: string): void {
    this.#records.delete(dispatchId);
  }

  async context(scope: WorkerCredentialScope): Promise<JsonValue> {
    return await Promise.resolve(this.#required(scope).context as unknown as JsonValue);
  }

  async outputSchema(scope: WorkerCredentialScope): Promise<JsonValue> {
    return await Promise.resolve(this.#required(scope).outputSchema as unknown as JsonValue);
  }

  async submit(scope: WorkerCredentialScope, submission: JsonValue): Promise<JsonValue> {
    this.#required(scope);
    const parsed = parseWorkerSubmission(submission);
    // The idempotency key is a digest senawa computes over the canonical
    // submission, never a value the agent supplies, so a retry after a lost
    // response cannot be turned into a second distinct submission.
    const canonical = canonicalValue({
      dispatchId: scope.dispatchId,
      submission: parsed as unknown as JsonValue,
    });
    const submissionId = `submission_${canonicalDigest(canonical, this.#sha256)}`;
    return await this.#sink.accept({ submissionId, scope, submission: parsed });
  }

  #required(scope: WorkerCredentialScope): WorkerDispatchRecord {
    const record = this.#records.get(scope.dispatchId);
    if (record === undefined) {
      throw new WorkerApiError("unknown-dispatch", "Dispatch is not accepting worker traffic");
    }
    return record;
  }
}

/** Validates a submission's shape, refusing anything the channel does not offer. */
export function parseWorkerSubmission(submission: JsonValue): WorkerSubmission {
  const record = asRecord(submission);
  const kind = record.kind;
  if (kind === "phase-output") {
    return {
      kind,
      outputName: requiredString(record, "outputName"),
      value: canonicalValue(requiredPresent(record, "value")),
    };
  }
  if (kind === "completion") {
    return {
      kind,
      summary: requiredString(record, "summary"),
      evidence: canonicalValue(requiredPresent(record, "evidence")),
    };
  }
  if (kind === "question") return { kind, question: requiredString(record, "question") };
  if (kind === "escalation") return { kind, reason: requiredString(record, "reason") };
  throw new WorkerApiError("invalid-submission", "Submission kind is not offered");
}

function asRecord(value: JsonValue): { readonly [key: string]: JsonValue } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkerApiError("invalid-submission", "Submission must be a JSON object");
  }
  return value as { readonly [key: string]: JsonValue };
}

function requiredString(record: { readonly [key: string]: JsonValue }, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkerApiError("invalid-submission", `Submission ${key} must be a non-empty string`);
  }
  return value;
}

function requiredPresent(record: { readonly [key: string]: JsonValue }, key: string): JsonValue {
  const value = record[key];
  if (value === undefined) {
    throw new WorkerApiError("invalid-submission", `Submission ${key} is required`);
  }
  return value;
}
