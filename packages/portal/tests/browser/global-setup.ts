import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeDependencies, startSenawaService } from "../../../../apps/senawa/dist/daemon.js";
import {
  bindGitObjectId,
  bindGitRevision,
  canonicalDigest,
  canonicalValue,
  compileWorkflowGraph,
  consumerKey,
  createAmendmentProposal,
  createIntegrationBarrier,
  createPhaseAttempt,
  createPhaseCandidate,
  createPhaseInputBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  defineGate,
  definitionGeneration,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  phaseId as kernelPhaseId,
  runId as kernelRunId,
  sha256Digest,
  taskId,
} from "../../../kernel/dist/index.js";
import {
  type CommandEnvelope,
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
} from "../../../protocol/dist/index.js";
import { type RuntimeDependencies, renderPromptPack } from "../../../runtime/dist/index.js";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "../../../storage-sqlite/dist/index.js";
import { HttpSupervisorClient, readPrivateCredential } from "../../../supervisor/dist/index.js";
import { runtimeCommand, runtimeFixture } from "../../../testing/dist/index.js";

const NOW = "2026-08-14T00:00:00.000Z";
const RUNS = Object.freeze({
  journey: "run_portal-journey",
  workspace: "run_portal-workspace",
});

let allocation = 0;
const productionSha256 = runtimeDependencies.sha256;

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = mkdtempSync(join(tmpdir(), "senawa-portal-browser-"));
  chmodSync(root, 0o700);
  const environment: NodeJS.ProcessEnv = {
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_STATE_HOME: join(root, "state"),
    SENAWA_PORTAL_MANIFEST: resolve("packages/portal/dist/manifest.json"),
    SENAWA_PORTAL_PORT: "0",
  };
  const databasePath = join(environment.XDG_STATE_HOME ?? root, "senawa", "authority.db");
  const assetDirectory = join(environment.XDG_STATE_HOME ?? root, "senawa", "assets");
  mkdirSync(join(environment.XDG_STATE_HOME ?? root, "senawa"), { recursive: true, mode: 0o700 });
  const dependencies: RuntimeDependencies = runtimeDependencies;
  const journeyDispatchId = seedAuthority({ databasePath, assetDirectory, dependencies });

  let sessionNow = Date.parse(NOW);
  const started = await startSenawaService(environment, {
    runtimeDependencies: dependencies,
    portalSessionClock: { now: () => sessionNow },
    scheduleBeforeEffects: () => ({ worked: false }),
  });
  const status = await started.service.status();
  const socketPath = status.listeners.find(({ kind }) => kind === "ipc")?.address;
  const origin = status.listeners.find(({ kind }) => kind === "loopback")?.address;
  if (socketPath === undefined || origin === undefined)
    throw new Error("Portal listeners are absent");
  const credential = readPrivateCredential(started.paths.credentialPath);
  const ipc = new HttpSupervisorClient({ socketPath, credential: credential.token });
  const control = await startControlServer({
    bootstrap: async () => `${origin}${(await ipc.createPortalSession()).path}`,
    advanceSession: () => {
      sessionNow += 9 * 60 * 60 * 1_000;
    },
    appendTranscript: () => appendJourneyTranscript(databasePath),
  });
  process.env.SENAWA_E2E_CONTROL_ORIGIN = control.origin;
  process.env.SENAWA_E2E_REPOSITORY_ID = repositoryForRun(RUNS.journey);
  process.env.SENAWA_E2E_RUNS = JSON.stringify(RUNS);
  process.env.SENAWA_E2E_JOURNEY_DISPATCH_ID = journeyDispatchId;

  return async () => {
    delete process.env.SENAWA_E2E_CONTROL_ORIGIN;
    delete process.env.SENAWA_E2E_REPOSITORY_ID;
    delete process.env.SENAWA_E2E_RUNS;
    delete process.env.SENAWA_E2E_JOURNEY_DISPATCH_ID;
    await closeServer(control.server);
    await started.service.stop();
    rmSync(root, { recursive: true, force: true });
  };
}

interface AuthorityOptions {
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly dependencies: RuntimeDependencies;
}

let liveTranscriptOrdinal = 0;

/**
 * Appends one durable line to the live run so a tail-following portal must
 * observe it. It writes the phase owner, which no absolute fixture count
 * depends on, because durable appends persist across browser projects.
 */
function appendJourneyTranscript(databasePath: string): string {
  liveTranscriptOrdinal += 1;
  const text = `live tail line ${liveTranscriptOrdinal}`;
  const broker = new SqliteContextBroker({
    databasePath,
    dependencies: {
      sha256: productionSha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32).fill(9),
    },
  });
  try {
    broker.appendTranscript({
      repositoryId: repositoryForRun(RUNS.journey),
      runId: RUNS.journey,
      owner: { kind: "phase", id: runtimeFixture.phase.phaseId },
      lineId: `live-${liveTranscriptOrdinal}`,
      occurredAt: new Date(Date.parse(NOW) + 900_000 + liveTranscriptOrdinal).toISOString(),
      stream: "stdout",
      text,
    });
  } finally {
    broker.close();
  }
  return text;
}

function seedAuthority(options: AuthorityOptions): string {
  const authority = new SqliteAuthority(options);
  const graph = portalGraph();
  const compactGraph = portalGraph(false);
  const journeyDispatchId = seedHumanRun(authority, options, graph, RUNS.journey, true);
  seedWorkspaceRun(authority, options, compactGraph);
  seedTranscripts(options, journeyDispatchId);
  authority.close();
  return journeyDispatchId;
}

/** Owner-scoped agent output so the terminal pane has durable authority to read. */
function seedTranscripts(options: AuthorityOptions, journeyDispatchId: string): void {
  const broker = new SqliteContextBroker({
    databasePath: options.databasePath,
    dependencies: {
      sha256: productionSha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32).fill(9),
    },
  });
  const append = (
    runId: string,
    owner: { readonly kind: "dispatch" | "task" | "phase"; readonly id: string },
    lines: readonly { readonly stream: "stdout" | "stderr" | "system"; readonly text: string }[],
  ) => {
    for (const [index, line] of lines.entries()) {
      broker.appendTranscript({
        repositoryId: repositoryForRun(runId),
        runId,
        owner,
        lineId: `${owner.kind}-${index + 1}`,
        occurredAt: new Date(Date.parse(NOW) + index * 1_000).toISOString(),
        stream: line.stream,
        text: line.text,
      });
    }
  };
  // The journey run is repository mode, where the dispatch is the only owner the
  // writer and the portal can agree on because no workspace row ever exists.
  append(RUNS.journey, { kind: "dispatch", id: journeyDispatchId }, [
    { stream: "system", text: "session started" },
    { stream: "stdout", text: "hostile line <script>blocked()</script></div> stays inert" },
    { stream: "stderr", text: "tool call refused: capability worker.write is absent" },
    ...Array.from({ length: 140 }, (_, index) => ({
      stream: "stdout" as const,
      text: `journey task output line ${index + 1}`,
    })),
    { stream: "system", text: "session ended completed" },
  ]);
  append(RUNS.journey, { kind: "phase", id: runtimeFixture.phase.phaseId }, [
    { stream: "system", text: "phase attempt 1 opened" },
    { stream: "stdout", text: "journey phase output line 1" },
  ]);
  append(RUNS.workspace, { kind: "task", id: runtimeFixture.task.taskId }, [
    { stream: "stdout", text: "workspace task-owned line that a dispatch scope must not show" },
  ]);
  append(RUNS.workspace, { kind: "dispatch", id: "dispatch-browser" }, [
    { stream: "system", text: "dispatch-browser session started" },
    { stream: "stdout", text: "workspace dispatch output line 1" },
  ]);
  broker.close();
}

function seedHumanRun(
  authority: SqliteAuthority,
  options: AuthorityOptions,
  graph: ReturnType<typeof portalGraph>,
  runId: string,
  withActivity: boolean,
): string {
  const suffix = runToken(runId);
  const repositoryId = repositoryForRun(runId);
  instantiate(authority, graph, runId, "repository", "approval-required");
  const worker = workerForRun(graph, runId, ["worker.submit.question", "worker.submit.asset"]);
  const broker = new SqliteContextBroker({
    databasePath: options.databasePath,
    dependencies: {
      sha256: productionSha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32).fill(7),
    },
  });
  broker.registerDispatch({
    context: worker.context,
    dispatch: worker.dispatch,
    completionRequirements: worker.completionRequirements,
    taskScope: taskScope(runId, worker.context.contextDigest),
  });
  const question = {
    prompt: `Choose the exact deployment target for ${runId} <script>blocked()</script>`,
    details: { choices: ["staging", "production"], markup: "<svg onload=blocked()>" },
  };
  broker.admitSubmission({
    submission: {
      apiVersion: PROTOCOL_VERSION,
      submissionId: `submission_question-${suffix}`,
      repositoryId,
      runId,
      dispatchId: worker.dispatch.dispatchId,
      task: worker.dispatch.task,
      contextId: worker.dispatch.contextId,
      contextDigest: worker.dispatch.contextDigest,
      principalId: worker.dispatch.worker.principalId,
      type: "question",
      question,
    },
  });
  seedArtifacts(authority, broker, worker, runId);
  broker.close();

  const amendment = amendmentProposal(graph, worker.context.contextDigest, runId);
  authority.putConfigurationSnapshot(amendment.baseSnapshot);
  authority.putConfigurationSnapshot(amendment.resultSnapshot);
  submit(
    authority,
    commandForRun(
      fixtureCommand({
        commandId: `command_amendment-${suffix}`,
        intent: "submit-amendment-proposal",
        payload: { proposal: amendment.proposal },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: amendment.proposal.proposalDigest,
      }),
      runId,
    ),
  );

  const completion = submit(
    authority,
    commandForRun(
      fixtureCommand({
        commandId: `command_completion-${suffix}`,
        intent: "submit-completion",
        payload: {
          submission: {
            task: worker.dispatch.task,
            disposition: "completed",
            summary: "Browser fixture completion",
            criteria: [{ criterionId: runtimeFixture.criterionId, disposition: "satisfied" }],
            evidence: [],
          },
        },
        expectedDefinitionRevision: worker.dispatch.task.contextRevisionDigest,
        expectedGraphRevision: graph.revisionDigest,
      }),
      runId,
    ),
  );
  if (completion.status !== "completed") {
    throw new Error(`Completion fixture was refused: ${JSON.stringify(completion)}`);
  }
  const assessment = (
    completion.result as { assessment: Parameters<typeof digestAccountingAssessment>[0] }
  ).assessment;
  const gateDefinition = defineGate(
    { key: consumerKey("release"), blocking: [], advisory: [] },
    productionSha256,
  );
  const candidate = createPhaseCandidate(
    {
      phase: runtimeFixture.phase,
      phaseAttempt: worker.context.phaseAttempt.phase,
      graphRevisionDigest: graph.revisionDigest,
      inputBindingDigest: worker.context.phaseInputBinding.bindingDigest,
      requiredOutputPublications: [],
      outputSetDigest: digestPhaseOutputSet([], productionSha256),
      selectedTaskSetDigest: digestSelectedTaskSet([worker.dispatch.task], productionSha256),
      tasks: [worker.dispatch.task],
      acceptedAccountingAssessments: [
        {
          assessmentDigest: digestAccountingAssessment(assessment, productionSha256),
          assessment,
        },
      ],
      dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
      gatePolicyDigest: gateDefinition.policyDigest,
    },
    graph,
    productionSha256,
  );
  const gate = submit(
    authority,
    commandForRun(
      fixtureCommand({
        commandId: `command_gate-${suffix}`,
        intent: "evaluate-gate",
        payload: {
          phase: runtimeFixture.phase,
          phaseAttempt: worker.context.phaseAttempt.phase,
          inputBindingDigest: worker.context.phaseInputBinding.bindingDigest,
          requiredOutputPublications: [],
          outputSetDigest: digestPhaseOutputSet([], productionSha256),
          dependencyBarrierDigest: runtimeFixture.dependencyBarrierDigest,
          gateDefinition,
          readings: [],
        },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
      runId,
    ),
  );
  if (gate.status !== "completed") {
    throw new Error(`Gate fixture was refused: ${JSON.stringify(gate)}`);
  }
  seedAllowance(authority, options, runId, worker.context.contextDigest, graph.revisionDigest);

  if (withActivity) {
    for (let index = 0; index < 30; index += 1) {
      submit(
        authority,
        commandForRun(
          fixtureCommand({
            commandId: `command_activity-${index}`,
            intent: "pause-run",
            payload: { expectedRunModeRevision: 900 + index },
            roles: ["reader"],
          }),
          runId,
        ),
      );
    }
  }
  return worker.dispatch.dispatchId;
}

function seedArtifacts(
  authority: SqliteAuthority,
  broker: SqliteContextBroker,
  worker: ReturnType<typeof workerForRun>,
  runId: string,
): void {
  const suffix = runToken(runId);
  const repositoryId = repositoryForRun(runId);
  const json = new TextEncoder().encode(
    JSON.stringify({
      hostile: "<script src=https://invalid.example/x.js></script><svg onload=blocked()>",
      nodes: Array.from({ length: 9_990 }, () => ""),
    }),
  );
  const text = new TextEncoder().encode("Verified text <img src=x onerror=blocked()>\n".repeat(50));
  const active = new TextEncoder().encode(
    "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
  );
  const assets = [
    { id: `asset_json-${suffix}`, bytes: json, mediaType: "application/json", install: true },
    { id: `asset_text-${suffix}`, bytes: text, mediaType: "text/plain", install: true },
    { id: `asset_active-${suffix}`, bytes: active, mediaType: "image/svg+xml", install: true },
    {
      id: `asset_missing-${suffix}`,
      bytes: new TextEncoder().encode("metadata only"),
      mediaType: "text/plain",
      install: false,
    },
  ] as const;
  for (const asset of assets) {
    const contentDigest = productionSha256.digest(asset.bytes);
    broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        submissionId: `submission_${asset.id.slice("asset_".length)}`,
        repositoryId,
        runId,
        dispatchId: worker.dispatch.dispatchId,
        task: worker.dispatch.task,
        contextId: worker.dispatch.contextId,
        contextDigest: worker.dispatch.contextDigest,
        principalId: worker.dispatch.worker.principalId,
        type: "asset",
        asset: {
          assetId: asset.id,
          contentDigest,
          byteLength: asset.bytes.byteLength,
          mediaType: asset.mediaType,
          sensitivity: "internal",
          summary: `${asset.id} <a href='https://invalid.example'>blocked link</a>`,
        },
      },
    });
    if (asset.install) authority.putAsset(asset.bytes, asset.mediaType);
  }
}

function seedAllowance(
  authority: SqliteAuthority,
  options: AuthorityOptions,
  runId: string,
  contextDigest: string,
  graphRevision: string,
): void {
  const suffix = runToken(runId);
  const repositoryId = repositoryForRun(runId);
  const runner = new SqliteRunnerAuthority(options);
  const lease = {
    owner: `runner-owner-${suffix}`,
    fence: 1,
    expiresAt: "2026-08-14T00:10:00.000Z",
  };
  runner.configureRun({
    repositoryId,
    runId,
    contextDigest,
    taskScopes: [{ ...taskScope(runId, contextDigest), claimsAccepted: true }],
    budgets: [{ unit: "model-millidollars", limit: 1 }],
    lease,
  });
  runner.bindAllowancePolicy(repositoryId, runId, runtimeFixture.allowancePolicy);
  const command = {
    sequence: 1,
    commandId: `runner-command-${suffix}`,
    repositoryId,
    runId,
    operationId: `operation-${suffix}`,
    kind: "worker" as const,
    taskScope: taskScope(runId, contextDigest),
    contextDigest,
    inputDigest: "b".repeat(64),
    input: { dispatchId: `dispatch-${suffix}` },
    budgetReservation: { unit: "model-millidollars", amount: 5 },
    queuedAt: NOW,
    maxReconciliationAttempts: 2,
  };
  runner.enqueue(command);
  const result = runner.persistIntent({
    repositoryId,
    runId,
    lease,
    currentTime: NOW,
    attemptId: `attempt-${suffix}`,
    command,
  });
  if (result.type !== "escalated") throw new Error("Allowance fixture did not escalate");
  if (graphRevision.length !== 64) throw new Error("Graph revision fixture is invalid");
  runner.close();
  void authority;
}

function seedWorkspaceRun(
  authority: SqliteAuthority,
  options: AuthorityOptions,
  graph: ReturnType<typeof portalGraph>,
): void {
  instantiate(authority, graph, RUNS.workspace, "worktree");
  const repositoryId = repositoryForRun(RUNS.workspace);
  const runner = new SqliteRunnerAuthority(options);
  runner.configureRun({
    repositoryId,
    runId: RUNS.workspace,
    contextDigest: runtimeFixture.task.contextRevisionDigest,
    taskScopes: [
      {
        ...taskScope(RUNS.workspace, runtimeFixture.task.contextRevisionDigest),
        claimsAccepted: true,
      },
    ],
    budgets: [{ unit: "model-millidollars", limit: 10 }],
    lease: {
      owner: "runner-owner-workspace",
      fence: 1,
      expiresAt: "2026-08-14T00:10:00.000Z",
    },
  });
  runner.bindAllowancePolicy(repositoryId, RUNS.workspace, runtimeFixture.allowancePolicy);
  runner.close();
  const workspace = new SqliteWorkspaceIntegrationAuthority(options);
  workspace.bindRunExecution({
    repositoryId,
    runId: RUNS.workspace,
    configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
    execution: {
      workspaceMode: "worktree",
      maxWriterConcurrency: 2,
      failurePolicy: "continue",
      integrationRef: "refs/heads/senawa/integration",
    },
    allowancePolicy: runtimeFixture.allowancePolicy,
  });
  const baseRevision = gitRevision("1", "2");
  const resultRevision = gitRevision("3", "4");
  const workspaceRecord = workspace.persistWorkspaceIntent({
    repositoryId,
    runId: RUNS.workspace,
    workspaceId: "workspace-browser",
    dispatchId: "dispatch-browser",
    taskId: runtimeFixture.task.taskId,
    definitionGeneration: 1,
    baseRevision,
    prepareEffectId: "effect-prepare-browser",
    inspectEffectId: "effect-inspect-browser",
  });
  workspace.recordWorkspaceState(
    repositoryId,
    RUNS.workspace,
    workspaceRecord.workspaceId,
    "prepared",
  );
  const result = workspace.persistWorkspaceResult({
    repositoryId,
    runId: RUNS.workspace,
    resultId: "result-browser",
    workspaceId: workspaceRecord.workspaceId,
    resultRevision,
    completionFactDigest: "5".repeat(64),
    captureEffectId: "effect-capture-browser",
    inspectEffectId: "effect-result-browser",
    recordedAt: NOW,
  });
  const barrier = createIntegrationBarrier(
    {
      phaseId: runtimeFixture.phase.phaseId,
      definitionGeneration: runtimeFixture.phase.definitionGeneration,
      graphRevisionDigest: graph.revisionDigest,
      targetRef: "refs/heads/senawa/integration",
      beforeRevision: baseRevision,
      afterRevision: resultRevision,
      members: [
        {
          taskId: runtimeFixture.task.taskId,
          definitionGeneration: runtimeFixture.task.definitionGeneration,
          contextDigest: runtimeFixture.task.contextRevisionDigest,
          baseRevisionDigest: bindGitRevision(baseRevision, productionSha256).descriptorDigest,
          resultTreeDigest: bindGitObjectId(resultRevision.tree, productionSha256).descriptorDigest,
          completionFactDigest: "5".repeat(64) as ReturnType<typeof sha256Digest>,
        },
      ],
      gatePolicyDigest: "8".repeat(64) as ReturnType<typeof sha256Digest>,
      gateReadingDigest: "9".repeat(64) as ReturnType<typeof sha256Digest>,
      gateEvaluationDigest: "a".repeat(64) as ReturnType<typeof sha256Digest>,
      outcome: "integrated",
    },
    productionSha256,
  );
  const member = barrier.members[0];
  if (member === undefined) throw new Error("Integration barrier member is absent");
  for (const [integrationId, terminal] of [
    ["integration-attempt-1-conflict", "conflicted"],
    ["integration-rework-2-required", "rework-required"],
  ] as const) {
    workspace.persistIntegrationIntent({
      repositoryId,
      runId: RUNS.workspace,
      integrationId,
      phaseId: barrier.phaseId,
      definitionGeneration: barrier.definitionGeneration,
      targetRef: barrier.targetRef,
      fanInDigest: barrier.fanInDigest,
      members: [{ workspaceId: workspaceRecord.workspaceId, resultId: result.resultId, member }],
      prepareEffectId: `effect-prepare-${integrationId}`,
      inspectEffectId: `effect-inspect-${integrationId}`,
    });
    const ownerId = `owner-${integrationId}`;
    const claim = workspace.claimIntegrationSlot({
      repositoryId,
      runId: RUNS.workspace,
      integrationId,
      ownerId,
      currentTime: NOW,
      expiresAt: "2026-08-14T13:00:00.000Z",
    });
    if (claim.type !== "claimed") throw new Error("Integration fixture was not claimed");
    const fence = claim.attempt.fence;
    if (fence === undefined) throw new Error("Integration fixture fence is absent");
    workspace.recordIntegrationState(
      repositoryId,
      RUNS.workspace,
      integrationId,
      "candidate-created",
      ownerId,
      fence,
      NOW,
    );
    if (terminal === "conflicted") {
      workspace.recordIntegrationState(
        repositoryId,
        RUNS.workspace,
        integrationId,
        terminal,
        ownerId,
        fence,
        NOW,
      );
    } else {
      workspace.recordIntegrationState(
        repositoryId,
        RUNS.workspace,
        integrationId,
        "validating",
        ownerId,
        fence,
        NOW,
      );
      workspace.recordIntegrationGate(
        repositoryId,
        RUNS.workspace,
        integrationId,
        {
          policyDigest: "8".repeat(64),
          readingDigest: "9".repeat(64),
          evaluationDigest: "a".repeat(64),
          decision: "failed",
          evidence: { sanitized: "<script>inert</script>" },
        },
        ownerId,
        fence,
        NOW,
      );
      workspace.recordIntegrationState(
        repositoryId,
        RUNS.workspace,
        integrationId,
        terminal,
        ownerId,
        fence,
        NOW,
      );
    }
  }
  workspace.close();
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture phase is missing");
  return value;
}

/**
 * Phases preceding the delivery phase, chained the way a real workflow depends.
 *
 * Their identifiers are deliberately not in execution order, because digest
 * order is what the authority pages nodes in. A fixture whose two orders agree
 * cannot detect a view that renders the workflow backwards.
 */
const UPSTREAM_PHASES = Object.freeze([
  { key: "define", id: kernelPhaseId("phase_zz-define") },
  { key: "research", id: kernelPhaseId("phase_mm-research") },
  { key: "plan", id: kernelPhaseId("phase_aa-plan") },
  { key: "implement", id: kernelPhaseId("phase_ff-implement") },
]);

/** Phase keys in the order the workflow runs them. */
export const PHASE_EXECUTION_ORDER = Object.freeze([
  ...UPSTREAM_PHASES.map(({ key }) => key),
  "delivery",
]);

function portalGraph(hostile = true) {
  return compileWorkflowGraph(
    {
      workflow: {
        id: runtimeFixture.workflowId,
        key: consumerKey("portal"),
        generation: definitionGeneration(1),
        source: { locator: "fixture://portal", pointer: "" },
      },
      phases: [
        ...UPSTREAM_PHASES.map((phase, index) => ({
          id: phase.id,
          key: consumerKey(phase.key),
          generation: definitionGeneration(1),
          parentId: runtimeFixture.workflowId,
          source: { locator: "fixture://portal", pointer: `/phases/${phase.key}` },
          ...(index === 0 ? {} : { dependsOn: [required(UPSTREAM_PHASES[index - 1]).id] }),
        })),
        {
          id: runtimeFixture.phase.phaseId,
          key: consumerKey("delivery"),
          generation: runtimeFixture.phase.definitionGeneration,
          parentId: runtimeFixture.workflowId,
          source: { locator: "fixture://portal", pointer: "/phases/delivery" },
          dependsOn: [required(UPSTREAM_PHASES.at(-1)).id],
        },
      ],
      executableWork: [
        {
          id: runtimeFixture.task.taskId,
          key: consumerKey("verify"),
          generation: runtimeFixture.task.definitionGeneration,
          parentId: runtimeFixture.phase.phaseId,
          source: { locator: "fixture://portal", pointer: "/tasks/verify" },
          completionPolicy: {
            criteria: [{ criterionId: runtimeFixture.criterionId, required: true }],
            evidencePolicy: { mode: "none", requirements: [] },
          },
          input: hostile
            ? {
                hostile:
                  "<script>blocked()</script><svg onload=blocked()><a href=https://invalid.example>blocked</a>",
                long: "x".repeat(4_200),
              }
            : {},
        },
      ],
      criteria: [
        {
          id: runtimeFixture.criterionId,
          key: consumerKey("verified"),
          generation: definitionGeneration(1),
          parentId: runtimeFixture.task.taskId,
          source: { locator: "fixture://portal", pointer: "/criteria/verified" },
        },
      ],
    },
    productionSha256,
  );
}

function workerForRun(
  graph: ReturnType<typeof portalGraph>,
  runId: string,
  capabilities: readonly string[],
) {
  const suffix = runToken(runId);
  const task = {
    taskId: runtimeFixture.task.taskId,
    definitionGeneration: runtimeFixture.task.definitionGeneration,
  };
  const mappedValue = canonicalValue({ request: `portal fixture ${suffix}` });
  const mappedInput = {
    value: mappedValue,
    valueDigest: canonicalDigest(mappedValue, productionSha256),
  };
  const phase = { ...runtimeFixture.phase, attempt: 1 };
  const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), productionSha256);
  const phaseInputBinding = createPhaseInputBinding(
    {
      phase,
      schemaKey: consumerKey("portal-input"),
      schemaResourceDigest: sha256Digest("6".repeat(64)),
      mappings: [],
      contentDigest: mappedInput.valueDigest,
      byteLength: canonicalBytes(mappedValue).byteLength,
      validationReceiptDigest: sha256Digest("7".repeat(64)),
      sourceSetDigest,
    },
    productionSha256,
  );
  const phaseAttempt = createPhaseAttempt(
    {
      repositoryId: repositoryForRun(runId),
      runId: kernelRunId(runId),
      phase,
      inputBindingDigest: phaseInputBinding.bindingDigest,
      sourceSetDigest,
      executorDigest: sha256Digest("8".repeat(64)),
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      upstreamClosureSetDigest: sha256Digest("9".repeat(64)),
      upstreamOutputSetDigest: sha256Digest("0".repeat(64)),
    },
    productionSha256,
  );
  const promptText = "Review request $" + "{{ input.request }}\n";
  const promptBytes = new TextEncoder().encode(promptText);
  const promptContentDigest = sha256Digest(productionSha256.digest(promptBytes));
  const promptKey = consumerKey("portal-prompt");
  const promptSource = {
    path: "prompts/portal.md",
    mediaType: "text/markdown; charset=utf-8",
    byteLength: promptBytes.byteLength,
    contentDigest: promptContentDigest,
    utf8: promptText,
  } as const;
  const configuredPrompt = {
    key: promptKey,
    path: promptSource.path,
    resourceDigest: canonicalDigest(
      canonicalValue({ key: promptKey, source: promptSource, inputPaths: ["/request"] }),
      productionSha256,
    ),
    contentDigest: promptContentDigest,
    byteLength: promptBytes.byteLength,
    utf8: promptText,
    inputPaths: ["/request"],
  };
  const context = createWorkerContextBase(
    {
      task,
      graphRevisionDigest: graph.revisionDigest,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      contracts: [],
      dependencyBarrier: { task, dependencies: [] },
      assets: [],
      repositoryBase: {
        commitDigest: "1".repeat(64) as ReturnType<typeof sha256Digest>,
        treeDigest: "2".repeat(64) as ReturnType<typeof sha256Digest>,
      },
      modelPolicy: {
        key: consumerKey("worker-policy"),
        policyDigest: "3".repeat(64) as ReturnType<typeof sha256Digest>,
        orderedRoutesDigest: "4".repeat(64) as ReturnType<typeof sha256Digest>,
      },
      role: {
        key: consumerKey("implementer"),
        roleDigest: "5".repeat(64) as ReturnType<typeof sha256Digest>,
      },
      prompt: configuredPrompt,
      mappedInput,
      phaseAttempt,
      phaseInputBinding,
      phaseOutputDeclarations: [],
      capabilities,
      budgets: [{ unit: "spend-nano", limit: 2_000 }],
    },
    productionSha256,
  );
  const input = {
    repositoryId: repositoryForRun(runId),
    runId: kernelRunId(runId),
    ordinal: 1,
    workerPrincipalId: `principal_${suffix}`,
    roleKey: consumerKey("implementer"),
    capabilities,
    promptResource: {
      key: configuredPrompt.key,
      resourceDigest: configuredPrompt.resourceDigest,
      contentDigest: configuredPrompt.contentDigest,
    },
    promptPackDigest: "0".repeat(64) as ReturnType<typeof sha256Digest>,
  };
  const provisional = createWorkerDispatch(input, context, productionSha256);
  const prompt = renderPromptPack(context, provisional, productionSha256, 65_536);
  const dispatch = createWorkerDispatch(
    { ...input, promptPackDigest: prompt.digest },
    context,
    productionSha256,
  );
  const completionRequirements = deriveCompletionRequirements(
    graph,
    [dispatch.task],
    productionSha256,
  )[0];
  if (completionRequirements === undefined) throw new Error("Worker requirements are absent");
  return { context, dispatch, completionRequirements };
}

function instantiate(
  authority: SqliteAuthority,
  graph: ReturnType<typeof portalGraph>,
  runId: string,
  workspaceMode: "repository" | "worktree",
  approvalPolicy: "no-approval" | "approval-required" = "no-approval",
): void {
  const suffix = runToken(runId);
  submit(
    authority,
    commandForRun(
      fixtureCommand({
        commandId: `command_instantiate-${suffix}`,
        intent: "instantiate-run",
        payload: {
          workflowId: runtimeFixture.workflowId,
          configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
          execution:
            workspaceMode === "repository"
              ? runtimeFixture.execution
              : {
                  workspaceMode: "worktree",
                  maxWriterConcurrency: 2,
                  failurePolicy: "continue",
                  integrationRef: "refs/heads/senawa/integration",
                },
          graph,
          phase: runtimeFixture.phase,
          approvalPolicy:
            approvalPolicy === "no-approval"
              ? { policy: "no-approval" }
              : {
                  policy: "approval-required",
                  authority: fixtureCommand({
                    commandId: "command_principal-template",
                    intent: "pause-run",
                    payload: { expectedRunModeRevision: 0 },
                  }).principal,
                },
          escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
          allowancePolicy: runtimeFixture.allowancePolicy,
        },
      }),
      runId,
    ),
  );
}

function amendmentProposal(
  graph: ReturnType<typeof portalGraph>,
  contextDigest: string,
  runId: string,
) {
  const baseSnapshot = configurationSnapshot(graph);
  const provisional = createAmendmentProposal(
    amendmentInput(graph, contextDigest, baseSnapshot.snapshotDigest, "f".repeat(64), runId),
    productionSha256,
  );
  const resultSnapshot = configurationSnapshot(provisional.reviewedResultGraph);
  const proposal = createAmendmentProposal(
    amendmentInput(
      graph,
      contextDigest,
      baseSnapshot.snapshotDigest,
      resultSnapshot.snapshotDigest,
      runId,
    ),
    productionSha256,
  );
  return { baseSnapshot, resultSnapshot, proposal };
}

function amendmentInput(
  graph: ReturnType<typeof portalGraph>,
  contextDigest: string,
  baseSnapshotDigest: string,
  resultSnapshotDigest: string,
  runId: string,
) {
  return {
    source: {
      kind: "human" as const,
      request: `Add sanitized package verification for ${runId} <script>blocked()</script>`,
    },
    baseGraph: graph,
    baseContextDigest: sha256Digest(contextDigest),
    baseConfigurationSnapshotDigest: sha256Digest(baseSnapshotDigest),
    resultConfigurationSnapshotDigest: sha256Digest(resultSnapshotDigest),
    operations: [
      {
        kind: "add-task" as const,
        task: {
          id: taskId("task_package"),
          key: consumerKey("package"),
          generation: definitionGeneration(1),
          parentId: runtimeFixture.phase.phaseId,
          dependsOn: [runtimeFixture.task.taskId],
          source: { locator: "fixture://amendment", pointer: "/tasks/package" },
          completionPolicy: {
            criteria: [],
            evidencePolicy: { mode: "none" as const, requirements: [] },
          },
        },
        criteria: [],
      },
    ],
    phaseCandidateHistory: [],
  };
}

function configurationSnapshot(graph: ReturnType<typeof portalGraph>) {
  const empty = Object.freeze([]);
  const emptyDigest = canonicalDigest(canonicalValue(empty), productionSha256);
  const promptKey = consumerKey("portal-prompt");
  const promptUtf8 = "Review portal fixture metadata.\n";
  const promptBytes = new TextEncoder().encode(promptUtf8);
  const promptSource = canonicalValue({
    path: "prompts/portal.md",
    mediaType: "text/markdown; charset=utf-8",
    byteLength: promptBytes.byteLength,
    contentDigest: sha256Digest(productionSha256.digest(promptBytes)),
    utf8: promptUtf8,
  });
  const promptContent = canonicalValue({ key: promptKey, source: promptSource, inputPaths: [] });
  const prompts = canonicalValue([
    { ...promptContent, digest: canonicalDigest(promptContent, productionSha256) },
  ]);
  const execution = Object.freeze({
    workspaceMode: "repository",
    maxWriterConcurrency: 1,
    failurePolicy: "continue",
  });
  const content = {
    apiVersion: "senawa.dev/configuration-snapshot/v1",
    execution,
    graph,
    prompts,
    schemas: empty,
    roles: empty,
    modelPolicies: empty,
    sensors: empty,
    gates: empty,
    implementationEvidenceViews: empty,
    phaseDataflow: empty,
    forEach: empty,
    taskTemplates: empty,
    componentDigests: {
      execution: canonicalDigest(canonicalValue(execution), productionSha256),
      graph: canonicalDigest(canonicalValue(graph), productionSha256),
      prompts: canonicalDigest(prompts, productionSha256),
      schemas: emptyDigest,
      roles: emptyDigest,
      modelPolicies: emptyDigest,
      sensors: emptyDigest,
      gates: emptyDigest,
      implementationEvidenceViews: emptyDigest,
      phaseDataflow: emptyDigest,
      forEach: emptyDigest,
      taskTemplates: emptyDigest,
    },
  };
  return canonicalValue({
    ...content,
    snapshotDigest: canonicalDigest(canonicalValue(content), productionSha256),
  }) as unknown as typeof content & { readonly snapshotDigest: string };
}

function commandForRun(command: CommandEnvelope, runId: string): CommandEnvelope {
  return decodeCommandEnvelope({
    ...command,
    repositoryId: repositoryForRun(runId),
    runId,
    transport: { kind: "cli", requestId: `request_${command.commandId}` },
  });
}

function fixtureCommand(input: Parameters<typeof runtimeCommand>[0]): CommandEnvelope {
  const command = runtimeCommand(input);
  return decodeCommandEnvelope({
    ...command,
    payloadDigest: productionSha256.digest(canonicalBytes(command.payload)),
  });
}

function submit(authority: SqliteAuthority, command: CommandEnvelope) {
  return authority.submit(command, {
    currentTime: NOW,
    facts: { source: "portal-browser-fixture" },
    allocateId: () => `stream-event-browser-${++allocation}`,
  });
}

function taskScope(runId: string, contextDigest: string) {
  return {
    runId,
    taskId: runtimeFixture.task.taskId,
    definitionGeneration: runtimeFixture.task.definitionGeneration,
    acceptedContextDigest: contextDigest,
    fenceGeneration: 1,
  };
}

function runToken(runId: string): string {
  if (!runId.startsWith("run_")) throw new Error("Fixture run identity is invalid");
  return runId.slice("run_".length);
}

function repositoryForRun(runId: string): string {
  return `repository_${runToken(runId)}`;
}

function gitRevision(commit: string, tree: string) {
  return {
    commit: { objectFormat: "sha1" as const, oid: commit.repeat(40) },
    tree: { objectFormat: "sha1" as const, oid: tree.repeat(40) },
  };
}

async function startControlServer(actions: {
  readonly bootstrap: () => Promise<string>;
  readonly advanceSession: () => void;
  readonly appendTranscript: () => string;
}): Promise<{ readonly origin: string; readonly server: Server }> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/bootstrap") {
        return json(response, 200, { url: await actions.bootstrap() });
      }
      if (request.method === "POST" && request.url === "/advance-session") {
        actions.advanceSession();
        return json(response, 204, {});
      }
      if (request.method === "POST" && request.url === "/append-transcript") {
        return json(response, 200, { text: actions.appendTranscript() });
      }
      return json(response, 404, { error: "not-found" });
    } catch (error) {
      return json(response, 500, {
        error: error instanceof Error ? error.message : "fixture-error",
      });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Control server has no port");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  const value = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(value),
  });
  response.end(value);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
    server.closeAllConnections();
  });
}
