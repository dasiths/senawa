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
  | {
      readonly kind: "complete";
      readonly outputs: readonly { readonly name: string; readonly value: CanonicalValue }[];
      readonly evidence: readonly {
        readonly kind: string;
        readonly path: string;
        readonly content: string;
      }[];
      readonly summary?: string;
    }
  | { readonly kind: "phase-output"; readonly outputName: string; readonly value: CanonicalValue }
  | { readonly kind: "completion"; readonly summary: string; readonly evidence: CanonicalValue }
  | { readonly kind: "question"; readonly question: string }
  | { readonly kind: "escalation"; readonly reason: string };

export interface AcceptedWorkerSubmission {
  readonly submissionId: string;
  readonly scope: WorkerCredentialScope;
  readonly submission: WorkerSubmission;
}

/**
 * Resolves what a dispatch may read when this process did not register it.
 *
 * Dispatch happens in whichever process ran `start` or `advance`, and the
 * daemon serving this channel is a different process, so an in-memory
 * registration alone leaves every real agent talking to an empty map.
 */
export interface WorkerDispatchLookup {
  find(scope: WorkerCredentialScope): WorkerDispatchRecord | undefined;
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
  readonly #lookup: WorkerDispatchLookup | undefined;

  constructor(options: {
    readonly sink: WorkerSubmissionSink;
    readonly sha256: { digest(bytes: Uint8Array): string };
    readonly lookup?: WorkerDispatchLookup;
  }) {
    this.#sink = options.sink;
    this.#sha256 = options.sha256;
    this.#lookup = options.lookup;
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
    const record = this.#records.get(scope.dispatchId) ?? this.#lookup?.find(scope);
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
  if (kind === "complete") {
    const outputs = requiredArray(record, "outputs").map((entry) => {
      const output = asRecord(entry);
      return {
        name: requiredString(output, "name"),
        value: canonicalValue(requiredPresent(output, "value")),
      };
    });
    if (outputs.length === 0) {
      throw new WorkerApiError("invalid-submission", "A completion must carry at least one output");
    }
    const names = new Set(outputs.map(({ name }) => name));
    if (names.size !== outputs.length) {
      throw new WorkerApiError("invalid-submission", "A completion names the same output twice");
    }
    const summary = record.summary;
    return {
      kind,
      outputs,
      evidence: requiredArray(record, "evidence").map((entry) => {
        const item = asRecord(entry);
        return {
          kind: requiredString(item, "kind"),
          path: requiredString(item, "path"),
          content: requiredString(item, "content"),
        };
      }),
      ...(typeof summary === "string" && summary.length > 0 ? { summary } : {}),
    };
  }
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

function requiredArray(
  record: { readonly [key: string]: JsonValue },
  key: string,
): readonly JsonValue[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new WorkerApiError("invalid-submission", `Submission ${key} must be an array`);
  }
  return value;
}
