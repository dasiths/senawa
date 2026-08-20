import type { Escalation } from "@senawa/kernel";
import {
  type AcceptedAccountingAssessment,
  type AmendmentApplication,
  type AmendmentDecision,
  type AmendmentLifecycleProjection,
  type AmendmentProposal,
  type AmendmentQuiescenceFact,
  type AmendmentWithdrawal,
  type AuthorityDecision,
  applyApprovedAmendment,
  approvalId,
  assessCompletionAccounting,
  type CompletionSubmission,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  closePhase,
  createAmendmentDecision,
  createAmendmentWithdrawal,
  createAuthorityDecision,
  createEscalation,
  createPhaseCandidate,
  decideRunCommand,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestRunEventContent,
  digestSelectedTaskSet,
  escalationId,
  evaluateGate,
  eventId,
  type GateEvidence,
  type IntegrationBarrier,
  isSha256Digest,
  type PhaseApprovalPolicyInput,
  type PhaseCandidate,
  type PhaseClosure,
  type PhaseGenerationReference,
  type PhaseLifecycleProjection,
  projectAmendmentLifecycle,
  projectPhaseLifecycle,
  type RunEvent,
  replayRunEvents,
  runId,
  type SensorReading,
  type Sha256Digest,
  type TaskGenerationReference,
  validateAmendmentProposal,
  validateGateDefinition,
  validateGateEvidence,
  validateIntegrationBarrier,
  validatePhaseCandidate,
  validateWorkflowGraph,
  type WorkflowGraph,
  workflowId,
} from "@senawa/kernel";
import {
  type AuthenticatedPrincipal,
  type CommandEnvelope,
  type CommandIntent,
  canonicalBytes,
  canonicalStringify,
  type DurableReceipt,
  decodeApplyApprovedAmendmentPayload,
  decodeCommandEnvelope,
  decodeDurableReceipt,
  decodeEventReplayPage,
  decodeEventStreamFrame,
  decodeImportPlanPayload,
  decodeProjectionEnvelope,
  decodeReceiptPage,
  decodeRecordAmendmentDecisionPayload,
  decodeRecordFanOutDiffDecisionPayload,
  decodeRecordIntegrationBarrierPayload,
  decodeRecordPhaseAttemptTransitionPayload,
  decodeStartPhaseAttemptPayload,
  decodeSubmitAmendmentProposalPayload,
  decodeWithdrawAmendmentProposalPayload,
  type ErrorEnvelope,
  type EventReplayPage,
  type EventStreamFrame,
  type JsonValue,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  type ReceiptPage,
  type ReceiptStatus,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import {
  type AdmissionFacts,
  type AllocationKind,
  type AuthorityPort,
  type AuthorizationPolicy,
  type CommandServicePort,
  PageQueryError,
  type RuntimeDependencies,
  type RuntimeQueryPort,
  type SerializableAuthorityPort,
} from "./ports.js";
import type {
  ParallelExecutionPolicy,
  RunExecutionBinding,
  RunnerAllowancePolicy,
} from "./workspace-authority.js";

const SNAPSHOT_VERSION = "senawa.dev/runtime-memory/v1" as const;

export interface RoleAuthorizationRule {
  readonly intent: CommandIntent["type"];
  readonly roles: readonly string[];
}

export function createRoleAuthorizationPolicy(
  rules: readonly RoleAuthorizationRule[],
): AuthorizationPolicy {
  const rolesByIntent = new Map<CommandIntent["type"], ReadonlySet<string>>();
  for (const rule of rules) {
    if (rolesByIntent.has(rule.intent)) {
      throw new TypeError(`Authorization intent ${rule.intent} is configured more than once`);
    }
    rolesByIntent.set(rule.intent, new Set(rule.roles));
  }
  return Object.freeze({
    authorize(principal: AuthenticatedPrincipal, intent: CommandIntent): boolean {
      const allowed = rolesByIntent.get(intent.type);
      return allowed !== undefined && principal.roles.some((role) => allowed.has(role));
    },
  });
}

interface RuntimeRunRecords {
  readonly runEvents: readonly RunEvent[];
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly execution: ParallelExecutionPolicy;
  readonly phase: PhaseGenerationReference;
  readonly approvalPolicy: PhaseApprovalPolicyInput;
  readonly escalationPolicyDigest: Sha256Digest;
  readonly allowancePolicy: RunnerAllowancePolicy;
  readonly assessments: readonly AcceptedAccountingAssessment[];
  readonly candidate?: PhaseCandidate;
  readonly gateEvidence?: GateEvidence;
  readonly authorityDecision?: AuthorityDecision;
  readonly escalation?: Escalation;
  readonly closure?: PhaseClosure;
  readonly integrationBarrier?: IntegrationBarrier;
  readonly phaseLifecycles?: readonly RuntimePhaseLifecycleRecords[];
  readonly amendmentRecords?: readonly RuntimeAmendmentRecords[];
  readonly amendmentEvents?: readonly RuntimeAmendmentEvent[];
}

export interface RuntimeSchedulingSnapshot {
  readonly graph: WorkflowGraph;
  readonly phase: PhaseGenerationReference;
  readonly acceptedTasks: readonly {
    readonly task: TaskGenerationReference;
    readonly accountingAssessmentDigest: Sha256Digest;
    readonly integrationBarrierDigest?: Sha256Digest;
  }[];
}

interface RuntimePhaseLifecycleRecords {
  readonly phase: PhaseGenerationReference;
  readonly approvalPolicy: PhaseApprovalPolicyInput;
  readonly escalationPolicyDigest: Sha256Digest;
  readonly assessments: readonly AcceptedAccountingAssessment[];
  readonly candidate?: PhaseCandidate;
  readonly gateEvidence?: GateEvidence;
  readonly authorityDecision?: AuthorityDecision;
  readonly escalation?: Escalation;
  readonly closure?: PhaseClosure;
}

interface RuntimeAmendmentRecords {
  readonly proposal: AmendmentProposal;
  readonly decision?: AmendmentDecision;
  readonly withdrawal?: AmendmentWithdrawal;
  readonly application?: AmendmentApplication;
}

type RuntimeAmendmentEventType =
  | "amendment-proposal-submitted"
  | "amendment-proposal-withdrawn"
  | "amendment-decision-recorded"
  | "amendment-fencing-required"
  | "approved-amendment-applied";

interface RuntimeAmendmentEvent {
  readonly type: RuntimeAmendmentEventType;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: import("@senawa/kernel").CanonicalValue;
  readonly eventDigest: Sha256Digest;
}

type RuntimeAmendmentAggregate = RuntimeRunRecords & {
  readonly phaseLifecycles: readonly RuntimePhaseLifecycleRecords[];
  readonly amendmentRecords: readonly RuntimeAmendmentRecords[];
  readonly amendmentEvents: readonly RuntimeAmendmentEvent[];
};

interface StoredCommand {
  readonly canonicalEnvelope: string;
  readonly receipt: DurableReceipt;
  readonly admission: StoredAdmission;
}

interface StoredAllocation {
  readonly kind: AllocationKind;
  readonly id: string;
}

interface StoredAdmission {
  readonly currentTime: string;
  readonly facts: JsonValue;
  readonly authorizationDecision: boolean;
  readonly allocations: readonly StoredAllocation[];
  readonly trustedAmendmentQuiescence?: AmendmentQuiescenceFact;
  readonly trustedHumanAuthority?: TrustedHumanAuthorityDecision;
}

export interface TrustedRuntimeCommandFacts {
  readonly amendmentQuiescence?: AmendmentQuiescenceFact;
  readonly humanAuthority?: TrustedHumanAuthorityDecision;
}

export interface TrustedHumanAuthorityDecision {
  readonly result?: JsonValue;
  readonly refusal?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface RuntimeAuthorityRun {
  repositoryId: string;
  runId: string;
  cursor: number;
  commands: Map<string, StoredCommand>;
  receiptHistory: DurableReceipt[];
  events: EventStreamFrame[];
  records?: RuntimeRunRecords;
  projectionGeneratedAt?: string;
}

interface SerializedRun {
  readonly repositoryId: string;
  readonly runId: string;
  readonly cursor: number;
  readonly commands: readonly {
    readonly commandId: string;
    readonly canonicalEnvelope: string;
    readonly receipt: DurableReceipt;
    readonly admission: StoredAdmission;
  }[];
  readonly receiptHistory: readonly DurableReceipt[];
  readonly events: readonly EventStreamFrame[];
  readonly records?: RuntimeRunRecords;
  readonly projectionGeneratedAt?: string;
}

export class InMemoryAuthority
  implements AuthorityPort<RuntimeAuthorityRun>, SerializableAuthorityPort
{
  readonly runs: Map<string, RuntimeAuthorityRun>;

  constructor() {
    this.runs = new Map();
  }

  static fromCanonicalJson(
    serialized: string,
    dependencies: RuntimeDependencies,
  ): InMemoryAuthority {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new TypeError("Runtime authority snapshot must contain valid canonical JSON");
    }
    if (canonicalSerialize(canonicalValue(parsed)) !== serialized) {
      throw new TypeError("Runtime authority snapshot must use canonical JSON encoding");
    }
    const snapshot = exactObject(parsed, "snapshot", ["version", "runs"]);
    if (snapshot.version !== SNAPSHOT_VERSION || !Array.isArray(snapshot.runs)) {
      throw new TypeError(`Runtime authority snapshot must use ${SNAPSHOT_VERSION}`);
    }
    const runs = snapshot.runs.map((run) => parseSerializedRun(run, dependencies));
    validateSnapshotUniqueness(runs);
    const authority = new InMemoryAuthority();
    const service = new RuntimeCommandService(dependencies, authority);
    for (const run of runs) replaySerializedRun(service, run, runs);
    if (authority.toCanonicalJson() !== serialized) {
      throw new TypeError("Runtime authority snapshot does not equal deterministic command replay");
    }
    return authority;
  }

  toCanonicalJson(): string {
    const runs = [...this.runs.values()]
      .sort((left, right) =>
        compareText(runKey(left.repositoryId, left.runId), runKey(right.repositoryId, right.runId)),
      )
      .map(serializeRun);
    return canonicalSerialize(canonicalValue({ version: SNAPSHOT_VERSION, runs }));
  }
}

export class RuntimeCommandService implements CommandServicePort, RuntimeQueryPort {
  readonly authority: AuthorityPort<RuntimeAuthorityRun>;
  readonly dependencies: RuntimeDependencies;

  constructor(
    dependencies: RuntimeDependencies,
    authority: AuthorityPort<RuntimeAuthorityRun> = new InMemoryAuthority(),
  ) {
    this.dependencies = dependencies;
    this.authority = authority;
    for (const run of authority.runs.values()) {
      this.validateHydratedRun(run);
    }
  }

  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt {
    return this.submitWithTrustedFacts(input, admission, {});
  }

  submitWithTrustedFacts(
    input: string | unknown,
    admission: AdmissionFacts,
    trustedFacts: TrustedRuntimeCommandFacts,
  ): DurableReceipt {
    const command = decodeCommandEnvelope(input);
    const canonicalEnvelope = canonicalStringify(command);
    validateTimestamp(admission.currentTime, "currentTime");
    const facts = canonicalValue(admission.facts) as unknown as JsonValue;
    const replay = this.findStoredCommand(command.commandId);
    if (replay !== undefined) {
      if (replay.command.canonicalEnvelope === canonicalEnvelope) {
        return replay.command.receipt;
      }
      return conflictReceipt(command, replay.run.cursor);
    }

    const allocations: StoredAllocation[] = [];
    const capturedAdmission: AdmissionFacts = {
      currentTime: admission.currentTime,
      facts,
      allocateId(kind, allocatedCommand) {
        const id = admission.allocateId(kind, allocatedCommand);
        allocations.push({ kind, id });
        return id;
      },
    };
    const authorizationDecision = this.dependencies.authorization.authorize(
      command.principal,
      command.intent,
    );
    const [queuedEventId, claimedEventId, terminalEventId] = this.allocateStreamEventIds(
      command,
      capturedAdmission,
    );
    const run = this.getOrCreateRun(command.repositoryId, command.runId);
    this.transition(run, command, capturedAdmission, queuedEventId, "queued");
    this.transition(run, command, capturedAdmission, claimedEventId, "claimed");
    const priorRevision = this.recordRevision(run.records);
    const recordsBeforeExecution = run.records;
    const projectionBeforeExecution = run.projectionGeneratedAt;

    let terminal: DurableReceipt;
    try {
      this.validateAuthorityIdentity(command, run);
      this.validateAdmission(command, capturedAdmission, authorizationDecision);
      const result = this.execute(command, capturedAdmission, run, trustedFacts);
      const resultRevision = this.recordRevision(run.records);
      terminal = this.transition(run, command, capturedAdmission, terminalEventId, "completed", {
        ...(priorRevision === undefined ? {} : { priorRevision }),
        ...(resultRevision === undefined ? {} : { resultRevision }),
        result,
      });
      run.projectionGeneratedAt = capturedAdmission.currentTime;
    } catch (error) {
      if (recordsBeforeExecution === undefined) delete run.records;
      else run.records = recordsBeforeExecution;
      if (projectionBeforeExecution === undefined) delete run.projectionGeneratedAt;
      else run.projectionGeneratedAt = projectionBeforeExecution;
      const refusal = commandRefusal(error);
      terminal = this.transition(run, command, capturedAdmission, terminalEventId, refusal.status, {
        ...(priorRevision === undefined ? {} : { priorRevision }),
        error: errorEnvelope(command, refusal.code, refusal.message, refusal.retryable),
      });
    }
    run.commands.set(command.commandId, {
      canonicalEnvelope,
      receipt: terminal,
      admission: {
        currentTime: capturedAdmission.currentTime,
        facts,
        authorizationDecision,
        allocations: allocations.map((allocation) => ({ ...allocation })),
        ...(trustedFacts.amendmentQuiescence === undefined
          ? {}
          : { trustedAmendmentQuiescence: trustedFacts.amendmentQuiescence }),
        ...(trustedFacts.humanAuthority === undefined
          ? {}
          : { trustedHumanAuthority: trustedFacts.humanAuthority }),
      },
    });
    return terminal;
  }

  queryReceipt(commandId: string): DurableReceipt | undefined {
    return this.findStoredCommand(commandId)?.command.receipt;
  }

  queryReceiptHistory(repositoryId: string, runIdentity: string): readonly DurableReceipt[] {
    return Object.freeze([
      ...(this.authority.runs.get(runKey(repositoryId, runIdentity))?.receiptHistory ?? []),
    ]);
  }

  queryReceiptPage(
    repositoryId: string,
    runIdentity: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): ReceiptPage {
    validatePageRequest(afterCursor, limit);
    const run = this.authority.runs.get(runKey(repositoryId, runIdentity));
    validatePageCursor(afterCursor, run?.cursor ?? 0);
    const matching = run?.receiptHistory.filter((receipt) => receipt.cursor > afterCursor) ?? [];
    return decodeReceiptPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId: runIdentity,
      afterCursor,
      latestCursor: run?.cursor ?? 0,
      hasMore: matching.length > limit,
      receipts: matching.slice(0, limit),
    });
  }

  queryEvents(
    repositoryId: string,
    runIdentity: string,
    afterCursor = 0,
  ): readonly EventStreamFrame[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw new TypeError("Event replay cursors must be non-negative safe integers");
    }
    const run = this.authority.runs.get(runKey(repositoryId, runIdentity));
    return Object.freeze(run?.events.filter((event) => event.cursor > afterCursor) ?? []);
  }

  queryEventPage(
    repositoryId: string,
    runIdentity: string,
    afterCursor = 0,
    limit: number = PROTOCOL_LIMITS.maxPageItems,
  ): EventReplayPage {
    validatePageRequest(afterCursor, limit);
    const run = this.authority.runs.get(runKey(repositoryId, runIdentity));
    validatePageCursor(afterCursor, run?.cursor ?? 0);
    validateReplayCursor(afterCursor, run?.events[0]?.cursor ?? 0);
    const matching = run?.events.filter((event) => event.cursor > afterCursor) ?? [];
    return decodeEventReplayPage({
      apiVersion: PROTOCOL_VERSION,
      repositoryId,
      runId: runIdentity,
      afterCursor,
      earliestAvailableCursor: run?.events[0]?.cursor ?? 0,
      latestCursor: run?.cursor ?? 0,
      hasMore: matching.length > limit,
      events: matching.slice(0, limit),
    });
  }

  queryProjection(repositoryId: string, runIdentity: string): ProjectionEnvelope | undefined {
    const run = this.authority.runs.get(runKey(repositoryId, runIdentity));
    if (run?.records === undefined || run.projectionGeneratedAt === undefined) return undefined;
    const projection = this.project(run.records);
    return decodeProjectionEnvelope({
      apiVersion: PROTOCOL_VERSION,
      cursor: run.cursor,
      repositoryId,
      runId: runIdentity,
      projectionType: "phase-lifecycle",
      revision: projection.projectionDigest,
      generatedAt: run.projectionGeneratedAt,
      payload: projection,
      payloadDigest: this.digestJson(projection),
    });
  }

  queryRunExecution(repositoryId: string, runIdentity: string): RunExecutionBinding | undefined {
    const records = this.authority.runs.get(runKey(repositoryId, runIdentity))?.records;
    return records === undefined
      ? undefined
      : Object.freeze({
          repositoryId,
          runId: runIdentity,
          configurationSnapshotDigest: records.configurationSnapshotDigest,
          execution: records.execution,
          allowancePolicy: records.allowancePolicy,
        });
  }

  queryIntegrationBarrier(
    repositoryId: string,
    runIdentity: string,
  ): IntegrationBarrier | undefined {
    return this.authority.runs.get(runKey(repositoryId, runIdentity))?.records?.integrationBarrier;
  }

  queryRunScheduling(
    repositoryId: string,
    runIdentity: string,
  ): RuntimeSchedulingSnapshot | undefined {
    const records = this.authority.runs.get(runKey(repositoryId, runIdentity))?.records;
    if (records === undefined) return undefined;
    return Object.freeze({
      graph: currentGraph(records, this.dependencies.sha256),
      phase: records.phase,
      acceptedTasks: Object.freeze(
        records.assessments
          .map(({ assessment, assessmentDigest }) =>
            Object.freeze({
              task: assessment.submission.task,
              accountingAssessmentDigest: assessmentDigest,
              ...(records.integrationBarrier === undefined
                ? {}
                : { integrationBarrierDigest: records.integrationBarrier.barrierDigest }),
            }),
          )
          .sort((left, right) => compareText(left.task.taskId, right.task.taskId)),
      ),
    });
  }

  restoreNonEffectCommand(
    sourceRun: SerializedRun,
    stored: SerializedRun["commands"][number],
    snapshotRuns: readonly SerializedRun[],
  ): void {
    const command = decodeCommandEnvelope(stored.canonicalEnvelope);
    const terminal = stored.receipt;
    if (terminal.status !== "refused" && terminal.status !== "expired") {
      throw new TypeError("Only refused or expired non-effect commands can be restored directly");
    }
    const authorizationDecision = this.dependencies.authorization.authorize(
      command.principal,
      command.intent,
    );
    if (authorizationDecision !== stored.admission.authorizationDecision) {
      throw new TypeError("Stored authorization decision does not match current policy");
    }
    const payloadDigest = this.digestJson(command.payload);
    const terminalError = terminal.error;
    if (
      terminalError === undefined ||
      terminal.result !== undefined ||
      terminal.resultRevision !== undefined
    ) {
      throw new TypeError("Stored non-effect receipt must contain only a terminal error");
    }
    const deterministicError = deterministicAdmissionError(
      command,
      stored.admission,
      authorizationDecision,
      payloadDigest,
    );
    const authorityIdentityError = deterministicAuthorityIdentityError(
      command,
      snapshotRuns,
      terminalError.code,
    );
    if (deterministicError !== undefined) {
      const expectedStatus = deterministicError.code === "command-expired" ? "expired" : "refused";
      if (
        terminal.status !== expectedStatus ||
        canonicalStringify(terminalError) !== canonicalStringify(deterministicError)
      ) {
        throw new TypeError("Stored deterministic refusal does not match admission facts");
      }
    } else if (authorityIdentityError !== undefined) {
      if (canonicalStringify(terminalError) !== canonicalStringify(authorityIdentityError)) {
        throw new TypeError("Stored authority identity refusal does not match snapshot state");
      }
    } else if (
      terminal.status !== "refused" ||
      terminalError.code !== "invalid-command" ||
      terminalError.retryable ||
      terminalError.commandId !== command.commandId ||
      terminalError.message.length === 0 ||
      terminalError.details !== undefined
    ) {
      throw new TypeError(
        `Stored post-execution refusal has invalid error semantics: ${terminalError.code}`,
      );
    }

    const submittedHistory = sourceRun.receiptHistory.filter(
      (receipt) => receipt.commandId === command.commandId,
    );
    const submittedEvents = sourceRun.events.filter(
      (event) => event.commandId === command.commandId,
    );
    if (submittedHistory.length !== 3 || submittedEvents.length !== 3) {
      throw new TypeError("Stored non-effect command requires one complete receipt lifecycle");
    }
    if (
      stored.admission.allocations.length !== 3 ||
      stored.admission.allocations.some((allocation) => allocation.kind !== "stream-event")
    ) {
      throw new TypeError(
        "Stored non-effect command requires exactly three stream event allocations",
      );
    }

    const run = this.getOrCreateRun(command.repositoryId, command.runId);
    const expectedPriorRevision = this.recordRevision(run.records);
    if (terminal.priorRevision !== expectedPriorRevision) {
      throw new TypeError("Stored non-effect refusal has an invalid prior revision");
    }
    const admission: AdmissionFacts = {
      currentTime: stored.admission.currentTime,
      facts: stored.admission.facts,
      allocateId() {
        throw new TypeError("Non-effect restoration uses persisted allocation identities directly");
      },
    };
    const [queuedAllocation, claimedAllocation, terminalAllocation] = stored.admission.allocations;
    if (
      queuedAllocation === undefined ||
      claimedAllocation === undefined ||
      terminalAllocation === undefined
    ) {
      throw new TypeError("Stored non-effect command allocation sequence is incomplete");
    }
    const historyStart = run.receiptHistory.length;
    const eventStart = run.events.length;
    this.transition(run, command, admission, queuedAllocation.id, "queued");
    this.transition(run, command, admission, claimedAllocation.id, "claimed");
    const reconstructedTerminal = this.transition(
      run,
      command,
      admission,
      terminalAllocation.id,
      terminal.status,
      {
        ...(terminal.priorRevision === undefined ? {} : { priorRevision: terminal.priorRevision }),
        error: terminalError,
      },
    );
    const reconstructedHistory = run.receiptHistory.slice(historyStart);
    const reconstructedEvents = run.events.slice(eventStart);
    if (
      canonicalStringify(reconstructedHistory) !== canonicalStringify(submittedHistory) ||
      canonicalStringify(reconstructedEvents) !== canonicalStringify(submittedEvents) ||
      canonicalStringify(reconstructedTerminal) !== canonicalStringify(terminal)
    ) {
      throw new TypeError("Stored non-effect command history does not match reconstruction");
    }
    run.commands.set(command.commandId, {
      canonicalEnvelope: stored.canonicalEnvelope,
      receipt: reconstructedTerminal,
      admission: stored.admission,
    });
  }

  private execute(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
    trustedFacts: TrustedRuntimeCommandFacts,
  ): JsonValue {
    switch (command.intent.type) {
      case "instantiate-run":
        return this.instantiateRun(command, admission, run);
      case "accept-graph-revision":
        return this.acceptGraphRevision(command, admission, run);
      case "submit-completion":
        return this.submitCompletion(command, run);
      case "evaluate-gate":
        return this.evaluateGate(command, run);
      case "record-authority-decision":
        return this.recordAuthorityDecision(command, admission, run);
      case "create-escalation":
        return this.createEscalation(command, admission, run);
      case "close-phase":
        return this.closePhase(command, run);
      case "start-phase-attempt":
        return this.startPhaseAttempt(command, run);
      case "record-phase-attempt-transition":
        return canonicalValue(decodeRecordPhaseAttemptTransitionPayload(command.payload));
      case "import-plan":
        return canonicalValue(decodeImportPlanPayload(command.payload));
      case "record-fan-out-diff-decision":
        return canonicalValue(decodeRecordFanOutDiffDecisionPayload(command.payload));
      case "submit-amendment-proposal":
        return this.submitAmendmentProposal(command, admission, run);
      case "withdraw-amendment-proposal":
        return this.withdrawAmendmentProposal(command, admission, run);
      case "record-amendment-decision":
        return this.recordAmendmentDecision(command, admission, run);
      case "apply-approved-amendment":
        return this.applyApprovedAmendment(
          command,
          admission,
          run,
          trustedFacts.amendmentQuiescence,
        );
      case "record-integration-barrier":
        return this.recordIntegrationBarrier(command, run);
      case "answer-question":
      case "steer-agent":
      case "override-member":
      case "grant-allowance":
      case "pause-run":
      case "resume-run":
      case "end-run":
        return trustedHumanAuthorityResult(trustedFacts.humanAuthority);
      default:
        throw new RuntimeRefusal("unsupported-intent", "Intent is not implemented in this slice");
    }
  }

  private instantiateRun(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    if (run.records !== undefined) {
      throw new RuntimeRefusal("run-already-instantiated", "Run is already instantiated");
    }
    const payload = exactObject(command.payload, "instantiate-run payload", [
      "workflowId",
      "configurationSnapshotDigest",
      "execution",
      "graph",
      "phase",
      "approvalPolicy",
      "escalationPolicyDigest",
      "allowancePolicy",
    ]);
    const graph = validateWorkflowGraph(payload.graph, this.dependencies.sha256);
    const configurationSnapshotDigest = requiredDigest(
      payload.configurationSnapshotDigest,
      "configurationSnapshotDigest",
    );
    const execution = validateRuntimeExecutionPolicy(payload.execution);
    const escalationPolicyDigest = requiredDigest(
      payload.escalationPolicyDigest,
      "escalationPolicyDigest",
    );
    const content = {
      type: "run-instantiated",
      sequence: 1,
      occurredAt: admission.currentTime,
      runId: runId(command.runId),
      workflowId: workflowId(requiredString(payload.workflowId, "workflowId")),
      revisionDigest: graph.revisionDigest,
      graph,
      facts: canonicalValue(admission.facts),
    } as const;
    const eventDigest = digestRunEventContent(content, this.dependencies.sha256);
    const events = decideRunCommand(
      undefined,
      {
        type: "instantiate-run",
        eventId: eventId(`event_${eventDigest}`),
        eventContentDigest: eventDigest,
        sequence: content.sequence,
        occurredAt: content.occurredAt,
        runId: content.runId,
        workflowId: content.workflowId,
        graph,
        facts: content.facts,
      },
      this.dependencies.sha256,
    );
    const records: RuntimeRunRecords = {
      runEvents: events,
      configurationSnapshotDigest,
      execution,
      phase: payload.phase as unknown as PhaseGenerationReference,
      approvalPolicy: payload.approvalPolicy as unknown as PhaseApprovalPolicyInput,
      escalationPolicyDigest,
      allowancePolicy: validateRunnerAllowancePolicy(
        payload.allowancePolicy,
        escalationPolicyDigest,
      ),
      assessments: [],
    };
    this.project(records);
    run.records = records;
    return canonicalValue({
      graphRevision: graph.revisionDigest,
      configurationSnapshotDigest,
      execution,
    }) as unknown as JsonValue;
  }

  private recordIntegrationBarrier(command: CommandEnvelope, run: RuntimeAuthorityRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (!command.principal.roles.includes("trusted-supervisor")) {
      throw new RuntimeRefusal(
        "trusted-supervisor-required",
        "Integration barriers require the trusted-supervisor role",
      );
    }
    if (records.execution.workspaceMode !== "worktree") {
      throw new RuntimeRefusal(
        "integration-forbidden",
        "Repository execution forbids integration barriers",
      );
    }
    const payload = decodeRecordIntegrationBarrierPayload(command.payload);
    if (payload.configurationSnapshotDigest !== records.configurationSnapshotDigest) {
      throw new RuntimeRefusal(
        "stale-configuration",
        "Integration barrier configuration snapshot does not match the run",
      );
    }
    const barrier = validateIntegrationBarrier(payload.barrier, this.dependencies.sha256);
    const graph = currentGraph(records, this.dependencies.sha256);
    if (
      barrier.phaseId !== records.phase.phaseId ||
      barrier.definitionGeneration !== records.phase.definitionGeneration ||
      barrier.graphRevisionDigest !== graph.revisionDigest ||
      barrier.targetRef !== records.execution.integrationRef
    ) {
      throw new RuntimeRefusal(
        "stale-integration-barrier",
        "Integration barrier does not match current run authority",
      );
    }
    this.assertExactObject(command, barrier.barrierDigest);
    if (records.integrationBarrier !== undefined) {
      if (canonicalStringify(records.integrationBarrier) !== canonicalStringify(barrier)) {
        throw new RuntimeRefusal(
          "integration-barrier-exists",
          "A different integration barrier is already authoritative",
        );
      }
      return canonicalValue({
        integrationId: payload.integrationId,
        barrierDigest: barrier.barrierDigest,
      }) as unknown as JsonValue;
    }
    run.records = { ...records, integrationBarrier: barrier };
    return canonicalValue({
      integrationId: payload.integrationId,
      barrierDigest: barrier.barrierDigest,
    }) as unknown as JsonValue;
  }

  private acceptGraphRevision(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    if (records.assessments.length > 0 || records.candidate !== undefined) {
      throw new RuntimeRefusal(
        "active-records",
        "Graph revisions cannot replace a graph after lifecycle records exist",
      );
    }
    this.assertGraphRevision(command, records);
    const payload = exactObject(command.payload, "accept-graph-revision payload", [
      "workflowId",
      "graph",
    ]);
    const graph = validateWorkflowGraph(payload.graph, this.dependencies.sha256);
    const state = replayRunEvents(records.runEvents, this.dependencies.sha256);
    const content = {
      type: "graph-revision-accepted",
      sequence: state.lastSequence + 1,
      occurredAt: admission.currentTime,
      runId: state.runId,
      workflowId: workflowId(requiredString(payload.workflowId, "workflowId")),
      beforeRevisionDigest: state.revisionDigest,
      afterRevisionDigest: graph.revisionDigest,
      graph,
      facts: canonicalValue(admission.facts),
    } as const;
    const eventDigest = digestRunEventContent(content, this.dependencies.sha256);
    const events = decideRunCommand(
      state,
      {
        type: "accept-graph-revision",
        eventId: eventId(`event_${eventDigest}`),
        eventContentDigest: eventDigest,
        sequence: content.sequence,
        occurredAt: content.occurredAt,
        runId: content.runId,
        workflowId: content.workflowId,
        expectedRevisionDigest: content.beforeRevisionDigest,
        graph,
        facts: content.facts,
      },
      this.dependencies.sha256,
    );
    const updated = { ...records, runEvents: [...records.runEvents, ...events] };
    this.project(updated);
    run.records = updated;
    return canonicalValue({ graphRevision: graph.revisionDigest }) as unknown as JsonValue;
  }

  private submitCompletion(command: CommandEnvelope, run: RuntimeAuthorityRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    // A candidate the gate rejected is not the phase's decided content. It is a
    // failed attempt, and the attempt the run starts next is entitled to replace
    // it. Holding it against that attempt meant a retried phase could never hand
    // its work in: the authority refused every completion the retry produced, so
    // the run waited for an agent that had already finished, on every cycle, for
    // ever. An accepted candidate still stands, because that is a decision.
    const rejectedCandidate =
      records.candidate !== undefined && records.gateEvidence?.evaluation.decision === "rejected";
    if (records.candidate !== undefined && !rejectedCandidate) {
      throw new RuntimeRefusal(
        "candidate-exists",
        "Completion cannot change after candidate creation",
      );
    }
    const payload = exactObject(command.payload, "submit-completion payload", ["submission"]);
    const submission = exactObject(
      payload.submission,
      "completion submission",
      ["task", "disposition", "summary", "criteria", "completionEvidence"],
      ["replacementTask"],
    );
    const task = parseTaskReference(submission.task);
    if (command.expectedDefinitionRevision !== task.contextRevisionDigest) {
      throw new RuntimeRefusal(
        "stale-definition",
        "Completion expectedDefinitionRevision must match its task context revision",
      );
    }
    if (
      !rejectedCandidate &&
      records.assessments.some(
        (accepted) => accepted.assessment.submission.task.taskId === task.taskId,
      )
    ) {
      throw new RuntimeRefusal("completion-exists", "Task already has an accepted completion");
    }
    const graph = currentGraph(records, this.dependencies.sha256);
    assertActivePhaseTask(task, records.phase, graph);
    const requirements = deriveCompletionRequirements(graph, [task], this.dependencies.sha256)[0];
    if (requirements === undefined) {
      throw new RuntimeRefusal("invalid-completion", "Completion task has no graph requirements");
    }
    const assessment = assessCompletionAccounting(
      requirements,
      payload.submission as unknown as CompletionSubmission,
    );
    const assessmentDigest = digestAccountingAssessment(assessment, this.dependencies.sha256);
    // Only the retried task's own assessment is replaced. A fan-out retries the
    // member that failed, and the members that passed keep the work they did.
    // The rejected candidate and its evidence are dropped rather than set aside,
    // because a record that is absent cannot be mistaken for a decision.
    const kept = rejectedCandidate
      ? records.assessments.filter(
          (accepted) => accepted.assessment.submission.task.taskId !== task.taskId,
        )
      : records.assessments;
    const base = rejectedCandidate ? withoutRejectedCandidate(records) : records;
    run.records = updateCurrentPhase(base, {
      assessments: [...kept, { assessmentDigest, assessment }],
    });
    return canonicalValue({ assessmentDigest, assessment }) as unknown as JsonValue;
  }

  private evaluateGate(command: CommandEnvelope, run: RuntimeAuthorityRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (records.candidate !== undefined) {
      throw new RuntimeRefusal("candidate-exists", "A phase candidate already exists");
    }
    const payload = exactObject(
      command.payload,
      "evaluate-gate payload",
      [
        "phase",
        "phaseAttempt",
        "inputBindingDigest",
        "requiredOutputPublications",
        "outputSetDigest",
        "dependencyBarrierDigest",
        "gateDefinition",
        "readings",
      ],
      ["integrationBarrierDigest"],
    );
    if (records.execution.workspaceMode === "repository") {
      if (payload.integrationBarrierDigest !== undefined) {
        throw new RuntimeRefusal(
          "integration-forbidden",
          "Repository execution forbids integration barrier candidates",
        );
      }
    } else if (
      records.integrationBarrier === undefined ||
      payload.integrationBarrierDigest !== records.integrationBarrier.barrierDigest
    ) {
      throw new RuntimeRefusal(
        "integration-barrier-required",
        "Worktree gate evaluation requires the exact current integration barrier",
      );
    }
    const graph = currentGraph(records, this.dependencies.sha256);
    const definition = validateGateDefinition(payload.gateDefinition, this.dependencies.sha256);
    if (!Array.isArray(payload.readings)) {
      throw new RuntimeRefusal("invalid-gate", "Gate readings must be an array");
    }
    const tasks = records.assessments.map((accepted) => accepted.assessment.submission.task);
    if (!Array.isArray(payload.requiredOutputPublications)) {
      throw new RuntimeRefusal(
        "invalid-candidate",
        "Required output publications must be an array",
      );
    }
    const candidate = createPhaseCandidate(
      {
        phase: payload.phase as unknown as PhaseGenerationReference,
        phaseAttempt: payload.phaseAttempt as never,
        graphRevisionDigest: graph.revisionDigest,
        inputBindingDigest: requiredDigest(payload.inputBindingDigest, "inputBindingDigest"),
        requiredOutputPublications: payload.requiredOutputPublications as never,
        outputSetDigest: requiredDigest(payload.outputSetDigest, "outputSetDigest"),
        selectedTaskSetDigest: digestSelectedTaskSet(tasks, this.dependencies.sha256),
        tasks,
        acceptedAccountingAssessments: records.assessments,
        dependencyBarrierDigest: requiredDigest(
          payload.dependencyBarrierDigest,
          "dependencyBarrierDigest",
        ),
        ...(records.integrationBarrier === undefined
          ? {}
          : {
              integrationBarrierDigest: records.integrationBarrier.barrierDigest,
            }),
        gatePolicyDigest: definition.policyDigest,
      },
      graph,
      this.dependencies.sha256,
    );
    this.assertExactObject(command, candidate.candidateDigest);
    const evaluation = evaluateGate(
      definition,
      payload.readings as unknown as readonly SensorReading[],
      candidate.candidateDigest,
      this.dependencies.sha256,
    );
    const gateEvidence = validateGateEvidence(
      { definition, readings: payload.readings, evaluation },
      candidate.candidateDigest,
      this.dependencies.sha256,
    );
    const updated = updateCurrentPhase(records, { candidate, gateEvidence });
    this.project(updated);
    run.records = updated;
    return canonicalValue({ candidate, gateEvidence }) as unknown as JsonValue;
  }

  private recordAuthorityDecision(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (records.candidate === undefined || records.gateEvidence === undefined) {
      throw new RuntimeRefusal("candidate-required", "Authority decisions require gate evidence");
    }
    if (records.authorityDecision !== undefined) {
      throw new RuntimeRefusal("decision-exists", "An authority decision already exists");
    }
    this.assertExactObject(command, records.candidate.candidateDigest);
    const payload = exactObject(
      command.payload,
      "authority-decision payload",
      ["decision"],
      ["reason"],
    );
    if (payload.decision !== "approve" && payload.decision !== "reject") {
      throw new RuntimeRefusal("invalid-decision", "Decision must be approve or reject");
    }
    if (payload.reason !== undefined && typeof payload.reason !== "string") {
      throw new RuntimeRefusal("invalid-decision", "Decision reason must be a string");
    }
    // A rejection without a reason leaves the next attempt guessing, so the
    // reason is required exactly where it is the only thing that carries
    // forward.
    if (payload.decision === "reject" && (payload.reason ?? "").length === 0) {
      throw new RuntimeRefusal("invalid-decision", "A rejection must carry a reason");
    }
    const authorityDecision = createAuthorityDecision(
      {
        decision: payload.decision,
        approvalId: approvalId(admission.allocateId("approval", command)),
        principal: command.principal,
        occurredAt: admission.currentTime,
        candidateDigest: records.candidate.candidateDigest,
        ...(typeof payload.reason === "string" && payload.reason.length > 0
          ? { reason: payload.reason }
          : {}),
      },
      this.dependencies.sha256,
    );
    const updated = updateCurrentPhase(records, { authorityDecision });
    this.project(updated);
    run.records = updated;
    return canonicalValue(authorityDecision) as unknown as JsonValue;
  }

  /**
   * Records that a phase cannot reach a gate and needs a human.
   *
   * Without this, a phase whose gates keep failing has no terminal move: it can
   * neither close nor hand the problem over, so the run stalls silently. The
   * escalation is derived from the authority's own records rather than from the
   * caller, because an agent that could describe its own failure could also
   * describe a different one.
   */
  private createEscalation(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (records.candidate === undefined || records.gateEvidence === undefined) {
      throw new RuntimeRefusal(
        "candidate-required",
        "Escalation requires the gate evidence it is escalating",
      );
    }
    if (records.escalation !== undefined) {
      throw new RuntimeRefusal("escalation-exists", "Phase already has an escalation");
    }
    if (records.closure !== undefined) {
      throw new RuntimeRefusal("closure-exists", "A closed phase cannot escalate");
    }
    // Escalating a passing gate would let an agent route around a decision it
    // already won, so the evidence has to actually be a refusal.
    if (records.gateEvidence.evaluation.decision !== "rejected") {
      throw new RuntimeRefusal(
        "invalid-escalation",
        "Escalation requires gate evidence whose decision is rejected",
      );
    }
    this.assertExactObject(command, records.candidate.candidateDigest);
    const payload = exactObject(command.payload, "create-escalation payload", ["allowedResponses"]);
    if (!Array.isArray(payload.allowedResponses) || payload.allowedResponses.length === 0) {
      throw new RuntimeRefusal(
        "invalid-escalation",
        "Escalation must offer at least one allowed response",
      );
    }
    const evidence = records.gateEvidence;
    const escalation = createEscalation(
      {
        escalationId: escalationId(admission.allocateId("escalation", command)),
        owner: {
          kind: "phase",
          phaseId: records.phase.phaseId,
          definitionGeneration: records.phase.definitionGeneration,
          contextRevisionDigest: records.candidate.graphRevisionDigest,
        },
        trigger: { kind: "blocked" },
        contextDigest: records.candidate.inputBindingDigest,
        candidateDigest: records.candidate.candidateDigest,
        policyDigest: records.escalationPolicyDigest,
        unresolvedCriterionIds: [],
        failedReadingDigests: evidence.evaluation.readingDigests.filter((_digest, index) =>
          isFailedRule(evidence.evaluation.blocking[index]),
        ),
        unknownReadingDigests: [],
        attemptFacts: [],
        allowedResponses: payload.allowedResponses as never,
        timestamp: admission.currentTime,
      },
      this.dependencies.sha256,
    );
    const updated = updateCurrentPhase(records, { escalation });
    this.project(updated);
    run.records = updated;
    return canonicalValue(escalation) as unknown as JsonValue;
  }

  private closePhase(command: CommandEnvelope, run: RuntimeAuthorityRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    exactObject(command.payload, "close-phase payload", []);
    if (records.candidate === undefined || records.gateEvidence === undefined) {
      throw new RuntimeRefusal(
        "candidate-required",
        "Closure requires exact candidate gate evidence",
      );
    }
    if (records.closure !== undefined) {
      throw new RuntimeRefusal("closure-exists", "Phase is already closed");
    }
    if (
      records.execution.workspaceMode === "worktree" &&
      (records.integrationBarrier === undefined ||
        records.candidate.integrationBarrierDigest !== records.integrationBarrier.barrierDigest)
    ) {
      throw new RuntimeRefusal(
        "integration-barrier-required",
        "Worktree closure requires the exact current integration barrier",
      );
    }
    this.assertExactObject(command, records.candidate.candidateDigest);
    const graph = currentGraph(records, this.dependencies.sha256);
    const approval =
      records.approvalPolicy.policy === "no-approval"
        ? records.approvalPolicy
        : records.authorityDecision === undefined
          ? (() => {
              throw new RuntimeRefusal("decision-required", "Closure requires authority approval");
            })()
          : { ...records.approvalPolicy, decision: records.authorityDecision };
    const closure = closePhase(
      { graph, candidate: records.candidate, gateEvidence: records.gateEvidence, approval },
      this.dependencies.sha256,
    );
    const updated = updateCurrentPhase(records, { closure });
    this.project(updated);
    run.records = updated;
    return canonicalValue(closure) as unknown as JsonValue;
  }

  /**
   * Moves the run to its next phase.
   *
   * Without this a run's phase was fixed at instantiation, so a workflow could
   * only ever execute its first phase. Advancing archives the closed phase and
   * clears the per-phase records, because the next phase must build its own
   * candidate, evidence, and decision rather than inheriting them.
   */
  private startPhaseAttempt(command: CommandEnvelope, run: RuntimeAuthorityRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    const payload = decodeStartPhaseAttemptPayload(command.payload);
    if (records.closure === undefined) {
      throw new RuntimeRefusal("closure-required", "A run advances only from a closed phase");
    }
    const graph = currentGraph(records, this.dependencies.sha256);
    const target = graph.nodes.find(
      (node) =>
        node.kind === "phase" &&
        node.definition.id === payload.phaseId &&
        node.definition.generation === payload.definitionGeneration,
    );
    if (target === undefined || target.kind !== "phase") {
      throw new RuntimeRefusal("unknown-phase", "The graph declares no such phase generation");
    }
    if (
      target.definition.id === records.phase.phaseId &&
      target.definition.generation === records.phase.definitionGeneration
    ) {
      throw new RuntimeRefusal("phase-already-current", "The run is already on that phase");
    }
    const closed = new Set(
      (records.phaseLifecycles ?? [])
        .filter((lifecycle) => lifecycle.closure !== undefined)
        .map((lifecycle) => lifecycle.phase.phaseId),
    );
    closed.add(records.phase.phaseId);
    if (closed.has(target.definition.id)) {
      throw new RuntimeRefusal("phase-already-closed", "That phase has already closed");
    }
    const unmet = target.definition.dependsOn.filter((dependency) => !closed.has(dependency));
    if (unmet.length > 0) {
      throw new RuntimeRefusal(
        "dependencies-open",
        `Phase depends on ${unmet.length} phase${unmet.length === 1 ? "" : "s"} that have not closed`,
      );
    }
    // A run's first phase has no lifecycle entry until something advances past
    // it, so seed the closing phase before folding its closure in. Without this
    // the phase that just closed is dropped from history entirely.
    const seeded: RuntimeRunRecords =
      records.phaseLifecycles === undefined
        ? { ...records, phaseLifecycles: [phaseLifecycleRecords(records)] }
        : records;
    const archived = updateCurrentPhase(seeded, {});
    // The next phase builds its own candidate, evidence, and decision, so the
    // closed phase's records are dropped rather than carried forward.
    const {
      candidate: _candidate,
      gateEvidence: _gateEvidence,
      authorityDecision: _authorityDecision,
      closure: _closure,
      integrationBarrier: _integrationBarrier,
      ...carried
    } = archived;
    const advanced: RuntimeRunRecords = {
      ...carried,
      phase: {
        phaseId: target.definition.id,
        definitionGeneration: target.definition.generation,
      },
      // The next phase has accepted nothing yet; carrying the closed phase's
      // assessments would let it close on work that was never done for it.
      assessments: [],
      phaseLifecycles: [
        ...(archived.phaseLifecycles ?? []),
        {
          phase: {
            phaseId: target.definition.id,
            definitionGeneration: target.definition.generation,
          },
          approvalPolicy: records.approvalPolicy,
          escalationPolicyDigest: records.escalationPolicyDigest,
          assessments: [],
        },
      ],
      // The projection reads the amendment aggregate whenever any part of it
      // exists, so advancing seeds the empty halves rather than leaving a run
      // that never amended anything unprojectable.
      amendmentRecords: archived.amendmentRecords ?? [],
      amendmentEvents: archived.amendmentEvents ?? [],
    };
    this.project(advanced);
    run.records = advanced;
    return canonicalValue({
      phaseId: target.definition.id,
      definitionGeneration: target.definition.generation,
    }) as unknown as JsonValue;
  }

  private submitAmendmentProposal(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    const payload = decodeSubmitAmendmentProposalPayload(command.payload);
    const history = phaseCandidateHistory(records);
    const proposal = validateAmendmentProposal(payload.proposal, history, this.dependencies.sha256);
    this.assertGraphRevision(command, records);
    this.assertExactObject(command, proposal.proposalDigest);
    const graph = currentGraph(records, this.dependencies.sha256);
    if (
      proposal.baseGraph.revisionDigest !== command.expectedGraphRevision ||
      canonicalSerialize(canonicalValue(proposal.baseGraph)) !==
        canonicalSerialize(canonicalValue(graph))
    ) {
      throw new RuntimeRefusal(
        "stale-base",
        "Amendment proposal base graph must exactly equal the current graph",
      );
    }
    const aggregate = ensureAmendmentAggregate(records);
    const existing = aggregate.amendmentRecords.find(
      (item) => item.proposal.amendmentId === proposal.amendmentId,
    );
    if (existing !== undefined) {
      throw new RuntimeRefusal(
        existing.proposal.proposalDigest === proposal.proposalDigest
          ? "amendment-proposal-exists"
          : "amendment-proposal-conflict",
        "Amendment identity is already bound to a proposal",
      );
    }
    const updated = appendAmendmentEvent(
      {
        ...aggregate,
        amendmentRecords: [...aggregate.amendmentRecords, { proposal }],
      },
      "amendment-proposal-submitted",
      admission.currentTime,
      proposal,
      this.dependencies.sha256,
    );
    this.project(updated);
    run.records = updated;
    return canonicalValue({
      amendmentId: proposal.amendmentId,
      proposalDigest: proposal.proposalDigest,
      baseGraphRevisionDigest: proposal.baseGraph.revisionDigest,
      reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
    }) as unknown as JsonValue;
  }

  private withdrawAmendmentProposal(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    const payload = decodeWithdrawAmendmentProposalPayload(command.payload);
    const aggregate = requiredAmendmentAggregate(records);
    const [index, lifecycle] = requiredAmendmentRecord(aggregate, payload.amendmentId);
    assertProposalBinding(payload.proposalDigest, lifecycle.proposal);
    this.assertExactObject(command, lifecycle.proposal.proposalDigest);
    if (lifecycle.withdrawal !== undefined) {
      throw new RuntimeRefusal("amendment-withdrawal-exists", "Amendment is already withdrawn");
    }
    if (lifecycle.application !== undefined) {
      throw new RuntimeRefusal("amendment-already-applied", "Applied amendments cannot withdraw");
    }
    const withdrawal = createAmendmentWithdrawal(
      { principal: command.principal, occurredAt: admission.currentTime },
      lifecycle.proposal,
      lifecycle.decision,
      this.dependencies.sha256,
    );
    const updated = appendAmendmentEvent(
      replaceAmendmentRecord(aggregate, index, { ...lifecycle, withdrawal }),
      "amendment-proposal-withdrawn",
      admission.currentTime,
      withdrawal,
      this.dependencies.sha256,
    );
    this.project(updated);
    run.records = updated;
    return canonicalValue(withdrawal) as unknown as JsonValue;
  }

  private recordAmendmentDecision(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
  ): JsonValue {
    const records = requiredRecords(run);
    const payload = decodeRecordAmendmentDecisionPayload(command.payload);
    const aggregate = requiredAmendmentAggregate(records);
    const [index, lifecycle] = requiredAmendmentRecord(aggregate, payload.amendmentId);
    const proposal = lifecycle.proposal;
    assertProposalBinding(payload.proposalDigest, proposal);
    assertDecidableWithoutReview(command, proposal);
    if (payload.reviewedResultGraphRevisionDigest !== proposal.reviewedResultGraph.revisionDigest) {
      throw new RuntimeRefusal(
        "stale-result-graph",
        "Decision reviewed result graph digest does not match the proposal",
      );
    }
    if (command.expectedGraphRevision !== proposal.baseGraph.revisionDigest) {
      throw new RuntimeRefusal(
        "stale-graph",
        "Decision expectedGraphRevision must equal the proposal base graph revision",
      );
    }
    this.assertExactObject(command, proposal.proposalDigest);
    if (lifecycle.decision !== undefined) {
      throw new RuntimeRefusal("amendment-decision-exists", "Amendment already has a decision");
    }
    if (lifecycle.withdrawal !== undefined) {
      throw new RuntimeRefusal("withdrawn-proposal", "A withdrawn amendment cannot be decided");
    }
    const graph = currentGraph(records, this.dependencies.sha256);
    const pendingProposals = currentPendingProposals(aggregate, graph, proposal.amendmentId);
    const decision = createAmendmentDecision(
      {
        decision: payload.decision,
        approvalId: approvalId(admission.allocateId("approval", command)),
        principal: command.principal,
        occurredAt: admission.currentTime,
      },
      proposal,
      {
        currentGraph: graph,
        phaseCandidateHistory: phaseCandidateHistory(records),
        pendingProposals,
        ...(lifecycle.withdrawal === undefined ? {} : { withdrawal: lifecycle.withdrawal }),
      },
      this.dependencies.sha256,
    );
    let updated = appendAmendmentEvent(
      replaceAmendmentRecord(aggregate, index, { ...lifecycle, decision }),
      "amendment-decision-recorded",
      admission.currentTime,
      decision,
      this.dependencies.sha256,
    );
    if (decision.decision === "approve") {
      updated = appendAmendmentEvent(
        updated,
        "amendment-fencing-required",
        admission.currentTime,
        {
          amendmentId: proposal.amendmentId,
          proposalDigest: proposal.proposalDigest,
          decisionDigest: decision.decisionDigest,
          impactDigest: proposal.impact.impactDigest,
          affectedTaskScopes: proposal.impact.affectedTaskScopes,
        },
        this.dependencies.sha256,
      );
    }
    this.project(updated);
    run.records = updated;
    return canonicalValue(decision) as unknown as JsonValue;
  }

  private applyApprovedAmendment(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: RuntimeAuthorityRun,
    trustedQuiescence: AmendmentQuiescenceFact | undefined,
  ): JsonValue {
    const records = requiredRecords(run);
    const payload = decodeApplyApprovedAmendmentPayload(command.payload);
    const aggregate = requiredAmendmentAggregate(records);
    const [index, lifecycle] = requiredAmendmentRecord(aggregate, payload.amendmentId);
    const proposal = lifecycle.proposal;
    assertProposalBinding(payload.proposalDigest, proposal);
    if (lifecycle.decision === undefined) {
      throw new RuntimeRefusal("amendment-decision-required", "Application requires a decision");
    }
    if (payload.decisionDigest !== lifecycle.decision.decisionDigest) {
      throw new RuntimeRefusal(
        "stale-object",
        "Application decision digest does not match the recorded decision",
      );
    }
    if (payload.reviewedResultGraphRevisionDigest !== proposal.reviewedResultGraph.revisionDigest) {
      throw new RuntimeRefusal(
        "stale-result-graph",
        "Application reviewed result graph digest does not match the proposal",
      );
    }
    if (command.expectedGraphRevision !== proposal.baseGraph.revisionDigest) {
      throw new RuntimeRefusal(
        "stale-graph",
        "Application expectedGraphRevision must equal the approved base graph revision",
      );
    }
    this.assertGraphRevision(command, records);
    this.assertExactObject(command, lifecycle.decision.decisionDigest);
    if (lifecycle.application !== undefined) {
      throw new RuntimeRefusal("amendment-already-applied", "Amendment is already applied");
    }
    if (trustedQuiescence === undefined) {
      throw new RuntimeRefusal(
        "trusted-quiescence-required",
        "Application requires storage-authoritative quiescence facts",
      );
    }
    const graph = currentGraph(records, this.dependencies.sha256);
    const application = applyApprovedAmendment(
      {
        proposal,
        decision: lifecycle.decision,
        currentGraph: graph,
        quiescence: trustedQuiescence,
        occurredAt: admission.currentTime,
        phaseCandidateHistory: phaseCandidateHistory(records),
        ...(lifecycle.withdrawal === undefined ? {} : { withdrawal: lifecycle.withdrawal }),
      },
      this.dependencies.sha256,
    );
    const withGraph = appendGraphRevisionEvent(
      replaceAmendmentRecord(aggregate, index, { ...lifecycle, application }),
      application.graph,
      admission,
      this.dependencies,
    );
    const updated = appendAmendmentEvent(
      withGraph,
      "approved-amendment-applied",
      admission.currentTime,
      application,
      this.dependencies.sha256,
    );
    this.project(updated);
    run.records = updated;
    return canonicalValue({
      application,
      graphRevision: application.afterGraphRevisionDigest,
    }) as unknown as JsonValue;
  }

  private validateAdmission(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    authorizationDecision: boolean,
  ): void {
    if (
      command.expiresAt !== undefined &&
      Date.parse(command.expiresAt) <= Date.parse(admission.currentTime)
    ) {
      throw new RuntimeRefusal("command-expired", "Command expiry has passed", false, "expired");
    }
    if (!authorizationDecision) {
      throw new RuntimeRefusal("unauthorized", "Principal is not authorized for this intent");
    }
    const payloadDigest = this.digestJson(command.payload);
    if (payloadDigest !== command.payloadDigest) {
      throw new RuntimeRefusal(
        "payload-digest-mismatch",
        "Payload digest does not match payload bytes",
      );
    }
  }

  private validateAuthorityIdentity(command: CommandEnvelope, current: RuntimeAuthorityRun): void {
    for (const run of this.authority.runs.values()) {
      if (run === current || run.records === undefined) continue;
      if (run.runId === command.runId && run.repositoryId !== command.repositoryId) {
        throw new RuntimeRefusal(
          "run-repository-mismatch",
          "Run identity is already bound to a different repository",
        );
      }
      if (run.repositoryId === command.repositoryId && run.runId !== command.runId) {
        throw new RuntimeRefusal(
          "repository-run-conflict",
          "Repository already has a different active run",
        );
      }
    }
  }

  private assertGraphRevision(command: CommandEnvelope, records: RuntimeRunRecords): void {
    const graph = currentGraph(records, this.dependencies.sha256);
    if (command.expectedGraphRevision !== graph.revisionDigest) {
      throw new RuntimeRefusal("stale-graph", "expectedGraphRevision does not match current graph");
    }
  }

  private assertExactObject(command: CommandEnvelope, expected: string): void {
    if (command.exactObjectDigest !== expected) {
      throw new RuntimeRefusal(
        "stale-object",
        "exactObjectDigest does not match current candidate",
      );
    }
  }

  private project(records: RuntimeRunRecords): PhaseLifecycleProjection & {
    readonly phaseLifecycles?: readonly PhaseLifecycleProjection[];
    readonly amendments?: readonly AmendmentLifecycleProjection[];
    readonly amendmentEventDigests?: readonly Sha256Digest[];
  } {
    const graph = currentGraph(records, this.dependencies.sha256);
    assertPhaseInGraph(records.phase, graph);
    const primary = projectPhaseLifecycle(
      {
        graph,
        phase: records.phase,
        approvalPolicy: records.approvalPolicy,
        escalationPolicyDigest: records.escalationPolicyDigest,
        ...(records.candidate === undefined ? {} : { candidate: records.candidate }),
        ...(records.gateEvidence === undefined ? {} : { gateEvidence: records.gateEvidence }),
        ...(records.authorityDecision === undefined
          ? {}
          : { authorityDecision: records.authorityDecision }),
        ...(records.closure === undefined ? {} : { closure: records.closure }),
      },
      this.dependencies.sha256,
    );
    if (
      records.phaseLifecycles === undefined &&
      records.amendmentRecords === undefined &&
      records.amendmentEvents === undefined
    ) {
      return primary;
    }
    const aggregate = requiredAmendmentAggregate(records);
    validateAmendmentEventChain(aggregate.amendmentEvents, this.dependencies.sha256);
    const phaseLifecycles = aggregate.phaseLifecycles.map((lifecycle) =>
      projectPhaseRecords(lifecycle, graph, this.dependencies.sha256),
    );
    assertCurrentPhaseProjection(records, aggregate.phaseLifecycles);
    const history = phaseCandidateHistory(records);
    const amendments = aggregate.amendmentRecords.map((lifecycle) =>
      projectAmendmentLifecycle(
        {
          proposal: lifecycle.proposal,
          currentGraph: graph,
          phaseCandidateHistory: history,
          pendingProposals: currentPendingProposals(
            aggregate,
            graph,
            lifecycle.proposal.amendmentId,
          ),
          ...(lifecycle.decision === undefined ? {} : { decision: lifecycle.decision }),
          ...(lifecycle.withdrawal === undefined ? {} : { withdrawal: lifecycle.withdrawal }),
          ...(lifecycle.application === undefined ? {} : { application: lifecycle.application }),
        },
        this.dependencies.sha256,
      ),
    );
    const content = {
      ...primary,
      phaseLifecycles,
      amendments,
      amendmentEventDigests: aggregate.amendmentEvents.map(({ eventDigest }) => eventDigest),
    };
    return canonicalValue({
      ...content,
      projectionDigest: canonicalDigest(canonicalValue(content), this.dependencies.sha256),
    }) as unknown as PhaseLifecycleProjection & {
      readonly phaseLifecycles: readonly PhaseLifecycleProjection[];
      readonly amendments: readonly AmendmentLifecycleProjection[];
      readonly amendmentEventDigests: readonly Sha256Digest[];
    };
  }

  private validateHydratedRun(run: RuntimeAuthorityRun): void {
    for (const [index, event] of run.events.entries()) {
      const receipt = run.receiptHistory[index];
      if (
        receipt === undefined ||
        event.payloadDigest !== this.digestJson(event.payload) ||
        event.eventType !== `command-${receipt.status}` ||
        event.commandId !== receipt.commandId ||
        canonicalStringify(event.payload) !== canonicalStringify({ status: receipt.status })
      ) {
        throw new TypeError("Stored command event does not match its receipt transition");
      }
    }
    if (run.records === undefined) return;
    const graph = currentGraph(run.records, this.dependencies.sha256);
    const validatedAssessments = run.records.assessments.map((accepted) => {
      const task = accepted.assessment.submission.task;
      const requirements = deriveCompletionRequirements(graph, [task], this.dependencies.sha256)[0];
      if (requirements === undefined)
        throw new TypeError("Stored assessment task is absent from graph");
      const assessment = assessCompletionAccounting(requirements, accepted.assessment.submission);
      const assessmentDigest = digestAccountingAssessment(assessment, this.dependencies.sha256);
      if (assessmentDigest !== accepted.assessmentDigest) {
        throw new TypeError("Stored assessment digest does not match its source");
      }
      return { assessmentDigest, assessment };
    });
    let records = updateCurrentPhase(run.records, { assessments: validatedAssessments });
    if (records.candidate !== undefined) {
      records = updateCurrentPhase(records, {
        candidate: validatePhaseCandidate(records.candidate, graph, this.dependencies.sha256),
      });
    }
    this.project(records);
    run.records = records;
  }

  private transition(
    run: RuntimeAuthorityRun,
    command: CommandEnvelope,
    admission: AdmissionFacts,
    allocatedEventId: string,
    status: ReceiptStatus,
    fields: Partial<
      Pick<DurableReceipt, "priorRevision" | "resultRevision" | "result" | "error">
    > = {},
  ): DurableReceipt {
    const priorStatus = run.receiptHistory
      .filter((receipt) => receipt.commandId === command.commandId)
      .at(-1)?.status;
    assertReceiptTransition(priorStatus, status);
    const cursor = run.cursor + 1;
    const receipt = decodeDurableReceipt({
      apiVersion: PROTOCOL_VERSION,
      commandId: command.commandId,
      repositoryId: command.repositoryId,
      runId: command.runId,
      status,
      cursor,
      ...fields,
    });
    const eventPayload = canonicalValue({ status }) as unknown as JsonValue;
    const frame = decodeEventStreamFrame({
      apiVersion: PROTOCOL_VERSION,
      cursor,
      repositoryId: command.repositoryId,
      runId: command.runId,
      eventId: allocatedEventId,
      eventType: `command-${status}`,
      occurredAt: admission.currentTime,
      payload: eventPayload,
      payloadDigest: this.digestJson(eventPayload),
      commandId: command.commandId,
    });
    run.cursor = cursor;
    run.receiptHistory.push(receipt);
    run.events.push(frame);
    return receipt;
  }

  private allocateStreamEventIds(
    command: CommandEnvelope,
    admission: AdmissionFacts,
  ): readonly [string, string, string] {
    const allocated = Array.from({ length: 3 }, () =>
      validateOpaqueIdentity(admission.allocateId("stream-event", command)),
    ) as [string, string, string];
    const existing = new Set(
      [...this.authority.runs.values()].flatMap((run) => run.events.map((event) => event.eventId)),
    );
    if (new Set(allocated).size !== allocated.length || allocated.some((id) => existing.has(id))) {
      throw new TypeError("Allocated stream event identities must be globally unique");
    }
    return allocated;
  }

  private digestJson(value: unknown): string {
    const digest = this.dependencies.sha256.digest(canonicalBytes(value));
    if (!isSha256Digest(digest)) {
      throw new TypeError("SHA-256 implementations must return lowercase hexadecimal digests");
    }
    return digest;
  }

  private recordRevision(records: RuntimeRunRecords | undefined): string | undefined {
    return records === undefined
      ? undefined
      : canonicalDigest(canonicalValue(records), this.dependencies.sha256);
  }

  private findStoredCommand(
    commandId: string,
  ): { readonly run: RuntimeAuthorityRun; readonly command: StoredCommand } | undefined {
    for (const run of this.authority.runs.values()) {
      const command = run.commands.get(commandId);
      if (command !== undefined) return { run, command };
    }
    return undefined;
  }

  private getOrCreateRun(repositoryId: string, runIdentity: string): RuntimeAuthorityRun {
    const key = runKey(repositoryId, runIdentity);
    const current = this.authority.runs.get(key);
    if (current !== undefined) return current;
    const run: RuntimeAuthorityRun = {
      repositoryId,
      runId: runIdentity,
      cursor: 0,
      commands: new Map(),
      receiptHistory: [],
      events: [],
    };
    this.authority.runs.set(key, run);
    return run;
  }
}

class RuntimeRefusal extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: Extract<ReceiptStatus, "refused" | "expired">;

  constructor(
    code: string,
    message: string,
    retryable = false,
    status: Extract<ReceiptStatus, "refused" | "expired"> = "refused",
  ) {
    super(message);
    this.name = "RuntimeRefusal";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function commandRefusal(error: unknown): RuntimeRefusal {
  if (error instanceof RuntimeRefusal) return error;
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "invalid-command";
    return new RuntimeRefusal(code, error.message);
  }
  return new RuntimeRefusal("invalid-command", "Command processing failed");
}

function currentGraph(
  records: RuntimeRunRecords,
  sha256: RuntimeDependencies["sha256"],
): WorkflowGraph {
  return replayRunEvents(records.runEvents, sha256).graph;
}

function ensureAmendmentAggregate(records: RuntimeRunRecords): RuntimeAmendmentAggregate {
  return {
    ...records,
    phaseLifecycles: records.phaseLifecycles ?? [phaseLifecycleRecords(records)],
    amendmentRecords: records.amendmentRecords ?? [],
    amendmentEvents: records.amendmentEvents ?? [],
  };
}

function requiredAmendmentAggregate(records: RuntimeRunRecords): RuntimeAmendmentAggregate {
  if (
    records.phaseLifecycles === undefined ||
    records.amendmentRecords === undefined ||
    records.amendmentEvents === undefined
  ) {
    throw new RuntimeRefusal(
      "amendment-proposal-required",
      "Run has no submitted amendment proposals",
    );
  }
  return records as RuntimeAmendmentAggregate;
}

function phaseLifecycleRecords(records: RuntimeRunRecords): RuntimePhaseLifecycleRecords {
  return {
    phase: records.phase,
    approvalPolicy: records.approvalPolicy,
    escalationPolicyDigest: records.escalationPolicyDigest,
    assessments: records.assessments,
    ...(records.candidate === undefined ? {} : { candidate: records.candidate }),
    ...(records.gateEvidence === undefined ? {} : { gateEvidence: records.gateEvidence }),
    ...(records.authorityDecision === undefined
      ? {}
      : { authorityDecision: records.authorityDecision }),
    ...(records.closure === undefined ? {} : { closure: records.closure }),
  };
}

// Dropping the keys rather than setting them undefined keeps the records exactly
// as they were before a gate ever ran, which is what a fresh attempt is owed.
function withoutRejectedCandidate(records: RuntimeRunRecords): RuntimeRunRecords {
  const { candidate: _candidate, gateEvidence: _gateEvidence, ...rest } = records;
  return rest;
}

function updateCurrentPhase(
  records: RuntimeRunRecords,
  changes: Partial<RuntimePhaseLifecycleRecords>,
): RuntimeRunRecords {
  const updated = { ...records, ...changes };
  if (records.phaseLifecycles === undefined) return updated;
  const current = phaseLifecycleRecords(updated);
  let matched = false;
  const phaseLifecycles = records.phaseLifecycles.map((lifecycle) => {
    if (
      lifecycle.phase.phaseId !== records.phase.phaseId ||
      lifecycle.phase.definitionGeneration !== records.phase.definitionGeneration
    ) {
      return lifecycle;
    }
    matched = true;
    return current;
  });
  if (!matched) {
    throw new RuntimeRefusal(
      "phase-history-mismatch",
      "Current phase is absent from phase-keyed lifecycle records",
    );
  }
  return { ...updated, phaseLifecycles };
}

function projectPhaseRecords(
  records: RuntimePhaseLifecycleRecords,
  graph: WorkflowGraph,
  sha256: RuntimeDependencies["sha256"],
): PhaseLifecycleProjection {
  assertPhaseInGraph(records.phase, graph);
  // A phase that closed under an earlier graph revision is history. An
  // amendment moves the revision on, and its record still verifies by its own
  // digest, so it is projected as recorded rather than re-derived.
  const candidate = records.candidate as { readonly graphRevisionDigest?: string } | undefined;
  const historical =
    candidate !== undefined && candidate.graphRevisionDigest !== graph.revisionDigest;
  return projectPhaseLifecycle(
    {
      graph,
      phase: records.phase,
      approvalPolicy: records.approvalPolicy,
      escalationPolicyDigest: records.escalationPolicyDigest,
      ...(historical ? { historical: true } : {}),
      ...(records.candidate === undefined ? {} : { candidate: records.candidate }),
      ...(records.gateEvidence === undefined ? {} : { gateEvidence: records.gateEvidence }),
      ...(records.authorityDecision === undefined
        ? {}
        : { authorityDecision: records.authorityDecision }),
      ...(records.closure === undefined ? {} : { closure: records.closure }),
    },
    sha256,
  );
}

function assertCurrentPhaseProjection(
  records: RuntimeRunRecords,
  phaseLifecycles: readonly RuntimePhaseLifecycleRecords[],
): void {
  const matching = phaseLifecycles.filter(
    ({ phase }) =>
      phase.phaseId === records.phase.phaseId &&
      phase.definitionGeneration === records.phase.definitionGeneration,
  );
  if (
    matching.length !== 1 ||
    canonicalSerialize(canonicalValue(matching[0])) !==
      canonicalSerialize(canonicalValue(phaseLifecycleRecords(records)))
  ) {
    throw new RuntimeRefusal(
      "phase-history-mismatch",
      "Current lifecycle must exactly equal its phase-keyed record",
    );
  }
  const keys = phaseLifecycles.map(({ phase }) => `${phase.phaseId}@${phase.definitionGeneration}`);
  if (new Set(keys).size !== keys.length) {
    throw new RuntimeRefusal(
      "phase-history-mismatch",
      "Phase-keyed lifecycle records must have unique generation keys",
    );
  }
}

function validateAmendmentEventChain(
  events: readonly RuntimeAmendmentEvent[],
  sha256: RuntimeDependencies["sha256"],
): void {
  for (const [index, event] of events.entries()) {
    validateTimestamp(event.occurredAt, "amendment event occurredAt");
    const content = {
      type: event.type,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      payload: canonicalValue(event.payload),
    };
    if (
      event.sequence !== index + 1 ||
      ![
        "amendment-proposal-submitted",
        "amendment-proposal-withdrawn",
        "amendment-decision-recorded",
        "amendment-fencing-required",
        "approved-amendment-applied",
      ].includes(event.type) ||
      event.eventDigest !== canonicalDigest(canonicalValue(content), sha256)
    ) {
      throw new RuntimeRefusal("invalid-amendment-event", "Amendment event chain is not canonical");
    }
  }
}

function phaseCandidateHistory(records: RuntimeRunRecords): readonly PhaseGenerationReference[] {
  const lifecycles = records.phaseLifecycles ?? [phaseLifecycleRecords(records)];
  const references = lifecycles
    .filter((lifecycle) => lifecycle.candidate !== undefined)
    .map(({ phase }) => phase)
    .sort((left, right) =>
      compareText(
        `${left.phaseId}@${left.definitionGeneration}`,
        `${right.phaseId}@${right.definitionGeneration}`,
      ),
    );
  return Object.freeze(
    references.filter(
      (reference, index) =>
        index === 0 ||
        reference.phaseId !== references[index - 1]?.phaseId ||
        reference.definitionGeneration !== references[index - 1]?.definitionGeneration,
    ),
  );
}

function requiredAmendmentRecord(
  records: RuntimeAmendmentAggregate,
  amendmentIdentity: string,
): readonly [number, RuntimeAmendmentRecords] {
  const index = records.amendmentRecords.findIndex(
    ({ proposal }) => proposal.amendmentId === amendmentIdentity,
  );
  const lifecycle = records.amendmentRecords[index];
  if (index < 0 || lifecycle === undefined) {
    throw new RuntimeRefusal("amendment-proposal-not-found", "Amendment proposal does not exist");
  }
  return [index, lifecycle];
}

function assertProposalBinding(proposalDigest: string, proposal: AmendmentProposal): void {
  if (proposalDigest !== proposal.proposalDigest) {
    throw new RuntimeRefusal(
      "amendment-proposal-conflict",
      "Command proposal digest does not match the amendment identity",
    );
  }
}

/**
 * Who may decide this proposal.
 *
 * A plan import fills in a fan-out the author already declared, and its review
 * question was settled before the proposal existed: the diff classifier refuses
 * to enqueue anything that changed or removed a member without a decision. So
 * the engine may decide one, and asking a person would be asking them to approve
 * the workflow they wrote.
 *
 * Every other proposal changes a graph nobody agreed to change, so it needs a
 * person.
 */
function assertDecidableWithoutReview(command: CommandEnvelope, proposal: AmendmentProposal): void {
  if (command.principal.roles.includes("release-manager")) return;
  const source = proposal.source as unknown;
  if (
    typeof source === "object" &&
    source !== null &&
    (source as { readonly kind?: unknown }).kind === "import-plan"
  ) {
    return;
  }
  throw new RuntimeRefusal(
    "release-manager-required",
    "Only a plan import may be decided without the release-manager role",
  );
}

function replaceAmendmentRecord(
  records: RuntimeAmendmentAggregate,
  index: number,
  lifecycle: RuntimeAmendmentRecords,
): RuntimeAmendmentAggregate {
  return {
    ...records,
    amendmentRecords: records.amendmentRecords.map((item, itemIndex) =>
      itemIndex === index ? lifecycle : item,
    ),
  };
}

function currentPendingProposals(
  records: RuntimeAmendmentAggregate,
  graph: WorkflowGraph,
  excludedAmendmentId: string,
): readonly AmendmentProposal[] {
  return records.amendmentRecords
    .filter(
      ({ proposal, decision, withdrawal, application }) =>
        proposal.amendmentId !== excludedAmendmentId &&
        proposal.baseGraph.revisionDigest === graph.revisionDigest &&
        decision === undefined &&
        withdrawal === undefined &&
        application === undefined,
    )
    .map(({ proposal }) => proposal);
}

function appendAmendmentEvent(
  records: RuntimeAmendmentAggregate,
  type: RuntimeAmendmentEventType,
  occurredAt: string,
  payload: unknown,
  sha256: RuntimeDependencies["sha256"],
): RuntimeAmendmentAggregate {
  const content = {
    type,
    sequence: records.amendmentEvents.length + 1,
    occurredAt,
    payload: canonicalValue(payload),
  } as const;
  const event = canonicalValue({
    ...content,
    eventDigest: canonicalDigest(canonicalValue(content), sha256),
  }) as unknown as RuntimeAmendmentEvent;
  return { ...records, amendmentEvents: [...records.amendmentEvents, event] };
}

function appendGraphRevisionEvent(
  records: RuntimeAmendmentAggregate,
  graph: WorkflowGraph,
  admission: AdmissionFacts,
  dependencies: RuntimeDependencies,
): RuntimeAmendmentAggregate {
  const state = replayRunEvents(records.runEvents, dependencies.sha256);
  const content = {
    type: "graph-revision-accepted",
    sequence: state.lastSequence + 1,
    occurredAt: admission.currentTime,
    runId: state.runId,
    workflowId: state.workflowId,
    beforeRevisionDigest: state.revisionDigest,
    afterRevisionDigest: graph.revisionDigest,
    graph,
    facts: canonicalValue(admission.facts),
  } as const;
  const eventDigest = digestRunEventContent(content, dependencies.sha256);
  const events = decideRunCommand(
    state,
    {
      type: "accept-graph-revision",
      eventId: eventId(`event_${eventDigest}`),
      eventContentDigest: eventDigest,
      sequence: content.sequence,
      occurredAt: content.occurredAt,
      runId: content.runId,
      workflowId: content.workflowId,
      expectedRevisionDigest: content.beforeRevisionDigest,
      graph,
      facts: content.facts,
    },
    dependencies.sha256,
  );
  return { ...records, runEvents: [...records.runEvents, ...events] };
}

function assertPhaseInGraph(phase: PhaseGenerationReference, graph: WorkflowGraph): void {
  const definition = graph.nodes.find(
    (node) => node.kind === "phase" && node.definition.id === phase.phaseId,
  )?.definition;
  if (definition === undefined || definition.generation !== phase.definitionGeneration) {
    throw new RuntimeRefusal(
      "phase-definition-mismatch",
      "Configured lifecycle phase does not match the current graph",
    );
  }
}

function assertActivePhaseTask(
  task: TaskGenerationReference,
  phase: PhaseGenerationReference,
  graph: WorkflowGraph,
): void {
  const directTasks = graph.nodes.flatMap((node) =>
    node.kind === "task" && node.definition.parentId === phase.phaseId ? [node.definition] : [],
  );
  const superseded = new Set(directTasks.flatMap((definition) => definition.supersedes));
  const definition = directTasks.find((definition) => definition.id === task.taskId);
  if (
    definition === undefined ||
    definition.generation !== task.definitionGeneration ||
    superseded.has(task.taskId)
  ) {
    throw new RuntimeRefusal(
      "task-definition-mismatch",
      "Completion task is not an active direct task of the configured phase",
    );
  }
}

function requiredRecords(run: RuntimeAuthorityRun): RuntimeRunRecords {
  if (run.records === undefined) {
    throw new RuntimeRefusal("run-not-instantiated", "Run has not been instantiated");
  }
  return run.records;
}

function parseTaskReference(value: unknown): TaskGenerationReference {
  const task = exactObject(value, "task reference", [
    "taskId",
    "definitionGeneration",
    "contextRevisionDigest",
  ]);
  requiredString(task.taskId, "taskId");
  if (
    !Number.isSafeInteger(task.definitionGeneration) ||
    (task.definitionGeneration as number) < 1
  ) {
    throw new RuntimeRefusal("invalid-completion", "Task generation must be a positive integer");
  }
  requiredDigest(task.contextRevisionDigest, "contextRevisionDigest");
  return task as unknown as TaskGenerationReference;
}

function requiredDigest(value: unknown, field: string): Sha256Digest {
  if (!isSha256Digest(value)) {
    throw new RuntimeRefusal("invalid-payload", `${field} must be a SHA-256 digest`);
  }
  return value;
}

function validateRunnerAllowancePolicy(
  value: unknown,
  escalationPolicyDigest: Sha256Digest,
): RunnerAllowancePolicy {
  const submitted = exactObject(value, "runner allowance policy", ["policyDigest", "ceilings"]);
  const policyDigest = requiredDigest(submitted.policyDigest, "allowance policy digest");
  if (policyDigest !== escalationPolicyDigest) {
    throw new TypeError("Allowance policy digest must match the escalation policy digest");
  }
  if (!Array.isArray(submitted.ceilings)) {
    throw new TypeError("Allowance policy ceilings must be an array");
  }
  const seen = new Set<string>();
  const ceilings = submitted.ceilings.map((value, index) => {
    const ceiling = exactObject(value, `allowance policy ceiling ${index}`, ["unit", "maximum"]);
    const unit = requiredString(ceiling.unit, "allowance policy unit");
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(unit) || seen.has(unit)) {
      throw new TypeError("Allowance policy units must be unique lowercase tokens");
    }
    if (!Number.isSafeInteger(ceiling.maximum) || (ceiling.maximum as number) < 0) {
      throw new TypeError("Allowance policy maximum must be a non-negative safe integer");
    }
    seen.add(unit);
    return Object.freeze({ unit, maximum: ceiling.maximum as number });
  });
  if (
    ceilings.some((ceiling, index) => {
      const previous = ceilings[index - 1];
      return previous !== undefined && previous.unit >= ceiling.unit;
    })
  ) {
    throw new TypeError("Allowance policy ceilings must be sorted by unit");
  }
  return Object.freeze({ policyDigest, ceilings: Object.freeze(ceilings) });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RuntimeRefusal("invalid-payload", `${field} must be a string`);
  }
  return value;
}

function validateTimestamp(value: string, field: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RuntimeRefusal("invalid-time", `${field} must be a UTC RFC 3339 timestamp`);
  }
}

function assertReceiptTransition(previous: ReceiptStatus | undefined, next: ReceiptStatus): void {
  const legal =
    (previous === undefined && next === "queued") ||
    (previous === "queued" && next === "claimed") ||
    (previous === "claimed" && isTerminalStatus(next));
  if (!legal) {
    throw new TypeError(`Illegal durable receipt transition ${previous ?? "none"} -> ${next}`);
  }
}

function isTerminalStatus(status: ReceiptStatus): boolean {
  return status !== "queued" && status !== "claimed";
}

function validatePageRequest(afterCursor: number, limit: number): void {
  if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
    throw new TypeError("Page cursors must be non-negative safe integers");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > PROTOCOL_LIMITS.maxPageItems) {
    throw new TypeError(`Page limits must be integers from 1 to ${PROTOCOL_LIMITS.maxPageItems}`);
  }
}

function validatePageCursor(afterCursor: number, latestCursor: number): void {
  if (afterCursor > latestCursor) {
    throw new PageQueryError("cursor-ahead", "Page cursor exceeds the latest authority cursor");
  }
}

function validateReplayCursor(afterCursor: number, earliestAvailableCursor: number): void {
  if (earliestAvailableCursor > 0 && afterCursor < earliestAvailableCursor - 1) {
    throw new PageQueryError(
      "event-replay-gap",
      "Event cursor precedes the available replay range",
    );
  }
}

function conflictReceipt(command: CommandEnvelope, cursor: number): DurableReceipt {
  return decodeDurableReceipt({
    apiVersion: PROTOCOL_VERSION,
    commandId: command.commandId,
    repositoryId: command.repositoryId,
    runId: command.runId,
    status: "refused",
    cursor,
    error: errorEnvelope(
      command,
      "command-id-conflict",
      "Command identity is already bound to a different canonical envelope",
      false,
    ),
  });
}

function errorEnvelope(
  command: CommandEnvelope,
  code: string,
  message: string,
  retryable: boolean,
): ErrorEnvelope {
  return {
    apiVersion: PROTOCOL_VERSION,
    code,
    message,
    retryable,
    commandId: command.commandId,
  };
}

function deterministicAdmissionError(
  command: CommandEnvelope,
  admission: StoredAdmission,
  authorizationDecision: boolean,
  payloadDigest: string,
): ErrorEnvelope | undefined {
  if (
    command.expiresAt !== undefined &&
    Date.parse(command.expiresAt) <= Date.parse(admission.currentTime)
  ) {
    return errorEnvelope(command, "command-expired", "Command expiry has passed", false);
  }
  if (!authorizationDecision) {
    return errorEnvelope(
      command,
      "unauthorized",
      "Principal is not authorized for this intent",
      false,
    );
  }
  if (payloadDigest !== command.payloadDigest) {
    return errorEnvelope(
      command,
      "payload-digest-mismatch",
      "Payload digest does not match payload bytes",
      false,
    );
  }
  return undefined;
}

function deterministicAuthorityIdentityError(
  command: CommandEnvelope,
  snapshotRuns: readonly SerializedRun[],
  code: string,
): ErrorEnvelope | undefined {
  if (
    code === "repository-run-conflict" &&
    snapshotRuns.some(
      (run) =>
        run.records !== undefined &&
        run.repositoryId === command.repositoryId &&
        run.runId !== command.runId,
    )
  ) {
    return errorEnvelope(
      command,
      "repository-run-conflict",
      "Repository already has a different active run",
      false,
    );
  }
  if (
    code === "run-repository-mismatch" &&
    snapshotRuns.some(
      (run) =>
        run.records !== undefined &&
        run.runId === command.runId &&
        run.repositoryId !== command.repositoryId,
    )
  ) {
    return errorEnvelope(
      command,
      "run-repository-mismatch",
      "Run identity is already bound to a different repository",
      false,
    );
  }
  return undefined;
}

function runKey(repositoryId: string, runIdentity: string): string {
  return `${repositoryId}\u0000${runIdentity}`;
}

function serializeRun(run: RuntimeAuthorityRun): SerializedRun {
  return {
    repositoryId: run.repositoryId,
    runId: run.runId,
    cursor: run.cursor,
    commands: [...run.commands.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([commandId, command]) => ({ commandId, ...command })),
    receiptHistory: run.receiptHistory,
    events: run.events,
    ...(run.records === undefined ? {} : { records: run.records }),
    ...(run.projectionGeneratedAt === undefined
      ? {}
      : { projectionGeneratedAt: run.projectionGeneratedAt }),
  };
}

function parseSerializedRun(value: unknown, dependencies: RuntimeDependencies): SerializedRun {
  const run = exactObject(
    value,
    "serialized run",
    ["repositoryId", "runId", "cursor", "commands", "receiptHistory", "events"],
    ["records", "projectionGeneratedAt"],
  );
  const repositoryId = validateOpaqueIdentity(run.repositoryId);
  const runIdentity = validateOpaqueIdentity(run.runId);
  if (!Number.isSafeInteger(run.cursor) || (run.cursor as number) < 0) {
    throw new TypeError("Serialized run cursor must be a non-negative safe integer");
  }
  if (
    !Array.isArray(run.commands) ||
    !Array.isArray(run.receiptHistory) ||
    !Array.isArray(run.events)
  ) {
    throw new TypeError("Serialized run commands, receipts, and events must be arrays");
  }
  const commands = run.commands.map((entry) => {
    const command = exactObject(entry, "serialized command", [
      "commandId",
      "canonicalEnvelope",
      "receipt",
      "admission",
    ]);
    const canonicalEnvelope = requiredString(command.canonicalEnvelope, "canonicalEnvelope");
    const decoded = decodeCommandEnvelope(canonicalEnvelope);
    if (canonicalStringify(decoded) !== canonicalEnvelope) {
      throw new TypeError("Serialized command envelope must use canonical JSON encoding");
    }
    if (decoded.commandId !== command.commandId) {
      throw new TypeError("Serialized command identity does not match its canonical envelope");
    }
    return {
      commandId: decoded.commandId,
      canonicalEnvelope,
      receipt: decodeDurableReceipt(command.receipt),
      admission: parseStoredAdmission(command.admission),
    };
  });
  const parsed: SerializedRun = {
    repositoryId,
    runId: runIdentity,
    cursor: run.cursor as number,
    commands,
    receiptHistory: run.receiptHistory.map((receipt) => decodeDurableReceipt(receipt)),
    events: run.events.map((event) => decodeEventStreamFrame(event)),
    ...(run.records === undefined
      ? {}
      : { records: parseRuntimeRunRecords(run.records, dependencies) }),
    ...(run.projectionGeneratedAt === undefined
      ? {}
      : {
          projectionGeneratedAt: requiredString(run.projectionGeneratedAt, "projectionGeneratedAt"),
        }),
  };
  validateSerializedRun(parsed);
  return parsed;
}

function validateSerializedRun(run: SerializedRun): void {
  if (run.receiptHistory.length !== run.events.length) {
    throw new TypeError("Serialized receipt and event histories must have equal lengths");
  }
  for (let index = 0; index < run.receiptHistory.length; index += 1) {
    const receipt = run.receiptHistory[index] as DurableReceipt;
    const event = run.events[index] as EventStreamFrame;
    if (
      receipt.cursor !== index + 1 ||
      event.cursor !== receipt.cursor ||
      receipt.repositoryId !== run.repositoryId ||
      receipt.runId !== run.runId ||
      event.repositoryId !== run.repositoryId ||
      event.runId !== run.runId
    ) {
      throw new TypeError("Serialized run history has invalid identity or cursor ordering");
    }
  }
  if (run.cursor !== run.receiptHistory.length) {
    throw new TypeError("Serialized run cursor must equal its final history cursor");
  }
  const eventIds = new Set(run.events.map((event) => event.eventId));
  if (eventIds.size !== run.events.length) {
    throw new TypeError("Serialized command events must have unique identities");
  }
  const receiptsByCommand = new Map<string, DurableReceipt[]>();
  for (const receipt of run.receiptHistory) {
    const receipts = receiptsByCommand.get(receipt.commandId) ?? [];
    receipts.push(receipt);
    receiptsByCommand.set(receipt.commandId, receipts);
  }
  if (receiptsByCommand.size !== run.commands.length) {
    throw new TypeError("Serialized receipt history must cover exactly the stored commands");
  }
  for (const command of run.commands) {
    const commandId = command.commandId;
    const envelope = decodeCommandEnvelope(command.canonicalEnvelope);
    const history = receiptsByCommand.get(commandId) ?? [];
    if (
      envelope.repositoryId !== run.repositoryId ||
      envelope.runId !== run.runId ||
      history.length !== 3 ||
      history[0]?.status !== "queued" ||
      history[1]?.status !== "claimed" ||
      !isTerminalStatus(history[2]?.status as ReceiptStatus) ||
      canonicalStringify(command.receipt) !== canonicalStringify(history[2])
    ) {
      throw new TypeError("Serialized commands must have one legal durable receipt lifecycle");
    }
  }
}

function parseStoredAdmission(value: unknown): StoredAdmission {
  const admission = exactObject(
    value,
    "stored command admission",
    ["currentTime", "facts", "authorizationDecision", "allocations"],
    ["trustedAmendmentQuiescence", "trustedHumanAuthority"],
  );
  const currentTime = requiredString(admission.currentTime, "currentTime");
  validateTimestamp(currentTime, "currentTime");
  if (typeof admission.authorizationDecision !== "boolean") {
    throw new TypeError("Stored authorizationDecision must be a boolean");
  }
  if (!Array.isArray(admission.allocations)) {
    throw new TypeError("Stored command allocations must be an array");
  }
  const trustedAmendmentQuiescence = admission.trustedAmendmentQuiescence as
    | AmendmentQuiescenceFact
    | undefined;
  const trustedHumanAuthority = parseTrustedHumanAuthority(admission.trustedHumanAuthority);
  return {
    currentTime,
    facts: canonicalValue(admission.facts) as unknown as JsonValue,
    authorizationDecision: admission.authorizationDecision,
    allocations: admission.allocations.map((value) => {
      const allocation = exactObject(value, "stored command allocation", ["kind", "id"]);
      if (allocation.kind !== "approval" && allocation.kind !== "stream-event") {
        throw new TypeError("Stored allocation kind is invalid");
      }
      return { kind: allocation.kind, id: validateOpaqueIdentity(allocation.id) };
    }),
    ...(trustedAmendmentQuiescence === undefined ? {} : { trustedAmendmentQuiescence }),
    ...(trustedHumanAuthority === undefined ? {} : { trustedHumanAuthority }),
  };
}

function parseTrustedHumanAuthority(value: unknown): TrustedHumanAuthorityDecision | undefined {
  if (value === undefined) return undefined;
  const submitted = exactObject(value, "trusted human authority", [], ["result", "refusal"]);
  if ((submitted.result === undefined) === (submitted.refusal === undefined)) {
    throw new TypeError("Trusted human authority must contain exactly one result or refusal");
  }
  if (submitted.refusal !== undefined) {
    const refusal = exactObject(submitted.refusal, "trusted human authority refusal", [
      "code",
      "message",
    ]);
    return Object.freeze({
      refusal: Object.freeze({
        code: requiredString(refusal.code, "trusted refusal code"),
        message: requiredString(refusal.message, "trusted refusal message"),
      }),
    });
  }
  return Object.freeze({
    result: canonicalValue(submitted.result) as unknown as JsonValue,
  });
}

function trustedHumanAuthorityResult(
  decision: TrustedHumanAuthorityDecision | undefined,
): JsonValue {
  if (decision === undefined) {
    throw new RuntimeRefusal(
      "trusted-authority-required",
      "Command requires trusted storage authority",
    );
  }
  if (decision.refusal !== undefined) {
    throw new RuntimeRefusal(decision.refusal.code, decision.refusal.message);
  }
  if (decision.result === undefined) {
    throw new RuntimeRefusal(
      "invalid-trusted-authority",
      "Trusted storage authority lacks a result",
    );
  }
  return decision.result;
}

function parseRuntimeRunRecords(
  value: unknown,
  dependencies: RuntimeDependencies,
): RuntimeRunRecords {
  const submitted = exactObject(
    value,
    "runtime run records",
    [
      "runEvents",
      "configurationSnapshotDigest",
      "execution",
      "phase",
      "approvalPolicy",
      "escalationPolicyDigest",
      "allowancePolicy",
      "assessments",
    ],
    [
      "candidate",
      "gateEvidence",
      "authorityDecision",
      "closure",
      "integrationBarrier",
      "phaseLifecycles",
      "amendmentRecords",
      "amendmentEvents",
    ],
  );
  if (!Array.isArray(submitted.runEvents) || !Array.isArray(submitted.assessments)) {
    throw new TypeError("Runtime run events and assessments must be arrays");
  }

  const phase = exactObject(submitted.phase, "runtime phase reference", [
    "phaseId",
    "definitionGeneration",
  ]);
  requiredString(phase.phaseId, "phaseId");
  if (
    !Number.isSafeInteger(phase.definitionGeneration) ||
    (phase.definitionGeneration as number) < 1
  ) {
    throw new TypeError("Runtime phase definitionGeneration must be a positive safe integer");
  }

  const policyValue = exactObject(
    submitted.approvalPolicy,
    "runtime approval policy",
    ["policy"],
    isApprovalRequiredPolicy(submitted.approvalPolicy) ? ["authority"] : [],
  );
  if (policyValue.policy !== "no-approval" && policyValue.policy !== "approval-required") {
    throw new TypeError("Runtime approval policy is invalid");
  }
  if (policyValue.policy === "approval-required" && !Object.hasOwn(policyValue, "authority")) {
    throw new TypeError("Runtime approval-required policy must include authority");
  }
  const approvalPolicy: PhaseApprovalPolicyInput =
    policyValue.policy === "no-approval"
      ? { policy: "no-approval" }
      : { policy: "approval-required", authority: canonicalValue(policyValue.authority) };

  const runEvents = submitted.runEvents as unknown as readonly RunEvent[];
  const graph = replayRunEvents(runEvents, dependencies.sha256).graph;
  const assessments = submitted.assessments.map((value) => {
    const accepted = exactObject(value, "runtime accepted assessment", [
      "assessmentDigest",
      "assessment",
    ]);
    const assessmentDigest = requiredDigest(accepted.assessmentDigest, "assessmentDigest");
    const assessment = accepted.assessment as AcceptedAccountingAssessment["assessment"];
    if (digestAccountingAssessment(assessment, dependencies.sha256) !== assessmentDigest) {
      throw new TypeError("Runtime assessment digest does not match its assessment");
    }
    return { assessmentDigest, assessment };
  });
  const escalationPolicyDigest = requiredDigest(
    submitted.escalationPolicyDigest,
    "escalationPolicyDigest",
  );
  let records: RuntimeRunRecords = {
    runEvents,
    configurationSnapshotDigest: requiredDigest(
      submitted.configurationSnapshotDigest,
      "configurationSnapshotDigest",
    ),
    execution: validateRuntimeExecutionPolicy(submitted.execution),
    phase: phase as unknown as PhaseGenerationReference,
    approvalPolicy,
    escalationPolicyDigest,
    allowancePolicy: validateRunnerAllowancePolicy(
      submitted.allowancePolicy,
      escalationPolicyDigest,
    ),
    assessments,
    ...(submitted.candidate === undefined
      ? {}
      : { candidate: submitted.candidate as PhaseCandidate }),
    ...(submitted.gateEvidence === undefined
      ? {}
      : { gateEvidence: submitted.gateEvidence as GateEvidence }),
    ...(submitted.authorityDecision === undefined
      ? {}
      : { authorityDecision: submitted.authorityDecision as AuthorityDecision }),
    ...(submitted.closure === undefined ? {} : { closure: submitted.closure as PhaseClosure }),
    ...(submitted.integrationBarrier === undefined
      ? {}
      : {
          integrationBarrier: validateIntegrationBarrier(
            submitted.integrationBarrier,
            dependencies.sha256,
          ),
        }),
  };
  projectPhaseLifecycle(
    {
      graph,
      phase: records.phase,
      approvalPolicy: records.approvalPolicy,
      escalationPolicyDigest: records.escalationPolicyDigest,
      ...(records.candidate === undefined ? {} : { candidate: records.candidate }),
      ...(records.gateEvidence === undefined ? {} : { gateEvidence: records.gateEvidence }),
      ...(records.authorityDecision === undefined
        ? {}
        : { authorityDecision: records.authorityDecision }),
      ...(records.closure === undefined ? {} : { closure: records.closure }),
    },
    dependencies.sha256,
  );
  const amendmentFields = ["phaseLifecycles", "amendmentRecords", "amendmentEvents"] as const;
  const presentAmendmentFields = amendmentFields.filter((field) => submitted[field] !== undefined);
  if (presentAmendmentFields.length !== 0 && presentAmendmentFields.length !== 3) {
    throw new TypeError("Runtime amendment record arrays must be present together");
  }
  if (presentAmendmentFields.length === 3) {
    if (
      !Array.isArray(submitted.phaseLifecycles) ||
      !Array.isArray(submitted.amendmentRecords) ||
      !Array.isArray(submitted.amendmentEvents)
    ) {
      throw new TypeError("Runtime amendment record fields must be arrays");
    }
    const phaseLifecycles = submitted.phaseLifecycles.map((lifecycle) =>
      parsePhaseLifecycleRecord(lifecycle, graph, dependencies),
    );
    records = { ...records, phaseLifecycles };
    assertCurrentPhaseProjection(records, phaseLifecycles);
    const history = phaseCandidateHistory(records);
    const amendmentRecords = submitted.amendmentRecords.map((value) => {
      const lifecycle = exactObject(
        value,
        "runtime amendment records",
        ["proposal"],
        ["decision", "withdrawal", "application"],
      );
      return {
        proposal: validateAmendmentProposal(lifecycle.proposal, history, dependencies.sha256),
        ...(lifecycle.decision === undefined
          ? {}
          : { decision: lifecycle.decision as AmendmentDecision }),
        ...(lifecycle.withdrawal === undefined
          ? {}
          : { withdrawal: lifecycle.withdrawal as AmendmentWithdrawal }),
        ...(lifecycle.application === undefined
          ? {}
          : { application: lifecycle.application as AmendmentApplication }),
      };
    });
    const amendmentEvents = submitted.amendmentEvents.map((value) => {
      const event = exactObject(value, "runtime amendment event", [
        "type",
        "sequence",
        "occurredAt",
        "payload",
        "eventDigest",
      ]);
      return {
        type: requiredString(event.type, "amendment event type") as RuntimeAmendmentEventType,
        sequence: event.sequence as number,
        occurredAt: requiredString(event.occurredAt, "amendment event occurredAt"),
        payload: canonicalValue(event.payload),
        eventDigest: requiredDigest(event.eventDigest, "amendment eventDigest"),
      };
    });
    const aggregate: RuntimeAmendmentAggregate = {
      ...records,
      phaseLifecycles,
      amendmentRecords,
      amendmentEvents,
    };
    validateAmendmentEventChain(amendmentEvents, dependencies.sha256);
    for (const lifecycle of amendmentRecords) {
      projectAmendmentLifecycle(
        {
          proposal: lifecycle.proposal,
          currentGraph: graph,
          phaseCandidateHistory: history,
          pendingProposals: currentPendingProposals(
            aggregate,
            graph,
            lifecycle.proposal.amendmentId,
          ),
          ...(lifecycle.decision === undefined ? {} : { decision: lifecycle.decision }),
          ...(lifecycle.withdrawal === undefined ? {} : { withdrawal: lifecycle.withdrawal }),
          ...(lifecycle.application === undefined ? {} : { application: lifecycle.application }),
        },
        dependencies.sha256,
      );
    }
    records = aggregate;
  }
  return records;
}

function parsePhaseLifecycleRecord(
  value: unknown,
  graph: WorkflowGraph,
  dependencies: RuntimeDependencies,
): RuntimePhaseLifecycleRecords {
  const submitted = exactObject(
    value,
    "runtime phase lifecycle records",
    ["phase", "approvalPolicy", "escalationPolicyDigest", "assessments"],
    ["candidate", "gateEvidence", "authorityDecision", "closure"],
  );
  const phase = exactObject(submitted.phase, "runtime phase lifecycle reference", [
    "phaseId",
    "definitionGeneration",
  ]);
  requiredString(phase.phaseId, "phaseId");
  if (
    !Number.isSafeInteger(phase.definitionGeneration) ||
    (phase.definitionGeneration as number) < 1
  ) {
    throw new TypeError("Runtime phase lifecycle generation must be a positive safe integer");
  }
  const policy = exactObject(
    submitted.approvalPolicy,
    "runtime phase lifecycle approval policy",
    ["policy"],
    isApprovalRequiredPolicy(submitted.approvalPolicy) ? ["authority"] : [],
  );
  if (policy.policy !== "no-approval" && policy.policy !== "approval-required") {
    throw new TypeError("Runtime phase lifecycle approval policy is invalid");
  }
  if (!Array.isArray(submitted.assessments)) {
    throw new TypeError("Runtime phase lifecycle assessments must be an array");
  }
  const assessments = submitted.assessments.map((value) => {
    const accepted = exactObject(value, "runtime phase lifecycle assessment", [
      "assessmentDigest",
      "assessment",
    ]);
    const assessmentDigest = requiredDigest(accepted.assessmentDigest, "assessmentDigest");
    const assessment = accepted.assessment as AcceptedAccountingAssessment["assessment"];
    if (digestAccountingAssessment(assessment, dependencies.sha256) !== assessmentDigest) {
      throw new TypeError("Runtime phase lifecycle assessment digest does not match");
    }
    return { assessmentDigest, assessment };
  });
  const records: RuntimePhaseLifecycleRecords = {
    phase: phase as unknown as PhaseGenerationReference,
    approvalPolicy:
      policy.policy === "no-approval"
        ? { policy: "no-approval" }
        : { policy: "approval-required", authority: canonicalValue(policy.authority) },
    escalationPolicyDigest: requiredDigest(
      submitted.escalationPolicyDigest,
      "escalationPolicyDigest",
    ),
    assessments,
    ...(submitted.candidate === undefined
      ? {}
      : {
          // An archived phase closed under an earlier graph revision, so its
          // candidate is verified by its own digest rather than re-derived.
          candidate: validatePhaseCandidate(
            submitted.candidate as PhaseCandidate,
            graph,
            dependencies.sha256,
            {
              historical:
                (submitted.candidate as { readonly graphRevisionDigest?: string })
                  .graphRevisionDigest !== graph.revisionDigest,
            },
          ),
        }),
    ...(submitted.gateEvidence === undefined
      ? {}
      : { gateEvidence: submitted.gateEvidence as GateEvidence }),
    ...(submitted.authorityDecision === undefined
      ? {}
      : { authorityDecision: submitted.authorityDecision as AuthorityDecision }),
    ...(submitted.closure === undefined ? {} : { closure: submitted.closure as PhaseClosure }),
  };
  projectPhaseRecords(records, graph, dependencies.sha256);
  return records;
}

function isApprovalRequiredPolicy(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).policy === "approval-required"
  );
}

function validateRuntimeExecutionPolicy(value: unknown): ParallelExecutionPolicy {
  const submitted = exactObject(
    value,
    "runtime execution policy",
    ["workspaceMode", "maxWriterConcurrency", "failurePolicy"],
    ["integrationRef"],
  );
  if (submitted.workspaceMode !== "repository" && submitted.workspaceMode !== "worktree") {
    throw new TypeError("Runtime workspaceMode must be repository or worktree");
  }
  if (submitted.failurePolicy !== "continue" && submitted.failurePolicy !== "fail-fast") {
    throw new TypeError("Runtime failurePolicy must be continue or fail-fast");
  }
  if (
    !Number.isSafeInteger(submitted.maxWriterConcurrency) ||
    (submitted.maxWriterConcurrency as number) < 1
  ) {
    throw new TypeError("Runtime maxWriterConcurrency must be a positive safe integer");
  }
  if (submitted.workspaceMode === "repository") {
    if (submitted.maxWriterConcurrency !== 1 || submitted.integrationRef !== undefined) {
      throw new TypeError(
        "Runtime repository execution requires one writer and no integration ref",
      );
    }
    return Object.freeze({
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: submitted.failurePolicy,
    });
  }
  if (
    typeof submitted.integrationRef !== "string" ||
    !submitted.integrationRef.startsWith("refs/heads/")
  ) {
    throw new TypeError("Runtime worktree execution requires a full local integration ref");
  }
  return Object.freeze({
    workspaceMode: "worktree",
    maxWriterConcurrency: submitted.maxWriterConcurrency as number,
    failurePolicy: submitted.failurePolicy,
    integrationRef: submitted.integrationRef,
  });
}

function validateSnapshotUniqueness(runs: readonly SerializedRun[]): void {
  const runKeys = new Set<string>();
  const activeRepositoryIds = new Set<string>();
  const activeRunIds = new Set<string>();
  const commandIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const run of runs) {
    const key = runKey(run.repositoryId, run.runId);
    if (runKeys.has(key))
      throw new TypeError("Runtime authority snapshot contains duplicate run keys");
    runKeys.add(key);
    if (run.records !== undefined && activeRepositoryIds.has(run.repositoryId)) {
      throw new TypeError("Runtime authority snapshot contains multiple runs for one repository");
    }
    if (run.records !== undefined && activeRunIds.has(run.runId)) {
      throw new TypeError(
        "Runtime authority snapshot contains one active run in multiple repositories",
      );
    }
    if (run.records !== undefined) {
      activeRepositoryIds.add(run.repositoryId);
      activeRunIds.add(run.runId);
    }
    for (const command of run.commands) {
      if (commandIds.has(command.commandId)) {
        throw new TypeError("Runtime authority snapshot contains duplicate command identities");
      }
      commandIds.add(command.commandId);
    }
    for (const event of run.events) {
      if (eventIds.has(event.eventId)) {
        throw new TypeError(
          "Runtime authority snapshot contains duplicate stream event identities",
        );
      }
      eventIds.add(event.eventId);
    }
  }
}

function replaySerializedRun(
  service: RuntimeCommandService,
  run: SerializedRun,
  snapshotRuns: readonly SerializedRun[],
): void {
  const firstCursorByCommand = new Map<string, number>();
  for (const receipt of run.receiptHistory) {
    if (!firstCursorByCommand.has(receipt.commandId)) {
      firstCursorByCommand.set(receipt.commandId, receipt.cursor);
    }
  }
  const commands = [...run.commands].sort(
    (left, right) =>
      (firstCursorByCommand.get(left.commandId) as number) -
      (firstCursorByCommand.get(right.commandId) as number),
  );
  for (const stored of commands) {
    if (
      stored.receipt.status !== "completed" &&
      stored.receipt.error !== undefined &&
      stored.admission.trustedHumanAuthority === undefined &&
      [
        "command-expired",
        "unauthorized",
        "payload-digest-mismatch",
        "repository-run-conflict",
        "run-repository-mismatch",
        "invalid-command",
      ].includes(stored.receipt.error.code)
    ) {
      service.restoreNonEffectCommand(run, stored, snapshotRuns);
      continue;
    }
    let allocationIndex = 0;
    const receipt = service.submitWithTrustedFacts(
      stored.canonicalEnvelope,
      {
        currentTime: stored.admission.currentTime,
        facts: stored.admission.facts,
        allocateId(kind) {
          const allocation = stored.admission.allocations[allocationIndex];
          if (allocation === undefined || allocation.kind !== kind) {
            throw new TypeError("Stored command allocation sequence does not match replay");
          }
          allocationIndex += 1;
          return allocation.id;
        },
      },
      {
        ...(stored.admission.trustedAmendmentQuiescence === undefined
          ? {}
          : { amendmentQuiescence: stored.admission.trustedAmendmentQuiescence }),
        ...(stored.admission.trustedHumanAuthority === undefined
          ? {}
          : { humanAuthority: stored.admission.trustedHumanAuthority }),
      },
    );
    if (allocationIndex !== stored.admission.allocations.length) {
      throw new TypeError("Stored command contains unused replay allocations");
    }
    const replayed = service.authority.runs
      .get(runKey(run.repositoryId, run.runId))
      ?.commands.get(stored.commandId);
    if (
      replayed?.admission.authorizationDecision !== stored.admission.authorizationDecision ||
      canonicalStringify(receipt) !== canonicalStringify(stored.receipt)
    ) {
      throw new TypeError("Stored command receipt or authorization decision does not match replay");
    }
  }
}

function exactObject(
  value: unknown,
  subject: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeRefusal("invalid-payload", `${subject} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !allowed.has(key))
  ) {
    throw new RuntimeRefusal(
      "invalid-payload",
      `${subject} fields must be exactly ${required.join(", ")} plus documented optional fields`,
    );
  }
  return object;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** True when a blocking rule did not evaluate to true, so it did not pass. */
function isFailedRule(rule: { readonly result: unknown } | undefined): boolean {
  return rule !== undefined && rule.result !== true;
}
