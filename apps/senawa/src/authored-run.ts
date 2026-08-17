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
    approvalPolicy: { policy: "approval-required", authority: input.principal },
    escalationPolicyDigest: sha256Digest("9".repeat(64)),
    allowancePolicy: {
      policyDigest: sha256Digest("9".repeat(64)),
      ceilings: [
        { unit: "dispatch-failure", maximum: 64 },
        { unit: "work-attempt", maximum: 64 },
        { unit: "workspace-operations", maximum: 64 },
      ],
    },
  };
  const commandId = `command_instantiate-${dependencies.sha256
    .digest(canonicalBytes({ repositoryId: input.repositoryId, runId: input.runId }))
    .slice(0, 32)}`;
  let allocation = 0;
  const allocateId = (kind: string): string => {
    allocation += 1;
    return `${kind}-instantiate-${allocation}`;
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
