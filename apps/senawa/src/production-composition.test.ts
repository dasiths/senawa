import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileWorkflowAmendment,
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
  createExampleWorkflowResources,
  WORKFLOW_AMENDMENT_API_VERSION,
} from "@senawa/configuration";
import {
  type CopilotSdkPort,
  type CopilotSdkSessionConfig,
  type CopilotSdkSessionPort,
  CopilotWorkerEffectHost,
  FilesystemCopilotSessionStore,
} from "@senawa/execution-host";
import { canonicalBytes, decodeCanonicalJsonValue } from "@senawa/protocol";
import {
  type AsyncEffectHostContext,
  createRoleAuthorizationPolicy,
  type EffectIntent,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
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
import { ProductionScheduler, selectCurrentDispatches } from "./production-scheduler.js";

const roots = new Set<string>();

function exampleResourceReader() {
  const resources = createExampleWorkflowResources();
  return {
    async read({ path }: { readonly path: string }) {
      const text = resources[path];
      if (text === undefined) throw new Error("Missing example resource");
      return new TextEncoder().encode(text);
    },
  };
}
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

describe("production worker composition", () => {
  it("selects one exact durable current dispatch and fails closed on ambiguity", () => {
    const baseGraph = createRuntimeGraph();
    const taskNode = baseGraph.nodes.find(({ kind }) => kind === "task");
    if (taskNode?.kind !== "task") throw new Error("Expected a task node");
    const graph = {
      ...baseGraph,
      nodes: baseGraph.nodes.map((node) =>
        node.kind === "task"
          ? { ...node, definition: { ...node.definition, generation: 2 } }
          : node,
      ),
    };
    const scope = {
      runId: runtimeFixture.runId,
      taskId: taskNode.definition.id,
      definitionGeneration: 2,
      acceptedContextDigest: "b".repeat(64),
      fenceGeneration: 2,
      claimsAccepted: true,
    };
    const historical = {
      context: { contextDigest: "a".repeat(64) },
      dispatch: {
        dispatchId: "dispatch_historical",
        task: { taskId: taskNode.definition.id, definitionGeneration: 1 },
      },
      taskScope: { ...scope, definitionGeneration: 1, acceptedContextDigest: "a".repeat(64) },
      effect: {},
    };
    const current = {
      context: { contextDigest: scope.acceptedContextDigest },
      dispatch: {
        dispatchId: "dispatch_current",
        task: { taskId: taskNode.definition.id, definitionGeneration: 2 },
      },
      taskScope: scope,
      effect: {},
    };
    const runtime = { graph, phase: runtimeFixture.phase, acceptedTasks: [] };

    expect(
      selectCurrentDispatches(runtime as never, [scope], [historical, current] as never),
    ).toEqual([current]);
    expect(
      selectCurrentDispatches(runtime as never, [scope], [
        historical,
        current,
        {
          ...current,
          dispatch: { ...current.dispatch, dispatchId: "dispatch_current-duplicate" },
        },
      ] as never),
    ).toBeUndefined();
  });

  it("recovers an approved amendment after restart and applies the exact reviewed graph", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-amendment-recovery-"));
    roots.add(root);
    const databasePath = join(root, "authority.db");
    const amendmentDependencies: RuntimeDependencies = {
      sha256: deterministicSha256,
      authorization: createRoleAuthorizationPolicy([
        { intent: "instantiate-run", roles: ["release-manager"] },
        { intent: "submit-amendment-proposal", roles: ["release-manager"] },
        { intent: "record-amendment-decision", roles: ["release-manager"] },
        { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
      ]),
    };
    const authority = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies: amendmentDependencies,
    });
    const baseSnapshot = await compileWorkflowConfiguration(
      {
        document: createExampleWorkflowConfiguration(),
        locator: "fixture://amendment-recovery-base",
        resources: exampleResourceReader(),
      },
      deterministicSha256,
    );
    const baseContextDigest = "a".repeat(64);
    const compilation = compileWorkflowAmendment(
      {
        document: {
          apiVersion: WORKFLOW_AMENDMENT_API_VERSION,
          kind: "WorkflowAmendment",
          baseSnapshotDigest: baseSnapshot.snapshotDigest,
          baseContextDigest,
          operations: [
            {
              kind: "add-phase",
              phase: {
                key: "audit",
                generation: 1,
                dependsOn: ["work"],
                input: {
                  schema: "work-input",
                  mappings: [
                    {
                      key: "workflow-input",
                      source: { kind: "workflow-input", pointer: "" },
                      destinationPointer: "",
                    },
                  ],
                },
                executor: { kind: "task-set", work: [] },
                outputs: [],
                iteration: {
                  maximumAttempts: 1,
                  onGateRejected: "fail",
                  onApprovalRejected: "fail",
                  onExhausted: "fail",
                },
                exit: { requiredOutputs: [], approval: { policy: "none" } },
                actions: [],
              },
            },
          ],
        },
        locator: "fixture://amendment-recovery",
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    const staleCompilation = compileWorkflowAmendment(
      {
        document: {
          apiVersion: WORKFLOW_AMENDMENT_API_VERSION,
          kind: "WorkflowAmendment",
          baseSnapshotDigest: baseSnapshot.snapshotDigest,
          baseContextDigest,
          operations: [
            {
              kind: "add-phase",
              phase: {
                key: "package",
                generation: 1,
                dependsOn: ["work"],
                input: {
                  schema: "work-input",
                  mappings: [
                    {
                      key: "workflow-input",
                      source: { kind: "workflow-input", pointer: "" },
                      destinationPointer: "",
                    },
                  ],
                },
                executor: { kind: "task-set", work: [] },
                outputs: [],
                iteration: {
                  maximumAttempts: 1,
                  onGateRejected: "fail",
                  onApprovalRejected: "fail",
                  onExhausted: "fail",
                },
                exit: { requiredOutputs: [], approval: { policy: "none" } },
                actions: [],
              },
            },
          ],
        },
        locator: "fixture://amendment-recovery-stale",
        baseSnapshot,
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    authority.commandAuthority.putConfigurationSnapshot(baseSnapshot);
    authority.commandAuthority.putConfigurationSnapshot(compilation.resultSnapshot);
    authority.commandAuthority.putConfigurationSnapshot(staleCompilation.resultSnapshot);
    const phase = baseSnapshot.graph.nodes.find(({ kind }) => kind === "phase");
    if (phase === undefined || phase.kind !== "phase") {
      throw new Error("Example workflow phase is missing");
    }
    let allocationSequence = 0;
    const admission = (currentTime: string) => {
      return {
        currentTime,
        facts: { source: "amendment-restart-fixture" },
        allocateId(kind: "approval" | "stream-event") {
          allocationSequence += 1;
          return kind === "approval"
            ? `approval_amendment-restart-${allocationSequence}`
            : `stream-event-amendment-restart-${allocationSequence}`;
        },
      };
    };
    expect(
      authority.commandAuthority.submit(
        runtimeCommand({
          commandId: "command_amendment-restart-instantiate",
          intent: "instantiate-run",
          payload: {
            workflowId: baseSnapshot.graph.workflowId,
            configurationSnapshotDigest: baseSnapshot.snapshotDigest,
            execution: baseSnapshot.execution,
            graph: baseSnapshot.graph,
            phase: {
              phaseId: phase.definition.id,
              definitionGeneration: phase.definition.generation,
            },
            approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
            escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
            allowancePolicy: runtimeFixture.allowancePolicy,
          },
        }),
        admission("2026-08-13T12:00:00.000Z"),
      ).status,
    ).toBe("completed");
    expect(
      authority.commandAuthority.submit(
        runtimeCommand({
          commandId: "command_amendment-restart-submit-stale",
          intent: "submit-amendment-proposal",
          payload: { proposal: staleCompilation.proposal },
          expectedGraphRevision: baseSnapshot.graph.revisionDigest,
          exactObjectDigest: staleCompilation.proposal.proposalDigest,
        }),
        admission("2026-08-13T12:00:01.500Z"),
      ).status,
    ).toBe("completed");
    expect(
      authority.commandAuthority.submit(
        runtimeCommand({
          commandId: "command_amendment-restart-submit",
          intent: "submit-amendment-proposal",
          payload: { proposal: compilation.proposal },
          expectedGraphRevision: baseSnapshot.graph.revisionDigest,
          exactObjectDigest: compilation.proposal.proposalDigest,
        }),
        admission("2026-08-13T12:00:01.000Z"),
      ).status,
    ).toBe("completed");
    const approvalReceipt = authority.commandAuthority.submit(
      runtimeCommand({
        commandId: "command_amendment-restart-approve",
        intent: "record-amendment-decision",
        payload: {
          amendmentId: compilation.proposal.amendmentId,
          proposalDigest: compilation.proposal.proposalDigest,
          decision: "approve",
          reviewedResultGraphRevisionDigest:
            compilation.proposal.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: baseSnapshot.graph.revisionDigest,
        exactObjectDigest: compilation.proposal.proposalDigest,
      }),
      admission("2026-08-13T12:00:02.000Z"),
    );
    expect(approvalReceipt).toMatchObject({ status: "completed" });
    expect(
      authority.commandAuthority.submit(
        runtimeCommand({
          commandId: "command_amendment-restart-approve-stale",
          intent: "record-amendment-decision",
          payload: {
            amendmentId: staleCompilation.proposal.amendmentId,
            proposalDigest: staleCompilation.proposal.proposalDigest,
            decision: "approve",
            reviewedResultGraphRevisionDigest:
              staleCompilation.proposal.reviewedResultGraph.revisionDigest,
          },
          expectedGraphRevision: baseSnapshot.graph.revisionDigest,
          exactObjectDigest: staleCompilation.proposal.proposalDigest,
        }),
        admission("2026-08-13T12:00:02.500Z"),
      ).status,
    ).toBe("completed");
    expect(authority.listApprovedAmendmentRecoveries()).toHaveLength(2);

    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse("2026-08-13T12:00:03.000Z") },
      ownerId: "owner_amendment-restart",
    });
    await service.start();

    expect(authority.listApprovedAmendmentRecoveries()).toEqual([]);
    const records = authority.queryAmendments(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(records.map(({ lifecycle }) => (lifecycle as { status: string }).status).sort()).toEqual(
      ["applied", "stale"],
    );
    const applied = records.find(
      ({ lifecycle }) => (lifecycle as { status: string }).status === "applied",
    );
    if (applied === undefined) throw new Error("Recovered amendment was not applied");
    const appliedProposal = applied.proposal as {
      proposalDigest: string;
      reviewedResultGraph: { revisionDigest: string };
    };
    expect(applied.application).toMatchObject({
      afterGraphRevisionDigest: appliedProposal.reviewedResultGraph.revisionDigest,
    });
    const applyCommandId = `command_amendment-apply-${appliedProposal.proposalDigest.slice(0, 20)}-1`;
    expect(authority.queryLatest(applyCommandId)?.terminalReceipt).toMatchObject({
      status: "completed",
    });
    await service.drain();
    await service.stop();
  }, 15_000);

  it("re-drives one dispatch after a host restart without losing transcript lines", async () => {
    let redriveAllocation = 0;
    const root = mkdtempSync(join(tmpdir(), "senawa-worker-redrive-"));
    roots.add(root);
    const databasePath = join(root, "authority.db");
    const authority = new SqliteAuthority({
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const graph = createRuntimeGraph();
    expect(
      authority.submit(
        runtimeCommand({
          commandId: "command_redrive-instantiate",
          intent: "instantiate-run",
          payload: {
            workflowId: runtimeFixture.workflowId,
            configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
            execution: runtimeFixture.execution,
            graph,
            phase: runtimeFixture.phase,
            approvalPolicy: { policy: "no-approval" },
            escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
            allowancePolicy: runtimeFixture.allowancePolicy,
          },
        }),
        {
          currentTime: runtimeFixture.currentTime,
          facts: { source: "redrive-composition-test" },
          allocateId: () => {
            redriveAllocation += 1;
            return `stream-event-redrive-instantiate-${redriveAllocation}`;
          },
        },
      ),
    ).toMatchObject({ status: "completed" });
    authority.close();

    // A host restart brings a new wall clock, so re-used line identities would
    // conflict on occurredAt and every line up to the prior mark would be lost.
    let currentTime: string = runtimeFixture.currentTime;
    const broker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: deterministicSha256,
        currentTime: () => currentTime,
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
    });
    const worker = createWorkerExecutionFixture(graph);
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: workerTaskScope(worker),
    });
    const input = decodeCanonicalJsonValue({
      dispatchId: worker.dispatch.dispatchId,
      routeSelection: worker.routeSelection,
      timeoutMs: 1_000,
      grantPolicy: {
        expiresAfterMs: 2_000,
        maxOperations: 4,
        maxBytes: 4_096,
        maxChunkBytes: 1_024,
      },
    });
    const intent: EffectIntent = {
      command: {
        sequence: 1,
        commandId: "command_redrive-worker",
        repositoryId: worker.dispatch.repositoryId,
        runId: worker.dispatch.runId,
        operationId: "operation_redrive-worker",
        kind: "worker",
        taskScope: workerTaskScope(worker),
        contextDigest: worker.context.contextDigest,
        inputDigest: deterministicSha256.digest(canonicalBytes(input)),
        input,
        budgetReservation: { unit: "model-millidollars", amount: 1 },
        queuedAt: runtimeFixture.currentTime,
        maxReconciliationAttempts: 2,
      },
      owner: "owner_redrive",
      fence: 1,
      attemptId: "attempt_redrive",
      status: "intent",
      persistedAt: runtimeFixture.currentTime,
    };
    const context: AsyncEffectHostContext = {
      lease: { owner: "owner_redrive", fence: 1, expiresAt: "2026-08-12T12:00:30.000Z" },
      signal: new AbortController().signal,
    };
    const hostOptions = {
      broker,
      workingDirectory: "/tmp/senawa-production-work",
      transcript: broker.transcript,
    };

    const firstObservation = await new CopilotWorkerEffectHost({
      ...hostOptions,
      sdk: new CompletingSdkPort(),
    }).dispatch(intent, context);
    expect(firstObservation.details).not.toHaveProperty("transcriptRefusals");
    const portal = new SqlitePortalQueryAuthority({
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    const owner = { kind: "dispatch", id: worker.dispatch.dispatchId } as const;
    const afterFirst = portal.listTranscript(
      worker.dispatch.repositoryId,
      worker.dispatch.runId,
      owner,
    );
    expect(afterFirst.records.length).toBeGreaterThan(1);

    currentTime = "2026-08-12T13:00:00.000Z";
    const secondObservation = await new CopilotWorkerEffectHost({
      ...hostOptions,
      sdk: new CompletingSdkPort(),
    }).dispatch(intent, context);

    expect(secondObservation.details).not.toHaveProperty("transcriptRefusals");
    const afterSecond = portal.listTranscript(
      worker.dispatch.repositoryId,
      worker.dispatch.runId,
      owner,
    );
    expect(afterSecond.records.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: afterFirst.records.length * 2 }, (_, index) => index + 1),
    );
    expect(
      afterSecond.records.slice(0, afterFirst.records.length).map(({ occurredAt }) => occurredAt),
    ).toEqual(afterFirst.records.map(({ occurredAt }) => occurredAt));
    expect(
      afterSecond.records
        .slice(afterFirst.records.length)
        .every(({ occurredAt }) => occurredAt === "2026-08-12T13:00:00.000Z"),
    ).toBe(true);
    portal.close();
    broker.close();
  });

  it("rejects cross-authority worker intents before broker or SDK mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-worker-binding-"));
    roots.add(root);
    const databasePath = join(root, "authority.db");
    const broker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: deterministicSha256,
        currentTime: () => runtimeFixture.currentTime,
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
    });
    const worker = createWorkerExecutionFixture();
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: workerTaskScope(worker),
    });
    const sdk = new CompletingSdkPort();
    const host = new CopilotWorkerEffectHost({
      broker,
      sdk,
      workingDirectory: join(root, "work"),
    });
    const input = decodeCanonicalJsonValue({
      dispatchId: worker.dispatch.dispatchId,
      routeSelection: worker.routeSelection,
      timeoutMs: 1_000,
      grantPolicy: {
        expiresAfterMs: 2_000,
        maxOperations: 4,
        maxBytes: 4_096,
        maxChunkBytes: 1_024,
      },
    });
    const baseIntent: EffectIntent = {
      command: {
        sequence: 1,
        commandId: "command_binding-worker",
        repositoryId: worker.dispatch.repositoryId,
        runId: worker.dispatch.runId,
        operationId: "operation_binding-worker",
        kind: "worker",
        taskScope: workerTaskScope(worker),
        contextDigest: worker.context.contextDigest,
        inputDigest: deterministicSha256.digest(canonicalBytes(input)),
        input,
        budgetReservation: { unit: "model-millidollars", amount: 1 },
        queuedAt: runtimeFixture.currentTime,
        maxReconciliationAttempts: 1,
      },
      owner: "owner_binding",
      fence: 1,
      attemptId: "attempt_binding",
      status: "intent",
      persistedAt: runtimeFixture.currentTime,
    };
    const invalidIntents = [
      { ...baseIntent, command: { ...baseIntent.command, kind: "sensor" as const } },
      {
        ...baseIntent,
        command: { ...baseIntent.command, repositoryId: "repository_other" },
      },
      { ...baseIntent, command: { ...baseIntent.command, runId: "run_other" } },
      { ...baseIntent, command: { ...baseIntent.command, contextDigest: "f".repeat(64) } },
    ];
    const context: AsyncEffectHostContext = {
      lease: { owner: "owner_binding", fence: 1, expiresAt: "2026-08-12T12:00:30.000Z" },
      signal: new AbortController().signal,
    };
    const grantsBefore = broker.authority.projection().grants;

    for (const intent of invalidIntents) {
      await expect(host.dispatch(intent, context)).rejects.toThrow(TypeError);
      await expect(host.inspect(intent, context)).rejects.toThrow(TypeError);
      await expect(host.cancel(intent, context)).rejects.toThrow(TypeError);
    }

    expect(broker.authority.projection().grants).toBe(grantsBefore);
    expect(sdk.createCalls).toBe(0);
    expect(sdk.metadataCalls).toBe(0);
    expect(sdk.abortCalls).toBe(0);
    broker.close();
  });

  it("drives a seeded worker effect through completion outbox to workflow assessment", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-production-composition-"));
    roots.add(root);
    const databasePath = join(root, "authority.db");
    const sdkDirectory = join(root, "sdk");
    mkdirSync(sdkDirectory, { mode: 0o700 });
    const authority = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies,
    });
    let broker: SqliteContextBroker;
    const bridge = new CompletionFactCommandBridge({
      authority,
      broker: () => broker,
      currentTime: () => runtimeFixture.currentTime,
    });
    broker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: deterministicSha256,
        currentTime: () => runtimeFixture.currentTime,
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
      completionFacts: bridge,
    });
    const graph = createRuntimeGraph();
    const worker = createWorkerExecutionFixture(graph);
    const effectInput = decodeCanonicalJsonValue({
      dispatchId: worker.dispatch.dispatchId,
      routeSelection: worker.routeSelection,
      timeoutMs: 1_000,
      grantPolicy: {
        expiresAfterMs: 2_000,
        maxOperations: 4,
        maxBytes: 4_096,
        maxChunkBytes: 1_024,
      },
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: workerTaskScope(worker),
      effect: {
        input: effectInput,
        budgetReservation: { unit: "model-millidollars", amount: 2_000 },
      },
    });
    authority.accept({
      envelope: runtimeCommand({
        commandId: "command_production-instantiate",
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
      }),
      createAdmission: () => ({
        currentTime: runtimeFixture.currentTime,
        facts: { source: "production-composition-test" },
        allocations: [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-production-instantiate-${ordinal}`,
        })),
      }),
    });
    const schedulerRunner = new SqliteRunnerAuthority({ databasePath, dependencies });
    const workspaceAuthority = new SqliteWorkspaceIntegrationAuthority({
      databasePath,
      dependencies,
    });
    const scheduler = new ProductionScheduler({
      authority,
      runnerAuthority: schedulerRunner,
      workspaceAuthority,
      contextBroker: broker,
      supervisorWriterLimit: 4,
      hostWriterLimit: 4,
      sha256: deterministicSha256,
    });

    const sdk = new CompletingSdkPort();
    const service = new SupervisorService({
      authority,
      clock: { now: () => Date.parse(runtimeFixture.currentTime) },
      ownerId: "owner_production",
      asyncEffectHost: new CopilotWorkerEffectHost({
        broker,
        sdk,
        workingDirectory: "/tmp/senawa-production-work",
      }),
      deliverCompletionOutboxOnce: () => broker.deliverCompletionOutboxOnce(),
      scheduleBeforeEffects: ({ repositoryId, runId, lease, currentTime }) =>
        scheduler.schedule({ repositoryId, runId, lease, currentTime }),
      sessionStoreHealth: new FilesystemCopilotSessionStore({
        baseDirectory: sdkDirectory,
        metadata: sdk,
      }),
      closeables: [
        { close: () => broker.close() },
        { close: () => workspaceAuthority.close() },
        { close: () => schedulerRunner.close() },
      ],
    });

    expect(authority.operationalSnapshot().startedSessionIds).toEqual([]);
    await service.start();

    const runnerQuery = new SqliteRunnerAuthority({ databasePath, dependencies });
    expect(
      runnerQuery.load({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
      }).effects[0],
    ).toMatchObject({ outcome: { status: "completed", origin: "dispatch" } });
    expect(sdk.createCalls).toBe(1);
    runnerQuery.close();
    const history = authority.queryHistory(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(history).toHaveLength(6);
    expect(history.filter(({ status }) => status === "terminal")).toHaveLength(2);
    expect(history.at(-1)?.terminalReceipt).toMatchObject({
      status: "completed",
      result: {
        assessment: {
          submission: {
            task: worker.dispatch.task,
            disposition: "completed",
            summary: "Completed by fake Copilot SDK",
          },
        },
      },
    });
    await service.drain();
    await service.stop();
  });
});

function workerTaskScope(worker: ReturnType<typeof createWorkerExecutionFixture>) {
  return {
    runId: worker.dispatch.runId,
    taskId: worker.dispatch.task.taskId,
    definitionGeneration: worker.dispatch.task.definitionGeneration,
    acceptedContextDigest: worker.context.contextDigest,
    fenceGeneration: 1,
  } as const;
}

class CompletingSdkPort implements CopilotSdkPort {
  readonly workingDirectory = "/tmp/senawa-production-work";
  createCalls = 0;
  metadataCalls = 0;
  abortCalls = 0;

  async resumeSession(): Promise<undefined> {
    return undefined;
  }

  async createSession(config: CopilotSdkSessionConfig): Promise<CopilotSdkSessionPort> {
    this.createCalls += 1;
    if (config.sessionId === undefined) throw new Error("Expected dispatch session identity");
    return new CompletingSession(config.sessionId, config);
  }

  async sessionMetadataExists(): Promise<boolean> {
    this.metadataCalls += 1;
    return false;
  }

  async abortSession(): Promise<boolean> {
    this.abortCalls += 1;
    return false;
  }
}

class CompletingSession implements CopilotSdkSessionPort {
  constructor(
    readonly sessionId: string,
    readonly config: CopilotSdkSessionConfig,
  ) {}

  async sendAndWait(): Promise<void> {
    const tool = this.config.tools.find(({ name }) => name === "submit_completion");
    if (tool === undefined) throw new Error("Completion tool is missing");
    const result = await tool.handler(
      {
        disposition: "completed",
        summary: "Completed by fake Copilot SDK",
        criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" }],
        evidence: [],
      },
      { sessionId: this.sessionId, toolCallId: "completion", toolName: tool.name },
    );
    if (result.resultType !== "success") throw new Error("Completion submission was refused");
  }

  async abort(): Promise<void> {}

  async disconnect(): Promise<void> {}
}
