import {
  type AccountingAssessment,
  consumerKey,
  createPhaseCandidate,
  createSensorReading,
  defineGate,
  digestAccountingAssessment,
  digestSelectedTaskSet,
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
] as const;

function createDependencies(): RuntimeDependencies {
  return {
    sha256: deterministicSha256,
    authorization: createRoleAuthorizationPolicy(
      ALLOWED_INTENTS.map((intent) => ({ intent, roles: ["release-manager"] })),
    ),
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
      graph,
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
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
      evidence: [],
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
      graphRevisionDigest: graph.revisionDigest,
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

describe("transport-independent runtime command conformance", () => {
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
    expect(service.queryEvents(runtimeFixture.repositoryId, runtimeFixture.runId, 12)).toHaveLength(
      3,
    );

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
    const { gateDefinition, reading } = acceptedCandidate(graph, assessment);
    const staleCandidate = service.submit(
      runtimeCommand({
        commandId: "command_stale-candidate",
        intent: "evaluate-gate",
        payload: {
          phase: runtimeFixture.phase,
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
    expect(() => restore(forgedTerminal)).toThrow(/deterministic refusal/);
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
  });
});

function instantiatePayload() {
  return {
    workflowId: runtimeFixture.workflowId,
    graph: createRuntimeGraph(),
    phase: runtimeFixture.phase,
    approvalPolicy: { policy: "approval-required" as const, authority: runtimePrincipal },
    escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
  };
}
