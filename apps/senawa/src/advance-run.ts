import type { ConfigurationSnapshot } from "@senawa/configuration";
import { loadAuthoredWorkflow, runSensors } from "@senawa/execution-host";
import {
  type CanonicalValue,
  canonicalValue,
  createPhaseCandidate,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  evaluateGate,
  type Sha256Digest,
  sha256Digest,
} from "@senawa/kernel";
import {
  type AuthenticatedPrincipal,
  canonicalBytes,
  type DurableReceipt,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { RuntimeDataflowAuthority, type RuntimeDependencies } from "@senawa/runtime";
import { SqliteCanonicalJsonAssetStore, SqliteContextBroker } from "@senawa/storage-sqlite";
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
  readonly exit?: { readonly gate?: string };
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

  const publications = published.map(({ fact }) =>
    dataflow.publishPhaseOutput({
      schema: runtimeSchemaContract(
        snapshot,
        String(fact.output.schemaKey),
        input.dependencies.sha256,
      ),
      fact,
    }),
  );
  const assessments = state.completionOutbox
    .filter((entry) => entry.fact.dispatchId === dispatchId)
    .map((entry) => ({
      assessment: entry.fact.assessment,
      assessmentDigest: digestAccountingAssessment(
        entry.fact.assessment,
        input.dependencies.sha256,
      ),
    }));

  const gate = gateFor(snapshot, phase);
  const readings = gate === undefined ? [] : await readGate(input, snapshot, gate);
  const candidate = createPhaseCandidate(
    {
      phase: scheduling.phase,
      phaseAttempt: { ...scheduling.phase, attempt: 1 },
      graphRevisionDigest: snapshot.graph.revisionDigest,
      inputBindingDigest: publications[0]?.inputBindingDigest ?? sha256Digest("0".repeat(64)),
      requiredOutputPublications: publications,
      outputSetDigest: digestPhaseOutputSet(publications, input.dependencies.sha256),
      selectedTaskSetDigest: digestSelectedTaskSet([dispatch.task], input.dependencies.sha256),
      tasks: [dispatch.task],
      acceptedAccountingAssessments: assessments,
      dependencyBarrierDigest: sha256Digest("0".repeat(64)),
      gatePolicyDigest: gate?.policyDigest ?? sha256Digest("0".repeat(64)),
    },
    snapshot.graph,
    input.dependencies.sha256,
  );

  if (gate !== undefined) {
    const evaluation = evaluateGate(
      gate,
      readings,
      candidate.candidateDigest,
      input.dependencies.sha256,
    );
    if (evaluation.decision !== "accepted") {
      return {
        kind: "gate-refused",
        phaseKey,
        reasons: readings.map((reading) => `${String(reading.sensorKey)} did not pass`),
      };
    }
  }

  submit(supervisor, input, `gate-${phaseKey}`, "evaluate-gate", candidate.candidateDigest, {
    phase: candidate.phase,
    phaseAttempt: candidate.phaseAttempt,
    inputBindingDigest: candidate.inputBindingDigest,
    requiredOutputPublications: candidate.requiredOutputPublications,
    outputSetDigest: candidate.outputSetDigest,
    dependencyBarrierDigest: candidate.dependencyBarrierDigest,
    gateDefinition: gate,
    readings,
  });

  // An authored approval is a human's to give. The driver stops here and the
  // run waits, rather than recording a decision nobody made.
  if (requiresApproval(phase)) return { kind: "awaiting-approval", phaseKey };

  submit(supervisor, input, `close-${phaseKey}`, "close-phase", candidate.candidateDigest, {});
  const next = nextPhase(snapshot, phaseKey);
  if (next === undefined) return { kind: "finished" };
  submit(
    supervisor,
    input,
    `advance-${next.key}`,
    "start-phase-attempt",
    candidate.candidateDigest,
    {
      phaseId: next.id,
      definitionGeneration: next.generation,
    },
  );
  return { kind: "closed", phaseKey };
}

function requiresApproval(phase: SnapshotPhase): boolean {
  return (
    (phase as unknown as { readonly approval?: { readonly policy?: string } }).approval?.policy ===
    "required"
  );
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
  const sensorKeys = [...new Set(gate.rules.map(({ sensor }) => String(sensor)))].sort();
  if (sensorKeys.length === 0) return [];
  const result = await runSensors({
    snapshot,
    sensorKeys,
    rootDirectory: input.projectRoot,
    sha256: input.dependencies.sha256,
  });
  return result.readings;
}

function gateFor(
  snapshot: ConfigurationSnapshot,
  phase: SnapshotPhase,
):
  | (Parameters<typeof evaluateGate>[0] & {
      readonly rules: readonly { readonly sensor: string }[];
    })
  | undefined {
  const gateKey = phase.exit?.gate;
  if (gateKey === undefined) return undefined;
  const entry = snapshot.gates.find((candidate) => candidate.key === gateKey);
  if (entry === undefined) return undefined;
  return (entry.value as unknown as SnapshotGateValue).definition as never;
}

function submit(
  supervisor: SqliteSupervisorAuthority,
  input: AdvanceRunInput,
  suffix: string,
  intent: string,
  exactObjectDigest: string,
  payload: unknown,
): DurableReceipt {
  const commandId = `command_${suffix}-${input.dependencies.sha256
    .digest(canonicalBytes(canonicalValue({ runId: input.runId, suffix })))
    .slice(0, 24)}`;
  let allocation = 0;
  return supervisor.commandAuthority.submit(
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
      expectedGraphRevision: undefined,
      exactObjectDigest,
    } as never),
    {
      currentTime: input.currentTime,
      facts: { source: "advance-run" },
      allocateId: (kind: string) => {
        allocation += 1;
        return `${kind}-advance-${allocation}`;
      },
    },
  );
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
