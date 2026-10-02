import { canonicalBytes } from "@senawa/protocol";
import type {
  CompletionFact,
  IntegrationAttemptRecord,
  RunnerAuthoritySnapshot,
  WorkspaceRecord,
  WorkspaceResultRecord,
} from "@senawa/runtime";
import type {
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import { deterministicSha256 } from "@senawa/testing";
import { describe, expect, it } from "vitest";
import { DurableCompletionEligibility } from "./workspace-composition.js";

describe("DurableCompletionEligibility", () => {
  it("ignores failed earlier rework and rejects ambiguous successful barriers", () => {
    const fact = {
      submissionId: "submission_semantic-rework",
      repositoryId: "repository_semantic-rework",
      runId: "run_semantic-rework",
      dispatchId: "dispatch_semantic-rework",
      assessment: { disposition: "accepted" },
    } as unknown as CompletionFact;
    const completionFactDigest = deterministicSha256.digest(canonicalBytes(fact));
    const workspace = {
      workspaceId: "workspace_semantic-rework",
      dispatchId: fact.dispatchId,
      state: "captured",
    } as unknown as WorkspaceRecord;
    const result = {
      resultId: "result_semantic-rework",
      workspaceId: workspace.workspaceId,
      completionFactDigest,
    } as unknown as WorkspaceResultRecord;
    const member = {
      memberDigest: "1".repeat(64),
      completionFactDigest,
    } as IntegrationAttemptRecord["members"][number]["member"];
    const failed = integration(
      "integration_aaa-failed",
      "rework-required",
      workspace,
      result,
      member,
    );
    const successful = integration(
      "integration_zzz-successful",
      "barrier-recorded",
      workspace,
      result,
      member,
      "2".repeat(64),
    );
    const attempts: IntegrationAttemptRecord[] = [failed, successful];
    let recordedIntegrationId: string | undefined;
    const workspaceAuthority = {
      loadRunExecution: () => ({ execution: { workspaceMode: "worktree" } }),
      listWorkspaces: () => [workspace],
      listWorkspaceResults: () => [result],
      listIntegrationAttempts: () => attempts,
      recordCompletionEligibility: (input: { readonly integrationId?: string }) => {
        recordedIntegrationId = input.integrationId;
        return { ...input, eligible: true };
      },
      completionAdmission: () => "accepted",
    } as unknown as SqliteWorkspaceIntegrationAuthority;
    const runnerAuthority = {
      load: () =>
        ({
          effects: [
            {
              intent: {
                command: {
                  kind: "worker",
                  input: { dispatchId: fact.dispatchId },
                },
              },
              outcome: { status: "completed", freshness: "current" },
            },
          ],
        }) as unknown as RunnerAuthoritySnapshot,
    } as unknown as SqliteRunnerAuthority;
    const eligibility = new DurableCompletionEligibility({
      workspaceAuthority,
      runnerAuthority,
      sha256: deterministicSha256,
      currentIntegrationBarrier: () => successful.barrier,
    });

    expect(eligibility.completionAdmission(fact.submissionId, fact)).toBe("accepted");
    expect(recordedIntegrationId).toBe(successful.integrationId);

    attempts.push(
      integration(
        "integration_second-success",
        "barrier-recorded",
        workspace,
        result,
        member,
        "3".repeat(64),
      ),
    );
    expect(() => eligibility.completionAdmission(fact.submissionId, fact)).toThrow("ambiguous");
  });
});

function integration(
  integrationId: string,
  state: IntegrationAttemptRecord["state"],
  workspace: WorkspaceRecord,
  result: WorkspaceResultRecord,
  member: IntegrationAttemptRecord["members"][number]["member"],
  barrierDigest?: string,
): IntegrationAttemptRecord {
  return {
    integrationId,
    state,
    members: [{ workspaceId: workspace.workspaceId, resultId: result.resultId, member }],
    ...(barrierDigest === undefined
      ? {}
      : {
          barrier: {
            barrierDigest,
            members: [member],
          },
        }),
  } as unknown as IntegrationAttemptRecord;
}
