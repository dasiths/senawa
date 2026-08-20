import { compileAuthoredWorkflow } from "@senawa/execution-host";
import {
  type CanonicalValue,
  canonicalValue,
  type Sha256Digest,
  type WorkerModelRouteSelection,
} from "@senawa/kernel";
import type { AuthenticatedPrincipal } from "@senawa/protocol";
import { RuntimeDataflowAuthority, type RuntimeDependencies } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
} from "@senawa/storage-sqlite";
import { instantiateAuthoredRun } from "./authored-run.js";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import { dispatchPhase } from "./dispatch-driver.js";

export interface StartAuthoredRunInput {
  readonly projectRoot: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
  readonly repositoryId: string;
  readonly runId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly input: CanonicalValue;
  readonly currentTime: string;
  readonly repositoryBase: {
    readonly commitDigest: Sha256Digest;
    readonly treeDigest: Sha256Digest;
  };
  readonly maxAiCredits?: number;
  readonly configurationDirectory?: string;
}

export interface StartedAuthoredRun {
  readonly repositoryId: string;
  readonly runId: string;
  readonly phaseKey: string;
  readonly dispatchId: string;
  readonly contextId: string;
  readonly graphRevision: Sha256Digest;
  /** The route the dispatched phase runs under, which a worker adapter needs. */
  readonly routeSelection: WorkerModelRouteSelection;
}

/**
 * Takes a project from authored files to a dispatched first phase.
 *
 * This is the whole missing path in one call: compile, instantiate, bind the
 * request, and dispatch. After it returns, the supervisor's scheduler has work
 * it can see.
 */
export async function startAuthoredRun(input: StartAuthoredRunInput): Promise<StartedAuthoredRun> {
  const snapshot = await compileAuthoredWorkflow(
    input.projectRoot,
    input.dependencies.sha256,
    input.configurationDirectory,
  );
  const authority = new SqliteAuthority({
    databasePath: input.databasePath,
    assetDirectory: input.assetDirectory,
    dependencies: input.dependencies,
  });
  const contextBroker = new SqliteContextBroker({
    databasePath: input.databasePath,
    dependencies: {
      sha256: input.dependencies.sha256,
      currentTime: () => input.currentTime,
      issueGrantToken: () => new Uint8Array(32),
    },
  });
  try {
    const receipt = instantiateAuthoredRun({
      authority,
      snapshot,
      repositoryId: input.repositoryId,
      runId: input.runId,
      principal: input.principal,
      currentTime: input.currentTime,
      dependencies: input.dependencies,
    });
    if (receipt.status !== "completed") {
      // The receipt says why, and dropping it left a caller with a status word
      // and nothing to act on. A refusal that names the rule takes minutes to
      // fix; one that names only itself takes an afternoon.
      throw new Error(
        `Run instantiation was ${receipt.status}${
          receipt.error?.message === undefined ? "" : `: ${receipt.error.message}`
        }`,
      );
    }

    const dataflow = new RuntimeDataflowAuthority(
      input.dependencies.sha256,
      configurationRuntimeSchemaValidator(),
      new SqliteCanonicalJsonAssetStore(authority),
      authority,
    );
    // The root phase reads the workflow input, so its declared schema is the
    // schema the request is bound against.
    const phaseKey = firstPhaseKey(snapshot);
    const rootDeclaration = snapshot.phaseDataflow.find((entry) => entry.key === phaseKey);
    if (rootDeclaration === undefined) throw new Error(`Workflow declares no phase ${phaseKey}`);
    const workflowSchemaKey = (
      rootDeclaration.value as unknown as { readonly input: { readonly schema: string } }
    ).input.schema;
    const binding = dataflow.bindWorkflowInput({
      repositoryId: input.repositoryId,
      runId: input.runId,
      workflowId: snapshot.graph.workflowId,
      graphRevisionDigest: snapshot.graph.revisionDigest,
      configurationSnapshotDigest: snapshot.snapshotDigest,
      schema: runtimeSchemaContract(snapshot, workflowSchemaKey, input.dependencies.sha256),
      value: input.input,
    });

    const dispatched = dispatchPhase({
      snapshot,
      dataflow,
      contextBroker,
      sessionLedger: authority,
      dependencies: input.dependencies,
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      workflowInput: { bindingDigest: binding.bindingDigest, value: input.input },
      repositoryBase: input.repositoryBase,
      currentTime: input.currentTime,
      ...(input.maxAiCredits === undefined ? {} : { maxAiCredits: input.maxAiCredits }),
    });

    return {
      repositoryId: input.repositoryId,
      runId: input.runId,
      phaseKey,
      dispatchId: dispatched.dispatch.dispatchId,
      contextId: dispatched.dispatch.contextId,
      graphRevision: snapshot.graph.revisionDigest,
      routeSelection: dispatched.routeSelection,
    };
  } finally {
    contextBroker.close();
    authority.close();
  }
}

/** Reads a workflow request file into the canonical value the run is bound to. */
export function workflowRequest(value: unknown): CanonicalValue {
  return canonicalValue(value);
}

function firstPhaseKey(snapshot: Awaited<ReturnType<typeof compileAuthoredWorkflow>>): string {
  const root = snapshot.graph.nodes.find(
    (node) => node.kind === "phase" && node.definition.dependsOn.length === 0,
  );
  if (root === undefined || root.kind !== "phase") {
    throw new Error("Workflow declares no phase without dependencies");
  }
  return root.definition.key;
}
