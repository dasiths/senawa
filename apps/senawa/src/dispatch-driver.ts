import type { ConfigurationRegistryEntry, ConfigurationSnapshot } from "@senawa/configuration";
import type { AssetSensitivity, ContextBudget, DataMappingDeclaration } from "@senawa/kernel";
import {
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  deriveCompletionRequirements,
  runId as kernelRunId,
  type MappingSourceBinding,
  type Sha256Digest,
  sha256Digest,
  type WorkerContextBase,
  type WorkerDispatch,
} from "@senawa/kernel";
import { decodeCanonicalJsonValue } from "@senawa/protocol";
import {
  type ContextBrokerClient,
  type RuntimeDataflowAuthority,
  type RuntimeDependencies,
  renderPromptPack,
} from "@senawa/runtime";
import { runtimeSchemaContract } from "./dataflow-composition.js";

/** The snapshot shapes this driver reads. The compiler stores them untyped. */
interface SnapshotPhase {
  readonly key: string;
  readonly dependsOn?: readonly string[];
  readonly input: {
    readonly schema: string;
    readonly mappings: readonly DataMappingDeclaration[];
  };
  readonly executor: CanonicalValue & {
    readonly role: string;
    readonly budgets: readonly ContextBudget[];
  };
  readonly outputs: readonly {
    readonly key: string;
    readonly schema: string;
    readonly maxBytes: number;
    readonly sensitivity: AssetSensitivity;
  }[];
}

interface SnapshotAgentRole {
  readonly key: string;
  readonly capabilities: readonly string[];
  readonly prompt: string;
  readonly modelPolicy: string;
}

interface SnapshotModelPolicy {
  readonly key: string;
  readonly routes: readonly {
    readonly provider: string;
    readonly model: string;
    readonly maxTurns: number;
    readonly maxSubmissions: number;
    readonly maxMillidollars: number;
    readonly maxAiCredits?: number;
  }[];
}

/** Everything the driver needs to turn one phase into one registered dispatch. */
export interface DispatchPhaseInput {
  readonly snapshot: ConfigurationSnapshot;
  readonly dataflow: RuntimeDataflowAuthority;
  readonly contextBroker: ContextBrokerClient;
  readonly dependencies: RuntimeDependencies;
  readonly repositoryId: string;
  readonly runId: string;
  readonly phaseKey: string;
  /**
   * The run's bound workflow input. A phase with dependencies also reads the
   * published output of each phase it depends on, supplied as `upstream`.
   */
  readonly workflowInput: {
    readonly bindingDigest: Sha256Digest;
    readonly value: CanonicalValue;
  };
  /** Published upstream outputs this phase reads, empty for the root phase. */
  readonly upstream?: readonly {
    readonly phase: string;
    readonly output: string;
    readonly bindingDigest: Sha256Digest;
    /** Proof the output was accepted. A produced-but-unaccepted output is not readable. */
    readonly acceptanceDigest: Sha256Digest;
    readonly value: CanonicalValue;
  }[];
  /** Which attempt this is. A retry after a red gate dispatches attempt two. */
  readonly attempt?: number;
  readonly repositoryBase: {
    readonly commitDigest: Sha256Digest;
    readonly treeDigest: Sha256Digest;
  };
  readonly currentTime: string;
  readonly timeoutMs?: number;
  /** Credit ceiling for this dispatch. The compiler has no route field for it. */
  readonly maxAiCredits?: number;
}

export interface DispatchPhaseResult {
  readonly context: WorkerContextBase;
  readonly dispatch: WorkerDispatch;
}

const PROMPT_PACK_MAX_BYTES = 65_536;
const PROVISIONAL_PROMPT_PACK_DIGEST = sha256Digest("0".repeat(64));
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Builds and registers the worker dispatch for one phase.
 *
 * This is the step that never existed: every primitive below was implemented and
 * tested, but nothing composed them, so an instantiated run never became agent
 * work. The ordering matters and is not obvious, so it is spelled out.
 */
export function dispatchPhase(input: DispatchPhaseInput): DispatchPhaseResult {
  const { snapshot, dependencies } = input;
  const sha256 = dependencies.sha256;
  const declaration = registryValue<SnapshotPhase>(
    registryEntry(snapshot.phaseDataflow, input.phaseKey),
  );
  const phaseNode = requiredNode(snapshot, "phase", input.phaseKey);
  const taskNode = snapshot.graph.nodes.find(
    (node) => node.kind === "task" && node.definition.parentId === phaseNode.definition.id,
  );
  if (taskNode === undefined || taskNode.kind !== "task") {
    throw new Error(`Phase ${input.phaseKey} declares no executable work`);
  }

  const roleEntry = registryEntry(snapshot.roles, declaration.executor.role);
  const role = registryValue<SnapshotAgentRole>(roleEntry);
  const modelPolicyEntry = registryEntry(snapshot.modelPolicies, role.modelPolicy);
  const modelPolicy = registryValue<SnapshotModelPolicy>(modelPolicyEntry);
  const promptEntry = requiredPrompt(snapshot, role.prompt);
  const prompt = promptEntry;

  const upstream = input.upstream ?? [];
  const sourceBindings: readonly MappingSourceBinding[] = [
    {
      source: { kind: "workflow-input" as const },
      sourceBindingDigest: input.workflowInput.bindingDigest,
      value: input.workflowInput.value,
    },
    ...upstream.map((entry) => ({
      source: {
        kind: "phase-output" as const,
        phase: consumerKey(entry.phase),
        output: consumerKey(entry.output),
      },
      sourceBindingDigest: entry.bindingDigest,
      acceptanceDigest: entry.acceptanceDigest,
      value: entry.value,
    })),
  ];
  // The upstream set is what makes a retry after an amended dependency a
  // different attempt, so it is derived from the bindings rather than fixed.
  const upstreamSetDigest = canonicalDigest(
    canonicalValue(sourceBindings.map(({ sourceBindingDigest }) => sourceBindingDigest).sort()),
    sha256,
  );

  const started = input.dataflow.startPhaseAttempt({
    repositoryId: input.repositoryId,
    runId: input.runId,
    phase: {
      phaseId: phaseNode.definition.id,
      definitionGeneration: phaseNode.definition.generation,
      attempt: input.attempt ?? 1,
    },
    graphRevisionDigest: snapshot.graph.revisionDigest,
    configurationSnapshotDigest: snapshot.snapshotDigest,
    executorDigest: roleEntry.digest,
    upstreamClosureSetDigest: upstreamSetDigest,
    upstreamOutputSetDigest: upstreamSetDigest,
    schema: runtimeSchemaContract(snapshot, declaration.input.schema, sha256),
    mappings: declaration.input.mappings,
    sourceBindings,
    mappingPolicy: {
      dependencyPhases: (declaration.dependsOn ?? []).map(consumerKey),
      declaredPhaseOutputs: snapshot.phaseDataflow.flatMap((entry) => {
        const value = registryValue<SnapshotPhase>(entry);
        return value.outputs.map(({ key }) => ({
          phase: consumerKey(value.key),
          output: consumerKey(key),
        }));
      }),
      completionEvidenceViews: [],
      allowCurrentItem: false,
    },
  });

  // The role's own capabilities cannot reach the broker; the protocol ones are
  // what let the agent submit anything at all. Both the context and the dispatch
  // must carry the identical list, because a dispatch may not widen its context.
  const capabilities = [...role.capabilities].sort(compare);

  const context = createWorkerContextBase(
    {
      task: {
        taskId: taskNode.definition.id,
        definitionGeneration: taskNode.definition.generation,
      },
      graphRevisionDigest: snapshot.graph.revisionDigest,
      configurationSnapshotDigest: snapshot.snapshotDigest,
      contracts: [],
      dependencyBarrier: {
        task: {
          taskId: taskNode.definition.id,
          definitionGeneration: taskNode.definition.generation,
        },
        dependencies: [],
      },
      assets: [],
      repositoryBase: input.repositoryBase,
      modelPolicy: {
        key: consumerKey(role.modelPolicy),
        policyDigest: modelPolicyEntry.digest,
        orderedRoutesDigest: modelPolicyEntry.digest,
      },
      role: { key: consumerKey(roleEntry.key), roleDigest: roleEntry.digest },
      prompt: {
        key: consumerKey(prompt.key),
        path: prompt.source.path,
        resourceDigest: promptEntry.digest,
        contentDigest: prompt.source.contentDigest,
        byteLength: prompt.source.byteLength,
        utf8: prompt.source.utf8,
        inputPaths: prompt.inputPaths,
      },
      mappedInput: {
        value: started.value,
        valueDigest: canonicalDigest(started.value, sha256),
      },
      phaseAttempt: started.attempt,
      phaseInputBinding: started.inputBinding,
      phaseOutputDeclarations: declaration.outputs.map((output) => ({
        outputName: consumerKey(output.key),
        schemaKey: consumerKey(output.schema),
        schemaResourceDigest: runtimeSchemaContract(snapshot, output.schema, sha256)
          .schemaResourceDigest,
        maxBytes: output.maxBytes,
        sensitivity: output.sensitivity,
      })),
      // The same policy the broker judges completion by, so the generated
      // contract cannot promise the agent different terms.
      completionPolicy: taskNode.definition.completionPolicy,
      capabilities,
      budgets: declaration.executor.budgets,
    },
    sha256,
  );

  const dispatchInput = {
    repositoryId: input.repositoryId,
    runId: kernelRunId(input.runId),
    ordinal: 1,
    workerPrincipalId: `principal_${input.phaseKey}-1`,
    roleKey: consumerKey(roleEntry.key),
    capabilities,
    promptResource: {
      key: consumerKey(prompt.key),
      resourceDigest: promptEntry.digest,
      contentDigest: prompt.source.contentDigest,
    },
  };

  // The prompt pack digest is an input to the dispatch, and the dispatch is an
  // input to rendering the pack, so the first dispatch exists only to be
  // rendered against and is discarded.
  const provisional = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: PROVISIONAL_PROMPT_PACK_DIGEST },
    context,
    sha256,
  );
  const pack = renderPromptPack(context, provisional, sha256, PROMPT_PACK_MAX_BYTES);
  const dispatch = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: pack.digest },
    context,
    sha256,
  );

  const route = modelPolicy.routes[0];
  if (route === undefined) throw new Error(`Model policy ${role.modelPolicy} declares no route`);
  const routeSelection = createWorkerModelRouteSelection(
    {
      routeIndex: 0,
      provider: route.provider,
      model: route.model,
      maxTurns: route.maxTurns,
      maxSubmissions: route.maxSubmissions,
      maxMillidollars: route.maxMillidollars,
      maxAiCredits: input.maxAiCredits ?? 1,
    },
    context,
    dispatch,
    sha256,
  );

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    context,
    dispatch: input.contextBroker.registerDispatch({
      context,
      dispatch,
      completionRequirements: deriveCompletionRequirements(
        snapshot.graph,
        [dispatch.task],
        sha256,
      )[0],
      taskScope: {
        runId: input.runId,
        taskId: dispatch.task.taskId,
        definitionGeneration: dispatch.task.definitionGeneration,
        acceptedContextDigest: context.contextDigest,
        fenceGeneration: 1,
      },
      // Omitting the effect registers a dispatch the scheduler silently ignores,
      // which strands the run with no error anywhere.
      effect: {
        input: decodeCanonicalJsonValue({
          dispatchId: dispatch.dispatchId,
          routeSelection,
          timeoutMs,
          grantPolicy: {
            expiresAfterMs: timeoutMs * 2,
            maxOperations: 64,
            maxBytes: 1_048_576,
            maxChunkBytes: 65_536,
          },
        }),
        budgetReservation: { unit: "review-iteration", amount: 1 },
      },
    }),
  };
}

function requiredNode(snapshot: ConfigurationSnapshot, kind: "phase", key: string) {
  const node = snapshot.graph.nodes.find(
    (candidate) => candidate.kind === kind && candidate.definition.key === key,
  );
  if (node === undefined || node.kind !== "phase") {
    throw new Error(`Workflow declares no ${kind} named ${key}`);
  }
  return node;
}

function requiredPrompt(snapshot: ConfigurationSnapshot, key: string) {
  const prompt = snapshot.prompts.find((candidate) => candidate.key === key);
  if (prompt === undefined) throw new Error(`Configuration declares no prompt named ${key}`);
  return prompt;
}

function registryEntry(
  entries: readonly ConfigurationRegistryEntry[],
  key: string,
): ConfigurationRegistryEntry {
  const entry = entries.find((candidate) => candidate.key === key);
  if (entry === undefined) throw new Error(`Configuration declares no entry named ${key}`);
  return entry;
}

function registryValue<T>(entry: ConfigurationRegistryEntry): T {
  return entry.value as unknown as T;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
