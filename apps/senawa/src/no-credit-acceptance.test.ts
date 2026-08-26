import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileWorkflowAmendment,
  compileWorkflowConfiguration,
  createExampleWorkflowResources,
  createWorktreeFanOutWorkflowConfiguration,
  WORKFLOW_AMENDMENT_API_VERSION,
} from "@senawa/configuration";
import {
  createEd25519FixtureKeyPair,
  DeterministicControlPlaneSimulator,
  DeterministicRandom,
  InProcessControlPlaneTransport,
  ReferenceControlPlane,
  signCommandIngress,
  VirtualClock,
} from "@senawa/control-plane";
import {
  BoundedGitCommandPort,
  DurableWorkspaceEffectHost,
  GitIntegrationAdapter,
  GitWorkspaceAdapter,
  RootScopedConfigurationResources,
  RootScopedWorkspaceFiles,
  verifyGitRepository,
} from "@senawa/execution-host";
import {
  type AccountingAssessment,
  bindGitRevision,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createPhaseAttempt,
  createPhaseCandidate,
  createPhaseInputBinding,
  createSensorReading,
  createWorkerContextBase,
  createWorkerDispatch,
  defineGate,
  definitionGeneration,
  deriveCompletionRequirements,
  digestAccountingAssessment,
  digestPhaseOutputSet,
  digestSelectedTaskSet,
  type GitRevisionDescriptor,
  runId as kernelRunId,
  sha256Digest,
} from "@senawa/kernel";
import {
  type CommandSubmission,
  canonicalBytes,
  decodeCanonicalJsonValue,
  PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type RemoteRepositoryBinding,
} from "@senawa/protocol";
import { assertSecretSafePositiveProjection, decodeDeterministicReport } from "@senawa/reporting";
import {
  type AsyncEffectHost,
  createRoleAuthorizationPolicy,
  type EffectInspection,
  type EffectIntent,
  type EffectObservation,
  type QueuedEffectCommand,
  type RuntimeDependencies,
  renderPromptPack,
} from "@senawa/runtime";
import {
  checkSqliteAuthorityIntegrity,
  SqliteAuthority,
  SqliteContextBroker,
  SqlitePortalQueryAuthority,
  SqliteRemoteAuthority,
  SqliteRunnerAuthority,
  SqliteWorkspaceIntegrationAuthority,
} from "@senawa/storage-sqlite";
import {
  CompletionFactCommandBridge,
  HttpSupervisorClient,
  loadOrCreateLocalCredential,
  NodeEd25519RemoteCrypto,
  PortalApi,
  PortalSessionSecurity,
  RemoteConnector,
  remoteClassifiedReportSignatureBytes,
  SqliteSupervisorAuthority,
  SupervisorApi,
  SupervisorHttpHandler,
  SupervisorService,
  startLoopbackSupervisorServer,
  startUnixSupervisorServer,
} from "@senawa/supervisor";
import { deterministicSha256, runtimeCommand, runtimePrincipal } from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, SENAWA_VERSION } from "./cli.js";
import { recordTrustedIntegrationBarrier } from "./daemon.js";
import { createDiagnosticsDirectory, createRepairPlan } from "./maintenance.js";
import { createNodeCliDependencies } from "./node-cli.js";
import { ProductionScheduler } from "./production-scheduler.js";
import { exportSqliteReportingDirectory, verifyReportingDirectory } from "./report-export.js";
import {
  backupSupervisorState,
  restoreSupervisorStateBackup,
  verifySupervisorStateBackup,
} from "./state-backup.js";
import {
  DurableCompletionEligibility,
  DynamicWorkspaceEffectHost,
} from "./workspace-composition.js";

const CHECKOUT_ROOT = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("Phase 14F no-credit acceptance", () => {
  it("accepts detached and multi-worktree checkout baselines without branch assumptions", () => {
    expect(
      parseWorktreeRecords(
        "worktree /tmp/primary checkout\nHEAD 1111111111111111111111111111111111111111\ndetached\n\n" +
          "worktree /tmp/secondary\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/topic\n\n",
      ),
    ).toHaveLength(2);
  });

  it("composes the complete alpha journey without AI credits or mounted-checkout worktrees", async () => {
    const fixture = await temporaryRepository();
    try {
      const workflowPath = join(fixture.repositoryRoot, ".senawa", "workflow.json");

      expect(await runCli(["init", fixture.repositoryRoot], createNodeCliDependencies())).toEqual({
        output: `${join(fixture.repositoryRoot, ".senawa")}: created`,
        exitCode: 0,
      });
      // `init` now publishes the authored three-document tree, which is what a
      // person edits. This acceptance drives the lowered internal document, so
      // it writes that itself rather than expecting init to produce one.
      expect(await runCli(["doctor", fixture.repositoryRoot], createNodeCliDependencies())).toEqual(
        {
          output: `${fixture.repositoryRoot}/.senawa: valid`,
          exitCode: 0,
        },
      );

      const workflow = createWorktreeFanOutWorkflowConfiguration({
        integrationRef: fixture.targetRef,
        evidenceKind,
        tasks: [
          { key: "alpha", instruction: "Write alpha.txt" },
          { key: "beta", instruction: "Write beta.txt" },
        ],
      });
      await writeExampleResources(fixture.repositoryRoot);
      await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, { mode: 0o600 });
      expect(await runCli(["doctor", workflowPath], createNodeCliDependencies())).toEqual({
        output: `${workflowPath}: valid`,
        exitCode: 0,
      });
      await fixture.git(["add", "--all", "--", "."]);
      await fixture.git(["commit", "-m", "configure acceptance workflow"]);
      const baseRevision = await fixture.bindCurrentRevision();
      const baseSnapshot = await compileWorkflowConfiguration(
        {
          document: workflow,
          locator: workflowPath,
          resources: await RootScopedConfigurationResources.create(
            fixture.repositoryRoot,
            ".senawa",
          ),
        },
        deterministicSha256,
      );
      const amendment = compileWorkflowAmendment(
        {
          document: {
            apiVersion: WORKFLOW_AMENDMENT_API_VERSION,
            kind: "WorkflowAmendment",
            baseSnapshotDigest: baseSnapshot.snapshotDigest,
            baseContextDigest: "a".repeat(64),
            operations: [
              {
                kind: "add-phase",
                phase: {
                  key: "audit",
                  generation: 1,
                  dependsOn: ["work"],
                  input: {
                    schema: "work-input",
                    mappings: [
                      {
                        key: "workflow-input",
                        source: { kind: "workflow-input", pointer: "" },
                        destinationPointer: "",
                      },
                    ],
                  },
                  executor: { kind: "task-set", work: [] },
                  outputs: [],
                  iteration: {
                    maximumAttempts: 1,
                    onGateRejected: "fail",
                    onApprovalRejected: "fail",
                    onExhausted: "fail",
                  },
                  exit: { requiredOutputs: [], approval: { policy: "none" } },
                  actions: [],
                },
              },
            ],
          },
          locator: "fixture://phase-13f-amendment",
          baseSnapshot,
          phaseCandidateHistory: [],
        },
        deterministicSha256,
      );
      const phase = required(
        baseSnapshot.graph.nodes.find(
          (node) => node.kind === "phase" && node.definition.key === consumerKey("work"),
        ),
      );
      if (phase.kind !== "phase") throw new Error("Acceptance work phase is missing");
      const allowancePolicy = {
        policyDigest: sha256Digest("9".repeat(64)),
        ceilings: [{ unit: "work-attempt", maximum: 10 }],
      } as const;

      let supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      supervisor.commandAuthority.putConfigurationSnapshot(baseSnapshot);
      supervisor.commandAuthority.putConfigurationSnapshot(amendment.resultSnapshot);
      expect(
        submit(
          supervisor,
          runtimeCommand({
            commandId: "command_acceptance-instantiate",
            intent: "instantiate-run",
            payload: {
              workflowId: baseSnapshot.graph.workflowId,
              configurationSnapshotDigest: baseSnapshot.snapshotDigest,
              execution: baseSnapshot.execution,
              graph: baseSnapshot.graph,
              phase: {
                phaseId: phase.definition.id,
                definitionGeneration: phase.definition.generation,
              },
              approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
              escalationPolicyDigest: allowancePolicy.policyDigest,
              allowancePolicy,
            },
          }),
        ).status,
      ).toBe("completed");
      supervisor.close();

      const production = await createProductionJourney(fixture, baseSnapshot, baseRevision);
      await production.service.start();
      expect(production.workers.calls).toBe(2);
      for (let delivery = 0; delivery < 4; delivery += 1) {
        if (!production.deliverCompletion()) break;
      }
      for (let cycle = 0; cycle < 16; cycle += 1) {
        if (!(await production.service.runCycle()).worked) break;
      }
      expect(
        production.supervisor.commandAuthority.queryRunScheduling(
          ACCEPTANCE_REPOSITORY_ID,
          ACCEPTANCE_RUN_ID,
        )?.acceptedTasks,
        JSON.stringify(
          production.supervisor.commandAuthority
            .queryReceiptHistory(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
            .filter(({ commandId }) => commandId.startsWith("command_worker-completion-")),
        ),
      ).toHaveLength(2);
      const budgetProbe = production.escalateBudget();
      const escalation = budgetProbe.escalation;
      const escalationDigest = deterministicSha256.digest(canonicalBytes(escalation));
      expect(await production.service.status()).toMatchObject({
        health: "healthy",
        sdkSessionStore: { expectedSessionCount: 0, missingSessionIds: [] },
      });
      expect(await fixture.git(["show", `${fixture.targetRef}:alpha.txt`])).toBe("alpha\n");
      expect(await fixture.git(["show", `${fixture.targetRef}:beta.txt`])).toBe("beta\n");
      expect(
        production.workspaceAuthority
          .listWorkspaces(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
          .every(({ state }) => state === "removed"),
      ).toBe(true);
      expect(
        production.workspaceAuthority
          .listIntegrationAttempts(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
          .some(({ state }) => state === "barrier-recorded"),
      ).toBe(true);
      expect(
        production.runner
          .queryBudgets(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
          .some(({ unit, spent }) => unit === "dispatch-failure" && spent === 2),
      ).toBe(true);
      await production.service.stop();

      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const allowancePortal = new SqlitePortalQueryAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      // The agent list is the view that answers "who is stuck, and on what". It
      // named an agent's work by digest, and nothing else exercises this query,
      // which is how a validator that refused real data reached a release.
      const agents = allowancePortal.listAgents(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID).agents;
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents) {
        expect({
          namedTask: agent.taskName !== undefined && agent.taskName !== agent.taskId,
          namedPhase: agent.phaseName !== undefined && agent.phaseName !== agent.phaseId,
          // This journey runs deterministic writers and never chooses a model,
          // so having none to report is the correct answer here.
          model: agent.model,
        }).toEqual({ namedTask: true, namedPhase: true, model: undefined });
      }
      const allowanceReview = required(
        allowancePortal.getAllowanceReview(
          ACCEPTANCE_REPOSITORY_ID,
          ACCEPTANCE_RUN_ID,
          escalation.commandId,
        ),
      );
      allowancePortal.close();
      const allowanceReceipt = submit(
        supervisor,
        runtimeCommand({
          commandId: "command_acceptance-allowance",
          intent: "grant-allowance",
          payload: {
            escalationCommandId: escalation.commandId,
            operationId: escalation.operationId,
            escalationDigest,
            policyDigest: allowanceReview.allowancePolicyDigest,
            unit: escalation.unit,
            expectedLimit: allowanceReview.currentLimit,
            expectedRunModeRevision: allowanceReview.expectedRunModeRevision,
            increaseBy: Math.min(2, allowanceReview.maxIncrease),
          },
          expectedGraphRevision: allowanceReview.expectedGraphRevision,
          exactObjectDigest: escalationDigest,
        }),
      );
      expect(allowanceReceipt.status, JSON.stringify(allowanceReceipt)).toBe("completed");
      settleBudgetProbe(fixture, supervisor, budgetProbe.command);

      expect(
        submit(
          supervisor,
          runtimeCommand({
            commandId: "command_acceptance-amendment-proposal",
            intent: "submit-amendment-proposal",
            payload: { proposal: amendment.proposal },
            expectedGraphRevision: baseSnapshot.graph.revisionDigest,
            exactObjectDigest: amendment.proposal.proposalDigest,
          }),
        ).status,
      ).toBe("completed");
      const amendmentApproval = {
        ...runtimeCommand({
          commandId: "command_acceptance-amendment-approval",
          intent: "record-amendment-decision",
          payload: {
            amendmentId: amendment.proposal.amendmentId,
            proposalDigest: amendment.proposal.proposalDigest,
            decision: "approve",
            reviewedResultGraphRevisionDigest:
              amendment.proposal.reviewedResultGraph.revisionDigest,
          },
          expectedGraphRevision: baseSnapshot.graph.revisionDigest,
          exactObjectDigest: amendment.proposal.proposalDigest,
        }),
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: ACCEPTANCE_RUN_ID,
      };

      supervisor.close();
      let loseAcknowledgement = true;
      const crashingAuthority = new SqliteAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
        faultInjector(point) {
          if (loseAcknowledgement && point === "after-command-commit-before-ack") {
            loseAcknowledgement = false;
            throw new Error("simulated process crash after amendment approval commit");
          }
        },
      });
      expect(() => crashingAuthority.submit(amendmentApproval, admission())).toThrow(
        "simulated process crash after amendment approval commit",
      );
      crashingAuthority.close();

      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      expect(supervisor.commandAuthority.submit(amendmentApproval, admission())).toMatchObject({
        status: "completed",
      });
      supervisor.setMode("running", "2026-08-14T12:02:32.000Z");
      const approvedRecovery = required(supervisor.listApprovedAmendmentRecoveries()[0]);
      expect(approvedRecovery.observedQuiescent).toBe(true);
      expect(
        supervisor.queueApprovedAmendmentApply(approvedRecovery, "2026-08-14T12:02:32.000Z"),
      ).toBe(true);
      supervisor.setMode("stopped", "2026-08-14T12:02:32.000Z");
      const amendmentRecovery = new SupervisorService({
        authority: supervisor,
        clock: fixedClock("2026-08-14T12:02:33.000Z"),
        ownerId: "owner_acceptance-amendment-recovery",
        startupCycleLimit: 8,
      });
      await amendmentRecovery.start();
      const recoveredAmendment = supervisor.queryAmendment(
        ACCEPTANCE_REPOSITORY_ID,
        ACCEPTANCE_RUN_ID,
        amendment.proposal.amendmentId,
      );
      expect(
        recoveredAmendment,
        JSON.stringify({
          recoveries: supervisor.listApprovedAmendmentRecoveries(),
          receipts: supervisor
            .queryHistory(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
            .filter(({ commandId }) => commandId.startsWith("command_amendment-apply-")),
        }),
      ).toMatchObject({ lifecycle: { status: "applied" } });
      await amendmentRecovery.stop();

      supervisor = new SqliteSupervisorAuthority({
        databasePath: fixture.databasePath,
        assetDirectory: fixture.assetDirectory,
        dependencies,
      });
      const lifecycle = closeAcceptedPhase(supervisor, amendment.resultSnapshot.graph);
      expect(lifecycle.candidate.tasks).toHaveLength(2);

      supervisor.setMode("running", "2026-08-14T12:03:00.000Z");
      const remote = createRemoteJourney(fixture, supervisor);
      const acceptedRemote = remote.accept(
        remoteSubmission("command_acceptance-remote-pause", {
          expectedRunModeRevision: 0,
        }),
      );
      expect(acceptedRemote.envelope.acceptedCommand.attribution.principal).toEqual(
        remote.serverPrincipal,
      );
      remote.simulator.partition(remote.binding.bindingId);
      expect(await remote.connector.pumpOnce()).toMatchObject({ partitioned: true });
      expect(supervisor.queryLatest("command_acceptance-remote-pause")).toBeUndefined();
      remote.simulator.reconnect(remote.binding.bindingId);
      expect(await remote.connector.pumpOnce()).toMatchObject({
        admittedCommands: 1,
        partitioned: false,
      });
      drainLocalCommands(supervisor, remote.clock.now());
      expect(supervisor.queryLatest("command_acceptance-remote-pause")).toMatchObject({
        status: "terminal",
        terminalReceipt: { status: "completed" },
      });
      const remoteReporting = await remote.connector.pumpOnce();
      expect(remoteReporting.localResults).toBe(1);
      expect(remoteReporting.enqueuedReports).toBeGreaterThan(0);
      expect(remoteReporting.acknowledgedReports).toBeGreaterThan(0);
      for (let synchronization = 0; synchronization < 8; synchronization += 1) {
        if (remote.connector.status().synchronization.pendingReports === 0) break;
        await remote.connector.pumpOnce();
      }
      expect(remote.connector.status().synchronization).toMatchObject({
        state: "current",
        pendingReports: 0,
        enqueuedToAcknowledged: 0,
      });
      const sentReport = required(
        remote.transport
          .sentReports()
          .find(({ report }) => JSON.stringify(report).includes("command_acceptance-remote-pause")),
      );
      expect(sentReport.report.receiptChains[0]?.entries.map(({ stage }) => stage)).toEqual([
        "central-accepted",
        "connector-delivered",
        "local-accepted",
        "runner-claimed",
        "local-outcome",
      ]);
      expect(
        remote.repositoryVerifier.verify(
          remote.binding.repositoryKeyId,
          remoteClassifiedReportSignatureBytes(sentReport.report),
          sentReport.signature,
        ),
      ).toBe(true);
      expect(
        remote.transport
          .acknowledgements()
          .some(({ reportId }) => reportId === sentReport.report.reportId),
      ).toBe(true);
      await remote.close();

      await observePortal(fixture, supervisor, amendment.resultSnapshot.graph.revisionDigest);
      supervisor.setMode("stopped", "2026-08-14T12:04:00.000Z");
      supervisor.close();

      const firstExport = join(fixture.root, "report-first");
      const secondExport = join(fixture.root, "report-second");
      const firstManifest = exportSqliteReportingDirectory({
        databasePath: fixture.databasePath,
        dependencies,
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: ACCEPTANCE_RUN_ID,
        destinationDirectory: firstExport,
      });
      const secondManifest = exportSqliteReportingDirectory({
        databasePath: fixture.databasePath,
        dependencies,
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: ACCEPTANCE_RUN_ID,
        destinationDirectory: secondExport,
      });
      expect(verifyReportingDirectory(firstExport, deterministicSha256)).toEqual(firstManifest);
      expect(secondManifest.reportDigest).toBe(firstManifest.reportDigest);
      expect(await readFile(join(secondExport, "report.json"))).toEqual(
        await readFile(join(firstExport, "report.json")),
      );
      const deterministicReport = decodeDeterministicReport(
        await readFile(join(firstExport, "report.json")),
      );
      for (const section of [
        "assets",
        "amendments",
        "escalations",
        "gates",
        "approvals",
        "costs",
        "workspaces",
        "integration",
        "portal",
        "remote",
      ] as const) {
        const reportSection = deterministicReport.sections.find(({ name }) => name === section);
        expect(reportSection?.status, section).toBe("complete");
      }
      const serializedReport = JSON.stringify(deterministicReport);
      assertSecretSafePositiveProjection(serializedReport, "Phase 13F report");
      expect(serializedReport).toContain("command_acceptance-close");
      expect(serializedReport).toContain("command_acceptance-remote-pause");
      expect(serializedReport).not.toContain("ai-credits");
      expect(serializedReport).not.toContain("github-copilot");

      await verifyMaintenanceAndRestore(fixture, firstManifest.reportDigest);

      for (const name of [
        "SENAWA_COPILOT_LIVE",
        "SENAWA_COPILOT_MODEL",
        "SENAWA_COPILOT_TIMEOUT_MS",
        "SENAWA_COPILOT_ACKNOWLEDGE_COST_AND_DATA",
      ]) {
        expect(process.env[name]).toBeUndefined();
      }
      expect(production.sdkAdapterConstructions).toBe(0);
      expect(production.modelCalls).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);
});

const ACCEPTANCE_REPOSITORY_ID = "repository_acceptance";
const ACCEPTANCE_RUN_ID = "run_acceptance";
const identity = Object.freeze({
  repositoryId: ACCEPTANCE_REPOSITORY_ID,
  runId: ACCEPTANCE_RUN_ID,
});
const evidenceKind = canonicalValue({ name: "acceptance-output", version: 1 });
let allocationSequence = 0;
const dependencies: RuntimeDependencies = Object.freeze({
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "submit-completion", roles: ["engine", "release-manager"] },
    { intent: "evaluate-gate", roles: ["engine", "release-manager"] },
    { intent: "record-authority-decision", roles: ["release-manager"] },
    { intent: "close-phase", roles: ["engine", "release-manager"] },
    { intent: "record-phase-attempt-transition", roles: ["engine", "release-manager"] },
    { intent: "import-plan", roles: ["engine", "release-manager"] },
    { intent: "record-fan-out-diff-decision", roles: ["engine", "release-manager"] },
    { intent: "submit-amendment-proposal", roles: ["engine", "release-manager"] },
    { intent: "record-amendment-decision", roles: ["release-manager"] },
    { intent: "apply-approved-amendment", roles: ["trusted-supervisor"] },
    { intent: "record-integration-barrier", roles: ["trusted-supervisor"] },
    { intent: "grant-allowance", roles: ["release-manager"] },
    { intent: "pause-run", roles: ["operator", "release-manager"] },
  ]),
});

function admission() {
  return {
    currentTime: "2026-08-14T12:00:00.000Z",
    facts: { source: "phase-13f-acceptance" },
    allocateId(kind: "approval" | "stream-event") {
      allocationSequence += 1;
      return kind === "approval"
        ? `approval_acceptance-${allocationSequence}`
        : `stream-event-acceptance-${allocationSequence}`;
    },
  };
}

function submit(supervisor: SqliteSupervisorAuthority, command: ReturnType<typeof runtimeCommand>) {
  return supervisor.commandAuthority.submit(
    {
      ...command,
      repositoryId: ACCEPTANCE_REPOSITORY_ID,
      runId: ACCEPTANCE_RUN_ID,
    },
    admission(),
  );
}

function fixedClock(timestamp: string) {
  return { now: () => Date.parse(timestamp) };
}

async function createProductionJourney(
  fixture: TemporaryRepository,
  snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>,
  baseRevision: GitRevisionDescriptor,
) {
  const supervisor = new SqliteSupervisorAuthority({
    databasePath: fixture.databasePath,
    assetDirectory: fixture.assetDirectory,
    dependencies,
  });
  const runner = new SqliteRunnerAuthority({
    databasePath: fixture.databasePath,
    dependencies,
  });
  const workspaceAuthority = new SqliteWorkspaceIntegrationAuthority({
    databasePath: fixture.databasePath,
    dependencies,
  });
  let broker: SqliteContextBroker;
  const eligibility = new DurableCompletionEligibility({
    workspaceAuthority,
    runnerAuthority: runner,
    sha256: deterministicSha256,
    currentIntegrationBarrier: (repositoryId, runId) =>
      supervisor.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
  });
  const completionBridge = new CompletionFactCommandBridge({
    authority: supervisor,
    broker: () => broker,
    completionEligibility: eligibility,
    currentTime: () => "2026-08-14T12:02:00.000Z",
  });
  broker = new SqliteContextBroker({
    databasePath: fixture.databasePath,
    dependencies: {
      sha256: deterministicSha256,
      currentTime: () => "2026-08-14T12:02:00.000Z",
      issueGrantToken: () => new Uint8Array(32).fill(13),
    },
    completionFacts: completionBridge,
  });
  const seeds = createAcceptanceSeeds(snapshot, baseRevision);
  for (const seed of seeds) {
    supervisor.commandAuthority.putAsset(
      canonicalBytes(seed.mappedInput.value),
      "application/json",
    );
    expect(
      supervisor.commandAuthority.appendPhaseAttempt(seed.phaseAttempt, seed.phaseInputBinding),
    ).toBe("created");
    broker.registerDispatch({
      context: seed.context,
      dispatch: seed.dispatch,
      completionRequirements: seed.completionRequirements,
      taskScope: seed.taskScope,
      effect: {
        input: decodeCanonicalJsonValue({
          dispatchId: seed.dispatch.dispatchId,
          write: { path: seed.path, content: seed.content },
        }),
        budgetReservation: { unit: "dispatch-failure", amount: 1 },
        baseRevision,
        integrationGatePolicyDigest: sha256Digest("7".repeat(64)),
      },
    });
  }
  const verified = await verifyGitRepository(fixture.command, {
    repositoryRoot: fixture.repositoryRoot,
    ownedRoot: fixture.ownedRoot,
    targetRef: fixture.targetRef,
    expectedRevision: baseRevision,
  });
  const gitHost = new DurableWorkspaceEffectHost({
    authority: workspaceAuthority,
    workspace: new GitWorkspaceAdapter(fixture.command, verified),
    integration: new GitIntegrationAdapter(fixture.command, verified),
    identity: {
      authorName: "Senawa Acceptance Worker",
      authorEmail: "worker@senawa.invalid",
      authorDate: "2000-01-01T00:00:00Z",
      committerName: "Senawa Acceptance Integration",
      committerEmail: "integration@senawa.invalid",
      committerDate: "2000-01-01T00:00:00Z",
    },
    sha256: deterministicSha256,
    evaluateIntegration: async (root) => {
      const files = await RootScopedWorkspaceFiles.create(root);
      return {
        decision:
          (await files.read("alpha.txt")) === "alpha\n" &&
          (await files.read("beta.txt")) === "beta\n"
            ? ("passed" as const)
            : ("failed" as const),
        evidence: { sensor: "phase-13f-deterministic-fan-in" },
      };
    },
    recordTrustedBarrier: (repositoryId, runId, integrationId, barrier) => {
      const binding = required(supervisor.commandAuthority.queryRunExecution(repositoryId, runId));
      recordTrustedIntegrationBarrier(
        supervisor,
        binding,
        repositoryId,
        runId,
        integrationId,
        barrier,
      );
    },
    currentTrustedBarrier: (repositoryId, runId) =>
      supervisor.commandAuthority.queryIntegrationBarrier(repositoryId, runId),
    currentTime: () => "2026-08-14T12:02:00.000Z",
  });
  const workers = new DeterministicAcceptanceWorkers(broker, supervisor.commandAuthority, seeds);
  const acquiredRunnerLease = supervisor.acquireRunLease(
    ACCEPTANCE_REPOSITORY_ID,
    ACCEPTANCE_RUN_ID,
    "owner_acceptance-production",
    "2026-08-14T12:02:00.000Z",
    "2026-08-14T12:02:30.000Z",
  );
  const runnerLease = {
    owner: acquiredRunnerLease.ownerId,
    fence: acquiredRunnerLease.fence,
    expiresAt: acquiredRunnerLease.expiresAt,
  } as const;
  runner.configureRun({
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    runId: ACCEPTANCE_RUN_ID,
    contextDigest: deterministicSha256.digest(
      canonicalBytes(seeds.map(({ context }) => context.contextDigest)),
    ),
    taskScopes: seeds.map(({ taskScope }) => ({ ...taskScope, claimsAccepted: true })),
    budgets: [
      { unit: "work-attempt", limit: 1 },
      { unit: "dispatch-failure", limit: 2 },
      { unit: "workspace-operations", limit: 20 },
    ],
    capacities: [{ resource: "writer", limit: 2, occupied: 0 }],
    lease: runnerLease,
  });
  runner.bindAllowancePolicy(
    ACCEPTANCE_REPOSITORY_ID,
    ACCEPTANCE_RUN_ID,
    required(
      supervisor.commandAuthority.queryRunExecution(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID),
    ).allowancePolicy,
  );
  const dynamic = new DynamicWorkspaceEffectHost({
    authority: supervisor,
    workspaceAuthority,
    repositoryRoot: fixture.repositoryRoot,
    hostWriterCapacity: 2,
    createWorkerHost: (root) => workers.host(root),
    createGitHost: async () => gitHost,
  });
  const scheduler = new ProductionScheduler({
    authority: supervisor,
    runnerAuthority: runner,
    workspaceAuthority,
    contextBroker: broker,
    supervisorWriterLimit: 2,
    hostWriterLimit: 2,
    sha256: deterministicSha256,
  });
  const service = new SupervisorService({
    authority: supervisor,
    clock: fixedClock("2026-08-14T12:02:00.000Z"),
    ownerId: "owner_acceptance-production",
    startupCycleLimit: 256,
    asyncEffectHost: dynamic,
    runnerBatchSize: 2,
    scheduleBeforeEffects: ({ repositoryId, runId, lease, currentTime }) =>
      scheduler.schedule({ repositoryId, runId, lease, currentTime }),
    listSchedulableRuns: () => scheduler.listRuns(),
    deliverCompletionOutboxOnce: () => broker.deliverCompletionOutboxOnce(),
    failurePolicyForRun: () => "continue",
    sessionStoreHealth: {
      health: async (expectedSessionIds) => ({
        status: "healthy" as const,
        expectedSessionCount: expectedSessionIds.length,
        missingSessionIds: Object.freeze([] as string[]),
      }),
    },
    closeables: [
      { close: () => broker.close() },
      { close: () => workspaceAuthority.close() },
      { close: () => runner.close() },
    ],
  });
  return {
    service,
    supervisor,
    runner,
    workspaceAuthority,
    workers,
    deliverCompletion: () => broker.deliverCompletionOutboxOnce(),
    escalateBudget() {
      const acquired = supervisor.acquireRunLease(
        ACCEPTANCE_REPOSITORY_ID,
        ACCEPTANCE_RUN_ID,
        "owner_acceptance-production",
        "2026-08-14T12:02:00.000Z",
        "2026-08-14T12:02:30.000Z",
      );
      const currentRunnerLease = {
        owner: acquired.ownerId,
        fence: acquired.fence,
        expiresAt: acquired.expiresAt,
      } as const;
      const escalationCommand = {
        sequence: 99,
        commandId: "runner-command-acceptance-budget",
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: ACCEPTANCE_RUN_ID,
        operationId: "operation_acceptance-budget",
        kind: "sensor" as const,
        taskScope: required(seeds[0]).taskScope,
        contextDigest: required(seeds[0]).context.contextDigest,
        inputDigest: deterministicSha256.digest(canonicalBytes({ probe: "budget-only" })),
        input: decodeCanonicalJsonValue({ probe: "budget-only" }),
        budgetReservation: { unit: "work-attempt", amount: 2 },
        queuedAt: "2026-08-14T12:02:00.000Z",
        maxReconciliationAttempts: 1,
      };
      runner.enqueue(escalationCommand);
      const result = runner.persistIntent({
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: ACCEPTANCE_RUN_ID,
        lease: currentRunnerLease,
        currentTime: "2026-08-14T12:02:00.000Z",
        attemptId: "attempt_acceptance-budget",
        command: escalationCommand,
      });
      if (result.type !== "escalated") {
        throw new Error("Acceptance budget probe did not escalate");
      }
      return { command: escalationCommand, escalation: result.escalation };
    },
    sdkAdapterConstructions: 0,
    modelCalls: 0,
  };
}

function settleBudgetProbe(
  fixture: TemporaryRepository,
  supervisor: SqliteSupervisorAuthority,
  command: QueuedEffectCommand,
): void {
  const runner = new SqliteRunnerAuthority({
    databasePath: fixture.databasePath,
    dependencies,
  });
  const acquired = supervisor.acquireRunLease(
    ACCEPTANCE_REPOSITORY_ID,
    ACCEPTANCE_RUN_ID,
    "owner_acceptance-budget-resolution",
    "2026-08-14T12:02:31.000Z",
    "2026-08-14T12:03:01.000Z",
  );
  const lease = {
    owner: acquired.ownerId,
    fence: acquired.fence,
    expiresAt: acquired.expiresAt,
  };
  const persisted = runner.persistIntent({
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    runId: ACCEPTANCE_RUN_ID,
    lease,
    currentTime: "2026-08-14T12:02:31.000Z",
    attemptId: "attempt_acceptance-budget-resolution",
    command,
  });
  if (persisted.type !== "persisted") throw new Error("Allowed budget probe was not persisted");
  const scope = required(
    runner
      .load(identity)
      .taskScopes.find(
        ({ taskId, definitionGeneration }) =>
          taskId === command.taskScope.taskId &&
          definitionGeneration === command.taskScope.definitionGeneration,
      ),
  );
  const claim = runner.claimEffectAttempt({
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    runId: ACCEPTANCE_RUN_ID,
    lease,
    currentTime: "2026-08-14T12:02:31.000Z",
    attemptId: "attempt_acceptance-budget-resolution",
    intent: persisted.intent,
    taskScope: scope,
  });
  if (claim.type !== "claimed") throw new Error("Allowed budget probe was not claimable");
  expect(
    runner.commitEffect({
      repositoryId: ACCEPTANCE_REPOSITORY_ID,
      runId: ACCEPTANCE_RUN_ID,
      lease,
      currentTime: "2026-08-14T12:02:31.000Z",
      attemptId: "attempt_acceptance-budget-resolution",
      intent: persisted.intent,
      observation: {
        status: "cancelled",
        observedAt: "2026-08-14T12:02:31.000Z",
        details: { resolution: "human-allowance-recorded-no-execution-required" },
      },
    }).status,
  ).toBe("cancelled");
  const unsettled = runner
    .load(identity)
    .effects.filter(({ outcome }) => outcome === undefined)
    .map(({ intent }) => ({ kind: intent.command.kind, operationId: intent.command.operationId }));
  expect(unsettled, JSON.stringify(unsettled)).toEqual([]);
  runner.close();
  supervisor.releaseRunLease(acquired, "2026-08-14T12:02:31.000Z");
}

function createAcceptanceSeeds(
  snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>,
  baseRevision: GitRevisionDescriptor,
) {
  const tasks = snapshot.graph.nodes.filter(
    (node) => node.kind === "task" && ["alpha", "beta"].includes(node.definition.key),
  );
  expect(tasks).toHaveLength(2);
  const repositoryRevisionDigest = bindGitRevision(
    baseRevision,
    deterministicSha256,
  ).descriptorDigest;
  return tasks.map((node, index) => {
    if (node.kind !== "task") throw new Error("Acceptance task is missing");
    const task = {
      taskId: node.definition.id,
      definitionGeneration: node.definition.generation,
    };
    const mappedInput = acceptanceMappedInput(
      (node.definition.input as unknown as { readonly value: unknown }).value,
    );
    const phaseReference = {
      phaseId: node.definition.parentId,
      definitionGeneration:
        snapshot.graph.nodes.find(
          (candidate) =>
            candidate.kind === "phase" && candidate.definition.id === node.definition.parentId,
        )?.definition.generation ?? definitionGeneration(1),
      attempt: index + 1,
    };
    const sourceSetDigest = canonicalDigest(canonicalValue({ mappings: [] }), deterministicSha256);
    const phaseInputBinding = createPhaseInputBinding(
      {
        phase: phaseReference,
        schemaKey: consumerKey("work-input"),
        schemaResourceDigest: required(snapshot.schemas[0]).source.contentDigest,
        mappings: [],
        contentDigest: mappedInput.valueDigest,
        byteLength: canonicalBytes(mappedInput.value).byteLength,
        validationReceiptDigest: sha256Digest("7".repeat(64)),
        sourceSetDigest,
      },
      deterministicSha256,
    );
    const phaseAttempt = createPhaseAttempt(
      {
        repositoryId: ACCEPTANCE_REPOSITORY_ID,
        runId: kernelRunId(ACCEPTANCE_RUN_ID),
        phase: phaseReference,
        inputBindingDigest: phaseInputBinding.bindingDigest,
        sourceSetDigest,
        executorDigest: sha256Digest("8".repeat(64)),
        graphRevisionDigest: snapshot.graph.revisionDigest,
        configurationSnapshotDigest: snapshot.snapshotDigest,
        upstreamClosureSetDigest: sha256Digest("9".repeat(64)),
        upstreamOutputSetDigest: sha256Digest("0".repeat(64)),
      },
      deterministicSha256,
    );
    const context = createWorkerContextBase(
      {
        task,
        graphRevisionDigest: snapshot.graph.revisionDigest,
        configurationSnapshotDigest: snapshot.snapshotDigest,
        contracts: [],
        dependencyBarrier: { task, dependencies: [] },
        assets: [],
        repositoryBase: {
          commitDigest: repositoryRevisionDigest,
          treeDigest: repositoryRevisionDigest,
        },
        modelPolicy: {
          key: consumerKey("no-model"),
          policyDigest: sha256Digest("5".repeat(64)),
          orderedRoutesDigest: sha256Digest("6".repeat(64)),
        },
        role: {
          key: consumerKey("deterministic-writer"),
          roleDigest: sha256Digest("4".repeat(64)),
        },
        prompt: acceptancePrompt(snapshot),
        mappedInput,
        phaseAttempt,
        phaseInputBinding,
        phaseOutputDeclarations: [],
        completionPolicy: node.definition.completionPolicy,
        priorRefusals: [],
        answeredQuestions: [],
        capabilities: ["worker.submit.asset", "worker.submit.completion"],
        budgets: [{ unit: "dispatch-failure", limit: 1 }],
      },
      deterministicSha256,
    );
    const dispatchInput = {
      repositoryId: ACCEPTANCE_REPOSITORY_ID,
      runId: kernelRunId(ACCEPTANCE_RUN_ID),
      ordinal: index + 1,
      workerPrincipalId: `principal_acceptance-${index + 1}`,
      roleKey: consumerKey("deterministic-writer"),
      capabilities: ["worker.submit.asset", "worker.submit.completion"],
      promptResource: acceptancePromptReference(snapshot),
      promptPackDigest: sha256Digest("0".repeat(64)),
    };
    const provisional = createWorkerDispatch(dispatchInput, context, deterministicSha256);
    const prompt = renderPromptPack(context, provisional, deterministicSha256, 65_536);
    const dispatch = createWorkerDispatch(
      { ...dispatchInput, promptPackDigest: prompt.digest },
      context,
      deterministicSha256,
    );
    const completionRequirements = required(
      deriveCompletionRequirements(snapshot.graph, [dispatch.task], deterministicSha256)[0],
    );
    const key = String(node.definition.key);
    return Object.freeze({
      key,
      path: `${key}.txt`,
      content: `${key}\n`,
      context,
      dispatch,
      mappedInput,
      phaseAttempt,
      phaseInputBinding,
      completionRequirements,
      taskScope: {
        runId: ACCEPTANCE_RUN_ID,
        taskId: node.definition.id,
        definitionGeneration: node.definition.generation,
        acceptedContextDigest: context.contextDigest,
        fenceGeneration: 1,
      },
    });
  });
}

function acceptancePrompt(snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>) {
  const resource = snapshot.prompts[0];
  if (resource === undefined) throw new Error("Acceptance prompt resource is missing");
  return {
    key: resource.key,
    path: resource.source.path,
    resourceDigest: resource.digest,
    contentDigest: resource.source.contentDigest,
    byteLength: resource.source.byteLength,
    utf8: resource.source.utf8,
    inputPaths: resource.inputPaths,
  };
}

function acceptancePromptReference(
  snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>,
) {
  const prompt = acceptancePrompt(snapshot);
  return {
    key: prompt.key,
    resourceDigest: prompt.resourceDigest,
    contentDigest: prompt.contentDigest,
  };
}

function acceptanceMappedInput(value: unknown) {
  const mapped = canonicalValue(value);
  return { value: mapped, valueDigest: canonicalDigest(mapped, deterministicSha256) };
}

async function writeExampleResources(repositoryRoot: string): Promise<void> {
  const resources = createExampleWorkflowResources();
  for (const [path, content] of Object.entries(resources)) {
    const destination = join(repositoryRoot, ".senawa", path);
    await mkdir(destination.slice(0, destination.lastIndexOf("/")), { recursive: true });
    await writeFile(destination, content, { mode: 0o600 });
  }
}

type AcceptanceSeed = ReturnType<typeof createAcceptanceSeeds>[number];

class DeterministicAcceptanceWorkers {
  readonly #completed = new Set<string>();
  calls = 0;

  constructor(
    readonly broker: SqliteContextBroker,
    readonly authority: SqliteAuthority,
    readonly seeds: readonly AcceptanceSeed[],
  ) {}

  host(root: string): AsyncEffectHost {
    return {
      dispatch: (intent) => this.dispatch(root, intent),
      inspect: (intent) => this.inspect(intent),
      cancel: () => this.cancel(),
    };
  }

  async dispatch(root: string, intent: EffectIntent): Promise<EffectObservation> {
    const worker = object(intent.command.input);
    const dispatchId = requiredString(worker.dispatchId);
    const seed = required(this.seeds.find(({ dispatch }) => dispatch.dispatchId === dispatchId));
    if (!this.#completed.has(dispatchId)) {
      const write = object(worker.write);
      await (await RootScopedWorkspaceFiles.create(root)).write(
        requiredString(write.path),
        requiredString(write.content),
      );
      const bytes = new TextEncoder().encode(`evidence:${seed.key}\n`);
      const contentDigest = deterministicSha256.digest(bytes);
      const assetId = `asset_acceptance-${seed.key}`;
      expect(
        this.broker.admitSubmission({
          submission: {
            apiVersion: PROTOCOL_VERSION,
            submissionId: `submission_acceptance-asset-${seed.key}`,
            repositoryId: ACCEPTANCE_REPOSITORY_ID,
            runId: ACCEPTANCE_RUN_ID,
            dispatchId: seed.dispatch.dispatchId,
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
              summary: `Deterministic ${seed.key} output`,
            },
          },
        }).status,
      ).toBe("accepted");
      this.authority.putAsset(bytes, "text/plain");
      expect(
        this.broker.admitSubmission({
          submission: {
            apiVersion: PROTOCOL_VERSION,
            submissionId: `submission_acceptance-completion-${seed.key}`,
            repositoryId: ACCEPTANCE_REPOSITORY_ID,
            runId: ACCEPTANCE_RUN_ID,
            dispatchId: seed.dispatch.dispatchId,
            task: seed.dispatch.task,
            contextId: seed.dispatch.contextId,
            contextDigest: seed.dispatch.contextDigest,
            principalId: seed.dispatch.worker.principalId,
            type: "completion",
            completion: {
              task: seed.dispatch.task,
              disposition: "completed",
              summary: `Completed deterministic ${seed.key} writer`,
              criteria: seed.completionRequirements.criteria.map(({ criterionId }) => ({
                criterionId,
                disposition: "satisfied" as const,
              })),
              completionEvidence: [
                {
                  assetId,
                  kind: evidenceKind,
                  descriptor: canonicalValue({ path: seed.path, source: "deterministic-worker" }),
                },
              ],
            },
          },
        }).status,
      ).toBe("accepted");
      this.#completed.add(dispatchId);
      this.calls += 1;
    }
    return {
      status: "completed",
      observedAt: "2026-08-14T12:02:00.000Z",
      details: { worker: "deterministic", dispatchId },
    };
  }

  async inspect(intent: EffectIntent): Promise<EffectInspection> {
    const worker = object(intent.command.input);
    const dispatchId = requiredString(worker.dispatchId);
    return {
      status: this.#completed.has(dispatchId) ? "completed" : "missing",
      observedAt: "2026-08-14T12:02:00.000Z",
    };
  }

  async cancel(): Promise<EffectObservation> {
    return { status: "cancelled", observedAt: "2026-08-14T12:02:00.000Z" };
  }
}

function closeAcceptedPhase(
  supervisor: SqliteSupervisorAuthority,
  graph: Awaited<ReturnType<typeof compileWorkflowConfiguration>>["graph"],
) {
  const barrier = required(
    supervisor.commandAuthority.queryIntegrationBarrier(
      ACCEPTANCE_REPOSITORY_ID,
      ACCEPTANCE_RUN_ID,
    ),
  );
  const assessments = supervisor.commandAuthority
    .queryReceiptHistory(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID)
    .flatMap((receipt) => {
      const result = receipt.result as { assessment?: AccountingAssessment } | undefined;
      return result?.assessment === undefined
        ? []
        : [
            {
              assessment: result.assessment,
              assessmentDigest: digestAccountingAssessment(result.assessment, deterministicSha256),
            },
          ];
    });
  expect(assessments).toHaveLength(2);
  const tasks = assessments.map(({ assessment }) => assessment.submission.task);
  const scheduling = required(
    supervisor.commandAuthority.queryRunScheduling(ACCEPTANCE_REPOSITORY_ID, ACCEPTANCE_RUN_ID),
  );
  const gateDefinition = defineGate(
    {
      key: consumerKey("acceptance"),
      blocking: [
        {
          key: consumerKey("fan-in-passed"),
          condition: {
            operator: "equals",
            accessor: { sensorKey: consumerKey("integration"), pointer: "/passed" },
            expected: true,
          },
        },
      ],
      advisory: [],
    },
    deterministicSha256,
  );
  const candidate = createPhaseCandidate(
    {
      phase: scheduling.phase,
      phaseAttempt: { ...scheduling.phase, attempt: 1 },
      graphRevisionDigest: graph.revisionDigest,
      inputBindingDigest: graph.revisionDigest,
      requiredOutputPublications: [],
      outputSetDigest: digestPhaseOutputSet([], deterministicSha256),
      selectedTaskSetDigest: digestSelectedTaskSet(tasks, deterministicSha256),
      tasks,
      acceptedAccountingAssessments: assessments,
      dependencyBarrierDigest: sha256Digest("b".repeat(64)),
      integrationBarrierDigest: barrier.barrierDigest,
      gatePolicyDigest: gateDefinition.policyDigest,
    },
    graph,
    deterministicSha256,
  );
  const reading = createSensorReading(
    {
      sensorKey: consumerKey("integration"),
      inputDigest: candidate.candidateDigest,
      outcome: "succeeded",
      data: { passed: true },
    },
    deterministicSha256,
  );
  expect(
    submit(
      supervisor,
      runtimeCommand({
        commandId: "command_acceptance-gate",
        intent: "evaluate-gate",
        payload: {
          phase: scheduling.phase,
          phaseAttempt: candidate.phaseAttempt,
          inputBindingDigest: candidate.inputBindingDigest,
          requiredOutputPublications: candidate.requiredOutputPublications,
          outputSetDigest: candidate.outputSetDigest,
          dependencyBarrierDigest: sha256Digest("b".repeat(64)),
          integrationBarrierDigest: barrier.barrierDigest,
          gateDefinition,
          readings: [reading],
        },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
    ).status,
  ).toBe("completed");
  expect(
    submit(
      supervisor,
      runtimeCommand({
        commandId: "command_acceptance-human-approval",
        intent: "record-authority-decision",
        payload: { decision: "approve" },
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
    ).status,
  ).toBe("completed");
  expect(
    submit(
      supervisor,
      runtimeCommand({
        commandId: "command_acceptance-close",
        intent: "close-phase",
        payload: {},
        expectedGraphRevision: graph.revisionDigest,
        exactObjectDigest: candidate.candidateDigest,
      }),
    ).status,
  ).toBe("completed");
  return { candidate };
}

function createRemoteJourney(fixture: TemporaryRepository, supervisor: SqliteSupervisorAuthority) {
  const clock = new VirtualClock("2026-08-14T12:03:00.000Z");
  const random = new DeterministicRandom("acceptance");
  const repositoryKey = createEd25519FixtureKeyPair("key-repository-acceptance", "71".repeat(32));
  const controlPlaneKey = createEd25519FixtureKeyPair(
    "key-control-plane-acceptance",
    "82".repeat(32),
  );
  const binding: RemoteRepositoryBinding = {
    apiVersion: REMOTE_PROTOCOL_VERSION,
    bindingId: "binding-acceptance",
    tenantId: "tenant-acceptance",
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    connectorId: "connector-acceptance",
    repositoryKeyId: repositoryKey.keyId,
    controlPlaneKeyId: controlPlaneKey.keyId,
    revocationEpoch: 0,
    policyDigest: "3".repeat(64),
    issuedAt: clock.now(),
  };
  const serverPrincipal = {
    issuer: "https://identity.example.test",
    subject: "operator-acceptance",
    tenant: binding.tenantId,
    assurance: "multi-factor" as const,
    roles: ["operator"],
  };
  const authority = new ReferenceControlPlane({
    clock,
    random,
    serverPeerId: "control-plane-acceptance",
    signingKey: controlPlaneKey,
    sha256: deterministicSha256,
  });
  authority.register({ binding, repositoryPublicKey: repositoryKey.publicKey });
  const simulator = new DeterministicControlPlaneSimulator({ authority, clock, random });
  const transport = new InProcessControlPlaneTransport({ authority, simulator, binding });
  const crypto = new NodeEd25519RemoteCrypto({
    publicKeys: new Map([[controlPlaneKey.keyId, controlPlaneKey.publicKey]]),
    privateKeys: new Map([[repositoryKey.keyId, repositoryKey.privateKey]]),
  });
  const repositoryVerifier = new NodeEd25519RemoteCrypto({
    publicKeys: new Map([[repositoryKey.keyId, repositoryKey.publicKey]]),
  });
  const remoteAuthority = new SqliteRemoteAuthority({
    databasePath: fixture.databasePath,
    dependencies,
  });
  let reportSequence = 0;
  const connector = new RemoteConnector({
    authority: remoteAuthority,
    supervisorApi: new SupervisorApi(supervisor),
    binding,
    policy: {
      policyDigest: binding.policyDigest,
      roleMappings: [
        {
          issuer: serverPrincipal.issuer,
          tenant: binding.tenantId,
          upstreamRole: "operator",
          localRoles: ["release-manager"],
        },
      ],
      maximumRemoteAuthorizationLeaseSeconds: 900,
      synchronization: {
        classificationCeiling: "internal",
        receiptChain: true,
        events: true,
        projections: true,
        synchronizationState: true,
      },
    },
    transport,
    verifier: crypto,
    signer: crypto,
    clock: { now: () => Date.parse(clock.now()) },
    ids: { allocate: () => `report_acceptance-${++reportSequence}` },
    admissionAllocator: {
      allocationsFor: (submission) =>
        [1, 2, 3].map((ordinal) => ({
          kind: "stream-event" as const,
          id: `stream-event-${submission.commandId}-${ordinal}`,
        })),
    },
    ownerId: "owner_acceptance-remote",
    batchSize: 8,
    pollIntervalMs: 60_000,
  });
  return {
    clock,
    binding,
    simulator,
    transport,
    connector,
    serverPrincipal,
    repositoryVerifier,
    accept(command: CommandSubmission) {
      const result = authority.acceptCommand(
        {
          repositoryKeyId: repositoryKey.keyId,
          connectorId: binding.connectorId,
          requestId: `request-${command.commandId}`,
          command,
          signature: signCommandIngress(repositoryKey.privateKey, command),
          principal: {
            issuer: "https://untrusted.invalid",
            subject: "forged-client-actor",
            tenant: "tenant-forged",
            assurance: "single-factor",
            roles: ["administrator"],
          },
        } as Parameters<ReferenceControlPlane["acceptCommand"]>[0],
        { principal: serverPrincipal },
      );
      if (result.type !== "accepted") throw new Error(`Remote command refused: ${result.code}`);
      return result;
    },
    async close() {
      await connector.close();
      remoteAuthority.close();
    },
  };
}

function remoteSubmission(commandId: string, payload: object): CommandSubmission {
  const command = {
    ...runtimeCommand({
      commandId,
      intent: "pause-run",
      payload,
      expiresAt: "2026-08-14T12:13:00.000Z",
    }),
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    runId: ACCEPTANCE_RUN_ID,
  };
  const { principal: _principal, transport: _transport, ...submission } = command;
  return submission;
}

function drainLocalCommands(supervisor: SqliteSupervisorAuthority, currentTime: string): void {
  const lease = supervisor.acquireRunLease(
    ACCEPTANCE_REPOSITORY_ID,
    ACCEPTANCE_RUN_ID,
    "owner_acceptance-remote-runner",
    currentTime,
    new Date(Date.parse(currentTime) + 60_000).toISOString(),
  );
  for (let index = 0; index < 4; index += 1) {
    supervisor.drainRunOnce({
      repositoryId: ACCEPTANCE_REPOSITORY_ID,
      runId: ACCEPTANCE_RUN_ID,
      lease,
      currentTime,
    });
  }
  supervisor.releaseRunLease(lease, currentTime);
}

async function observePortal(
  fixture: TemporaryRepository,
  supervisor: SqliteSupervisorAuthority,
  expectedGraphRevision: string,
): Promise<void> {
  const query = new SqlitePortalQueryAuthority({
    databasePath: fixture.databasePath,
    assetDirectory: fixture.assetDirectory,
    dependencies,
  });
  const api = new SupervisorApi(supervisor, "supervisor_acceptance", new PortalApi(query));
  const sessions = new PortalSessionSecurity({
    clock: fixedClock("2026-08-14T12:04:00.000Z"),
    random: { bytes: (length) => randomBytes(length) },
  });
  const credential = loadOrCreateLocalCredential(join(fixture.root, "portal-runtime"), {
    bytes: (length) => randomBytes(length),
  });
  const contextFactory = () => {
    throw new Error("Phase 13F portal observation must remain read-only");
  };
  const ipc = await startUnixSupervisorServer(
    join(fixture.root, "portal-runtime", "supervisor.sock"),
    new SupervisorHttpHandler({
      api,
      transport: "ipc",
      credential,
      sessions,
      contextFactory,
    }),
  );
  const loopback = await startLoopbackSupervisorServer(
    0,
    (origin) =>
      new SupervisorHttpHandler({
        api,
        transport: "loopback",
        sessions,
        loopbackOrigin: origin,
        contextFactory,
      }),
  );
  try {
    const ipcClient = new HttpSupervisorClient({
      socketPath: required(ipc.socketPath),
      credential: credential.token,
      requestTimeoutMs: 2_000,
    });
    const loopbackClient = new HttpSupervisorClient({
      baseUrl: required(loopback.origin),
      requestTimeoutMs: 2_000,
    });
    await loopbackClient.consumePortalBootstrap((await ipcClient.createPortalSession()).path);
    const overview = await loopbackClient.getPortalRunOverview(identity);
    expect(overview).toMatchObject({
      mode: "paused",
      sync: { graphRevision: expectedGraphRevision },
      counts: { phases: 2, tasks: 2, activeEffects: 0 },
    });
    expect((await loopbackClient.listPortalArtifacts(identity)).artifacts).toHaveLength(2);
    expect((await loopbackClient.listPortalDelivery(identity)).records.length).toBeGreaterThan(0);
    expect((await loopbackClient.listPortalWorkspaces(identity)).workspaces).toHaveLength(2);
    expect(
      (await loopbackClient.listPortalIntegrations(identity)).integrations.length,
    ).toBeGreaterThanOrEqual(1);
    expect((await loopbackClient.listPortalHumanNeeds(identity)).needs).toEqual([]);
    const receipts = await loopbackClient.listPortalReceipts({ ...identity, limit: 100 });
    const receiptText = JSON.stringify(receipts);
    for (const commandId of [
      "command_acceptance-allowance",
      "command_acceptance-human-approval",
      "command_acceptance-close",
      "command_acceptance-remote-pause",
    ]) {
      expect(receiptText).toContain(commandId);
    }
    const events = await loopbackClient.listPortalEvents({ ...identity, limit: 100 });
    expect(events.events.length).toBeGreaterThan(0);
    expect(await loopbackClient.listPortalRepositories()).toEqual(
      await ipcClient.listPortalRepositories(),
    );
  } finally {
    await loopback.close();
    await ipc.close();
    query.close();
  }
}

async function verifyMaintenanceAndRestore(
  fixture: TemporaryRepository,
  reportDigest: string,
): Promise<void> {
  const supervisor = new SqliteSupervisorAuthority({
    databasePath: fixture.databasePath,
    assetDirectory: fixture.assetDirectory,
    dependencies,
  });
  const service = new SupervisorService({
    authority: supervisor,
    clock: fixedClock("2026-08-14T12:05:00.000Z"),
    ownerId: "owner_acceptance-maintenance",
  });
  await service.start();
  const status = await service.status();
  await service.drain();
  const sdkDirectory = join(fixture.root, "sdk-state");
  await mkdir(sdkDirectory, { mode: 0o700 });
  const backupDirectory = join(fixture.root, "backup");
  await backupSupervisorState({
    service,
    stopSdkClient: async () => undefined,
    sdkDirectory,
    destinationDirectory: backupDirectory,
    dependencies,
    requestId: "backup_acceptance",
  });
  expect(verifySupervisorStateBackup(backupDirectory, dependencies).requestId).toBe(
    "backup_acceptance",
  );
  const integrity = checkSqliteAuthorityIntegrity({
    databasePath: fixture.databasePath,
    assetDirectory: fixture.assetDirectory,
    dependencies,
  });
  expect(integrity.status).toBe("passed");
  expect(
    createDiagnosticsDirectory({
      destinationDirectory: join(fixture.root, "diagnostics"),
      productVersion: SENAWA_VERSION,
      integrity,
      serviceStatus: status,
    }).classification,
  ).toBe("secret-safe-metadata");
  expect(createRepairPlan(integrity, deterministicSha256).allowedActions).toEqual([
    "verified-fresh-restore",
  ]);
  await service.stop();

  const restored = restoreSupervisorStateBackup({
    backupDirectory,
    databasePath: join(fixture.root, "restored", "authority.db"),
    assetDirectory: join(fixture.root, "restored", "assets"),
    sdkDirectory: join(fixture.root, "restored", "copilot-sdk"),
    dependencies,
  });
  expect(restored.queryReceipt("command_acceptance-close")).toMatchObject({
    status: "completed",
  });
  restored.close();
  const restoredManifest = exportSqliteReportingDirectory({
    databasePath: join(fixture.root, "restored", "authority.db"),
    dependencies,
    repositoryId: ACCEPTANCE_REPOSITORY_ID,
    runId: ACCEPTANCE_RUN_ID,
    destinationDirectory: join(fixture.root, "restored-report"),
  });
  expect(restoredManifest.reportDigest).toBe(reportDigest);
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Acceptance fixture value must be an object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Acceptance fixture string is missing");
  }
  return value;
}

interface TemporaryRepository {
  readonly root: string;
  readonly repositoryRoot: string;
  readonly ownedRoot: string;
  readonly databasePath: string;
  readonly assetDirectory: string;
  readonly targetRef: string;
  readonly command: BoundedGitCommandPort;
  readonly checkoutWorktrees: string;
  git(args: readonly string[], root?: string): Promise<string>;
  bindCurrentRevision(): Promise<GitRevisionDescriptor>;
  cleanup(): Promise<void>;
}

async function temporaryRepository(): Promise<TemporaryRepository> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "senawa-no-credit-acceptance-")));
  roots.add(root);
  if (containsPath(CHECKOUT_ROOT, root) || containsPath(root, CHECKOUT_ROOT)) {
    throw new Error("Acceptance repository must be outside the real Senawa checkout");
  }
  const repositoryRoot = join(root, "repository");
  const ownedRoot = join(root, "owned-workspaces");
  const home = join(root, "git-home");
  const targetRef = "refs/heads/senawa/integration";
  await Promise.all([mkdir(ownedRoot), mkdir(home)]);
  const command = new BoundedGitCommandPort({
    gitExecutable: "/usr/bin/git",
    isolatedHome: home,
    additionalSubcommands: ["init", "commit", "cat-file", "show", "checkout", "branch"],
  });
  const git = async (args: readonly string[], commandRoot = repositoryRoot) => {
    if (!containsPath(root, commandRoot)) {
      throw new Error("Acceptance fixture Git commands must stay inside its temporary root");
    }
    const result = await command.run({ rootDirectory: commandRoot, args, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled) {
      throw new Error(`Git command failed: ${args.join(" ")}\n${result.stderr.text}`);
    }
    return result.stdout.text;
  };
  const checkoutWorktrees = await checkoutWorktreePorcelain(command);
  expect(parseWorktreeRecords(checkoutWorktrees).length).toBeGreaterThan(0);

  await git(["init", "--initial-branch=main", repositoryRoot], root);
  await git(["config", "user.name", "Senawa Acceptance"]);
  await git(["config", "user.email", "acceptance@senawa.invalid"]);
  const files = await RootScopedWorkspaceFiles.create(repositoryRoot);
  await files.write("base.txt", "base\n");
  await git(["add", "--all", "--", "."]);
  await git(["commit", "-m", "base"]);

  let cleaned = false;
  return {
    root,
    repositoryRoot,
    ownedRoot,
    databasePath: join(root, "state", "authority.db"),
    assetDirectory: join(root, "state", "assets"),
    targetRef,
    command,
    checkoutWorktrees,
    git,
    async bindCurrentRevision() {
      const objectFormat = oneLine(await git(["rev-parse", "--show-object-format"])) as
        | "sha1"
        | "sha256";
      const commit = oneLine(await git(["rev-parse", "HEAD^{commit}"]));
      const tree = oneLine(await git(["rev-parse", "HEAD^{tree}"]));
      await git(["update-ref", targetRef, commit]);
      return {
        commit: { objectFormat, oid: commit },
        tree: { objectFormat, oid: tree },
      };
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      let temporaryWorktrees = await git(["worktree", "list", "--porcelain"]);
      for (const path of temporaryWorktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path !== repositoryRoot)) {
        await git(["worktree", "remove", "--force", "--force", path]);
      }
      await git(["worktree", "prune"]);
      temporaryWorktrees = await git(["worktree", "list", "--porcelain"]);
      expect(temporaryWorktrees.match(/^worktree /gmu)).toHaveLength(1);
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
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut || result.cancelled) {
    throw new Error("Unable to capture the checkout worktree baseline");
  }
  return result.stdout.text;
}

function parseWorktreeRecords(porcelain: string): readonly string[] {
  return porcelain
    .split("\n\n")
    .filter((record) => record.length > 0)
    .map((record) => {
      if (!record.startsWith("worktree ")) {
        throw new Error("Git worktree porcelain contains an invalid record");
      }
      return record;
    });
}

function containsPath(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function oneLine(value: string): string {
  const lines = value.trim().split("\n");
  if (lines.length !== 1 || lines[0] === undefined || lines[0].length === 0) {
    throw new Error("Expected one non-empty output line");
  }
  return lines[0];
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Required Phase 13F fixture value is missing");
  return value;
}
