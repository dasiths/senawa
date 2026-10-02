import type { JsonValue } from "@senawa/protocol";
import type { WorkerCredentialScope } from "./worker-credential.js";

/** What the worker channel offers, deliberately narrower than the operator API. */
export interface WorkerApi {
  /** The dispatch's prompt, inputs, and completion requirements. */
  context(scope: WorkerCredentialScope): Promise<JsonValue>;
  /** The schema the phase output must satisfy, so an agent need not guess. */
  outputSchema(scope: WorkerCredentialScope): Promise<JsonValue>;
  /** Phase output, a completion request, a question, or an escalation. */
  submit(scope: WorkerCredentialScope, submission: JsonValue): Promise<JsonValue>;
}

export type WorkerApiRefusal =
  | "unknown-dispatch"
  | "invalid-submission"
  | "submission-refused"
  | "unavailable";

export class WorkerApiError extends Error {
  readonly code: WorkerApiRefusal;

  constructor(code: WorkerApiRefusal, message: string) {
    super(message);
    this.name = "WorkerApiError";
    this.code = code;
  }
}

/**
 * The capability a submission of each kind consumes.
 *
 * Reads carry no capability, so a worker that crashed can re-read its context
 * without spending a submission it never used. Nothing here reaches a human
 * authority operation, which is the point of the separate channel.
 */
const SUBMISSION_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  // A complete request carries the outputs and asks for completion in one go,
  // so it spends the completion capability rather than a separate output one.
  complete: "worker.submit.completion",
  "phase-output": "worker.submit.phase-output",
  completion: "worker.submit.completion",
  question: "worker.submit.question",
  escalation: "worker.submit.question",
});

/** Maps a submission kind to the capability it requires, refusing unknown kinds. */
export function workerSubmissionCapability(submission: JsonValue): string {
  const kind =
    typeof submission === "object" && submission !== null && !Array.isArray(submission)
      ? (submission as { readonly [key: string]: JsonValue }).kind
      : undefined;
  const capability = typeof kind === "string" ? SUBMISSION_CAPABILITIES[kind] : undefined;
  if (capability === undefined) {
    throw new WorkerApiError(
      "invalid-submission",
      "Submission kind must be complete, phase-output, completion, question, or escalation",
    );
  }
  return capability;
}
