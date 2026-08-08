import { createHash } from "node:crypto";
import {
  type RuntimeGraphDefinition,
  RuntimeRevisionConflictError,
  type RuntimeStateStoragePort,
  type StoredRuntimeState,
  type VersionedStoredRuntimeState,
} from "@senawa/application";
import type { RuntimePhase, RuntimeTask } from "@senawa/domain";
import { BeadsClient } from "./beads-client.js";

type TransitionStep = "pending-metadata" | "coarse-status" | "state-event" | "final-metadata";

export interface BeadsRuntimeStateOptions {
  readonly client?: BeadsClient;
  readonly afterTransitionStep?: (
    step: TransitionStep,
    context: { readonly operationId: string; readonly issueId: string },
  ) => void | Promise<void>;
}

interface BeadsIssue {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly issue_type: string;
  readonly assignee?: string;
  readonly metadata?: Record<string, unknown>;
}

interface SenawaIssueMetadata extends Record<string, unknown> {
  readonly kind?: unknown;
  readonly gate_id?: unknown;
  readonly node_id?: unknown;
  readonly pending_operation?: unknown;
}

interface OperationReceipt {
  readonly digest: string;
  readonly revision: number;
  readonly result_node_id?: string;
}

interface PendingOperation {
  readonly id: string;
  readonly expected_revision: number;
  readonly desired_revision: number;
  readonly desired_state: string;
  readonly payload_digest: string;
}

interface RunMetadata {
  readonly kind: "run";
  readonly run_id: string;
  readonly api_version: "senawa.dev/runtime/v1";
  readonly status: StoredRuntimeState["status"];
  readonly end_reason: string | null;
  readonly revision: number;
  readonly last_operation_id: string;
  readonly operation_receipts: Readonly<Record<string, OperationReceipt>>;
  readonly pending_operation?: PendingOperation;
  readonly active_turn: StoredRuntimeState["activeTurn"];
  readonly dispatches: StoredRuntimeState["dispatches"];
}

interface PhaseMetadata {
  readonly kind: "phase";
  readonly run_id: string;
  readonly node_id: string;
  readonly order: number;
  readonly executor_kind: "agent" | "task-frontier" | "sensor-only" | "human" | "foreach";
  readonly status: RuntimePhase["status"];
  readonly iteration: number;
  readonly artifact_version: number | null;
  readonly session_id: string | null;
  readonly rejection_reason: string | null;
  readonly gate_id: string | null;
  readonly pending_operation?: PendingOperation;
}

interface TaskMetadata {
  readonly kind: "task";
  readonly run_id: string;
  readonly node_id: string;
  readonly parent_phase_id: string;
  readonly order: number;
  readonly definition: Omit<
    RuntimeTask,
    | "status"
    | "attempt"
    | "dispatchFailures"
    | "sessionId"
    | "steering"
    | "reworkFindings"
    | "reworkFeedback"
  >;
  readonly status: RuntimeTask["status"];
  readonly attempt: number;
  readonly dispatch_failures: number;
  readonly session_id: string | null;
  readonly steering: readonly string[];
  readonly rework_findings?: readonly string[];
  readonly rework_feedback?: RuntimeTask["reworkFeedback"];
  readonly pending_operation?: PendingOperation;
}

export class BeadsRuntimeStateStore implements RuntimeStateStoragePort {
  private readonly client: BeadsClient;

  constructor(
    repositoryRoot: string,
    private readonly options: BeadsRuntimeStateOptions = {},
  ) {
    this.client = options.client ?? new BeadsClient(repositoryRoot);
  }

  async createRuntimeState(
    runId: string,
    state: StoredRuntimeState,
    operationId: string,
    graph: RuntimeGraphDefinition,
  ): Promise<VersionedStoredRuntimeState> {
    await this.client.ensureInitialized();
    const digest = payloadDigest(state);
    const issues = await this.listAll();
    let epic = findRunIssue(issues, runId);
    if (epic === undefined) {
      epic = await this.writeJson<BeadsIssue>([
        "create",
        `Senawa run ${runId}`,
        "--type",
        "epic",
        "--metadata",
        metadataJson(
          indexMetadata(runId, "run", {
            ...runMetadata(runId, state, operationId, 0, {}),
            pending_operation: pending(operationId, 0, 1, state.status, digest),
          }),
        ),
      ]);
      await this.afterStep("pending-metadata", operationId, epic.id);
    } else {
      const metadata = requireRunMetadata(epic, runId);
      const receipt = metadata.operation_receipts[operationId];
      if (receipt !== undefined) {
        if (receipt.digest !== digest) throw operationConflict(operationId);
        return this.readRuntimeState(runId);
      }
      if (metadata.pending_operation?.id !== operationId) {
        throw new Error(`Run already exists: ${runId}`);
      }
    }

    const phaseIssues = new Map<string, BeadsIssue>();
    for (const [index, definition] of graph.phases.entries()) {
      let issue = findNodeIssue(issues, runId, "phase", definition.id);
      if (issue === undefined) {
        const phase = requirePhase(state, definition.id);
        issue = await this.writeJson<BeadsIssue>([
          "create",
          definition.title,
          "--type",
          "task",
          "--parent",
          epic.id,
          "--metadata",
          metadataJson(
            indexMetadata(
              runId,
              "phase",
              phaseMetadata(runId, phase, index, definition.executorKind, null),
            ),
          ),
        ]);
        await this.setStateLabel(issue.id, phase.status, operationId);
      }
      phaseIssues.set(definition.id, issue);
    }
    for (const definition of graph.phases) {
      const dependent = requireMapValue(phaseIssues, definition.id);
      for (const blockerId of definition.dependsOn) {
        await this.ensureDependency(dependent.id, requireMapValue(phaseIssues, blockerId).id);
      }
    }
    await this.convergeTasks(runId, epic.id, phaseIssues, state, operationId, issues);
    await this.finalizeRun(epic, state, operationId, digest, 1, {});
    return this.readConverged(runId, digest);
  }

  async readRuntimeState(runId: string): Promise<VersionedStoredRuntimeState> {
    return projectRuntimeState(await this.listAll(), runId);
  }

  async commitRuntimeState(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
    readonly state: StoredRuntimeState;
  }): Promise<VersionedStoredRuntimeState> {
    await this.client.assertSupported();
    const digest = payloadDigest(input.state);
    const issues = await this.listAll();
    const epic = findRunIssue(issues, input.runId);
    if (epic === undefined) throw new Error(`Run does not exist: ${input.runId}`);
    const current = requireRunMetadata(epic, input.runId);
    const receipt = current.operation_receipts[input.operationId];
    if (receipt !== undefined) {
      if (receipt.digest !== digest) throw operationConflict(input.operationId);
      return this.readRuntimeState(input.runId);
    }
    const pendingForRetry = current.pending_operation?.id === input.operationId;
    if (!pendingForRetry && String(current.revision) !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    if (
      isTerminal(current.status) &&
      payloadDigest(projectRuntimeState(issues, input.runId).state) !== digest
    ) {
      throw new Error(`Run ${input.runId} is terminal and cannot be mutated`);
    }
    const desiredRevision = current.revision + 1;
    if (!pendingForRetry) {
      await this.updateMetadata(
        epic.id,
        indexMetadata(input.runId, "run", {
          ...current,
          pending_operation: pending(
            input.operationId,
            current.revision,
            desiredRevision,
            input.state.status,
            digest,
          ),
        }),
      );
      await this.afterStep("pending-metadata", input.operationId, epic.id);
    }

    const phaseIssues = new Map(
      issues
        .filter((issue) => nodeKind(issue, input.runId) === "phase")
        .map((issue) => [requirePhaseMetadata(issue, input.runId).node_id, issue]),
    );
    await this.convergePhases(input.runId, phaseIssues, input.state, input.operationId);
    await this.convergeTasks(
      input.runId,
      epic.id,
      phaseIssues,
      input.state,
      input.operationId,
      issues,
    );
    await this.transitionIssue(epic, input.state.status, input.operationId, async () =>
      indexMetadata(input.runId, "run", {
        ...runMetadata(
          input.runId,
          input.state,
          input.operationId,
          desiredRevision,
          current.operation_receipts,
        ),
        operation_receipts: {
          ...current.operation_receipts,
          [input.operationId]: { digest, revision: desiredRevision },
        },
      }),
    );
    return this.readConverged(input.runId, digest);
  }

  async claimReadyTask(input: {
    readonly runId: string;
    readonly expectedRevision: string;
    readonly operationId: string;
  }): Promise<RuntimeTask | null> {
    await this.client.assertSupported();
    const before = await this.listAll();
    const epic = findRunIssue(before, input.runId);
    if (epic === undefined) throw new Error(`Run does not exist: ${input.runId}`);
    const run = requireRunMetadata(epic, input.runId);
    const receipt = run.operation_receipts[input.operationId];
    if (receipt?.result_node_id !== undefined) {
      const issue = findNodeIssue(before, input.runId, "task", receipt.result_node_id);
      if (issue === undefined)
        throw new Error(`Claim receipt references missing task ${receipt.result_node_id}`);
      return runtimeTask(requireTaskMetadata(issue, input.runId), issue.status);
    }
    if (String(run.revision) !== input.expectedRevision) {
      throw new RuntimeRevisionConflictError(input.runId, input.operationId);
    }
    const claimed = await this.writeJson<BeadsIssue[]>([
      "ready",
      "--claim",
      "--type",
      "task",
      "--metadata-field",
      `senawa_run_id=${input.runId}`,
      "--metadata-field",
      "senawa_kind=task",
    ]);
    const issue = claimed[0];
    if (issue === undefined) return null;
    const metadata = requireTaskMetadata(issue, input.runId);
    const desired = { ...runtimeTask(metadata, issue.status), status: "in_progress" as const };
    await this.transitionIssue(issue, desired.status, input.operationId, async () =>
      indexMetadata(
        input.runId,
        "task",
        taskMetadata(input.runId, desired, metadata.parent_phase_id, metadata.order),
      ),
    );
    const refreshedIssues = await this.listAll();
    const desiredState = projectRuntimeState(refreshedIssues, input.runId).state;
    const refreshedEpic = findRunIssue(refreshedIssues, input.runId);
    if (refreshedEpic === undefined) throw new Error(`Run does not exist: ${input.runId}`);
    const refreshedRun = requireRunMetadata(refreshedEpic, input.runId);
    const revision = refreshedRun.revision + 1;
    const digest = payloadDigest(desiredState);
    await this.transitionIssue(refreshedEpic, desiredState.status, input.operationId, async () =>
      indexMetadata(input.runId, "run", {
        ...runMetadata(
          input.runId,
          desiredState,
          input.operationId,
          revision,
          refreshedRun.operation_receipts,
        ),
        operation_receipts: {
          ...refreshedRun.operation_receipts,
          [input.operationId]: {
            digest,
            revision,
            result_node_id: metadata.node_id,
          },
        },
      }),
    );
    return desired;
  }

  private async convergePhases(
    runId: string,
    issues: ReadonlyMap<string, BeadsIssue>,
    state: StoredRuntimeState,
    operationId: string,
  ): Promise<void> {
    for (const desired of state.phases) {
      const issue = requireMapValue(issues, desired.id);
      const current = requirePhaseMetadata(issue, runId);
      await this.transitionIssue(issue, desired.status, operationId, async (gateId) =>
        indexMetadata(
          runId,
          "phase",
          phaseMetadata(runId, desired, current.order, current.executor_kind, gateId),
        ),
      );
    }
  }

  private async convergeTasks(
    runId: string,
    epicId: string,
    phaseIssues: ReadonlyMap<string, BeadsIssue>,
    state: StoredRuntimeState,
    operationId: string,
    issues: readonly BeadsIssue[],
  ): Promise<void> {
    const frontier = [...phaseIssues.values()].find(
      (issue) => requirePhaseMetadata(issue, runId).executor_kind === "task-frontier",
    );
    if (state.tasks.length > 0 && frontier === undefined) {
      throw new Error(`Run ${runId} has tasks but no task-frontier phase`);
    }
    const taskIssues = new Map(
      issues
        .filter((issue) => nodeKind(issue, runId) === "task")
        .map((issue) => [requireTaskMetadata(issue, runId).node_id, issue]),
    );
    for (const [order, desired] of state.tasks.entries()) {
      let issue = taskIssues.get(desired.key);
      if (issue === undefined) {
        const parent = frontier?.id ?? epicId;
        issue = await this.writeJson<BeadsIssue>([
          "create",
          desired.title,
          "--type",
          "task",
          "--parent",
          parent,
          "--metadata",
          metadataJson(
            indexMetadata(
              runId,
              "task",
              taskMetadata(
                runId,
                desired,
                frontier === undefined ? "" : requirePhaseMetadata(frontier, runId).node_id,
                order,
              ),
            ),
          ),
        ]);
        await this.setStateLabel(issue.id, desired.status, operationId);
        taskIssues.set(desired.key, issue);
      } else {
        const metadata = requireTaskMetadata(issue, runId);
        await this.transitionIssue(issue, desired.status, operationId, async () =>
          indexMetadata(
            runId,
            "task",
            taskMetadata(runId, desired, metadata.parent_phase_id, metadata.order),
          ),
        );
      }
    }
    for (const desired of state.tasks) {
      const dependent = requireMapValue(taskIssues, desired.key);
      for (const blockerId of desired.dependsOn) {
        await this.ensureDependency(dependent.id, requireMapValue(taskIssues, blockerId).id);
      }
    }
  }

  private async transitionIssue(
    issue: BeadsIssue,
    desiredState: string,
    operationId: string,
    finalMetadata: (gateId: string | null) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const currentSenawa = requireSenawa(issue);
    const supportsHumanGate = currentSenawa.kind === "phase";
    const supportsTaskClaim = currentSenawa.kind === "task";
    const existingGateId = stringOrNull(currentSenawa.gate_id);
    const final = await finalMetadata(existingGateId);
    if (
      isConverged(issue, {
        desiredState,
        existingGateId,
        final,
        supportsHumanGate,
        supportsTaskClaim,
      })
    ) {
      return;
    }
    const { senawa } = final;
    const pendingMetadata = {
      ...final,
      senawa: {
        ...requireRecord(senawa, `metadata for ${issue.id}`),
        pending_operation: pending(operationId, 0, 0, desiredState, payloadDigest(final)),
      },
    };
    await this.updateMetadata(issue.id, pendingMetadata);
    await this.afterStep("pending-metadata", operationId, issue.id);

    let gateId = existingGateId;
    if (gateId !== null && desiredState !== "awaiting_approval") {
      await this.writeRaw([
        "gate",
        "resolve",
        gateId,
        "--reason",
        `Senawa operation ${operationId}`,
      ]);
      gateId = null;
    }
    await this.setCoarseStatus(issue.id, issue.status, desiredState, supportsTaskClaim);
    await this.afterStep("coarse-status", operationId, issue.id);
    await this.setStateLabel(issue.id, desiredState, operationId);
    if (supportsHumanGate && desiredState === "awaiting_approval" && gateId === null) {
      const gate = await this.writeJson<BeadsIssue>([
        "gate",
        "create",
        "--type=human",
        "--blocks",
        issue.id,
        "--reason",
        `Senawa node ${issue.title} awaits human approval`,
      ]);
      gateId = gate.id;
    }
    await this.afterStep("state-event", operationId, issue.id);
    await this.updateMetadata(issue.id, await finalMetadata(gateId));
    await this.afterStep("final-metadata", operationId, issue.id);
  }

  private async finalizeRun(
    epic: BeadsIssue,
    state: StoredRuntimeState,
    operationId: string,
    digest: string,
    revision: number,
    receipts: Readonly<Record<string, OperationReceipt>>,
  ): Promise<void> {
    await this.transitionIssue(epic, state.status, operationId, async () =>
      indexMetadata(
        state.phases[0] === undefined
          ? requireRunMetadata(epic).run_id
          : requireRunMetadata(epic).run_id,
        "run",
        {
          ...runMetadata(requireRunMetadata(epic).run_id, state, operationId, revision, receipts),
          operation_receipts: {
            ...receipts,
            [operationId]: { digest, revision },
          },
        },
      ),
    );
  }

  private async readConverged(runId: string, digest: string): Promise<VersionedStoredRuntimeState> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.readRuntimeState(runId);
      if (payloadDigest(current.state) === digest) return current;
    }
    throw new Error(`Beads state for ${runId} did not converge to the requested operation`);
  }

  private async setCoarseStatus(
    issueId: string,
    currentStatus: string,
    desiredState: string,
    supportsTaskClaim: boolean,
  ): Promise<void> {
    const desiredStatus = coarseStatus(desiredState);
    const releaseClaim = supportsTaskClaim && desiredStatus === "open";
    if (currentStatus === desiredStatus && !releaseClaim) return;
    if (desiredStatus === "closed") {
      await this.writeJson(["close", issueId, "--reason", `Senawa state ${desiredState}`]);
      return;
    }
    await this.writeJson([
      "update",
      issueId,
      "--status",
      desiredStatus,
      ...(releaseClaim ? ["--assignee", ""] : []),
    ]);
  }

  private async setStateLabel(issueId: string, state: string, operationId: string): Promise<void> {
    await this.writeJson([
      "set-state",
      issueId,
      `senawa=${state}`,
      "--reason",
      `Senawa operation ${operationId}`,
    ]);
  }

  private async ensureDependency(dependentId: string, blockerId: string): Promise<void> {
    try {
      await this.writeJson(["dep", "add", dependentId, blockerId]);
    } catch (error) {
      if (error instanceof Error && /already exists|duplicate/iu.test(error.message)) return;
      throw error;
    }
  }

  private async updateMetadata(issueId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.writeJson(["update", issueId, "--metadata", metadataJson(metadata)]);
  }

  private async listAll(): Promise<BeadsIssue[]> {
    const issues = await this.client.json<BeadsIssue[]>(["list", "--all", "--limit", "0"]);
    return issues.filter((issue) => issue.issue_type !== "event");
  }

  private async writeJson<T = unknown>(arguments_: readonly string[]): Promise<T> {
    return this.client.json<T>(arguments_);
  }

  private async writeRaw(arguments_: readonly string[]): Promise<void> {
    await this.client.raw(arguments_);
  }

  private afterStep(step: TransitionStep, operationId: string, issueId: string): Promise<void> {
    return Promise.resolve(this.options.afterTransitionStep?.(step, { operationId, issueId }));
  }
}

function projectRuntimeState(
  issues: readonly BeadsIssue[],
  runId: string,
): VersionedStoredRuntimeState {
  const epic = findRunIssue(issues, runId);
  if (epic === undefined) throw new Error(`Run does not exist: ${runId}`);
  const run = requireRunMetadata(epic, runId);
  const phases = issues
    .filter((issue) => nodeKind(issue, runId) === "phase")
    .map((issue) => requirePhaseMetadata(issue, runId))
    .toSorted((left, right) => left.order - right.order)
    .map(runtimePhase);
  const tasks = issues
    .filter((issue) => nodeKind(issue, runId) === "task")
    .map((issue) => ({ issue, metadata: requireTaskMetadata(issue, runId) }))
    .toSorted((left, right) => left.metadata.order - right.metadata.order)
    .map(({ issue, metadata }) => runtimeTask(metadata, issue.status));
  return {
    revision: String(run.revision),
    state: {
      apiVersion: run.api_version,
      status: run.status,
      endReason: run.end_reason,
      phases,
      tasks,
      activeTurn: structuredClone(run.active_turn),
      dispatches: structuredClone([...run.dispatches]),
    },
  };
}

/**
 * A converged node needs no `bd` writes: the durable final metadata write is the last step of
 * {@link BeadsRuntimeStateStore.transitionIssue}, so metadata equality with no pending operation
 * also proves the coarse status and state label of the previous transition were written.
 */
function isConverged(
  issue: BeadsIssue,
  desired: {
    readonly desiredState: string;
    readonly existingGateId: string | null;
    readonly final: Record<string, unknown>;
    readonly supportsHumanGate: boolean;
    readonly supportsTaskClaim: boolean;
  },
): boolean {
  if (requireSenawa(issue).pending_operation !== undefined) return false;
  const awaitingApproval = desired.desiredState === "awaiting_approval";
  if (desired.existingGateId !== null && !awaitingApproval) return false;
  if (desired.supportsHumanGate && awaitingApproval && desired.existingGateId === null)
    return false;
  const desiredStatus = coarseStatus(desired.desiredState);
  if (issue.status !== desiredStatus) return false;
  if (desired.supportsTaskClaim && desiredStatus === "open" && (issue.assignee ?? "") !== "") {
    return false;
  }
  return payloadDigest(issue.metadata ?? {}) === payloadDigest(desired.final);
}

function runMetadata(
  runId: string,
  state: StoredRuntimeState,
  operationId: string,
  revision: number,
  receipts: Readonly<Record<string, OperationReceipt>>,
): RunMetadata {
  return {
    kind: "run",
    run_id: runId,
    api_version: state.apiVersion,
    status: state.status,
    end_reason: state.endReason,
    revision,
    last_operation_id: operationId,
    operation_receipts: receipts,
    active_turn: state.activeTurn,
    dispatches: state.dispatches,
  };
}

function phaseMetadata(
  runId: string,
  phase: RuntimePhase,
  order: number,
  executorKind: "agent" | "task-frontier" | "sensor-only" | "human" | "foreach",
  gateId: string | null,
): PhaseMetadata {
  return {
    kind: "phase",
    run_id: runId,
    node_id: phase.id,
    order,
    executor_kind: executorKind,
    status: phase.status,
    iteration: phase.iteration,
    artifact_version: phase.artifactVersion,
    session_id: phase.sessionId,
    rejection_reason: phase.rejectionReason,
    gate_id: phase.status === "awaiting_approval" ? gateId : null,
  };
}

function taskMetadata(
  runId: string,
  task: RuntimeTask,
  parentPhaseId: string,
  order: number,
): TaskMetadata {
  const {
    status,
    attempt,
    dispatchFailures,
    sessionId,
    steering,
    reworkFindings,
    reworkFeedback,
    ...definition
  } = task;
  return {
    kind: "task",
    run_id: runId,
    node_id: task.key,
    parent_phase_id: parentPhaseId,
    order,
    definition,
    status,
    attempt,
    dispatch_failures: dispatchFailures,
    session_id: sessionId,
    steering,
    ...(reworkFindings === undefined ? {} : { rework_findings: reworkFindings }),
    ...(reworkFeedback === undefined ? {} : { rework_feedback: reworkFeedback }),
  };
}

function runtimePhase(metadata: PhaseMetadata): RuntimePhase {
  return {
    id: metadata.node_id,
    status: metadata.status,
    iteration: metadata.iteration,
    artifactVersion: metadata.artifact_version,
    sessionId: metadata.session_id,
    rejectionReason: metadata.rejection_reason,
  };
}

function runtimeTask(metadata: TaskMetadata, issueStatus: string): RuntimeTask {
  return {
    ...structuredClone(metadata.definition),
    status:
      issueStatus === "closed"
        ? "closed"
        : issueStatus === "in_progress"
          ? "in_progress"
          : metadata.status,
    attempt: metadata.attempt,
    dispatchFailures: metadata.dispatch_failures,
    sessionId: metadata.session_id,
    steering: [...metadata.steering],
    ...(metadata.rework_findings === undefined
      ? {}
      : { reworkFindings: [...metadata.rework_findings] }),
    ...(metadata.rework_feedback === undefined
      ? {}
      : { reworkFeedback: structuredClone(metadata.rework_feedback) }),
  };
}

function pending(
  operationId: string,
  expectedRevision: number,
  desiredRevision: number,
  desiredState: string,
  digest: string,
): PendingOperation {
  return {
    id: operationId,
    expected_revision: expectedRevision,
    desired_revision: desiredRevision,
    desired_state: desiredState,
    payload_digest: digest,
  };
}

function indexMetadata(
  runId: string,
  kind: "run" | "phase" | "task",
  senawa: RunMetadata | PhaseMetadata | TaskMetadata,
): Record<string, unknown> {
  return { senawa_run_id: runId, senawa_kind: kind, senawa };
}

function findRunIssue(issues: readonly BeadsIssue[], runId: string): BeadsIssue | undefined {
  return issues.find((issue) => nodeKind(issue, runId) === "run");
}

function findNodeIssue(
  issues: readonly BeadsIssue[],
  runId: string,
  kind: "phase" | "task",
  nodeId: string,
): BeadsIssue | undefined {
  return issues.find(
    (issue) => nodeKind(issue, runId) === kind && requireSenawa(issue).node_id === nodeId,
  );
}

function nodeKind(issue: BeadsIssue, runId: string): string | undefined {
  const metadata = issue.metadata;
  if (metadata === undefined) return undefined;
  const { senawa_run_id: metadataRunId, senawa_kind: metadataKind } = metadata;
  return metadataRunId === runId && typeof metadataKind === "string" ? metadataKind : undefined;
}

function requireRunMetadata(issue: BeadsIssue, runId?: string): RunMetadata {
  const metadata = requireSenawa(issue) as unknown as RunMetadata;
  if (metadata.kind !== "run" || (runId !== undefined && metadata.run_id !== runId)) {
    throw new Error(`Beads issue ${issue.id} has invalid Senawa run metadata`);
  }
  return metadata;
}

function requirePhaseMetadata(issue: BeadsIssue, runId: string): PhaseMetadata {
  const metadata = requireSenawa(issue) as unknown as PhaseMetadata;
  if (
    metadata.kind !== "phase" ||
    metadata.run_id !== runId ||
    typeof metadata.node_id !== "string"
  ) {
    throw new Error(`Beads issue ${issue.id} has invalid Senawa phase metadata`);
  }
  return metadata;
}

function requireTaskMetadata(issue: BeadsIssue, runId: string): TaskMetadata {
  const metadata = requireSenawa(issue) as unknown as TaskMetadata;
  if (
    metadata.kind !== "task" ||
    metadata.run_id !== runId ||
    typeof metadata.node_id !== "string"
  ) {
    throw new Error(`Beads issue ${issue.id} has invalid Senawa task metadata`);
  }
  return metadata;
}

function requireSenawa(issue: BeadsIssue): SenawaIssueMetadata {
  const { senawa } = issue.metadata ?? {};
  return requireRecord(senawa, `Senawa metadata for issue ${issue.id}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requirePhase(state: StoredRuntimeState, phaseId: string): RuntimePhase {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Missing runtime phase ${phaseId}`);
  return phase;
}

function requireMapValue<T>(map: ReadonlyMap<string, T>, key: string): T {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing Beads graph node ${key}`);
  return value;
}

function coarseStatus(state: string): "open" | "in_progress" | "deferred" | "closed" {
  if (state === "accepted" || state === "closed" || state === "finished") return "closed";
  if (state === "running" || state === "in_progress") return "in_progress";
  if (state === "ended") return "deferred";
  return "open";
}

function isTerminal(status: StoredRuntimeState["status"]): boolean {
  return status === "finished" || status === "ended";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function payloadDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortValue(value)))
    .digest("hex");
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortValue(child)]),
  );
}

function metadataJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function operationConflict(operationId: string): Error {
  return new Error(`Beads operation ${operationId} was already used with different content`);
}
