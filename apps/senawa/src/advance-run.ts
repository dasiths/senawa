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
import type { CanonicalJsonAssetPort } from "@senawa/runtime";
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
  | { readonly kind: "awaiting-agent"; readonly phaseKey: string }
  | { readonly kind: "awaiting-approval"; readonly phaseKey: string }
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
  };
  readonly exit?: {
    readonly gate?: string;
    readonly approval?: { readonly policy?: string };
  };
}

interface GateRule {
  readonly condition: { readonly accessor: { readonly sensorKey: string } };
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
    throw new Error(`Workflow does not compile: ${loaded.diagnostics.length} diagnostics`);
  }
  const supervisor = new SqliteSupervisorAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  const broker = new SqliteContextBroker({
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
    broker.close();
    supervisor.close();
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
  const phase = phaseValue(snapshot, phaseKey);

  const state = broker.authority.snapshot();

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
    const dispatched = dispatchPhase({
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
  const dispatch = state.dispatches
    .filter(
      (candidate) =>
        candidate.runId === input.runId &&
        phaseKeyByTask(snapshot, candidate.task.taskId) === phaseKey,
    )
    .sort((left, right) => left.ordinal - right.ordinal)
    .at(-1);

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
    const dispatched = dispatchPhase({
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
  const completed = state.terminalCompletions.some((entry) => entry.dispatchId === dispatchId);
  const published = state.phaseOutputOutbox.filter((entry) => entry.fact.dispatchId === dispatchId);

  // A person who asked for the attempt to start again is not waiting for the
  // agent to finish first: that is the whole point of asking. The instruction is
  // already recorded, so the retry can carry it even though the abandoned turn
  // never reported anything.
  const attempt = dispatch.ordinal;
  const steerings = supervisor.commandAuthority.listAgentSteerings(dispatchId);
  const abort = steerings.filter((entry) => entry.delivery === "abort-retry");
  if (!completed && abort.length > 0) {
    const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
    if (attempt < maximumAttempts) {
      const instructions = abort.map((entry) => entry.instruction);
      const retried = dispatchPhase({
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
        attempt: attempt + 1,
        priorRefusals: instructions,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: attempt + 1,
        dispatchId: retried.dispatch.dispatchId,
        reasons: instructions,
      };
    }
  }

  // An answered question is only half an answer. The agent that asked cannot
  // read the database, so the answer reaches it by being carried into a fresh
  // dispatch, and the requirement that stopped the run is satisfied by that
  // dispatch rather than by the answer being written down.
  const answered = supervisor.commandAuthority
    .listAnsweredQuestions(input.repositoryId, input.runId)
    .filter((entry) => entry.taskId === String(dispatch.task.taskId));
  if (answered.length > 0) {
    // A member owns its own task, so the fresh dispatch has to name the same
    // member rather than the phase's first.
    const member = members.findIndex(
      (task) =>
        String((task as { readonly definition: { readonly id: unknown } }).definition.id) ===
        String(dispatch.task.taskId),
    );
    const resumed = dispatchPhase({
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
      attempt: attempt + 1,
      memberIndex: member < 0 ? 0 : member,
      answeredQuestions: answered.map(({ question, answer }) => ({ question, answer })),
    });
    for (const entry of answered) {
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
    // A dispatch that ended without handing anything in is a spent attempt, not
    // work still in progress. Reporting it as awaiting the agent waits for a
    // turn that is already over, which stalls the run until a person notices.
    if (!asked && spentDispatch(input, dispatchId)) {
      const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
      if (attempt < maximumAttempts) {
        const retried = dispatchPhase({
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
          attempt: attempt + 1,
          priorRefusals: [
            "Your previous turn ended without submitting a completion, so this is a fresh attempt. This is not a refusal of anything you sent.",
          ],
        });
        return {
          kind: "retrying",
          phaseKey,
          attempt: attempt + 1,
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
    return { kind: "awaiting-agent", phaseKey };
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
    currentPhaseDispatches(snapshot, state, input.runId, phaseKey).map((candidate) =>
      String(candidate.dispatchId),
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
  const measured = gate === undefined ? [] : await readGate(input, snapshot, gate);
  // The candidate must cover every active task the phase owns, not only the one
  // this dispatch carried.
  const tasks = dispatchedPhaseTasks(snapshot, state, input.runId, phaseKey);

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
    const reasons = readings.map((reading) => `${String(reading.sensorKey)} did not pass`);
    const maximumAttempts = phase.iteration?.maximumAttempts ?? 1;
    if (phase.iteration?.onGateRejected === "iterate" && attempt < maximumAttempts) {
      // The next attempt is told what the last one failed, because a retry that
      // is not told what to change only spends an attempt.
      const retried = dispatchPhase({
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
        attempt: attempt + 1,
        priorRefusals: reasons,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: attempt + 1,
        dispatchId: retried.dispatch.dispatchId,
        reasons,
      };
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
    if (phase.iteration?.onApprovalRejected === "iterate" && attempt < maximumAttempts) {
      const retried = dispatchPhase({
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
        attempt: attempt + 1,
        priorRefusals: reasons,
      });
      return {
        kind: "retrying",
        phaseKey,
        attempt: attempt + 1,
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
 * Whether the dispatch's turn is over with nothing handed in.
 *
 * The runner records the outcome of the effect that ran the agent. Only that
 * record distinguishes a turn still running from one that ended empty, and the
 * context broker never learns the difference because an empty turn writes
 * nothing to it.
 */
function spentDispatch(input: AdvanceRunInput, dispatchId: string): boolean {
  const runner = new SqliteRunnerAuthority({
    databasePath: input.databasePath,
    dependencies: input.dependencies,
  });
  try {
    return runner
      .load({ repositoryId: input.repositoryId, runId: input.runId })
      .effects.some((effect) => {
        const outcome = effect.outcome;
        if (outcome === undefined || outcome.status === "active" || outcome.status === "unknown") {
          return false;
        }
        const details = outcome.details as { readonly dispatchId?: unknown } | undefined;
        return String(details?.dispatchId) === dispatchId && outcome.status !== "completed";
      });
  } catch {
    // A run whose work never went through the runner has no effect to read, so
    // there is nothing saying this turn is over.
    return false;
  } finally {
    runner.close();
  }
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
    const stored = broker.loadWorkerDispatch(entry.fact.dispatchId);
    if (stored === undefined) continue;
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
 * Every task the phase has dispatched, in the order the candidate expects.
 *
 * The candidate must cover the phase's active tasks exactly. Their context
 * revision is known only to the dispatch, so the set is read from dispatches
 * rather than rebuilt from the graph.
 */
function dispatchedPhaseTasks(
  snapshot: ConfigurationSnapshot,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  runId: string,
  phaseKey: string,
): readonly TaskGenerationReference[] {
  return currentPhaseDispatches(snapshot, state, runId, phaseKey)
    .map((candidate) => candidate.task)
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
function currentPhaseDispatches(
  snapshot: ConfigurationSnapshot,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  runId: string,
  phaseKey: string,
): readonly ReturnType<SqliteContextBroker["authority"]["snapshot"]>["dispatches"][number][] {
  const byTask = new Map<
    string,
    ReturnType<SqliteContextBroker["authority"]["snapshot"]>["dispatches"][number]
  >();
  for (const candidate of state.dispatches) {
    if (candidate.runId !== runId) continue;
    if (phaseKeyByTask(snapshot, candidate.task.taskId) !== phaseKey) continue;
    const key = String(candidate.task.taskId);
    const held = byTask.get(key);
    if (held === undefined || candidate.ordinal >= held.ordinal) byTask.set(key, candidate);
  }
  return [...byTask.values()];
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
  const found: {
    phase: string;
    output: string;
    bindingDigest: Sha256Digest;
    acceptanceDigest: Sha256Digest;
    value: CanonicalValue;
  }[] = [];
  for (const entry of state.phaseOutputOutbox) {
    const producing = phaseKeyById(snapshot, entry.fact.output.phase.phaseId);
    if (producing === undefined || !wanted.has(producing)) continue;
    const contentDigest = sha256Digest(String(entry.fact.output.contentDigest));
    // The stored bytes, not a placeholder. A phase that reads an upstream output
    // has to read what the agent actually produced.
    const value = assets.load(contentDigest);
    if (value === undefined) continue;
    found.push({
      phase: producing,
      output: String(entry.fact.output.outputName),
      bindingDigest: contentDigest,
      acceptanceDigest: sha256Digest(String(entry.fact.output.validationReceiptDigest)),
      value,
    });
  }
  return found;
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
