import type { ConfigurationRegistryEntry, ConfigurationSnapshot } from "@senawa/configuration";
import type { AssetSensitivity, ContextBudget, DataMappingDeclaration } from "@senawa/kernel";
import {
  type AgentSessionResumeBinding,
  type AgentSessionScope,
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createAgentSessionResumeBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  decideAgentSessionResume,
  deriveCompletionRequirements,
  runId as kernelRunId,
  type MappingSourceBinding,
  type Sha256Digest,
  sha256Digest,
  type WorkerContextBase,
  type WorkerDispatch,
  type WorkerModelRouteSelection,
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
    readonly kind?: string;
    readonly template?: string;
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
  readonly sessionScope?: AgentSessionScope;
  readonly sessionMaxTurns?: number;
}

/**
 * Where session continuity is recorded between dispatches.
 *
 * The driver cannot hold this in memory: a run advances one durable step per
 * process, so the only place a successor can learn which conversation preceded
 * it is the authority.
 */
export interface AgentSessionLedgerPort {
  queryLatestAgentSessionResumeBinding(
    sessionLineKey: string,
  ): AgentSessionResumeBinding | undefined;
  countAgentSessionResumeBindings(sessionLineKey: string, sessionId?: string): number;
  putAgentSessionResumeBinding(binding: AgentSessionResumeBinding, sessionLineKey: string): unknown;
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
  /** Which member of a fan-out phase to dispatch. Members run one at a time. */
  readonly memberIndex?: number;
  /** Why the previous attempt was refused, so the next one is told what to change. */
  readonly priorRefusals?: readonly string[];
  readonly repositoryBase: {
    readonly commitDigest: Sha256Digest;
    readonly treeDigest: Sha256Digest;
  };
  readonly currentTime: string;
  readonly timeoutMs?: number;
  /** Credit ceiling for this dispatch. The compiler has no route field for it. */
  readonly maxAiCredits?: number;
  /** Where session continuity is read and recorded. Omitted, every dispatch is fresh. */
  readonly sessionLedger?: AgentSessionLedgerPort;
}

export interface DispatchPhaseResult {
  readonly context: WorkerContextBase;
  readonly dispatch: WorkerDispatch;
  /** The route this dispatch runs under, which a worker adapter needs to run it. */
  readonly routeSelection: WorkerModelRouteSelection;
  /**
   * The conversation this dispatch joins, and the one it starts.
   *
   * `resumed` is absent when the persona is attempt-scoped, when this is its
   * first dispatch on the line, or when the recorded predecessor no longer
   * matches: a lost session is a visible absence here rather than a silent
   * restart inside the adapter.
   */
  readonly session: Readonly<{
    readonly scope: AgentSessionScope;
    readonly lineKey: string;
    readonly sessionId: string;
    readonly turn: number;
    readonly resumed?: AgentSessionResumeBinding;
    /** Which fields stopped a recorded predecessor from being resumed. */
    readonly lost?: readonly string[];
    /**
     * The bound a conversation reached, when this dispatch renewed it.
     *
     * Distinct from `lost`: a renewal is the policy working as authored, while
     * a loss means the ground moved under a conversation that should have
     * continued.
     */
    readonly renewedAfterTurns?: number;
    /** This dispatch's own binding, recorded so its successor can find it. */
    readonly binding: AgentSessionResumeBinding;
  }>;
}

/** A member's input is its element, which the template maps whole. */
const MEMBER_ITEM_MAPPINGS = Object.freeze([
  Object.freeze({
    key: consumerKey("item"),
    source: Object.freeze({ kind: "current-item" as const, pointer: "" }),
    destinationPointer: "",
  }),
]) as never;

const PROMPT_PACK_MAX_BYTES = 65_536;
const PROVISIONAL_PROMPT_PACK_DIGEST = sha256Digest("0".repeat(64));
/** Turns one conversation may carry before it is renewed, when none is authored. */
const DEFAULT_SESSION_MAX_TURNS = 24;

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
  const attempt = input.attempt ?? 1;
  const declaration = registryValue<SnapshotPhase>(
    registryEntry(snapshot.phaseDataflow, input.phaseKey),
  );
  const phaseNode = requiredNode(snapshot, "phase", input.phaseKey);
  const phaseTasks = snapshot.graph.nodes.filter(
    (node) => node.kind === "task" && node.definition.parentId === phaseNode.definition.id,
  );
  // A fan-out phase owns one task per member and runs them one at a time, so a
  // caller names which. Every other phase owns exactly one.
  const taskNode = phaseTasks[input.memberIndex ?? 0];
  if (taskNode === undefined || taskNode.kind !== "task") {
    if (declaration.executor.kind === "task-frontier") {
      throw new Error(
        `Phase ${input.phaseKey} is a fan-out whose members have not been materialised`,
      );
    }
    throw new Error(`Phase ${input.phaseKey} declares no executable work`);
  }

  // A fan-out phase carries no role of its own: its members run the agent the
  // task template names.
  const template =
    declaration.executor.kind === "task-frontier"
      ? registryValue<{ readonly role: string; readonly budgets: readonly ContextBudget[] }>(
          registryEntry(snapshot.taskTemplates, String(declaration.executor.template)),
        )
      : undefined;
  const executorRole = template?.role ?? declaration.executor.role;
  const executorBudgets = template?.budgets ?? declaration.executor.budgets;
  const roleEntry = registryEntry(snapshot.roles, executorRole);
  const role = registryValue<SnapshotAgentRole>(roleEntry);
  const modelPolicyEntry = registryEntry(snapshot.modelPolicies, role.modelPolicy);
  const modelPolicy = registryValue<SnapshotModelPolicy>(modelPolicyEntry);
  // An attempt that failed on its route gains nothing by repeating it, so each
  // retry falls to the next authored route. The last route is where retries
  // settle: a policy that runs out of alternatives still has to run somewhere.
  const routeIndex = Math.min(Math.max((input.attempt ?? 1) - 1, 0), modelPolicy.routes.length - 1);
  const route = modelPolicy.routes[routeIndex];
  if (route === undefined) throw new Error(`Model policy ${role.modelPolicy} declares no route`);
  const previousRoute = routeIndex === 0 ? undefined : modelPolicy.routes[routeIndex - 1];
  // The agent is told it changed model, because the same instruction can need
  // different handling on a different one, and a silent swap reads as the run
  // inexplicably changing its mind.
  const routeChange =
    previousRoute === undefined
      ? undefined
      : `${previousRoute.model} did not finish this work; you are ${route.model}`;
  const promptEntry = requiredPrompt(snapshot, role.prompt);
  const prompt = promptEntry;

  // A fan-out member reads its own element, computed when the members were
  // materialised and stored on the task. Everything else reads the workflow
  // input and its upstream phases.
  const member =
    template === undefined
      ? undefined
      : (taskNode.definition.input as unknown as {
          readonly value: CanonicalValue;
          readonly digest: Sha256Digest;
        });
  const upstream = member === undefined ? (input.upstream ?? []) : [];
  const sourceBindings: readonly MappingSourceBinding[] =
    member === undefined
      ? [
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
        ]
      : [
          {
            source: { kind: "current-item" as const },
            sourceBindingDigest: member.digest,
            value: member.value,
          },
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
      attempt,
    },
    graphRevisionDigest: snapshot.graph.revisionDigest,
    configurationSnapshotDigest: snapshot.snapshotDigest,
    executorDigest: roleEntry.digest,
    upstreamClosureSetDigest: upstreamSetDigest,
    upstreamOutputSetDigest: upstreamSetDigest,
    schema: runtimeSchemaContract(snapshot, declaration.input.schema, sha256),
    mappings: member === undefined ? declaration.input.mappings : MEMBER_ITEM_MAPPINGS,
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
      allowCurrentItem: member !== undefined,
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
      priorRefusals: [
        ...(input.priorRefusals ?? []),
        ...(routeChange === undefined ? [] : [routeChange]),
      ],
      capabilities,
      budgets: executorBudgets,
    },
    sha256,
  );

  const dispatchInput = {
    repositoryId: input.repositoryId,
    runId: kernelRunId(input.runId),
    ordinal: attempt,
    // A retry is a different worker identity, so an earlier attempt's principal
    // cannot submit against the attempt that replaced it.
    workerPrincipalId: `principal_${input.phaseKey}-${attempt}`,
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

  const routeSelection = createWorkerModelRouteSelection(
    {
      routeIndex,
      provider: route.provider,
      model: route.model,
      maxTurns: route.maxTurns,
      maxSubmissions: route.maxSubmissions,
      maxMillidollars: route.maxMillidollars,
      // The authored route is the answer unless a caller overrides it.
      maxAiCredits: input.maxAiCredits ?? route.maxAiCredits ?? 1,
    },
    context,
    dispatch,
    sha256,
  );

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { record: recordSession, session } = resolveSession({
    ledger: input.sessionLedger,
    scope: role.sessionScope ?? "attempt",
    maxTurns: role.sessionMaxTurns ?? DEFAULT_SESSION_MAX_TURNS,
    runId: input.runId,
    roleKey: role.key,
    isMember: declaration.executor.kind === "task-frontier",
    taskNodeId: String(taskNode.definition.id),
    context,
    dispatch,
    routeSelection,
    repositoryBase: input.repositoryBase,
    sha256,
  });
  const registered = input.contextBroker.registerDispatch({
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
        ...(session.resumed === undefined
          ? {}
          : {
              sessionResume: {
                scope: session.scope,
                requestedBinding: session.binding,
                authorizedBinding: session.resumed,
              },
            }),
      }),
      budgetReservation: { unit: "review-iteration", amount: 1 },
    },
  });
  recordSession();
  return { context, routeSelection, session, dispatch: registered };
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

/**
 * Decides which conversation this dispatch joins, and records the one it starts.
 *
 * A line is the unit of continuity. Two personas never share one, and neither do
 * two fan-out members of the same persona: a member is a leaf of work rather
 * than a thread of thought, so each gets its own conversation even under a
 * run-scoped role.
 */
function resolveSession(input: {
  readonly ledger: AgentSessionLedgerPort | undefined;
  readonly scope: AgentSessionScope;
  readonly maxTurns: number;
  readonly runId: string;
  readonly roleKey: string;
  readonly isMember: boolean;
  readonly taskNodeId: string;
  readonly context: WorkerContextBase;
  readonly dispatch: WorkerDispatch;
  readonly routeSelection: WorkerModelRouteSelection;
  readonly repositoryBase: {
    readonly commitDigest: Sha256Digest;
    readonly treeDigest: Sha256Digest;
  };
  readonly sha256: RuntimeDependencies["sha256"];
}): {
  readonly record: () => void;
  readonly session: DispatchPhaseResult["session"];
} {
  const { scope, ledger, sha256 } = input;
  const identity =
    scope === "phase" || input.isMember
      ? `${encodeURIComponent(input.roleKey)}/${encodeURIComponent(input.taskNodeId)}`
      : encodeURIComponent(input.roleKey);
  // Every part is escaped and joined by a character escaping removes, so no two
  // distinct lines can spell the same key. A NUL separator cannot be used: the
  // store truncates the text there, which would collapse every persona in a run
  // onto one line and let one resume into another's conversation.
  const lineKey = `${encodeURIComponent(input.runId)}/${scope}/${identity}`;

  // An attempt-scoped persona has no line to join, so nothing is looked up and
  // nothing is recorded: recording would imply a continuity that does not exist.
  const predecessor =
    scope === "attempt" || ledger === undefined
      ? undefined
      : ledger.queryLatestAgentSessionResumeBinding(lineKey);
  const turn =
    ledger === undefined || scope === "attempt" || predecessor === undefined
      ? 1
      : ledger.countAgentSessionResumeBindings(lineKey, predecessor.predecessorSessionId) + 1;

  const own = (sessionId: string): AgentSessionResumeBinding =>
    createAgentSessionResumeBinding(
      {
        predecessorDispatchId: input.dispatch.dispatchId,
        predecessorSessionId: sessionId,
        promptResourceDigest: input.dispatch.promptResource.resourceDigest,
        promptContentDigest: input.dispatch.promptResource.contentDigest,
        promptPackDigest: input.dispatch.promptPackDigest,
        mappedInputDigest: input.context.mappedInput.valueDigest,
        contextId: input.context.contextId,
        contextDigest: input.context.contextDigest,
        graphRevisionDigest: input.context.phaseAttempt.graphRevisionDigest,
        configurationSnapshotDigest: input.context.configurationSnapshotDigest,
        taskId: input.dispatch.task.taskId,
        taskGeneration: input.dispatch.task.definitionGeneration,
        modelSelectionDigest: input.routeSelection.selectionDigest,
        repositoryCommitDigest: input.repositoryBase.commitDigest,
        repositoryTreeDigest: input.repositoryBase.treeDigest,
      },
      sha256,
    );

  // The decision is taken here rather than left to the adapter, because a lost
  // session must be visible to the run as a degraded outcome. An adapter that
  // quietly starts over turns forgotten context into an unexplained regression.
  const candidate = own(predecessor?.predecessorSessionId ?? input.dispatch.dispatchId);
  // A conversation that never ends grows until it costs more than it is worth,
  // so one that has reached its bound is renewed rather than carried further.
  // This is a deliberate renewal, not the loss of a conversation whose ground
  // moved, and the two are reported differently because they mean different
  // things to somebody reading the run.
  const renewed = predecessor !== undefined && turn > input.maxTurns;
  const decision =
    predecessor === undefined || renewed
      ? undefined
      : decideAgentSessionResume(candidate, predecessor, sha256, scope);
  const resumed = decision?.action === "resume" ? predecessor : undefined;
  const sessionId = resumed?.predecessorSessionId ?? input.dispatch.dispatchId;
  const binding = resumed === undefined ? own(sessionId) : candidate;
  // A binding names the dispatch whose conversation it records, and the ledger
  // holds that reference, so it cannot be written until the dispatch exists.
  // Recording is handed back as a step the caller runs after registration.
  const record = () => {
    if (ledger !== undefined && scope !== "attempt")
      ledger.putAgentSessionResumeBinding(binding, lineKey);
  };
  return {
    record,
    session: Object.freeze({
      scope,
      lineKey,
      sessionId,
      turn,
      binding,
      ...(resumed === undefined ? {} : { resumed }),
      ...(renewed ? { renewedAfterTurns: input.maxTurns } : {}),
      ...(decision?.action === "new-session" ? { lost: decision.mismatchFields } : {}),
    }),
  };
}
