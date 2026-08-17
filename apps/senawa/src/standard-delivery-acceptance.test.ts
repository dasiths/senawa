import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIGURATION_SNAPSHOT_API_VERSION,
  type ConfigurationRegistryEntry,
  type ConfigurationSnapshot,
  compileWorkflowConfiguration,
  createStandardTemplateFiles,
  validateSchemaInstance,
} from "@senawa/configuration";
import {
  BoundedGitCommandPort,
  RootScopedConfigurationResources,
  RootScopedWorkspaceFiles,
} from "@senawa/execution-host";
import {
  type AccountingAssessment,
  type AssetSensitivity,
  approvalId,
  assessCompletionAccounting,
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  closePhase,
  compareFanOutEvaluations,
  consumerKey,
  createAmendmentProposal,
  createAuthorityDecision,
  createPhaseCandidate,
  createSensorReading,
  createWorkerContextBase,
  createWorkerDispatch,
  type DataMappingDeclaration,
  definitionGeneration,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  evaluateGate,
  evaluateTaskFrontier,
  type FanOutEvaluation,
  type GateDefinition,
  type MappingSourceBinding,
  type PhaseOutputAcceptance,
  type PhaseOutputPublication,
  runId,
  type Sha256Digest,
  sha256Digest,
} from "@senawa/kernel";
import { canonicalBytes, decodeCanonicalJsonValue, PROTOCOL_VERSION } from "@senawa/protocol";
import { assertSecretSafePositiveProjection, decodeDeterministicReport } from "@senawa/reporting";
import {
  type AsyncEffectHost,
  createFanOutAmendmentOperations,
  createRoleAuthorizationPolicy,
  type EffectInspection,
  type EffectIntent,
  type EffectObservation,
  type GeneratedTaskAuthorityTemplate,
  PlanImportCoordinator,
  RuntimeDataflowAuthority,
  type RuntimeDependencies,
  renderPromptPack,
} from "@senawa/runtime";
import {
  type SqliteAuthority,
  SqliteCanonicalJsonAssetStore,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import {
  CompletionFactCommandBridge,
  PlanImportCommandBridge,
  SqliteSupervisorAuthority,
  SupervisorService,
} from "@senawa/supervisor";
import { deterministicSha256, runtimeCommand, runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./cli.js";
import {
  configurationRuntimeSchemaValidator,
  runtimeSchemaContract,
} from "./dataflow-composition.js";
import { createNodeCliDependencies } from "./node-cli.js";
import { ProductionScheduler } from "./production-scheduler.js";
import { exportSqliteReportingDirectory } from "./report-export.js";
import {
  DurableCompletionEligibility,
  DynamicWorkspaceEffectHost,
} from "./workspace-composition.js";

const CHECKOUT_ROOT = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const REPOSITORY_ID = "repository_standard-delivery";
const RUN_ID = "run_standard-delivery";
const NOW = "2026-08-15T12:00:00.000Z";
const GENERATED_WORKER_CAPABILITIES = ["worker.submit.asset", "worker.submit.completion"] as const;
const roots = new Set<string>();
let allocation = 0;

const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["engine", "release-manager"] },
    { intent: "evaluate-gate", roles: ["engine", "release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["engine", "release-manager"] },
    { intent: "submit-amendment-proposal", roles: ["engine", "release-manager"] },
    { intent: "record-amendment-decision", roles: ["release-manager"] },
    { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
  ]),
};

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("Phase 14F standard delivery acceptance", () => {
  it("drives the generated standard tree from define through verify without model credit", async () => {
    const fixture = await temporaryRepository();
    try {
      // This acceptance drives the lowered internal document, which `init` no
      // longer publishes because no person should have to edit one. It is
      // written here directly so the test still exercises the generated tree.
      for (const [path, content] of Object.entries(createStandardTemplateFiles())) {
        const destination = join(fixture.repositoryRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, content, "utf8");
      }
      const workflowPath = join(fixture.repositoryRoot, ".senawa", "workflow.json");
      expect(await runCli(["doctor", workflowPath], createNodeCliDependencies())).toEqual({
        output: `${workflowPath}: valid`,
        exitCode: 0,
      });
      const document = JSON.parse(await readFile(workflowPath, "utf8"));
      expect(
        document.phases.map(({ key, executor }: { key: string; executor: { kind: string } }) => [
          key,
          executor.kind,
        ]),
      ).toEqual([
        ["define", "agent"],
        ["research", "agent"],
        ["plan", "agent"],
        ["implement", "task-frontier"],
        ["verify", "agent"],
      ]);
      expect(
        document.phases.some(
          ({ executor }: { executor: { kind: string } }) => executor.kind === "task-set",
        ),
      ).toBe(false);
      const snapshot = await compileWorkflowConfiguration(
        {
          document,
          locator: workflowPath,
          resources: await RootScopedConfigurationResources.create(
            fixture.repositoryRoot,
            ".senawa",
          ),
        },
        deterministicSha256,
      );
      await fixture.git(["add", "--all", "--", "."]);
      await fixture.git(["commit", "-m", "initialize standard delivery"]);

      let supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      supervisor.commandAuthority.putConfigurationSnapshot(snapshot);
      // The alpha runtime binds one command-driven lifecycle phase per run. Bind it to
      // the phase whose generated tasks execute through the production supervisor.
      const lifecyclePhase = phaseNode(snapshot, "implement");
      const instantiateReceipt = submit(
        supervisor,
        runtimeCommand({
          commandId: "command_standard-instantiate",
          intent: "instantiate-run",
          payload: {
            workflowId: snapshot.graph.workflowId,
            configurationSnapshotDigest: snapshot.snapshotDigest,
            execution: snapshot.execution,
            graph: snapshot.graph,
            phase: {
              phaseId: lifecyclePhase.definition.id,
              definitionGeneration: lifecyclePhase.definition.generation,
            },
            approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
            escalationPolicyDigest: sha256Digest("9".repeat(64)),
            allowancePolicy: {
              policyDigest: sha256Digest("9".repeat(64)),
              ceilings: [
                { unit: "dispatch-failure", maximum: 64 },
                { unit: "work-attempt", maximum: 64 },
                { unit: "workspace-operations", maximum: 64 },
              ],
            },
          },
        }),
      );
      expect(instantiateReceipt.status, JSON.stringify(instantiateReceipt)).toBe("completed");

      const assets = new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority);
      const dataflow = new RuntimeDataflowAuthority(
        deterministicSha256,
        configurationRuntimeSchemaValidator(),
        assets,
        supervisor.commandAuthority,
      );
      const workflowValue = canonicalValue({ request: "Deliver two dependency-ordered files" });
      const workflowBinding = dataflow.bindWorkflowInput({
        repositoryId: REPOSITORY_ID,
        runId: RUN_ID,
        workflowId: snapshot.graph.workflowId,
        graphRevisionDigest: snapshot.graph.revisionDigest,
        configurationSnapshotDigest: snapshot.snapshotDigest,
        schema: runtimeSchemaContract(snapshot, "workflow-input", deterministicSha256),
        value: workflowValue,
      });
      const accepted = new Map<string, AcceptedPhase>();
      const promptDigests = new Map<string, string>();

      const definition = canonicalValue({ definition: "Create alpha.txt, then beta.txt." });
      accepted.set(
        "define",
        closeAgentPhase({
          supervisor,
          dataflow,
          assets,
          snapshot,
          phaseKey: "define",
          outputName: "definition",
          outputValue: definition,
          sources: [
            {
              source: { kind: "workflow-input" as const },
              sourceBindingDigest: workflowBinding.bindingDigest,
              value: workflowValue,
            },
          ],
          promptDigests,
        }),
      );
      const research = canonicalValue({
        research: "The repository is clean; alpha must precede beta.",
      });
      accepted.set(
        "research",
        closeAgentPhase({
          supervisor,
          dataflow,
          assets,
          snapshot,
          phaseKey: "research",
          outputName: "research",
          outputValue: research,
          sources: [outputSource(required(accepted.get("define")), definition)],
          promptDigests,
        }),
      );
      const planTasks = [
        { id: "alpha", title: "Create alpha", instruction: "Write alpha.txt", dependsOn: [] },
        { id: "beta", title: "Create beta", instruction: "Write beta.txt", dependsOn: ["alpha"] },
      ];
      const planValue = canonicalValue({ tasks: planTasks });
      const plan = closeAgentPhase({
        supervisor,
        dataflow,
        assets,
        snapshot,
        phaseKey: "plan",
        outputName: "plan",
        outputValue: planValue,
        sources: [
          outputSource(required(accepted.get("define")), definition),
          outputSource(required(accepted.get("research")), research),
        ],
        promptDigests,
      });
      accepted.set("plan", plan);
      expect([...promptDigests.keys()]).toEqual(["define", "research", "plan"]);

      const planAcceptance = required(plan.acceptance);
      const planPublication = required(plan.publication);
      const evaluation = evaluatePlan(
        snapshot,
        plan.attempt.attempt.attemptDigest,
        planAcceptance,
        planValue,
      );
      const reordered = evaluatePlan(
        snapshot,
        plan.attempt.attempt.attemptDigest,
        planAcceptance,
        canonicalValue({ tasks: [...planTasks].reverse() }),
      );
      expect(reordered.evaluationDigest).toBe(evaluation.evaluationDigest);
      expect(reordered.taskSetDigest).toBe(evaluation.taskSetDigest);

      const generatedTemplate = generatedAuthorityTemplate(snapshot);
      const operations = createFanOutOperations(evaluation, generatedTemplate);
      const probe = createAmendmentProposal(
        {
          source: {
            kind: "import-plan",
            evaluationDigest: evaluation.evaluationDigest,
            diffDigest: compareFanOutEvaluations(evaluation, undefined, deterministicSha256)
              .diffDigest,
            acceptanceDigest: planAcceptance.acceptanceDigest,
          },
          baseGraph: snapshot.graph,
          baseContextDigest: plan.attempt.inputBinding.bindingDigest,
          baseConfigurationSnapshotDigest: snapshot.snapshotDigest,
          resultConfigurationSnapshotDigest: sha256Digest("8".repeat(64)),
          operations,
          phaseCandidateHistory: [],
        },
        deterministicSha256,
      );
      const resultSnapshot = snapshotWithGraph(snapshot, probe.reviewedResultGraph);

      let crashAfterEvaluation = true;
      const crashingCoordinator = new PlanImportCoordinator(
        {
          appliedEvaluation: (key) => supervisor.commandAuthority.appliedEvaluation(key),
          recordEvaluation: (key, value, prior) => {
            const result = supervisor.commandAuthority.recordEvaluation(key, value, prior);
            if (crashAfterEvaluation) {
              crashAfterEvaluation = false;
              throw new Error("simulated lost acknowledgement after import evaluation");
            }
            return result;
          },
          enqueueProposal: (key, proposal) =>
            supervisor.commandAuthority.enqueueProposal(key, proposal),
        },
        deterministicSha256,
      );
      const importRequest = {
        evaluation,
        phaseAttempt: plan.attempt.attempt,
        publication: planPublication,
        acceptance: planAcceptance,
        expectedClosureDigest: plan.closureDigest,
        expectedDefinitionDigest: required(snapshot.forEach.find(({ key }) => key === "plan-tasks"))
          .digest,
        baseGraph: snapshot.graph,
        baseContextDigest: plan.attempt.inputBinding.bindingDigest,
        baseConfigurationSnapshotDigest: snapshot.snapshotDigest,
        resultConfigurationSnapshotDigest: resultSnapshot.snapshotDigest,
        phaseCandidateHistory: [],
        template: generatedTemplate,
      } as const;
      expect(() => crashingCoordinator.import(importRequest)).toThrow("lost acknowledgement");
      supervisor.close();

      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const importBridge = new PlanImportCommandBridge({
        coordinator: new PlanImportCoordinator(supervisor.commandAuthority, deterministicSha256),
        commands: {
          putConfigurationSnapshot: (value) =>
            supervisor.commandAuthority.putConfigurationSnapshot(value),
          submit: (command) => supervisor.commandAuthority.submit(command, admission()),
        },
        sha256: deterministicSha256,
      });
      const imported = importBridge.execute(importRequest, resultSnapshot);
      expect(imported.result.status).toBe("proposal-enqueued");
      expect(imported.receipt?.status).toBe("completed");
      const proposal = required(
        imported.result.status === "proposal-enqueued" ? imported.result.proposal : undefined,
      );
      const importApprovalReceipt = submit(
        supervisor,
        runtimeCommand({
          commandId: "command_standard-import-approve",
          intent: "record-amendment-decision",
          payload: {
            amendmentId: proposal.amendmentId,
            proposalDigest: proposal.proposalDigest,
            decision: "approve",
            reviewedResultGraphRevisionDigest: proposal.reviewedResultGraph.revisionDigest,
          },
          expectedGraphRevision: snapshot.graph.revisionDigest,
          exactObjectDigest: proposal.proposalDigest,
        }),
      );
      expect(importApprovalReceipt.status, JSON.stringify(importApprovalReceipt)).toBe("completed");
      const recovery = required(supervisor.listApprovedAmendmentRecoveries()[0]);
      expect(recovery.observedQuiescent).toBe(true);
      supervisor.setMode("running", NOW);
      expect(supervisor.queueApprovedAmendmentApply(recovery, NOW)).toBe(true);
      supervisor.setMode("stopped", NOW);
      const amendmentService = new SupervisorService({
        authority: supervisor,
        clock: { now: () => Date.parse(NOW) },
        ownerId: "owner_standard-import",
      });
      await amendmentService.start();
      expect(supervisor.queryAmendment(REPOSITORY_ID, RUN_ID, proposal.amendmentId)).toMatchObject({
        lifecycle: { status: "applied" },
      });
      await amendmentService.stop();

      // The amendment service owns and closes the authority it applied through.
      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });

      // Generated tasks exist only in the applied graph revision, so the implement
      // attempt must bind the post-import snapshot.
      const implementAttempt = startPhase(
        new RuntimeDataflowAuthority(
          deterministicSha256,
          configurationRuntimeSchemaValidator(),
          new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority),
          supervisor.commandAuthority,
        ),
        resultSnapshot,
        "implement",
        [outputSource(plan, planValue)],
      );

      const production = await runGeneratedImplementation({
        fixture,
        supervisor,
        snapshot: resultSnapshot,
        attempt: implementAttempt,
        evaluation,
      });
      expect(production.order).toEqual(["alpha", "beta"]);
      expect(production.reworks).toBe(1);
      expect(production.gitHostConstructions).toBe(0);
      expect(production.workerHostConstructions).toBeGreaterThan(0);

      // The implementation service owns and closes the authority it scheduled through.
      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const implementation = closeTaskPhase(
        supervisor,
        resultSnapshot,
        implementAttempt,
        production.assessments,
        true,
      );
      accepted.set("implement", implementation);
      expect(
        supervisor.commandAuthority.queryProjection(REPOSITORY_ID, RUN_ID)?.payload,
      ).toMatchObject({
        status: "closed",
      });

      const completionEvidence = canonicalValue({
        acceptedTasks: production.assessments.map(({ assessment }) => ({
          taskId: assessment.submission.task.taskId,
          disposition: assessment.submission.disposition,
          evidenceCount: assessment.submission.completionEvidence.length,
        })),
      });
      const verification = canonicalValue({
        verified: true,
        summary: "Both generated tasks completed in dependency order.",
      });
      const verify = closeAgentPhase({
        supervisor,
        dataflow: new RuntimeDataflowAuthority(
          deterministicSha256,
          configurationRuntimeSchemaValidator(),
          new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority),
          supervisor.commandAuthority,
        ),
        assets: new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority),
        snapshot: resultSnapshot,
        phaseKey: "verify",
        outputName: "verification",
        outputValue: verification,
        sources: [
          outputSource(required(accepted.get("define")), definition),
          {
            source: {
              kind: "completion-evidence" as const,
              phase: consumerKey("implement"),
              view: consumerKey("accepted-implementation"),
            },
            sourceBindingDigest: implementation.closureDigest,
            value: completionEvidence,
          },
          outputSource(required(accepted.get("research")), research),
          outputSource(plan, planValue),
        ],
        promptDigests,
      });
      accepted.set("verify", verify);
      expect(promptDigests.get("verify")).toBeDefined();
      expect(verify.closureDigest).toBeDefined();
      expect(
        supervisor.commandAuthority.queryProjection(REPOSITORY_ID, RUN_ID)?.payload,
      ).toMatchObject({
        status: "closed",
      });
      supervisor.close();

      const reopened = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const portal = new SqlitePortalQueryAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const delivery = portal.listDeliveryRecords(REPOSITORY_ID, RUN_ID, 0, 256);
      expect(new Set(delivery.records.map(({ kind }) => kind))).toEqual(
        new Set([
          "phase-attempt",
          "phase-transition",
          "phase-output",
          "fan-out-evaluation",
          "generated-task",
          "plan-import",
        ]),
      );
      expect(delivery.records.filter(({ kind }) => kind === "phase-attempt")).toHaveLength(5);
      expect(delivery.records.filter(({ kind }) => kind === "phase-output")).not.toContainEqual(
        expect.objectContaining({ accepted: false }),
      );
      expect(delivery.records.filter(({ kind }) => kind === "generated-task")).toHaveLength(2);
      expect(delivery.records.find(({ kind }) => kind === "plan-import")).toMatchObject({
        state: "applied",
      });
      const serializedDelivery = JSON.stringify(delivery);
      for (const secret of [
        "Create alpha.txt, then beta.txt.",
        "The repository is clean",
        "Write alpha.txt",
        "Both generated tasks completed",
      ]) {
        expect(serializedDelivery).not.toContain(secret);
      }
      portal.close();

      const reportDirectory = join(fixture.root, "report");
      exportSqliteReportingDirectory({
        databasePath: fixture.databasePath,
        dependencies,
        repositoryId: REPOSITORY_ID,
        runId: RUN_ID,
        destinationDirectory: reportDirectory,
      });
      const report = decodeDeterministicReport(
        await readFile(join(reportDirectory, "report.json")),
      );
      const serializedReport = JSON.stringify(report);
      assertSecretSafePositiveProjection(serializedReport, "Phase 14F standard delivery report");
      expect(serializedReport).toContain(evaluation.evaluationDigest);
      expect(serializedReport).toContain(proposal.proposalDigest);
      for (const secret of [
        "Create alpha.txt, then beta.txt.",
        "The repository is clean",
        "Write alpha.txt",
        "Both generated tasks completed",
      ]) {
        expect(serializedReport).not.toContain(secret);
      }
      expect(
        reopened.commandAuthority.queryProjection(REPOSITORY_ID, RUN_ID)?.payload,
      ).toMatchObject({
        status: "closed",
      });
      reopened.close();
      expect(await checkoutWorktreePorcelain(fixture.command)).toBe(fixture.checkoutWorktrees);
      for (const name of [
        "SENAWA_COPILOT_LIVE",
        "SENAWA_COPILOT_MODEL",
        "SENAWA_COPILOT_MAX_AI_CREDITS",
        "SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA",
      ])
        expect(process.env[name]).toBeUndefined();
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);
});

interface AcceptedPhase {
  readonly phaseKey: string;
  readonly attempt: ReturnType<RuntimeDataflowAuthority["startPhaseAttempt"]>;
  readonly publication?: ReturnType<RuntimeDataflowAuthority["publishPhaseOutput"]>;
  readonly acceptance?: PhaseOutputAcceptance;
  readonly closureDigest: Sha256Digest;
}

interface AcceptedAssessment {
  readonly assessment: AccountingAssessment;
  readonly assessmentDigest: Sha256Digest;
}

interface SnapshotGate {
  readonly key: string;
  readonly phase: string;
  readonly definition: GateDefinition;
}

type ContextBudgets = ReturnType<typeof createWorkerContextBase>["budgets"];

interface SnapshotPhase {
  readonly key: string;
  readonly dependsOn?: readonly string[];
  readonly input: {
    readonly schema: string;
    readonly mappings: readonly DataMappingDeclaration[];
  };
  readonly executor: CanonicalValue & { readonly budgets: ContextBudgets };
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

interface SnapshotEvidenceView {
  readonly key: string;
  readonly phase: string;
}

interface SnapshotForEach {
  readonly key: string;
  readonly pointer: string;
  readonly identityPointer: string;
  readonly limits: Parameters<typeof evaluateTaskFrontier>[0]["limits"];
}

interface SnapshotTaskTemplate {
  readonly key: string;
  readonly generation: number;
  readonly budgets: ContextBudgets;
  readonly inputSchema: string;
  readonly inputMappings: readonly DataMappingDeclaration[];
  readonly dependencyIdentityPointer: string;
  readonly completionPolicy: {
    readonly criteria: GeneratedTaskAuthorityTemplate["criteria"];
    readonly completionEvidencePolicy: GeneratedTaskAuthorityTemplate["completionEvidencePolicy"];
  };
}

interface GeneratedSeed {
  readonly member: FanOutEvaluation["members"][number];
  readonly context: ReturnType<typeof createWorkerContextBase>;
  readonly dispatch: ReturnType<typeof createWorkerDispatch>;
  readonly completionRequirements: ReturnType<typeof deriveCompletionRequirements>[number];
  readonly taskScope: {
    readonly runId: string;
    readonly taskId: string;
    readonly definitionGeneration: number;
    readonly acceptedContextDigest: Sha256Digest;
    readonly fenceGeneration: number;
  };
}

function effectDispatchId(intent: EffectIntent): string {
  return String((intent.command.input as { readonly dispatchId?: unknown }).dispatchId);
}

function startPhase(
  dataflow: RuntimeDataflowAuthority,
  snapshot: ConfigurationSnapshot,
  phaseKey: string,
  sourceBindings: readonly MappingSourceBinding[],
) {
  const phase = phaseNode(snapshot, phaseKey);
  const declaration = phaseDeclaration(snapshot, phaseKey);
  return dataflow.startPhaseAttempt({
    repositoryId: REPOSITORY_ID,
    runId: RUN_ID,
    phase: {
      phaseId: phase.definition.id,
      definitionGeneration: phase.definition.generation,
      attempt: 1,
    },
    graphRevisionDigest: snapshot.graph.revisionDigest,
    configurationSnapshotDigest: snapshot.snapshotDigest,
    executorDigest: canonicalDigest(declaration.executor, deterministicSha256),
    upstreamClosureSetDigest: canonicalDigest(
      canonicalValue(sourceBindings.map(({ sourceBindingDigest }) => sourceBindingDigest).sort()),
      deterministicSha256,
    ),
    upstreamOutputSetDigest: canonicalDigest(
      canonicalValue(sourceBindings.map(({ sourceBindingDigest }) => sourceBindingDigest).sort()),
      deterministicSha256,
    ),
    schema: runtimeSchemaContract(snapshot, declaration.input.schema, deterministicSha256),
    mappings: declaration.input.mappings,
    sourceBindings,
    mappingPolicy: {
      dependencyPhases: (declaration.dependsOn ?? []).map(consumerKey),
      declaredPhaseOutputs: snapshot.phaseDataflow.flatMap((entry) =>
        registryValue<SnapshotPhase>(entry).outputs.map(({ key }) => ({
          phase: consumerKey(registryValue<SnapshotPhase>(entry).key),
          output: consumerKey(key),
        })),
      ),
      completionEvidenceViews: snapshot.completionEvidenceViews.map((entry) => ({
        phase: consumerKey(registryValue<SnapshotEvidenceView>(entry).phase),
        view: consumerKey(registryValue<SnapshotEvidenceView>(entry).key),
      })),
      allowCurrentItem: false,
    },
  });
}

function closeAgentPhase(input: {
  readonly supervisor: SqliteSupervisorAuthority;
  readonly dataflow: RuntimeDataflowAuthority;
  readonly assets: SqliteCanonicalJsonAssetStore;
  readonly snapshot: ConfigurationSnapshot;
  readonly phaseKey: string;
  readonly outputName: string;
  readonly outputValue: ReturnType<typeof canonicalValue>;
  readonly sources: readonly MappingSourceBinding[];
  readonly promptDigests: Map<string, string>;
  readonly finalAuthority?: boolean;
}): AcceptedPhase {
  const started = startPhase(input.dataflow, input.snapshot, input.phaseKey, input.sources);
  const phase = phaseNode(input.snapshot, input.phaseKey);
  const task = required(
    input.snapshot.graph.nodes.find(
      (node) => node.kind === "task" && node.definition.parentId === phase.definition.id,
    ),
  );
  if (task.kind !== "task") throw new Error("Agent task missing");
  const contextTask = {
    taskId: task.definition.id,
    definitionGeneration: task.definition.generation,
  };
  const role = registryEntry(
    input.snapshot.roles,
    input.phaseKey === "research"
      ? "researcher"
      : input.phaseKey === "plan"
        ? "planner"
        : input.phaseKey === "verify"
          ? "verifier"
          : "definer",
  );
  const roleValue = registryValue<SnapshotAgentRole>(role);
  const prompt = required(input.snapshot.prompts.find(({ key }) => key === roleValue.prompt));
  const model = registryEntry(input.snapshot.modelPolicies, roleValue.modelPolicy);
  const declaration = phaseDeclaration(input.snapshot, input.phaseKey);
  const context = createWorkerContextBase(
    {
      task: contextTask,
      graphRevisionDigest: input.snapshot.graph.revisionDigest,
      configurationSnapshotDigest: input.snapshot.snapshotDigest,
      contracts: [],
      dependencyBarrier: { task: contextTask, dependencies: [] },
      assets: [],
      repositoryBase: {
        commitDigest: sha256Digest("1".repeat(64)),
        treeDigest: sha256Digest("1".repeat(64)),
      },
      modelPolicy: {
        key: consumerKey(roleValue.modelPolicy),
        policyDigest: model.digest,
        orderedRoutesDigest: model.digest,
      },
      role: { key: consumerKey(role.key), roleDigest: role.digest },
      prompt: {
        key: prompt.key,
        path: prompt.source.path,
        resourceDigest: prompt.digest,
        contentDigest: prompt.source.contentDigest,
        byteLength: prompt.source.byteLength,
        utf8: prompt.source.utf8,
        inputPaths: prompt.inputPaths,
      },
      mappedInput: {
        value: started.value,
        valueDigest: canonicalDigest(started.value, deterministicSha256),
      },
      phaseAttempt: started.attempt,
      phaseInputBinding: started.inputBinding,
      phaseOutputDeclarations: declaration.outputs.map(
        ({ key, schema, maxBytes, sensitivity }) => ({
          outputName: consumerKey(key),
          schemaKey: consumerKey(schema),
          schemaResourceDigest: runtimeSchemaContract(input.snapshot, schema, deterministicSha256)
            .schemaResourceDigest,
          maxBytes,
          sensitivity,
        }),
      ),
      capabilities: roleValue.capabilities,
      budgets: declaration.executor.budgets,
    },
    deterministicSha256,
  );
  const dispatchInput = {
    repositoryId: REPOSITORY_ID,
    runId: runId(RUN_ID),
    ordinal: 1,
    workerPrincipalId: `principal_fixture-${input.phaseKey}`,
    roleKey: consumerKey(role.key),
    capabilities: roleValue.capabilities,
    promptResource: {
      key: prompt.key,
      resourceDigest: prompt.digest,
      contentDigest: prompt.source.contentDigest,
    },
  };
  const provisional = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: sha256Digest("0".repeat(64)) },
    context,
    deterministicSha256,
  );
  const rendered = renderPromptPack(context, provisional, deterministicSha256, 65_536);
  const dispatch = createWorkerDispatch(
    { ...dispatchInput, promptPackDigest: rendered.digest },
    context,
    deterministicSha256,
  );
  expect(renderPromptPack(context, dispatch, deterministicSha256, 65_536).digest).toBe(
    rendered.digest,
  );
  expect(new TextDecoder().decode(rendered.utf8Bytes)).toContain("SENAWA_UNTRUSTED_INPUT_BEGIN");
  input.promptDigests.set(input.phaseKey, rendered.digest);

  const asset = input.assets.install(input.outputValue);
  const schema = runtimeSchemaContract(
    input.snapshot,
    required(declaration.outputs[0]).schema,
    deterministicSha256,
  );
  const validationReceiptDigest = canonicalDigest(
    canonicalValue({
      boundary: "phase output",
      schemaKey: schema.key,
      schemaResourceDigest: schema.schemaResourceDigest,
      validatorProfileDigest: schema.validatorProfileDigest,
      contentDigest: asset.contentDigest,
      findings: [],
    }),
    deterministicSha256,
  );
  const requirements = required(
    deriveCompletionRequirements(input.snapshot.graph, [dispatch.task], deterministicSha256)[0],
  );
  const broker = new SqliteContextBroker({
    databasePath: input.supervisor.databasePath,
    dependencies: {
      sha256: deterministicSha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32).fill(5),
    },
  });
  broker.registerDispatch({
    context,
    dispatch,
    completionRequirements: requirements,
    taskScope: {
      runId: RUN_ID,
      taskId: dispatch.task.taskId,
      definitionGeneration: dispatch.task.definitionGeneration,
      acceptedContextDigest: context.contextDigest,
      fenceGeneration: 1,
    },
  });
  broker.installCanonicalOutputAsset(
    {
      contentDigest: asset.contentDigest,
      byteLength: asset.byteLength,
      mediaType: "application/json",
      schemaResourceDigest: schema.schemaResourceDigest,
      validationReceiptDigest,
    },
    canonicalBytes(input.outputValue),
  );
  const publication = input.dataflow.publishPhaseOutput({
    schema,
    fact: {
      submissionId: `submission_output-${input.phaseKey}`,
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      dispatchId: dispatch.dispatchId,
      contextId: dispatch.contextId,
      contextDigest: dispatch.contextDigest,
      producingTask: dispatch.task,
      output: {
        phase: started.attempt.phase,
        outputName: input.outputName,
        schemaKey: schema.key,
        schemaResourceDigest: schema.schemaResourceDigest,
        contentDigest: asset.contentDigest,
        byteLength: asset.byteLength,
        mediaType: "application/json",
        sensitivity: "internal",
        graphRevisionDigest: input.snapshot.graph.revisionDigest,
        configurationSnapshotDigest: input.snapshot.snapshotDigest,
        inputBindingDigest: started.inputBinding.bindingDigest,
        validationReceiptDigest,
      },
    },
  });
  broker.close();
  const assessment = assessCompletionAccounting(requirements, {
    task: dispatch.task,
    disposition: "completed",
    summary: `Deterministic ${input.phaseKey} fixture output`,
    criteria: requirements.criteria.map(({ criterionId }) => ({
      criterionId,
      disposition: "satisfied" as const,
    })),
    completionEvidence: [],
  });
  return closePhaseAuthority(
    input.supervisor,
    input.snapshot,
    started,
    [publication],
    [{ assessment, assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256) }],
    input.finalAuthority,
  );
}

function closeTaskPhase(
  supervisor: SqliteSupervisorAuthority,
  snapshot: ConfigurationSnapshot,
  started: ReturnType<RuntimeDataflowAuthority["startPhaseAttempt"]>,
  assessments: readonly AcceptedAssessment[],
  finalAuthority = false,
): AcceptedPhase {
  return closePhaseAuthority(supervisor, snapshot, started, [], assessments, finalAuthority);
}

function closePhaseAuthority(
  supervisor: SqliteSupervisorAuthority,
  snapshot: ConfigurationSnapshot,
  started: ReturnType<RuntimeDataflowAuthority["startPhaseAttempt"]>,
  publications: readonly PhaseOutputPublication[],
  assessments: readonly AcceptedAssessment[],
  finalAuthority = false,
): AcceptedPhase {
  const phase = required(
    snapshot.graph.nodes.find(
      (node) => node.kind === "phase" && node.definition.id === started.attempt.phase.phaseId,
    ),
  );
  if (phase.kind !== "phase") throw new Error("Phase missing");
  const tasks = assessments.map(({ assessment }) => assessment.submission.task);
  const gateEntry = required(
    snapshot.gates.find(
      (entry) => registryValue<SnapshotGate>(entry).phase === phase.definition.key,
    ),
  );
  const gate = registryValue<SnapshotGate>(gateEntry).definition;
  const candidate = createPhaseCandidate(
    {
      phase: { phaseId: phase.definition.id, definitionGeneration: phase.definition.generation },
      phaseAttempt: started.attempt.phase,
      graphRevisionDigest: snapshot.graph.revisionDigest,
      inputBindingDigest: started.inputBinding.bindingDigest,
      requiredOutputPublications: publications,
      outputSetDigest: digestPhaseOutputSet(publications, deterministicSha256),
      selectedTaskSetDigest: digestSelectedTaskSet(tasks, deterministicSha256),
      tasks,
      acceptedAccountingAssessments: assessments,
      dependencyBarrierDigest: sha256Digest("2".repeat(64)),
      gatePolicyDigest: gate.policyDigest,
    },
    snapshot.graph,
    deterministicSha256,
  );
  const reading = createSensorReading(
    {
      sensorKey: consumerKey("diff-check"),
      inputDigest: candidate.candidateDigest,
      outcome: "succeeded",
      data: { exitCode: 0 },
    },
    deterministicSha256,
  );
  const evaluation = evaluateGate(gate, [reading], candidate.candidateDigest, deterministicSha256);
  const decision = createAuthorityDecision(
    {
      decision: "approve",
      approvalId: approvalId(`approval_${phase.definition.key}`),
      principal: runtimePrincipal,
      occurredAt: NOW,
      candidateDigest: candidate.candidateDigest,
    },
    deterministicSha256,
  );
  const closure = closePhase(
    {
      graph: snapshot.graph,
      candidate,
      gateEvidence: { definition: gate, readings: [reading], evaluation },
      approval: { policy: "approval-required", authority: runtimePrincipal, decision },
    },
    deterministicSha256,
  );
  supervisor.commandAuthority.acceptPhaseOutputs(closure.outputAcceptances);
  const dataflow = new RuntimeDataflowAuthority(
    deterministicSha256,
    configurationRuntimeSchemaValidator(),
    new SqliteCanonicalJsonAssetStore(supervisor.commandAuthority),
    supervisor.commandAuthority,
  );
  dataflow.transitionPhaseAttempt({
    attempt: started.attempt,
    trigger: "closure-created",
    triggerDigest: closure.closureDigest,
    policy: { maxAttempts: 2, upstreamChange: "iterate", exhaustion: "escalate" },
    budgetLedger: {
      counters: [{ unit: "review-iteration", limit: 2, used: 0 }],
      appliedAllowanceDecisionDigests: [],
    },
  });
  if (finalAuthority) {
    expect(
      submit(
        supervisor,
        runtimeCommand({
          commandId: `command_standard-${phase.definition.key}-gate`,
          intent: "evaluate-gate",
          payload: {
            phase: candidate.phase,
            phaseAttempt: candidate.phaseAttempt,
            inputBindingDigest: candidate.inputBindingDigest,
            requiredOutputPublications: candidate.requiredOutputPublications,
            outputSetDigest: candidate.outputSetDigest,
            dependencyBarrierDigest: candidate.dependencyBarrierDigest,
            gateDefinition: gate,
            readings: [reading],
          },
          expectedGraphRevision: snapshot.graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      submit(
        supervisor,
        runtimeCommand({
          commandId: `command_standard-${phase.definition.key}-approve`,
          intent: "record-authority-decision",
          payload: { decision: "approve" },
          expectedGraphRevision: snapshot.graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
      ),
    ).toMatchObject({ status: "completed" });
    expect(
      submit(
        supervisor,
        runtimeCommand({
          commandId: `command_standard-${phase.definition.key}-close`,
          intent: "close-phase",
          payload: {},
          expectedGraphRevision: snapshot.graph.revisionDigest,
          exactObjectDigest: candidate.candidateDigest,
        }),
      ),
    ).toMatchObject({ status: "completed" });
  }
  return {
    phaseKey: String(phase.definition.key),
    attempt: started,
    ...(publications[0] === undefined ? {} : { publication: publications[0] }),
    ...(closure.outputAcceptances[0] === undefined
      ? {}
      : { acceptance: closure.outputAcceptances[0] }),
    closureDigest: closure.closureDigest,
  };
}

function evaluatePlan(
  snapshot: ConfigurationSnapshot,
  attemptDigest: string,
  acceptance: PhaseOutputAcceptance | undefined,
  value: ReturnType<typeof canonicalValue>,
): FanOutEvaluation {
  const definition = registryEntry(snapshot.forEach, "plan-tasks");
  const itemSchema = runtimeSchemaContract(snapshot, "plan-task-item", deterministicSha256);
  const collectionSchema = runtimeSchemaContract(
    snapshot,
    "plan-task-collection",
    deterministicSha256,
  );
  const template = registryEntry(snapshot.taskTemplates, "implementation");
  const implement = phaseNode(snapshot, "implement");
  const definitionValue = registryValue<SnapshotForEach>(definition);
  const templateValue = registryValue<SnapshotTaskTemplate>(template);
  const schemas = new Map([
    [itemSchema.schemaResourceDigest, itemSchema],
    [collectionSchema.schemaResourceDigest, collectionSchema],
    [
      runtimeSchemaContract(snapshot, "implementation-task-input", deterministicSha256)
        .schemaResourceDigest,
      runtimeSchemaContract(snapshot, "implementation-task-input", deterministicSha256),
    ],
  ]);
  return evaluateTaskFrontier(
    {
      repositoryId: REPOSITORY_ID,
      runId: RUN_ID,
      attemptDigest: sha256Digest(attemptDigest),
      forEachKey: consumerKey("plan-tasks"),
      definitionDigest: definition.digest,
      sourceBindingDigest: required(acceptance).acceptanceDigest,
      sourceValue: value,
      collectionPointer: definitionValue.pointer,
      collectionSchemaDigest: collectionSchema.schemaResourceDigest,
      itemSchemaDigest: itemSchema.schemaResourceDigest,
      identityPointer: definitionValue.identityPointer,
      template: {
        key: consumerKey(template.key),
        parentPhaseId: implement.definition.id,
        generation: definitionGeneration(templateValue.generation),
        templateDigest: template.digest,
        inputSchemaDigest: runtimeSchemaContract(
          snapshot,
          templateValue.inputSchema,
          deterministicSha256,
        ).schemaResourceDigest,
        inputMappings: templateValue.inputMappings,
        dependencyIdentityPointer: templateValue.dependencyIdentityPointer,
      },
      sourceBindings: [],
      mappingPolicy: {
        dependencyPhases: [],
        declaredPhaseOutputs: [],
        completionEvidenceViews: [],
        allowCurrentItem: true,
      },
      limits: definitionValue.limits,
      acceptedTotalTasks: 0,
      graphRevisionDigest: snapshot.graph.revisionDigest,
      configurationSnapshotDigest: snapshot.snapshotDigest,
    },
    {
      validate(digest, instance) {
        const schema = required(schemas.get(digest));
        return validateSchemaInstance(
          schema.schema,
          instance,
          schema.externalSchemas.map(({ id, schema }) => ({ id, schema })),
        );
      },
    },
    deterministicSha256,
  );
}

function generatedAuthorityTemplate(snapshot: ConfigurationSnapshot) {
  const entry = registryEntry(snapshot.taskTemplates, "implementation");
  const value = registryValue<SnapshotTaskTemplate>(entry);
  return {
    templateDigest: entry.digest,
    binding: entry.value,
    parentPhaseId: phaseNode(snapshot, "implement").definition.id,
    criteria: value.completionPolicy.criteria,
    completionEvidencePolicy: value.completionPolicy.completionEvidencePolicy,
  };
}

function createFanOutOperations(
  evaluation: FanOutEvaluation,
  template: ReturnType<typeof generatedAuthorityTemplate>,
) {
  const diff = compareFanOutEvaluations(evaluation, undefined, deterministicSha256);
  return createFanOutAmendmentOperations(diff, template, deterministicSha256);
}

function snapshotWithGraph(
  snapshot: ConfigurationSnapshot,
  graph: ConfigurationSnapshot["graph"],
): ConfigurationSnapshot {
  const componentDigests = {
    ...snapshot.componentDigests,
    graph: canonicalDigest(canonicalValue(graph), deterministicSha256),
  };
  const content = {
    apiVersion: CONFIGURATION_SNAPSHOT_API_VERSION,
    execution: snapshot.execution,
    graph,
    prompts: snapshot.prompts,
    schemas: snapshot.schemas,
    roles: snapshot.roles,
    modelPolicies: snapshot.modelPolicies,
    sensors: snapshot.sensors,
    gates: snapshot.gates,
    completionEvidenceViews: snapshot.completionEvidenceViews,
    phaseDataflow: snapshot.phaseDataflow,
    forEach: snapshot.forEach,
    taskTemplates: snapshot.taskTemplates,
    componentDigests,
  };
  return canonicalValue({
    ...content,
    snapshotDigest: canonicalDigest(canonicalValue(content), deterministicSha256),
  }) as unknown as ConfigurationSnapshot;
}

async function runGeneratedImplementation(input: {
  fixture: TemporaryRepository;
  supervisor: SqliteSupervisorAuthority;
  snapshot: ConfigurationSnapshot;
  attempt: ReturnType<RuntimeDataflowAuthority["startPhaseAttempt"]>;
  evaluation: FanOutEvaluation;
}) {
  const runner = new SqliteRunnerAuthority({
    databasePath: input.fixture.databasePath,
    dependencies,
  });
  const workspace = new SqliteWorkspaceIntegrationAuthority({
    databasePath: input.fixture.databasePath,
    dependencies,
  });
  let broker: SqliteContextBroker;
  const eligibility = new DurableCompletionEligibility({
    workspaceAuthority: workspace,
    runnerAuthority: runner,
    sha256: deterministicSha256,
    currentIntegrationBarrier: () => undefined,
  });
  const completionBridge = new CompletionFactCommandBridge({
    authority: input.supervisor,
    broker: () => broker,
    completionEligibility: eligibility,
    currentTime: () => NOW,
  });
  broker = new SqliteContextBroker({
    databasePath: input.fixture.databasePath,
    dependencies: {
      sha256: deterministicSha256,
      currentTime: () => NOW,
      issueGrantToken: () => new Uint8Array(32).fill(7),
    },
    completionFacts: completionBridge,
  });
  const prompt = required(input.snapshot.prompts.find(({ key }) => key === "implementor"));
  const role = registryEntry(input.snapshot.roles, "implementor");
  const model = registryEntry(input.snapshot.modelPolicies, "standard");
  const seeds = input.evaluation.members.map((member, index) => {
    const task = required(
      input.snapshot.graph.nodes.find(
        (node) => node.kind === "task" && node.definition.id === member.taskId,
      ),
    );
    if (task.kind !== "task") throw new Error("Generated task missing");
    const contextTask = {
      taskId: task.definition.id,
      definitionGeneration: task.definition.generation,
    };
    const context = createWorkerContextBase(
      {
        task: contextTask,
        graphRevisionDigest: input.snapshot.graph.revisionDigest,
        configurationSnapshotDigest: input.snapshot.snapshotDigest,
        contracts: [],
        dependencyBarrier: { task: contextTask, dependencies: [] },
        assets: [],
        repositoryBase: {
          commitDigest: sha256Digest("4".repeat(64)),
          treeDigest: sha256Digest("4".repeat(64)),
        },
        modelPolicy: {
          key: consumerKey("standard"),
          policyDigest: model.digest,
          orderedRoutesDigest: model.digest,
        },
        role: { key: consumerKey("implementor"), roleDigest: role.digest },
        prompt: {
          key: prompt.key,
          path: prompt.source.path,
          resourceDigest: prompt.digest,
          contentDigest: prompt.source.contentDigest,
          byteLength: prompt.source.byteLength,
          utf8: prompt.source.utf8,
          inputPaths: prompt.inputPaths,
        },
        mappedInput: { value: member.input, valueDigest: member.inputDigest },
        phaseAttempt: input.attempt.attempt,
        phaseInputBinding: input.attempt.inputBinding,
        phaseOutputDeclarations: [],
        capabilities: GENERATED_WORKER_CAPABILITIES,
        budgets: registryValue<SnapshotTaskTemplate>(
          registryEntry(input.snapshot.taskTemplates, "implementation"),
        ).budgets,
      },
      deterministicSha256,
    );
    const dispatchInput = {
      repositoryId: REPOSITORY_ID,
      runId: runId(RUN_ID),
      ordinal: index + 1,
      workerPrincipalId: `principal_implementation-${member.identity}`,
      roleKey: consumerKey("implementor"),
      capabilities: GENERATED_WORKER_CAPABILITIES,
      promptResource: {
        key: prompt.key,
        resourceDigest: prompt.digest,
        contentDigest: prompt.source.contentDigest,
      },
    };
    const provisional = createWorkerDispatch(
      { ...dispatchInput, promptPackDigest: sha256Digest("0".repeat(64)) },
      context,
      deterministicSha256,
    );
    const promptPackDigest = renderPromptPack(
      context,
      provisional,
      deterministicSha256,
      65_536,
    ).digest;
    const dispatch = createWorkerDispatch(
      { ...dispatchInput, promptPackDigest },
      context,
      deterministicSha256,
    );
    const completionRequirements = required(
      deriveCompletionRequirements(input.snapshot.graph, [dispatch.task], deterministicSha256)[0],
    );
    const taskScope = {
      runId: RUN_ID,
      taskId: task.definition.id,
      definitionGeneration: task.definition.generation,
      acceptedContextDigest: context.contextDigest,
      fenceGeneration: 1,
    };
    broker.registerDispatch({
      context,
      dispatch,
      completionRequirements,
      taskScope,
      effect: {
        input: decodeCanonicalJsonValue({
          dispatchId: dispatch.dispatchId,
          identity: member.identity,
        }),
        budgetReservation: { unit: "dispatch-failure", amount: 1 },
      },
    });
    return { member, context, dispatch, completionRequirements, taskScope };
  });
  const worker = new GeneratedWorkers(
    broker,
    input.supervisor.commandAuthority,
    seeds,
    input.fixture.repositoryRoot,
    input.snapshot,
  );
  let workerHostConstructions = 0;
  let gitHostConstructions = 0;
  const dynamic = new DynamicWorkspaceEffectHost({
    authority: input.supervisor,
    workspaceAuthority: workspace,
    repositoryRoot: input.fixture.repositoryRoot,
    hostWriterCapacity: 1,
    createWorkerHost: () => {
      workerHostConstructions += 1;
      return worker;
    },
    createGitHost: async () => {
      gitHostConstructions += 1;
      throw new Error("Repository-mode acceptance must not construct a Git workspace host");
    },
  });
  const scheduler = new ProductionScheduler({
    authority: input.supervisor,
    runnerAuthority: runner,
    workspaceAuthority: workspace,
    contextBroker: broker,
    supervisorWriterLimit: 1,
    hostWriterLimit: 1,
    sha256: deterministicSha256,
  });
  input.supervisor.setMode("running", NOW);
  const service = new SupervisorService({
    authority: input.supervisor,
    clock: { now: () => Date.parse(NOW) },
    ownerId: "owner_standard-implementation",
    startupCycleLimit: 256,
    asyncEffectHost: dynamic,
    runnerBatchSize: 1,
    scheduleBeforeEffects: ({ repositoryId, runId, lease, currentTime }) =>
      scheduler.schedule({ repositoryId, runId, lease, currentTime }),
    listSchedulableRuns: () => scheduler.listRuns(),
    deliverCompletionOutboxOnce: () => broker.deliverCompletionOutboxOnce(),
    failurePolicyForRun: () => "continue",
    sessionStoreHealth: {
      health: async () => ({
        status: "healthy" as const,
        expectedSessionCount: 0,
        missingSessionIds: [],
      }),
    },
  });
  await service.start();
  for (let index = 0; index < 32; index += 1) if (!(await service.runCycle()).worked) break;
  for (let index = 0; index < 8; index += 1) if (!broker.deliverCompletionOutboxOnce()) break;
  const assessments = input.supervisor.commandAuthority
    .queryReceiptHistory(REPOSITORY_ID, RUN_ID)
    .flatMap((receipt) => {
      const result = receipt.result as { readonly assessment?: AccountingAssessment } | undefined;
      const assessment = result?.assessment;
      return assessment === undefined
        ? []
        : [
            {
              assessment,
              assessmentDigest: digestAccountingAssessment(assessment, deterministicSha256),
            },
          ];
    })
    .filter(({ assessment }) =>
      input.evaluation.members.some(({ taskId }) => taskId === assessment.submission.task.taskId),
    );
  expect(assessments).toHaveLength(2);
  await service.stop();
  broker.close();
  workspace.close();
  runner.close();
  return {
    order: worker.order,
    reworks: worker.reworks,
    assessments,
    workerHostConstructions,
    gitHostConstructions,
  };
}

class GeneratedWorkers implements AsyncEffectHost {
  readonly order: string[] = [];
  readonly completed = new Set<string>();
  reworks = 0;
  constructor(
    readonly broker: SqliteContextBroker,
    readonly authority: SqliteAuthority,
    readonly seeds: readonly GeneratedSeed[],
    readonly root: string,
    readonly snapshot: ConfigurationSnapshot,
  ) {}
  async dispatch(intent: EffectIntent): Promise<EffectObservation> {
    const dispatchId = String(effectDispatchId(intent));
    const seed = required(this.seeds.find(({ dispatch }) => dispatch.dispatchId === dispatchId));
    if (!this.completed.has(dispatchId)) {
      const identity = seed.member.identity;
      if (identity === "beta") {
        const findings = validateSchemaInstance(
          runtimeSchemaContract(this.snapshot, "implementation-task-input", deterministicSha256)
            .schema,
          canonicalValue({ id: "beta" }),
        );
        expect(findings.length).toBeGreaterThan(0);
        this.reworks += 1;
      }
      await (await RootScopedWorkspaceFiles.create(this.root)).write(
        `${identity}.txt`,
        `${identity}\n`,
      );
      const bytes = new TextEncoder().encode(`completionEvidence:${identity}`);
      const assetId = `asset_standard-${identity}`;
      const contentDigest = deterministicSha256.digest(bytes);
      this.authority.putAsset(bytes, "text/plain");
      expect(
        this.broker.admitSubmission({
          submission: {
            apiVersion: PROTOCOL_VERSION,
            submissionId: `submission_asset-${identity}`,
            repositoryId: REPOSITORY_ID,
            runId: RUN_ID,
            dispatchId,
            task: seed.dispatch.task,
            contextId: seed.dispatch.contextId,
            contextDigest: seed.dispatch.contextDigest,
            principalId: seed.dispatch.worker.principalId,
            type: "asset",
            asset: {
              assetId,
              contentDigest,
              byteLength: bytes.byteLength,
              mediaType: "text/plain",
              sensitivity: "internal",
              summary: `Generated ${identity} completionEvidence`,
            },
          },
        }).status,
      ).toBe("accepted");
      expect(
        this.broker.admitSubmission({
          submission: {
            apiVersion: PROTOCOL_VERSION,
            submissionId: `submission_completion-${identity}`,
            repositoryId: REPOSITORY_ID,
            runId: RUN_ID,
            dispatchId,
            task: seed.dispatch.task,
            contextId: seed.dispatch.contextId,
            contextDigest: seed.dispatch.contextDigest,
            principalId: seed.dispatch.worker.principalId,
            type: "completion",
            completion: {
              task: seed.dispatch.task,
              disposition: "completed",
              summary: `Completed generated ${identity}`,
              criteria: seed.completionRequirements.criteria.map(({ criterionId }) => ({
                criterionId,
                disposition: "satisfied",
              })),
              completionEvidence: [
                {
                  assetId,
                  kind: canonicalValue("task-completion"),
                  descriptor: canonicalValue({ generatedTask: identity }),
                },
              ],
            },
          },
        }).status,
      ).toBe("accepted");
      this.order.push(identity);
      this.completed.add(dispatchId);
    }
    return {
      status: "completed",
      observedAt: NOW,
      details: { fixture: "deterministic", dispatchId },
    };
  }
  async inspect(intent: EffectIntent): Promise<EffectInspection> {
    return {
      status: this.completed.has(String(effectDispatchId(intent))) ? "completed" : "missing",
      observedAt: NOW,
    };
  }
  async cancel(): Promise<EffectObservation> {
    return { status: "cancelled", observedAt: NOW };
  }
}

function outputSource(phase: AcceptedPhase, value: ReturnType<typeof canonicalValue>) {
  return {
    source: {
      kind: "phase-output" as const,
      phase: consumerKey(phase.phaseKey),
      output: consumerKey(required(phase.publication).outputName),
    },
    sourceBindingDigest: required(phase.acceptance).acceptanceDigest,
    acceptanceDigest: required(phase.acceptance).acceptanceDigest,
    value,
  };
}

function phaseNode(snapshot: ConfigurationSnapshot, key: string) {
  const node = required(
    snapshot.graph.nodes.find(
      (candidate) => candidate.kind === "phase" && candidate.definition.key === key,
    ),
  );
  if (node.kind !== "phase") throw new Error(`Phase ${key} missing`);
  return node;
}

function registryEntry(
  entries: readonly ConfigurationRegistryEntry[],
  key: string,
): ConfigurationRegistryEntry {
  return required(entries.find((entry) => entry.key === key));
}

function registryValue<T>(entry: ConfigurationRegistryEntry): T {
  return entry.value as unknown as T;
}

function phaseDeclaration(snapshot: ConfigurationSnapshot, key: string): SnapshotPhase {
  return registryValue<SnapshotPhase>(registryEntry(snapshot.phaseDataflow, key));
}

function submit(supervisor: SqliteSupervisorAuthority, command: ReturnType<typeof runtimeCommand>) {
  return supervisor.commandAuthority.submit(
    { ...command, repositoryId: REPOSITORY_ID, runId: RUN_ID },
    admission(),
  );
}

function admission() {
  return {
    currentTime: NOW,
    facts: { source: "phase-14f-standard-acceptance" },
    allocateId(kind: "approval" | "stream-event") {
      allocation += 1;
      return kind === "approval"
        ? `approval_standard-${allocation}`
        : `stream-event-standard-${allocation}`;
    },
  };
}

interface TemporaryRepository {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly command: BoundedGitCommandPort;
  readonly checkoutWorktrees: string;
  git(args: readonly string[], root?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function temporaryRepository(): Promise<TemporaryRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "senawa-standard-delivery-")));
  roots.add(root);
  if (containsPath(CHECKOUT_ROOT, root) || containsPath(root, CHECKOUT_ROOT))
    throw new Error("Temporary repository overlaps checkout");
  const repositoryRoot = join(root, "repository");
  const home = join(root, "home");
  await mkdir(home);
  const command = new BoundedGitCommandPort({
    gitExecutable: "/usr/bin/git",
    isolatedHome: home,
    additionalSubcommands: ["init", "commit", "cat-file", "show", "checkout", "branch"],
  });
  const git = async (args: readonly string[], cwd = repositoryRoot) => {
    const result = await command.run({ rootDirectory: cwd, args, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled)
      throw new Error(`Git command failed: ${args.join(" ")}\n${result.stderr.text}`);
    return result.stdout.text;
  };
  const checkoutWorktrees = await checkoutWorktreePorcelain(command);
  await git(["init", "--initial-branch=main", repositoryRoot], root);
  await git(["config", "user.name", "Senawa Standard Acceptance"]);
  await git(["config", "user.email", "standard@senawa.invalid"]);
  return {
    root,
    repositoryRoot,
    databasePath: join(root, "state", "authority.db"),
    assetDirectory: join(root, "state", "assets"),
    command,
    checkoutWorktrees,
    git,
    async cleanup() {
      expect(await checkoutWorktreePorcelain(command)).toBe(checkoutWorktrees);
      roots.delete(root);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function checkoutWorktreePorcelain(command: BoundedGitCommandPort): Promise<string> {
  const result = await command.run({
    rootDirectory: CHECKOUT_ROOT,
    args: ["worktree", "list", "--porcelain"],
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0) throw new Error("Unable to read checkout worktrees");
  return result.stdout.text;
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required Phase 14F acceptance value is missing");
  return value;
}
