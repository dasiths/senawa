import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  BoundedGitCommandPort,
  type CopilotSdkPort,
  type CopilotSdkSessionConfig,
  type CopilotSdkSessionPort,
  CopilotWorkerEffectHost,
  DurableWorkspaceEffectHost,
  GitIntegrationAdapter,
  GitWorkspaceAdapter,
  IntegrationSlotBusyError,
  RootScopedWorkspaceFiles,
  verifyGitRepository,
} from "@senawa/execution-host";
import {
  bindGitObjectId,
  bindGitRevision,
  createIntegrationBarrier,
  type GitRevisionDescriptor,
  type IntegrationMemberInput,
} from "@senawa/kernel";
import { canonicalBytes, decodeCanonicalJsonValue } from "@senawa/protocol";
import type {
  AsyncEffectHost,
  AsyncEffectHostContext,
  EffectIntent,
  EffectObservation,
  RuntimeDependencies,
} from "@senawa/runtime";
import { createRoleAuthorizationPolicy } from "@senawa/runtime";
import {
  SqliteContextBroker,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import {
  CompletionFactCommandBridge,
  SqliteSupervisorAuthority,
  SupervisorService,
} from "@senawa/supervisor";
import {
  createRuntimeGraph,
  createWorkerExecutionFixture,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { recordTrustedIntegrationBarrier } from "./daemon.js";
import { ProductionScheduler } from "./production-scheduler.js";
import {
  DurableCompletionEligibility,
  DynamicWorkspaceEffectHost,
} from "./workspace-composition.js";

const SENAWA_ROOT = "/workspaces/senawa";
const roots = new Set<string>();
const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "record-integration-barrier", roles: ["trusted-supervisor"] },
    { intent: "submit-completion", roles: ["engine"] },
  ]),
};
const context: AsyncEffectHostContext = {
  lease: { owner: "owner_workspace-production", fence: 1, expiresAt: "2026-08-13T13:00:00.000Z" },
  signal: new AbortController().signal,
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("production workspace composition", () => {
  it("integrates after restart and fails closed on a conflicting post-crash barrier", async () => {
    const fixture = await temporaryRepository();
    const runner = new SqliteRunnerAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    runner.configureRun({
      repositoryId: "repository_workspace-production",
      runId: "run_workspace-production",
      contextDigest: "a".repeat(64),
      taskScopes: [taskScope("task_alpha"), taskScope("task_beta")],
      budgets: [{ unit: "workspace-operations", limit: 100 }],
      capacities: [{ resource: "writer", limit: 2, occupied: 0 }],
      lease: context.lease,
    });
    const supervisor = new SqliteSupervisorAuthority({
      databasePath: fixture.databasePath,
      assetDirectory: join(fixture.root, "assets"),
      dependencies,
    });
    const graph = createRuntimeGraph();
    const execution = {
      workspaceMode: "worktree" as const,
      maxWriterConcurrency: 2,
      failurePolicy: "continue" as const,
      integrationRef: fixture.targetRef,
    };
    let runtimeSeedAllocation = 0;
    expect(
      supervisor.commandAuthority.submit(
        {
          ...runtimeCommand({
            commandId: "command_workspace-production-instantiate",
            intent: "instantiate-run",
            payload: {
              workflowId: runtimeFixture.workflowId,
              configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
              execution,
              graph,
              phase: runtimeFixture.phase,
              approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
              escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
              allowancePolicy: runtimeFixture.allowancePolicy,
            },
          }),
          repositoryId: "repository_workspace-production",
          runId: "run_workspace-production",
        },
        {
          currentTime: "2026-08-13T12:00:00.000Z",
          facts: { source: "workspace-production-test" },
          allocateId: () => {
            runtimeSeedAllocation += 1;
            return `stream-event-workspace-production-${runtimeSeedAllocation}`;
          },
        },
      ),
    ).toMatchObject({ status: "completed" });
    let authority = new SqliteWorkspaceIntegrationAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    authority.bindRunExecution({
      repositoryId: "repository_workspace-production",
      runId: "run_workspace-production",
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution,
      allowancePolicy: runtimeFixture.allowancePolicy,
    });
    const verified = await verifyGitRepository(fixture.command, {
      repositoryRoot: fixture.repositoryRoot,
      ownedRoot: fixture.ownedRoot,
      targetRef: fixture.targetRef,
      expectedRevision: fixture.baseRevision,
    });
    const workspace = new GitWorkspaceAdapter(fixture.command, verified);
    let takeOverBeforePublication = false;
    const integration = new GitIntegrationAdapter(fixture.command, verified, {
      beforePublicationAuthorityReassert() {
        if (!takeOverBeforePublication) return;
        takeOverBeforePublication = false;
        expect(
          authority.claimIntegrationSlot({
            repositoryId: "repository_workspace-production",
            runId: "run_workspace-production",
            integrationId: "integration_workspace-production",
            ownerId: "owner_workspace-takeover",
            currentTime: "2026-08-13T13:01:00.000Z",
            expiresAt: "2026-08-13T14:00:00.000Z",
          }),
        ).toMatchObject({ type: "claimed", attempt: { fence: 5 } });
      },
    });
    const trustedBarriers: string[] = [];
    let failAfterTrustedBarrier = false;
    let gateDecision: "passed" | "failed" = "passed";
    const createHost = () =>
      new DurableWorkspaceEffectHost({
        authority,
        workspace,
        integration,
        identity: gitIdentity,
        sha256: deterministicSha256,
        evaluateIntegration: async (root) => {
          const files = await RootScopedWorkspaceFiles.create(root);
          return {
            decision:
              gateDecision === "passed" &&
              (await files.read("alpha.txt")) === "alpha\n" &&
              (await files.read("beta.txt")) === "beta\n"
                ? "passed"
                : "failed",
            evidence: { root: "candidate", sensor: "disjoint-content" },
          };
        },
        recordTrustedBarrier: (repositoryId, runId, integrationId, barrier) => {
          recordTrustedIntegrationBarrier(
            supervisor,
            required(supervisor.commandAuthority.queryRunExecution(repositoryId, runId)),
            repositoryId,
            runId,
            integrationId,
            barrier,
          );
          if (!trustedBarriers.includes(barrier.barrierDigest)) {
            trustedBarriers.push(barrier.barrierDigest);
          }
          if (failAfterTrustedBarrier) {
            failAfterTrustedBarrier = false;
            throw new Error("crash after trusted runtime barrier commit");
          }
        },
        currentTrustedBarrier: (repositoryId, runId) =>
          supervisor.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
        currentTime: () => "2026-08-13T12:00:00.000Z",
      });
    let host = createHost();
    let dynamic = dynamicHost(supervisor, authority, fixture.repositoryRoot, host);
    const workspaceFacts = [
      { workspaceId: "workspace_alpha", dispatchId: "dispatch_alpha", taskId: "task_alpha" },
      { workspaceId: "workspace_beta", dispatchId: "dispatch_beta", taskId: "task_beta" },
    ] as const;

    for (const [sequence, fact] of workspaceFacts.entries()) {
      await dynamic.dispatch(
        effect(sequence + 1, fact.taskId, {
          operation: "prepare-workspace",
          ...fact,
          definitionGeneration: 1,
          baseRevision: fixture.baseRevision,
          inspectEffectId: `inspect_prepare_${fact.workspaceId}`,
        }),
        context,
      );
    }
    const alphaRoot = host.workspaceRoot(
      "repository_workspace-production",
      "run_workspace-production",
      "workspace_alpha",
    );
    const betaRoot = host.workspaceRoot(
      "repository_workspace-production",
      "run_workspace-production",
      "workspace_beta",
    );
    expect(alphaRoot).toBeDefined();
    expect(betaRoot).toBeDefined();
    expect(alphaRoot).not.toBe(betaRoot);
    await Promise.all([
      dynamic.dispatch(
        workerEffect(5, "task_alpha", "workspace_alpha", "alpha.txt", "alpha\n"),
        context,
      ),
      dynamic.dispatch(
        workerEffect(6, "task_beta", "workspace_beta", "beta.txt", "beta\n"),
        context,
      ),
    ]);

    for (const [sequence, fact] of workspaceFacts.entries()) {
      await dynamic.dispatch(
        effect(sequence + 10, fact.taskId, {
          operation: "capture-workspace",
          workspaceId: fact.workspaceId,
          resultId: `result_${fact.taskId}`,
          completionFactDigest: sequence === 0 ? "c".repeat(64) : "d".repeat(64),
          inspectEffectId: `inspect_capture_${fact.workspaceId}`,
          message: `capture ${fact.taskId}`,
        }),
        context,
      );
    }
    const results = authority.listWorkspaceResults(
      "repository_workspace-production",
      "run_workspace-production",
    );
    const conflictFacts = [
      { workspaceId: "workspace_gamma", dispatchId: "dispatch_gamma", taskId: "task_gamma" },
      { workspaceId: "workspace_delta", dispatchId: "dispatch_delta", taskId: "task_delta" },
    ] as const;
    for (const [sequence, fact] of conflictFacts.entries()) {
      await dynamic.dispatch(
        effect(sequence + 40, fact.taskId, {
          operation: "prepare-workspace",
          ...fact,
          definitionGeneration: 1,
          baseRevision: fixture.baseRevision,
          inspectEffectId: `inspect_prepare_${fact.workspaceId}`,
        }),
        context,
      );
      await dynamic.dispatch(
        workerEffect(sequence + 42, fact.taskId, fact.workspaceId, "base.txt", `${fact.taskId}\n`),
        context,
      );
      await dynamic.dispatch(
        effect(sequence + 44, fact.taskId, {
          operation: "capture-workspace",
          workspaceId: fact.workspaceId,
          resultId: `result_${fact.taskId}`,
          completionFactDigest: (sequence === 0 ? "3" : "4").repeat(64),
          inspectEffectId: `inspect_capture_${fact.workspaceId}`,
          message: `capture ${fact.taskId}`,
        }),
        context,
      );
    }
    const conflictResults = authority
      .listWorkspaceResults("repository_workspace-production", "run_workspace-production")
      .filter(({ workspaceId }) => conflictFacts.some((fact) => fact.workspaceId === workspaceId));
    const conflictInputs: IntegrationMemberInput[] = conflictFacts.map((fact, index) => ({
      taskId: fact.taskId as IntegrationMemberInput["taskId"],
      definitionGeneration: 1 as IntegrationMemberInput["definitionGeneration"],
      contextDigest: "a".repeat(64) as IntegrationMemberInput["contextDigest"],
      baseRevisionDigest: bindGitRevision(fixture.baseRevision, deterministicSha256)
        .descriptorDigest,
      resultTreeDigest: bindGitObjectId(
        required(conflictResults.find(({ workspaceId }) => workspaceId === fact.workspaceId))
          .resultRevision.revision.tree,
        deterministicSha256,
      ).descriptorDigest,
      completionFactDigest: (index === 0 ? "3" : "4").repeat(
        64,
      ) as IntegrationMemberInput["completionFactDigest"],
    }));
    const conflictBarrier = createIntegrationBarrier(
      {
        phaseId: runtimeFixture.phase.phaseId,
        definitionGeneration: 1 as never,
        graphRevisionDigest: graph.revisionDigest,
        targetRef: fixture.targetRef,
        beforeRevision: fixture.baseRevision,
        afterRevision: fixture.baseRevision,
        members: conflictInputs,
        gatePolicyDigest: "f".repeat(64) as never,
        gateReadingDigest: "1".repeat(64) as never,
        gateEvaluationDigest: "2".repeat(64) as never,
        outcome: "integrated",
      },
      deterministicSha256,
    );
    const conflictObservation = await dynamic.dispatch(
      effect(46, "task_gamma", {
        operation: "prepare-integration",
        integrationId: "integration_content-conflict",
        phaseId: conflictBarrier.phaseId,
        definitionGeneration: 1,
        targetRef: fixture.targetRef,
        fanInDigest: conflictBarrier.fanInDigest,
        beforeRevision: fixture.baseRevision,
        members: conflictBarrier.members.map((member) => {
          const workspaceId =
            member.taskId === "task_gamma" ? "workspace_gamma" : "workspace_delta";
          const result = required(
            conflictResults.find((candidate) => candidate.workspaceId === workspaceId),
          );
          return {
            workspaceId,
            resultId: result.resultId,
            member,
            resultRevision: result.resultRevision.revision,
          };
        }),
        inspectEffectId: "inspect_integration_content-conflict",
      }),
      context,
    );
    expect(conflictObservation.status).toBe("failed");
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_content-conflict"),
    ).toMatchObject({ state: "conflicted" });
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    for (const [sequence, fact] of conflictFacts.entries()) {
      await dynamic.dispatch(
        effect(sequence + 47, fact.taskId, {
          operation: "remove-workspace",
          workspaceId: fact.workspaceId,
        }),
        context,
      );
    }
    const memberInputs: IntegrationMemberInput[] = workspaceFacts.map((fact, index) => ({
      taskId: fact.taskId as IntegrationMemberInput["taskId"],
      definitionGeneration: 1 as IntegrationMemberInput["definitionGeneration"],
      contextDigest: "a".repeat(64) as IntegrationMemberInput["contextDigest"],
      baseRevisionDigest: bindGitRevision(fixture.baseRevision, deterministicSha256)
        .descriptorDigest,
      resultTreeDigest: bindGitObjectId(
        required(results.find(({ workspaceId }) => workspaceId === fact.workspaceId)).resultRevision
          .revision.tree,
        deterministicSha256,
      ).descriptorDigest,
      completionFactDigest: (index === 0 ? "c" : "d").repeat(
        64,
      ) as IntegrationMemberInput["completionFactDigest"],
    }));
    const memberBarrier = createIntegrationBarrier(
      {
        phaseId: runtimeFixture.phase.phaseId,
        definitionGeneration: 1 as never,
        graphRevisionDigest: graph.revisionDigest,
        targetRef: fixture.targetRef,
        beforeRevision: fixture.baseRevision,
        afterRevision: fixture.baseRevision,
        members: memberInputs,
        gatePolicyDigest: "f".repeat(64) as never,
        gateReadingDigest: "1".repeat(64) as never,
        gateEvaluationDigest: "2".repeat(64) as never,
        outcome: "integrated",
      },
      deterministicSha256,
    );
    const failedBarrier = createIntegrationBarrier(
      {
        phaseId: runtimeFixture.phase.phaseId,
        definitionGeneration: 1 as never,
        graphRevisionDigest: memberBarrier.graphRevisionDigest,
        targetRef: fixture.targetRef,
        beforeRevision: fixture.baseRevision,
        afterRevision: fixture.baseRevision,
        members: memberInputs,
        gatePolicyDigest: "f".repeat(64) as never,
        gateReadingDigest: "1".repeat(64) as never,
        gateEvaluationDigest: "2".repeat(64) as never,
        outcome: "integrated",
      },
      deterministicSha256,
    );
    const cancelledPrepare = await dynamic.dispatch(
      effect(16, "task_alpha", {
        operation: "prepare-integration",
        integrationId: "integration_cancelled",
        phaseId: runtimeFixture.phase.phaseId,
        definitionGeneration: 1,
        targetRef: fixture.targetRef,
        fanInDigest: memberBarrier.fanInDigest,
        beforeRevision: fixture.baseRevision,
        members: memberBarrier.members.map((member) => {
          const workspaceId = member.taskId === "task_alpha" ? "workspace_alpha" : "workspace_beta";
          const result = required(
            results.find((candidate) => candidate.workspaceId === workspaceId),
          );
          return {
            workspaceId,
            resultId: result.resultId,
            member,
            resultRevision: result.resultRevision.revision,
          };
        }),
        inspectEffectId: "inspect_integration_cancelled",
      }),
      context,
    );
    await expect(
      dynamic.cancel(
        effect(17, "task_alpha", {
          operation: "validate-integration",
          integrationId: "integration_cancelled",
          candidateRevision: observationDetails(cancelledPrepare)
            .candidateRevision as GitRevisionDescriptor,
          policyDigest: "f".repeat(64),
        }),
        context,
      ),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_cancelled"),
    ).toMatchObject({ state: "cancelled" });
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    gateDecision = "failed";
    const failedPrepare = await dynamic.dispatch(
      effect(18, "task_alpha", {
        operation: "prepare-integration",
        integrationId: "integration_semantic-failure",
        phaseId: failedBarrier.phaseId,
        definitionGeneration: 1,
        targetRef: fixture.targetRef,
        fanInDigest: failedBarrier.fanInDigest,
        beforeRevision: fixture.baseRevision,
        members: failedBarrier.members.map((member) => {
          const workspaceId = member.taskId === "task_alpha" ? "workspace_alpha" : "workspace_beta";
          const result = required(
            results.find((candidate) => candidate.workspaceId === workspaceId),
          );
          return {
            workspaceId,
            resultId: result.resultId,
            member,
            resultRevision: result.resultRevision.revision,
          };
        }),
        inspectEffectId: "inspect_integration_semantic-failure",
      }),
      context,
    );
    await dynamic.dispatch(
      effect(19, "task_alpha", {
        operation: "validate-integration",
        integrationId: "integration_semantic-failure",
        candidateRevision: observationDetails(failedPrepare)
          .candidateRevision as GitRevisionDescriptor,
        policyDigest: "f".repeat(64),
      }),
      context,
    );
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_semantic-failure"),
    ).toMatchObject({ state: "rework-required", gate: { decision: "failed" } });
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    expect(authority.integrationSlotStatus("repository_workspace-production")).toEqual({
      ownerId: context.lease.owner,
      fence: 3,
      expiresAt: "0000-01-01T00:00:00.000Z",
    });
    gateDecision = "passed";
    const prepare = await dynamic.dispatch(
      effect(20, "task_alpha", {
        operation: "prepare-integration",
        integrationId: "integration_workspace-production",
        phaseId: memberBarrier.phaseId,
        definitionGeneration: 1,
        targetRef: fixture.targetRef,
        fanInDigest: memberBarrier.fanInDigest,
        beforeRevision: fixture.baseRevision,
        members: memberBarrier.members.map((member) => {
          const workspaceId = member.taskId === "task_alpha" ? "workspace_alpha" : "workspace_beta";
          const result = required(
            results.find((candidate) => candidate.workspaceId === workspaceId),
          );
          return {
            workspaceId,
            resultId: result.resultId,
            member,
            resultRevision: result.resultRevision.revision,
          };
        }),
        inspectEffectId: "inspect_integration_workspace-production",
      }),
      context,
    );
    const candidateRevision = observationDetails(prepare)
      .candidateRevision as GitRevisionDescriptor;

    authority.close();
    authority = new SqliteWorkspaceIntegrationAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    host = createHost();
    dynamic = dynamicHost(supervisor, authority, fixture.repositoryRoot, host);
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_workspace-production"),
    ).toMatchObject({ state: "candidate-created", ownerId: context.lease.owner, fence: 4 });

    await dynamic.dispatch(
      effect(21, "task_alpha", {
        operation: "validate-integration",
        integrationId: "integration_workspace-production",
        candidateRevision,
        policyDigest: "f".repeat(64),
      }),
      context,
    );
    const gated = required(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_workspace-production"),
    );
    const barrier = createIntegrationBarrier(
      {
        phaseId: memberBarrier.phaseId,
        definitionGeneration: memberBarrier.definitionGeneration,
        graphRevisionDigest: memberBarrier.graphRevisionDigest,
        targetRef: fixture.targetRef,
        beforeRevision: fixture.baseRevision,
        afterRevision: candidateRevision,
        members: memberInputs,
        gatePolicyDigest: required(gated.gate).policyDigest as never,
        gateReadingDigest: required(gated.gate).readingDigest as never,
        gateEvaluationDigest: required(gated.gate).evaluationDigest as never,
        outcome: "integrated",
      },
      deterministicSha256,
    );
    const publishEffect = effect(22, "task_alpha", {
      operation: "publish-integration",
      integrationId: "integration_workspace-production",
      expectedOld: fixture.baseRevision,
      candidateRevision,
      barrier,
    });
    takeOverBeforePublication = true;
    await expect(dynamic.dispatch(publishEffect, context)).rejects.toBeInstanceOf(
      IntegrationSlotBusyError,
    );
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    const takeoverContext: AsyncEffectHostContext = {
      lease: {
        owner: "owner_workspace-takeover",
        fence: 99,
        expiresAt: "2026-08-13T14:00:00.000Z",
      },
      signal: new AbortController().signal,
    };
    failAfterTrustedBarrier = true;
    await expect(dynamic.dispatch(publishEffect, takeoverContext)).rejects.toThrow(
      "crash after trusted runtime barrier commit",
    );
    expect(
      supervisor.commandAuthority.queryIntegrationBarrier(
        "repository_workspace-production",
        "run_workspace-production",
      )?.barrierDigest,
    ).toBe(barrier.barrierDigest);
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_workspace-production"),
    ).toMatchObject({ state: "published", fence: 5 });
    authority.close();
    authority = new SqliteWorkspaceIntegrationAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    host = createHost();
    dynamic = dynamicHost(supervisor, authority, fixture.repositoryRoot, host);
    const conflictingBarrier = createIntegrationBarrier(
      {
        phaseId: barrier.phaseId,
        definitionGeneration: barrier.definitionGeneration,
        graphRevisionDigest: barrier.graphRevisionDigest,
        targetRef: barrier.targetRef,
        beforeRevision: fixture.baseRevision,
        afterRevision: candidateRevision,
        members: memberInputs,
        gatePolicyDigest: barrier.gatePolicyDigest,
        gateReadingDigest: barrier.gateReadingDigest,
        gateEvaluationDigest: "e".repeat(64) as never,
        outcome: "integrated",
      },
      deterministicSha256,
    );
    await expect(
      dynamic.inspect(
        effect(23, "task_alpha", {
          operation: "publish-integration",
          integrationId: "integration_workspace-production",
          expectedOld: fixture.baseRevision,
          candidateRevision,
          barrier: conflictingBarrier,
        }),
        takeoverContext,
      ),
    ).rejects.toThrow("conflicts with the current runtime barrier");

    expect(trustedBarriers).toEqual([barrier.barrierDigest]);
    expect(
      authority
        .listIntegrationAttempts("repository_workspace-production", "run_workspace-production")
        .find(({ integrationId }) => integrationId === "integration_workspace-production"),
    ).toMatchObject({
      state: "target-moved",
    });
    expect(oneLine(await fixture.git(["show", `${fixture.targetRef}:alpha.txt`]))).toBe("alpha");
    expect(oneLine(await fixture.git(["show", `${fixture.targetRef}:beta.txt`]))).toBe("beta");

    for (const [sequence, fact] of workspaceFacts.entries()) {
      await dynamic.dispatch(
        effect(sequence + 30, fact.taskId, {
          operation: "remove-workspace",
          workspaceId: fact.workspaceId,
        }),
        context,
      );
    }
    const finalWorkspaces = authority.listWorkspaces(
      "repository_workspace-production",
      "run_workspace-production",
    );
    expect(finalWorkspaces.map(({ workspaceId }) => workspaceId)).toEqual([
      "workspace_alpha",
      "workspace_beta",
      "workspace_delta",
      "workspace_gamma",
    ]);
    expect(finalWorkspaces.every(({ state }) => state === "removed")).toBe(true);

    authority.close();
    runner.close();
    supervisor.close();
    await fixture.cleanup();
  });

  it("bounds production semantic rework to two attempts without queuing a third", async () => {
    const fixture = await temporaryRepository();
    const graph = createRuntimeGraph();
    const worker = createWorkerExecutionFixture(graph);
    const execution = {
      workspaceMode: "worktree" as const,
      maxWriterConcurrency: 4,
      failurePolicy: "continue" as const,
      integrationRef: fixture.targetRef,
    };
    const supervisor = new SqliteSupervisorAuthority({
      databasePath: fixture.databasePath,
      assetDirectory: join(fixture.root, "assets"),
      dependencies,
    });
    let allocation = 0;
    expect(
      supervisor.commandAuthority.submit(
        {
          ...runtimeCommand({
            commandId: "command_scheduler-instantiate",
            intent: "instantiate-run",
            payload: {
              workflowId: runtimeFixture.workflowId,
              configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
              execution,
              graph,
              phase: runtimeFixture.phase,
              approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
              escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
              allowancePolicy: runtimeFixture.allowancePolicy,
            },
          }),
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
        },
        {
          currentTime: runtimeFixture.currentTime,
          facts: { source: "scheduler-production-test" },
          allocateId: () => `stream-event-scheduler-${++allocation}`,
        },
      ),
    ).toMatchObject({ status: "completed" });
    const runner = new SqliteRunnerAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    const workspaceAuthority = new SqliteWorkspaceIntegrationAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    let broker: SqliteContextBroker;
    const eligibility = new DurableCompletionEligibility({
      workspaceAuthority,
      runnerAuthority: runner,
      sha256: deterministicSha256,
      currentIntegrationBarrier: (repositoryId, runId) =>
        supervisor.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
    });
    const completionBridge = new CompletionFactCommandBridge({
      authority: supervisor,
      broker: () => broker,
      completionEligibility: eligibility,
      currentTime: () => runtimeFixture.currentTime,
    });
    broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: {
        sha256: deterministicSha256,
        currentTime: () => runtimeFixture.currentTime,
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
      completionFacts: completionBridge,
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: {
        runId: runtimeFixture.runId,
        taskId: worker.dispatch.task.taskId,
        definitionGeneration: worker.dispatch.task.definitionGeneration,
        acceptedContextDigest: worker.context.contextDigest,
        fenceGeneration: 1,
      },
      effect: {
        input: decodeCanonicalJsonValue({
          dispatchId: worker.dispatch.dispatchId,
          routeSelection: worker.routeSelection,
          timeoutMs: 2_000,
          grantPolicy: {
            expiresAfterMs: 3_000,
            maxOperations: 4,
            maxBytes: 4_096,
            maxChunkBytes: 1_024,
          },
        }),
        budgetReservation: { unit: "work-attempt", amount: 2_000 },
        baseRevision: fixture.baseRevision,
        integrationGatePolicyDigest: "f".repeat(64),
      },
    });
    const verified = await verifyGitRepository(fixture.command, {
      repositoryRoot: fixture.repositoryRoot,
      ownedRoot: fixture.ownedRoot,
      targetRef: fixture.targetRef,
      expectedRevision: fixture.baseRevision,
    });
    let gateEvaluations = 0;
    const gitHost = new DurableWorkspaceEffectHost({
      authority: workspaceAuthority,
      workspace: new GitWorkspaceAdapter(fixture.command, verified),
      integration: new GitIntegrationAdapter(fixture.command, verified),
      identity: gitIdentity,
      sha256: deterministicSha256,
      evaluateIntegration: async (_root) => {
        gateEvaluations += 1;
        return {
          decision: "failed",
          evidence: { command: "trusted-test-callback", gateEvaluations },
        };
      },
      recordTrustedBarrier: (repositoryId, runId, integrationId, barrier) =>
        recordTrustedIntegrationBarrier(
          supervisor,
          required(supervisor.commandAuthority.queryRunExecution(repositoryId, runId)),
          repositoryId,
          runId,
          integrationId,
          barrier,
        ),
      currentTrustedBarrier: (repositoryId, runId) =>
        supervisor.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
      currentTime: () => runtimeFixture.currentTime,
    });
    const sdk = new WorkspaceCompletingSdkPort();
    const dynamic = new DynamicWorkspaceEffectHost({
      authority: supervisor,
      workspaceAuthority,
      repositoryRoot: fixture.repositoryRoot,
      hostWriterCapacity: 3,
      createWorkerHost: async (root) =>
        new CopilotWorkerEffectHost({
          broker,
          sdk,
          workingDirectory: root,
          workspaceFiles: await RootScopedWorkspaceFiles.create(root),
        }),
      createGitHost: async () => gitHost,
    });
    const scheduler = new ProductionScheduler({
      authority: supervisor,
      runnerAuthority: runner,
      workspaceAuthority,
      contextBroker: broker,
      supervisorWriterLimit: 1,
      hostWriterLimit: 3,
      sha256: deterministicSha256,
    });
    const observedBatchSizes: number[] = [];
    const service = new SupervisorService({
      authority: supervisor,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_scheduler-production",
      asyncEffectHost: dynamic,
      runnerBatchSize: 9,
      failurePolicyForRun: () => "continue",
      scheduleBeforeEffects: ({ repositoryId, runId, lease, currentTime }) => {
        const scheduled = scheduler.schedule({ repositoryId, runId, lease, currentTime });
        observedBatchSizes.push(scheduled.batchSize);
        return scheduled;
      },
      listSchedulableRuns: () => scheduler.listRuns(),
      deliverCompletionOutboxOnce: () => broker.deliverCompletionOutboxOnce(),
      closeables: [
        { close: () => broker.close() },
        { close: () => workspaceAuthority.close() },
        { close: () => runner.close() },
      ],
    });

    await service.start();
    const query = new SqliteRunnerAuthority({
      databasePath: fixture.databasePath,
      dependencies,
    });
    const snapshot = query.load({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
    });
    expect(snapshot.capacities).toEqual([{ resource: "writer", limit: 4, occupied: 0 }]);
    expect(observedBatchSizes).toContain(1);
    expect(observedBatchSizes.every((size) => size === 1)).toBe(true);
    expect(snapshot.effects.map(({ intent }) => intent.command.kind)).toEqual([
      "git",
      "worker",
      "git",
      "git",
      "git",
      "git",
      "git",
    ]);
    expect(
      snapshot.effects.filter(({ intent }) =>
        JSON.stringify(intent.command.input).includes('"operation":"prepare-integration"'),
      ),
    ).toHaveLength(2);
    const integrationAttempts = workspaceAuthority.listIntegrationAttempts(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    expect(integrationAttempts).toHaveLength(2);
    expect(integrationAttempts[0]).toMatchObject({ state: "rework-required" });
    expect(integrationAttempts[1]).toMatchObject({ state: "rework-required" });
    expect(gateEvaluations).toBe(2);
    expect(
      query
        .queryBudgets(runtimeFixture.repositoryId, runtimeFixture.runId)
        .every(({ limit, spent, reserved }) => spent + reserved <= limit),
    ).toBe(true);
    expect(
      workspaceAuthority
        .listWorkspaces(runtimeFixture.repositoryId, runtimeFixture.runId)
        .every(({ state }) => state === "captured"),
    ).toBe(true);
    expect(oneLine(await fixture.git(["rev-parse", fixture.targetRef]))).toBe(
      fixture.baseRevision.commit.oid,
    );
    expect(
      supervisor.commandAuthority.queryIntegrationBarrier(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
      ),
    ).toBeUndefined();
    for (const [index, workspaceRecord] of workspaceAuthority
      .listWorkspaces(runtimeFixture.repositoryId, runtimeFixture.runId)
      .entries()) {
      const input = decodeCanonicalJsonValue({
        operation: "remove-workspace",
        workspaceId: workspaceRecord.workspaceId,
      });
      const template = required(snapshot.effects[0]).intent;
      await dynamic.dispatch(
        {
          ...template,
          command: {
            ...template.command,
            commandId: `command_workspace-production-teardown-${index}`,
            operationId: `operation_workspace-production-teardown-${index}`,
            input,
            inputDigest: deterministicSha256.digest(canonicalBytes(input)),
          },
          attemptId: `attempt_workspace-production-teardown-${index}`,
        },
        context,
      );
    }
    query.close();
    await service.drain();
    await service.stop();
    await fixture.cleanup();
  });
});

interface TemporaryRepository {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly databasePath: string;
  readonly targetRef: string;
  readonly command: BoundedGitCommandPort;
  readonly baseRevision: GitRevisionDescriptor;
  git(args: readonly string[], root?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function temporaryRepository(): Promise<TemporaryRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "senawa-workspace-production-")));
  roots.add(root);
  if (relative(SENAWA_ROOT, root).startsWith("..") === false) {
    throw new Error("Temporary Git repository must be outside the Senawa checkout");
  }
  const repositoryRoot = join(root, "repository");
  const ownedRoot = join(root, "owned-workspaces");
  const home = join(root, "git-home");
  await Promise.all([mkdir(ownedRoot), mkdir(home)]);
  const command = new BoundedGitCommandPort({
    gitExecutable: "/usr/bin/git",
    isolatedHome: home,
    additionalSubcommands: ["init", "commit", "cat-file", "show", "checkout", "branch"],
  });
  const git = async (args: readonly string[], commandRoot = repositoryRoot) => {
    const result = await command.run({ rootDirectory: commandRoot, args, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled) {
      throw new Error(`Git command failed: ${args.join(" ")}\n${result.stderr.text}`);
    }
    return result.stdout.text;
  };
  const before = await git(["worktree", "list", "--porcelain"], SENAWA_ROOT);
  await git(["init", "--initial-branch=main", repositoryRoot], root);
  await git(["config", "user.name", "Senawa Test"]);
  await git(["config", "user.email", "test@senawa.invalid"]);
  const files = await RootScopedWorkspaceFiles.create(repositoryRoot);
  await files.write("base.txt", "base\n");
  await git(["add", "--all", "--", "."]);
  await git(["commit", "-m", "base"]);
  const objectFormat = oneLine(await git(["rev-parse", "--show-object-format"])) as
    | "sha1"
    | "sha256";
  const commit = oneLine(await git(["rev-parse", "HEAD^{commit}"]));
  const tree = oneLine(await git(["rev-parse", "HEAD^{tree}"]));
  const targetRef = "refs/heads/senawa/integration";
  await git(["update-ref", targetRef, commit]);
  const baseRevision = {
    commit: { objectFormat, oid: commit },
    tree: { objectFormat, oid: tree },
  } as const;
  let cleaned = false;
  return {
    root,
    repositoryRoot,
    ownedRoot,
    databasePath: join(root, "authority.db"),
    targetRef,
    command,
    baseRevision,
    git,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      const porcelain = await git(["worktree", "list", "--porcelain"]);
      expect(porcelain.match(/^worktree /gmu)).toHaveLength(1);
      expect(await git(["worktree", "list", "--porcelain"], SENAWA_ROOT)).toBe(before);
      roots.delete(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function effect(sequence: number, taskId: string, inputValue: unknown): EffectIntent {
  const input = decodeCanonicalJsonValue(inputValue);
  return {
    command: {
      sequence,
      commandId: `command_workspace-production-${sequence}`,
      repositoryId: "repository_workspace-production",
      runId: "run_workspace-production",
      operationId: `operation_workspace-production-${String(sequence).padStart(3, "0")}`,
      kind: "git",
      taskScope: taskScope(taskId),
      contextDigest: "a".repeat(64),
      inputDigest: deterministicSha256.digest(canonicalBytes(input)),
      input,
      budgetReservation: { unit: "workspace-operations", amount: 1 },
      capacityReservation: { resource: "writer", amount: 1 },
      queuedAt: "2026-08-13T12:00:00.000Z",
      maxReconciliationAttempts: 3,
    },
    owner: context.lease.owner,
    fence: context.lease.fence,
    attemptId: `attempt_workspace-production-${sequence}`,
    status: "intent",
    persistedAt: "2026-08-13T12:00:00.000Z",
  };
}

function workerEffect(
  sequence: number,
  taskId: string,
  workspaceId: string,
  path: string,
  content: string,
): EffectIntent {
  const intent = effect(sequence, taskId, {
    operation: "dispatch-worker",
    workspaceId,
    worker: { path, content },
  });
  return {
    ...intent,
    command: { ...intent.command, kind: "worker" },
  };
}

function dynamicHost(
  supervisor: SqliteSupervisorAuthority,
  workspaceAuthority: SqliteWorkspaceIntegrationAuthority,
  repositoryRoot: string,
  gitHost: DurableWorkspaceEffectHost,
): DynamicWorkspaceEffectHost {
  return new DynamicWorkspaceEffectHost({
    authority: supervisor,
    workspaceAuthority,
    repositoryRoot,
    hostWriterCapacity: 2,
    createWorkerHost: (root) => new DeterministicWorkspaceWriter(root),
    createGitHost: async () => gitHost,
  });
}

class DeterministicWorkspaceWriter implements AsyncEffectHost {
  constructor(readonly root: string) {}

  async dispatch(intent: EffectIntent): Promise<EffectObservation> {
    const input = intent.command.input as { readonly path: string; readonly content: string };
    await (await RootScopedWorkspaceFiles.create(this.root)).write(input.path, input.content);
    return {
      status: "completed",
      observedAt: "2026-08-13T12:00:00.000Z",
      details: { root: "assigned", path: input.path },
    };
  }

  async inspect() {
    return { status: "completed" as const, observedAt: "2026-08-13T12:00:00.000Z" };
  }

  async cancel() {
    return { status: "cancelled" as const, observedAt: "2026-08-13T12:00:00.000Z" };
  }
}

class WorkspaceCompletingSdkPort implements CopilotSdkPort {
  async resumeSession(): Promise<undefined> {
    return undefined;
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    return new WorkspaceCompletingSession(required(config.sessionId), config);
  }

  async sessionMetadataExists(): Promise<boolean> {
    return false;
  }
}

class WorkspaceCompletingSession implements CopilotSdkSessionPort {
  constructor(
    readonly sessionId: string,
    readonly config: CopilotSdkSessionConfig,
  ) {}

  async sendAndWait(): Promise<void> {
    const write = required(
      this.config.tools.find(({ name }) => name === "senawa_write_workspace_file"),
    );
    const written = await write.handler(
      { path: "scheduled.txt", content: "scheduled\n" },
      { sessionId: this.sessionId, toolCallId: "write", toolName: write.name },
    );
    if (written.resultType !== "success") throw new Error("Workspace write was refused");
    const completion = required(this.config.tools.find(({ name }) => name === "senawa_complete"));
    const submitted = await completion.handler(
      {
        disposition: "completed",
        summary: "Completed scheduled worktree task",
        criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" }],
        completionEvidence: [],
      },
      { sessionId: this.sessionId, toolCallId: "completion", toolName: completion.name },
    );
    if (submitted.resultType !== "success") throw new Error("Completion was refused");
  }

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {}
}

function taskScope(taskId: string) {
  return {
    runId: "run_workspace-production",
    taskId,
    definitionGeneration: 1,
    acceptedContextDigest: "a".repeat(64),
    fenceGeneration: 1,
    claimsAccepted: true,
  } as const;
}

function observationDetails(observation: EffectObservation): Record<string, unknown> {
  const envelope = observation.details as { details?: Record<string, unknown> } | undefined;
  return required(envelope?.details);
}

function oneLine(value: string): string {
  return value.trimEnd();
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required workspace test value is missing");
  return value;
}

const gitIdentity = Object.freeze({
  authorName: "Senawa Worker",
  authorEmail: "worker@senawa.invalid",
  authorDate: "2026-08-13T00:00:00Z",
  committerName: "Senawa Integration",
  committerEmail: "integration@senawa.invalid",
  committerDate: "2026-08-13T00:00:00Z",
});
