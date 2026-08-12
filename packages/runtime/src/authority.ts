import {
  type AcceptedAccountingAssessment,
  type AuthorityDecision,
  approvalId,
  assessCompletionAccounting,
  type CompletionSubmission,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  closePhase,
  createAuthorityDecision,
  createPhaseCandidate,
  decideRunCommand,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestRunEventContent,
  digestSelectedTaskSet,
  evaluateGate,
  eventId,
  type GateEvidence,
  isSha256Digest,
  type PhaseApprovalPolicyInput,
  type PhaseCandidate,
  type PhaseClosure,
  type PhaseGenerationReference,
  type PhaseLifecycleProjection,
  projectPhaseLifecycle,
  type RunEvent,
  replayRunEvents,
  runId,
  type SensorReading,
  type Sha256Digest,
  type TaskGenerationReference,
  validateGateDefinition,
  validateGateEvidence,
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
  decodeCommandEnvelope,
  decodeDurableReceipt,
  decodeEventStreamFrame,
  decodeProjectionEnvelope,
  type ErrorEnvelope,
  type EventStreamFrame,
  type JsonValue,
  PROTOCOL_VERSION,
  type ProjectionEnvelope,
  type ReceiptStatus,
  validateOpaqueIdentity,
} from "@senawa/protocol";
import type {
  AdmissionFacts,
  AllocationKind,
  AuthorizationPolicy,
  CommandServicePort,
  RuntimeDependencies,
  RuntimeQueryPort,
  SerializableAuthorityPort,
} from "./ports.js";

const SNAPSHOT_VERSION = "senawa.dev/runtime-memory/v1alpha1" as const;

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
  readonly phase: PhaseGenerationReference;
  readonly approvalPolicy: PhaseApprovalPolicyInput;
  readonly escalationPolicyDigest: Sha256Digest;
  readonly assessments: readonly AcceptedAccountingAssessment[];
  readonly candidate?: PhaseCandidate;
  readonly gateEvidence?: GateEvidence;
  readonly authorityDecision?: AuthorityDecision;
  readonly closure?: PhaseClosure;
}

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
}

interface MutableRun {
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

export class InMemoryAuthority implements SerializableAuthorityPort {
  readonly runs: Map<string, MutableRun>;

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
    for (const run of runs) replaySerializedRun(service, run);
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
  readonly authority: InMemoryAuthority;
  readonly dependencies: RuntimeDependencies;

  constructor(dependencies: RuntimeDependencies, authority = new InMemoryAuthority()) {
    this.dependencies = dependencies;
    this.authority = authority;
    for (const run of authority.runs.values()) {
      this.validateHydratedRun(run);
    }
  }

  submit(input: string | unknown, admission: AdmissionFacts): DurableReceipt {
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
      const result = this.execute(command, capturedAdmission, run);
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

  restoreNonEffectCommand(
    sourceRun: SerializedRun,
    stored: SerializedRun["commands"][number],
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
    if (deterministicError !== undefined) {
      const expectedStatus = deterministicError.code === "command-expired" ? "expired" : "refused";
      if (
        terminal.status !== expectedStatus ||
        canonicalStringify(terminalError) !== canonicalStringify(deterministicError)
      ) {
        throw new TypeError("Stored deterministic refusal does not match admission facts");
      }
    } else if (
      terminal.status !== "refused" ||
      terminalError.code !== "invalid-command" ||
      terminalError.retryable ||
      terminalError.commandId !== command.commandId ||
      terminalError.message.length === 0 ||
      terminalError.details !== undefined
    ) {
      throw new TypeError("Stored post-execution refusal has invalid error semantics");
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

  private execute(command: CommandEnvelope, admission: AdmissionFacts, run: MutableRun): JsonValue {
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
      case "close-phase":
        return this.closePhase(command, run);
      default:
        throw new RuntimeRefusal("unsupported-intent", "Intent is not implemented in this slice");
    }
  }

  private instantiateRun(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: MutableRun,
  ): JsonValue {
    if (run.records !== undefined) {
      throw new RuntimeRefusal("run-already-instantiated", "Run is already instantiated");
    }
    const payload = exactObject(command.payload, "instantiate-run payload", [
      "workflowId",
      "graph",
      "phase",
      "approvalPolicy",
      "escalationPolicyDigest",
    ]);
    const graph = validateWorkflowGraph(payload.graph, this.dependencies.sha256);
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
      phase: payload.phase as unknown as PhaseGenerationReference,
      approvalPolicy: payload.approvalPolicy as unknown as PhaseApprovalPolicyInput,
      escalationPolicyDigest: requiredDigest(
        payload.escalationPolicyDigest,
        "escalationPolicyDigest",
      ),
      assessments: [],
    };
    this.project(records);
    run.records = records;
    return canonicalValue({ graphRevision: graph.revisionDigest }) as unknown as JsonValue;
  }

  private acceptGraphRevision(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: MutableRun,
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

  private submitCompletion(command: CommandEnvelope, run: MutableRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (records.candidate !== undefined) {
      throw new RuntimeRefusal(
        "candidate-exists",
        "Completion cannot change after candidate creation",
      );
    }
    const payload = exactObject(command.payload, "submit-completion payload", ["submission"]);
    const submission = exactObject(
      payload.submission,
      "completion submission",
      ["task", "disposition", "summary", "criteria", "evidence"],
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
    run.records = {
      ...records,
      assessments: [...records.assessments, { assessmentDigest, assessment }],
    };
    return canonicalValue({ assessmentDigest, assessment }) as unknown as JsonValue;
  }

  private evaluateGate(command: CommandEnvelope, run: MutableRun): JsonValue {
    const records = requiredRecords(run);
    this.assertGraphRevision(command, records);
    if (records.candidate !== undefined) {
      throw new RuntimeRefusal("candidate-exists", "A phase candidate already exists");
    }
    const payload = exactObject(
      command.payload,
      "evaluate-gate payload",
      ["phase", "dependencyBarrierDigest", "gateDefinition", "readings"],
      ["integrationBarrierDigest"],
    );
    const graph = currentGraph(records, this.dependencies.sha256);
    const definition = validateGateDefinition(payload.gateDefinition, this.dependencies.sha256);
    if (!Array.isArray(payload.readings)) {
      throw new RuntimeRefusal("invalid-gate", "Gate readings must be an array");
    }
    const tasks = records.assessments.map((accepted) => accepted.assessment.submission.task);
    const candidate = createPhaseCandidate(
      {
        phase: payload.phase as unknown as PhaseGenerationReference,
        graphRevisionDigest: graph.revisionDigest,
        selectedTaskSetDigest: digestSelectedTaskSet(tasks, this.dependencies.sha256),
        tasks,
        acceptedAccountingAssessments: records.assessments,
        dependencyBarrierDigest: requiredDigest(
          payload.dependencyBarrierDigest,
          "dependencyBarrierDigest",
        ),
        ...(payload.integrationBarrierDigest === undefined
          ? {}
          : {
              integrationBarrierDigest: requiredDigest(
                payload.integrationBarrierDigest,
                "integrationBarrierDigest",
              ),
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
    const updated = { ...records, candidate, gateEvidence };
    this.project(updated);
    run.records = updated;
    return canonicalValue({ candidate, gateEvidence }) as unknown as JsonValue;
  }

  private recordAuthorityDecision(
    command: CommandEnvelope,
    admission: AdmissionFacts,
    run: MutableRun,
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
    const payload = exactObject(command.payload, "authority-decision payload", ["decision"]);
    if (payload.decision !== "approve" && payload.decision !== "reject") {
      throw new RuntimeRefusal("invalid-decision", "Decision must be approve or reject");
    }
    const authorityDecision = createAuthorityDecision(
      {
        decision: payload.decision,
        approvalId: approvalId(admission.allocateId("approval", command)),
        principal: command.principal,
        occurredAt: admission.currentTime,
        candidateDigest: records.candidate.candidateDigest,
      },
      this.dependencies.sha256,
    );
    const updated = { ...records, authorityDecision };
    this.project(updated);
    run.records = updated;
    return canonicalValue(authorityDecision) as unknown as JsonValue;
  }

  private closePhase(command: CommandEnvelope, run: MutableRun): JsonValue {
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
    const updated = { ...records, closure };
    this.project(updated);
    run.records = updated;
    return canonicalValue(closure) as unknown as JsonValue;
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

  private validateAuthorityIdentity(command: CommandEnvelope, current: MutableRun): void {
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

  private project(records: RuntimeRunRecords): PhaseLifecycleProjection {
    const graph = currentGraph(records, this.dependencies.sha256);
    assertPhaseInGraph(records.phase, graph);
    return projectPhaseLifecycle(
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
  }

  private validateHydratedRun(run: MutableRun): void {
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
    let records = { ...run.records, assessments: validatedAssessments };
    if (records.candidate !== undefined) {
      records = {
        ...records,
        candidate: validatePhaseCandidate(records.candidate, graph, this.dependencies.sha256),
      };
    }
    this.project(records);
    run.records = records;
  }

  private transition(
    run: MutableRun,
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
  ): { readonly run: MutableRun; readonly command: StoredCommand } | undefined {
    for (const run of this.authority.runs.values()) {
      const command = run.commands.get(commandId);
      if (command !== undefined) return { run, command };
    }
    return undefined;
  }

  private getOrCreateRun(repositoryId: string, runIdentity: string): MutableRun {
    const key = runKey(repositoryId, runIdentity);
    const current = this.authority.runs.get(key);
    if (current !== undefined) return current;
    const run: MutableRun = {
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

function requiredRecords(run: MutableRun): RuntimeRunRecords {
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

function runKey(repositoryId: string, runIdentity: string): string {
  return `${repositoryId}\u0000${runIdentity}`;
}

function serializeRun(run: MutableRun): SerializedRun {
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
  const admission = exactObject(value, "stored command admission", [
    "currentTime",
    "facts",
    "authorizationDecision",
    "allocations",
  ]);
  const currentTime = requiredString(admission.currentTime, "currentTime");
  validateTimestamp(currentTime, "currentTime");
  if (typeof admission.authorizationDecision !== "boolean") {
    throw new TypeError("Stored authorizationDecision must be a boolean");
  }
  if (!Array.isArray(admission.allocations)) {
    throw new TypeError("Stored command allocations must be an array");
  }
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
  };
}

function parseRuntimeRunRecords(
  value: unknown,
  dependencies: RuntimeDependencies,
): RuntimeRunRecords {
  const submitted = exactObject(
    value,
    "runtime run records",
    ["runEvents", "phase", "approvalPolicy", "escalationPolicyDigest", "assessments"],
    ["candidate", "gateEvidence", "authorityDecision", "closure"],
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
  const records: RuntimeRunRecords = {
    runEvents,
    phase: phase as unknown as PhaseGenerationReference,
    approvalPolicy,
    escalationPolicyDigest: requiredDigest(
      submitted.escalationPolicyDigest,
      "escalationPolicyDigest",
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

function validateSnapshotUniqueness(runs: readonly SerializedRun[]): void {
  const runKeys = new Set<string>();
  const repositoryIds = new Set<string>();
  const commandIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const run of runs) {
    const key = runKey(run.repositoryId, run.runId);
    if (runKeys.has(key))
      throw new TypeError("Runtime authority snapshot contains duplicate run keys");
    runKeys.add(key);
    if (repositoryIds.has(run.repositoryId)) {
      throw new TypeError("Runtime authority snapshot contains multiple runs for one repository");
    }
    repositoryIds.add(run.repositoryId);
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

function replaySerializedRun(service: RuntimeCommandService, run: SerializedRun): void {
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
    if (stored.receipt.status !== "completed") {
      service.restoreNonEffectCommand(run, stored);
      continue;
    }
    let allocationIndex = 0;
    const receipt = service.submit(stored.canonicalEnvelope, {
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
    });
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
