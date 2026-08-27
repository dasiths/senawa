import type { ConfigurationSnapshot } from "@senawa/configuration";
import { loadAuthoredWorkflow, runSensors } from "@senawa/execution-host";
import {
  type CanonicalValue,
  canonicalValue,
  createPhaseCandidate,
  createSensorReading,
  defineGate,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  evaluateGate,
  type PhaseOutputPublication,
  type Sha256,
  type Sha256Digest,
  sha256Digest,
  type TaskGenerationReference,
} from "@senawa/kernel";
import {
  type AuthenticatedPrincipal,
  canonicalBytes,
  type DurableReceipt,
  decodeAuthenticatedPrincipal,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type {
  CanonicalJsonAssetPort,
  RuntimeAttemptRecord,
  RuntimeSchedulingSnapshot,
} from "@senawa/runtime";
import { RuntimeDataflowAuthority, type RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
  SqliteRunnerAuthority,
} from "@senawa/storage-sqlite";
import { SqliteSupervisorAuthority } from "@senawa/supervisor";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import { dispatchPhase } from "./dispatch-driver.js";
import { planFanOut, snapshotWithGraph } from "./fan-out-driver.js";

/** Applying an approved amendment is a supervisor action, not a human decision. */
const TRUSTED_SUPERVISOR = decodeAuthenticatedPrincipal({
  issuer: "senawa.local",
  subject: "advance-run",
  tenant: "local",
  assurance: "hardware-backed",
  roles: ["trusted-supervisor"],
});

/** What the driver did, and what it is now waiting for. */
export type AdvanceOutcome =
  | { readonly kind: "dispatched"; readonly phaseKey: string; readonly dispatchId: string }
  | {
      readonly kind: "retrying";
      readonly phaseKey: string;
      readonly attempt: number;
      readonly dispatchId: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "awaiting-agent";
      readonly phaseKey: string;
      /** The turn being waited on. Without it, a wait nobody can end is unnamed. */
      readonly dispatchId?: string;
    }
  | { readonly kind: "awaiting-approval"; readonly phaseKey: string }
  | {
      /** A member out of tries has asked a person what to do, and waits. */
      readonly kind: "escalated";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "gate-refused";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "rejected";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "output-refused";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "fanned-out"; readonly phaseKey: string; readonly members: number }
  | { readonly kind: "closed"; readonly phaseKey: string }
  | { readonly kind: "finished" };

/**
 * What a caller can do next about an outcome.
 *
 * Every outcome must classify, so there is no reachable state in which a run can
 * neither make progress, await a declared human decision, nor be refused with
 * reasons a person can escalate. Adding an outcome without classifying it fails
 * to compile, which is the only way this stays true.
 */
export type AdvanceDisposition = "progress" | "awaiting-human" | "refused";

export function classifyOutcome(outcome: AdvanceOutcome): AdvanceDisposition {
  switch (outcome.kind) {
    case "dispatched":
    case "retrying":
    case "fanned-out":
    case "closed":
    case "finished":
      return "progress";
    // The agent is working, and a person can escalate or steer it. This is a
    // wait, not a stall.
    case "awaiting-agent":
    case "awaiting-approval":
    case "escalated":
      return "awaiting-human";
    case "gate-refused":
    case "rejected":
    case "output-refused":
      return "refused";
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unclassified advance outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

export interface AdvanceRunInput {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly repositoryId: string;
  readonly runId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly dependencies: RuntimeDependencies;
  readonly currentTime: string;
  readonly configurationDirectory?: string;
  /** Bound at instantiation; every phase reads it alongside its upstream outputs. */
  readonly workflowInput: {
    readonly bindingDigest: Sha256Digest;
    readonly value: CanonicalValue;
  };
  readonly repositoryBase: {
    readonly commitDigest: Sha256Digest;
    readonly treeDigest: Sha256Digest;
  };
  /**
   * Authorities to advance through, already open. Opening a pair costs about
   * half a second on a run of three phases and grows with the run, and a
   * service that advances every cycle paid it every cycle, on the event loop
   * its console answers from. A caller that supplies them keeps them; whoever
   * opened them closes them.
   */
  readonly open?: {
    readonly supervisor: SqliteSupervisorAuthority;
    readonly broker: SqliteContextBroker;
  };
}

interface SnapshotPhase {
  readonly key: string;
  readonly dependsOn?: readonly string[];
  readonly executor?: { readonly kind?: string };
  readonly outputs: readonly { readonly key: string }[];
  readonly iteration?: {
    readonly maximumAttempts?: number;
    readonly onGateRejected?: string;
    readonly onApprovalRejected?: string;
    readonly onExhausted?: string;
  };
  readonly exit?: {
    readonly gate?: string;
    readonly approval?: { readonly policy?: string };
  };
}

interface GateRule {
  readonly key: string;
  readonly condition: {
    readonly accessor: { readonly sensorKey: string; readonly pointer?: string };
    readonly operator?: string;
    readonly expected?: unknown;
  };
}

interface SnapshotGateValue {
  readonly phase: string;
  readonly definition: Parameters<typeof evaluateGate>[0];
}

/**
 * Moves a run forward by one decision and reports what it did.
 *
 * Every step below existed and was covered on its own. Nothing joined them, so
 * a dispatched phase stayed dispatched: no sensor ran, no gate was evaluated,
 * and no second phase was ever reached. This is that join.
 *
 * One step per call, because each step is a durable authority decision and a
 * caller that crashes between two of them must be able to resume at the next.
 */
export async function advanceRun(input: AdvanceRunInput): Promise<AdvanceOutcome> {
  const loaded = await loadAuthoredWorkflow(
    input.projectRoot,
    input.dependencies.sha256,
    input.configurationDirectory,
  );
  if (loaded.snapshot === undefined) {
    // A count is not a reason. This is the message a person reads when a run
    // stops advancing, so it has to name what to fix and where.
    throw new Error(
      `Workflow does not compile: ${loaded.diagnostics
        .map(({ locator, pointer, message }) => `${locator}${pointer} ${message}`)
        .join("; ")}`,
    );
  }
  const supervisor =
    input.open?.supervisor ??
    new SqliteSupervisorAuthority({
      databasePath: input.databasePath,
      assetDirectory: input.assetDirectory,
      dependencies: input.dependencies,
    });
  const broker =
    input.open?.broker ??
    new SqliteContextBroker({
      databasePath: input.databasePath,
      dependencies: {
        sha256: input.dependencies.sha256,
        currentTime: () => input.currentTime,
        issueGrantToken: () => new Uint8Array(32),
      },
    });
  try {
    // An applied amendment leaves the run on a graph the authored project no
    // longer describes, so the run's own snapshot wins where one exists.
    const active = activeSnapshot(supervisor, input, loaded.snapshot);
    return await step(input, active, supervisor, broker);
  } finally {
    if (input.open === undefined) {
      broker.close();
      supervisor.close();
    }
  }
}

/** The snapshot this run is executing against, which an amendment may have changed. */
function activeSnapshot(
  supervisor: SqliteSupervisorAuthority,
  input: AdvanceRunInput,
  authored: ConfigurationSnapshot,
): ConfigurationSnapshot {
  const scheduling = supervisor.commandAuthority.queryRunScheduling(
    input.repositoryId,
    input.runId,
  );
  const graph = scheduling?.graph;
  if (graph === undefined || graph.revisionDigest === authored.graph.revisionDigest) {
    return authored;
  }
  return snapshotWithGraph(authored, graph as never, input.dependencies.sha256);
}

async function step(
  input: AdvanceRunInput,
  snapshot: ConfigurationSnapshot,
  supervisor: SqliteSupervisorAuthority,
  broker: SqliteContextBroker,
): Promise<AdvanceOutcome> {
  const scheduling = supervisor.commandAuthority.queryRunScheduling(
    input.repositoryId,
    input.runId,
  );
  if (scheduling === undefined) throw new Error(`${input.runId}: no such run`);
  const phaseKey = phaseKeyById(snapshot, scheduling.phase.phaseId);
  if (phaseKey === undefined)
    throw new Error("Run points at a phase the workflow does not declare");
  // A closed last phase is a finished run, and there is nothing left to drive.
  // Without this the driver re-ran the phase it had already closed on every
  // cycle, rebuilding the same commands against a graph that had moved under
  // them, and the authority refused each one for conflicting with the identical
  // command it had recorded the first time. The run stopped for good, and said
  // so nowhere a person could read it.
  if (scheduling.closed && nextPhase(snapshot, phaseKey) === undefined) {
    return { kind: "finished" };
  }
  const phase = phaseValue(snapshot, phaseKey);

  const state = broker.authority.snapshot();

  // A turn ends when the agent returns, and the runner's outcome is the only
  // record of that. Copying it into the run's own record here is what lets
  // every decision below read one fact instead of inferring the same thing two
  // ways, which is how a member ended up both still working and spent.
  const attempts = closeEndedAttempts(input, supervisor, snapshot, scheduling, state);
  const digestOf = (dispatchId: string) =>
    attempts.find((entry) => entry.attemptDigest === attemptDigestOf(input, dispatchId));
  /** Whether an agent currently holds the turn this dispatch is. */
  const attemptOpen = (dispatchId: string): boolean =>
    digestOf(dispatchId)?.disposition === "opened";
  /**
   * Whether this dispatch's turn is recorded as over.
   *
   * An attempt nobody opened is not closed, it is unknown, and a run whose
   * dispatches predate this record must not be retried on sight.
   */
  const attemptClosed = (dispatchId: string): boolean => {
    const held = digestOf(dispatchId);
    return held !== undefined && held.disposition !== "opened";
  };
  // Every dispatch is an attempt. Opening it in one place rather than at the
  // seven that dispatch is what makes the authority's refusal reachable: a
  // dispatch that opened no attempt is one the one-agent rule cannot see.
  const dispatchAttempt = (
    request: Parameters<typeof dispatchPhase>[0],
  ): ReturnType<typeof dispatchPhase> => {
    const dispatched = dispatchPhase(request);
    recordAttempt(supervisor, input, snapshot.graph.revisionDigest, {
      dispatchId: String(dispatched.dispatch.dispatchId),
      taskId: String(dispatched.dispatch.task.taskId),
      definitionGeneration: Number(dispatched.dispatch.task.definitionGeneration),
      disposition: "opened",
    });
    return dispatched;
  };

  // A fan-out phase owns one task per member, and they run one at a time. The
  // next member is the first that nothing has been dispatched for yet. Without
  // this the driver treats the member that just finished as the phase's live
  // work and tries to close a phase most of whose members never ran.
  const members = phase.executor?.kind === "task-frontier" ? phaseTasks(snapshot, phaseKey) : [];
  const pendingMember =
    members.length === 0
      ? undefined
      : members.findIndex(
          (task) =>
            !state.dispatches.some(
              (candidate) =>
                candidate.runId === input.runId &&
                candidate.task.taskId ===
                  String((task as { readonly definition: { readonly id: unknown } }).definition.id),
            ),
        );
  if (pendingMember !== undefined && pendingMember >= 0) {
    // A member that reported it could not finish is one member's answer, not
    // the phase's. Under `continue` the rest are still worth running, and under
    // `fail-fast` they are not: spending attempts on work that will be thrown
    // away is the cost the policy exists to avoid.
    const blocked = state.completionOutbox
      .filter(
        (entry) =>
          phaseDispatchIdsOf(snapshot, state, input.runId, phaseKey).has(
            String(entry.fact.dispatchId),
          ) && String(entry.fact.assessment.submission.disposition) === "blocked",
      )
      .map((entry) => String(entry.fact.assessment.submission.summary));
    // A person may accept work the run judged unfinished. Once they have, the
    // run stops treating it as a failure: overriding it and then halting on it
    // anyway would make the override a gesture rather than a decision.
    const overridden = new Set(
      supervisor.commandAuthority
        .listMemberOverrides({ repositoryId: input.repositoryId, runId: input.runId })
        .map((entry) => entry.dispatchId),
    );
    const unaccepted = state.completionOutbox
      .filter(
        (entry) =>
          String(entry.fact.assessment.submission.disposition) === "blocked" &&
          !overridden.has(String(entry.fact.dispatchId)),
      )
      .map((entry) => String(entry.fact.dispatchId));
    if (
      blocked.length > 0 &&
      unaccepted.length > 0 &&
      executionFailurePolicy(snapshot) === "fail-fast"
    ) {
      return { kind: "rejected", phaseKey, reasons: blocked };
    }
    const dispatched = dispatchAttempt({
      snapshot,
      dataflow: new RuntimeDataflowAuthority(
        input.dependencies.sha256,
        configurationRuntimeSchemaValidator(),
        assets(supervisor, broker),
        supervisor.commandAuthority,
      ),
      contextBroker: broker,
      sessionLedger: supervisor.commandAuthority,
      dependencies: input.dependencies,
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      memberIndex: pendingMember,
      // Each member binds its own phase attempt, because each carries different
      // content and the dataflow refuses to reuse an ordinal for a new one.
      attempt: pendingMember + 1,
      workflowInput: input.workflowInput,
      upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
      repositoryBase: input.repositoryBase,
      currentTime: input.currentTime,
    });
    return { kind: "dispatched", phaseKey, dispatchId: dispatched.dispatch.dispatchId };
  }
  // The latest attempt is the live one. An earlier attempt's dispatch is still
  // stored, and treating it as current would gate work the retry replaced.
  //
  // A fan-out phase has one member per task and they run at the same time, so
  // they finish in any order. Reasoning about the newest dispatch alone made the
  // phase try to close as soon as that one member handed in: the candidate
  // covers every task the phase owns, so it refused itself for the members still
  // working, on every cycle, for ever. Whichever member has not handed work in is
  // the phase's business until none is left. That is the fan-in the fan-out
  // never had, and it waits on exactly what closing the phase needs.
  const acceptedTaskIds = new Set(scheduling.acceptedTasks.map(({ task }) => String(task.taskId)));
  const phaseMembers = [
    ...currentPhaseDispatches(snapshot, state, input.runId, phaseKey, acceptedTaskIds),
  ].sort((left, right) => left.ordinal - right.ordinal);
  const handedIn = new Set(state.completionOutbox.map((entry) => String(entry.fact.dispatchId)));
  const dispatch =
    phaseMembers.find((candidate) => !handedIn.has(String(candidate.dispatchId))) ??
    phaseMembers.at(-1);

  const dataflow = new RuntimeDataflowAuthority(
    input.dependencies.sha256,
    configurationRuntimeSchemaValidator(),
    assets(supervisor, broker),
    supervisor.commandAuthority,
  );

  if (dispatch === undefined) {
    // A fan-out phase has no task until the collection an earlier phase produced
    // is turned into members, so that has to happen before anything is
    // dispatched.
    if (phase.executor?.kind === "task-frontier" && phaseTasks(snapshot, phaseKey).length === 0) {
      return materialiseMembers(
        input,
        snapshot,
        supervisor,
        phaseKey,
        phase,
        state,
        assets(supervisor, broker),
      );
    }
    const dispatched = dispatchAttempt({
      snapshot,
      dataflow,
      contextBroker: broker,
      sessionLedger: supervisor.commandAuthority,
      dependencies: input.dependencies,
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      workflowInput: input.workflowInput,
      upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
      repositoryBase: input.repositoryBase,
      currentTime: input.currentTime,
    });
    return { kind: "dispatched", phaseKey, dispatchId: dispatched.dispatch.dispatchId };
  }

  const dispatchId = dispatch.dispatchId;
  // Every retry below is for this member, not for the phase's first one.
  const retryMember = memberIndexOf(snapshot, phaseKey, String(dispatch.task.taskId));
  const retryMemberIndex = retryMember === undefined ? {} : { memberIndex: retryMember };
  const completed = state.terminalCompletions.some((entry) => entry.dispatchId === dispatchId);
  const published = state.phaseOutputOutbox.filter((entry) => entry.fact.dispatchId === dispatchId);

  // A person who asked for the attempt to start again is not waiting for the
  // agent to finish first: that is the whole point of asking. The instruction is
  // already recorded, so the retry can carry it even though the abandoned turn
  // never reported anything.
  const attempt = dispatch.ordinal;
  // One number was carrying two meanings. A fan-out spends an ordinal per
  // member, so members sit at 1..N in the very space a retry increments into:
  // retrying member one asked for ordinal two, which its sibling already held
  // with different content, and the dataflow refused it. The same conflation
  // measured the retry limit by a member's position, so the last member of a
  // fan-out had spent its tries before taking one. A new dispatch takes the
  // next ordinal free in the phase, and the limit counts the retrying task's
  // own tries. The candidate keeps binding this dispatch's own ordinal.
  const phaseDispatches = state.dispatches.filter(
    (candidate) =>
      candidate.runId === input.runId &&
      phaseKeyByTask(snapshot, candidate.task.taskId) === phaseKey,
  );
  // A phase spends ordinals on more than dispatching, so the attempts know
  // which are taken and the dispatches only guess.
  const nextAttempt = Math.max(
    nextPhaseAttemptOrdinal(input, scheduling.phase),
    Math.max(0, ...phaseDispatches.map((candidate) => candidate.ordinal)) + 1,
  );
  // A turn that ended by asking a person is not a try, so it does not count
  // against the ceiling. Counting it meant a run could exhaust its attempts
  // without anything going wrong, purely by asking and being answered.
  //
  // Nor does a try made before a person told the member what to do differently.
  // A member that has spent its attempts asks for help, and an answer that
  // bought it nothing would be no answer at all, so the ceiling is counted from
  // the last instruction rather than from the start of the run.
  const answeredOrdinal = Math.max(
    0,
    ...answeredAttemptOrdinals(supervisor, broker, input, String(dispatch.task.taskId)),
  );
  const taskAttempts = phaseDispatches.filter(
    (candidate) =>
      String(candidate.task.taskId) === String(dispatch.task.taskId) &&
      candidate.ordinal > answeredOrdinal &&
      digestOf(String(candidate.dispatchId))?.disposition !== "suspended",
  ).length;
  const steerings = supervisor.commandAuthority.listAgentSteerings(dispatchId);
  const abort = steerings.filter((entry) => entry.delivery === "abort-retry");
  if (!completed && abort.length > 0) {
    const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
    if (taskAttempts < maximumAttempts) {
      const instructions = abort.map((entry) => entry.instruction);
      // A person abandoning a live turn is the one case where the attempt ends
      // without the agent returning. Saying so before the replacement opens is
      // what keeps the task from briefly having two.
      if (attemptOpen(String(dispatchId))) {
        recordAttempt(supervisor, input, snapshot.graph.revisionDigest, {
          dispatchId: String(dispatchId),
          taskId: String(dispatch.task.taskId),
          definitionGeneration: Number(dispatch.task.definitionGeneration),
          disposition: "refused",
        });
      }
      const retried = dispatchAttempt({
        snapshot,
        dataflow,
        contextBroker: broker,
        sessionLedger: supervisor.commandAuthority,
        dependencies: input.dependencies,
        repositoryId: input.repositoryId,
        runId: input.runId,
        phaseKey,
        workflowInput: input.workflowInput,
        upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
        repositoryBase: input.repositoryBase,
        currentTime: input.currentTime,
        attempt: nextAttempt,
        ...retryMemberIndex,
        priorRefusals: instructions,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: nextAttempt,
        dispatchId: retried.dispatch.dispatchId,
        reasons: instructions,
      };
    }
  }

  // An answered question is only half an answer. The agent that asked cannot
  // read the database, so the answer reaches it by being carried into a fresh
  // dispatch, and the requirement that stopped the run is satisfied by that
  // dispatch rather than by the answer being written down.
  const forTask = (entry: { readonly taskId: string }) =>
    entry.taskId === String(dispatch.task.taskId);
  // Everything it has been told, not just what arrived since it last ran. Its
  // context is the only memory it has, so carrying one answer at a time had it
  // asking again in different words for what it already knew.
  const answered = supervisor.commandAuthority
    .listAnsweredQuestions(input.repositoryId, input.runId)
    .filter(forTask);
  const undelivered = supervisor.commandAuthority
    .listUndeliveredAnswers(input.repositoryId, input.runId)
    .filter(forTask);
  // An answer carries into the next attempt, and work that has already been
  // handed in has no next attempt. Dispatching one anyway makes work the
  // scheduler will never start, because a task that is accepted, or waiting to
  // be, is not in the ready frontier, and the fan-in then waits on it for ever.
  //
  // Acceptance alone is too late a signal: a member that hands in sits handed-in
  // but unaccepted for a cycle or more, which is exactly when an answer arrives.
  // The durable completion is the fact that does not move.
  const handedInTaskIds = new Set(
    state.terminalCompletions
      .map((entry) =>
        state.dispatches.find(
          (candidate) => String(candidate.dispatchId) === String(entry.dispatchId),
        ),
      )
      .filter((candidate) => candidate !== undefined)
      .map((candidate) => String(candidate.task.taskId)),
  );
  const taskAlreadyDone =
    handedInTaskIds.has(String(dispatch.task.taskId)) ||
    (scheduling.acceptedTasks ?? []).some(
      (entry) => String(entry.task.taskId) === String(dispatch.task.taskId),
    );
  // Except when the answer is to a member that had run out of tries. That work
  // was handed in and refused, so "already done" is true and useless: the whole
  // point of the answer is to open the attempt that acts on it. Marking the
  // requirement delivered against the turn that asked would also satisfy it
  // with its own dispatch, which the record refuses outright.
  const answeringExhaustion = undelivered.some((entry) =>
    entry.submissionId.startsWith("submission_exhausted-"),
  );
  // A member that is still working will hand in on its own. Giving it a turn to
  // carry the answer makes a second dispatch for the same task, and whichever
  // one loses is waited on for ever. Only a turn that is over needs replacing.
  const memberStillWorking = !taskAlreadyDone && !completed && attemptOpen(String(dispatchId));
  if (undelivered.length > 0 && taskAlreadyDone && !answeringExhaustion) {
    for (const entry of undelivered) {
      supervisor.commandAuthority.satisfyFreshDispatchRequirement(
        entry.submissionId,
        String(dispatch.dispatchId),
      );
    }
  }
  if (undelivered.length > 0 && (answeringExhaustion || !taskAlreadyDone) && !memberStillWorking) {
    // A member owns its own task, so the fresh dispatch has to name the same
    // member rather than the phase's first.
    const member = members.findIndex(
      (task) =>
        String((task as { readonly definition: { readonly id: unknown } }).definition.id) ===
        String(dispatch.task.taskId),
    );
    const resumed = dispatchAttempt({
      snapshot,
      dataflow,
      contextBroker: broker,
      sessionLedger: supervisor.commandAuthority,
      dependencies: input.dependencies,
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      workflowInput: input.workflowInput,
      upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
      repositoryBase: input.repositoryBase,
      currentTime: input.currentTime,
      // A task scope is only taken over by a later attempt, which is what makes
      // the turn that asked unable to hand work in afterwards. So the answer
      // arrives on the next attempt rather than beside the question.
      attempt: nextAttempt,
      memberIndex: member < 0 ? 0 : member,
      answeredQuestions: answered.map(({ question, answer }) => ({ question, answer })),
    });
    for (const entry of undelivered) {
      supervisor.commandAuthority.satisfyFreshDispatchRequirement(
        entry.submissionId,
        resumed.dispatch.dispatchId,
      );
    }
    return {
      kind: "dispatched",
      phaseKey,
      dispatchId: resumed.dispatch.dispatchId,
    };
  }

  if (!completed || published.length === 0) {
    // A turn that stopped to ask is waiting for a person, not spent. Retrying it
    // dispatches an agent with the same context, which asks the same question
    // again and spends an attempt doing it.
    const asked = state.questions.some((question) => String(question.dispatchId) === dispatchId);
    // A dispatch whose attempt is recorded as over is a spent attempt, not work
    // still in progress. Reporting it as awaiting the agent waits for a turn
    // that is already finished, which stalls the run until a person notices.
    if (!asked && attemptClosed(dispatchId)) {
      const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
      if (taskAttempts < maximumAttempts) {
        const retried = dispatchAttempt({
          snapshot,
          dataflow,
          contextBroker: broker,
          sessionLedger: supervisor.commandAuthority,
          dependencies: input.dependencies,
          repositoryId: input.repositoryId,
          runId: input.runId,
          phaseKey,
          workflowInput: input.workflowInput,
          upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
          repositoryBase: input.repositoryBase,
          currentTime: input.currentTime,
          attempt: nextAttempt,
          ...retryMemberIndex,
          priorRefusals: [
            "Your previous turn ended without submitting a completion, so this is a fresh attempt. This is not a refusal of anything you sent.",
          ],
        });
        return {
          kind: "retrying",
          phaseKey,
          attempt: nextAttempt,
          dispatchId: retried.dispatch.dispatchId,
          reasons: [
            "Your previous turn ended without submitting a completion, so this is a fresh attempt. This is not a refusal of anything you sent.",
          ],
        };
      }
      return {
        kind: "rejected",
        phaseKey,
        reasons: [`no attempt handed any work in after ${maximumAttempts} tries`],
      };
    }
    return { kind: "awaiting-agent", phaseKey, dispatchId };
  }

  // Publication is where the declared schema is enforced. A refusal here means
  // the agent's output never becomes readable, so the phase is left unchanged.
  const publications: PhaseOutputPublication[] = [];
  for (const { fact } of published) {
    try {
      publications.push(
        dataflow.publishPhaseOutput({
          schema: runtimeSchemaContract(
            snapshot,
            String(fact.output.schemaKey),
            input.dependencies.sha256,
          ),
          fact,
        }),
      );
    } catch (error) {
      return {
        kind: "output-refused",
        phaseKey,
        reasons: [
          `${String(fact.output.outputName)}: ${
            error instanceof Error ? error.message : "output was refused"
          }`,
        ],
      };
    }
  }
  // A fan-out phase closes over every member, so the assessments have to come
  // from every member's completion rather than only the one this dispatch
  // carried. Taking one dispatch's worth leaves the candidate covering tasks it
  // has no assessment for, which is refused at the last step of a run that has
  // already done all its work.
  //
  // A task attempted more than once has a dispatch per attempt, and only the
  // latest one is the phase's current work: an earlier attempt's completion was
  // assessed against an earlier context and is stale by construction.
  const phaseDispatchIds = new Set(
    currentPhaseDispatches(snapshot, state, input.runId, phaseKey, acceptedTaskIds).map(
      (candidate) => String(candidate.dispatchId),
    ),
  );
  const assessments = state.completionOutbox
    .filter((entry) => phaseDispatchIds.has(String(entry.fact.dispatchId)))
    .map((entry) => ({
      assessment: entry.fact.assessment,
      assessmentDigest: digestAccountingAssessment(
        entry.fact.assessment,
        input.dependencies.sha256,
      ),
    }));

  // The authority derives the phase's accepted tasks from delivered completion
  // facts, so anything still sitting in the outbox has to be handed over first.
  // Every member's completion has to reach the authority, not only the one
  // this dispatch carried. The authority derives the phase's accepted tasks from
  // delivered facts, so a member left in the outbox is a member the phase does
  // not know finished, and the candidate is refused for not covering it.
  deliverFacts(input, supervisor, broker, state, phaseDispatchIds);

  const gate = gateFor(snapshot, phase, input.dependencies.sha256);
  // The authority builds the gate's task set from the completion facts it has
  // accepted, so the driver has to read that same source. Building it from
  // dispatches instead computes a digest the authority cannot reproduce, and
  // because the digest names the command, the refusal it earns is cached under
  // an identity the driver keeps re-deriving: the phase can then never be gated
  // again, however correct its evidence later becomes.
  // The accepted set has to be read after the delivery above, not from the view
  // the cycle opened with, or the driver gates on evidence the authority has
  // since been given.
  const delivered =
    supervisor.commandAuthority.queryRunScheduling(input.repositoryId, input.runId) ?? scheduling;
  const tasks = acceptedPhaseTasks(delivered, snapshot, phaseKey);
  // Waiting is right when the evidence is not in yet. Submitting is not, because
  // a refusal here is permanent.
  if (!coversEveryActiveTask(snapshot, phaseKey, tasks))
    return { kind: "awaiting-agent", phaseKey };
  const measured = gate === undefined ? [] : await readGate(input, snapshot, gate);

  const candidate = createPhaseCandidate(
    {
      phase: scheduling.phase,
      phaseAttempt: { ...scheduling.phase, attempt },
      graphRevisionDigest: snapshot.graph.revisionDigest,
      inputBindingDigest: publications[0]?.inputBindingDigest ?? sha256Digest("0".repeat(64)),
      requiredOutputPublications: publications,
      outputSetDigest: digestPhaseOutputSet(publications, input.dependencies.sha256),
      selectedTaskSetDigest: digestSelectedTaskSet(tasks, input.dependencies.sha256),
      tasks,
      acceptedAccountingAssessments: assessments,
      dependencyBarrierDigest: sha256Digest("0".repeat(64)),
      gatePolicyDigest: gate?.policyDigest ?? sha256Digest("0".repeat(64)),
    },
    snapshot.graph,
    input.dependencies.sha256,
  );

  // A reading is evidence about one candidate, so it is bound to that candidate.
  const readings = measured.map((reading) =>
    createSensorReading(
      {
        sensorKey: reading.sensorKey,
        inputDigest: candidate.candidateDigest,
        outcome: reading.outcome,
        ...(reading.outcome === "succeeded" ? { data: reading.data } : { error: reading.error }),
      } as Parameters<typeof createSensorReading>[0],
      input.dependencies.sha256,
    ),
  );

  const evaluation =
    gate === undefined
      ? undefined
      : evaluateGate(gate, readings, candidate.candidateDigest, input.dependencies.sha256);

  // A candidate that already exists is this phase's, recorded by an earlier
  // call that then stopped for a decision.
  submitTolerating(
    ["candidate-exists"],
    supervisor,
    input,
    // A retry is a different decision, so it needs a different command identity.
    // The attempt alone is not that decision: a candidate the authority refused
    // leaves the identity bound to the envelope it refused, and a corrected
    // candidate for the same attempt could then never be submitted at all.
    `gate-${phaseKey}-${attempt}-${String(candidate.candidateDigest).slice(0, 16)}`,
    "evaluate-gate",
    snapshot.graph.revisionDigest,
    candidate.candidateDigest,
    {
      phase: candidate.phase,
      phaseAttempt: candidate.phaseAttempt,
      inputBindingDigest: candidate.inputBindingDigest,
      requiredOutputPublications: candidate.requiredOutputPublications,
      outputSetDigest: candidate.outputSetDigest,
      dependencyBarrierDigest: candidate.dependencyBarrierDigest,
      gateDefinition: gate,
      readings,
    },
  );

  // The evidence is recorded before the refusal is reported, because an
  // escalation carries that evidence and there is nothing to escalate with
  // otherwise.
  if (evaluation !== undefined && evaluation.decision !== "accepted") {
    const reasons = refusalReasons(gate, evaluation, measured);
    const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
    if (phase.iteration?.onGateRejected === "iterate" && taskAttempts < maximumAttempts) {
      // The next attempt is told what the last one failed, because a retry that
      // is not told what to change only spends an attempt.
      const retried = dispatchAttempt({
        snapshot,
        dataflow,
        contextBroker: broker,
        sessionLedger: supervisor.commandAuthority,
        dependencies: input.dependencies,
        repositoryId: input.repositoryId,
        runId: input.runId,
        phaseKey,
        workflowInput: input.workflowInput,
        upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
        repositoryBase: input.repositoryBase,
        currentTime: input.currentTime,
        attempt: nextAttempt,
        ...retryMemberIndex,
        priorRefusals: reasons,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: nextAttempt,
        dispatchId: retried.dispatch.dispatchId,
        reasons,
      };
    }
    // Out of tries. A phase whose policy says escalate asks a person what to do
    // instead of stopping the run, and tells them what kept failing. Their
    // answer is carried into the next attempt and buys the ceiling back, so a
    // member nobody has spoken to and one somebody has redirected are not the
    // same member.
    if (phase.iteration?.onExhausted === "escalate") {
      const asked = askForHelp({
        broker,
        dispatch,
        phaseKey,
        reasons,
        tries: taskAttempts,
        currentTime: input.currentTime,
      });
      if (asked) return { kind: "escalated", phaseKey, reasons };
    }
    return { kind: "gate-refused", phaseKey, reasons };
  }

  // An authored approval is a human's to give. Submitting close-phase while one
  // is owed would cache a refusal against that command id and replay it after
  // the decision arrives, so the driver asks what the human is asked.
  if (requiresApproval(phase) && approvalPending(input)) {
    return { kind: "awaiting-approval", phaseKey };
  }

  const closed = submitTolerating(
    ["decision-required", "rejected-authority"],
    supervisor,
    input,
    `close-${phaseKey}-${attempt}`,
    "close-phase",
    snapshot.graph.revisionDigest,
    candidate.candidateDigest,
    {},
  );
  if (closed === "decision-required") {
    return { kind: "awaiting-approval", phaseKey };
  }
  if (closed === "rejected-authority") {
    // A person refused this candidate. Their reason is what the next attempt
    // has to act on, so it is read back rather than paraphrased.
    const reasons = rejectionReasons(input) ?? ["a person rejected this phase"];
    const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
    if (phase.iteration?.onApprovalRejected === "iterate" && taskAttempts < maximumAttempts) {
      const retried = dispatchAttempt({
        snapshot,
        dataflow,
        contextBroker: broker,
        sessionLedger: supervisor.commandAuthority,
        dependencies: input.dependencies,
        repositoryId: input.repositoryId,
        runId: input.runId,
        phaseKey,
        workflowInput: input.workflowInput,
        upstream: upstreamOutputs(snapshot, phase, state, assets(supervisor, broker)),
        repositoryBase: input.repositoryBase,
        currentTime: input.currentTime,
        attempt: nextAttempt,
        ...retryMemberIndex,
        priorRefusals: reasons,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: nextAttempt,
        dispatchId: retried.dispatch.dispatchId,
        reasons,
      };
    }
    return { kind: "rejected", phaseKey, reasons };
  }
  const next = nextPhase(snapshot, phaseKey);
  if (next === undefined) return { kind: "finished" };
  submit(
    supervisor,
    input,
    `advance-${next.key}`,
    "start-phase-attempt",
    snapshot.graph.revisionDigest,
    candidate.candidateDigest,
    {
      phaseId: next.id,
      definitionGeneration: next.generation,
    },
  );
  return { kind: "closed", phaseKey };
}

function requiresApproval(phase: SnapshotPhase): boolean {
  return phase.exit?.approval?.policy === "required";
}

/** The phase that becomes current once this one closes, in declaration order. */
function nextPhase(
  snapshot: ConfigurationSnapshot,
  closedKey: string,
): { readonly key: string; readonly id: string; readonly generation: number } | undefined {
  const keys = phaseSequence(snapshot);
  const following = keys[keys.indexOf(closedKey) + 1];
  if (following === undefined) return undefined;
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "phase" && candidate.definition.key === following,
  );
  if (node === undefined || node.kind !== "phase") return undefined;
  return { key: following, id: node.definition.id, generation: node.definition.generation };
}

/**
 * The phase keys in the order a sequential run reaches them.
 *
 * Both registries this could be read from are sorted for canonicalisation: the
 * dataflow registry by key, the graph by node id. Reading either one directly
 * runs the workflow in an order nobody authored, and a workflow whose last
 * phase alphabetically is also its first declares itself finished after one
 * phase. What survives canonicalisation is `dependsOn`, so the order is
 * recovered from it: a phase never precedes something it needs, and phases
 * that need nothing from each other keep the registry's stable key order.
 */
function phaseSequence(snapshot: ConfigurationSnapshot): readonly string[] {
  const remaining = snapshot.phaseDataflow.map((entry) => entry.value as unknown as SnapshotPhase);
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (remaining.length > 0) {
    const at = remaining.findIndex((phase) =>
      (phase.dependsOn ?? []).every((need) => placed.has(need) || !known(remaining, need)),
    );
    // A dependency cycle would leave every phase waiting. The compiler rejects
    // those, so take the head rather than loop forever if one ever arrives.
    const [phase] = remaining.splice(at < 0 ? 0 : at, 1);
    if (phase === undefined) break;
    ordered.push(phase.key);
    placed.add(phase.key);
  }
  return ordered;
}

function known(phases: readonly SnapshotPhase[], key: string): boolean {
  return phases.some((phase) => phase.key === key);
}

/** Runs the phase's sensors for real, so the gate rests on something executed. */
async function readGate(
  input: AdvanceRunInput,
  snapshot: ConfigurationSnapshot,
  gate: NonNullable<ReturnType<typeof gateFor>>,
) {
  const sensorKeys = [...new Set(gateSensorKeys(gate))].sort();
  if (sensorKeys.length === 0) return [];
  const result = await runSensors({
    snapshot,
    sensorKeys,
    rootDirectory: input.projectRoot,
    sha256: input.dependencies.sha256,
  });
  return result.readings;
}

/** Every sensor the gate reads, blocking and advisory alike. */
function gateSensorKeys(gate: NonNullable<ReturnType<typeof gateFor>>): readonly string[] {
  const rules = [...(gate.blocking ?? []), ...(gate.advisory ?? [])];
  return rules.map((rule) => String(rule.condition.accessor.sensorKey));
}

/** As much of a sensor's own words as a worker context will carry. */
const MAX_REFUSAL_EXCERPT = 900;

/**
 * Why the gate refused, in terms the next attempt can act on.
 *
 * A retry that is told "tests did not pass" only spends an attempt: it knows it
 * failed and nothing about what to change. The reading that refused it already
 * holds the sensor's own output, so the refusal carries that instead, along
 * with the rule that was not met. Passing sensors are left out; naming them as
 * reasons pointed the next attempt at work that was already right.
 */
function refusalReasons(
  gate: ReturnType<typeof gateFor>,
  evaluation: ReturnType<typeof evaluateGate>,
  measured: Awaited<ReturnType<typeof readGate>>,
): readonly string[] {
  const rules = new Map(
    [...(gate?.blocking ?? []), ...(gate?.advisory ?? [])].map((rule) => [String(rule.key), rule]),
  );
  const failed = evaluation.blocking.filter((rule) => rule.result !== "true");
  const reasons: string[] = [];
  for (const outcome of failed) {
    const rule = rules.get(String(outcome.key));
    const sensorKey = rule === undefined ? undefined : String(rule.condition.accessor.sensorKey);
    const reading = measured.find((entry) => String(entry.sensorKey) === sensorKey);
    reasons.push(unmetRule(outcome.key, rule, reading));
    const excerpt = sensorExcerpt(reading);
    if (excerpt !== undefined) reasons.push(`${sensorKey ?? "sensor"} said:\n${excerpt}`);
  }
  // A gate can refuse with no blocking rule named when the evaluation itself is
  // what went wrong. Saying nothing would leave the attempt with no reason at
  // all, which the context refuses to carry.
  if (reasons.length === 0) reasons.push("the phase gate refused this attempt");
  return reasons;
}

/** The rule that was not met, stated as the comparison it made. */
function unmetRule(
  key: unknown,
  rule: GateRule | undefined,
  reading: Awaited<ReturnType<typeof readGate>>[number] | undefined,
): string {
  if (rule === undefined) return `gate rule ${String(key)} was not met`;
  const pointer = rule.condition.accessor.pointer ?? "";
  const observed =
    reading === undefined || reading.outcome !== "succeeded"
      ? "nothing, because the sensor did not run"
      : JSON.stringify(readingValue(reading.data, pointer));
  return `${String(rule.condition.accessor.sensorKey)}${pointer} ${String(rule.condition.operator ?? "equals")} ${JSON.stringify(rule.condition.expected)}, and read ${observed}`;
}

/** The value a rule's pointer selects, without pulling in a JSON Pointer library. */
function readingValue(data: unknown, pointer: string): unknown {
  let current: unknown = data;
  for (const segment of pointer.split("/").filter((part) => part.length > 0)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[
      segment.replaceAll("~1", "/").replaceAll("~0", "~")
    ];
  }
  return current;
}

/** What the sensor printed, bounded to what a worker context will carry. */
function sensorExcerpt(
  reading: Awaited<ReturnType<typeof readGate>>[number] | undefined,
): string | undefined {
  if (reading === undefined) return undefined;
  if (reading.outcome !== "succeeded") {
    const error = reading.error as { readonly code?: unknown; readonly message?: unknown };
    return `${String(error?.code ?? "failed")}: ${String(error?.message ?? "")}`.slice(
      0,
      MAX_REFUSAL_EXCERPT,
    );
  }
  const data = reading.data as { readonly stdout?: unknown; readonly stderr?: unknown };
  const printed = [data.stdout, data.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  if (printed.length === 0) return undefined;
  // From the first thing that went wrong, not from the top. A test run that
  // passes ten cases before failing one puts nothing but successes in its first
  // nine hundred characters, and a retry was handed the part that was already
  // right.
  const failure = FAILURE_MARKERS.map((marker) => printed.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const from = failure === undefined ? 0 : Math.max(0, printed.lastIndexOf("\n", failure) + 1);
  return printed.slice(from, from + MAX_REFUSAL_EXCERPT);
}

/** Where a sensor's output starts saying what went wrong. */
const FAILURE_MARKERS = ["not ok ", "AssertionError", "FAIL", "Error:", "error:", "✗"];

function gateFor(
  snapshot: ConfigurationSnapshot,
  phase: SnapshotPhase,
  sha256: Sha256,
):
  | (Parameters<typeof evaluateGate>[0] & {
      readonly blocking?: readonly GateRule[];
      readonly advisory?: readonly GateRule[];
    })
  | undefined {
  const gateKey = phase.exit?.gate;
  // A phase may declare no gate. Every downstream record still expects gate
  // evidence, so an empty gate is the honest shape: nothing to satisfy, and
  // nothing pretending to have been checked.
  if (gateKey === undefined) {
    return defineGate(
      { advisory: [], blocking: [], key: `${phase.key}-open` } as never,
      sha256,
    ) as never;
  }
  const entry = snapshot.gates.find((candidate) => candidate.key === gateKey);
  if (entry === undefined) return undefined;
  return (entry.value as unknown as SnapshotGateValue).definition as never;
}

/**
 * Hands the broker's pending completion and output facts to the authority.
 *
 * The broker records what an agent submitted; the authority decides what it
 * means. Until a fact crosses that line the authority has no accepted task for
 * the phase, and evaluating a gate refuses with a task set mismatch.
 */
/**
 * The next ordinal no attempt of this phase holds.
 *
 * Opening the authority per call matches how the runner is read here, and the
 * alternative — inferring from dispatches — lands on ordinals a gate or a close
 * already spent.
 */
function nextPhaseAttemptOrdinal(
  input: AdvanceRunInput,
  phase: { readonly phaseId?: unknown; readonly definitionGeneration?: unknown },
): number {
  const phaseId = typeof phase.phaseId === "string" ? phase.phaseId : undefined;
  const generation =
    typeof phase.definitionGeneration === "number" ? phase.definitionGeneration : undefined;
  if (phaseId === undefined || generation === undefined) return 1;
  const authority = new SqliteAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  try {
    return authority.nextPhaseAttemptOrdinal({
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseId,
      definitionGeneration: generation,
    });
  } catch {
    return 1;
  } finally {
    authority.close();
  }
}

/**
 * Asks a person what to do about a member that has run out of tries.
 *
 * The question carries what kept failing, because "it failed six times" is not
 * something anybody can act on. It is raised once: a second identical question
 * would be a second thing to answer for one problem.
 *
 * Returns whether anybody now owes an answer, which is what makes this a wait
 * rather than a refusal.
 */
function askForHelp(input: {
  readonly broker: SqliteContextBroker;
  readonly dispatch: {
    readonly dispatchId: unknown;
    readonly repositoryId: unknown;
    readonly runId: unknown;
    readonly task: unknown;
    readonly contextId: unknown;
    readonly contextDigest: unknown;
    readonly worker: { readonly principalId: unknown };
  };
  readonly phaseKey: string;
  readonly reasons: readonly string[];
  readonly tries: number;
  readonly currentTime: string;
}): boolean {
  const dispatchId = String(input.dispatch.dispatchId);
  const progress = input.broker.loadWorkerDispatchProgress(dispatchId);
  const outstanding = (progress?.submissions ?? []).some(
    (entry) => (entry as { readonly type?: unknown }).type === "question",
  );
  if (outstanding) return true;
  // The prompt becomes a need's title, which is bounded, and a wall of test
  // output is not a title anyway. The ask is short and the reading travels
  // beside it, where the portal already shows a question's details.
  const excerpt = input.reasons.join("\n").replace(/\s+/gu, " ").slice(0, 600);
  const prompt =
    `${input.phaseKey} could not be finished in ${String(input.tries)} attempts. ` +
    `What should the agent do differently?\n\nWhat kept failing: ${excerpt}`;
  try {
    input.broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        submissionId: `submission_exhausted-${dispatchId.replace(/[^a-z0-9]/gu, "").slice(0, 48)}`,
        repositoryId: input.dispatch.repositoryId,
        runId: input.dispatch.runId,
        dispatchId: input.dispatch.dispatchId,
        task: input.dispatch.task,
        contextId: input.dispatch.contextId,
        contextDigest: input.dispatch.contextDigest,
        principalId: input.dispatch.worker.principalId,
        type: "question",
        question: { prompt, details: { attempts: input.tries, reasons: input.reasons } },
      },
    });
    return true;
  } catch {
    // A broker that will not take the question leaves the run refused, which is
    // the old behaviour and still says why.
    return false;
  }
}

/**
 * The attempt ordinals a person's answer has already covered for this task.
 *
 * A member that spends its attempts asks for help. An answer that bought it
 * nothing would be no answer at all, so the tries made before the answer stop
 * counting against the ceiling and the member gets its allowance again.
 */
function answeredAttemptOrdinals(
  supervisor: SqliteSupervisorAuthority,
  broker: SqliteContextBroker,
  input: AdvanceRunInput,
  taskId: string,
): readonly number[] {
  const answered = new Set(
    supervisor.commandAuthority
      .listAnsweredQuestions(input.repositoryId, input.runId)
      .filter((entry) => entry.taskId === taskId)
      .map((entry) => entry.submissionId),
  );
  if (answered.size === 0) return [];
  const ordinals: number[] = [];
  for (const stored of broker.listWorkerDispatches(input.repositoryId, input.runId)) {
    if (String(stored.dispatch.task.taskId) !== taskId) continue;
    const progress = broker.loadWorkerDispatchProgress(String(stored.dispatch.dispatchId));
    for (const submission of progress?.submissions ?? []) {
      const id = (submission as { readonly submissionId?: unknown }).submissionId;
      if (typeof id === "string" && answered.has(id)) ordinals.push(stored.dispatch.ordinal);
    }
  }
  return ordinals;
}

/**
 * Records the end of every turn that is over.
 *
 * An attempt opens when a dispatch is created and closes when the turn ends,
 * whether it handed work in, stopped to ask, or returned with nothing. Three
 * facts say a turn ended, and none of them is the whole story on its own: the
 * completion the agent handed in, the question it stopped on, and the runner's
 * outcome, which is the only record of a turn that ended empty.
 *
 * They are read here, once, and turned into the run's own record rather than
 * into a decision. Everything downstream asks the record. The driver used to
 * ask the effect log twice per advance, once for whether the turn had started
 * and once for whether it was spent, and the two answers could disagree: a
 * member could be both still working and already finished, which is how a task
 * ended up with two dispatches and a fan-in that waited for ever.
 */
function closeEndedAttempts(
  input: AdvanceRunInput,
  supervisor: SqliteSupervisorAuthority,
  snapshot: ConfigurationSnapshot,
  scheduling: RuntimeSchedulingSnapshot,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
): readonly RuntimeAttemptRecord[] {
  const ended = new Map<string, "closed" | "fail" | "suspended">();
  for (const entry of state.terminalCompletions) ended.set(String(entry.dispatchId), "closed");
  // An agent that asks is waiting for a person, and the answer reaches it on a
  // fresh dispatch. That turn is over even though the agent is well, and saying
  // so is what lets the resuming dispatch open an attempt at all.
  //
  // It is recorded as suspended rather than closed because it is not a try. A
  // live run stopped at `research` after eight turns, every one of them ending
  // by asking a person, and was rejected for handing no work in: the only
  // record that a turn had asked was whether its question was still
  // outstanding, so answering it converted a suspended turn into a spent
  // attempt. What a turn did does not change when somebody answers.
  for (const question of state.questions) {
    const held = String(question.dispatchId);
    if (!ended.has(held)) ended.set(held, "suspended");
  }
  for (const dispatchId of returnedDispatchIds(input)) {
    if (!ended.has(dispatchId)) ended.set(dispatchId, "fail");
  }
  // An accepted task has nothing left for an agent to hand in, so an attempt
  // still open on one cannot be waited on. A dispatch made for a task that was
  // already accepted never runs, so no effect ever returns for it and nothing
  // else here would ever close it: the phase waits on an agent that was never
  // started, and the one-agent rule then refuses the dispatch that would
  // replace it.
  const accepted = new Set(scheduling.acceptedTasks.map(({ task }) => String(task.taskId)));
  for (const dispatch of state.dispatches) {
    if (dispatch.runId !== input.runId) continue;
    if (!accepted.has(String(dispatch.task.taskId))) continue;
    const dispatchId = String(dispatch.dispatchId);
    if (!ended.has(dispatchId)) ended.set(dispatchId, "closed");
  }
  if (ended.size === 0) return scheduling.attempts;
  const recorded = new Map(scheduling.attempts.map((entry) => [entry.attemptDigest, entry]));
  let closed = false;
  for (const [dispatchId, disposition] of ended) {
    // A closure is recorded for a turn whose opening was not, because the
    // opening is the driver's to record and the ending is the run's. A dispatch
    // made by `senawa start`, which runs in its own process before any driver
    // exists, has no opened attempt, and refusing to close it left the phase
    // waiting on a turn that was already over.
    const held = recorded.get(attemptDigestOf(input, dispatchId));
    if (held !== undefined && held.disposition !== "opened") continue;
    const dispatch = state.dispatches.find(
      (candidate) => String(candidate.dispatchId) === dispatchId,
    );
    if (dispatch === undefined) continue;
    recordAttempt(supervisor, input, snapshot.graph.revisionDigest, {
      dispatchId,
      taskId: String(dispatch.task.taskId),
      definitionGeneration: Number(dispatch.task.definitionGeneration),
      disposition,
    });
    closed = true;
  }
  if (!closed) return scheduling.attempts;
  return (
    supervisor.commandAuthority.queryRunScheduling(input.repositoryId, input.runId)?.attempts ??
    scheduling.attempts
  );
}

/** The dispatches the runner has seen an agent return from, handed in or not. */
function returnedDispatchIds(input: AdvanceRunInput): readonly string[] {
  const runner = new SqliteRunnerAuthority({
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    return runner
      .load({ repositoryId: input.repositoryId, runId: input.runId })
      .effects.flatMap((effect) => {
        const outcome = effect.outcome;
        if (outcome === undefined || outcome.status === "active" || outcome.status === "unknown") {
          return [];
        }
        const details = outcome.details as { readonly dispatchId?: unknown } | undefined;
        return details?.dispatchId === undefined ? [] : [String(details.dispatchId)];
      });
  } catch {
    // A run whose work never went through the runner has no effect to read, so
    // nothing has returned that way.
    return [];
  } finally {
    runner.close();
  }
}

/** The identity of the attempt a dispatch is, derived from the dispatch itself. */
function attemptDigestOf(input: AdvanceRunInput, dispatchId: string): string {
  return input.dependencies.sha256.digest(canonicalBytes(canonicalValue({ dispatchId })));
}

function deliverFacts(
  input: AdvanceRunInput,
  supervisor: SqliteSupervisorAuthority,
  broker: SqliteContextBroker,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  dispatchIds: ReadonlySet<string>,
): void {
  for (const entry of state.completionOutbox) {
    if (!dispatchIds.has(String(entry.fact.dispatchId))) continue;
    // A fact the outbox has already handed over needs no second offer. The
    // outbox keeps entries after delivery, so reading all of it every cycle
    // re-submitted every completion the phase had ever accepted, for as long as
    // the run lived. That is harmless only while the envelope stays identical:
    // the identity is derived from the payload, and the expected graph revision
    // is read fresh, so the moment an amendment moved the graph the same
    // identity carried different content and the authority refused it for
    // conflicting with itself. The run then stopped driving for good.
    if (entry.delivered) continue;
    const stored = broker.loadWorkerDispatch(entry.fact.dispatchId);
    // Skipping this quietly leaves the phase permanently short of the evidence
    // it needs to close, and the run merely looks slow.
    if (stored === undefined)
      throw new Error(
        `Completion ${entry.submissionId} names dispatch ${String(entry.fact.dispatchId)}, which the broker does not hold`,
      );
    try {
      submit(
        supervisor,
        input,
        `completion-${entry.submissionId.replace("submission_", "").slice(0, 20)}`,
        "submit-completion",
        String(stored.context.graphRevisionDigest),
        undefined,
        { submission: entry.fact.assessment.submission },
        String(entry.fact.assessment.submission.task.contextRevisionDigest),
      );
    } catch (error) {
      // The completion bridge queues its own submit-completion the moment a
      // worker hands in, so the authority may already hold this one. Anything
      // else is a refusal the phase has to stop on.
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("completion-exists")) throw error;
    }
    broker.deliverCompletionFact(entry.submissionId);
  }
}

/**
 * Turns a computed collection into the member tasks a fan-out phase runs.
 *
 * Members are not in the compiled graph, because the collection is not known
 * until the phase before produces it. The engine may decide the resulting
 * proposal because its source is a plan import, which the author declared by
 * writing `forEach`.
 */
function materialiseMembers(
  input: AdvanceRunInput,
  snapshot: ConfigurationSnapshot,
  supervisor: SqliteSupervisorAuthority,
  phaseKey: string,
  phase: SnapshotPhase,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  assets: CanonicalJsonAssetPort,
): AdvanceOutcome {
  const upstream = upstreamOutputs(snapshot, phase, state, assets)[0];
  if (upstream === undefined) return { kind: "awaiting-agent", phaseKey };

  const { evaluation, proposal, resultSnapshot } = planFanOut({
    snapshot,
    dependencies: input.dependencies,
    repositoryId: input.repositoryId,
    runId: input.runId,
    phaseKey,
    source: { value: upstream.value, acceptanceDigest: upstream.acceptanceDigest },
    attemptDigest: upstream.bindingDigest,
  });
  if (evaluation.members.length === 0) return { kind: "closed", phaseKey };

  // Applying the amendment reads the result snapshot back, so it has to be
  // stored before the proposal names its digest.
  supervisor.commandAuthority.putConfigurationSnapshot(resultSnapshot);
  const suffix = String(proposal.proposalDigest).slice(0, 20);
  submit(
    supervisor,
    input,
    `fanout-propose-${suffix}`,
    "submit-amendment-proposal",
    snapshot.graph.revisionDigest,
    proposal.proposalDigest,
    { proposal },
  );
  submit(
    supervisor,
    input,
    `fanout-decide-${suffix}`,
    "record-amendment-decision",
    snapshot.graph.revisionDigest,
    proposal.proposalDigest,
    {
      amendmentId: proposal.amendmentId,
      proposalDigest: proposal.proposalDigest,
      decision: "approve",
      reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
    },
  );
  const recovery = supervisor
    .listApprovedAmendmentRecoveries()
    .find((entry) => entry.amendmentId === proposal.amendmentId);
  if (recovery === undefined || !recovery.observedQuiescent) {
    return { kind: "awaiting-agent", phaseKey };
  }
  // Applying is mechanical once a decision exists and the affected scopes are
  // quiescent, which is what the trusted-supervisor role means. The driver is
  // the supervisor here, because no daemon need be running to advance a run.
  submit(
    supervisor,
    { ...input, principal: TRUSTED_SUPERVISOR },
    `fanout-apply-${suffix}`,
    "apply-approved-amendment",
    recovery.baseGraphRevisionDigest,
    recovery.decisionDigest,
    {
      amendmentId: recovery.amendmentId,
      proposalDigest: recovery.proposalDigest,
      decisionDigest: recovery.decisionDigest,
      reviewedResultGraphRevisionDigest: recovery.reviewedResultGraphRevisionDigest,
    },
  );
  return { kind: "fanned-out", phaseKey, members: evaluation.members.length };
}

/** True when a person still owes this run a decision. */
function approvalPending(input: AdvanceRunInput): boolean {
  const portal = new SqlitePortalQueryAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  try {
    return portal
      .listHumanNeeds(input.repositoryId, input.runId)
      .needs.some((need: { readonly kind: string }) => need.kind === "candidate-approval");
  } finally {
    portal.close();
  }
}

/**
 * The reason a person gave when they rejected this phase.
 *
 * A rejection must carry one and it is bound into the decision digest, so it is
 * read back from the record rather than reconstructed by the driver.
 */
function rejectionReasons(input: AdvanceRunInput): readonly string[] | undefined {
  const authority = new SqliteAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  try {
    const recorded = JSON.stringify(authority.queryReceiptHistory(input.repositoryId, input.runId));
    const reasons = [...recorded.matchAll(/"reason":"((?:[^"\\]|\\.)*)"/gu)]
      .map(([, reason]) => JSON.parse(`"${reason ?? ""}"`) as string)
      .filter((reason) => reason.length > 0);
    const last = reasons[reasons.length - 1];
    return last === undefined ? undefined : Object.freeze([last]);
  } finally {
    authority.close();
  }
}

/** Submits a command, returning the refusal code for outcomes the caller expects. */
function submitTolerating(
  tolerated: readonly string[],
  supervisor: SqliteSupervisorAuthority,
  input: AdvanceRunInput,
  suffix: string,
  intent: string,
  graphRevision: string,
  exactObjectDigest: string | undefined,
  payload: unknown,
): string | undefined {
  try {
    submit(supervisor, input, suffix, intent, graphRevision, exactObjectDigest, payload);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const matched = tolerated.find((code) => message.includes(code));
    if (matched === undefined) throw error;
    return matched;
  }
}

/** Submits one command and refuses to continue when the authority did not accept it. */
/**
 * Opens or closes the attempt a dispatch is, against the task it is for.
 *
 * The authority refuses a second open attempt for a task, so this is where the
 * one-agent rule stops being a thing the driver remembers and starts being a
 * thing the run records.
 */
function recordAttempt(
  supervisor: SqliteSupervisorAuthority,
  input: AdvanceRunInput,
  graphRevision: string,
  attempt: {
    readonly dispatchId: string;
    readonly taskId: string;
    readonly definitionGeneration: number;
    readonly disposition: "opened" | "closed" | "fail" | "suspended" | "refused";
  },
): void {
  const attemptDigest = attemptDigestOf(input, attempt.dispatchId);
  submit(
    supervisor,
    input,
    `attempt-${attempt.disposition}`,
    "record-phase-attempt-transition",
    graphRevision,
    undefined,
    {
      attemptDigest,
      transitionDigest: input.dependencies.sha256.digest(
        canonicalBytes(canonicalValue({ dispatchId: attempt.dispatchId, of: attempt.disposition })),
      ),
      triggerDigest: input.dependencies.sha256.digest(
        canonicalBytes(canonicalValue({ runId: input.runId, of: attempt.disposition })),
      ),
      taskId: attempt.taskId,
      definitionGeneration: attempt.definitionGeneration,
      disposition: attempt.disposition,
    },
  );
}

function submit(
  supervisor: SqliteSupervisorAuthority,
  input: AdvanceRunInput,
  suffix: string,
  intent: string,
  graphRevision: string,
  exactObjectDigest: string | undefined,
  payload: unknown,
  expectedDefinitionRevision?: string,
): DurableReceipt {
  refuseUncanonicalPayload(intent, payload);
  const payloadDigest = input.dependencies.sha256.digest(canonicalBytes(canonicalValue(payload)));
  // The identity carries what the command says, not only which step said it.
  // Keyed on the step alone, a phase that ran twice produced two different
  // decisions under one identity, and the authority refused the second for
  // conflicting with the first. Replay still works: the same decision digests
  // the same and is recognised as the command already recorded.
  const commandId = `command_${suffix}-${input.dependencies.sha256
    .digest(canonicalBytes(canonicalValue({ runId: input.runId, suffix, payloadDigest })))
    .slice(0, 24)}`;
  let allocation = 0;
  const receipt = supervisor.commandAuthority.submit(
    decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: input.principal,
      transport: { kind: "cli", requestId: `request_${commandId}` },
      repositoryId: input.repositoryId,
      runId: input.runId,
      intent: { type: intent },
      payload: payload as never,
      payloadDigest,
      expectedGraphRevision: graphRevision,
      ...(exactObjectDigest === undefined ? {} : { exactObjectDigest }),
      ...(expectedDefinitionRevision === undefined ? {} : { expectedDefinitionRevision }),
    } as never),
    {
      currentTime: input.currentTime,
      facts: { source: "advance-run" },
      // Identities must be globally unique, so they carry the command they serve.
      // The separator is an underscore because that is the prefix form every
      // allocated identity is validated against.
      allocateId: (kind: string) => {
        allocation += 1;
        return `${kind}_${commandId.slice(8).toLowerCase()}${allocation}`;
      },
    },
  );
  // A driver that reports progress the authority refused is worse than one that stops.
  if (receipt.status !== "completed") {
    // The code alone names a category. The message names what was wrong, which
    // is what a person reading a stopped run needs.
    throw new Error(
      `${intent} was ${receipt.status}${
        receipt.error === undefined ? "" : `: ${receipt.error.code}: ${receipt.error.message ?? ""}`
      }`,
    );
  }
  return receipt;
}

/**
 * The tasks the phase owns that a candidate has to cover, read the way the
 * kernel reads them: every direct task of the phase that nothing supersedes,
 * in task-id order.
 */
function activePhaseTaskIds(snapshot: ConfigurationSnapshot, phaseKey: string): readonly string[] {
  const tasks = phaseTasks(snapshot, phaseKey) as readonly {
    readonly definition: { readonly id: string; readonly supersedes?: readonly string[] };
  }[];
  const superseded = new Set(tasks.flatMap((task) => task.definition.supersedes ?? []));
  return tasks
    .map((task) => task.definition.id)
    .filter((id) => !superseded.has(id))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Whether the tasks a candidate carries cover the phase exactly.
 *
 * The kernel compares the candidate's task set against every active direct task
 * of the phase, in task-id order, and refuses anything else.
 */
function coversEveryActiveTask(
  snapshot: ConfigurationSnapshot,
  phaseKey: string,
  tasks: readonly TaskGenerationReference[],
): boolean {
  const active = activePhaseTaskIds(snapshot, phaseKey);
  return (
    tasks.length === active.length &&
    active.every((id, index) => String(tasks[index]?.taskId) === id)
  );
}

/**
 * The tasks the authority has accepted completion facts for, narrowed to this
 * phase and ordered the way the kernel compares them.
 */
function acceptedPhaseTasks(
  scheduling: { readonly acceptedTasks: readonly { readonly task: TaskGenerationReference }[] },
  snapshot: ConfigurationSnapshot,
  phaseKey: string,
): readonly TaskGenerationReference[] {
  return scheduling.acceptedTasks
    .map(({ task }) => task)
    .filter((task) => phaseKeyByTask(snapshot, String(task.taskId)) === phaseKey)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
}

/**
 * The latest dispatch of each task the phase owns.
 *
 * A task attempted more than once has a dispatch per attempt. The candidate
 * selects a set of tasks and the evidence closing it must belong to the same
 * generation, so every earlier attempt is history: counting them made a
 * retried phase select one task twice, and then refuse its own candidate for
 * carrying an assessment from a context it no longer names.
 */
export function currentPhaseDispatches(
  snapshot: ConfigurationSnapshot,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  runId: string,
  phaseKey: string,
  /**
   * Tasks the run has already accepted. A later dispatch on one of these is not
   * a retry, because an accepted task is owed nothing, and letting it supersede
   * hides the dispatch that earned the acceptance -- along with its completion
   * and its assessment. A live run made a tenth dispatch for an accepted member
   * and then waited for its agent for ever, could not close because the real
   * completion was filtered out of the candidate, and never delivered the fact
   * that would have closed it. One substitution, three symptoms.
   */
  accepted: ReadonlySet<string> = new Set(),
): readonly ReturnType<SqliteContextBroker["authority"]["snapshot"]>["dispatches"][number][] {
  const handedIn = new Set(state.completionOutbox.map((entry) => String(entry.fact.dispatchId)));
  const byTask = new Map<
    string,
    ReturnType<SqliteContextBroker["authority"]["snapshot"]>["dispatches"][number]
  >();
  for (const candidate of state.dispatches) {
    if (candidate.runId !== runId) continue;
    if (phaseKeyByTask(snapshot, candidate.task.taskId) !== phaseKey) continue;
    const key = String(candidate.task.taskId);
    const held = byTask.get(key);
    if (held === undefined) {
      byTask.set(key, candidate);
      continue;
    }
    // A retry supersedes on ordinal alone, because a fresh dispatch with no
    // completion yet is exactly what the phase is now waiting on.
    if (!accepted.has(key)) {
      if (candidate.ordinal >= held.ordinal) byTask.set(key, candidate);
      continue;
    }
    const candidateHandedIn = handedIn.has(String(candidate.dispatchId));
    if (candidateHandedIn === handedIn.has(String(held.dispatchId))) {
      if (candidate.ordinal >= held.ordinal) byTask.set(key, candidate);
    } else if (candidateHandedIn) {
      byTask.set(key, candidate);
    }
  }
  return [...byTask.values()];
}

/**
 * Where a task sits among the phase's members, so a retry re-runs that member.
 *
 * The dispatch driver takes `phaseTasks[memberIndex ?? 0]`, and both retry
 * paths used to pass nothing: every retry in a fan-out re-ran the first member
 * whatever had actually failed. When that member was already accepted the retry
 * became a dispatch for finished work, which is the shadow that deadlocked two
 * live runs -- both of them on the first member, which is the tell.
 */
function memberIndexOf(
  snapshot: ConfigurationSnapshot,
  phaseKey: string,
  taskId: string,
): number | undefined {
  const index = phaseTasks(snapshot, phaseKey).findIndex(
    (candidate) =>
      String((candidate as { readonly definition: { readonly id: unknown } }).definition.id) ===
      taskId,
  );
  return index < 0 ? undefined : index;
}

function phaseValue(snapshot: ConfigurationSnapshot, key: string): SnapshotPhase {
  const entry = snapshot.phaseDataflow.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`Workflow declares no phase ${key}`);
  return entry.value as unknown as SnapshotPhase;
}

/** The tasks the compiled graph declares under a phase. */
function phaseTasks(snapshot: ConfigurationSnapshot, phaseKey: string): readonly unknown[] {
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "phase" && String(candidate.definition.key) === phaseKey,
  );
  if (node === undefined || node.kind !== "phase") return [];
  return snapshot.graph.nodes.filter(
    (candidate) =>
      candidate.kind === "task" && candidate.definition.parentId === node.definition.id,
  );
}

function phaseKeyById(snapshot: ConfigurationSnapshot, phaseId: string): string | undefined {
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "phase" && candidate.definition.id === phaseId,
  );
  return node === undefined || node.kind !== "phase" ? undefined : node.definition.key;
}

function phaseKeyByTask(snapshot: ConfigurationSnapshot, taskId: string): string | undefined {
  const task = snapshot.graph.nodes.find(
    (node) => node.kind === "task" && node.definition.id === taskId,
  );
  if (task === undefined || task.kind !== "task") return undefined;
  return phaseKeyById(snapshot, task.definition.parentId ?? "");
}

/** The accepted upstream outputs this phase reads, in declaration order. */
function upstreamOutputs(
  snapshot: ConfigurationSnapshot,
  phase: SnapshotPhase,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  assets: CanonicalJsonAssetPort,
): readonly {
  readonly phase: string;
  readonly output: string;
  readonly bindingDigest: Sha256Digest;
  readonly acceptanceDigest: Sha256Digest;
  readonly value: CanonicalValue;
}[] {
  const wanted = new Set(phase.dependsOn ?? []);
  if (wanted.size === 0) return [];
  const found = new Map<
    string,
    {
      phase: string;
      output: string;
      attempt: number;
      bindingDigest: Sha256Digest;
      acceptanceDigest: Sha256Digest;
      value: CanonicalValue;
    }
  >();
  for (const entry of state.phaseOutputOutbox) {
    const producing = phaseKeyById(snapshot, entry.fact.output.phase.phaseId);
    if (producing === undefined || !wanted.has(producing)) continue;
    const contentDigest = sha256Digest(String(entry.fact.output.contentDigest));
    // The stored bytes, not a placeholder. A phase that reads an upstream output
    // has to read what the agent actually produced.
    const value = assets.load(contentDigest);
    if (value === undefined) continue;
    const output = String(entry.fact.output.outputName);
    const attempt = Number(entry.fact.output.phase.attempt ?? 0);
    const key = `${producing}\u0000${output}`;
    // Every attempt that produced output leaves a publication behind, and an
    // upstream phase that was asked a question or refused once has more than
    // one. Handing all of them to the binder made two bindings for a single
    // source, and the phase downstream could never be dispatched again. The
    // phase closes on its current attempt, so the highest is the accepted one.
    const seen = found.get(key);
    if (seen !== undefined && seen.attempt >= attempt) continue;
    found.set(key, {
      phase: producing,
      output,
      attempt,
      bindingDigest: contentDigest,
      acceptanceDigest: sha256Digest(String(entry.fact.output.validationReceiptDigest)),
      value,
    });
  }
  return [...found.values()].map(({ attempt: _attempt, ...binding }) => binding);
}

/**
 * Names the field a payload cannot canonicalise on.
 *
 * `canonicalValue` refuses the whole object without saying which part offended,
 * which turns a one-field mistake into a hunt through the entire submission.
 */
function refuseUncanonicalPayload(intent: string, payload: unknown): void {
  try {
    canonicalValue(payload);
    return;
  } catch {
    // Fall through to locate the offending path.
  }
  const locate = (value: unknown, path: string): string => {
    if (value === null || typeof value !== "object") return path;
    for (const [key, entry] of Object.entries(value)) {
      try {
        canonicalValue(entry as never);
      } catch {
        return locate(entry, `${path}.${key}`);
      }
    }
    return path;
  };
  throw new TypeError(`Cannot submit ${intent}: ${locate(payload, "payload")} is not canonical`);
}

/** The dispatch ids belonging to one phase, including every fan-out member. */
function phaseDispatchIdsOf(
  snapshot: ConfigurationSnapshot,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  runId: string,
  phaseKey: string,
): ReadonlySet<string> {
  return new Set(
    state.dispatches
      .filter(
        (candidate) =>
          candidate.runId === runId && phaseKeyByTask(snapshot, candidate.task.taskId) === phaseKey,
      )
      .map((candidate) => String(candidate.dispatchId)),
  );
}

/** What the run does when a piece of work reports it could not be finished. */
function executionFailurePolicy(snapshot: ConfigurationSnapshot): string {
  const execution = (snapshot as unknown as { readonly execution?: Record<string, unknown> })
    .execution;
  return String(execution?.failurePolicy ?? "continue");
}

/**
 * Reads a phase output whether the run installed it or a worker staged it.
 *
 * A worker that runs in its own process hands its output bytes to the broker
 * rather than to the run's asset store. Reading only the store means every
 * output a real agent published looks like a missing asset.
 */
function assets(supervisor: SqliteSupervisorAuthority, broker: SqliteContextBroker) {
  const store = new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority);
  return Object.freeze({
    install: (value: CanonicalValue) => store.install(value),
    load(contentDigest: Sha256Digest): CanonicalValue | undefined {
      const installed = store.load(contentDigest);
      if (installed !== undefined) return installed;
      const bytes = broker.loadCanonicalOutputBytes(String(contentDigest));
      if (bytes === undefined) return undefined;
      // Reading a staged output installs it. A publication references the run's
      // own asset, so leaving it staged would satisfy the read and then fail the
      // reference it was read for.
      const value = canonicalValue(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      store.install(value);
      return value;
    },
  });
}
