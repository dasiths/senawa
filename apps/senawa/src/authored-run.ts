import type { ConfigurationSnapshot } from "@senawa/configuration";
import { sha256Digest } from "@senawa/kernel";
import type { AuthenticatedPrincipal } from "@senawa/protocol";
import {
  canonicalBytes,
  type DurableReceipt,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import type { RuntimeDependencies } from "@senawa/runtime";
import type { SqliteAuthority } from "@senawa/storage-sqlite";

export interface InstantiateAuthoredRunInput {
  readonly authority: SqliteAuthority;
  readonly snapshot: ConfigurationSnapshot;
  readonly repositoryId: string;
  readonly runId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly currentTime: string;
  readonly dependencies: RuntimeDependencies;
  /** Which phase carries the command-driven lifecycle. Defaults to the first root phase. */
  readonly lifecyclePhaseKey?: string;
}

/**
 * Registers a compiled workflow and instantiates a run from it.
 *
 * This is the step that was missing entirely: an authored workflow could be
 * compiled but never became a run, because nothing registered the snapshot or
 * submitted the instantiation.
 */
export function instantiateAuthoredRun(input: InstantiateAuthoredRunInput): DurableReceipt {
  const { authority, snapshot, dependencies } = input;
  authority.putConfigurationSnapshot(snapshot);

  const phase = selectLifecyclePhase(snapshot, input.lifecyclePhaseKey);
  const payload = {
    workflowId: snapshot.graph.workflowId,
    configurationSnapshotDigest: snapshot.snapshotDigest,
    execution: snapshot.execution,
    graph: snapshot.graph,
    phase: { phaseId: phase.id, definitionGeneration: phase.generation },
    approvalPolicy: approvalPolicyFor(snapshot, input.principal),
    escalationPolicyDigest: sha256Digest("9".repeat(64)),
    allowancePolicy: {
      policyDigest: sha256Digest("9".repeat(64)),
      // A ceiling is what a person is allowed to grant when a budget runs out.
      // The list named every failure unit and omitted `review-iteration`, which
      // is the unit an ordinary dispatch spends, so the one budget a healthy run
      // actually exhausts was the one nobody could ever top up: the run stopped
      // on a request for more, and the portal offered no command to grant it.
      // The authority requires these sorted by unit.
      ceilings: [
        { unit: "dispatch-failure", maximum: 64 },
        { unit: "review-iteration", maximum: 64 },
        { unit: "work-attempt", maximum: 64 },
        { unit: "workspace-operations", maximum: 64 },
      ],
    },
  };
  const commandId = `command_instantiate-${dependencies.sha256
    .digest(canonicalBytes({ repositoryId: input.repositoryId, runId: input.runId }))
    .slice(0, 32)}`;
  let allocation = 0;
  // Identities are globally unique, so they carry the run they belong to. A
  // fixed suffix meant only the first run in a state root could start.
  const allocateId = (kind: string): string => {
    allocation += 1;
    return `${kind}-${commandId.slice(8)}-${allocation}`;
  };
  return authority.submit(
    decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: input.principal,
      transport: { kind: "cli", requestId: `request_${commandId}` },
      repositoryId: input.repositoryId,
      runId: input.runId,
      intent: { type: "instantiate-run" },
      payload,
      payloadDigest: dependencies.sha256.digest(canonicalBytes(payload)),
    }),
    {
      currentTime: input.currentTime,
      facts: { source: "authored-run" },
      allocateId,
    },
  );
}

/**
 * Opens the attempt a dispatch is, against the task it is for.
 *
 * `senawa start` dispatches in its own process, before any driver exists. Its
 * dispatch is an attempt like any other, and leaving it unrecorded left the
 * one-agent rule blind to the first turn of every run.
 */
export function openPhaseAttempt(input: {
  readonly authority: SqliteAuthority;
  readonly repositoryId: string;
  readonly runId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly currentTime: string;
  readonly dependencies: RuntimeDependencies;
  readonly graphRevision: string;
  readonly dispatchId: string;
  readonly taskId: string;
  readonly definitionGeneration: number;
}): DurableReceipt {
  const digest = (value: unknown): string =>
    input.dependencies.sha256.digest(canonicalBytes(value as never));
  const payload = {
    attemptDigest: digest({ dispatchId: input.dispatchId }),
    transitionDigest: digest({ dispatchId: input.dispatchId, of: "opened" }),
    triggerDigest: digest({ runId: input.runId, of: "opened" }),
    taskId: input.taskId,
    definitionGeneration: input.definitionGeneration,
    disposition: "opened",
  };
  const commandId = `command_attempt-opened-${digest({
    runId: input.runId,
    dispatchId: input.dispatchId,
  }).slice(0, 24)}`;
  let allocation = 0;
  return input.authority.submit(
    decodeCommandEnvelope({
      apiVersion: PROTOCOL_VERSION,
      commandId,
      principal: input.principal,
      transport: { kind: "cli", requestId: `request_${commandId}` },
      repositoryId: input.repositoryId,
      runId: input.runId,
      intent: { type: "record-phase-attempt-transition" },
      payload,
      payloadDigest: input.dependencies.sha256.digest(canonicalBytes(payload)),
      expectedGraphRevision: input.graphRevision,
    } as never),
    {
      currentTime: input.currentTime,
      facts: { source: "authored-run" },
      allocateId: (kind: string) => {
        allocation += 1;
        return `${kind}_${commandId.slice(8).toLowerCase()}${allocation}`;
      },
    },
  );
}

/**
 * The run's approval policy, derived from what the author asked for.
 *
 * The authority models approval per run while the authored surface states it
 * per phase, so a workflow that approves any phase currently approves them all.
 * Recorded as F-011; narrowing it needs per-phase policy in the authority.
 */
function approvalPolicyFor(
  snapshot: ConfigurationSnapshot,
  principal: AuthenticatedPrincipal,
): { readonly policy: string; readonly authority?: AuthenticatedPrincipal } {
  const approved = snapshot.phaseDataflow.some(
    (entry) =>
      (
        entry.value as unknown as {
          readonly exit?: { readonly approval?: { readonly policy?: string } };
        }
      ).exit?.approval?.policy === "required",
  );
  return approved
    ? { policy: "approval-required", authority: principal }
    : { policy: "no-approval" };
}

function selectLifecyclePhase(
  snapshot: ConfigurationSnapshot,
  key: string | undefined,
): { readonly id: string; readonly generation: number } {
  const phases = snapshot.graph.nodes.filter((node) => node.kind === "phase");
  const chosen =
    key === undefined
      ? phases.find((node) => node.definition.dependsOn.length === 0)
      : phases.find((node) => node.definition.key === key);
  if (chosen === undefined || chosen.kind !== "phase") {
    throw new Error(
      key === undefined
        ? "Workflow declares no phase without dependencies"
        : `Workflow declares no phase named ${key}`,
    );
  }
  return { id: chosen.definition.id, generation: chosen.definition.generation };
}
