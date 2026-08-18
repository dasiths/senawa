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
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { RuntimeDataflowAuthority, type RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
} from "@senawa/storage-sqlite";
import { SqliteSupervisorAuthority } from "@senawa/supervisor";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import { dispatchPhase } from "./dispatch-driver.js";

/** What the driver did, and what it is now waiting for. */
export type AdvanceOutcome =
  | { readonly kind: "dispatched"; readonly phaseKey: string; readonly dispatchId: string }
  | { readonly kind: "awaiting-agent"; readonly phaseKey: string }
  | { readonly kind: "awaiting-approval"; readonly phaseKey: string }
  | {
      readonly kind: "gate-refused";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "output-refused";
      readonly phaseKey: string;
      readonly reasons: readonly string[];
    }
  | { readonly kind: "closed"; readonly phaseKey: string }
  | { readonly kind: "finished" };

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
  readonly outputs: readonly { readonly key: string }[];
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
    return await step(input, loaded.snapshot, supervisor, broker);
  } finally {
    broker.close();
    supervisor.close();
  }
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
  const dispatch = state.dispatches.find(
    (candidate) =>
      candidate.runId === input.runId &&
      phaseKeyByTask(snapshot, candidate.task.taskId) === phaseKey,
  );

  const dataflow = new RuntimeDataflowAuthority(
    input.dependencies.sha256,
    configurationRuntimeSchemaValidator(),
    new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority),
    supervisor.commandAuthority,
  );

  if (dispatch === undefined) {
    const dispatched = dispatchPhase({
      snapshot,
      dataflow,
      contextBroker: broker,
      dependencies: input.dependencies,
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      workflowInput: input.workflowInput,
      upstream: upstreamOutputs(snapshot, phase, state),
      repositoryBase: input.repositoryBase,
      currentTime: input.currentTime,
    });
    return { kind: "dispatched", phaseKey, dispatchId: dispatched.dispatch.dispatchId };
  }

  const dispatchId = dispatch.dispatchId;
  const completed = state.terminalCompletions.some((entry) => entry.dispatchId === dispatchId);
  const published = state.phaseOutputOutbox.filter((entry) => entry.fact.dispatchId === dispatchId);
  if (!completed || published.length === 0) return { kind: "awaiting-agent", phaseKey };

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
  const assessments = state.completionOutbox
    .filter((entry) => entry.fact.dispatchId === dispatchId)
    .map((entry) => ({
      assessment: entry.fact.assessment,
      assessmentDigest: digestAccountingAssessment(
        entry.fact.assessment,
        input.dependencies.sha256,
      ),
    }));

  // The authority derives the phase's accepted tasks from delivered completion
  // facts, so anything still sitting in the outbox has to be handed over first.
  deliverFacts(input, supervisor, broker, state, dispatchId);

  const gate = gateFor(snapshot, phase, input.dependencies.sha256);
  const measured = gate === undefined ? [] : await readGate(input, snapshot, gate);
  // The candidate must cover every active task the phase owns, not only the one
  // this dispatch carried.
  const tasks = dispatchedPhaseTasks(snapshot, state, input.runId, phaseKey);
  const candidate = createPhaseCandidate(
    {
      phase: scheduling.phase,
      phaseAttempt: { ...scheduling.phase, attempt: 1 },
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
    `gate-${phaseKey}`,
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
    return {
      kind: "gate-refused",
      phaseKey,
      reasons: readings.map((reading) => `${String(reading.sensorKey)} did not pass`),
    };
  }

  // An authored approval is a human's to give. Submitting close-phase while one
  // is owed would cache a refusal against that command id and replay it after
  // the decision arrives, so the driver asks what the human is asked.
  if (requiresApproval(phase) && approvalPending(input)) {
    return { kind: "awaiting-approval", phaseKey };
  }

  const closed = submitTolerating(
    ["decision-required"],
    supervisor,
    input,
    `close-${phaseKey}`,
    "close-phase",
    snapshot.graph.revisionDigest,
    candidate.candidateDigest,
    {},
  );
  if (closed === "decision-required") {
    return { kind: "awaiting-approval", phaseKey };
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
  const keys = snapshot.phaseDataflow.map((entry) => entry.key);
  const following = keys[keys.indexOf(closedKey) + 1];
  if (following === undefined) return undefined;
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === "phase" && candidate.definition.key === following,
  );
  if (node === undefined || node.kind !== "phase") return undefined;
  return { key: following, id: node.definition.id, generation: node.definition.generation };
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
function deliverFacts(
  input: AdvanceRunInput,
  supervisor: SqliteSupervisorAuthority,
  broker: SqliteContextBroker,
  state: ReturnType<SqliteContextBroker["authority"]["snapshot"]>,
  dispatchId: string,
): void {
  for (const entry of state.completionOutbox) {
    if (entry.delivered || entry.fact.dispatchId !== dispatchId) continue;
    const stored = broker.loadWorkerDispatch(entry.fact.dispatchId);
    if (stored === undefined) continue;
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
    broker.deliverCompletionFact(entry.submissionId);
  }
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
  const commandId = `command_${suffix}-${input.dependencies.sha256
    .digest(canonicalBytes(canonicalValue({ runId: input.runId, suffix })))
    .slice(0, 24)}`;
  refuseUncanonicalPayload(intent, payload);
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
      payloadDigest: input.dependencies.sha256.digest(canonicalBytes(canonicalValue(payload))),
      expectedGraphRevision: graphRevision,
      ...(exactObjectDigest === undefined ? {} : { exactObjectDigest }),
      ...(expectedDefinitionRevision === undefined ? {} : { expectedDefinitionRevision }),
    } as never),
    {
      currentTime: input.currentTime,
      facts: { source: "advance-run" },
      // Identities must be globally unique, so they carry the command they serve.
      allocateId: (kind: string) => {
        allocation += 1;
        return `${kind}-${commandId.slice(8)}-${allocation}`;
      },
    },
  );
  // A driver that reports progress the authority refused is worse than one that stops.
  if (receipt.status !== "completed") {
    throw new Error(
      `${intent} was ${receipt.status}${receipt.error === undefined ? "" : `: ${receipt.error.code}`}`,
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
  return state.dispatches
    .filter(
      (candidate) =>
        candidate.runId === runId && phaseKeyByTask(snapshot, candidate.task.taskId) === phaseKey,
    )
    .map((candidate) => candidate.task)
    .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
}

function phaseValue(snapshot: ConfigurationSnapshot, key: string): SnapshotPhase {
  const entry = snapshot.phaseDataflow.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`Workflow declares no phase ${key}`);
  return entry.value as unknown as SnapshotPhase;
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
    found.push({
      phase: producing,
      output: String(entry.fact.output.outputName),
      bindingDigest: sha256Digest(String(entry.fact.output.contentDigest)),
      acceptanceDigest: sha256Digest(String(entry.fact.output.validationReceiptDigest)),
      value: canonicalValue({}),
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
