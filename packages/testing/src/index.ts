import {
  canonicalDigest,
  canonicalValue,
  compileWorkflowGraph,
  consumerKey,
  createPhaseAttempt,
  createPhaseInputBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  createWorkerModelRouteSelection,
  criterionId,
  definitionGeneration,
  deriveCompletionRequirements,
  runId as kernelRunId,
  phaseId,
  type Sha256,
  sha256Digest,
  taskId,
  workflowId,
} from "@senawa/kernel";
import {
  type CommandEnvelope,
  type CommandIntent,
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { type AdmissionFacts, type AllocationKind, renderPromptPack } from "@senawa/runtime";

export interface DeterministicSequence {
  next(): string;
}

export function createSequence(prefix: string): DeterministicSequence {
  let value = 0;
  return {
    next() {
      value += 1;
      return `${prefix}-${value}`;
    },
  };
}

export const deterministicSha256: Sha256 = Object.freeze({
  digest(bytes: Uint8Array): string {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) {
      accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    }
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
});

export const runtimeFixture = Object.freeze({
  repositoryId: "repository_fixture",
  runId: "run_fixture",
  workflowId: workflowId("workflow_fixture"),
  phase: Object.freeze({
    phaseId: phaseId("phase_delivery"),
    definitionGeneration: definitionGeneration(1),
  }),
  task: Object.freeze({
    taskId: taskId("task_verify"),
    definitionGeneration: definitionGeneration(1),
    contextRevisionDigest: sha256Digest("a".repeat(64)),
  }),
  criterionId: criterionId("criterion_verified"),
  dependencyBarrierDigest: sha256Digest("b".repeat(64)),
  escalationPolicyDigest: sha256Digest("c".repeat(64)),
  allowancePolicy: Object.freeze({
    policyDigest: sha256Digest("c".repeat(64)),
    ceilings: Object.freeze([
      Object.freeze({ unit: "model-millidollars", maximum: 10_000 }),
      Object.freeze({ unit: "spend-nano", maximum: 10_000 }),
    ]),
  }),
  configurationSnapshotDigest: sha256Digest("d".repeat(64)),
  execution: Object.freeze({
    workspaceMode: "repository" as const,
    maxWriterConcurrency: 1,
    failurePolicy: "continue" as const,
  }),
  currentTime: "2026-08-12T12:00:00.000Z",
});

export const runtimePrincipal = Object.freeze({
  issuer: "https://issuer.example.test",
  subject: "user_fixture",
  tenant: "tenant_fixture",
  assurance: "multi-factor" as const,
  roles: Object.freeze(["release-manager"]),
});

export function createRuntimeGraph(revision = 1) {
  return compileWorkflowGraph(
    {
      workflow: {
        id: runtimeFixture.workflowId,
        key: consumerKey("fixture"),
        generation: definitionGeneration(1),
        source: { locator: "fixture://runtime", pointer: "" },
      },
      phases: [
        {
          id: runtimeFixture.phase.phaseId,
          key: consumerKey("delivery"),
          generation: runtimeFixture.phase.definitionGeneration,
          parentId: runtimeFixture.workflowId,
          source: { locator: "fixture://runtime", pointer: "/phases/delivery" },
        },
      ],
      executableWork: [
        {
          id: runtimeFixture.task.taskId,
          key: consumerKey("verify"),
          generation: runtimeFixture.task.definitionGeneration,
          parentId: runtimeFixture.phase.phaseId,
          source: { locator: "fixture://runtime", pointer: "/tasks/verify" },
          completionPolicy: {
            criteria: [{ criterionId: runtimeFixture.criterionId, required: true }],
            completionEvidencePolicy: { mode: "none", requirements: [] },
          },
          input: { revision },
        },
      ],
      criteria: [
        {
          id: runtimeFixture.criterionId,
          key: consumerKey("verified"),
          generation: definitionGeneration(1),
          parentId: runtimeFixture.task.taskId,
          source: { locator: "fixture://runtime", pointer: "/criteria/verified" },
        },
      ],
    },
    deterministicSha256,
  );
}

export function createWorkerExecutionFixture(
  graph = createRuntimeGraph(),
  capabilities: readonly string[] = ["worker.submit.completion"],
  ordinal = 1,
) {
  const contextTask = {
    taskId: runtimeFixture.task.taskId,
    definitionGeneration: runtimeFixture.task.definitionGeneration,
  };
  const mappedInput = testingMappedInput(deterministicSha256);
  const phaseAttemptReference = { ...runtimeFixture.phase, attempt: 1 };
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), deterministicSha256);
  const phaseInputBinding = createPhaseInputBinding(
    {
      phase: phaseAttemptReference,
      schemaKey: consumerKey("worker-input"),
      schemaResourceDigest: sha256Digest("6".repeat(64)),
      mappings: [],
      contentDigest: mappedInput.valueDigest,
      byteLength: new TextEncoder().encode(JSON.stringify(mappedInput.value)).byteLength,
      validationReceiptDigest: sha256Digest("7".repeat(64)),
      sourceSetDigest,
    },
    deterministicSha256,
  );
  const phaseAttempt = createPhaseAttempt(
    {
      repositoryId: runtimeFixture.repositoryId,
      runId: kernelRunId(runtimeFixture.runId),
      phase: phaseAttemptReference,
      inputBindingDigest: phaseInputBinding.bindingDigest,
      sourceSetDigest,
      executorDigest: sha256Digest("8".repeat(64)),
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      upstreamClosureSetDigest: sha256Digest("9".repeat(64)),
      upstreamOutputSetDigest: sha256Digest("0".repeat(64)),
    },
    deterministicSha256,
  );
  const context = createWorkerContextBase(
    {
      task: contextTask,
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: sha256Digest("d".repeat(64)),
      contracts: [],
      dependencyBarrier: { task: contextTask, dependencies: [] },
      assets: [],
      repositoryBase: {
        commitDigest: sha256Digest("1".repeat(64)),
        treeDigest: sha256Digest("2".repeat(64)),
      },
      modelPolicy: {
        key: consumerKey("worker-policy"),
        policyDigest: sha256Digest("3".repeat(64)),
        orderedRoutesDigest: sha256Digest("4".repeat(64)),
      },
      role: { key: consumerKey("implementer"), roleDigest: sha256Digest("5".repeat(64)) },
      prompt: testingPrompt(deterministicSha256),
      mappedInput,
      phaseAttempt,
      phaseInputBinding,
      phaseOutputDeclarations: [
        {
          outputName: consumerKey("verification"),
          schemaKey: consumerKey("verification-output"),
          schemaResourceDigest: sha256Digest("6".repeat(64)),
          maxBytes: 262_144,
          sensitivity: "internal",
        },
      ],
      completionPolicy: {
        criteria: [{ criterionId: runtimeFixture.criterionId, required: true }],
        completionEvidencePolicy: { mode: "none", requirements: [] },
      },
      priorRefusals: [],
      answeredQuestions: [],
      capabilities,
      budgets: [{ unit: "work-attempt", limit: 2_000 }],
    },
    deterministicSha256,
  );
  const dispatchInput = {
    repositoryId: runtimeFixture.repositoryId,
    runId: kernelRunId(runtimeFixture.runId),
    ordinal,
    workerPrincipalId: "principal_worker",
    roleKey: consumerKey("implementer"),
    capabilities,
    promptResource: testingPromptReference(deterministicSha256),
    promptPackDigest: sha256Digest("0".repeat(64)),
  };
  const provisional = createWorkerDispatch(dispatchInput, context, deterministicSha256);
  const prompt = renderPromptPack(context, provisional, deterministicSha256, 65_536);
  const dispatch = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: prompt.digest },
    context,
    deterministicSha256,
  );
  const routeSelection = createWorkerModelRouteSelection(
    {
      routeIndex: 0,
      provider: "github-copilot",
      model: "gpt-5-mini",
      maxTurns: 4,
      maxSubmissions: 4,
      maxMillidollars: 2_000,
      maxAiCredits: 1,
    },
    context,
    dispatch,
    deterministicSha256,
  );
  const completionRequirements = deriveCompletionRequirements(
    graph,
    [dispatch.task],
    deterministicSha256,
  )[0];
  if (completionRequirements === undefined)
    throw new Error("Missing fixture completion requirements");
  return Object.freeze({ context, dispatch, routeSelection, completionRequirements });
}

function testingPrompt(sha256: Sha256) {
  const key = consumerKey("implementer-prompt");
  const path = "prompts/implementer.md";
  const utf8 = "Complete the assigned work.\n";
  const bytes = new TextEncoder().encode(utf8);
  const contentDigest = sha256Digest(sha256.digest(bytes));
  const inputPaths: readonly string[] = [];
  const source = {
    path,
    mediaType: "text/markdown; charset=utf-8",
    byteLength: bytes.byteLength,
    contentDigest,
    utf8,
  };
  return {
    key,
    path,
    resourceDigest: canonicalDigest(canonicalValue({ key, source, inputPaths }), sha256),
    contentDigest,
    byteLength: bytes.byteLength,
    utf8,
    inputPaths,
  };
}

function testingPromptReference(sha256: Sha256) {
  const prompt = testingPrompt(sha256);
  return {
    key: prompt.key,
    resourceDigest: prompt.resourceDigest,
    contentDigest: prompt.contentDigest,
  };
}

function testingMappedInput(sha256: Sha256) {
  const value = canonicalValue({});
  return { value, valueDigest: canonicalDigest(value, sha256) };
}

export function createAdmissionFixture(): {
  at(currentTime?: string): AdmissionFacts;
} {
  let approval = 0;
  let streamEvent = 0;
  return {
    at(currentTime = runtimeFixture.currentTime): AdmissionFacts {
      return {
        currentTime,
        facts: { source: "runtime-conformance" },
        allocateId(kind: AllocationKind): string {
          if (kind === "approval") {
            approval += 1;
            return `approval_fixture-${approval}`;
          }
          streamEvent += 1;
          return `stream-event-${streamEvent}`;
        },
      };
    },
  };
}

export interface RuntimeCommandFixtureInput {
  readonly commandId: string;
  readonly intent: CommandIntent["type"];
  readonly payload: unknown;
  readonly expectedDefinitionRevision?: string;
  readonly expectedGraphRevision?: string;
  readonly exactObjectDigest?: string;
  readonly expiresAt?: string;
  readonly roles?: readonly string[];
}

export function runtimeCommand(input: RuntimeCommandFixtureInput): CommandEnvelope {
  const payloadDigest = deterministicSha256.digest(canonicalBytes(input.payload));
  return decodeCommandEnvelope({
    apiVersion: PROTOCOL_VERSION,
    commandId: input.commandId,
    principal: { ...runtimePrincipal, roles: input.roles ?? runtimePrincipal.roles },
    transport: { kind: "cli", requestId: `request_${input.commandId}` },
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    intent: { type: input.intent },
    payload: input.payload,
    payloadDigest,
    ...(input.expectedDefinitionRevision === undefined
      ? {}
      : { expectedDefinitionRevision: input.expectedDefinitionRevision }),
    ...(input.expectedGraphRevision === undefined
      ? {}
      : { expectedGraphRevision: input.expectedGraphRevision }),
    ...(input.exactObjectDigest === undefined
      ? {}
      : { exactObjectDigest: input.exactObjectDigest }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  });
}

export * from "./runner-conformance.js";
