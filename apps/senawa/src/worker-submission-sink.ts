import type { ConfigurationSnapshot } from "@senawa/configuration";
import {
  assessCompletionAccounting,
  type CanonicalValue,
  canonicalBytes,
  canonicalDigest,
  canonicalValue,
  type Sha256,
} from "@senawa/kernel";
import { type JsonValue, PROTOCOL_VERSION } from "@senawa/protocol";
import type { SqliteCanonicalJsonAssetStore, SqliteContextBroker } from "@senawa/storage-sqlite";
import { WorkerApiError } from "@senawa/supervisor";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import type { AcceptedWorkerSubmission, WorkerSubmissionSink } from "./worker-service.js";

export interface BrokerWorkerSubmissionSinkOptions {
  readonly broker: SqliteContextBroker;
  readonly assets: SqliteCanonicalJsonAssetStore;
  readonly loadSnapshot: (snapshotDigest: string) => unknown | undefined;
  readonly sha256: Sha256;
}

/**
 * Applies what an agent hands in to durable state.
 *
 * Everything here is decided by the authority afterwards. This validates the
 * output against the schema the phase declared, installs it, and records the
 * submissions; it never judges whether the phase is done.
 */
export class BrokerWorkerSubmissionSink implements WorkerSubmissionSink {
  readonly #options: BrokerWorkerSubmissionSinkOptions;

  constructor(options: BrokerWorkerSubmissionSinkOptions) {
    this.#options = options;
  }

  async accept(accepted: AcceptedWorkerSubmission): Promise<JsonValue> {
    try {
      return await this.#accept(accepted);
    } catch (error) {
      if (error instanceof WorkerApiError) throw error;
      // A bare throw here reaches the agent as "Supervisor request failed",
      // which tells it nothing it can act on.
      throw new WorkerApiError(
        "submission-refused",
        error instanceof Error ? error.message : "Submission could not be applied",
      );
    }
  }

  /** Derives a distinct submission identity without exceeding the 64-char suffix. */
  static #derive(submissionId: string, marker: string): string {
    const suffix = submissionId.slice("submission_".length);
    return `submission_${suffix.slice(0, 64 - marker.length)}${marker}`;
  }

  async #accept(accepted: AcceptedWorkerSubmission): Promise<JsonValue> {
    const { scope, submission, submissionId } = accepted;
    const stored = this.#options.broker
      .listWorkerDispatches(scope.repositoryId, scope.runId)
      .find((entry) => entry.dispatch.dispatchId === scope.dispatchId);
    if (stored === undefined) {
      throw new WorkerApiError("unknown-dispatch", "Dispatch is not accepting worker traffic");
    }

    if (submission.kind === "question" || submission.kind === "escalation") {
      const payload =
        submission.kind === "question"
          ? { question: submission.question, urgency: "normal" as const }
          : { question: submission.reason, urgency: "blocking" as const };
      return this.#admit(stored, "question", submissionId, "question", payload);
    }

    if (submission.kind !== "complete") {
      throw new WorkerApiError(
        "invalid-submission",
        `The channel does not accept a bare ${submission.kind}; hand in a complete request`,
      );
    }

    const snapshot = this.#options.loadSnapshot(
      String(stored.context.configurationSnapshotDigest),
    ) as ConfigurationSnapshot | undefined;
    if (snapshot === undefined) {
      throw new WorkerApiError(
        "unavailable",
        "The configuration this dispatch was built from is gone",
      );
    }

    const results: JsonValue[] = [];
    const completionEvidence = submission.completionEvidence.map((item) => {
      const descriptor = canonicalValue({ path: item.path, kind: item.kind });
      const installed = this.#options.assets.install(
        canonicalValue({ content: item.content, path: item.path }),
      );
      return {
        assetId: `asset_${String(installed.contentDigest)}`,
        kind: item.kind,
        descriptor,
        ...(item.criterionId === undefined ? {} : { criterionId: item.criterionId }),
      };
    });
    const completion = {
      task: stored.dispatch.task,
      disposition: "completed",
      summary: submission.summary ?? "Submitted by the agent",
      criteria: stored.completionRequirements.criteria.map(({ criterionId }) => ({
        criterionId,
        disposition: "satisfied" as const,
      })),
      completionEvidence,
    };

    // Evidence is judged before anything is published, so a completion that
    // owes evidence leaves the phase exactly as it was.
    const owed = unsatisfiedEvidence(stored.completionRequirements, completion);
    if (owed.length > 0) {
      throw new WorkerApiError(
        "invalid-submission",
        `This completion owes evidence: ${owed.join("; ")}`,
      );
    }

    for (const output of submission.outputs) {
      results.push(this.#publish(stored, snapshot, submissionId, output.name, output.value));
    }

    results.push(
      this.#admit(
        stored,
        "completion",
        BrokerWorkerSubmissionSink.#derive(submissionId, "c"),
        "completion",
        completion,
      ),
    );
    return await Promise.resolve(results[results.length - 1] as JsonValue);
  }

  #publish(
    stored: ReturnType<SqliteContextBroker["listWorkerDispatches"]>[number],
    snapshot: ConfigurationSnapshot,
    submissionId: string,
    outputName: string,
    value: CanonicalValue,
  ): JsonValue {
    const declaration = stored.context.phaseOutputDeclarations.find(
      (entry) => String(entry.outputName) === outputName,
    );
    if (declaration === undefined) {
      throw new WorkerApiError(
        "invalid-submission",
        `This phase declares no output named ${outputName}`,
      );
    }

    const contract = runtimeSchemaContract(
      snapshot,
      String(declaration.schemaKey),
      this.#options.sha256,
    );
    const findings = configurationRuntimeSchemaValidator().validate(contract, value);
    if (findings.length > 0) {
      throw new WorkerApiError(
        "invalid-submission",
        `Output ${outputName} does not satisfy ${String(declaration.schemaKey)}: ${findings
          .map((finding) => `${finding.instancePointer} fails ${finding.keyword}`)
          .join("; ")}`,
      );
    }

    const installed = this.#options.assets.install(value);
    const validationReceiptDigest = canonicalDigest(
      canonicalValue({
        boundary: "phase output",
        contentDigest: String(installed.contentDigest),
        findings: [],
        schemaKey: String(contract.key),
        schemaResourceDigest: String(contract.schemaResourceDigest),
        validatorProfileDigest: String(contract.validatorProfileDigest),
      }),
      this.#options.sha256,
    );
    this.#options.broker.installCanonicalOutputAsset(
      {
        byteLength: installed.byteLength,
        contentDigest: installed.contentDigest,
        mediaType: "application/json",
        schemaResourceDigest: declaration.schemaResourceDigest,
        validationReceiptDigest,
      },
      canonicalBytes(value),
    );

    return this.#admit(
      stored,
      "phase-output",
      BrokerWorkerSubmissionSink.#derive(submissionId, "o"),
      "output",
      {
        byteLength: installed.byteLength,
        configurationSnapshotDigest: stored.context.configurationSnapshotDigest,
        contentDigest: installed.contentDigest,
        graphRevisionDigest: stored.context.graphRevisionDigest,
        inputBindingDigest: stored.context.phaseInputBinding.bindingDigest,
        mediaType: "application/json",
        outputName: declaration.outputName,
        phase: stored.context.phaseAttempt.phase,
        schemaKey: declaration.schemaKey,
        schemaResourceDigest: declaration.schemaResourceDigest,
        sensitivity: declaration.sensitivity,
        validationReceiptDigest,
      },
    );
  }

  #admit(
    stored: ReturnType<SqliteContextBroker["listWorkerDispatches"]>[number],
    type: "question" | "completion" | "phase-output",
    submissionId: string,
    payloadKey: "question" | "completion" | "output",
    payload: unknown,
  ): JsonValue {
    const result = this.#options.broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        contextDigest: stored.dispatch.contextDigest,
        contextId: stored.dispatch.contextId,
        dispatchId: stored.dispatch.dispatchId,
        [payloadKey]: payload,
        principalId: stored.dispatch.worker.principalId,
        repositoryId: stored.dispatch.repositoryId,
        runId: stored.dispatch.runId,
        submissionId,
        task: stored.dispatch.task,
        type,
      },
    } as Parameters<SqliteContextBroker["admitSubmission"]>[0]);
    if (result.status !== "accepted") {
      throw new WorkerApiError("submission-refused", `Submission was ${result.status}`);
    }
    return { status: result.status, submissionId } as JsonValue;
  }
}

/** Names each evidence kind still owed, and how much of it, in the agent's words. */
function unsatisfiedEvidence(requirements: unknown, completion: unknown): readonly string[] {
  const assessment = assessCompletionAccounting(
    requirements as Parameters<typeof assessCompletionAccounting>[0],
    completion as Parameters<typeof assessCompletionAccounting>[1],
  );
  if (assessment.completionEvidenceSatisfied) return [];
  const shortfalls = [
    ...assessment.taskEvidence.map((item) => ({ scope: "this completion", item })),
    ...assessment.criteria.flatMap((criterion) =>
      criterion.completionEvidence.map((item) => ({
        scope: `criterion ${String(criterion.criterionId)}`,
        item,
      })),
    ),
  ];
  return shortfalls
    .filter(({ item }) => !item.satisfied)
    .map(
      ({ scope, item }) =>
        `${scope} needs ${item.minimumCount} of ${
          typeof item.kind === "string" ? item.kind : JSON.stringify(item.kind)
        } and carries ${item.attachmentCount}`,
    );
}
