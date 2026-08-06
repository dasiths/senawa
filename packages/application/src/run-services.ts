import {
  type BrowserRunCommand,
  type CommandActor,
  type GateEvaluation,
  type JournalEventName,
  type JsonObject,
  JsonObjectSchema,
  type JsonValue,
  type PlanArtifact,
  PlanArtifactSchema,
  type RunSnapshot,
  type RuntimeArtifact,
  type RuntimeBackend,
  type RuntimeDispatch,
  type RuntimeLease,
  type RuntimePhase,
  type RuntimeState,
  type RuntimeTask,
  type SensorReading,
  type WorkerProfile,
  type WorkRequest,
} from "@senawa/domain";
import type { RunDriver } from "./driver.js";
import type {
  ArtifactValidationPort,
  ClockPort,
  GateEvaluationPort,
  IdentifierPort,
  ReportingPort,
  RunPersistencePort,
  SchedulerPort,
  WorkerEventRecord,
  WorkerExecutionPort,
  WorkerResult,
  WorkerTurn,
  WorkflowCatalogPort,
} from "./ports.js";
import { RuntimeRevisionConflictError } from "./ports.js";
import {
  type OpenWorkerQuestion,
  projectOpenWorkerQuestions,
  projectRunStatus,
  type RunStatusProjection,
} from "./projections.js";
import { createPhasePrompt, createTaskPrompt } from "./prompts.js";

const ansiEscapePattern = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const questionAnswerPollIntervalMs = 250;
const questionAnswerTimeoutMs = 540_000;

export interface ActiveQuestionTurn {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface WorkerQuestionContext extends ActiveQuestionTurn {
  readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
}

export interface AnswerQuestionOptions {
  readonly submissionId?: string;
}

export class QuestionUnavailableError extends Error {
  constructor(readonly reason: "unknown" | "answered" | "stale") {
    super(`Question is unavailable: ${reason}`);
    this.name = "QuestionUnavailableError";
  }
}

export class QuestionSubmissionConflictError extends Error {
  constructor() {
    super("Question answer submission conflicts with an existing submission");
    this.name = "QuestionSubmissionConflictError";
  }
}

export interface WaitForQuestionAnswerOptions {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StartRunInput {
  readonly actor: CommandActor;
  readonly request: WorkRequest;
  readonly snapshot: RunSnapshot;
  readonly runId?: string;
}

export interface EndRunOptions {
  readonly force?: boolean;
  readonly graceMs?: number;
}

export interface TransitionResult {
  readonly runId: string;
  readonly kind:
    | "started"
    | "phase-submitted"
    | "awaiting-approval"
    | "task-closed"
    | "task-rework"
    | "task-escalated"
    | "phase-accepted"
    | "finished"
    | "ended"
    | "idle";
  readonly phaseId?: string;
  readonly taskId?: string;
}

type ReconciledWorkerExecution =
  | { readonly kind: "result"; readonly result: WorkerResult }
  | { readonly kind: "deferred"; readonly transition: TransitionResult };

export type { RunStatusProjection } from "./projections.js";

export class RunCommandService implements RunDriver {
  private readonly store: RuntimeCoordinator;

  constructor(
    store: RunPersistencePort,
    private readonly workerHost: WorkerExecutionPort,
    private readonly gateEvaluator: GateEvaluationPort,
    private readonly artifactValidator: ArtifactValidationPort,
    private readonly clock: ClockPort,
    private readonly identifiers: IdentifierPort,
    private readonly scheduler: SchedulerPort,
    private readonly driverLeaseTtlMs = 30_000,
    private readonly backend: RuntimeBackend = "file",
  ) {
    this.store = new RuntimeCoordinator(store, identifiers);
  }

  async start(input: StartRunInput): Promise<TransitionResult> {
    const runId = input.runId ?? `run-${this.identifiers.createId()}`;
    const snapshot = input.snapshot;
    if (snapshot.runId !== runId) {
      throw new Error(`Run snapshot ${snapshot.runId} does not match requested run ${runId}`);
    }
    const state: RuntimeState = {
      apiVersion: "senawa.dev/runtime/v1",
      identity: {
        runId,
        backend: this.backend,
        workflow: snapshot.workflow.metadata.name,
        request: input.request,
        createdAt: snapshot.createdAt,
        fingerprint: snapshot.fingerprint,
      },
      snapshot,
      status: "running",
      endReason: null,
      phases: snapshot.workflow.spec.phases.map((phase) => ({
        id: phase.id,
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      })),
      tasks: [],
      artifacts: [],
      journal: [],
      outputs: {},
      activeTurn: null,
      dispatches: [],
      leases: { driver: null, web: null },
      leaseFences: { driver: 0, web: 0 },
    };
    emit(state, "work.started", input.actor, this.now(), {
      workflow: state.identity.workflow,
      goal: input.request.goal,
    });
    emit(state, "workflow.instantiated", input.actor, this.now(), {
      phases: state.phases.slice(0, 12).map((phase) => phase.id),
    });
    const operationId = this.identifiers.createId();
    await this.store.publishSnapshot(snapshot, operationId);
    await this.store.createRun(state, operationId);
    return { runId, kind: "started" };
  }

  async executeBrowserCommand(
    runId: string,
    command: BrowserRunCommand,
  ): Promise<TransitionResult> {
    const actor: CommandActor = { channel: "web" };
    switch (command.command) {
      case "approve": {
        const state = await this.store.readRun(runId);
        if (!hasCommandEvent(state, command.commandId, "phase.approved")) {
          await this.approve(runId, command.phaseId, actor, command.note, command.commandId);
        }
        return this.resume(runId, actor, command.commandId);
      }
      case "reject": {
        const state = await this.store.readRun(runId);
        if (!hasCommandEvent(state, command.commandId, "phase.rejected")) {
          await this.reject(runId, command.phaseId, command.reason, actor, command.commandId);
        }
        return this.resume(runId, actor, command.commandId);
      }
      case "steer": {
        const state = await this.store.readRun(runId);
        if (hasCommandEvent(state, command.commandId, "steering.recorded")) {
          return { runId, kind: "idle", taskId: command.taskId };
        }
        return this.steer(runId, command.taskId, command.instruction, actor, command.commandId);
      }
      case "resume":
        return this.resume(runId, actor, command.commandId);
      case "end": {
        const state = await this.store.readRun(runId);
        if (hasCommandEvent(state, command.commandId, "work.ended")) {
          return { runId, kind: "ended" };
        }
        return this.end(runId, command.reason, actor, {}, command.commandId);
      }
    }
  }

  async approve(
    runId: string,
    phaseId: string,
    actor: CommandActor,
    note?: string,
    commandId?: string,
  ): Promise<TransitionResult> {
    await this.store.updateRun(runId, (state) => {
      if (commandId !== undefined && hasCommandEvent(state, commandId, "phase.approved")) return;
      assertMutable(state);
      const phase = requirePhase(state, phaseId);
      if (phase.status !== "awaiting_approval") {
        throw new Error(`Phase ${phaseId} is not awaiting approval`);
      }
      phase.status = "accepted";
      emit(state, "phase.approved", actor, this.now(), {
        phaseId,
        iteration: phase.iteration,
        ...(note === undefined ? {} : { note }),
        ...(commandId === undefined ? {} : { commandId }),
      });
      if (workflowPhase(state, phaseId).actions?.some((action) => action.kind === "import-plan")) {
        importPlan(state, phase, actor, this.now());
      }
      state.status = "running";
    });
    return { runId, kind: "phase-accepted", phaseId };
  }

  async reject(
    runId: string,
    phaseId: string,
    reason: string,
    actor: CommandActor,
    commandId?: string,
  ): Promise<TransitionResult> {
    await this.store.updateRun(runId, (state) => {
      if (commandId !== undefined && hasCommandEvent(state, commandId, "phase.rejected")) return;
      assertMutable(state);
      const phase = requirePhase(state, phaseId);
      const definition = workflowPhase(state, phaseId);
      if (phase.status !== "awaiting_approval") {
        throw new Error(`Phase ${phaseId} is not awaiting approval`);
      }
      if (phase.iteration >= definition.iteration.max) {
        throw new Error(`Phase ${phaseId} exhausted its iteration budget`);
      }
      phase.status = "pending";
      phase.rejectionReason = reason;
      state.status = "running";
      emit(state, "phase.rejected", actor, this.now(), {
        phaseId,
        iteration: phase.iteration,
        reason,
        ...(commandId === undefined ? {} : { commandId }),
      });
    });
    return { runId, kind: "idle", phaseId };
  }

  async steer(
    runId: string,
    taskId: string,
    instruction: string,
    actor: CommandActor,
    commandId?: string,
  ): Promise<TransitionResult> {
    await this.store.updateRun(runId, (state) => {
      if (commandId !== undefined && hasCommandEvent(state, commandId, "steering.recorded")) return;
      assertMutable(state);
      const task = state.tasks.find((candidate) => candidate.key === taskId);
      if (task === undefined || task.status === "closed" || task.status === "ended") {
        throw new Error(`Task ${taskId} cannot be steered`);
      }
      task.steering.push(instruction);
      if (task.status === "escalated") {
        task.status = task.attempt === 0 ? "pending" : "rework";
        task.dispatchFailures = 0;
      }
      emit(state, "steering.recorded", actor, this.now(), {
        taskId,
        instruction,
        ...(commandId === undefined ? {} : { commandId }),
      });
    });
    return { runId, kind: "idle", taskId };
  }

  async resume(runId: string, actor: CommandActor, commandId?: string): Promise<TransitionResult> {
    const current = await this.store.readRun(runId);
    if (commandId === undefined || !hasCommandEvent(current, commandId, "work.resumed")) {
      await this.store.updateRun(runId, (state) => {
        if (commandId !== undefined && hasCommandEvent(state, commandId, "work.resumed")) return;
        assertMutable(state);
        if (state.status === "awaiting_approval") {
          throw new Error("The run requires approval or rejection before it can resume");
        }
        state.status = "running";
        emit(state, "work.resumed", actor, this.now(), {
          ...(commandId === undefined ? {} : { commandId }),
        });
      });
    }
    return this.drive(runId, actor);
  }

  async pause(runId: string, actor: CommandActor): Promise<TransitionResult> {
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      if (state.activeTurn !== null) {
        throw new Error("Cannot pause while a worker turn is active");
      }
      if (state.status === "paused") return;
      state.status = "paused";
      emit(state, "work.paused", actor, this.now(), {});
    });
    return { runId, kind: "idle" };
  }

  async checkGate(
    runId: string,
    gateId: string,
    owner: { readonly kind: "phase" | "task"; readonly id: string },
    actor: CommandActor,
  ): Promise<GateEvaluation> {
    const state = await this.store.readRun(runId);
    assertMutable(state);
    const phase = owner.kind === "phase" ? requirePhase(state, owner.id) : undefined;
    const attempt = phase?.iteration ?? requireTask(state, owner.id).attempt;
    const artifact =
      phase?.artifactVersion !== null && phase?.artifactVersion !== undefined
        ? state.artifacts.find(
            (candidate) =>
              candidate.phaseId === owner.id && candidate.version === phase.artifactVersion,
          )?.content
        : undefined;
    const evaluation = await this.gateEvaluator.evaluate({
      runId,
      owner,
      attempt,
      gateId,
      policy: state.snapshot.policy,
      ...(artifact === undefined ? {} : { artifact }),
      onOutput: this.sensorOutput(runId, owner),
    });
    await this.store.updateRun(runId, (draft) => {
      assertMutable(draft);
      appendGateEvaluation(draft, evaluation, { owner, attempt }, this.now(), actor);
    });
    return evaluation;
  }

  async ask(
    runId: string,
    question: string,
    actor: CommandActor,
    workerContext?: WorkerQuestionContext,
  ) {
    const questionId = `question-${this.identifiers.createId()}`;
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      if (actor.channel === "worker") {
        if (workerContext === undefined || actor.sessionId !== workerContext.sessionId) {
          throw new QuestionUnavailableError("stale");
        }
        const active = state.activeTurn;
        if (
          state.status !== "running" ||
          active?.sessionId !== workerContext.sessionId ||
          active.turnId !== workerContext.turnId ||
          active.ownerKind !== workerContext.owner.kind ||
          active.ownerId !== workerContext.owner.id
        ) {
          throw new QuestionUnavailableError("stale");
        }
        emit(state, "question.asked", actor, this.now(), {
          questionId,
          question,
          sessionId: workerContext.sessionId,
          turnId: workerContext.turnId,
          ownerKind: workerContext.owner.kind,
          ownerId: workerContext.owner.id,
        });
        return;
      }
      emit(state, "question.asked", actor, this.now(), { questionId, question });
    });
    return { runId, questionId };
  }

  async answer(
    runId: string,
    questionId: string,
    answer: string,
    actor: CommandActor,
    options: AnswerQuestionOptions = {},
  ) {
    await this.store.updateRun(runId, (state) => {
      const replay = state.journal.find((event) => {
        return (
          event.event === "question.answered" &&
          options.submissionId !== undefined &&
          Reflect.get(event.data, "submissionId") === options.submissionId
        );
      });
      if (replay !== undefined) {
        if (
          Reflect.get(replay.data, "questionId") === questionId &&
          Reflect.get(replay.data, "answer") === answer
        ) {
          return;
        }
        throw new QuestionSubmissionConflictError();
      }
      assertMutable(state);
      const asked = state.journal.find((event) => {
        return (
          event.event === "question.asked" && Reflect.get(event.data, "questionId") === questionId
        );
      });
      if (asked === undefined) throw new QuestionUnavailableError("unknown");
      const answered = state.journal.some(
        (event) =>
          event.event === "question.answered" &&
          Reflect.get(event.data, "questionId") === questionId,
      );
      if (answered) throw new QuestionUnavailableError("answered");
      if (asked.actor.channel === "worker") {
        const active = state.activeTurn;
        if (
          state.status !== "running" ||
          active?.sessionId !== Reflect.get(asked.data, "sessionId") ||
          active.turnId !== Reflect.get(asked.data, "turnId") ||
          active.ownerKind !== Reflect.get(asked.data, "ownerKind") ||
          active.ownerId !== Reflect.get(asked.data, "ownerId")
        ) {
          throw new QuestionUnavailableError("stale");
        }
      }
      emit(state, "question.answered", actor, this.now(), {
        questionId,
        answer,
        ...(options.submissionId === undefined ? {} : { submissionId: options.submissionId }),
      });
    });
    return { runId, questionId };
  }

  async discover(runId: string, title: string, actor: CommandActor) {
    const discoveryId = `discovery-${this.identifiers.createId()}`;
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      emit(state, "discovery.recorded", actor, this.now(), { discoveryId, title });
    });
    return { runId, discoveryId };
  }

  async note(runId: string, note: string, actor: CommandActor) {
    const noteId = `note-${this.identifiers.createId()}`;
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      emit(state, "note.recorded", actor, this.now(), { noteId, note });
    });
    return { runId, noteId };
  }

  async revisePlan(runId: string, input: PlanArtifact, actor: CommandActor) {
    const plan = PlanArtifactSchema.parse(input);
    let added: string[] = [];
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      const known = new Set(state.tasks.map((task) => task.key));
      const additions = plan.tasks.filter((task) => !known.has(task.key));
      const available = new Set([...known, ...additions.map((task) => task.key)]);
      for (const task of additions) {
        if (state.snapshot.workerProfiles[task.role] === undefined) {
          throw new Error(`Plan task ${task.key} references missing worker profile ${task.role}`);
        }
        for (const dependency of task.dependsOn) {
          if (!available.has(dependency)) {
            throw new Error(`Plan task ${task.key} references unknown dependency ${dependency}`);
          }
        }
        state.tasks.push({
          ...task,
          status: "pending",
          attempt: 0,
          dispatchFailures: 0,
          sessionId: null,
          steering: [],
          reworkFindings: [],
        });
      }
      added = additions.map((task) => task.key);
      emit(state, "plan.revised", actor, this.now(), { summary: plan.summary, tasks: added });
    });
    return { runId, added };
  }

  async end(
    runId: string,
    reason: string,
    actor: CommandActor,
    options: EndRunOptions = {},
    commandId?: string,
  ): Promise<TransitionResult> {
    const initial = await this.store.readRun(runId);
    assertMutable(initial);
    const activeTurn = initial.activeTurn === null ? null : workerTurnFromActive(initial);
    if (activeTurn !== null && options.force !== true) {
      throw new Error("Run has an active worker turn; use forced end to cancel and reconcile it");
    }

    let observation: Awaited<ReturnType<RunCommandService["inspectWorkerTurn"]>> | null = null;
    if (activeTurn !== null) {
      if (this.workerHost.cancel === undefined) {
        throw new Error("Worker host does not support cancellation; forced end is unavailable");
      }
      await this.workerHost.cancel(activeTurn, reason);
      const deadline = Date.now() + Math.max(0, options.graceMs ?? 1_000);
      observation = await this.inspectWorkerTurn(activeTurn);
      while (observation.state === "active" && Date.now() < deadline) {
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        observation = await this.inspectWorkerTurn(activeTurn);
      }
    }

    const takeover =
      options.force === true
        ? await this.store.acquireLease(
            runId,
            "driver",
            `force-end-${this.identifiers.createId()}`,
            5_000,
          )
        : null;
    try {
      await this.store.updateRun(runId, (state) => {
        if (commandId !== undefined && hasCommandEvent(state, commandId, "work.ended")) return;
        assertMutable(state);
        if (activeTurn !== null && state.activeTurn?.dispatchId === activeTurn.dispatchId) {
          const dispatch = requireDispatch(state, activeTurn.dispatchId);
          dispatch.updatedAt = this.now().toISOString();
          if (observation?.state === "completed") {
            appendWorkerResult(state, activeTurn, observation.result, this.now());
            completeDispatch(state, activeTurn.dispatchId, this.now());
          } else if (observation?.state === "missing") {
            dispatch.status = "failed";
            dispatch.detail = "Worker session or turn was missing during forced end";
            emit(state, "dispatch.failed", { channel: "driver" }, this.now(), {
              dispatchId: activeTurn.dispatchId,
              operationId: activeTurn.operationId,
              ownerKind: activeTurn.owner.kind,
              ownerId: activeTurn.owner.id,
              reason: dispatch.detail,
            });
          } else {
            dispatch.status = "cancelled";
            dispatch.detail =
              observation?.state === "cancelled"
                ? (observation.detail ?? reason)
                : `Forced end after cancellation grace: ${observation?.state ?? "unreported"}`;
            emit(state, "worker.aborted", { channel: "driver" }, this.now(), {
              dispatchId: activeTurn.dispatchId,
              operationId: activeTurn.operationId,
              ownerKind: activeTurn.owner.kind,
              ownerId: activeTurn.owner.id,
              reason: dispatch.detail,
            });
          }
        }
        for (const phase of state.phases) {
          if (phase.status !== "accepted") phase.status = "ended";
        }
        for (const task of state.tasks) {
          if (task.status !== "closed") task.status = "ended";
        }
        state.activeTurn = null;
        state.status = "ended";
        state.endReason = reason;
        emit(state, "work.ended", actor, this.now(), {
          reason,
          forced: options.force === true,
          ...(commandId === undefined ? {} : { commandId }),
        });
      });
    } finally {
      if (takeover !== null) await this.store.releaseLease(runId, "driver", takeover);
    }
    return { runId, kind: "ended" };
  }

  async finish(runId: string, actor: CommandActor): Promise<TransitionResult> {
    await this.store.updateRun(runId, (state) => {
      assertMutable(state);
      const targetId = completionPhaseId(state);
      if (requirePhase(state, targetId).status !== "accepted") {
        throw new Error(`Completion phase ${targetId} has not been accepted`);
      }
      state.status = "finished";
      emit(state, "work.finished", actor, this.now(), { workflow: state.identity.workflow });
    });
    return { runId, kind: "finished" };
  }

  async drive(runId: string, actor: CommandActor, maxTransitions = 100): Promise<TransitionResult> {
    let result: TransitionResult = { runId, kind: "idle" };
    for (let index = 0; index < maxTransitions; index += 1) {
      const state = await this.store.readRun(runId);
      if (state.status === "awaiting_approval" || state.status === "paused") return result;
      if (state.status === "finished") return { runId, kind: "finished" };
      if (state.status === "ended") return { runId, kind: "ended" };
      result = await this.advance(runId, actor);
      if (
        result.kind === "awaiting-approval" ||
        result.kind === "task-escalated" ||
        result.kind === "finished" ||
        result.kind === "idle"
      ) {
        return result;
      }
    }
    throw new Error(`Driver exceeded ${maxTransitions} transitions`);
  }

  async advance(runId: string, actor: CommandActor): Promise<TransitionResult> {
    const leaseOwner = `driver-${this.identifiers.createId()}`;
    const lease = await this.store.acquireLease(runId, "driver", leaseOwner, this.driverLeaseTtlMs);
    const heartbeat = new LeaseHeartbeat(
      this.store,
      runId,
      "driver",
      lease,
      this.driverLeaseTtlMs,
      this.scheduler,
    );
    heartbeat.start();
    try {
      const state = await this.store.readRun(runId);
      assertMutable(state);
      if (state.status === "awaiting_approval") {
        const phase = state.phases.find((candidate) => candidate.status === "awaiting_approval");
        return {
          runId,
          kind: "awaiting-approval",
          ...(phase === undefined ? {} : { phaseId: phase.id }),
        };
      }

      const phase = nextPhase(state);
      if (phase === undefined) return this.finish(runId, actor);
      const definition = workflowPhase(state, phase.id);
      if (definition.executor.kind === "agent") {
        return await this.advanceAgentPhase(state, phase, actor, heartbeat);
      }
      if (definition.executor.kind === "task-frontier") {
        return await this.advanceTaskFrontier(state, phase, actor, heartbeat);
      }
      throw new Error(
        `Executor ${definition.executor.kind} is not supported by the standard driver`,
      );
    } finally {
      await heartbeat.stop();
      const latest = await this.store.readRun(runId);
      if (latest.status !== "finished" && latest.status !== "ended") {
        await this.store.releaseLease(runId, "driver", heartbeat.currentLease).catch((error) => {
          if (heartbeat.failure === null) throw error;
        });
      }
    }
  }

  private async advanceAgentPhase(
    state: RuntimeState,
    phase: RuntimePhase,
    actor: CommandActor,
    heartbeat: LeaseHeartbeat,
  ): Promise<TransitionResult> {
    const definition = workflowPhase(state, phase.id);
    if (definition.executor.kind !== "agent") throw new Error("Expected an agent phase");
    const role = definition.executor.role;
    const active = state.activeTurn;
    const iteration =
      active?.ownerKind === "phase" && active.ownerId === phase.id
        ? active.attempt
        : phase.iteration + 1;
    if (iteration > definition.iteration.max) {
      await this.store.updateRun(state.identity.runId, (draft) => {
        draft.status = "paused";
      });
      return { runId: state.identity.runId, kind: "idle", phaseId: phase.id };
    }
    const operation =
      active?.ownerKind === "phase"
        ? active.operation
        : phase.sessionId === null
          ? "create"
          : "resume";
    const sessionId =
      active?.ownerKind === "phase"
        ? active.sessionId
        : (phase.sessionId ?? this.identifiers.createId());
    const turnId = active?.ownerKind === "phase" ? active.turnId : this.identifiers.createId();
    const operationId =
      active?.ownerKind === "phase" ? active.operationId : this.identifiers.createId();
    const dispatchId =
      active?.ownerKind === "phase" ? active.dispatchId : this.identifiers.createId();
    if (active?.ownerKind !== "phase") {
      await this.store.updateRun(state.identity.runId, (draft) => {
        const current = requirePhase(draft, phase.id);
        current.status = "running";
        current.iteration = iteration;
        current.sessionId = sessionId;
        draft.activeTurn = {
          ownerKind: "phase",
          ownerId: phase.id,
          sessionId,
          attempt: iteration,
          turnId,
          dispatchId,
          operationId,
          operation,
        };
        draft.dispatches.push(
          createDispatch(
            draft,
            {
              ownerKind: "phase",
              ownerId: phase.id,
              sessionId,
              workAttempt: iteration,
              turnId,
              dispatchId,
              operationId,
              operation,
              dispatchFailure: 0,
            },
            this.now(),
          ),
        );
        emit(draft, "phase.started", actor, this.now(), { phaseId: phase.id, iteration });
      });
    }

    const turn: WorkerTurn = {
      runId: state.identity.runId,
      owner: { kind: "phase", id: phase.id },
      operation,
      turnId,
      dispatchId,
      operationId,
      ...traceContext(state.identity.runId, dispatchId),
      role,
      ...resolveTurnProfile(state, role),
      attempt: iteration,
      sessionId,
      goal: state.identity.request.goal,
      rejectionReason: phase.rejectionReason,
      steering: [],
      prompt: createPhasePrompt(state, phase, iteration),
      authorization: { taskPaths: [], frozenPaths: state.snapshot.policy.frozen },
    };
    const phaseExecution =
      active?.ownerKind === "phase"
        ? await this.reconcilePhaseDispatch(turn)
        : { kind: "result" as const, result: await this.executeWorkerSafely(turn) };
    if (phaseExecution.kind === "deferred") return phaseExecution.transition;
    const result = phaseExecution.result;
    assertWorkerSession(turn, result);
    if (result.artifact !== undefined) {
      try {
        await this.artifactValidator.validatePhaseArtifact({
          snapshot: state.snapshot,
          phaseId: phase.id,
          schemaReference: definition.executor.output.schema,
          artifact: result.artifact,
        });
      } catch (error) {
        await this.store.updateRun(state.identity.runId, (draft) => {
          appendWorkerResult(draft, turn, result, this.now());
          const current = requirePhase(draft, phase.id);
          current.status = "pending";
          current.sessionId = result.sessionId;
          draft.activeTurn = null;
          completeDispatch(draft, turn.dispatchId, this.now());
          draft.status = "paused";
          appendOutput(
            draft,
            turn.owner.kind,
            turn.owner.id,
            "stderr",
            errorMessage(error),
            this.now(),
          );
        });
        throw error;
      }
    }
    const gate = await this.gateEvaluator.evaluate({
      runId: state.identity.runId,
      owner: turn.owner,
      attempt: iteration,
      gateId: definition.exit?.gate ?? "none",
      policy: state.snapshot.policy,
      ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
      onOutput: this.sensorOutput(state.identity.runId, turn.owner),
    });
    await heartbeat.assertActive();
    let transition: TransitionResult = {
      runId: state.identity.runId,
      kind: "phase-submitted",
      phaseId: phase.id,
    };
    await this.store.updateRun(state.identity.runId, (draft) => {
      appendWorkerResult(draft, turn, result, this.now());
      if (draft.status === "ended") return;
      const current = requirePhase(draft, phase.id);
      current.sessionId = result.sessionId;
      draft.activeTurn = null;
      completeDispatch(draft, turn.dispatchId, this.now());
      appendGateEvaluation(draft, gate, turn, this.now());
      if (!gate.accepted || result.artifact === undefined) {
        current.status = "pending";
        draft.status = "paused";
        return;
      }
      const artifact = appendArtifact(draft, current, result.artifact, this.now());
      emit(draft, "phase.submitted", { channel: "worker", role }, this.now(), {
        phaseId: phase.id,
        iteration,
        artifact: artifact.path,
      });
      if (definition.exit?.approval === "human") {
        current.status = "awaiting_approval";
        draft.status = "awaiting_approval";
        transition = { runId: draft.identity.runId, kind: "awaiting-approval", phaseId: phase.id };
      } else {
        current.status = "accepted";
        emit(draft, "phase.approved", { channel: "driver" }, this.now(), {
          phaseId: phase.id,
          iteration,
        });
      }
    });
    return transition;
  }

  private async advanceTaskFrontier(
    state: RuntimeState,
    phase: RuntimePhase,
    actor: CommandActor,
    heartbeat: LeaseHeartbeat,
  ): Promise<TransitionResult> {
    const definition = workflowPhase(state, phase.id);
    if (definition.executor.kind !== "task-frontier" || definition.loop === undefined) {
      throw new Error("Expected a bounded task frontier");
    }
    const loop = definition.loop;
    if (state.tasks.length === 0) throw new Error("The task frontier has no imported plan tasks");
    if (state.tasks.every((task) => task.status === "closed")) {
      await this.store.updateRun(state.identity.runId, (draft) => {
        const current = requirePhase(draft, phase.id);
        current.status = "accepted";
        emit(draft, "phase.approved", { channel: "driver" }, this.now(), {
          phaseId: phase.id,
          iteration: current.iteration,
        });
      });
      return { runId: state.identity.runId, kind: "phase-accepted", phaseId: phase.id };
    }

    if (state.activeTurn?.ownerKind === "task") {
      const task = requireTask(state, state.activeTurn.ownerId);
      const turn = taskTurnFromActive(state, task);
      const reconciliation = await this.reconcileTaskDispatch(
        state,
        phase,
        task,
        loop.each.dispatch.maxFailures,
        turn,
      );
      if (reconciliation.kind === "deferred") return reconciliation.transition;
      return this.completeTaskTurn(
        state,
        task,
        loop.each.gate,
        loop.each.rework.maxAttempts,
        turn,
        reconciliation.result,
        heartbeat,
      );
    }

    const task = await this.store.claimReadyTask(state.identity.runId);
    if (task === null) return { runId: state.identity.runId, kind: "idle", phaseId: phase.id };
    const attempt = task.attempt + 1;
    const operation = task.sessionId === null ? "create" : "resume";
    const sessionId = task.sessionId ?? this.identifiers.createId();
    const turnId = this.identifiers.createId();
    const operationId = this.identifiers.createId();
    const dispatchId = this.identifiers.createId();
    await this.store.updateRun(state.identity.runId, (draft) => {
      const currentPhase = requirePhase(draft, phase.id);
      if (currentPhase.status === "pending") {
        currentPhase.status = "running";
        currentPhase.iteration += 1;
        emit(draft, "phase.started", actor, this.now(), {
          phaseId: phase.id,
          iteration: currentPhase.iteration,
        });
      }
      const current = requireTask(draft, task.key);
      current.status = "in_progress";
      current.sessionId = sessionId;
      draft.activeTurn = {
        ownerKind: "task",
        ownerId: task.key,
        sessionId,
        attempt,
        turnId,
        dispatchId,
        operationId,
        operation,
      };
      draft.dispatches.push(
        createDispatch(
          draft,
          {
            ownerKind: "task",
            ownerId: task.key,
            sessionId,
            workAttempt: attempt,
            turnId,
            dispatchId,
            operationId,
            operation,
            dispatchFailure: current.dispatchFailures,
          },
          this.now(),
        ),
      );
      emit(draft, "task.dispatching", { channel: "driver" }, this.now(), {
        taskId: task.key,
        attempt,
        sessionId,
        turnId,
        dispatchId,
        operationId,
      });
    });

    const turn: WorkerTurn = {
      runId: state.identity.runId,
      owner: { kind: "task", id: task.key },
      operation,
      turnId,
      dispatchId,
      operationId,
      ...traceContext(state.identity.runId, dispatchId),
      role: task.role,
      ...resolveTurnProfile(state, task.role, task.execution),
      attempt,
      sessionId,
      goal: state.identity.request.goal,
      rejectionReason: null,
      steering: [...task.steering],
      prompt: createTaskPrompt(state, task, attempt),
      authorization: { taskPaths: task.paths, frozenPaths: state.snapshot.policy.frozen },
    };
    const result = await this.executeWorkerSafely(turn);
    return this.completeTaskTurn(
      state,
      task,
      loop.each.gate,
      loop.each.rework.maxAttempts,
      turn,
      result,
      heartbeat,
    );
  }

  private async completeTaskTurn(
    state: RuntimeState,
    task: RuntimeTask,
    gateId: string,
    maxReworkAttempts: number,
    turn: WorkerTurn,
    result: WorkerResult,
    heartbeat: LeaseHeartbeat,
  ): Promise<TransitionResult> {
    const attempt = turn.attempt;
    const gate = await this.gateEvaluator.evaluate({
      runId: state.identity.runId,
      owner: turn.owner,
      attempt,
      gateId,
      policy: state.snapshot.policy,
      onOutput: this.sensorOutput(state.identity.runId, turn.owner),
    });
    await heartbeat.assertActive();
    let transition: TransitionResult = {
      runId: state.identity.runId,
      kind: "task-closed",
      taskId: task.key,
    };
    await this.store.updateRun(state.identity.runId, (draft) => {
      appendWorkerResult(draft, turn, result, this.now());
      if (draft.status === "ended") return;
      const current = requireTask(draft, task.key);
      assertWorkerSession(turn, result);
      current.attempt = attempt;
      current.sessionId = result.sessionId;
      draft.activeTurn = null;
      completeDispatch(draft, turn.dispatchId, this.now());
      emit(draft, "task.dispatched", { channel: "driver" }, this.now(), {
        taskId: task.key,
        attempt,
        sessionId: result.sessionId,
      });
      emit(draft, "task.completion-requested", { channel: "worker", role: task.role }, this.now(), {
        taskId: task.key,
        attempt,
      });
      appendGateEvaluation(draft, gate, turn, this.now());
      if (gate.accepted) {
        current.status = "closed";
        current.reworkFindings = [];
        delete current.reworkFeedback;
        emit(draft, "task.closed", { channel: "driver" }, this.now(), {
          taskId: task.key,
          attempt,
        });
        return;
      }
      current.reworkFindings = gate.findings
        .slice(0, 20)
        .map((finding) => truncate(finding.message, 500));
      current.reworkFeedback = {
        gateId: gate.gateId,
        attempt,
        maximumAttempts: maxReworkAttempts,
        remainingAttempts: Math.max(0, maxReworkAttempts - attempt),
        failedReadings: gate.readings
          .filter((reading) => !reading.matched && !reading.advisory)
          .slice(0, 20)
          .map((reading) => ({
            sensorId: reading.sensorId,
            summary: truncate(reading.result.summary, 500),
          })),
        findings: current.reworkFindings,
        evidencePaths: gate.readings.flatMap((reading) => reading.evidencePaths).slice(0, 20),
        nextPrompt: "Address every failed reading and finding, then request completion again.",
      };
      if (attempt >= maxReworkAttempts) {
        current.status = "escalated";
        draft.status = "paused";
        emit(draft, "task.escalated", { channel: "driver" }, this.now(), {
          taskId: task.key,
          attempt,
        });
        transition = { runId: draft.identity.runId, kind: "task-escalated", taskId: task.key };
        return;
      }
      current.status = "rework";
      emit(draft, "task.rework", { channel: "driver" }, this.now(), {
        taskId: task.key,
        attempt,
        findings: gate.findings.map((finding) => finding.message),
      });
      transition = { runId: draft.identity.runId, kind: "task-rework", taskId: task.key };
    });
    return transition;
  }

  private async reconcileTaskDispatch(
    state: RuntimeState,
    phase: RuntimePhase,
    task: RuntimeTask,
    maxDispatchFailures: number,
    turn: WorkerTurn,
  ): Promise<ReconciledWorkerExecution> {
    const observation = await this.inspectWorkerTurn(turn);
    if (observation.state === "completed") {
      assertWorkerSession(turn, observation.result);
      return { kind: "result", result: observation.result };
    }
    if (observation.state === "idle" && turn.operation === "resume") {
      return { kind: "result", result: await this.executeWorkerSafely(turn) };
    }
    let transition: TransitionResult = {
      runId: state.identity.runId,
      kind: "idle",
      phaseId: phase.id,
      taskId: task.key,
    };
    await this.store.updateRun(state.identity.runId, (draft) => {
      const dispatch = requireDispatch(draft, turn.dispatchId);
      dispatch.updatedAt = this.now().toISOString();
      if (observation.state === "missing") {
        dispatch.status = "failed";
        dispatch.detail = "Worker session or turn is missing";
        const current = requireTask(draft, task.key);
        current.dispatchFailures += 1;
        current.status = current.attempt === 0 ? "pending" : "rework";
        current.sessionId = null;
        draft.activeTurn = null;
        emit(draft, "dispatch.failed", { channel: "driver" }, this.now(), {
          taskId: task.key,
          attempt: turn.attempt,
          dispatchFailures: current.dispatchFailures,
          dispatchId: turn.dispatchId,
          operationId: turn.operationId,
          turnId: turn.turnId,
        });
        if (current.dispatchFailures >= maxDispatchFailures) {
          current.status = "escalated";
          draft.status = "paused";
          emit(draft, "task.escalated", { channel: "driver" }, this.now(), {
            taskId: task.key,
            attempt: current.attempt,
            reason: "dispatch-failures-exhausted",
          });
          transition = { runId: draft.identity.runId, kind: "task-escalated", taskId: task.key };
        }
        return;
      }
      if (observation.state === "cancelled") {
        dispatch.status = "cancelled";
        dispatch.detail = observation.detail ?? "Worker turn was cancelled";
        const current = requireTask(draft, task.key);
        current.status = current.attempt === 0 ? "pending" : "rework";
        draft.activeTurn = null;
        draft.status = "paused";
        return;
      }
      dispatch.status = observation.state === "active" ? "active" : "unknown";
      dispatch.detail =
        observation.state === "unknown"
          ? observation.detail
          : observation.state === "idle"
            ? "Create operation has an idle session but no provable turn outcome"
            : "Worker turn remains active";
      draft.status = "paused";
    });
    return { kind: "deferred", transition };
  }

  private async reconcilePhaseDispatch(turn: WorkerTurn): Promise<ReconciledWorkerExecution> {
    const observation = await this.inspectWorkerTurn(turn);
    if (observation.state === "completed") {
      assertWorkerSession(turn, observation.result);
      return { kind: "result", result: observation.result };
    }
    if (observation.state === "idle" && turn.operation === "resume") {
      return { kind: "result", result: await this.executeWorkerSafely(turn) };
    }
    await this.store.updateRun(turn.runId, (draft) => {
      const dispatch = requireDispatch(draft, turn.dispatchId);
      dispatch.updatedAt = this.now().toISOString();
      if (observation.state === "missing" || observation.state === "cancelled") {
        dispatch.status = observation.state === "missing" ? "failed" : "cancelled";
        dispatch.detail =
          observation.state === "missing"
            ? "Worker session or turn is missing"
            : (observation.detail ?? "Worker turn was cancelled");
        const phase = requirePhase(draft, turn.owner.id);
        phase.status = "pending";
        phase.iteration = Math.max(0, turn.attempt - 1);
        phase.sessionId = null;
        draft.activeTurn = null;
        if (observation.state === "missing") {
          emit(draft, "dispatch.failed", { channel: "driver" }, this.now(), {
            phaseId: turn.owner.id,
            attempt: turn.attempt,
            dispatchId: turn.dispatchId,
            operationId: turn.operationId,
            turnId: turn.turnId,
          });
        }
      } else {
        dispatch.status = observation.state === "active" ? "active" : "unknown";
        dispatch.detail =
          observation.state === "unknown"
            ? observation.detail
            : observation.state === "idle"
              ? "Create operation has an idle session but no provable turn outcome"
              : "Worker turn remains active";
      }
      draft.status = "paused";
    });
    return {
      kind: "deferred",
      transition: { runId: turn.runId, kind: "idle", phaseId: turn.owner.id },
    };
  }

  private async inspectWorkerTurn(turn: WorkerTurn) {
    const observation =
      (await this.workerHost.inspect?.(turn)) ??
      ({
        state: "unknown" as const,
        detail: "Worker host does not support inspection",
      } as const);
    if (observation.state === "completed" || observation.state === "active") {
      return observation;
    }
    const records = (await this.store.readWorkerEvents(turn.runId)).filter(
      (record) =>
        record.dispatchId === turn.dispatchId &&
        record.operationId === turn.operationId &&
        record.event.sessionId === turn.sessionId &&
        record.event.turnId === turn.turnId,
    );
    const terminal = records.findLast((record) => record.event.kind === "lifecycle");
    if (terminal?.event.kind !== "lifecycle" || terminal.event.event !== "completed") {
      return observation;
    }
    const artifact = records.findLast((record) => record.event.kind === "artifact")?.event;
    return {
      state: "completed" as const,
      result: {
        sessionId: turn.sessionId,
        ...(artifact?.kind === "artifact" ? { artifact: artifact.artifact } : {}),
        output: records.flatMap((record) =>
          record.event.kind === "text" && record.event.delta !== true
            ? [{ stream: record.event.stream, text: record.event.text }]
            : [],
        ),
      },
    };
  }

  private async executeWorkerSafely(turn: WorkerTurn): Promise<WorkerResult> {
    try {
      return await this.workerHost.execute(turn, (event) =>
        this.store.appendWorkerEvent({
          runId: turn.runId,
          owner: turn.owner,
          dispatchId: turn.dispatchId,
          operationId: turn.operationId,
          role: turn.role,
          attempt: turn.attempt,
          event,
        }),
      );
    } catch (error) {
      await this.store.updateRun(turn.runId, (state) => {
        state.status = "paused";
        appendOutput(
          state,
          turn.owner.kind,
          turn.owner.id,
          "stderr",
          errorMessage(error),
          this.now(),
        );
      });
      throw error;
    }
  }

  private sensorOutput(
    runId: string,
    owner: { readonly kind: "phase" | "task"; readonly id: string },
  ) {
    const evaluationId = this.identifiers.createId();
    let sequence = 0;
    return async (input: {
      readonly sensorId: string;
      readonly stream: "stdout" | "stderr" | "system";
      readonly text: string;
    }) => {
      await this.store.appendLiveOutput({
        runId,
        owner,
        entryId: `sensor-${evaluationId}-${sequence++}`,
        stream: input.stream,
        text: input.text,
      });
    };
  }

  private now(): Date {
    return this.clock.now();
  }
}

class RuntimeCoordinator {
  constructor(
    private readonly port: RunPersistencePort,
    private readonly identifiers?: IdentifierPort,
  ) {}

  publishSnapshot(snapshot: RunSnapshot, operationId: string): Promise<void> {
    return this.port.publishSnapshot(snapshot, operationId);
  }

  createRun(state: RuntimeState, operationId: string): Promise<void> {
    return this.port.createRun(state, operationId);
  }

  async appendWorkerEvent(record: WorkerEventRecord): Promise<void> {
    await this.port.appendWorkerEvent({
      runId: record.runId,
      entryId: record.event.eventId,
      record,
    });
  }

  readWorkerEvents(runId: string): Promise<readonly WorkerEventRecord[]> {
    return this.port.readWorkerEvents(runId);
  }

  async appendLiveOutput(input: {
    readonly runId: string;
    readonly owner: { readonly kind: "phase" | "task"; readonly id: string };
    readonly entryId: string;
    readonly stream: "stdout" | "stderr" | "system";
    readonly text: string;
  }): Promise<void> {
    await this.port.appendOutput({
      runId: input.runId,
      ownerKind: input.owner.kind,
      ownerId: input.owner.id,
      entryId: input.entryId,
      record: {
        apiVersion: "senawa.dev/output/v1",
        seq: 0,
        ts: new Date().toISOString(),
        runId: input.runId,
        owner: input.owner,
        stream: input.stream,
        text: sanitizeOutput(input.text),
      },
    });
  }

  getActiveRunId(): Promise<string | null> {
    return this.port.getActiveRunId();
  }

  async readRun(runId: string): Promise<RuntimeState> {
    return (await this.port.readRun(runId)).state;
  }

  async updateRun(runId: string, update: (draft: RuntimeState) => void): Promise<RuntimeState> {
    if (this.identifiers === undefined) {
      throw new Error("Runtime mutation is not configured for this query service");
    }
    const operationId = this.identifiers.createId();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.port.readRun(runId);
      const next = structuredClone(current.state);
      update(next);
      try {
        return (
          await this.port.commitRun({
            runId,
            expectedRevision: current.revision,
            operationId,
            state: next,
          })
        ).state;
      } catch (error) {
        if (!(error instanceof RuntimeRevisionConflictError)) throw error;
      }
    }
    throw new RuntimeRevisionConflictError(runId, operationId);
  }

  async claimReadyTask(runId: string): Promise<RuntimeTask | null> {
    if (this.identifiers === undefined) {
      throw new Error("Runtime mutation is not configured for this query service");
    }
    const operationId = this.identifiers.createId();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await this.port.readRun(runId);
      try {
        return await this.port.claimReadyTask({
          runId,
          expectedRevision: current.revision,
          operationId,
        });
      } catch (error) {
        if (!(error instanceof RuntimeRevisionConflictError)) throw error;
      }
    }
    throw new RuntimeRevisionConflictError(runId, operationId);
  }

  acquireLease(
    runId: string,
    kind: "driver" | "web",
    owner: string,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    return this.port.acquireLease(runId, kind, owner, ttlMs);
  }

  renewLease(
    runId: string,
    kind: "driver" | "web",
    lease: RuntimeLease,
    ttlMs: number,
  ): Promise<RuntimeLease> {
    return this.port.renewLease(runId, kind, lease, ttlMs);
  }

  releaseLease(runId: string, kind: "driver" | "web", lease: RuntimeLease): Promise<void> {
    return this.port.releaseLease(runId, kind, lease);
  }
}

class LeaseHeartbeat {
  private cancelTimer: (() => void) | null = null;
  private pending: Promise<void> = Promise.resolve();
  private leaseFailure: unknown = null;

  constructor(
    private readonly store: RuntimeCoordinator,
    private readonly runId: string,
    private readonly kind: "driver" | "web",
    private lease: RuntimeLease,
    private readonly ttlMs: number,
    private readonly scheduler: SchedulerPort,
  ) {}

  get currentLease(): RuntimeLease {
    return this.lease;
  }

  get failure(): unknown {
    return this.leaseFailure;
  }

  start(): void {
    const intervalMs = Math.max(10, Math.floor(this.ttlMs / 3));
    this.cancelTimer = this.scheduler.scheduleEvery(intervalMs, () => this.queueRenewal());
  }

  async assertActive(): Promise<void> {
    this.queueRenewal();
    await this.pending;
    if (this.leaseFailure !== null) throw this.leaseFailure;
  }

  async stop(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.pending;
  }

  private queueRenewal(): void {
    if (this.leaseFailure !== null) return;
    this.pending = this.pending
      .then(async () => {
        this.lease = await this.store.renewLease(this.runId, this.kind, this.lease, this.ttlMs);
      })
      .catch((error: unknown) => {
        this.leaseFailure = error;
      });
  }
}

export class RunQueryService {
  private readonly store: RuntimeCoordinator;
  private readonly persistence: RunPersistencePort;

  constructor(
    store: RunPersistencePort,
    private readonly catalog?: WorkflowCatalogPort,
    private readonly reports?: ReportingPort,
    private readonly clock: ClockPort = { now: () => new Date() },
    private readonly scheduler: SchedulerPort = {
      scheduleEvery(intervalMs, task) {
        const timer = setInterval(task, intervalMs);
        timer.unref();
        return () => clearInterval(timer);
      },
    },
  ) {
    this.persistence = store;
    this.store = new RuntimeCoordinator(store);
  }

  activeRunId(): Promise<string | null> {
    return this.store.getActiveRunId();
  }

  async status(runId?: string): Promise<RunStatusProjection | null> {
    const resolved = runId ?? (await this.store.getActiveRunId());
    if (resolved === null) return null;
    return projectRunStatus(await this.store.readRun(resolved));
  }

  async openWorkerQuestions(runId: string): Promise<readonly OpenWorkerQuestion[]> {
    return projectOpenWorkerQuestions(await this.store.readRun(runId));
  }

  waitForQuestionAnswer(
    runId: string,
    questionId: string,
    expectedTurn: ActiveQuestionTurn,
    options: WaitForQuestionAnswerOptions = {},
  ): Promise<string> {
    const pollIntervalMs = positiveDuration(
      options.pollIntervalMs ?? questionAnswerPollIntervalMs,
      "Question answer poll interval",
    );
    const timeoutMs = positiveDuration(
      options.timeoutMs ?? questionAnswerTimeoutMs,
      "Question answer timeout",
    );
    const deadline = this.clock.now().getTime() + timeoutMs;
    const check = () => this.readQuestionAnswer(runId, questionId, expectedTurn);
    if (options.signal?.aborted === true) return Promise.reject(questionWaitAborted(questionId));

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let checking = false;
      let cancelTimer: () => void = () => undefined;
      const finish = (outcome: { readonly answer: string } | { readonly error: unknown }) => {
        if (settled) return;
        settled = true;
        cancelTimer();
        options.signal?.removeEventListener("abort", onAbort);
        if ("answer" in outcome) resolve(outcome.answer);
        else reject(outcome.error);
      };
      const onAbort = () => finish({ error: questionWaitAborted(questionId) });
      const poll = () => {
        if (settled) return;
        if (this.clock.now().getTime() >= deadline) {
          finish({ error: new Error(`Timed out waiting for answer to ${questionId}`) });
          return;
        }
        if (checking) return;
        checking = true;
        void check()
          .then((answer) => {
            if (this.clock.now().getTime() >= deadline) {
              finish({ error: new Error(`Timed out waiting for answer to ${questionId}`) });
              return;
            }
            if (answer !== null) finish({ answer });
          })
          .catch((error: unknown) => finish({ error }))
          .finally(() => {
            checking = false;
          });
      };
      cancelTimer = this.scheduler.scheduleEvery(pollIntervalMs, poll);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted === true) onAbort();
      else poll();
    });
  }

  private async readQuestionAnswer(
    runId: string,
    questionId: string,
    expectedTurn: ActiveQuestionTurn,
  ): Promise<string | null> {
    const state = await this.store.readRun(runId);
    const asked = state.journal.find(
      (event) =>
        event.event === "question.asked" && Reflect.get(event.data, "questionId") === questionId,
    );
    if (asked === undefined) throw new Error(`Unknown question ${questionId}`);
    if (asked.actor.channel !== "worker" || asked.actor.sessionId !== expectedTurn.sessionId) {
      throw new Error(
        `Question ${questionId} does not belong to worker session ${expectedTurn.sessionId}`,
      );
    }
    if (Reflect.get(asked.data, "turnId") !== expectedTurn.turnId) {
      throw new Error(
        `Question ${questionId} does not belong to worker turn ${expectedTurn.turnId}`,
      );
    }
    if (
      state.status !== "running" ||
      state.activeTurn?.sessionId !== expectedTurn.sessionId ||
      state.activeTurn.turnId !== expectedTurn.turnId
    ) {
      throw new Error(`Worker turn ${expectedTurn.turnId} is no longer active`);
    }
    const answered = state.journal.find(
      (event) =>
        event.event === "question.answered" && Reflect.get(event.data, "questionId") === questionId,
    );
    const answer = answered === undefined ? undefined : Reflect.get(answered.data, "answer");
    if (answered === undefined) return null;
    if (typeof answer !== "string") throw new Error(`Answer for ${questionId} is invalid`);
    return answer;
  }

  async journal(runId: string, after = 0, limit = 200) {
    return this.persistence.readJournal(runId, after, boundedLimit(limit));
  }

  async output(
    runId: string,
    ownerKind: "run" | "phase" | "task",
    ownerId: string,
    after = 0,
    limit = 200,
  ) {
    return this.persistence.readOutput(runId, ownerKind, ownerId, after, boundedLimit(limit));
  }

  async workerEvents(
    runId: string,
    ownerKind: "phase" | "task",
    ownerId: string,
    after = 0,
    limit = 200,
  ) {
    const records = (await this.persistence.readWorkerEvents(runId)).filter(
      (record) => record.owner.kind === ownerKind && record.owner.id === ownerId,
    );
    return records
      .map((record, index) => ({ seq: index + 1, ...record }))
      .filter((record) => record.seq > after)
      .slice(0, boundedLimit(limit));
  }

  async artifact(
    runId: string,
    phaseId: string,
    version?: number,
  ): Promise<RuntimeArtifact | null> {
    return this.persistence.readArtifact(runId, phaseId, version);
  }

  async sensorAudit(runId: string) {
    const state = await this.store.readRun(runId);
    const events = state.journal.filter(
      (event) => event.event === "sensor.completed" || event.event === "sensor.error",
    );
    const sensorIds = new Set(
      events.flatMap((event) => {
        const sensorId = Reflect.get(event.data, "sensorId");
        return typeof sensorId === "string" ? [sensorId] : [];
      }),
    );
    const sensors = [...sensorIds].map((sensorId) => {
      const samples = events.filter((event) => Reflect.get(event.data, "sensorId") === sensorId);
      const outcomes = samples.map((event) => {
        const verdict = Reflect.get(event.data, "verdict");
        return event.event === "sensor.error"
          ? "error"
          : typeof verdict === "string"
            ? verdict
            : "unknown";
      });
      const counts = new Map<string, number>();
      for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
      const agreement = outcomes.length === 0 ? 1 : Math.max(...counts.values()) / outcomes.length;
      const durations = samples
        .flatMap((event) => {
          const durationMs = Reflect.get(event.data, "durationMs");
          return typeof durationMs === "number" ? [durationMs] : [];
        })
        .toSorted((left, right) => left - right);
      const target = state.snapshot.policy.sensors.find(
        (sensor) => sensor.id === sensorId,
      )?.stability;
      return {
        sensorId,
        samples: outcomes.length,
        agreement,
        driftTransitions: outcomes.slice(1).filter((value, index) => value !== outcomes[index])
          .length,
        p95DurationMs: percentile(durations, 0.95),
        expectedSamples: target?.samples ?? null,
        expectedAgreement: target?.agreement ?? null,
        drifted:
          target !== undefined && outcomes.length >= target.samples && agreement < target.agreement,
      };
    });
    return {
      runId,
      sensors,
      hookLatency: { samples: 0, p95DurationMs: null, status: "unreported" as const },
    };
  }

  async workflows() {
    return this.requireCatalog().listWorkflows();
  }

  async workflow(workflowName: string) {
    return this.requireCatalog().readWorkflow(workflowName);
  }

  async renderWorkflow(workflowName: string): Promise<string> {
    const workflow = await this.workflow(workflowName);
    const lines = ["flowchart LR"];
    for (const phase of workflow.spec.phases) {
      lines.push(`  ${phase.id}[${JSON.stringify(phase.id)}]`);
      for (const dependency of phase.dependsOn) {
        lines.push(`  ${dependency} --> ${phase.id}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  async report(runId: string): Promise<string> {
    if (this.reports === undefined) throw new Error("Report service is not configured");
    return this.reports.render(runId);
  }

  private requireCatalog(): WorkflowCatalogPort {
    if (this.catalog === undefined) throw new Error("Workflow catalog is not configured");
    return this.catalog;
  }
}

function resolveTurnProfile(
  state: RuntimeState,
  role: string,
  execution?: {
    readonly model?: string | undefined;
    readonly effort?: "low" | "medium" | "high" | "xhigh" | undefined;
  },
): {
  profile: WorkerProfile;
  profileDigest: string;
  requestedModel: WorkerProfile["spec"]["model"];
  resolvedModel: WorkerProfile["spec"]["model"];
} {
  const profile = state.snapshot.workerProfiles[role];
  if (profile === undefined) throw new Error(`Unknown snapshotted worker profile: ${role}`);
  const sourcePath = `.senawa/agents/${role}.senawa.md`;
  const source = state.snapshot.files.find((file) => file.path === sourcePath);
  if (source === undefined)
    throw new Error(`Missing snapshotted worker profile source: ${sourcePath}`);
  const effort = execution?.effort ?? profile.spec.model.effort;
  const requestedModel = {
    id: execution?.model ?? profile.spec.model.id,
    ...(effort === undefined ? {} : { effort }),
  };
  return {
    profile,
    profileDigest: source.sha256,
    requestedModel,
    resolvedModel: requestedModel,
  };
}

function nextPhase(state: RuntimeState): RuntimePhase | undefined {
  return state.phases.find((phase) => {
    if (phase.status === "accepted" || phase.status === "ended") return false;
    const definition = workflowPhase(state, phase.id);
    return definition.dependsOn.every(
      (dependency) => requirePhase(state, dependency).status === "accepted",
    );
  });
}

function workflowPhase(state: RuntimeState, phaseId: string) {
  const phase = state.snapshot.workflow.spec.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Unknown workflow phase ${phaseId}`);
  return phase;
}

function requirePhase(state: RuntimeState, phaseId: string): RuntimePhase {
  const phase = state.phases.find((candidate) => candidate.id === phaseId);
  if (phase === undefined) throw new Error(`Unknown phase ${phaseId}`);
  return phase;
}

function requireTask(state: RuntimeState, taskId: string): RuntimeTask {
  const task = state.tasks.find((candidate) => candidate.key === taskId);
  if (task === undefined) throw new Error(`Unknown task ${taskId}`);
  return task;
}

function requireDispatch(state: RuntimeState, dispatchId: string): RuntimeDispatch {
  const dispatch = state.dispatches.find((candidate) => candidate.dispatchId === dispatchId);
  if (dispatch === undefined) throw new Error(`Unknown dispatch ${dispatchId}`);
  return dispatch;
}

function createDispatch(
  _state: RuntimeState,
  input: Omit<RuntimeDispatch, "status" | "createdAt" | "updatedAt">,
  now: Date,
): RuntimeDispatch {
  const timestamp = now.toISOString();
  return { ...input, status: "intent", createdAt: timestamp, updatedAt: timestamp };
}

function completeDispatch(state: RuntimeState, dispatchId: string, now: Date): void {
  const dispatch = requireDispatch(state, dispatchId);
  dispatch.status = "completed";
  dispatch.updatedAt = now.toISOString();
  delete dispatch.detail;
}

function taskTurnFromActive(state: RuntimeState, task: RuntimeTask): WorkerTurn {
  const active = state.activeTurn;
  if (active === null || active.ownerKind !== "task" || active.ownerId !== task.key) {
    throw new Error(`Task ${task.key} has no active dispatch`);
  }
  return {
    runId: state.identity.runId,
    owner: { kind: "task", id: task.key },
    operation: active.operation,
    turnId: active.turnId,
    dispatchId: active.dispatchId,
    operationId: active.operationId,
    ...traceContext(state.identity.runId, active.dispatchId),
    role: task.role,
    ...resolveTurnProfile(state, task.role, task.execution),
    attempt: active.attempt,
    sessionId: active.sessionId,
    goal: state.identity.request.goal,
    rejectionReason: null,
    steering: [...task.steering],
    prompt: createTaskPrompt(state, task, active.attempt),
    authorization: { taskPaths: task.paths, frozenPaths: state.snapshot.policy.frozen },
  };
}

function workerTurnFromActive(state: RuntimeState): WorkerTurn {
  const active = state.activeTurn;
  if (active === null) throw new Error(`Run ${state.identity.runId} has no active worker turn`);
  if (active.ownerKind === "task")
    return taskTurnFromActive(state, requireTask(state, active.ownerId));
  const phase = requirePhase(state, active.ownerId);
  const definition = workflowPhase(state, phase.id);
  if (definition.executor.kind !== "agent") {
    throw new Error(`Phase ${phase.id} active turn does not use an agent executor`);
  }
  return {
    runId: state.identity.runId,
    owner: { kind: "phase", id: phase.id },
    operation: active.operation,
    turnId: active.turnId,
    dispatchId: active.dispatchId,
    operationId: active.operationId,
    ...traceContext(state.identity.runId, active.dispatchId),
    role: definition.executor.role,
    ...resolveTurnProfile(state, definition.executor.role),
    attempt: active.attempt,
    sessionId: active.sessionId,
    goal: state.identity.request.goal,
    rejectionReason: phase.rejectionReason,
    steering: [],
    prompt: createPhasePrompt(state, phase, active.attempt),
    authorization: { taskPaths: [], frozenPaths: state.snapshot.policy.frozen },
  };
}

function traceContext(
  runId: string,
  dispatchId: string,
): {
  readonly traceId: string;
  readonly traceparent: string;
} {
  const traceId = stableHex(`${runId}:${dispatchId}`, 32);
  const spanId = stableHex(dispatchId, 16);
  return { traceId, traceparent: `00-${traceId}-${spanId}-01` };
}

function stableHex(value: string, length: number): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + left), 0x85ebca6b) >>> 0;
  }
  let result = "";
  while (result.length < length) {
    left = Math.imul(left ^ (right >>> 13), 0xc2b2ae35) >>> 0;
    right = Math.imul(right ^ (left >>> 16), 0x27d4eb2f) >>> 0;
    result += left.toString(16).padStart(8, "0");
    result += right.toString(16).padStart(8, "0");
  }
  return result.slice(0, length);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function assertWorkerSession(turn: WorkerTurn, result: WorkerResult): void {
  if (result.sessionId !== turn.sessionId) {
    throw new Error(
      `Worker result session ${result.sessionId} does not match dispatch session ${turn.sessionId}`,
    );
  }
}

function importPlan(
  state: RuntimeState,
  phase: RuntimePhase,
  actor: CommandActor,
  now: Date,
): void {
  const artifact = state.artifacts.find(
    (candidate) => candidate.phaseId === phase.id && candidate.version === phase.artifactVersion,
  );
  if (artifact === undefined) throw new Error(`Phase ${phase.id} has no current plan artifact`);
  const plan = PlanArtifactSchema.parse(artifact.content);
  for (const task of plan.tasks) {
    if (state.snapshot.workerProfiles[task.role] === undefined) {
      throw new Error(`Plan task ${task.key} references missing worker profile ${task.role}`);
    }
  }
  const existing = new Set(state.tasks.map((task) => task.key));
  const added: string[] = [];
  for (const task of plan.tasks) {
    if (existing.has(task.key)) continue;
    state.tasks.push({
      ...task,
      status: "pending",
      attempt: 0,
      dispatchFailures: 0,
      sessionId: null,
      steering: [],
      reworkFindings: [],
    });
    existing.add(task.key);
    added.push(task.key);
  }
  emit(state, "plan.imported", actor, now, { phaseId: phase.id, tasks: added });
}

function appendArtifact(
  state: RuntimeState,
  phase: RuntimePhase,
  content: JsonObject,
  now: Date,
): RuntimeArtifact {
  const version = (phase.artifactVersion ?? 0) + 1;
  const parsedContent = JsonObjectSchema.parse(content);
  const existing = state.artifacts.find(
    (artifact) => artifact.phaseId === phase.id && artifact.version === version,
  );
  if (existing !== undefined) {
    if (!jsonValuesEqual(existing.content, parsedContent)) {
      throw new Error(`Artifact ${existing.path} already exists with different content`);
    }
    phase.artifactVersion = version;
    phase.rejectionReason = null;
    return existing;
  }
  const consumed = Object.fromEntries(
    state.phases
      .filter((candidate) => candidate.artifactVersion !== null)
      .map((candidate) => [candidate.id, candidate.artifactVersion as number]),
  );
  const artifact: RuntimeArtifact = {
    phaseId: phase.id,
    version,
    path: `artifacts/${phase.id}/v${version}.json`,
    createdAt: now.toISOString(),
    content: parsedContent,
    consumed,
  };
  state.artifacts.push(artifact);
  phase.artifactVersion = version;
  phase.rejectionReason = null;
  return artifact;
}

function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index] as JsonValue))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftKeys = Object.keys(left).toSorted();
  const rightKeys = Object.keys(right).toSorted();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(left[key] as JsonValue, right[key] as JsonValue),
    )
  );
}

function appendWorkerResult(
  state: RuntimeState,
  turn: WorkerTurn,
  result: WorkerResult,
  now: Date,
): void {
  for (const output of result.output) {
    appendOutput(state, turn.owner.kind, turn.owner.id, output.stream, output.text, now, {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
    });
  }
}

function appendGateEvaluation(
  state: RuntimeState,
  evaluation: GateEvaluation,
  turn: Pick<WorkerTurn, "owner" | "attempt">,
  now: Date,
  actor: CommandActor = { channel: "driver" },
): void {
  for (const reading of evaluation.readings) {
    emit(state, "sensor.started", actor, now, {
      gateId: evaluation.gateId,
      sensorId: reading.sensorId,
      ownerKind: turn.owner.kind,
      ownerId: turn.owner.id,
      attempt: turn.attempt,
    });
    emit(
      state,
      "error" in reading.result ? "sensor.error" : "sensor.completed",
      actor,
      now,
      sensorEvidence(evaluation.gateId, reading, turn),
    );
  }
  emit(state, "gate.evaluated", actor, now, {
    gateId: evaluation.gateId,
    ownerKind: turn.owner.kind,
    ownerId: turn.owner.id,
    attempt: turn.attempt,
    accepted: evaluation.accepted,
    findings: evaluation.findings.slice(0, 20).map((finding) => finding.message),
    readings: evaluation.readings.slice(0, 20).map((reading) => ({
      sensorId: reading.sensorId,
      matched: reading.matched,
      advisory: reading.advisory,
      summary: reading.result.summary,
    })),
  });
}

function sensorEvidence(
  gateId: string,
  reading: SensorReading,
  turn: Pick<WorkerTurn, "owner" | "attempt">,
): JsonObject {
  return {
    gateId,
    sensorId: reading.sensorId,
    ownerKind: turn.owner.kind,
    ownerId: turn.owner.id,
    attempt: turn.attempt,
    durationMs: reading.durationMs,
    matched: reading.matched,
    advisory: reading.advisory,
    summary: reading.result.summary,
    evidencePaths: reading.evidencePaths,
    ...("error" in reading.result
      ? { retryable: reading.result.retryable }
      : { verdict: reading.result.verdict }),
  };
}

function appendOutput(
  state: RuntimeState,
  ownerKind: "run" | "phase" | "task",
  ownerId: string,
  stream: "stdout" | "stderr" | "system",
  text: string,
  now: Date,
  worker?: { readonly sessionId: string; readonly turnId: string },
): void {
  const key = ownerKey(ownerKind, ownerId);
  let records = state.outputs[key];
  if (records === undefined) {
    records = [];
    state.outputs[key] = records;
  }
  records.push({
    apiVersion: "senawa.dev/output/v1",
    seq: records.length + 1,
    ts: now.toISOString(),
    runId: state.identity.runId,
    owner: { kind: ownerKind, id: ownerId },
    ...worker,
    stream,
    text: sanitizeOutput(text),
  });
}

function sanitizeOutput(value: string): string {
  const withoutAnsi = value.replaceAll(ansiEscapePattern, "");
  const sanitized = [...withoutAnsi]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\t" || code >= 32;
    })
    .join("")
    .trim()
    .slice(0, 20_000);
  return sanitized || "(no output)";
}

function emit(
  state: RuntimeState,
  event: JournalEventName,
  actor: CommandActor,
  now: Date,
  data: JsonObject,
): void {
  state.journal.push({
    apiVersion: "senawa.dev/event/v1",
    seq: state.journal.length + 1,
    ts: now.toISOString(),
    runId: state.identity.runId,
    event,
    actor,
    data: JsonObjectSchema.parse(data),
  });
}

function hasCommandEvent(state: RuntimeState, commandId: string, event: JournalEventName): boolean {
  return state.journal.some(
    (candidate) =>
      candidate.event === event && Reflect.get(candidate.data, "commandId") === commandId,
  );
}

function assertMutable(state: RuntimeState): void {
  if (state.status === "finished" || state.status === "ended") {
    throw new Error(`Run ${state.identity.runId} is ${state.status}`);
  }
}

function completionPhaseId(state: RuntimeState): string {
  return state.snapshot.workflow.spec.completesWhen.replace(/-accepted$/u, "");
}

function ownerKey(ownerKind: "run" | "phase" | "task", ownerId: string): string {
  return `${ownerKind}:${ownerId}`;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? null;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Limit must be a positive integer");
  return Math.min(value, 500);
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.floor(value);
}

function questionWaitAborted(questionId: string): Error {
  return new Error(`Waiting for answer to ${questionId} was cancelled`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}
