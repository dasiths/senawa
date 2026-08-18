import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  compileWorkflowConfiguration,
  createExampleWorkflowConfiguration,
  createExampleWorkflowResources,
} from "@senawa/configuration";
import {
  type CompletionRequirements,
  canonicalDigest,
  canonicalValue,
  consumerKey,
  createPhaseAttempt,
  createPhaseInputBinding,
  createWorkerContextBase,
  createWorkerDispatch,
  deriveCompletionRequirements,
  runId as kernelRunId,
  sha256Digest,
  type WorkerDispatch,
} from "@senawa/kernel";
import { canonicalBytes, canonicalStringify, PROTOCOL_VERSION } from "@senawa/protocol";
import { type QueuedEffectCommand, renderPromptPack } from "@senawa/runtime";
import {
  SqliteAuthority,
  SqliteContextBroker,
  SqliteRunnerAuthority,
} from "@senawa/storage-sqlite";
import { SqliteSupervisorAuthority } from "@senawa/supervisor";
import {
  createAdmissionFixture,
  createRuntimeGraph,
  runtimeCommand,
  runtimeFixture,
  runtimePrincipal,
} from "@senawa/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeDependencies } from "./daemon.js";

const execute = promisify(execFile);
const roots = new Set<string>();
const children = new Set<ChildProcess>();

function exampleResourceReader() {
  const resources = createExampleWorkflowResources();
  return {
    async read({ path }: { readonly path: string }) {
      const text = resources[path];
      if (text === undefined) throw new Error("Missing example resource");
      return new TextEncoder().encode(text);
    },
  };
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited(child);
  }
  children.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("built supervisor service and thin CLI", () => {
  it("compiles a worker amendment, retries exact approval across restart, and recovers apply", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-amendment-blackbox-"));
    roots.add(root);
    chmodSync(root, 0o700);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const databasePath = join(root, "state", "senawa", "authority.db");
    const assetDirectory = join(root, "state", "senawa", "assets");
    const example = createExampleWorkflowConfiguration();
    const examplePhase = example.phases[0];
    const workBudgets =
      examplePhase?.executor.kind === "task-set"
        ? examplePhase.executor.work[0]?.budgets
        : undefined;
    if (workBudgets === undefined) throw new Error("Example workflow budgets are missing");
    const baseSnapshot = await compileWorkflowConfiguration(
      {
        document: {
          ...example,
          phases: [
            ...example.phases,
            {
              key: "unrelated",
              generation: 1,
              dependsOn: [],
              input: required(examplePhase).input,
              executor: {
                kind: "task-set",
                work: [
                  {
                    key: "side-task",
                    generation: 1,
                    role: "worker",
                    budgets: workBudgets,
                    dependsOn: [],
                    input: { instruction: "Continue unrelated work" },
                    completionPolicy: {
                      criteria: [],
                      completionEvidencePolicy: { mode: "none", requirements: [] },
                    },
                  },
                ],
              },
              outputs: [],
              iteration: required(examplePhase).iteration,
              exit: { requiredOutputs: [], approval: { policy: "none" } },
              actions: [],
            },
          ],
        },
        locator: "fixture://blackbox-amendment-base",
        resources: exampleResourceReader(),
      },
      runtimeDependencies.sha256,
    );
    const phase = baseSnapshot.graph.nodes.find(
      (node) => node.kind === "phase" && node.definition.key === consumerKey("work"),
    );
    const task = baseSnapshot.graph.nodes.find(
      (node) => node.kind === "task" && node.definition.key === consumerKey("first-task"),
    );
    const unrelatedTask = baseSnapshot.graph.nodes.find(
      (node) => node.kind === "task" && node.definition.key === consumerKey("side-task"),
    );
    if (phase?.kind !== "phase" || task?.kind !== "task" || unrelatedTask?.kind !== "task") {
      throw new Error("Black-box workflow phase and tasks are required");
    }
    const authority = new SqliteAuthority({
      databasePath,
      assetDirectory,
      dependencies: runtimeDependencies,
    });
    authority.putConfigurationSnapshot(baseSnapshot);
    const admission = createAdmissionFixture();
    const instantiate = runtimeCommand({
      commandId: "command_blackbox-amendment-instantiate",
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
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    expect(
      authority.submit(
        {
          ...instantiate,
          payloadDigest: runtimeDependencies.sha256.digest(canonicalBytes(instantiate.payload)),
        },
        admission.at("2026-08-13T12:00:00.000Z"),
      ).status,
    ).toBe("completed");
    authority.close();

    const promptBinding = contextPromptFromSnapshot(
      baseSnapshot,
      (task.definition.input as unknown as { readonly value: unknown }).value,
    );
    const unrelatedPromptBinding = contextPromptFromSnapshot(
      baseSnapshot,
      (unrelatedTask.definition.input as unknown as { readonly value: unknown }).value,
    );

    const context = createWorkerContextBase(
      {
        task: { taskId: task.definition.id, definitionGeneration: task.definition.generation },
        graphRevisionDigest: baseSnapshot.graph.revisionDigest,
        configurationSnapshotDigest: baseSnapshot.snapshotDigest,
        contracts: [],
        dependencyBarrier: {
          task: { taskId: task.definition.id, definitionGeneration: task.definition.generation },
          dependencies: [],
        },
        assets: [],
        repositoryBase: {
          commitDigest: sha256Digest("1".repeat(64)),
          treeDigest: sha256Digest("2".repeat(64)),
        },
        modelPolicy: {
          key: consumerKey("default"),
          policyDigest: sha256Digest("3".repeat(64)),
          orderedRoutesDigest: sha256Digest("4".repeat(64)),
        },
        role: { key: consumerKey("worker"), roleDigest: sha256Digest("5".repeat(64)) },
        prompt: unrelatedPromptBinding.prompt,
        mappedInput: unrelatedPromptBinding.mappedInput,
        ...contextDataflow(
          baseSnapshot,
          phase.definition.id,
          phase.definition.generation,
          unrelatedPromptBinding.mappedInput,
          1,
        ),
        completionPolicy: task.definition.completionPolicy,
        priorRefusals: [],
        capabilities: ["worker.submit.amendment-proposal", "worker.submit.completion"],
        budgets: [{ unit: "work-attempt", limit: 1 }],
      },
      runtimeDependencies.sha256,
    );
    const unrelatedContext = createWorkerContextBase(
      {
        task: {
          taskId: unrelatedTask.definition.id,
          definitionGeneration: unrelatedTask.definition.generation,
        },
        graphRevisionDigest: baseSnapshot.graph.revisionDigest,
        configurationSnapshotDigest: baseSnapshot.snapshotDigest,
        contracts: [],
        dependencyBarrier: {
          task: {
            taskId: unrelatedTask.definition.id,
            definitionGeneration: unrelatedTask.definition.generation,
          },
          dependencies: [],
        },
        assets: [],
        repositoryBase: {
          commitDigest: sha256Digest("1".repeat(64)),
          treeDigest: sha256Digest("2".repeat(64)),
        },
        modelPolicy: {
          key: consumerKey("default"),
          policyDigest: sha256Digest("3".repeat(64)),
          orderedRoutesDigest: sha256Digest("4".repeat(64)),
        },
        role: { key: consumerKey("worker"), roleDigest: sha256Digest("5".repeat(64)) },
        prompt: promptBinding.prompt,
        mappedInput: promptBinding.mappedInput,
        ...contextDataflow(
          baseSnapshot,
          unrelatedTask.definition.parentId,
          1,
          promptBinding.mappedInput,
          1,
        ),
        completionPolicy: unrelatedTask.definition.completionPolicy,
        priorRefusals: [],
        capabilities: ["worker.submit.discovery"],
        budgets: [{ unit: "work-attempt", limit: 1 }],
      },
      runtimeDependencies.sha256,
    );
    const dispatchInput = {
      repositoryId: runtimeFixture.repositoryId,
      runId: kernelRunId(runtimeFixture.runId),
      ordinal: 1,
      workerPrincipalId: "principal_amendment-blackbox",
      roleKey: consumerKey("worker"),
      capabilities: ["worker.submit.amendment-proposal", "worker.submit.completion"],
      promptResource: promptBinding.reference,
      promptPackDigest: sha256Digest("6".repeat(64)),
    } as const;
    const provisionalDispatch = createWorkerDispatch(
      dispatchInput,
      context,
      runtimeDependencies.sha256,
    );
    const prompt = renderPromptPack(
      context,
      provisionalDispatch,
      runtimeDependencies.sha256,
      65_536,
    );
    const dispatch = createWorkerDispatch(
      { ...dispatchInput, promptPackDigest: prompt.digest },
      context,
      runtimeDependencies.sha256,
    );
    const unrelatedDispatchInput = {
      ...dispatchInput,
      ordinal: 2,
      workerPrincipalId: "principal_unrelated-blackbox",
      capabilities: ["worker.submit.discovery"],
    } as const;
    const provisionalUnrelatedDispatch = createWorkerDispatch(
      unrelatedDispatchInput,
      unrelatedContext,
      runtimeDependencies.sha256,
    );
    const unrelatedPrompt = renderPromptPack(
      unrelatedContext,
      provisionalUnrelatedDispatch,
      runtimeDependencies.sha256,
      65_536,
    );
    const unrelatedDispatch = createWorkerDispatch(
      { ...unrelatedDispatchInput, promptPackDigest: unrelatedPrompt.digest },
      unrelatedContext,
      runtimeDependencies.sha256,
    );
    const completionRequirements = deriveCompletionRequirements(
      baseSnapshot.graph,
      [dispatch.task, unrelatedDispatch.task],
      runtimeDependencies.sha256,
    );
    const affectedCompletionRequirements = completionRequirements.find(
      ({ task }) => task.taskId === dispatch.task.taskId,
    );
    const unrelatedCompletionRequirements = completionRequirements.find(
      ({ task }) => task.taskId === unrelatedDispatch.task.taskId,
    );
    if (
      affectedCompletionRequirements === undefined ||
      unrelatedCompletionRequirements === undefined
    ) {
      throw new Error("Completion requirements are missing");
    }
    const broker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: runtimeDependencies.sha256,
        currentTime: () => "2026-08-13T12:00:01.000Z",
        issueGrantToken: () => new Uint8Array(32).fill(7),
      },
    });
    broker.registerDispatch({
      context,
      dispatch,
      completionRequirements: affectedCompletionRequirements,
      taskScope: {
        runId: runtimeFixture.runId,
        taskId: task.definition.id,
        definitionGeneration: task.definition.generation,
        acceptedContextDigest: context.contextDigest,
        fenceGeneration: 1,
      },
    });
    broker.registerDispatch({
      context: unrelatedContext,
      dispatch: unrelatedDispatch,
      completionRequirements: unrelatedCompletionRequirements,
      taskScope: {
        runId: runtimeFixture.runId,
        taskId: unrelatedTask.definition.id,
        definitionGeneration: unrelatedTask.definition.generation,
        acceptedContextDigest: unrelatedContext.contextDigest,
        fenceGeneration: 1,
      },
    });
    const submission = {
      apiVersion: PROTOCOL_VERSION,
      submissionId: "submission_amendment-blackbox",
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      dispatchId: dispatch.dispatchId,
      task: dispatch.task,
      contextId: context.contextId,
      contextDigest: context.contextDigest,
      principalId: dispatch.worker.principalId,
      type: "amendment-proposal" as const,
      amendment: {
        baseGraphRevisionDigest: baseSnapshot.graph.revisionDigest,
        baseContextDigest: context.contextDigest,
        summary: "Add a release audit phase",
        operations: [
          {
            kind: "add-task",
            phase: "work",
            work: {
              key: "audit-task",
              generation: 1,
              role: "worker",
              budgets: workBudgets,
              dependsOn: ["work/first-task"],
              input: { instruction: "Review the release" },
              completionPolicy: {
                criteria: [],
                completionEvidencePolicy: { mode: "none", requirements: [] },
              },
            },
          },
        ],
      },
    };
    expect(broker.admitSubmission({ submission })).toMatchObject({ status: "accepted" });
    broker.close();

    const seedLease = {
      owner: "owner_blackbox-seed",
      fence: 1,
      expiresAt: "2026-08-13T12:01:00.000Z",
    } as const;
    const affectedScope = {
      runId: runtimeFixture.runId,
      taskId: task.definition.id,
      definitionGeneration: task.definition.generation,
      acceptedContextDigest: context.contextDigest,
      fenceGeneration: 1,
    } as const;
    const unrelatedScope = {
      runId: runtimeFixture.runId,
      taskId: unrelatedTask.definition.id,
      definitionGeneration: unrelatedTask.definition.generation,
      acceptedContextDigest: unrelatedContext.contextDigest,
      fenceGeneration: 1,
    } as const;
    const runner = new SqliteRunnerAuthority({
      databasePath,
      dependencies: runtimeDependencies,
    });
    runner.configureRun({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      contextDigest: context.contextDigest,
      taskScopes: [
        { ...affectedScope, claimsAccepted: true },
        { ...unrelatedScope, claimsAccepted: true },
      ],
      budgets: [{ unit: "model-millidollars", limit: 10 }],
      lease: seedLease,
    });
    const effectCommands: readonly QueuedEffectCommand[] = [
      blackboxEffectCommand(1, "affected", affectedScope, context.contextDigest),
      blackboxEffectCommand(2, "unrelated", unrelatedScope, unrelatedContext.contextDigest),
    ];
    for (const command of effectCommands) {
      runner.enqueue(command);
      if (command.operationId === "operation_blackbox-unrelated") {
        runner.updateContext({
          repositoryId: runtimeFixture.repositoryId,
          runId: runtimeFixture.runId,
          lease: seedLease,
          currentTime: "2026-08-13T12:00:02.000Z",
          contextDigest: unrelatedContext.contextDigest,
        });
      }
      const persisted = runner.persistIntent({
        repositoryId: runtimeFixture.repositoryId,
        runId: runtimeFixture.runId,
        lease: seedLease,
        currentTime: "2026-08-13T12:00:02.000Z",
        attemptId: `attempt_seed-${command.operationId}`,
        command,
      });
      expect(persisted.type).toBe("persisted");
    }
    runner.close();

    const serviceExecutable = new URL("../dist/main-service.js", import.meta.url).pathname;
    const cliExecutable = new URL("../dist/main.js", import.meta.url).pathname;
    let service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);
    const proposal = await eventually(async () => {
      const list = JSON.parse(
        await cli(cliExecutable, environment, [
          "amendment",
          "list",
          runtimeFixture.repositoryId,
          runtimeFixture.runId,
        ]),
      );
      if (list[0] === undefined) {
        const observer = new SqliteContextBroker({
          databasePath,
          dependencies: {
            sha256: runtimeDependencies.sha256,
            currentTime: () => new Date().toISOString(),
            issueGrantToken: () => new Uint8Array(32).fill(8),
          },
        });
        const outcome = observer.getAmendmentProposalBridgeOutcome(submission.submissionId);
        observer.close();
        if (outcome !== undefined) {
          throw new Error(`Worker amendment compiler outcome: ${canonicalStringify(outcome)}`);
        }
      }
      return list[0];
    });
    expect(proposal).toMatchObject({
      lifecycle: { status: "reviewable" },
      workerSource: { submission: { submissionId: submission.submissionId } },
    });
    const amendmentId = proposal.proposal.amendmentId as string;
    expect(
      JSON.parse(
        await cli(cliExecutable, environment, [
          "amendment",
          "source",
          runtimeFixture.repositoryId,
          runtimeFixture.runId,
          amendmentId,
        ]),
      ),
    ).toMatchObject({ source: { submission: { submissionId: submission.submissionId } } });

    const approvalArguments = [
      "amendment",
      "approve",
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      amendmentId,
    ] as const;
    let lostApprovalCommandId: string | undefined;
    await expect(
      cli(cliExecutable, environment, approvalArguments).then((output) => {
        lostApprovalCommandId = JSON.parse(output).location.commandId as string;
        throw new Error("simulated lost approval response");
      }),
    ).rejects.toThrow("simulated lost approval response");
    const approvalAcceptance = JSON.parse(await cli(cliExecutable, environment, approvalArguments));
    expect(approvalAcceptance.location.commandId).toBe(lostApprovalCommandId);
    const approvalCommandId = approvalAcceptance.location.commandId as string;
    const approval = await eventually(async () => {
      const receipt = JSON.parse(
        await cli(cliExecutable, environment, ["receipt", "get", approvalCommandId]),
      );
      return receipt.status === "terminal" ? receipt : undefined;
    });
    expect(approval.terminalReceipt).toMatchObject({ status: "completed" });
    const approved = JSON.parse(
      await cli(cliExecutable, environment, [
        "amendment",
        "get",
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        amendmentId,
      ]),
    );
    expect(approved.lifecycle).toMatchObject({ status: "approved-awaiting-quiescence" });
    const outputBroker = new SqliteContextBroker({
      databasePath,
      dependencies: {
        sha256: runtimeDependencies.sha256,
        currentTime: () => new Date().toISOString(),
        issueGrantToken: () => new Uint8Array(32).fill(9),
      },
    });
    const affectedLateOutput = outputBroker.admitSubmission({
      submission: blackboxCompletionSubmission(
        "submission_blackbox-affected-late",
        dispatch,
        affectedCompletionRequirements,
        "Late affected output",
      ),
    });
    const unrelatedProgress = outputBroker.admitSubmission({
      submission: blackboxDiscoverySubmission(
        "submission_blackbox-unrelated-current",
        unrelatedDispatch,
      ),
    });
    expect(affectedLateOutput).toMatchObject({ status: "stale" });
    expect(affectedLateOutput.completionFact).toBeUndefined();
    expect(unrelatedProgress).toMatchObject({ status: "accepted" });
    outputBroker.close();
    const held = await eventually(async () => {
      const heldAt = new Date().toISOString();
      const heldUntil = new Date(Date.parse(heldAt) + 30_000).toISOString();
      const crashHolder = new SqliteSupervisorAuthority({
        databasePath,
        assetDirectory,
        dependencies: runtimeDependencies,
      });
      try {
        const lease = crashHolder.acquireRunLease(
          runtimeFixture.repositoryId,
          runtimeFixture.runId,
          "owner_blackbox-crash",
          heldAt,
          heldUntil,
        );
        return { lease, heldUntil };
      } catch {
        return undefined;
      } finally {
        crashHolder.close();
      }
    });
    service.kill("SIGKILL");
    await exited(service);
    children.delete(service);

    const takeoverAt = new Date(Date.parse(held.heldUntil) + 1).toISOString();
    const takeoverUntil = new Date(Date.parse(takeoverAt) + 30_000).toISOString();
    const takeoverAuthority = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory,
      dependencies: runtimeDependencies,
    });
    const takeover = takeoverAuthority.acquireRunLease(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      "owner_blackbox-takeover",
      takeoverAt,
      takeoverUntil,
    );
    expect(takeover.fence).toBe(held.lease.fence + 1);
    const settlementRunner = new SqliteRunnerAuthority({
      databasePath,
      dependencies: runtimeDependencies,
    });
    const runnerLease = {
      owner: takeover.ownerId,
      fence: takeover.fence,
      expiresAt: takeover.expiresAt,
    };
    const snapshot = settlementRunner.load({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
    });
    const affectedEffect = snapshot.effects.find(
      ({ intent }) => intent.command.operationId === "operation_blackbox-affected",
    );
    const unrelatedEffect = snapshot.effects.find(
      ({ intent }) => intent.command.operationId === "operation_blackbox-unrelated",
    );
    const affectedCurrentness = snapshot.taskScopes.find(
      ({ taskId }) => taskId === task.definition.id,
    );
    const unrelatedCurrentness = snapshot.taskScopes.find(
      ({ taskId }) => taskId === unrelatedTask.definition.id,
    );
    if (
      affectedEffect === undefined ||
      unrelatedEffect === undefined ||
      affectedCurrentness === undefined ||
      unrelatedCurrentness === undefined
    ) {
      throw new Error("Black-box runner recovery records are missing");
    }
    expect(affectedCurrentness.claimsAccepted).toBe(false);
    expect(unrelatedCurrentness.claimsAccepted).toBe(true);
    const affectedClaim = settlementRunner.claimEffectAttempt({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease: runnerLease,
      currentTime: takeoverAt,
      attemptId: "attempt_blackbox-affected-takeover",
      intent: affectedEffect.intent,
      taskScope: affectedCurrentness,
    });
    if (affectedClaim.type !== "claimed") throw new Error("Affected effect was not claimable");
    const affectedOutcome = settlementRunner.commitEffect({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease: runnerLease,
      currentTime: takeoverAt,
      attemptId: "attempt_blackbox-affected-takeover",
      intent: affectedEffect.intent,
      observation: {
        status: "completed",
        observedAt: takeoverAt,
        details: { reason: "late-output-after-amendment-fence" },
      },
    });
    const unrelatedClaim = settlementRunner.claimEffectAttempt({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease: runnerLease,
      currentTime: takeoverAt,
      attemptId: "attempt_blackbox-unrelated-takeover",
      intent: unrelatedEffect.intent,
      taskScope: unrelatedCurrentness,
    });
    if (unrelatedClaim.type !== "claimed") throw new Error("Unrelated effect was not claimable");
    const unrelatedOutcome = settlementRunner.commitEffect({
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      lease: runnerLease,
      currentTime: takeoverAt,
      attemptId: "attempt_blackbox-unrelated-takeover",
      intent: unrelatedEffect.intent,
      observation: {
        status: "completed",
        observedAt: takeoverAt,
        details: { reason: "unrelated-progress" },
      },
    });
    expect(affectedOutcome.status).toBe("completed");
    expect(unrelatedOutcome.freshness).toBe("current");
    settlementRunner.close();
    expect(takeoverAuthority.listApprovedAmendmentRecoveries()).toMatchObject([
      { amendmentId, observedQuiescent: true },
    ]);
    takeoverAuthority.releaseRunLease(takeover, new Date().toISOString());
    takeoverAuthority.close();

    service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);
    const recoveryObserver = new SqliteSupervisorAuthority({
      databasePath,
      assetDirectory,
      dependencies: runtimeDependencies,
    });
    const observedRecord = recoveryObserver.queryAmendment(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      amendmentId,
    );
    recoveryObserver.close();
    expect(observedRecord).toBeDefined();
    const applied = await eventually(async () => {
      try {
        const record = JSON.parse(
          await cli(cliExecutable, environment, [
            "amendment",
            "get",
            runtimeFixture.repositoryId,
            runtimeFixture.runId,
            amendmentId,
          ]),
        );
        return record.lifecycle.status === "applied" ? record : undefined;
      } catch {
        return undefined;
      }
    });
    expect(applied).toMatchObject({
      lifecycle: { status: "applied" },
      application: {
        afterGraphRevisionDigest: proposal.proposal.reviewedResultGraph.revisionDigest,
      },
    });
    await cli(cliExecutable, environment, ["service", "stop"]);
    await exited(service);
    children.delete(service);
  }, 80_000);

  it("submits, retries, drains, stops, and recovers durable state after restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "senawa-service-blackbox-"));
    roots.add(root);
    chmodSync(root, 0o700);
    const environment = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const serviceExecutable = new URL("../dist/main-service.js", import.meta.url).pathname;
    const cliExecutable = new URL("../dist/main.js", import.meta.url).pathname;
    let service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);

    const command = runtimeCommand({
      commandId: "command_blackbox",
      intent: "instantiate-run",
      payload: {
        workflowId: runtimeFixture.workflowId,
        configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
        execution: runtimeFixture.execution,
        graph: createRuntimeGraph(),
        phase: runtimeFixture.phase,
        approvalPolicy: { policy: "approval-required", authority: runtimePrincipal },
        escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
        allowancePolicy: runtimeFixture.allowancePolicy,
      },
    });
    const { principal: _principal, transport: _transport, ...submission } = command;
    const commandPath = join(root, "command.json");
    writeFileSync(commandPath, canonicalStringify(submission), { mode: 0o600 });
    const first = await cli(cliExecutable, environment, ["command", "submit", commandPath]);
    expect(JSON.parse(first).location.commandId).toBe(command.commandId);
    const retry = await cli(cliExecutable, environment, ["command", "submit", commandPath]);
    expect(JSON.parse(retry).location.commandId).toBe(command.commandId);

    const terminal = await eventually(async () => {
      const receipt = JSON.parse(
        await cli(cliExecutable, environment, ["receipt", "get", command.commandId]),
      );
      return receipt.status === "terminal" ? receipt : undefined;
    });
    expect(terminal.commandId).toBe(command.commandId);
    const events = JSON.parse(
      await cli(cliExecutable, environment, [
        "event",
        "list",
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
      ]),
    );
    expect(events.events).toHaveLength(3);

    await cli(cliExecutable, environment, ["service", "drain"]);
    const drained = JSON.parse(await cli(cliExecutable, environment, ["service", "status"]));
    expect(drained).toMatchObject({ lifecycle: "drained", mode: "drained" });
    await cli(cliExecutable, environment, ["service", "stop"]);
    await exited(service);
    children.delete(service);

    service = spawn(process.execPath, [serviceExecutable], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.add(service);
    await ready(cliExecutable, environment);
    const persisted = JSON.parse(
      await cli(cliExecutable, environment, ["receipt", "get", command.commandId]),
    );
    expect(persisted).toMatchObject({ commandId: command.commandId, status: "terminal" });
    await cli(cliExecutable, environment, ["service", "stop"]);
    await exited(service);
    children.delete(service);
  }, 40_000);
});

async function ready(executable: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await eventually(async () => {
    try {
      await cli(executable, environment, ["service", "status"]);
      return true;
    } catch {
      return undefined;
    }
  });
}

function contextPromptFromSnapshot(
  snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>,
  mappedValue: unknown,
) {
  const resource = snapshot.prompts[0];
  if (resource === undefined) throw new Error("Example prompt resource is missing");
  const prompt = {
    key: resource.key,
    path: resource.source.path,
    resourceDigest: resource.digest,
    contentDigest: resource.source.contentDigest,
    byteLength: resource.source.byteLength,
    utf8: resource.source.utf8,
    inputPaths: resource.inputPaths,
  };
  const value = canonicalValue(mappedValue);
  return {
    prompt,
    mappedInput: { value, valueDigest: canonicalDigest(value, runtimeDependencies.sha256) },
    reference: {
      key: prompt.key,
      resourceDigest: prompt.resourceDigest,
      contentDigest: prompt.contentDigest,
    },
  };
}

function contextDataflow(
  snapshot: Awaited<ReturnType<typeof compileWorkflowConfiguration>>,
  phaseIdentity: string,
  phaseGeneration: number,
  mappedInput: { readonly value: ReturnType<typeof canonicalValue>; readonly valueDigest: string },
  attemptOrdinal: number,
) {
  const phase = {
    phaseId: phaseIdentity as never,
    definitionGeneration: phaseGeneration as never,
    attempt: attemptOrdinal,
  };
  const sourceSetDigest = canonicalDigest(
    canonicalValue({ mappings: [] }),
    runtimeDependencies.sha256,
  );
  const phaseInputBinding = createPhaseInputBinding(
    {
      phase,
      schemaKey: consumerKey("work-input"),
      schemaResourceDigest: required(snapshot.schemas[0]).source.contentDigest,
      mappings: [],
      contentDigest: mappedInput.valueDigest as never,
      byteLength: canonicalBytes(mappedInput.value).byteLength,
      validationReceiptDigest: sha256Digest("7".repeat(64)),
      sourceSetDigest,
    },
    runtimeDependencies.sha256,
  );
  const phaseAttempt = createPhaseAttempt(
    {
      repositoryId: runtimeFixture.repositoryId,
      runId: kernelRunId(runtimeFixture.runId),
      phase,
      inputBindingDigest: phaseInputBinding.bindingDigest,
      sourceSetDigest,
      executorDigest: sha256Digest("8".repeat(64)),
      graphRevisionDigest: snapshot.graph.revisionDigest,
      configurationSnapshotDigest: snapshot.snapshotDigest,
      upstreamClosureSetDigest: sha256Digest("9".repeat(64)),
      upstreamOutputSetDigest: sha256Digest("0".repeat(64)),
    },
    runtimeDependencies.sha256,
  );
  return { phaseAttempt, phaseInputBinding, phaseOutputDeclarations: [] };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

function blackboxEffectCommand(
  sequence: number,
  suffix: "affected" | "unrelated",
  taskScope: QueuedEffectCommand["taskScope"],
  contextDigest: string,
): QueuedEffectCommand {
  const input = { dispatchId: `dispatch_blackbox-${suffix}` } as const;
  return {
    sequence,
    commandId: `command_blackbox-effect-${suffix}`,
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    operationId: `operation_blackbox-${suffix}`,
    kind: "worker",
    taskScope,
    contextDigest,
    inputDigest: runtimeDependencies.sha256.digest(canonicalBytes(input)),
    input,
    budgetReservation: { unit: "model-millidollars", amount: 1 },
    queuedAt: "2026-08-13T12:00:01.000Z",
    maxReconciliationAttempts: 2,
  };
}

function blackboxCompletionSubmission(
  submissionId: string,
  dispatch: WorkerDispatch,
  requirements: CompletionRequirements,
  summary: string,
) {
  return {
    apiVersion: PROTOCOL_VERSION,
    submissionId,
    repositoryId: dispatch.repositoryId,
    runId: dispatch.runId,
    dispatchId: dispatch.dispatchId,
    task: dispatch.task,
    contextId: dispatch.contextId,
    contextDigest: dispatch.contextDigest,
    principalId: dispatch.worker.principalId,
    type: "completion" as const,
    completion: {
      task: dispatch.task,
      disposition: "completed" as const,
      summary,
      criteria: requirements.criteria.map(({ criterionId }) => ({
        criterionId,
        disposition: "satisfied" as const,
      })),
      completionEvidence: [],
    },
  };
}

function blackboxDiscoverySubmission(submissionId: string, dispatch: WorkerDispatch) {
  return {
    apiVersion: PROTOCOL_VERSION,
    submissionId,
    repositoryId: dispatch.repositoryId,
    runId: dispatch.runId,
    dispatchId: dispatch.dispatchId,
    task: dispatch.task,
    contextId: dispatch.contextId,
    contextDigest: dispatch.contextDigest,
    principalId: dispatch.worker.principalId,
    type: "discovery" as const,
    discovery: {
      summary: "Unrelated current progress",
      details: { scope: "unrelated" },
    },
  };
}

async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const result = await operation();
    if (result !== undefined) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Black-box service condition did not become true");
}

async function cli(
  executable: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): Promise<string> {
  const result = await execute(process.execPath, [executable, ...arguments_], { env: environment });
  return result.stdout.trim();
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}
