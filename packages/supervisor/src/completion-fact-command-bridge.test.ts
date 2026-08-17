import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CompletionFact,
  type ContextBrokerClient,
  createRoleAuthorizationPolicy,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSupervisorAuthority } from "./command-queue.js";
import { CompletionFactCommandBridge } from "./completion-fact-command-bridge.js";
import { SupervisorRunController } from "./run-controller.js";

const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["engine"] },
  ]),
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("CompletionFactCommandBridge", () => {
  it("redelivers exactly after queue commit and drains to an accepted completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-completion-bridge-"));
    roots.add(root);
    const authority = new SqliteSupervisorAuthority({
      databasePath: join(root, "authority.db"),
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const graph = createRuntimeGraph();
    const instantiate = runtimeCommand({
      commandId: "command_bridge-instantiate",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph,
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    authority.accept({
      envelope: instantiate,
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "bridge-test" },
        allocations: [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-bridge-instantiate-${ordinal}`,
        })),
      }),
    });
    const controller = new SupervisorRunController({ authority });
    await controller.runOnceAsync({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      ownerId: "owner_bridge",
      currentTime: () => runtimeFixture.currentTime,
      attemptId: "attempt_bridge-instantiate",
    });

    const submission = {
      task: runtimeFixture.task,
      disposition: "completed" as const,
      summary: "Accepted through completion bridge",
      criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" as const }],
      completionEvidence: [],
    };
    const fact = {
      submissionId: "submission_bridge-completion",
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      dispatchId: "dispatch_bridge-completion",
      assessment: { submission },
    } as unknown as CompletionFact;
    const stored = {
      context: { graphRevisionDigest: graph.revisionDigest },
      dispatch: {
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        task: runtimeFixture.task,
      },
    };
    const broker = {
      loadWorkerDispatch: (dispatchId: string) =>
        dispatchId === fact.dispatchId ? stored : undefined,
    } as unknown as ContextBrokerClient;
    let faultAfterAccept = true;
    let eligibility: "accepted" | "deferred" = "deferred";
    const bridge = new CompletionFactCommandBridge({
      authority,
      broker: () => broker,
      completionEligibility: {
        completionAdmission: () => eligibility,
      },
      currentTime: () => runtimeFixture.currentTime,
      afterAccept: () => {
        if (faultAfterAccept) throw new Error("fault after queue commit");
      },
    });

    expect(bridge.admitCompletionFact(fact)).toBe("deferred");
    expect(authority.operationalSnapshot().pending.queuedCommands).toBe(0);
    eligibility = "accepted";

    expect(() => bridge.admitCompletionFact(fact)).toThrow("fault after queue commit");
    expect(authority.operationalSnapshot().pending.queuedCommands).toBe(1);

    faultAfterAccept = false;
    expect(() => bridge.admitCompletionFact(fact)).not.toThrow();
    const result = await controller.runOnceAsync({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      ownerId: "owner_bridge",
      currentTime: () => runtimeFixture.currentTime,
      attemptId: "attempt_bridge-completion",
    });

    expect(result.receipt?.terminalReceipt).toMatchObject({
      status: "completed",
      result: { assessment: { submission } },
    });
    expect(authority.operationalSnapshot().pending.queuedCommands).toBe(0);
    authority.close();
  });
});
