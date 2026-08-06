import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBrowserCommandService, LeaseConflictError } from "@senawa/application";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { CommandActor } from "@senawa/domain";
import { createFileTestComposition } from "@senawa/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createSenawaServices } from "../../../apps/senawa/src/services.js";
import { appJs } from "./static-assets.js";
import { startWebSupervisor, type WebSupervisor } from "./supervisor.js";

const actor: CommandActor = { channel: "direct-cli" };
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("loopback web supervisor", () => {
  it("refuses a second supervisor and keeps the bootstrap capability recoverable", async () => {
    const services = await createRun("singleton-run");
    const first = await startWebSupervisor(services);
    try {
      await expect(startWebSupervisor(services)).rejects.toBeInstanceOf(LeaseConflictError);
      const bootstrap = await fetch(first.bootstrapUrl, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      const origin = new URL(first.url).origin;
      const dagre = await fetch(`${origin}/dagre.js`, { headers: { Cookie: cookie } });
      const cytoscape = await fetch(`${origin}/cytoscape.js`, { headers: { Cookie: cookie } });
      const cytoscapeDagre = await fetch(`${origin}/cytoscape-dagre.js`, {
        headers: { Cookie: cookie },
      });
      expect(dagre.status).toBe(200);
      expect((await dagre.text()).length).toBeGreaterThan(100_000);
      expect(cytoscape.status).toBe(200);
      expect((await cytoscape.text()).length).toBeGreaterThan(100_000);
      expect(cytoscapeDagre.status).toBe(200);
      expect(await cytoscapeDagre.text()).toContain("cytoscapeDagre");
      const page = await fetch(first.url, { headers: { Cookie: cookie } });
      expect(page.headers.get("content-security-policy")).toContain(
        "style-src 'self' 'unsafe-inline'",
      );
      const repeatedBootstrap = await fetch(first.bootstrapUrl, { redirect: "manual" });
      expect(repeatedBootstrap.status).toBe(303);
      expect(repeatedBootstrap.headers.get("set-cookie")?.split(";", 1)[0]).toBe(cookie);
      const invalidBootstrap = first.bootstrapUrl.replace(
        /\/bootstrap\/[^/]+\//u,
        "/bootstrap/invalid/",
      );
      expect((await fetch(invalidBootstrap, { redirect: "manual" })).status).toBe(401);
      const crossOriginCommand = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: "http://example.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          apiVersion: "senawa.dev/browser-command/v1",
          command: "resume",
        }),
      });
      expect(crossOriginCommand.status).toBe(403);
      const missingOrigin = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          apiVersion: "senawa.dev/browser-command/v1",
          commandId: randomUUID(),
          command: "resume",
        }),
      });
      expect(missingOrigin.status).toBe(403);
      const wrongContentType = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "text/plain" },
        body: "{}",
      });
      expect(wrongContentType.status).toBe(415);
      const spoofedContentType = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json-evil" },
        body: "{}",
      });
      expect(spoofedContentType.status).toBe(415);
      const malformed = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          apiVersion: "senawa.dev/browser-command/v1",
          commandId: "../../receipt",
          command: "resume",
          claimOwner: "client-authority",
        }),
      });
      expect(malformed.status).toBe(400);
      const oversized = await fetch(`${origin}/api/v1/runs/${first.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ value: "x".repeat(8_192) }),
      });
      expect(oversized.status).toBe(413);
      const unauthorizedReceipt = await fetch(
        `${origin}/api/v1/runs/${first.runId}/commands/${randomUUID()}`,
      );
      expect(unauthorizedReceipt.status).toBe(401);
      const unauthorizedReceiptStream = await fetch(
        `${origin}/api/v1/runs/${first.runId}/commands/events`,
      );
      expect(unauthorizedReceiptStream.status).toBe(401);
      const crossRunReceipt = await fetch(
        `${origin}/api/v1/runs/another-run/commands/${randomUUID()}`,
        { headers: { Cookie: cookie } },
      );
      expect(crossRunReceipt.status).toBe(404);
      const crossRunReceiptStream = await fetch(
        `${origin}/api/v1/runs/another-run/commands/events`,
        { headers: { Cookie: cookie } },
      );
      expect(crossRunReceiptStream.status).toBe(404);
      expect(bootstrap.headers.has("access-control-allow-origin")).toBe(false);
    } finally {
      await first.close();
    }
  });

  it("replays persisted output and then tails newly persisted records without a gap", async () => {
    const services = await createRun("replay-run");
    const supervisor = await startWebSupervisor(services);
    const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const origin = new URL(supervisor.url).origin;
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${origin}/api/v1/runs/replay-run/streams/${encodeURIComponent("phase:define")}/events?after=1`,
        { headers: { Cookie: cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const next = sseReader(response);
      expect((await next()).seq).toBe(2);

      const independent = servicesForRoot(services.repositoryRoot);
      await independent.commands.reject("replay-run", "define", "Produce another version", actor);
      await independent.commands.resume("replay-run", actor);
      expect((await next()).seq).toBe(3);
      expect((await next()).seq).toBe(4);
    } finally {
      controller.abort();
      await supervisor.close();
    }
  });

  it("replays durable worker events through the selected-owner SSE stream", async () => {
    const services = await createRun("worker-stream-run");
    const supervisor = await startWebSupervisor(services);
    const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const origin = new URL(supervisor.url).origin;
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${origin}/api/v1/runs/worker-stream-run/streams/${encodeURIComponent("phase:define")}/worker-events`,
        { headers: { Cookie: cookie }, signal: controller.signal },
      );
      expect(response.status).toBe(200);
      const next = sseReader(response);
      expect((await next()).seq).toBe(1);
      expect((await next()).seq).toBe(2);
    } finally {
      controller.abort();
      await supervisor.close();
    }
  });

  it("replays writes made while the supervisor is stopped", async () => {
    const services = await createRun("restart-replay-run");
    const first = await startWebSupervisor(services);
    await first.close();

    const independent = servicesForRoot(services.repositoryRoot);
    await independent.commands.reject(
      "restart-replay-run",
      "define",
      "Write while browser is stopped",
      actor,
    );
    await independent.commands.resume("restart-replay-run", actor);

    const restarted = await startWebSupervisor(services);
    const bootstrap = await fetch(restarted.bootstrapUrl, { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const origin = new URL(restarted.url).origin;
    const controller = new AbortController();
    try {
      const response = await fetch(
        `${origin}/api/v1/runs/restart-replay-run/streams/${encodeURIComponent("phase:define")}/events?after=2`,
        { headers: { Cookie: cookie }, signal: controller.signal },
      );
      const next = sseReader(response);
      expect((await next()).seq).toBe(3);
      expect((await next()).seq).toBe(4);
    } finally {
      controller.abort();
      await restarted.close();
    }
  });

  it("replays and tails durable command receipts across reconnects and independent writers", async () => {
    const services = await createRun("receipt-stream-run");
    const supervisor = await startWebSupervisor(services);
    const browser = await rawBrowserSession(supervisor);
    const liveController = new AbortController();
    const commandId = "99999999-9999-4999-8999-999999999999";
    try {
      const liveResponse = await fetch(`${browser.prefix}/events`, {
        headers: { Cookie: browser.cookie },
        signal: liveController.signal,
      });
      expect(liveResponse.status).toBe(200);
      expect(liveResponse.headers.get("content-type")).toContain("text/event-stream");
      expect(liveResponse.headers.get("cache-control")).toBe("no-store");
      expect(liveResponse.headers.has("access-control-allow-origin")).toBe(false);
      const nextLive = sseReader<CommandReceipt>(liveResponse);
      expect(
        await browser.post({
          apiVersion: "senawa.dev/browser-command/v1",
          commandId,
          command: "reject",
          phaseId: "define",
          reason: "Stream the terminal receipt",
        }),
      ).toMatchObject({ response: { status: 202 } });
      const live = [await nextLive(), await nextLive(), await nextLive()];
      expect(live.map((receipt) => receipt.seq)).toEqual([1, 2, 3]);
      expect(live.map((receipt) => receipt.status)).toEqual(["queued", "running", "completed"]);
      expect(new Set(live.map((receipt) => receipt.commandId))).toEqual(new Set([commandId]));
      liveController.abort();

      const replayController = new AbortController();
      const replayResponse = await fetch(`${browser.prefix}/events`, {
        headers: { Cookie: browser.cookie },
        signal: replayController.signal,
      });
      const nextReplay = sseReader<CommandReceipt>(replayResponse);
      expect([await nextReplay(), await nextReplay(), await nextReplay()]).toEqual(live);
      replayController.abort();

      const reconnectController = new AbortController();
      const reconnectResponse = await fetch(`${browser.prefix}/events?after=0`, {
        headers: { Cookie: browser.cookie, "Last-Event-ID": "1" },
        signal: reconnectController.signal,
      });
      const nextReconnect = sseReader<CommandReceipt>(reconnectResponse);
      expect([(await nextReconnect()).seq, (await nextReconnect()).seq]).toEqual([2, 3]);

      const independent = servicesForRoot(services.repositoryRoot);
      const independentCommandId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await independent.browserCommands.submit("receipt-stream-run", {
        apiVersion: "senawa.dev/browser-command/v1",
        commandId: independentCommandId,
        command: "resume",
      });
      const independentlyWritten = await nextReconnect();
      expect(independentlyWritten).toMatchObject({
        seq: 4,
        commandId: independentCommandId,
        status: "queued",
      });
      reconnectController.abort();
    } finally {
      liveController.abort();
      await supervisor.close();
    }
  });

  it("uses DOM text nodes for all dynamic browser values", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(appJs).toContain("textContent");
    expect(appJs).toContain("document.createElement");
    expect(appJs).toContain("cytoscape({");
    expect(appJs).toContain("globalThis.__senawaGraph=graph");
    expect(appJs).toContain('name:"dagre"');
    expect(appJs).toContain("function calculatePositions(elements)");
    expect(appJs).toContain('name:"preset"');
    expect(appJs).toContain('node.position("y")>taskFrontierPosition.y');
    expect(appJs).toContain('parent:"phase:"+task.parentPhaseId');
    expect(appJs).toContain('phase.executorKind==="task-frontier"');
    expect(appJs).toContain('const placeholderId="placeholder:"+taskFrontier.id+":tasks"');
    expect(appJs).toContain('label:"Tasks from approved plan\\nnot expanded"');
    expect(appJs).toContain('source:"task:"+dependency,target:"task:"+task.key');
    expect(appJs).toContain('const completionId="boundary:"+taskFrontier.id+":complete"');
    expect(appJs).toContain("(phase.dependsOn||[]).includes(taskFrontier.id)");
    expect(appJs).toContain('source:completionId,target:"phase:"+successor.id');
    expect(appJs).not.toContain('positions["phase:implement"]');
    expect(appJs).not.toContain('target:"phase:verify"');
    expect(appJs).toContain('q("#resume").hidden=["awaiting_approval","ended","finished"]');
    expect(appJs).toContain("setCommandPending(command,true,extra)");
    expect(appJs).toContain("commandPending||receiptActive()");
    expect(appJs).toContain('document.querySelectorAll(".run-command")');
    expect(appJs).not.toContain('document.querySelectorAll(".controls button")');
    expect(appJs).toContain("const questionDrafts=new Map()");
    expect(appJs).toContain("const questionPending=new Set()");
    expect(appJs).toContain("function renderQuestions()");
    expect(appJs).toContain('prompt=text("p",question.question)');
    expect(appJs).toContain("answer.maxLength=4000");
    expect(appJs).toContain('answer.value=questionDrafts.get(question.questionId)||""');
    expect(appJs).toContain("questionDrafts.set(question.questionId,answer.value)");
    expect(appJs).toContain('question.status==="stale"?"No longer awaiting this answer"');
    expect(appJs).toContain('question.status!=="answerable"');
    expect(appJs).toContain("questionPending.has(question.questionId)");
    expect(appJs).toContain('questions/"+encodeURIComponent(question.questionId)+"/answer');
    expect(appJs).toContain("questionDrafts.delete(question.questionId)");
    expect(appJs).toContain("commandId:crypto.randomUUID()");
    expect(appJs).toContain("async function recoverActiveReceipt()");
    expect(appJs).toContain("function startReceiptStream()");
    expect(appJs).toContain(
      'new EventSource("/api/v1/runs/"+encodeURIComponent(runId)+"/commands/events")',
    );
    expect(appJs).toContain("if(receipt.seq<=receiptCursor)return false");
    expect(appJs).not.toContain("receiptPoll");
    expect(appJs).not.toContain("pollReceipt");
    expect(appJs).not.toContain("setTimeout(pollReceipt");
    expect(appJs).toContain('pendingCommand+" in progress…"');
    expect(appJs).toContain('activeTask.title+" · "+activeTask.status');
    expect(appJs).toContain('activePhase.id+" · "+activePhase.status');
    expect(appJs).toContain('state.status==="finished"');
    expect(appJs).toContain('textContent="run finished"');
    expect(appJs).toContain('/worker-events");');
    expect(appJs).toContain("appendWorkerRecord(JSON.parse(event.data))");
  });

  it("projects and answers durable worker questions through the authenticated API", async () => {
    const services = await createRun("question-api-run");
    const first = await seedWorkerQuestion(
      services,
      "question-api-run",
      "<img src=x onerror=alert('question')>",
    );
    const second = await services.commands.ask(
      "question-api-run",
      "Choose the release boundary?",
      { channel: "worker", sessionId: first.context.sessionId },
      first.context,
    );
    const initial = await startWebSupervisor(services);
    const initialBrowser = await questionBrowserSession(initial);
    expect((await initialBrowser.open()).questions).toEqual([
      expect.objectContaining({
        questionId: first.questionId,
        question: "<img src=x onerror=alert('question')>",
        ownerKind: "phase",
        ownerId: "define",
        status: "answerable",
      }),
      expect.objectContaining({ questionId: second.questionId, status: "answerable" }),
    ]);
    await initial.close();

    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const delayedServices = {
      ...services,
      browserCommands: {
        submit: services.browserCommands.submit.bind(services.browserCommands),
        receipt: services.browserCommands.receipt.bind(services.browserCommands),
        activeReceipt: services.browserCommands.activeReceipt.bind(services.browserCommands),
        receipts: services.browserCommands.receipts.bind(services.browserCommands),
        async processNext(..._input: Parameters<typeof services.browserCommands.processNext>) {
          await executionGate;
          return false;
        },
      },
    };
    const restarted = await startWebSupervisor(delayedServices);
    const browser = await questionBrowserSession(restarted);
    const submissionId = "11111111-1111-4111-8111-111111111111";
    try {
      expect((await browser.open()).questions).toHaveLength(2);
      expect((await fetch(`${browser.prefix}/questions/open`)).status).toBe(401);

      const queued = await browser.command({
        apiVersion: "senawa.dev/browser-command/v1",
        commandId: "22222222-2222-4222-8222-222222222222",
        command: "resume",
      });
      expect(queued.status).toBe(202);
      expect((await browser.active()).receipt).toMatchObject({ status: "queued" });

      expect(
        (await browser.answer(first.questionId, { submissionId, answer: "  Application layer  " }))
          .response.status,
      ).toBe(200);
      expect(
        (await browser.answer(first.questionId, { submissionId, answer: "Application layer" }))
          .response.status,
      ).toBe(200);
      const conflict = await browser.answer(first.questionId, {
        submissionId,
        answer: "Changed answer",
      });
      expect(conflict.response.status).toBe(409);
      expect(conflict.body).toMatchObject({ error: { code: "submission_conflict" } });
      const independentlyAnswered = await browser.answer(first.questionId, {
        submissionId: randomUUID(),
        answer: "Application layer",
      });
      expect(independentlyAnswered.response.status).toBe(409);
      expect(independentlyAnswered.body).toMatchObject({
        error: { code: "question_unavailable" },
      });
      expect((await browser.open()).questions.map((question) => question.questionId)).toEqual([
        second.questionId,
      ]);

      const answers = (await services.queries.journal("question-api-run")).filter(
        (event) => event.event === "question.answered",
      );
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        actor: { channel: "web" },
        data: { questionId: first.questionId, answer: "Application layer", submissionId },
      });

      expect(
        (await browser.answer(second.questionId, { submissionId: randomUUID(), answer: "" }))
          .response.status,
      ).toBe(400);
      expect(
        (
          await browser.answer(second.questionId, {
            submissionId: randomUUID(),
            answer: "x".repeat(4001),
          })
        ).response.status,
      ).toBe(400);
      expect(
        (
          await browser.answer(second.questionId, {
            submissionId: randomUUID(),
            answer: "Valid",
            extra: true,
          })
        ).response.status,
      ).toBe(400);
      expect((await browser.answerRaw("not valid", {}, {})).response.status).toBe(403);
      expect(
        (
          await browser.answerRaw(
            second.questionId,
            { submissionId: randomUUID(), answer: "Valid" },
            { Origin: "http://example.invalid", "Content-Type": "application/json" },
          )
        ).response.status,
      ).toBe(403);
      expect(
        (
          await browser.answerRaw(
            second.questionId,
            { submissionId: randomUUID(), answer: "Valid" },
            { Origin: browser.origin, "Content-Type": "text/plain" },
          )
        ).response.status,
      ).toBe(415);
      expect(
        (
          await browser.answerRaw(
            "not valid",
            { submissionId: randomUUID(), answer: "Valid" },
            { Origin: browser.origin, "Content-Type": "application/json" },
          )
        ).response.status,
      ).toBe(400);

      await replaceActiveQuestionTurn(services, "question-api-run", "replacement-turn");
      expect((await browser.open()).questions).toEqual([
        expect.objectContaining({ questionId: second.questionId, status: "stale" }),
      ]);
      const stale = await browser.answer(second.questionId, {
        submissionId: randomUUID(),
        answer: "Too late",
      });
      expect(stale.response.status).toBe(409);
      expect(stale.body).toMatchObject({ error: { code: "question_unavailable" } });
    } finally {
      releaseExecution();
      await restarted.close();
    }
  });

  it("acknowledges durably before execution and enforces command idempotency", async () => {
    const services = await createRun("async-command-run");
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const delayedServices = {
      ...services,
      browserCommands: {
        submit: services.browserCommands.submit.bind(services.browserCommands),
        receipt: services.browserCommands.receipt.bind(services.browserCommands),
        activeReceipt: services.browserCommands.activeReceipt.bind(services.browserCommands),
        receipts: services.browserCommands.receipts.bind(services.browserCommands),
        async processNext(...input: Parameters<typeof services.browserCommands.processNext>) {
          await executionGate;
          return services.browserCommands.processNext(...input);
        },
      },
    };
    const supervisor = await startWebSupervisor(delayedServices);
    const browser = await rawBrowserSession(supervisor);
    const commandId = "33333333-3333-4333-8333-333333333333";
    const command = {
      apiVersion: "senawa.dev/browser-command/v1",
      commandId,
      command: "reject",
      phaseId: "define",
      reason: "Prove durable acknowledgement",
    } as const;
    try {
      const submitted = await browser.post(command);
      expect(submitted.response.status).toBe(202);
      expect(submitted.response.headers.get("location")).toBe(
        `/api/v1/runs/async-command-run/commands/${commandId}`,
      );
      expect(submitted.body.receipt).toMatchObject({ commandId, status: "queued", seq: 1 });
      expect((await services.queries.status("async-command-run"))?.needs?.phaseId).toBe("define");

      const active = await browser.active();
      expect(active.receipt).toMatchObject({ commandId, status: "queued" });
      const replay = await browser.post(command);
      expect(replay.response.status).toBe(202);
      expect(replay.body.receipt).toEqual(submitted.body.receipt);

      const changed = await browser.post({ ...command, reason: "Changed content" });
      expect(changed.response.status).toBe(409);
      const competing = await browser.post({ ...command, commandId: randomUUID() });
      expect(competing.response.status).toBe(409);

      releaseExecution();
      expect(await browser.terminal(commandId)).toMatchObject({ status: "completed" });
      expect((await browser.active()).receipt).toBeNull();
    } finally {
      releaseExecution();
      await supervisor.close();
    }
  });

  it("keeps the web claim fenced until graceful shutdown finishes active execution", async () => {
    const services = await createRun("graceful-command-shutdown-run");
    let releaseExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    const browserCommands = new DurableBrowserCommandService(
      services.receiptStore,
      {
        async executeBrowserCommand(runId, payload) {
          await executionGate;
          return services.commands.executeBrowserCommand(runId, payload);
        },
      },
      {
        scheduleEvery: () => () => undefined,
      },
    );
    const supervisor = await startWebSupervisor({ ...services, browserCommands });
    const browser = await rawBrowserSession(supervisor);
    const commandId = "88888888-8888-4888-8888-888888888888";
    await browser.post({
      apiVersion: "senawa.dev/browser-command/v1",
      commandId,
      command: "reject",
      phaseId: "define",
      reason: "Finish before releasing the web claim",
    });
    await waitForStoredReceipt(services, "graceful-command-shutdown-run", commandId, "running");

    let closed = false;
    const closing = supervisor.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
    await expect(startWebSupervisor(services)).rejects.toBeInstanceOf(LeaseConflictError);

    releaseExecution();
    await closing;
    expect((await services.receiptStore.get(supervisor.runId, commandId))?.status).toBe(
      "completed",
    );
  });

  it("recovers queued and stale-running receipts after supervisor startup", async () => {
    const queuedServices = await createRun("queued-recovery-run");
    const queuedCommand = {
      apiVersion: "senawa.dev/browser-command/v1",
      commandId: "44444444-4444-4444-8444-444444444444",
      command: "reject",
      phaseId: "define",
      reason: "Recover queued command",
    } as const;
    await queuedServices.browserCommands.submit("queued-recovery-run", queuedCommand);
    const queuedSupervisor = await startWebSupervisor(queuedServices);
    try {
      const browser = await rawBrowserSession(queuedSupervisor);
      expect(await browser.terminal(queuedCommand.commandId)).toMatchObject({
        status: "completed",
      });
    } finally {
      await queuedSupervisor.close();
    }

    const staleServices = await createRun("stale-recovery-run");
    const staleCommand = {
      ...queuedCommand,
      commandId: "55555555-5555-4555-8555-555555555555",
      reason: "Recover stale running command",
    };
    await staleServices.browserCommands.submit("stale-recovery-run", staleCommand);
    const staleLease = await staleServices.acquireWebLease(
      "stale-recovery-run",
      "web-stopped",
      30_000,
    );
    await staleServices.receiptStore.claim({
      runId: "stale-recovery-run",
      webLease: staleLease,
      ttlMs: 30_000,
    });
    await staleServices.releaseWebLease("stale-recovery-run", staleLease);
    const restarted = await startWebSupervisor(staleServices);
    try {
      const browser = await rawBrowserSession(restarted);
      expect(await browser.terminal(staleCommand.commandId)).toMatchObject({
        status: "completed",
        attempt: 2,
      });
    } finally {
      await restarted.close();
    }
  });

  it("replays command-correlated application effects without duplicating transitions", async () => {
    const services = await createRun("command-replay-run");
    const command = {
      apiVersion: "senawa.dev/browser-command/v1",
      commandId: "66666666-6666-4666-8666-666666666666",
      command: "reject",
      phaseId: "define",
      reason: "Recover after application commit",
    } as const;
    await services.commands.executeBrowserCommand("command-replay-run", command);
    await services.browserCommands.submit("command-replay-run", command);
    const supervisor = await startWebSupervisor(services);
    try {
      const browser = await rawBrowserSession(supervisor);
      expect(await browser.terminal(command.commandId)).toMatchObject({ status: "completed" });
      const correlated = (await services.queries.journal("command-replay-run")).filter(
        (event) => Reflect.get(event.data, "commandId") === command.commandId,
      );
      expect(correlated.filter((event) => event.event === "phase.rejected")).toHaveLength(1);
      expect(correlated.filter((event) => event.event === "work.resumed")).toHaveLength(1);
    } finally {
      await supervisor.close();
    }
  });

  it("sanitizes unexpected command execution failures", async () => {
    const services = await createRun("sanitized-error-run");
    const browserCommands = new DurableBrowserCommandService(
      services.receiptStore,
      {
        async executeBrowserCommand() {
          throw new Error("Unexpected secret at /home/private/token.txt");
        },
      },
      {
        scheduleEvery: () => () => undefined,
      },
    );
    const supervisor = await startWebSupervisor({ ...services, browserCommands });
    try {
      const browser = await rawBrowserSession(supervisor);
      const commandId = "77777777-7777-4777-8777-777777777777";
      expect(
        await browser.post({
          apiVersion: "senawa.dev/browser-command/v1",
          commandId,
          command: "resume",
        }),
      ).toMatchObject({ response: { status: 202 } });
      const receipt = await browser.terminal(commandId);
      expect(receipt).toMatchObject({
        status: "refused",
        error: { message: "The command could not be completed" },
      });
      expect(receipt.error?.message).not.toContain("/home/private");
    } finally {
      await supervisor.close();
    }
  });

  it("drives the production workflow from rejection through finish over HTTP", async () => {
    const services = await createRun("production-demo-run");
    const supervisor = await startWebSupervisor(services);
    const browser = await browserSession(supervisor);
    try {
      await browser.command({
        apiVersion: "senawa.dev/browser-command/v1",
        command: "reject",
        phaseId: "define",
        reason: "Exercise artifact rework",
      });
      await approve(browser, "define");
      await approve(browser, "research");
      await approve(browser, "plan");
      expect((await services.queries.status("production-demo-run"))?.needs?.phaseId).toBe("verify");
      await approve(browser, "verify");

      expect((await services.queries.status("production-demo-run"))?.status).toBe("finished");
      expect(await services.queries.report("production-demo-run")).toContain(
        "Outcome: **finished**",
      );
    } finally {
      await supervisor.close();
    }
  });
});

async function createRun(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "senawa-web-"));
  const services = servicesForRoot(root);
  await services.commands.start({
    actor,
    definitions,
    request: { goal: "Exercise the browser supervisor", constraints: [] },
    runId,
  });
  await services.commands.drive(runId, actor);
  return services;
}

function servicesForRoot(root: string) {
  const composition = createFileTestComposition(root);
  return {
    ...createSenawaServices(root, {
      ...composition,
      gateEvaluator: {
        async evaluate(input) {
          return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
        },
      },
    }),
    persistence: composition.persistence,
    receiptStore: composition.receiptStore,
  };
}

async function seedWorkerQuestion(
  services: Awaited<ReturnType<typeof createRun>>,
  runId: string,
  question: string,
) {
  const context = {
    owner: { kind: "phase" as const, id: "define" },
    sessionId: "question-session",
    turnId: "question-turn",
  };
  const current = await services.persistence.readRun(runId);
  current.state.status = "running";
  current.state.activeTurn = {
    ownerKind: context.owner.kind,
    ownerId: context.owner.id,
    sessionId: context.sessionId,
    attempt: 1,
    turnId: context.turnId,
    dispatchId: "question-dispatch",
    operationId: "question-operation",
    operation: "create",
  };
  await services.persistence.commitRun({
    runId,
    expectedRevision: current.revision,
    operationId: "seed-question-turn",
    state: current.state,
  });
  const result = await services.commands.ask(
    runId,
    question,
    { channel: "worker", sessionId: context.sessionId },
    context,
  );
  return { ...result, context };
}

async function replaceActiveQuestionTurn(
  services: Awaited<ReturnType<typeof createRun>>,
  runId: string,
  turnId: string,
) {
  const current = await services.persistence.readRun(runId);
  if (current.state.activeTurn === null) throw new Error("Expected an active question turn");
  current.state.activeTurn = { ...current.state.activeTurn, turnId };
  await services.persistence.commitRun({
    runId,
    expectedRevision: current.revision,
    operationId: `replace-question-turn-${current.revision}`,
    state: current.state,
  });
}

function sseReader<T extends { seq: number } = { seq: number }>(
  response: Response,
): () => Promise<T> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length);
        if (data !== undefined) return JSON.parse(data) as T;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE stream ended before the next record");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

async function browserSession(supervisor: WebSupervisor) {
  const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap did not issue a session cookie");
  const origin = new URL(supervisor.url).origin;
  return {
    async command(command: unknown) {
      const payload = { ...(command as object), commandId: randomUUID() };
      const response = await fetch(`${origin}/api/v1/runs/${supervisor.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        receipt?: { commandId: string; status: string; error?: { message: string } };
      };
      expect(response.status, JSON.stringify(body)).toBe(202);
      if (body.receipt === undefined)
        throw new Error("Command acknowledgement omitted its receipt");
      for (;;) {
        const currentResponse = await fetch(
          `${origin}/api/v1/runs/${supervisor.runId}/commands/${body.receipt.commandId}`,
          { headers: { Cookie: cookie } },
        );
        const current = (await currentResponse.json()) as typeof body;
        if (current.receipt?.status === "completed") return current;
        if (current.receipt?.status === "refused") {
          throw new Error(current.receipt.error?.message ?? "Browser command was refused");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    },
  };
}

async function rawBrowserSession(supervisor: WebSupervisor) {
  const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap did not issue a session cookie");
  const origin = new URL(supervisor.url).origin;
  const prefix = `${origin}/api/v1/runs/${supervisor.runId}/commands`;
  return {
    cookie,
    prefix,
    async post(command: unknown) {
      const response = await fetch(prefix, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      return { response, body: (await response.json()) as { receipt?: CommandReceipt } };
    },
    async active() {
      const response = await fetch(`${prefix}/active`, { headers: { Cookie: cookie } });
      return (await response.json()) as { receipt: CommandReceipt | null };
    },
    async terminal(commandId: string): Promise<CommandReceipt> {
      for (;;) {
        const response = await fetch(`${prefix}/${commandId}`, { headers: { Cookie: cookie } });
        const body = (await response.json()) as { receipt: CommandReceipt };
        if (body.receipt.status === "completed" || body.receipt.status === "refused") {
          return body.receipt;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    },
  };
}

async function questionBrowserSession(supervisor: WebSupervisor) {
  const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap did not issue a session cookie");
  const origin = new URL(supervisor.url).origin;
  const prefix = `${origin}/api/v1/runs/${supervisor.runId}`;
  const answerRaw = async (
    questionId: string,
    input: Record<string, unknown>,
    headers: Record<string, string>,
  ) => {
    const response = await fetch(`${prefix}/questions/${encodeURIComponent(questionId)}/answer`, {
      method: "POST",
      headers: { Cookie: cookie, ...headers },
      body: JSON.stringify(input),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    origin,
    prefix,
    async open() {
      const response = await fetch(`${prefix}/questions/open`, { headers: { Cookie: cookie } });
      return (await response.json()) as {
        questions: Array<{
          questionId: string;
          question: string;
          ownerKind: string;
          ownerId: string;
          status: string;
        }>;
      };
    },
    async active() {
      const response = await fetch(`${prefix}/commands/active`, { headers: { Cookie: cookie } });
      return (await response.json()) as { receipt: CommandReceipt | null };
    },
    command(payload: unknown) {
      return fetch(`${prefix}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    answer(questionId: string, input: Record<string, unknown>) {
      return answerRaw(
        questionId,
        { apiVersion: "senawa.dev/question-answer/v1", ...input },
        { Origin: origin, "Content-Type": "application/json" },
      );
    },
    answerRaw,
  };
}

interface CommandReceipt {
  readonly seq: number;
  readonly commandId: string;
  readonly status: "queued" | "running" | "completed" | "refused";
  readonly attempt: number;
  readonly error?: { readonly message: string };
}

async function approve(browser: Awaited<ReturnType<typeof browserSession>>, phaseId: string) {
  return browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId,
  });
}

async function waitForStoredReceipt(
  services: Awaited<ReturnType<typeof createRun>>,
  runId: string,
  commandId: string,
  status: "queued" | "running",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipt = await services.receiptStore.get(runId, commandId);
    if (receipt?.status === status) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Receipt ${commandId} did not reach ${status}`);
}
