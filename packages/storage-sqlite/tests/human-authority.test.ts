import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalBytes,
  decodeCommandEnvelope,
  PROTOCOL_VERSION,
  TRANSCRIPT_LIMITS,
} from "@senawa/protocol";
import {
  type AgentTranscriptLine,
  createRoleAuthorizationPolicy,
  FencedRunner,
  type RuntimeDependencies,
} from "@senawa/runtime";
import {
  createRuntimeGraph,
  createWorkerExecutionFixture,
  deterministicSha256,
  FakeEffectHost,
  runtimeCommand,
  runtimeFixture,
} from "@senawa/testing";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  restoreSqliteAuthority,
  SqliteAuthority,
  SqliteContextBroker,
  type SqliteFaultPoint,
  SqlitePortalQueryAuthority,
  SqliteRunnerAuthority,
} from "../src/index.js";

const roots = new Set<string>();
const SECOND_REPOSITORY_ID = "repository_transcript-second";
const SECOND_RUN_ID = "run_transcript-second";
let allocationSequence = 0;
const dependencies: RuntimeDependencies = {
  sha256: deterministicSha256,
  authorization: createRoleAuthorizationPolicy([
    { intent: "instantiate-run", roles: ["release-manager"] },
    { intent: "answer-question", roles: ["operator", "release-manager"] },
    { intent: "grant-allowance", roles: ["release-manager"] },
    { intent: "pause-run", roles: ["operator", "release-manager"] },
    { intent: "resume-run", roles: ["operator", "release-manager"] },
    { intent: "end-run", roles: ["release-manager"] },
  ]),
};

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("SQLite Phase 11A human authority", () => {
  it("answers only the exact current trusted question and preserves a durable fresh dispatch requirement", async () => {
    const fixture = createFixture();
    let authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const worker = createWorkerExecutionFixture(createRuntimeGraph(), [
      "worker.submit.completion",
      "worker.submit.question",
    ]);
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: taskScope(worker.context.contextDigest),
    });
    expect(
      broker.admitSubmission({
        submission: {
          apiVersion: PROTOCOL_VERSION,
          submissionId: "submission_phase11-question",
          repositoryId: worker.dispatch.repositoryId,
          runId: worker.dispatch.runId,
          dispatchId: worker.dispatch.dispatchId,
          task: worker.dispatch.task,
          contextId: worker.dispatch.contextId,
          contextDigest: worker.dispatch.contextDigest,
          principalId: worker.dispatch.worker.principalId,
          type: "question",
          question: {
            prompt: "Which deployment target is authoritative?",
            details: { choices: ["staging", "production"] },
          },
        },
      }).status,
    ).toBe("accepted");
    const question = {
      prompt: "Which deployment target is authoritative?",
      details: { choices: ["staging", "production"] },
    };
    const questionDigest = deterministicSha256.digest(canonicalBytes(question));
    const inspection = new Database(fixture.databasePath, { readonly: true });
    expect(
      inspection
        .prepare("SELECT repository_id, run_id FROM context_questions WHERE submission_id = ?")
        .get("submission_phase11-question"),
    ).toEqual({ repository_id: runtimeFixture.repositoryId, run_id: runtimeFixture.runId });
    inspection.close();
    const exact = answerQuestionCommand({
      commandId: "command_answer-question",
      questionDigest,
      contextDigest: worker.context.contextDigest,
      expectedDefinitionRevision: worker.dispatch.task.contextRevisionDigest,
    });

    const unauthorized = answerQuestionCommand({
      commandId: "command_answer-unauthorized",
      questionDigest,
      contextDigest: worker.context.contextDigest,
      expectedDefinitionRevision: worker.dispatch.task.contextRevisionDigest,
    });
    expect(
      authority.submit(
        { ...unauthorized, principal: { ...unauthorized.principal, roles: ["reader"] } },
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "unauthorized" } });
    expect(
      authority.submit(
        answerQuestionCommand({
          commandId: "command_answer-stale",
          questionDigest: "f".repeat(64),
          contextDigest: worker.context.contextDigest,
          expectedDefinitionRevision: worker.dispatch.task.contextRevisionDigest,
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "stale-question" } });
    const completed = authority.submit(exact, admission());
    expect(completed).toMatchObject({ status: "completed" });
    expect(authority.submit(exact, admission())).toEqual(completed);
    expect(
      authority.submit({ ...exact, commandId: "command_answer-conflict" }, admission()),
    ).toMatchObject({ status: "refused", error: { code: "question-already-answered" } });
    const requirements = authority.listFreshDispatchRequirements(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]).toMatchObject({
      submissionId: "submission_phase11-question",
      historicalDispatchId: worker.dispatch.dispatchId,
      contextDigest: worker.context.contextDigest,
    });
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    expect(
      portal.getQuestion(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "submission_phase11-question",
      ),
    ).toMatchObject({
      answer: { answer: { target: "production" } },
      freshDispatch: { status: "pending", requirementId: requirements[0]?.requirementDigest },
    });
    portal.close();
    expect(broker.loadWorkerDispatch(worker.dispatch.dispatchId)?.dispatch).toEqual(
      worker.dispatch,
    );

    broker.close();
    authority.close();
    authority = new SqliteAuthority(fixture.options);
    expect(
      authority.listFreshDispatchRequirements(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toEqual(requirements);
    expect(authority.queryReceipt(exact.commandId)).toEqual(completed);
    authority.close();
    fixture.dispose();
  });

  it("grants one policy-bounded allowance without changing reserved, spent, or unreported accounting", () => {
    const fixture = createFixture();
    let authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const runner = configuredRunner(fixture);
    const command = effectCommand();
    runner.enqueue(command);
    const escalationResult = runner.persistIntent(runInput(command));
    expect(escalationResult.type).toBe("escalated");
    if (escalationResult.type !== "escalated") throw new Error("Expected runner escalation");
    const escalationDigest = deterministicSha256.digest(
      canonicalBytes(escalationResult.escalation),
    );
    const before = runner.queryBudgets(runtimeFixture.repositoryId, runtimeFixture.runId)[0];
    const grant = grantAllowanceCommand({
      commandId: "command_grant-allowance",
      escalationDigest,
      expectedLimit: 1,
      increaseBy: 4,
    });
    expect(
      authority.submit(
        grantAllowanceCommand({
          commandId: "command_grant-stale-graph",
          escalationDigest,
          expectedGraphRevision: "f".repeat(64),
          expectedLimit: 1,
          increaseBy: 4,
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "stale-allowance" } });
    expect(
      authority.submit(
        grantAllowanceCommand({
          commandId: "command_grant-stale-run-mode",
          escalationDigest,
          expectedLimit: 1,
          expectedRunModeRevision: 9,
          increaseBy: 4,
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "stale-allowance" } });
    expect(
      authority.submit(
        grantAllowanceCommand({
          commandId: "command_grant-stale-unit",
          escalationDigest,
          expectedLimit: 1,
          increaseBy: 4,
          unit: "spend-nano",
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "stale-allowance" } });
    expect(
      authority.submit(
        grantAllowanceCommand({
          commandId: "command_grant-over-ceiling",
          escalationDigest,
          expectedLimit: 1,
          increaseBy: 10_000,
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "allowance-ceiling-exceeded" } });

    let injected = false;
    const faulting = new SqliteAuthority({
      ...fixture.options,
      faultInjector(point: SqliteFaultPoint) {
        if (!injected && point === "before-command-commit") {
          injected = true;
          throw new Error("allowance commit crash");
        }
      },
    });
    expect(() => faulting.submit(grant, admission())).toThrow("allowance commit crash");
    faulting.close();
    expect(runner.queryBudgets(runtimeFixture.repositoryId, runtimeFixture.runId)[0]).toEqual(
      before,
    );

    const completed = authority.submit(grant, admission());
    expect(completed).toMatchObject({ status: "completed" });
    const after = runner.queryBudgets(runtimeFixture.repositoryId, runtimeFixture.runId)[0];
    expect(after).toEqual({ ...before, limit: 5 });
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    expect(
      portal.getAllowanceReview(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        escalationResult.escalation.commandId,
      ),
    ).toBeUndefined();
    expect(
      portal
        .listHumanNeeds(runtimeFixture.repositoryId, runtimeFixture.runId)
        .needs.some(({ sourceId }) => sourceId === escalationResult.escalation.commandId),
    ).toBe(false);
    portal.close();
    const independent = new SqliteAuthority(fixture.options);
    expect(
      independent.submit(
        grantAllowanceCommand({
          commandId: "command_grant-racing",
          escalationDigest,
          expectedLimit: 1,
          increaseBy: 4,
        }),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "allowance-already-resolved" } });
    independent.close();
    authority.close();
    authority = new SqliteAuthority(fixture.options);
    expect(authority.queryReceipt(grant.commandId)).toEqual(completed);
    expect(runner.persistIntent(runInput(command))).toMatchObject({ type: "persisted" });
    authority.close();
    runner.close();
    fixture.dispose();
  });

  it("projects only a complete unresolved allowance review from current authority", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const runner = configuredRunner(fixture);
    const command = effectCommand();
    runner.enqueue(command);
    const result = runner.persistIntent(runInput(command));
    expect(result.type).toBe("escalated");
    if (result.type !== "escalated") throw new Error("Expected runner escalation");
    const escalationDigest = deterministicSha256.digest(canonicalBytes(result.escalation));
    const budget = runner.queryBudgets(runtimeFixture.repositoryId, runtimeFixture.runId)[0];
    if (budget === undefined) throw new Error("Expected runner budget");
    const maximum = runtimeFixture.allowancePolicy.ceilings.find(
      ({ unit }) => unit === result.escalation.unit,
    )?.maximum;
    if (maximum === undefined) throw new Error("Expected allowance ceiling");
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    expect(
      portal.getAllowanceReview(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        result.escalation.commandId,
      ),
    ).toEqual({
      apiVersion: PROTOCOL_VERSION,
      repositoryId: runtimeFixture.repositoryId,
      runId: runtimeFixture.runId,
      escalationCommandId: result.escalation.commandId,
      escalationDigest,
      operationId: result.escalation.operationId,
      unit: result.escalation.unit,
      requested: result.escalation.requested,
      available: result.escalation.available,
      createdAt: result.escalation.createdAt,
      currentLimit: budget.limit,
      maxIncrease: maximum - budget.limit,
      ceiling: maximum,
      allowancePolicyDigest: runtimeFixture.allowancePolicy.policyDigest,
      resultingMax: maximum,
      expectedGraphRevision: createRuntimeGraph().revisionDigest,
      expectedRunMode: "running",
      expectedRunModeRevision: 0,
    });
    expect(
      portal
        .listHumanNeeds(runtimeFixture.repositoryId, runtimeFixture.runId)
        .needs.find(({ sourceId }) => sourceId === result.escalation.commandId)?.allowedCommands,
    ).toEqual(["grant-allowance"]);

    const corrupt = new Database(fixture.databasePath);
    corrupt
      .prepare("UPDATE runner_allowance_policies SET policy_digest = ? WHERE run_key = ?")
      .run("f".repeat(64), JSON.stringify([runtimeFixture.repositoryId, runtimeFixture.runId]));
    corrupt.close();
    expect(
      portal.getAllowanceReview(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        result.escalation.commandId,
      ),
    ).toBeUndefined();
    expect(
      portal
        .listHumanNeeds(runtimeFixture.repositoryId, runtimeFixture.runId)
        .needs.find(({ sourceId }) => sourceId === result.escalation.commandId)?.allowedCommands,
    ).toEqual([]);
    portal.close();
    runner.close();
    authority.close();
    fixture.dispose();
  });

  it("guards pause and resume revisions, then fences and cancels through durable ending convergence", () => {
    const fixture = createFixture();
    let authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const runner = configuredRunner(fixture, 10);
    const command = effectCommand();
    runner.enqueue(command);
    const intentResult = runner.persistIntent(runInput(command));
    expect(intentResult.type).toBe("persisted");
    if (intentResult.type !== "persisted") throw new Error("Expected persisted effect intent");
    const secondCommand = {
      ...effectCommand(),
      sequence: 2,
      commandId: "runner-command-phase11-second",
      operationId: "operation_phase11-second",
    };
    runner.enqueue(secondCommand);
    expect(runner.persistIntent(runInput(secondCommand))).toMatchObject({ type: "persisted" });

    expect(
      authority.submit(runControlCommand("pause-run", "command_pause", 0), admission()),
    ).toMatchObject({
      status: "completed",
    });
    expect(() =>
      runner.enqueue({
        ...effectCommand(),
        commandId: "runner-command-paused",
        operationId: "operation_paused",
        sequence: 2,
      }),
    ).toThrow("does not accept new effects while run is paused");
    expect(
      authority.submit(runControlCommand("resume-run", "command_resume-stale", 0), admission()),
    ).toMatchObject({ status: "refused", error: { code: "stale-run-mode" } });
    expect(
      authority.submit(runControlCommand("resume-run", "command_resume", 1), admission()),
    ).toMatchObject({
      status: "completed",
    });
    expect(
      runner.claimEffectAttempt({
        ...runInput(command),
        intent: intentResult.intent,
        taskScope: command.taskScope,
      }),
    ).toMatchObject({ type: "claimed", action: "dispatch" });
    expect(
      authority.submit(
        runControlCommand("end-run", "command_end-unauthorized", 2, ["operator"]),
        admission(),
      ),
    ).toMatchObject({ status: "refused", error: { code: "unauthorized" } });
    expect(
      authority.submit(runControlCommand("end-run", "command_end", 2), admission()),
    ).toMatchObject({
      status: "completed",
    });
    expect(
      authority.queryRunControl(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toMatchObject({
      mode: "ending",
      revision: 3,
    });
    expect(
      runner.load({ repositoryId: runtimeFixture.repositoryId, runId: runtimeFixture.runId })
        .taskScopes,
    ).toEqual([expect.objectContaining({ claimsAccepted: false, fenceGeneration: 2 })]);

    const late = runner.commitEffect({
      ...runInput(command),
      intent: intentResult.intent,
      observation: {
        status: "completed",
        observedAt: "2026-08-14T12:00:01.000Z",
        outputDigest: "c".repeat(64),
        usage: { unit: "model-millidollars", amount: 5 },
      },
    });
    expect(late).toMatchObject({ status: "completed", freshness: "stale" });
    expect(
      authority.queryRunControl(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toMatchObject({
      mode: "ending",
      revision: 3,
    });

    const fenced = new FencedRunner(runner, new FakeEffectHost()).runOnce({
      ...runInput(secondCommand),
      attemptId: "attempt_cancel-after-end",
    });
    expect(fenced).toMatchObject({
      type: "committed",
      outcome: { status: "cancelled", freshness: "current" },
    });
    expect(
      authority.queryRunControl(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toMatchObject({
      mode: "ended",
      revision: 4,
    });
    authority.close();
    authority = new SqliteAuthority(fixture.options);
    expect(
      authority.queryRunControl(runtimeFixture.repositoryId, runtimeFixture.runId),
    ).toMatchObject({
      mode: "ended",
      revision: 4,
    });
    expect(() =>
      runner.enqueue({
        ...effectCommand(),
        commandId: "runner-command-ended",
        operationId: "operation_ended",
        sequence: 4,
      }),
    ).toThrow("does not accept new effects while run is ended");
    authority.close();
    runner.close();
    fixture.dispose();
  });
});

describe("SQLite Phase 11B portal query authority", () => {
  it("backs up and restores portal vectors and rejects coordinated revision corruption", async () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const before = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId)?.sync;
    expect(before).toBeDefined();
    portal.close();
    const backupPath = join(fixture.root, "portal-backup");
    await authority.backup(backupPath);
    authority.close();

    const restoredDatabasePath = join(fixture.root, "portal-restored.db");
    const restoredAssetDirectory = join(fixture.root, "portal-restored-assets");
    const restored = restoreSqliteAuthority({
      dependencies,
      databasePath: restoredDatabasePath,
      assetDirectory: restoredAssetDirectory,
      backupPath,
    });
    const restoredPortal = new SqlitePortalQueryAuthority({
      dependencies,
      databasePath: restoredDatabasePath,
      assetDirectory: restoredAssetDirectory,
    });
    expect(
      restoredPortal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId)?.sync,
    ).toEqual(before);
    restoredPortal.close();
    restored.close();

    const corrupt = new Database(fixture.databasePath);
    corrupt.exec("UPDATE portal_run_revisions SET human_revision = portal_revision + 1");
    corrupt.close();
    expect(() => new SqliteAuthority(fixture.options)).toThrow(
      "portal revision vectors do not match run authority",
    );
    fixture.dispose();
  });

  it("reads bounded graph and activity pages and observes independent source revisions", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const overviewA = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(overviewA).toBeDefined();
    const graph = portal.getGraphSummary(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(graph).toMatchObject({ nodeCount: 4, edgeCount: 3, jsonNodeBudget: 500 });
    expect(
      portal.listGraphNodes(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        graph?.graphRevision ?? "missing",
        0,
        2,
      ),
    ).toMatchObject({ hasMore: true, nextAfter: 2 });
    expect(() =>
      portal.listGraphNodes(runtimeFixture.repositoryId, runtimeFixture.runId, "f".repeat(64)),
    ).toThrow("graph revision is stale");
    const graphNodes = () =>
      new Map(
        portal
          .listGraphNodes(
            runtimeFixture.repositoryId,
            runtimeFixture.runId,
            graph?.graphRevision ?? "missing",
          )
          .nodes.map((node) => [node.nodeId, node]),
      );
    for (const node of graphNodes().values()) {
      expect(node).toMatchObject({ runState: "not-started", humanNeedCount: 0, evidenceCount: 0 });
      expect(node.roleKey).toBeUndefined();
      expect(node.attempt).toBeUndefined();
    }

    const worker = createWorkerExecutionFixture(createRuntimeGraph(), [
      "worker.submit.question",
      "worker.submit.asset",
    ]);
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: taskScope(worker.context.contextDigest),
    });
    expect(graphNodes().get(runtimeFixture.task.taskId)).toMatchObject({
      runState: "running",
      roleKey: "implementer",
      humanNeedCount: 0,
      evidenceCount: 0,
    });
    expect(graphNodes().get(runtimeFixture.workflowId)).toMatchObject({
      runState: "not-started",
      humanNeedCount: 0,
    });
    broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        submissionId: "submission_portal-question",
        repositoryId: worker.dispatch.repositoryId,
        runId: worker.dispatch.runId,
        dispatchId: worker.dispatch.dispatchId,
        task: worker.dispatch.task,
        contextId: worker.dispatch.contextId,
        contextDigest: worker.dispatch.contextDigest,
        principalId: worker.dispatch.worker.principalId,
        type: "question",
        question: { prompt: "<script>not executable</script>", details: { exact: true } },
      },
    });
    broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        submissionId: "submission_portal-node-asset",
        repositoryId: worker.dispatch.repositoryId,
        runId: worker.dispatch.runId,
        dispatchId: worker.dispatch.dispatchId,
        task: worker.dispatch.task,
        contextId: worker.dispatch.contextId,
        contextDigest: worker.dispatch.contextDigest,
        principalId: worker.dispatch.worker.principalId,
        type: "asset",
        asset: {
          assetId: "asset_portal-node-evidence",
          contentDigest: "e".repeat(64),
          byteLength: 12,
          mediaType: "text/plain",
          sensitivity: "internal",
          summary: "Node evidence",
        },
      },
    });
    expect(graphNodes().get(runtimeFixture.task.taskId)).toMatchObject({
      runState: "awaiting-human",
      humanNeedCount: 1,
      evidenceCount: 1,
    });
    const overviewB = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(overviewB?.sync.contextRevision).toBeGreaterThan(
      overviewA?.sync.contextRevision ?? Number.MAX_SAFE_INTEGER,
    );
    expect(overviewB?.sync.humanRevision).toBeGreaterThan(
      overviewA?.sync.humanRevision ?? Number.MAX_SAFE_INTEGER,
    );
    expect(portal.listHumanNeeds(runtimeFixture.repositoryId, runtimeFixture.runId).needs).toEqual([
      expect.objectContaining({
        kind: "question",
        title: "<script>not executable</script>",
        allowedCommands: ["answer-question"],
      }),
    ]);
    expect(
      portal.getQuestion(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "submission_portal-question",
      ),
    ).toMatchObject({
      source: { submissionId: "submission_portal-question" },
      prompt: "<script>not executable</script>",
      freshDispatch: { status: "not-required" },
    });

    const tail = portal.listEventWindow(runtimeFixture.repositoryId, runtimeFixture.runId, {
      limit: 2,
    });
    expect(tail.direction).toBe("tail");
    expect(tail.events.length).toBeLessThanOrEqual(2);
    if (tail.events[0] !== undefined) {
      expect(
        portal
          .listEventWindow(runtimeFixture.repositoryId, runtimeFixture.runId, {
            before: tail.events[0].cursor,
            limit: 2,
          })
          .events.every((event) => event.cursor < (tail.events[0]?.cursor ?? 0)),
      ).toBe(true);
    }
    expect(() =>
      portal.listEventWindow(runtimeFixture.repositoryId, runtimeFixture.runId, {
        after: 1,
        before: 2,
      }),
    ).toThrow("mutually exclusive");
    broker.close();
    portal.close();
    authority.close();
    fixture.dispose();
  });

  it("marks an ended run with unaccepted work as failed", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const graphRevision =
      portal.getGraphSummary(runtimeFixture.repositoryId, runtimeFixture.runId)?.graphRevision ??
      "missing";
    const workflowNode = () =>
      portal
        .listGraphNodes(runtimeFixture.repositoryId, runtimeFixture.runId, graphRevision)
        .nodes.find((node) => node.kind === "workflow");
    expect(workflowNode()?.runState).toBe("not-started");
    expect(
      authority.submit(runControlCommand("end-run", "command_portal-end", 0), admission()),
    ).toMatchObject({ status: "completed" });
    expect(authority.queryRunControl(runtimeFixture.repositoryId, runtimeFixture.runId)?.mode).toBe(
      "ended",
    );
    expect(workflowNode()?.runState).toBe("failed");
    portal.close();
    authority.close();
    fixture.dispose();
  });

  it("distinguishes worker metadata from verified installed bytes and caps previews", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const bytes = new TextEncoder().encode("hostile <img src=x onerror=alert(1)>");
    const contentDigest = deterministicSha256.digest(bytes);
    const worker = createWorkerExecutionFixture(createRuntimeGraph(), ["worker.submit.asset"]);
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: taskScope(worker.context.contextDigest),
    });
    broker.admitSubmission({
      submission: {
        apiVersion: PROTOCOL_VERSION,
        submissionId: "submission_portal-asset",
        repositoryId: worker.dispatch.repositoryId,
        runId: worker.dispatch.runId,
        dispatchId: worker.dispatch.dispatchId,
        task: worker.dispatch.task,
        contextId: worker.dispatch.contextId,
        contextDigest: worker.dispatch.contextDigest,
        principalId: worker.dispatch.worker.principalId,
        type: "asset",
        asset: {
          assetId: "asset_portal-hostile",
          contentDigest,
          byteLength: bytes.byteLength,
          mediaType: "text/plain",
          sensitivity: "internal",
          summary: "<svg onload=alert(1)>",
        },
      },
    });
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    expect(
      portal.listArtifacts(runtimeFixture.repositoryId, runtimeFixture.runId).artifacts[0],
    ).toMatchObject({
      availability: "metadata-only",
      summary: "<svg onload=alert(1)>",
    });
    expect(
      portal.readArtifactContent(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "asset_portal-hostile",
        0,
        64,
      ),
    ).toBeUndefined();
    const beforeInstall = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId);
    authority.putAsset(bytes, "text/plain");
    expect(
      portal.getArtifact(runtimeFixture.repositoryId, runtimeFixture.runId, "asset_portal-hostile"),
    ).toMatchObject({
      availability: "verified-stored",
    });
    expect(
      portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId)?.sync
        .contextRevision,
    ).toBeGreaterThan(beforeInstall?.sync.contextRevision ?? Number.MAX_SAFE_INTEGER);
    expect(
      portal.readArtifactContent(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "asset_portal-hostile",
        0,
        64,
      ),
    ).toMatchObject({
      encoding: "utf8",
      content: "hostile <img src=x onerror=alert(1)>",
      complete: true,
      jsonNodeBudget: 500,
    });
    expect(
      portal.downloadArtifact(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        "asset_portal-hostile",
      ),
    ).toMatchObject({
      filename: `senawa-artifact-${contentDigest}.bin`,
    });
    portal.close();
    broker.close();
    authority.close();
    fixture.dispose();
  });

  it("keeps owner-scoped transcript sequences durable, replayable, bounded, and paged", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    authority.close();
    let broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });

    expect(
      broker.appendTranscript(transcriptLine({ lineId: "capture:1", text: "session started" })),
    ).toEqual({
      sequence: 1,
      retained: 1,
      replayed: false,
    });
    expect(
      broker.appendTranscript(
        transcriptLine({ lineId: "capture:2", text: "tool submit_completion success" }),
      ),
    ).toEqual({ sequence: 2, retained: 2, replayed: false });
    expect(
      broker.appendTranscript(
        transcriptLine({ lineId: "capture:3", stream: "stdout", text: "line\twith\ttabs" }),
      ),
    ).toEqual({ sequence: 3, retained: 3, replayed: false });
    expect(
      broker.appendTranscript(
        transcriptLine({ lineId: "capture:3", stream: "stdout", text: "line\twith\ttabs" }),
      ),
    ).toEqual({ sequence: 3, retained: 3, replayed: true });
    // An exact replay of any retained record stays idempotent, not just the newest.
    expect(
      broker.appendTranscript(transcriptLine({ lineId: "capture:1", text: "session started" })),
    ).toEqual({ sequence: 1, retained: 3, replayed: true });
    expect(() =>
      broker.appendTranscript(transcriptLine({ lineId: "capture:1", text: "forged replacement" })),
    ).toThrow("conflicts with prior content");
    expect(
      broker.appendTranscript(
        transcriptLine({
          lineId: "phase-capture:1",
          owner: { kind: "phase", id: "phase_transcript" },
          text: "phase opened",
        }),
      ),
    ).toEqual({ sequence: 1, retained: 1, replayed: false });

    for (const invalid of [
      { text: "" },
      { text: "a".repeat(TRANSCRIPT_LIMITS.maxLineBytes + 1) },
      { text: "bell\u0007" },
      { text: "escape\u001b[31mred" },
      { text: "carriage\rreturn" },
      { text: "forged\nrow" },
    ]) {
      expect(() =>
        broker.appendTranscript(transcriptLine({ lineId: "capture:invalid", ...invalid })),
      ).toThrow(/\$\./u);
    }
    expect(() =>
      broker.appendTranscript({
        ...transcriptLine({ lineId: "capture:stream" }),
        stream: "stdin" as unknown as AgentTranscriptLine["stream"],
      }),
    ).toThrow(/stream must be one of/u);
    expect(() =>
      broker.appendTranscript(
        transcriptLine({ lineId: "capture:orphan", runId: "run_absent", text: "orphan" }),
      ),
    ).toThrow("unknown run");
    expect(() =>
      broker.appendTranscript({
        ...transcriptLine({ lineId: "capture:run" }),
        owner: { kind: "run" as unknown as "dispatch", id: runtimeFixture.runId },
      }),
    ).toThrow("cannot write the run projection scope");

    broker.close();
    broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const owner = { kind: "dispatch", id: "dispatch_transcript" } as const;
    const firstPage = portal.listTranscript(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      owner,
      0,
      2,
    );
    expect(firstPage).toMatchObject({ after: 0, nextAfter: 2, hasMore: true });
    expect(firstPage.records.map(({ sequence, text }) => [sequence, text])).toEqual([
      [1, "session started"],
      [2, "tool submit_completion success"],
    ]);
    const secondPage = portal.listTranscript(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      owner,
      firstPage.nextAfter,
      2,
    );
    expect(secondPage).toMatchObject({ after: 2, nextAfter: 3, hasMore: false });
    expect(secondPage.records).toHaveLength(1);
    expect(
      portal.listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, owner, 3, 2),
    ).toMatchObject({ after: 3, nextAfter: 3, hasMore: false, records: [] });
    expect(
      portal.listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, {
        kind: "phase",
        id: "phase_transcript",
      }).records,
    ).toHaveLength(1);
    expect(() => portal.listTranscript(runtimeFixture.repositoryId, "run_absent", owner)).toThrow(
      "Portal run does not exist",
    );
    expect(() =>
      portal.listTranscript(
        runtimeFixture.repositoryId,
        runtimeFixture.runId,
        owner,
        0,
        TRANSCRIPT_LIMITS.maxRecordsPerPage + 1,
      ),
    ).toThrow(/limit/u);

    const ceiling = TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner;
    seedTranscriptLines(fixture.databasePath, "dispatch_transcript", 4, ceiling + 1);
    expect(
      broker.appendTranscript(
        transcriptLine({ lineId: "capture:ceiling", text: `line ${ceiling + 2}` }),
      ),
    ).toEqual({
      sequence: ceiling + 2,
      retained: ceiling,
      replayed: false,
    });
    const evicted = portal.listTranscript(
      runtimeFixture.repositoryId,
      runtimeFixture.runId,
      owner,
      0,
      1,
    );
    expect(evicted.records[0]?.sequence).toBe(3);
    portal.close();
    broker.close();
    fixture.dispose();
  });

  it("agrees on the dispatch transcript owner in repository mode without a workspace row", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    const graph = createRuntimeGraph();
    authority.close();
    const worker = createWorkerExecutionFixture(graph, ["worker.submit.completion"]);
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    broker.registerDispatch({
      context: worker.context,
      dispatch: worker.dispatch,
      completionRequirements: worker.completionRequirements,
      taskScope: taskScope(worker.context.contextDigest),
    });
    // The writer is the execution host: it always owns lines by dispatch.
    broker.appendTranscript({
      repositoryId: worker.dispatch.repositoryId,
      runId: worker.dispatch.runId,
      owner: { kind: "dispatch", id: worker.dispatch.dispatchId },
      lineId: `${worker.dispatch.dispatchId}:1`,
      occurredAt: "2026-08-14T12:00:00.000Z",
      stream: "system",
      text: "session started",
    });

    const inspection = new Database(fixture.databasePath, { readonly: true });
    const workspaceRows =
      inspection
        .prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM runner_workspaces")
        .get()?.total ?? 0;
    inspection.close();
    expect(workspaceRows).toBe(0);

    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const node = portal
      .listGraphNodes(runtimeFixture.repositoryId, runtimeFixture.runId, graph.revisionDigest)
      .nodes.find(({ nodeId }) => nodeId === runtimeFixture.task.taskId);
    expect(node?.dispatchId).toBe(worker.dispatch.dispatchId);
    expect(node?.runState).toBe("running");
    expect(
      portal
        .listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, {
          kind: "dispatch",
          id: node?.dispatchId ?? "",
        })
        .records.map(({ text }) => text),
    ).toEqual(["session started"]);
    portal.close();
    broker.close();
    fixture.dispose();
  });

  it("keeps two runs of one owner namespace independent in sequence and retention", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    instantiate(authority, { repositoryId: SECOND_REPOSITORY_ID, runId: SECOND_RUN_ID });
    authority.close();
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    const owner = { kind: "task", id: "task_shared" } as const;
    for (const [index, text] of ["run a line one", "run a line two"].entries()) {
      broker.appendTranscript(transcriptLine({ lineId: `a:${index}`, owner, text }));
    }
    expect(
      broker.appendTranscript(
        transcriptLine({
          lineId: "b:0",
          owner,
          repositoryId: SECOND_REPOSITORY_ID,
          runId: SECOND_RUN_ID,
          text: "run b line one",
        }),
      ),
    ).toEqual({ sequence: 1, retained: 1, replayed: false });

    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const first = portal.listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, owner);
    expect(first.records.map(({ sequence, text }) => [sequence, text])).toEqual([
      [1, "run a line one"],
      [2, "run a line two"],
    ]);
    expect(
      portal
        .listTranscript(SECOND_REPOSITORY_ID, SECOND_RUN_ID, owner)
        .records.map(({ text }) => text),
    ).toEqual(["run b line one"]);

    // Run B retention must never evict run A rows that share the owner namespace.
    const ceiling = TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner;
    seedTranscriptLines(fixture.databasePath, "task_shared", 2, ceiling + 1, {
      ownerKind: "task",
      repositoryId: SECOND_REPOSITORY_ID,
      runId: SECOND_RUN_ID,
    });
    broker.appendTranscript(
      transcriptLine({
        lineId: "b:evict",
        owner,
        repositoryId: SECOND_REPOSITORY_ID,
        runId: SECOND_RUN_ID,
        text: `line ${ceiling + 2}`,
      }),
    );
    expect(
      portal
        .listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, owner)
        .records.map(({ text }) => text),
    ).toEqual(["run a line one", "run a line two"]);
    expect(
      portal.listTranscript(SECOND_REPOSITORY_ID, SECOND_RUN_ID, owner, 0, 1).records[0]?.sequence,
    ).toBe(3);
    portal.close();
    broker.close();
    fixture.dispose();
  });

  it("bumps the portal revision on transcript append and serves a bounded run-wide scope", () => {
    const fixture = createFixture();
    const authority = new SqliteAuthority(fixture.options);
    instantiate(authority);
    authority.close();
    const broker = new SqliteContextBroker({
      databasePath: fixture.databasePath,
      dependencies: contextDependencies(),
    });
    const portal = new SqlitePortalQueryAuthority(fixture.options);
    const before = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId);
    broker.appendTranscript(
      transcriptLine({
        lineId: "revision:1",
        owner: { kind: "task", id: "task_alpha" },
        text: "alpha one",
      }),
    );
    const after = portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId);
    expect(after?.sync.portalRevision).toBe((before?.sync.portalRevision ?? 0) + 1);
    // A replay is not a new line, so it must not move the revision vector.
    broker.appendTranscript(
      transcriptLine({
        lineId: "revision:1",
        owner: { kind: "task", id: "task_alpha" },
        text: "alpha one",
      }),
    );
    expect(
      portal.getRunOverview(runtimeFixture.repositoryId, runtimeFixture.runId)?.sync.portalRevision,
    ).toBe(after?.sync.portalRevision);

    broker.appendTranscript(
      transcriptLine({
        lineId: "revision:2",
        owner: { kind: "phase", id: "phase_beta" },
        text: "beta one",
      }),
    );
    const merged = portal.listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, {
      kind: "run",
      id: runtimeFixture.runId,
    });
    expect(merged.records.map(({ text }) => text)).toEqual(["alpha one", "beta one"]);
    expect(merged.records.map(({ owner }) => owner.kind)).toEqual(["run", "run"]);
    expect(merged.nextAfter).toBe(2);
    expect(() =>
      portal.listTranscript(runtimeFixture.repositoryId, runtimeFixture.runId, {
        kind: "run",
        id: "run_other",
      }),
    ).toThrow("must name its own run");
    portal.close();
    broker.close();
    fixture.dispose();
  });
});

function transcriptLine(overrides: Partial<AgentTranscriptLine>): AgentTranscriptLine {
  return {
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    owner: { kind: "dispatch", id: "dispatch_transcript" },
    lineId: "capture:default",
    occurredAt: "2026-08-14T12:00:00.000Z",
    stream: "system",
    text: "session started",
    ...overrides,
  };
}

function seedTranscriptLines(
  databasePath: string,
  ownerId: string,
  from: number,
  to: number,
  scope: {
    readonly ownerKind?: string;
    readonly repositoryId?: string;
    readonly runId?: string;
  } = {},
): void {
  const database = new Database(databasePath);
  try {
    const run = database
      .prepare<[string, string], { run_key: string }>(
        "SELECT run_key FROM runs WHERE repository_id = ? AND run_id = ?",
      )
      .get(scope.repositoryId ?? runtimeFixture.repositoryId, scope.runId ?? runtimeFixture.runId);
    if (run === undefined) throw new Error("Expected a durable run fixture");
    const base =
      database
        .prepare<[string], { latest: number | null }>(
          "SELECT MAX(run_sequence) AS latest FROM agent_transcript_lines WHERE run_key = ?",
        )
        .get(run.run_key)?.latest ?? 0;
    const insert = database.prepare(
      `INSERT INTO agent_transcript_lines(
         run_key, owner_kind, owner_id, sequence, run_sequence, line_id,
         occurred_at, stream, text
       ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-14T12:00:00.000Z', 'system', ?)`,
    );
    database.transaction(() => {
      for (let sequence = from; sequence <= to; sequence += 1) {
        insert.run(
          run.run_key,
          scope.ownerKind ?? "dispatch",
          ownerId,
          sequence,
          base + sequence - from + 1,
          `seed:${sequence}`,
          `line ${sequence}`,
        );
      }
    })();
  } finally {
    database.close();
  }
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "senawa-human-authority-"));
  roots.add(root);
  const databasePath = join(root, "authority.db");
  return {
    root,
    databasePath,
    options: {
      databasePath,
      assetDirectory: join(root, "assets"),
      dependencies,
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
      roots.delete(root);
    },
  };
}

function instantiate(
  authority: SqliteAuthority,
  run: { readonly repositoryId: string; readonly runId: string } = runtimeFixture,
): void {
  const base = runtimeCommand({
    commandId: `command_phase11-instantiate-${run.runId.replaceAll(/[^a-z0-9-]/gu, "-")}`,
    intent: "instantiate-run",
    payload: {
      workflowId: runtimeFixture.workflowId,
      configurationSnapshotDigest: runtimeFixture.configurationSnapshotDigest,
      execution: runtimeFixture.execution,
      graph: createRuntimeGraph(),
      phase: runtimeFixture.phase,
      approvalPolicy: { policy: "no-approval" },
      escalationPolicyDigest: runtimeFixture.escalationPolicyDigest,
      allowancePolicy: runtimeFixture.allowancePolicy,
    },
  });
  expect(
    authority.submit(
      run.runId === runtimeFixture.runId
        ? base
        : decodeCommandEnvelope({
            ...base,
            repositoryId: run.repositoryId,
            runId: run.runId,
          }),
      admission(),
    ),
  ).toMatchObject({ status: "completed" });
}

function admission() {
  return {
    currentTime: "2026-08-14T12:00:00.000Z",
    facts: { source: "phase11a-test" },
    allocateId() {
      allocationSequence += 1;
      return `stream-event-phase11-${allocationSequence}`;
    },
  };
}

function contextDependencies() {
  return {
    sha256: deterministicSha256,
    currentTime: () => "2026-08-14T12:00:00.000Z",
    issueGrantToken: () => new Uint8Array(32).fill(7),
  };
}

function taskScope(contextDigest: string) {
  return {
    runId: runtimeFixture.runId,
    taskId: runtimeFixture.task.taskId,
    definitionGeneration: runtimeFixture.task.definitionGeneration,
    acceptedContextDigest: contextDigest,
    fenceGeneration: 1,
  };
}

function answerQuestionCommand(input: {
  commandId: string;
  questionDigest: string;
  contextDigest: string;
  expectedDefinitionRevision: string;
}) {
  return runtimeCommand({
    commandId: input.commandId,
    intent: "answer-question",
    payload: {
      submissionId: "submission_phase11-question",
      questionDigest: input.questionDigest,
      contextDigest: input.contextDigest,
      taskId: runtimeFixture.task.taskId,
      definitionGeneration: runtimeFixture.task.definitionGeneration,
      answer: { target: "production" },
    },
    expectedDefinitionRevision: input.expectedDefinitionRevision,
    exactObjectDigest: input.questionDigest,
  });
}

function configuredRunner(fixture: ReturnType<typeof createFixture>, limit = 1) {
  const runner = new SqliteRunnerAuthority(fixture.options);
  runner.configureRun({
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    contextDigest: runtimeFixture.task.contextRevisionDigest,
    taskScopes: [{ ...taskScope(runtimeFixture.task.contextRevisionDigest), claimsAccepted: true }],
    budgets: [{ unit: "model-millidollars", limit }],
    lease: runnerLease(),
  });
  runner.bindAllowancePolicy(
    runtimeFixture.repositoryId,
    runtimeFixture.runId,
    runtimeFixture.allowancePolicy,
  );
  return runner;
}

function effectCommand() {
  return {
    sequence: 1,
    commandId: "runner-command-phase11",
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    operationId: "operation_phase11",
    kind: "worker" as const,
    taskScope: taskScope(runtimeFixture.task.contextRevisionDigest),
    contextDigest: runtimeFixture.task.contextRevisionDigest,
    inputDigest: "b".repeat(64),
    input: { dispatchId: "dispatch_phase11" },
    budgetReservation: { unit: "model-millidollars", amount: 5 },
    queuedAt: "2026-08-14T12:00:00.000Z",
    maxReconciliationAttempts: 2,
  };
}

function runnerLease() {
  return {
    owner: "runner-owner-phase11",
    fence: 1,
    expiresAt: "2026-08-14T13:00:00.000Z",
  };
}

function runInput(command: ReturnType<typeof effectCommand>) {
  return {
    repositoryId: runtimeFixture.repositoryId,
    runId: runtimeFixture.runId,
    lease: runnerLease(),
    currentTime: "2026-08-14T12:00:00.000Z",
    attemptId: "attempt_phase11",
    command,
  };
}

function grantAllowanceCommand(input: {
  commandId: string;
  escalationDigest: string;
  expectedLimit: number;
  expectedGraphRevision?: string;
  expectedRunModeRevision?: number;
  increaseBy: number;
  unit?: string;
}) {
  return runtimeCommand({
    commandId: input.commandId,
    intent: "grant-allowance",
    payload: {
      escalationCommandId: "runner-command-phase11",
      operationId: "operation_phase11",
      escalationDigest: input.escalationDigest,
      policyDigest: runtimeFixture.allowancePolicy.policyDigest,
      unit: input.unit ?? "model-millidollars",
      expectedLimit: input.expectedLimit,
      expectedRunModeRevision: input.expectedRunModeRevision ?? 0,
      increaseBy: input.increaseBy,
    },
    expectedGraphRevision: input.expectedGraphRevision ?? createRuntimeGraph().revisionDigest,
    exactObjectDigest: input.escalationDigest,
  });
}

function runControlCommand(
  intent: "pause-run" | "resume-run" | "end-run",
  commandId: string,
  expectedRunModeRevision: number,
  roles: readonly string[] = ["release-manager"],
) {
  return runtimeCommand({
    commandId,
    intent,
    payload: { expectedRunModeRevision },
    roles,
  });
}
