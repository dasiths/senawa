import {
  type AccountingAssessment,
  bindGitObjectId,
  bindGitRevision,
  consumerKey,
  createAmendmentProposal,
  createAmendmentQuiescenceFact,
  createIntegrationBarrier,
  createPhaseCandidate,
  createSensorReading,
  defineGate,
  definitionGeneration,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  phaseId,
  sha256Digest,
  taskId,
} from "@senawa/kernel";
import {
  canonicalBytes,
  canonicalStringify,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  ProtocolValidationError,
} from "@senawa/protocol";
import {
  createRoleAuthorizationPolicy,
  InMemoryAuthority,
  type PageQueryError,
  RuntimeCommandService,
  type RuntimeDependencies,
} from "@senawa/runtime";
import { describe, expect, it } from "vitest";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  deterministicSha256,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "./index.js";

const ALLOWED_INTENTS = [
  "instantiate-run",
  "accept-graph-revision",
  "submit-completion",
  "evaluate-gate",
  "record-authority-decision",
  "close-phase",
  "record-phase-attempt-transition",
  "import-plan",
  "record-fan-out-diff-decision",
  "submit-amendment-proposal",
  "withdraw-amendment-proposal",
  "record-amendment-decision",
] as const;

function createDependencies(): RuntimeDependencies {
  return {
    sha256: deterministicSha256,
    authorization: createRoleAuthorizationPolicy([
      ...ALLOWED_INTENTS.map((intent) => ({
        intent,
        // The engine may reach the decision intent; whether it may decide a
        // given proposal is the authority's question, not the policy's.
        roles:
          intent === "record-amendment-decision"
            ? ["engine", "release-manager"]
            : ["release-manager"],
      })),
      { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
      {
        intent: "record-integration-barrier",
        roles: ["release-manager", "trusted-supervisor"],
      },
    ]),
  };
}

function createService(authority?: InMemoryAuthority) {
  return new RuntimeCommandService(createDependencies(), authority);
}

interface SnapshotCommand {
  canonicalEnvelope: string;
  receipt: Record<string, unknown>;
  admission?: { allocations?: unknown[] };
}

interface SnapshotRun {
  repositoryId: string;
  runId: string;
  commands: SnapshotCommand[];
  receiptHistory: Record<string, unknown>[];
  events: (Record<string, unknown> & { eventId: string })[];
  records?: Record<string, unknown>;
}

interface RuntimeSnapshot {
  version: string;
  runs: SnapshotRun[];
}

function parseSnapshot(serialized: string): RuntimeSnapshot {
  return JSON.parse(serialized) as RuntimeSnapshot;
}

function restore(snapshot: RuntimeSnapshot): InMemoryAuthority {
  return InMemoryAuthority.fromCanonicalJson(canonicalStringify(snapshot), createDependencies());
}

function independentRunSnapshot(input: {
  repositoryId: string;
  runId: string;
  commandId: string;
  eventPrefix: string;
}): RuntimeSnapshot {
  const service = createService();
  let eventSequence = 0;
  const receipt = service.submit(
    {
      ...runtimeCommand({
        commandId: input.commandId,
        intent: "instantiate-run",
        payload: instantiatePayload(),
      }),
      repositoryId: input.repositoryId,
      runId: input.runId,
    },
    {
      currentTime: runtimeFixture.currentTime,
      facts: { source: "restoration-probe" },
      allocateId() {
        eventSequence += 1;
        return `${input.eventPrefix}-${eventSequence}`;
      },
    },
  );
  expect(receipt.status).toBe("completed");
  return parseSnapshot(service.authority.toCanonicalJson());
}

function instantiate(service: RuntimeCommandService, commandId = "command_instantiate") {
  const graph = createRuntimeGraph();
  const admission = createAdmissionFixture();
  const command = runtimeCommand({
    commandId,
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
  const receipt = service.submit(command, admission.at());
  expect(receipt.status).toBe("completed");
  return { graph, admission, command, receipt };
}

function completionPayload() {
  return {
    submission: {
      task: runtimeFixture.task,
      disposition: "completed" as const,
      summary: "Verified deterministic runtime journey",
      criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" as const }],
      completionEvidence: [],
    },
  };
}

function acceptedCandidate(
  graph: ReturnType<typeof createRuntimeGraph>,
  assessment: AccountingAssessment,
) {
  const gateDefinition = defineGate(
    {
      key: consumerKey("release"),
      blocking: [
        {
          key: consumerKey("verified"),
          condition: {
            operator: "equals",
            accessor: { sensorKey: consumerKey("quality"), pointer: "/passed" },
            expected: true,
          },
        },
      ],
      advisory: [],
    },
    deterministicSha256,
  );
  const tasks = [runtimeFixture.task];
  const candidate = createPhaseCandidate(
    {
      phase: runtimeFixture.phase,
      phaseAttempt: { ...runtimeFixture.phase, attempt: 1 },
      graphRevisionDigest: graph.revisionDigest,
      inputBindingDigest: runtimeFixture.configurationSnapshotDigest,
      requiredOutputPublications: [],
      outputSetDigest: digestPhaseOutputSet([], deterministicSha256),
      selectedTaskSetDigest: digestSelectedTaskSet(tasks, deterministicSha256),
      tasks,
      acceptedAccountingAssessments: [
        {
          assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256),
          assessment,
        },
      ],
      dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
      gatePolicyDigest: gateDefinition.policyDigest,
    },
    graph,
    deterministicSha256,
  );
  const reading = createSensorReading(
    {
      sensorKey: consumerKey("quality"),
      inputDigest: candidate.candidateDigest,
      outcome: "succeeded",
      data: { passed: true },
    },
    deterministicSha256,
  );
  return { candidate, gateDefinition, reading };
}

function candidateGateBindings(candidate: ReturnType<typeof acceptedCandidate>["candidate"]) {
  return {
    phaseAttempt: candidate.phaseAttempt,
    inputBindingDigest: candidate.inputBindingDigest,
    requiredOutputPublications: candidate.requiredOutputPublications,
    outputSetDigest: candidate.outputSetDigest,
  };
}

describe("transport-independent runtime command conformance", () => {
  it("records task-frontier metadata commands without mutating graph authority", () => {
    const service = createService();
    const instantiated = instantiate(service, "command_frontier-instantiate");
    const graphRevision = instantiated.graph.revisionDigest;
    const commands = [
      {
        commandId: "command_frontier-transition",
        intent: "record-phase-attempt-transition" as const,
        payload: {
          attemptDigest: "1".repeat(64),
          transitionDigest: "2".repeat(64),
          triggerDigest: "3".repeat(64),
          disposition: "iterate",
        },
      },
      {
        commandId: "command_frontier-import",
        intent: "import-plan" as const,
        payload: {
          attemptDigest: "1".repeat(64),
          acceptanceDigest: "2".repeat(64),
          closureDigest: "3".repeat(64),
          forEachKey: "plan-tasks",
          definitionDigest: "4".repeat(64),
          evaluationDigest: "5".repeat(64),
          taskSetDigest: "6".repeat(64),
        },
      },
      {
        commandId: "command_frontier-diff",
        intent: "record-fan-out-diff-decision" as const,
        payload: {
          evaluationDigest: "5".repeat(64),
          priorEvaluationDigest: "4".repeat(64),
          diffDigest: "6".repeat(64),
          authorityDigest: "7".repeat(64),
          changed: "supersede-changed",
          removed: "retain-removed",
        },
      },
    ];
    for (const command of commands) {
      const receipt = service.submit(
        runtimeCommand({ ...command, expectedGraphRevision: graphRevision }),
        instantiated.admission.at(),
      );
      expect(receipt).toMatchObject({ status: "completed", result: command.payload });
    }
  });

  it("binds trusted integration barriers to worktree policy and exact gate authority", () => {
    const repositoryService = createService();
    const repository = instantiate(repositoryService, "command_repository-instantiate");
    const repositoryBarrier = integrationBarrier(repository.graph);
    expect(
      repositoryService.submit(
        {
          ...runtimeCommand({
            commandId: "command_repository-barrier",
            intent: "record-integration-barrier",
            payload: {
              integrationId: "integration_repository",
              configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
              barrier: repositoryBarrier,
            },
            expectedGraphRevision: repository.graph.revisionDigest,
            exactObjectDigest: repositoryBarrier.barrierDigest,
          }),
          principal: trustedSupervisorPrincipal,
        },
        repository.admission.at(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "integration-forbidden" } });

    const service = createService();
    const graph = createRuntimeGraph();
    const admission = createAdmissionFixture();
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_worktree-instantiate",
          intent: "instantiate-run",
          payload: {
            ...instantiatePayload(),
            graph,
            execution: {
              workspaceMode: "worktree",
              maxWriterConcurrency: 2,
              failurePolicy: "continue",
              integrationRef: "refs/heads/senawa/integration",
            },
          },
        }),
        admission.at(),
      ),
    ).toMatchObject({ status: "completed" });
    const completion = service.submit(
      runtimeCommand({
        commandId: "command_worktree-completion",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    expect(completion.status).toBe("completed");
    const assessment = (completion.result as unknown as { assessment: AccountingAssessment })
      .assessment;
    const barrier = integrationBarrier(graph);
    const barrierPayload = {
      integrationId: "integration_worktree",
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      barrier,
    };
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_worktree-barrier-untrusted",
          intent: "record-integration-barrier",
          payload: barrierPayload,
          expectedGraphRevision: graph.revisionDigest,
          exactObjectDigest: barrier.barrierDigest,
        }),
        admission.at(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "trusted-supervisor-required" } });
    expect(
      service.submit(
        {
          ...runtimeCommand({
            commandId: "command_worktree-barrier",
            intent: "record-integration-barrier",
            payload: barrierPayload,
            expectedGraphRevision: graph.revisionDigest,
            exactObjectDigest: barrier.barrierDigest,
          }),
          principal: trustedSupervisorPrincipal,
        },
        admission.at(),
      ),
    ).toMatchObject({
      status: "completed",
      result: { barrierDigest: barrier.barrierDigest },
    });
    const gateDefinition = defineGate(
      { key: consumerKey("release"), blocking: [], advisory: [] },
      deterministicSha256,
    );
    const candidate = createPhaseCandidate(
      {
        phase: runtimeFixture.phase,
        phaseAttempt: { ...runtimeFixture.phase, attempt: 1 },
        graphRevisionDigest: graph.revisionDigest,
        inputBindingDigest: runtimeFixture.configurationSnapshotDigest,
        requiredOutputPublications: [],
        outputSetDigest: digestPhaseOutputSet([], deterministicSha256),
        selectedTaskSetDigest: digestSelectedTaskSet([runtimeFixture.task], deterministicSha256),
        tasks: [runtimeFixture.task],
        acceptedAccountingAssessments: [
          {
            assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256),
            assessment,
          },
        ],
        dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
        integrationBarrierDigest: barrier.barrierDigest,
        gatePolicyDigest: gateDefinition.policyDigest,
      },
      graph,
      deterministicSha256,
    );
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_worktree-gate-wrong-barrier",
          intent: "evaluate-gate",
          payload: {
            phase: runtimeFixture.phase,
            ...candidateGateBindings(candidate),
            dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
            integrationBarrierDigest: "f".repeat(64),
            gateDefinition,
            readings: [],
          },
          expectedGraphRevision: graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
        admission.at(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "integration-barrier-required" } });
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_worktree-gate",
          intent: "evaluate-gate",
          payload: {
            phase: runtimeFixture.phase,
            ...candidateGateBindings(candidate),
            dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
            integrationBarrierDigest: barrier.barrierDigest,
            gateDefinition,
            readings: [],
          },
          expectedGraphRevision: graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
        admission.at(),
      ),
    ).toMatchObject({ status: "completed", result: { candidate } });
  });

  it("reaches closure only through commands and reconstructs from canonical authority state", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);

    const completion = service.submit(
      runtimeCommand({
        commandId: "command_completion",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    expect(completion.status).toBe("completed");
    const assessment = (completion.result as unknown as { assessment: AccountingAssessment })
      .assessment;
    const { candidate, gateDefinition, reading } = acceptedCandidate(graph, assessment);

    const gate = service.submit(
      runtimeCommand({
        commandId: "command_gate",
        intent: "evaluate-gate",
        payload: {
          phase: runtimeFixture.phase,
          ...candidateGateBindings(candidate),
          dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
          gateDefinition,
          readings: [reading],
        },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
      admission.at(),
    );
    expect(gate.status).toBe("completed");

    const decision = service.submit(
      runtimeCommand({
        commandId: "command_approval",
        intent: "record-authority-decision",
        payload: { decision: "approve" },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
      admission.at(),
    );
    expect(decision.status).toBe("completed");

    const closeCommand = runtimeCommand({
      commandId: "command_close",
      intent: "close-phase",
      payload: {},
      expectedGraphRevision: graph.revisionDigest,
      exactObjectDigest: candidate.candidateDigest,
    });
    const closure = service.submit(closeCommand, admission.at());
    expect(closure.status).toBe("completed");
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({
      status: "closed",
      records: { closureDigest: (closure.result as { closureDigest: string }).closureDigest },
    });

    const history = service.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(history.map((receipt) => receipt.status)).toEqual(
      Array.from({ length: 5 }, () => ["queued", "claimed", "completed"]).flat(),
    );
    expect(history.map((receipt) => receipt.cursor)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    expect(
      service.queryReceiptPage(runtimeFixture.repositoryId, runtimeFixture.runId, 0, 4),
    ).toEqual(
      expect.objectContaining({
        afterCursor: 0,
        latestCursor: 15,
        hasMore: true,
        receipts: history.slice(0, 4),
      }),
    );
    expect(
      service.queryReceiptPage(runtimeFixture.repositoryId, runtimeFixture.runId, 4, 11),
    ).toEqual(
      expect.objectContaining({
        afterCursor: 4,
        latestCursor: 15,
        hasMore: false,
        receipts: history.slice(4),
      }),
    );
    expect(service.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId, 12)).toHaveLength(
      3,
    );
    const eventPage = service.queryEventPage(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      12,
      2,
    );
    expect(eventPage).toEqual(
      expect.objectContaining({
        afterCursor: 12,
        earliestAvailableCursor: 1,
        latestCursor: 15,
        hasMore: true,
      }),
    );
    expect(eventPage.events.map(({ cursor }) => cursor)).toEqual([13, 14]);
    expect(service.queryEventPage("repository_missing", "run_missing")).toEqual(
      expect.objectContaining({
        earliestAvailableCursor: 0,
        latestCursor: 0,
        hasMore: false,
        events: [],
      }),
    );
    const sparseService = createService();
    instantiate(sparseService, "command_sparse-terminal-page");
    const sparseRun = [...sparseService.authority.runs.values()][0];
    if (sparseRun === undefined) throw new Error("Expected sparse paging fixture run");
    sparseRun.cursor = 8;
    expect(
      sparseService.queryEventPage(runtimeFixture.repositoryId, runtimeFixture.runId, 7),
    ).toEqual(
      expect.objectContaining({
        afterCursor: 7,
        earliestAvailableCursor: 1,
        latestCursor: 8,
        hasMore: false,
        events: [],
      }),
    );
    expect(() =>
      service.queryReceiptPage(runtimeFixture.repositoryId, runtimeFixture.runId, 0, 0),
    ).toThrow(TypeError);
    expect(() =>
      service.queryEventPage(runtimeFixture.repositoryId, runtimeFixture.runId, -1, 1_025),
    ).toThrow(TypeError);
    expect(() =>
      service.queryReceiptPage(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        history.length + 1,
      ),
    ).toThrowError(expect.objectContaining<Partial<PageQueryError>>({ code: "cursor-ahead" }));
    expect(() => service.queryEventPage("repository_missing", "run_missing", 1)).toThrowError(
      expect.objectContaining<Partial<PageQueryError>>({ code: "cursor-ahead" }),
    );
    sparseRun.events.shift();
    expect(() =>
      sparseService.queryEventPage(runtimeFixture.repositoryId, runtimeFixture.runId, 0),
    ).toThrowError(expect.objectContaining<Partial<PageQueryError>>({ code: "event-replay-gap" }));

    const serialized = service.authority.toCanonicalJson();
    const restarted = createService(
      InMemoryAuthority.fromCanonicalJson(serialized, createDependencies()),
    );
    expect(restarted.authority).not.toBe(service.authority);
    expect(restarted.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
    );
    expect(restarted.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
      service.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId),
    );
    expect(restarted.submit(closeCommand, admission.at())).toEqual(closure);
    expect(restarted.authority.toCanonicalJson()).toBe(serialized);
  });

  it("refuses expired, unauthorized, and digest-mismatched commands durably", () => {
    const cases = [
      runtimeCommand({
        commandId: "command_expired",
        intent: "instantiate-run",
        payload: instantiatePayload(),
        expiresAt: "2026-08-12T11:59:59.000Z",
      }),
      runtimeCommand({
        commandId: "command_unauthorized",
        intent: "instantiate-run",
        payload: instantiatePayload(),
        roles: ["reader"],
      }),
      {
        ...runtimeCommand({
          commandId: "command_digest",
          intent: "instantiate-run",
          payload: instantiatePayload(),
        }),
        payloadDigest: "0".repeat(64),
      },
    ];

    for (const [index, command] of cases.entries()) {
      const service = createService();
      const receipt = service.submit(command, createAdmissionFixture().at());
      expect(receipt.status).toBe(index === 0 ? "expired" : "refused");
      expect(
        service.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId),
      ).toHaveLength(3);
      expect(receipt.error?.code).toBe(
        ["command-expired", "unauthorized", "payload-digest-mismatch"][index],
      );
    }
  });

  it("rolls back authoritative records when post-execution finalization fails", () => {
    let failRecordDigest = true;
    const faultingSha256 = {
      digest(bytes: Uint8Array): string {
        const content = new TextDecoder().decode(bytes);
        if (
          failRecordDigest &&
          content.includes('"runEvents"') &&
          content.includes('"approvalPolicy"')
        ) {
          failRecordDigest = false;
          throw new Error("injected record revision failure");
        }
        return deterministicSha256.digest(bytes);
      },
    };
    const authority = new InMemoryAuthority();
    const service = new RuntimeCommandService(
      { ...createDependencies(), sha256: faultingSha256 },
      authority,
    );
    const admission = createAdmissionFixture();
    const failed = service.submit(
      runtimeCommand({
        commandId: "command_faulted-instantiate",
        intent: "instantiate-run",
        payload: instantiatePayload(),
      }),
      admission.at(),
    );

    expect(failed.status).toBe("refused");
    expect(failed.error?.message).toContain("injected record revision failure");
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toBeUndefined();

    const recovered = createService(authority);
    const succeeded = recovered.submit(
      runtimeCommand({
        commandId: "command_recovered-instantiate",
        intent: "instantiate-run",
        payload: instantiatePayload(),
      }),
      admission.at(),
    );
    expect(succeeded.status).toBe("completed");
    expect(
      recovered.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toMatchObject({
      payload: { status: "awaiting-completion" },
    });

    const serialized = recovered.authority.toCanonicalJson();
    const restarted = createService(
      InMemoryAuthority.fromCanonicalJson(serialized, createDependencies()),
    );
    expect(restarted.authority.toCanonicalJson()).toBe(serialized);
    expect(restarted.queryReceipt(failed.commandId)).toEqual(failed);
    expect(restarted.queryReceipt(succeeded.commandId)).toEqual(succeeded);
  });

  it("enforces graph, definition, and exact candidate guards", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);

    const staleGraph = service.submit(
      runtimeCommand({
        commandId: "command_stale-graph",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: "f".repeat(64),
      }),
      admission.at(),
    );
    expect(staleGraph.error?.code).toBe("stale-graph");

    const staleDefinition = service.submit(
      runtimeCommand({
        commandId: "command_stale-definition",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: "e".repeat(64),
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    expect(staleDefinition.error?.code).toBe("stale-definition");

    const unknownPayloadField = service.submit(
      runtimeCommand({
        commandId: "command_invalid-payload",
        intent: "submit-completion",
        payload: { ...completionPayload(), mutableStatus: "completed" },
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    expect(unknownPayloadField.error?.code).toBe("invalid-payload");

    const completion = service.submit(
      runtimeCommand({
        commandId: "command_valid-completion",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    const assessment = (completion.result as unknown as { assessment: AccountingAssessment })
      .assessment;
    const { candidate, gateDefinition, reading } = acceptedCandidate(graph, assessment);
    const staleCandidate = service.submit(
      runtimeCommand({
        commandId: "command_stale-candidate",
        intent: "evaluate-gate",
        payload: {
          phase: runtimeFixture.phase,
          ...candidateGateBindings(candidate),
          dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
          gateDefinition,
          readings: [reading],
        },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: "d".repeat(64),
      }),
      admission.at(),
    );
    expect(staleCandidate.error?.code).toBe("stale-object");
  });

  it("returns exact replay receipts and refuses changed reuse without replacing authority", () => {
    const service = createService();
    const { admission, command, receipt } = instantiate(service);
    const before = service.authority.toCanonicalJson();

    expect(service.submit(command, admission.at())).toEqual(receipt);
    expect(service.authority.toCanonicalJson()).toBe(before);

    const conflict = service.submit(
      runtimeCommand({
        commandId: command.commandId,
        intent: "instantiate-run",
        payload: { ...instantiatePayload(), escalationPolicyDigest: "d".repeat(64) },
      }),
      admission.at(),
    );
    expect(conflict.status).toBe("refused");
    expect(conflict.error?.code).toBe("command-id-conflict");
    expect(service.queryReceipt(command.commandId)).toEqual(receipt);
    expect(service.authority.toCanonicalJson()).toBe(before);
  });

  it("rejects an altered completed command or its persisted outcome", () => {
    const service = createService();
    instantiate(service);

    const alteredCommand = parseSnapshot(service.authority.toCanonicalJson());
    const storedCommand = alteredCommand.runs[0]?.commands[0];
    if (storedCommand === undefined) throw new Error("Expected a stored command fixture");
    const envelope = JSON.parse(storedCommand.canonicalEnvelope) as Record<string, unknown>;
    const payload = envelope.payload as Record<string, unknown>;
    payload.escalationPolicyDigest = "d".repeat(64);
    envelope.payloadDigest = deterministicSha256.digest(canonicalBytes(payload));
    storedCommand.canonicalEnvelope = canonicalStringify(envelope);
    expect(() => restore(alteredCommand)).toThrow(/replay/);

    const alteredOutcome = parseSnapshot(service.authority.toCanonicalJson());
    const outcomeCommand = alteredOutcome.runs[0]?.commands[0];
    const terminalReceipt = alteredOutcome.runs[0]?.receiptHistory[2];
    if (outcomeCommand === undefined || terminalReceipt === undefined) {
      throw new Error("Expected completed command history fixture");
    }
    const changedResult = { graphRevision: "e".repeat(64) };
    outcomeCommand.receipt.result = changedResult;
    terminalReceipt.result = changedResult;
    expect(() => restore(alteredOutcome)).toThrow(/receipt|replay/);
  });

  it("rejects completed commands altered to be expired or unauthorized", () => {
    const service = createService();
    instantiate(service);

    for (const alteration of ["expired", "unauthorized"] as const) {
      const snapshot = parseSnapshot(service.authority.toCanonicalJson());
      const stored = snapshot.runs[0]?.commands[0];
      if (stored === undefined) throw new Error("Expected a stored command fixture");
      const envelope = JSON.parse(stored.canonicalEnvelope) as Record<string, unknown>;
      if (alteration === "expired") {
        envelope.expiresAt = "2026-08-12T11:59:59.000Z";
      } else {
        const principal = envelope.principal as Record<string, unknown>;
        principal.roles = ["reader"];
      }
      stored.canonicalEnvelope = canonicalStringify(envelope);
      expect(() => restore(snapshot)).toThrow(/receipt|authorization|replay/);
    }
  });

  it("rejects duplicate run keys and multiple runs for one repository", () => {
    const first = independentRunSnapshot({
      repositoryId: "repository_first",
      runId: "run_first",
      commandId: "command_first",
      eventPrefix: "first-event",
    });
    const duplicateRun = structuredClone(first);
    duplicateRun.runs.push(structuredClone(duplicateRun.runs[0] as SnapshotRun));
    expect(() => restore(duplicateRun)).toThrow("duplicate run keys");

    const second = independentRunSnapshot({
      repositoryId: "repository_first",
      runId: "run_second",
      commandId: "command_second",
      eventPrefix: "second-event",
    });
    const sameRepository = structuredClone(first);
    sameRepository.runs.push(second.runs[0] as SnapshotRun);
    expect(() => restore(sameRepository)).toThrow("multiple runs for one repository");
  });

  it("rejects globally duplicate command and stream event identities", () => {
    const first = independentRunSnapshot({
      repositoryId: "repository_first",
      runId: "run_first",
      commandId: "command_duplicate",
      eventPrefix: "shared-event",
    });
    const duplicateCommand = independentRunSnapshot({
      repositoryId: "repository_second",
      runId: "run_second",
      commandId: "command_duplicate",
      eventPrefix: "other-event",
    });
    const commandSnapshot = structuredClone(first);
    commandSnapshot.runs.push(duplicateCommand.runs[0] as SnapshotRun);
    expect(() => restore(commandSnapshot)).toThrow("duplicate command identities");

    const duplicateEvent = independentRunSnapshot({
      repositoryId: "repository_second",
      runId: "run_second",
      commandId: "command_other",
      eventPrefix: "shared-event",
    });
    const eventSnapshot = structuredClone(first);
    eventSnapshot.runs.push(duplicateEvent.runs[0] as SnapshotRun);
    expect(() => restore(eventSnapshot)).toThrow("duplicate stream event identities");
  });

  it("rejects unknown runtime records fields", () => {
    const service = createService();
    instantiate(service);
    const snapshot = parseSnapshot(service.authority.toCanonicalJson());
    const records = snapshot.runs[0]?.records;
    if (records === undefined) throw new Error("Expected runtime records fixture");
    records.mutableStatus = "completed";
    expect(() => restore(snapshot)).toThrow("runtime run records fields must be exactly");
  });

  it("rejects forged non-effect receipt, event, and allocation histories", () => {
    const service = createService();
    const expired = runtimeCommand({
      commandId: "command_restore-expired",
      intent: "instantiate-run",
      payload: instantiatePayload(),
      expiresAt: "2026-08-12T11:59:59.000Z",
    });
    expect(service.submit(expired, createAdmissionFixture().at()).status).toBe("expired");

    const forgedReceipt = parseSnapshot(service.authority.toCanonicalJson());
    const queued = forgedReceipt.runs[0]?.receiptHistory[0];
    if (queued === undefined) throw new Error("Expected queued receipt fixture");
    queued.result = { forged: true };
    expect(() => restore(forgedReceipt)).toThrow(/history|receipt|reconstruction/);

    const forgedEvent = parseSnapshot(service.authority.toCanonicalJson());
    const event = forgedEvent.runs[0]?.events[0];
    if (event === undefined) throw new Error("Expected queued event fixture");
    event.eventType = "command-completed";
    event.payload = { status: "completed" };
    event.payloadDigest = deterministicSha256.digest(canonicalBytes(event.payload));
    expect(() => restore(forgedEvent)).toThrow(/event|history|reconstruction/);

    const unusedAllocation = parseSnapshot(service.authority.toCanonicalJson());
    const stored = unusedAllocation.runs[0]?.commands[0];
    if (stored?.admission?.allocations === undefined) {
      throw new Error("Expected stored admission fixture");
    }
    stored.admission.allocations.push({ kind: "approval", id: "approval_unused" });
    expect(() => restore(unusedAllocation)).toThrow(/three stream event allocations/);

    const forgedTerminal = parseSnapshot(service.authority.toCanonicalJson());
    const forgedStored = forgedTerminal.runs[0]?.commands[0];
    const forgedHistoryTerminal = forgedTerminal.runs[0]?.receiptHistory[2];
    if (forgedStored === undefined || forgedHistoryTerminal === undefined) {
      throw new Error("Expected terminal refusal fixture");
    }
    for (const receipt of [forgedStored.receipt, forgedHistoryTerminal]) {
      receipt.error = {
        apiVersion: PROTOCOL_VERSION,
        code: "forged-terminal-cause",
        message: "Forged terminal semantics",
        retryable: false,
        commandId: "command_restore-expired",
      };
    }
    expect(() => restore(forgedTerminal)).toThrow(
      /deterministic refusal|receipt or authorization decision/u,
    );
  });

  it("rejects malformed and oversized protocol inputs before creating receipts", () => {
    const service = createService();
    const command = runtimeCommand({
      commandId: "command_invalid",
      intent: "instantiate-run",
      payload: instantiatePayload(),
    });
    expect(() =>
      service.submit(
        { ...command, alternatePrincipal: "user_other" },
        createAdmissionFixture().at(),
      ),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      service.submit(
        {
          ...command,
          commandId: "command_oversized",
          payload: "x".repeat(PROTOCOL_LIMITS.maxWireBytes),
        },
        createAdmissionFixture().at(),
      ),
    ).toThrow(ProtocolValidationError);
    expect(service.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
      [],
    );
  });

  it("preflights supplied receipt event identities before admission", () => {
    const service = createService();
    const before = service.authority.toCanonicalJson();
    const command = runtimeCommand({
      commandId: "command_duplicate-events",
      intent: "instantiate-run",
      payload: instantiatePayload(),
    });
    expect(() =>
      service.submit(command, {
        currentTime: runtimeFixture.currentTime,
        facts: {},
        allocateId: () => "stream-event-duplicate",
      }),
    ).toThrow("Allocated stream event identities must be globally unique");
    expect(service.queryReceiptHistory(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
      [],
    );
    expect(service.authority.toCanonicalJson()).toBe(before);
  });

  it("accepts an exact graph revision before lifecycle records exist", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);
    const revisedGraph = createRuntimeGraph(2);
    const receipt = service.submit(
      runtimeCommand({
        commandId: "command_revision",
        intent: "accept-graph-revision",
        payload: { workflowId: runtimeFixture.workflowId, graph: revisedGraph },
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    expect(receipt.status).toBe("completed");
    expect(receipt.result).toEqual({ graphRevision: revisedGraph.revisionDigest });
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({
      status: "awaiting-completion",
    });
  });

  it("binds one active run identity to one repository authority", () => {
    const service = createService();
    const { admission } = instantiate(service);
    const otherRun = {
      ...runtimeCommand({
        commandId: "command_other-run",
        intent: "instantiate-run",
        payload: instantiatePayload(),
      }),
      runId: "run_other",
    };
    const repositoryConflict = service.submit(otherRun, admission.at());
    expect(repositoryConflict.error?.code).toBe("repository-run-conflict");

    const otherRepository = {
      ...runtimeCommand({
        commandId: "command_other-repository",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: createRuntimeGraph().revisionDigest,
      }),
      repositoryId: "repository_other",
    };
    const runMismatch = service.submit(otherRepository, admission.at());
    expect(runMismatch.error?.code).toBe("run-repository-mismatch");

    const serialized = service.authority.toCanonicalJson();
    const restarted = createService(
      InMemoryAuthority.fromCanonicalJson(serialized, createDependencies()),
    );
    expect(restarted.queryReceipt(otherRun.commandId)).toEqual(repositoryConflict);
    expect(restarted.queryReceipt(otherRepository.commandId)).toEqual(runMismatch);
    expect(restarted.authority.toCanonicalJson()).toBe(serialized);
  });

  it("records, approves, and applies an exact amendment with replay-equivalent projections", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);
    const proposal = amendmentProposal(graph, "audit");

    const submitted = submitProposal(service, admission, proposal, "command_amendment-submit");
    expect(submitted.status).toBe("completed");
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({
      amendments: [{ amendmentId: proposal.amendmentId, status: "reviewable" }],
      phaseLifecycles: [{ phase: runtimeFixture.phase }],
    });

    const duplicate = submitProposal(service, admission, proposal, "command_amendment-duplicate");
    expect(duplicate.error?.code).toBe("amendment-proposal-exists");

    // The engine may decide a plan import, because a fan-out is the shape the
    // author declared. Anything else changes a graph nobody agreed to change.
    const engineDecision = service.submit(
      runtimeCommand({
        commandId: "command_amendment-engine-approve",
        intent: "record-amendment-decision",
        roles: ["engine"],
        payload: {
          amendmentId: proposal.amendmentId,
          proposalDigest: proposal.proposalDigest,
          decision: "approve",
          reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: proposal.baseGraph.revisionDigest,
        exactObjectDigest: proposal.proposalDigest,
      }),
      admission.at("2026-08-13T12:00:30.000Z"),
    );
    expect(engineDecision.error?.code).toBe("release-manager-required");

    const decision = service.submit(
      runtimeCommand({
        commandId: "command_amendment-approve",
        intent: "record-amendment-decision",
        payload: {
          amendmentId: proposal.amendmentId,
          proposalDigest: proposal.proposalDigest,
          decision: "approve",
          reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: proposal.baseGraph.revisionDigest,
        exactObjectDigest: proposal.proposalDigest,
      }),
      admission.at("2026-08-13T12:01:00.000Z"),
    );
    expect(decision.status).toBe("completed");
    const decisionRecord = decision.result as { decisionDigest: string };
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({ amendments: [{ status: "approved-awaiting-quiescence" }] });

    const quiescence = createAmendmentQuiescenceFact(
      {
        occurredAt: "2026-08-13T12:02:00.000Z",
        affectedTaskScopes: proposal.impact.affectedTaskScopes,
        liveClaimCount: 0,
        nonterminalEffectCount: 0,
      },
      proposal,
      deterministicSha256,
    );
    const untrustedApply = service.submit(
      runtimeCommand({
        commandId: "command_amendment-untrusted-apply",
        intent: "apply-approved-amendment",
        payload: {
          amendmentId: proposal.amendmentId,
          proposalDigest: proposal.proposalDigest,
          decisionDigest: decisionRecord.decisionDigest,
          reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: proposal.baseGraph.revisionDigest,
        exactObjectDigest: decisionRecord.decisionDigest,
      }),
      admission.at("2026-08-13T12:02:30.000Z"),
    );
    expect(untrustedApply.error?.code).toBe("unauthorized");
    const applied = service.submitWithTrustedFacts(
      runtimeCommand({
        commandId: "command_amendment-apply",
        intent: "apply-approved-amendment",
        payload: {
          amendmentId: proposal.amendmentId,
          proposalDigest: proposal.proposalDigest,
          decisionDigest: decisionRecord.decisionDigest,
          reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: proposal.baseGraph.revisionDigest,
        exactObjectDigest: decisionRecord.decisionDigest,
        roles: ["trusted-supervisor"],
      }),
      admission.at("2026-08-13T12:03:00.000Z"),
      { amendmentQuiescence: quiescence },
    );
    expect(applied.status).toBe("completed");
    expect(applied.result).toMatchObject({
      graphRevision: proposal.reviewedResultGraph.revisionDigest,
      application: { graph: proposal.reviewedResultGraph },
    });
    const projection = service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(projection?.payload).toMatchObject({
      amendments: [{ status: "applied" }],
      amendmentEventDigests: expect.arrayContaining([expect.any(String)]),
    });

    const serialized = service.authority.toCanonicalJson();
    const restarted = createService(
      InMemoryAuthority.fromCanonicalJson(serialized, createDependencies()),
    );
    expect(restarted.authority.toCanonicalJson()).toBe(serialized);
    expect(restarted.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)).toEqual(
      projection,
    );
  });

  it("allows unrelated phase candidate progress while an additive phase proposal is pending", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);
    const proposal = createAmendmentProposal(
      {
        source: { kind: "human", request: "release" },
        baseGraph: graph,
        baseContextDigest: runtimeFixture.task.contextRevisionDigest,
        baseConfigurationSnapshotDigest: sha256Digest("d".repeat(64)),
        resultConfigurationSnapshotDigest: sha256Digest("e".repeat(64)),
        operations: [
          {
            kind: "add-phase",
            phase: {
              id: phaseId("phase_release"),
              key: consumerKey("release"),
              generation: definitionGeneration(1),
              parentId: graph.workflowId,
              source: { locator: "fixture://amendment", pointer: "/phases/release" },
            },
          },
        ],
        phaseCandidateHistory: [],
      },
      deterministicSha256,
    );
    expect(submitProposal(service, admission, proposal, "command_amendment-add-phase").status).toBe(
      "completed",
    );

    const completion = service.submit(
      runtimeCommand({
        commandId: "command_amendment-unrelated-completion",
        intent: "submit-completion",
        payload: completionPayload(),
        expectedDefinitionRevision: runtimeFixture.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      admission.at(),
    );
    const assessment = (completion.result as unknown as { assessment: AccountingAssessment })
      .assessment;
    const { candidate, gateDefinition, reading } = acceptedCandidate(graph, assessment);
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_amendment-unrelated-gate",
          intent: "evaluate-gate",
          payload: {
            phase: runtimeFixture.phase,
            ...candidateGateBindings(candidate),
            dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
            gateDefinition,
            readings: [reading],
          },
          expectedGraphRevision: graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
        admission.at(),
      ).status,
    ).toBe("completed");
    expect(
      service.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({ amendments: [{ status: "reviewable" }], status: "awaiting-approval" });
  });

  it("enforces overlap, withdrawal, decision, stale, and quiescence races", () => {
    const service = createService();
    const { graph, admission } = instantiate(service);
    const first = amendmentProposal(graph, "audit");
    const second = amendmentProposal(graph, "package");
    expect(submitProposal(service, admission, first, "command_amendment-first").status).toBe(
      "completed",
    );
    expect(submitProposal(service, admission, second, "command_amendment-second").status).toBe(
      "completed",
    );

    const proposalConflict = service.submit(
      runtimeCommand({
        commandId: "command_amendment-proposal-conflict",
        intent: "withdraw-amendment-proposal",
        payload: { amendmentId: first.amendmentId, proposalDigest: "f".repeat(64) },
        exactObjectDigest: first.proposalDigest,
      }),
      admission.at("2026-08-13T12:03:00.000Z"),
    );
    expect(proposalConflict.error?.code).toBe("amendment-proposal-conflict");
    const resultConflict = service.submit(
      runtimeCommand({
        commandId: "command_amendment-result-conflict",
        intent: "record-amendment-decision",
        payload: {
          amendmentId: first.amendmentId,
          proposalDigest: first.proposalDigest,
          decision: "approve",
          reviewedResultGraphRevisionDigest: "f".repeat(64),
        },
        expectedGraphRevision: first.baseGraph.revisionDigest,
        exactObjectDigest: first.proposalDigest,
      }),
      admission.at("2026-08-13T12:03:30.000Z"),
    );
    expect(resultConflict.error?.code).toBe("stale-result-graph");

    const overlappingApproval = decideAmendment(
      service,
      admission,
      first,
      "approve",
      "command_amendment-overlap",
    );
    expect(overlappingApproval.error?.code).toBe("overlapping-proposal");
    const withdrawal = service.submit(
      runtimeCommand({
        commandId: "command_amendment-withdraw",
        intent: "withdraw-amendment-proposal",
        payload: { amendmentId: second.amendmentId, proposalDigest: second.proposalDigest },
        exactObjectDigest: second.proposalDigest,
      }),
      admission.at("2026-08-13T12:04:00.000Z"),
    );
    expect(withdrawal.status).toBe("completed");
    const approved = decideAmendment(
      service,
      admission,
      first,
      "approve",
      "command_amendment-approved",
    );
    expect(approved.status).toBe("completed");
    expect(
      service.submit(
        runtimeCommand({
          commandId: "command_amendment-late-withdraw",
          intent: "withdraw-amendment-proposal",
          payload: { amendmentId: first.amendmentId, proposalDigest: first.proposalDigest },
          exactObjectDigest: first.proposalDigest,
        }),
        admission.at("2026-08-13T12:05:00.000Z"),
      ).error?.code,
    ).toBe("conflicting-lifecycle");

    const decisionRecord = approved.result as { decisionDigest: string };
    const busy = createAmendmentQuiescenceFact(
      {
        occurredAt: "2026-08-13T12:06:00.000Z",
        affectedTaskScopes: first.impact.affectedTaskScopes,
        liveClaimCount: 1,
        nonterminalEffectCount: 0,
      },
      first,
      deterministicSha256,
    );
    const nonquiescent = service.submitWithTrustedFacts(
      runtimeCommand({
        commandId: "command_amendment-busy-apply",
        intent: "apply-approved-amendment",
        payload: {
          amendmentId: first.amendmentId,
          proposalDigest: first.proposalDigest,
          decisionDigest: decisionRecord.decisionDigest,
          reviewedResultGraphRevisionDigest: first.reviewedResultGraph.revisionDigest,
        },
        expectedGraphRevision: first.baseGraph.revisionDigest,
        exactObjectDigest: decisionRecord.decisionDigest,
        roles: ["trusted-supervisor"],
      }),
      admission.at("2026-08-13T12:07:00.000Z"),
      { amendmentQuiescence: busy },
    );
    expect(nonquiescent.error?.code).toBe("invalid-quiescence");

    const staleService = createService();
    const staleRun = instantiate(staleService, "command_stale-amendment-run");
    const staleProposal = amendmentProposal(staleRun.graph, "audit");
    submitProposal(
      staleService,
      staleRun.admission,
      staleProposal,
      "command_stale-amendment-submit",
    );
    const revisedGraph = createRuntimeGraph(2);
    expect(
      staleService.submit(
        runtimeCommand({
          commandId: "command_stale-amendment-revision",
          intent: "accept-graph-revision",
          payload: { workflowId: runtimeFixture.workflowId, graph: revisedGraph },
          expectedGraphRevision: staleRun.graph.revisionDigest,
        }),
        staleRun.admission.at(),
      ).status,
    ).toBe("completed");
    expect(
      staleService.queryProjection(runtimeFixture.repositoryId, runtimeFixture.runId)?.payload,
    ).toMatchObject({ amendments: [{ status: "stale" }] });
    expect(
      decideAmendment(
        staleService,
        staleRun.admission,
        staleProposal,
        "approve",
        "command_stale-amendment-approve",
      ).error?.code,
    ).toBe("stale-base");
    expect(
      decideAmendment(
        staleService,
        staleRun.admission,
        staleProposal,
        "reject",
        "command_stale-amendment-reject",
      ).status,
    ).toBe("completed");
  });
});

function amendmentProposal(graph: ReturnType<typeof createRuntimeGraph>, suffix: string) {
  return createAmendmentProposal(
    {
      source: { kind: "human", request: suffix },
      baseGraph: graph,
      baseContextDigest: runtimeFixture.task.contextRevisionDigest,
      baseConfigurationSnapshotDigest: sha256Digest("d".repeat(64)),
      resultConfigurationSnapshotDigest: sha256Digest("e".repeat(64)),
      operations: [
        {
          kind: "add-task",
          task: {
            id: taskId(`task_${suffix}`),
            key: consumerKey(suffix),
            generation: definitionGeneration(1),
            parentId: runtimeFixture.phase.phaseId,
            dependsOn: [runtimeFixture.task.taskId],
            source: { locator: "fixture://amendment", pointer: `/tasks/${suffix}` },
            completionPolicy: {
              criteria: [],
              completionEvidencePolicy: { mode: "none", requirements: [] },
            },
          },
          criteria: [],
        },
      ],
      phaseCandidateHistory: [],
    },
    deterministicSha256,
  );
}

function submitProposal(
  service: RuntimeCommandService,
  admission: ReturnType<typeof createAdmissionFixture>,
  proposal: ReturnType<typeof amendmentProposal>,
  commandId: string,
) {
  return service.submit(
    runtimeCommand({
      commandId,
      intent: "submit-amendment-proposal",
      payload: { proposal },
      expectedGraphRevision: proposal.baseGraph.revisionDigest,
      exactObjectDigest: proposal.proposalDigest,
    }),
    admission.at("2026-08-13T12:00:00.000Z"),
  );
}

function decideAmendment(
  service: RuntimeCommandService,
  admission: ReturnType<typeof createAdmissionFixture>,
  proposal: ReturnType<typeof amendmentProposal>,
  decision: "approve" | "reject",
  commandId: string,
) {
  return service.submit(
    runtimeCommand({
      commandId,
      intent: "record-amendment-decision",
      payload: {
        amendmentId: proposal.amendmentId,
        proposalDigest: proposal.proposalDigest,
        decision,
        reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
      },
      expectedGraphRevision: proposal.baseGraph.revisionDigest,
      exactObjectDigest: proposal.proposalDigest,
    }),
    admission.at("2026-08-13T12:04:30.000Z"),
  );
}

function instantiatePayload() {
  return {
    workflowId: runtimeFixture.workflowId,
    configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
    execution: runtimeFixture.execution,
    graph: createRuntimeGraph(),
    phase: runtimeFixture.phase,
    approvalPolicy: { policy: "approval-required" as const, authority: runtimePrincipal },
    escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
    allowancePolicy: runtimeFixture.allowancePolicy,
  };
}

const trustedSupervisorPrincipal = Object.freeze({
  ...runtimePrincipal,
  subject: "trusted_supervisor",
  roles: Object.freeze(["trusted-supervisor"]),
});

function integrationBarrier(graph: ReturnType<typeof createRuntimeGraph>) {
  const beforeRevision = {
    commit: { objectFormat: "sha1" as const, oid: "1".repeat(40) },
    tree: { objectFormat: "sha1" as const, oid: "2".repeat(40) },
  };
  const afterRevision = {
    commit: { objectFormat: "sha1" as const, oid: "3".repeat(40) },
    tree: { objectFormat: "sha1" as const, oid: "4".repeat(40) },
  };
  return createIntegrationBarrier(
    {
      phaseId: runtimeFixture.phase.phaseId,
      definitionGeneration: runtimeFixture.phase.definitionGeneration,
      graphRevisionDigest: graph.revisionDigest,
      targetRef: "refs/heads/senawa/integration",
      beforeRevision,
      afterRevision,
      members: [
        {
          taskId: runtimeFixture.task.taskId,
          definitionGeneration: runtimeFixture.task.definitionGeneration,
          contextDigest: runtimeFixture.task.contextRevisionDigest,
          baseRevisionDigest: bindGitRevision(beforeRevision, deterministicSha256).descriptorDigest,
          resultTreeDigest: bindGitObjectId(afterRevision.tree, deterministicSha256)
            .descriptorDigest,
          completionFactDigest: sha256Digest("5".repeat(64)),
        },
      ],
      gatePolicyDigest: sha256Digest("6".repeat(64)),
      gateReadingDigest: sha256Digest("7".repeat(64)),
      gateEvaluationDigest: sha256Digest("8".repeat(64)),
      outcome: "integrated",
    },
    deterministicSha256,
  );
}
