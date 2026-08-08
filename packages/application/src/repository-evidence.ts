import type { RepositoryBaselineEvidence, RepositoryDeltaEvidence } from "@senawa/domain";
import type { RepositoryEvidencePort } from "./ports.js";

const unavailableDigest = "0".repeat(64);

export class UnconfiguredRepositoryEvidencePort implements RepositoryEvidencePort {
  async captureBaseline(
    input: Parameters<RepositoryEvidencePort["captureBaseline"]>[0],
  ): Promise<RepositoryBaselineEvidence> {
    return {
      version: 1,
      kind: "repository-baseline",
      runId: input.runId,
      taskId: input.taskId,
      attempt: input.attempt,
      dispatchId: input.dispatchId,
      turnId: input.turnId,
      expectation: input.expectation,
      authorizedPaths: input.authorizedPaths,
      frozenPaths: input.frozenPaths,
      head: null,
      entries: [],
      capturedAt: input.capturedAt,
      uncertainty: ["repository-evidence-port-not-configured"],
      digest: unavailableDigest,
      evidencePath: `evidence/repository/tasks/${input.taskId}/attempt-${input.attempt}/${input.dispatchId}/baseline-unavailable.json`,
    };
  }

  async captureDelta(
    input: Parameters<RepositoryEvidencePort["captureDelta"]>[0],
  ): Promise<RepositoryDeltaEvidence> {
    return {
      version: 1,
      kind: "repository-delta",
      runId: input.baseline.runId,
      taskId: input.baseline.taskId,
      attempt: input.baseline.attempt,
      dispatchId: input.baseline.dispatchId,
      turnId: input.baseline.turnId,
      expectation: input.baseline.expectation,
      baselineDigest: input.baseline.digest,
      headBefore: input.baseline.head,
      headAfter: null,
      preExistingChanges: input.baseline.entries.map((entry) => entry.path),
      changedPaths: [],
      inScopeChanges: [],
      outOfScopeChanges: [],
      frozenChanges: [],
      uncertainty: ["repository-evidence-port-not-configured"],
      workerClaim: {
        reported: input.workerClaim.reported,
        changed: input.workerClaim.changed,
        agreement: input.workerClaim.reported ? "disagree" : "unreported",
      },
      capturedAt: input.capturedAt,
      digest: unavailableDigest,
      evidencePath: `evidence/repository/tasks/${input.baseline.taskId}/attempt-${input.baseline.attempt}/${input.baseline.dispatchId}/delta-unavailable.json`,
    };
  }
}
