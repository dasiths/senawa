import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableBrowserCommandService, LeaseConflictError } from "@senawa/application";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { CommandActor } from "@senawa/domain";
import { createFileTestComposition } from "@senawa/testing";
import { SimulatedWorkerAdapter } from "@senawa/workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createSenawaServices } from "../../../apps/senawa/src/services.js";
import { appJs, indexHtml, stylesCss } from "./static-assets.js";
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
    expect(indexHtml.indexOf('id="artifact-identity"')).toBeLessThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(indexHtml.indexOf('id="artifact-content"')).toBeLessThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(appJs).toContain("async function renderApproval(phaseId)");
    expect(appJs).toContain('q("#decision-controls").hidden=true');
    expect(appJs).toContain(
      'renderJson(q("#artifact-content"),artifact.content,"Artifact content")',
    );
    expect(appJs).toContain('declared.attribution+" "+declaredKind+": "+declared.value');
    expect(appJs).toContain('q("#decision-controls").hidden=false');
    expect(appJs).toContain("expectedVersion:approvalArtifact.version");
    expect(appJs).toContain("expectedDigest:approvalArtifact.digest");
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

  it("resizes, collapses, and persists the console rails", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(indexHtml).toContain('id="splitter-left" class="splitter" role="separator"');
    expect(indexHtml).toContain('id="splitter-right" class="splitter" role="separator"');
    expect(indexHtml).toContain('aria-orientation="vertical"');
    expect(indexHtml).toContain('aria-controls="overview"');
    expect(indexHtml).toContain('aria-controls="inspector"');
    expect(indexHtml).toContain('aria-valuemin="180"');
    expect(indexHtml).toContain('aria-valuemax="640"');
    expect(indexHtml).toContain('aria-valuenow="220"');
    expect(indexHtml).toContain('aria-valuenow="320"');
    expect(indexHtml).toContain('id="overview-toggle" class="rail-toggle" type="button"');
    expect(indexHtml).toContain('id="inspector-toggle" class="rail-toggle" type="button"');
    expect(indexHtml).toContain('aria-controls="overview-body"');
    expect(indexHtml).toContain('aria-controls="inspector-body"');
    expect(indexHtml).toContain('id="decision-badge" class="rail-badge" role="status" hidden');
    expect(stylesCss).toContain("grid-template-columns:var(--rail-left,220px)");
    expect(stylesCss).toContain('.workspace[data-left="collapsed"]{--rail-left:40px}');
    expect(stylesCss).toContain('.workspace[data-right="collapsed"]{--rail-right:40px}');
    expect(stylesCss).toContain(
      '.workspace[data-left="collapsed"] .overview .rail-spine,.workspace[data-right="collapsed"] .controls .rail-spine{display:block}',
    );
    expect(stylesCss).toContain('html[data-dragging="true"]{cursor:col-resize;user-select:none}');
    expect(appJs).toContain('const LAYOUT_KEY="senawa.console.layout.v1"');
    expect(appJs).toContain('localStorage.getItem(LAYOUT_KEY)||"null"');
    expect(appJs).toContain("localStorage.setItem(LAYOUT_KEY,JSON.stringify(layout))");
    expect(appJs).toContain('root.style.setProperty("--rail-left",layout.left+"px")');
    expect(appJs).toContain('root.style.setProperty("--rail-right",layout.right+"px")');
    expect(appJs).toContain('workspace.dataset.left=layout.leftCollapsed?"collapsed":"expanded"');
    expect(appJs).toContain('setAttribute("aria-valuenow"');
    expect(appJs).toContain('toggle.setAttribute("aria-expanded",String(!collapsed))');
    expect(appJs).toContain("setPointerCapture(event.pointerId)");
    expect(appJs).toContain("releasePointerCapture(dragState.pointerId)");
    expect(appJs).toContain('event.key==="ArrowLeft"');
    expect(appJs).toContain('event.key==="ArrowRight"');
    expect(appJs).toContain('event.key==="Home"');
    expect(appJs).toContain('event.key==="End"');
    expect(appJs).toContain("function toggleRail(side,collapsed)");
    expect(appJs).toContain("function updateDecisionBadge()");
    expect(appJs).toContain("badge.hidden=!pending");
    expect(appJs).toContain(
      'if(typeof ResizeObserver==="function")new ResizeObserver(()=>{if(dragState===null)scheduleGraphFit()}).observe(q("#graph"))',
    );
    expect(appJs).toContain("readLayout();\napplyLayout();");
  });

  it("renders artifact payloads through a bounded escaped JSON viewer", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(appJs).not.toContain("outerHTML");
    expect(appJs).not.toContain("insertAdjacentHTML");
    expect(appJs).not.toContain("document.write");
    expect(appJs).not.toContain("new RegExp");
    expect(indexHtml).toContain('<div id="artifact-content" class="jsonview"');
    expect(indexHtml).toContain('<div id="artifact-inputs" class="jsonview"');
    expect(indexHtml).not.toContain('<pre id="artifact-content"');
    expect(indexHtml.indexOf('id="artifact-identity"')).toBeLessThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(indexHtml.indexOf('id="artifact-content"')).toBeLessThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(appJs).toContain("function renderJson(host,value,label)");
    expect(appJs).toContain('tree.setAttribute("role","tree")');
    expect(appJs).toContain('item.setAttribute("role","treeitem")');
    expect(appJs).toContain('group.setAttribute("role","group")');
    expect(appJs).toContain('item.setAttribute("aria-expanded",String(expanded))');
    expect(appJs).toContain("const JSON_RAW_LIMIT=1000000");
    expect(appJs).toContain("const JSON_ROW_BUDGET=2000");
    expect(appJs).toContain("const JSON_CHUNK=100");
    expect(appJs).toContain("const JSON_STRING_CAP=512");
    expect(appJs).toContain("const JSON_DEFAULT_DEPTH=2");
    expect(appJs).toContain("if(view.rows>=JSON_ROW_BUDGET)");
    expect(appJs).toContain('"Show next "+Math.min(JSON_CHUNK,entries.length-end)');
    expect(appJs).toContain('"… "+(raw.length-JSON_STRING_CAP)+" more characters"');
    expect(appJs).toContain("raw.length>JSON_RAW_LIMIT");
    expect(appJs).toContain('text("pre",raw.slice(0,JSON_RAW_LIMIT),"jsonraw")');
    expect(appJs).toContain("function buildJsonChildren(view,item)");
    expect(appJs).toContain('search.type="search"');
    expect(appJs).toContain("const needle=query.trim().toLowerCase()");
    expect(appJs).toContain('(item.dataset.search||"").includes(needle)');
    expect(appJs).toContain('text("button","Expand all","jsonview-expand")');
    expect(appJs).toContain('text("button","Collapse all","jsonview-collapse")');
    expect(appJs).toContain('text("button","Copy JSON","jsonview-copy")');
    expect(appJs).toContain("function copyJson(view,value)");
    expect(appJs).toContain("navigator.clipboard?.writeText");
    expect(appJs).toContain('copy.setAttribute("aria-label","Copy "+(key===null?"payload":key))');
    expect(appJs).toContain(
      'renderJson(q("#artifact-inputs"),artifact.consumed,"Consumed inputs")',
    );
    expect(stylesCss).toContain(".jsontree{max-height:360px");
    expect(stylesCss).toContain(".jsonraw{max-height:360px");
    expect(stylesCss).not.toContain("#artifact-content{max-height:280px");
  });

  it("shows artifact JSON for any phase that has an artifact version", () => {
    expect(appJs).toContain(
      'const artifactKey=phase?.artifactVersion==null?null:phase.id+":"+phase.artifactVersion',
    );
    expect(appJs).toContain('q("#approval").hidden=artifactKey===null');
    expect(appJs).toContain("if(artifactKey!==null)void renderApproval(phase.id)");
    expect(appJs).not.toContain('q("#approval").hidden=!awaitingApproval');
    expect(appJs).toContain("function updateDecision()");
    expect(appJs).toContain('node?.kind==="phase"&&node.status==="awaiting_approval"');
    expect(appJs).toContain('q("#decision-controls").hidden=false');
  });

  it("separates routine progression from destructive actions", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(indexHtml).toContain('<div class="runbar">');
    expect(indexHtml.indexOf('id="resume"')).toBeLessThan(indexHtml.indexOf('id="workspace"'));
    expect(indexHtml.indexOf('id="last-command"')).toBeLessThan(
      indexHtml.indexOf('id="workspace"'),
    );
    expect(indexHtml).toContain(
      '<button id="resume" class="run-command icon-button" type="button">',
    );
    expect(indexHtml).toContain('<details id="danger-zone" class="danger-zone">');
    expect(indexHtml).toContain("<summary>Danger zone</summary>");
    expect(indexHtml).toContain(
      '<button id="end" class="danger run-command icon-button" type="button" aria-describedby="end-hint">',
    );
    expect(indexHtml).toContain('id="end-hint" class="hint" role="status" aria-live="polite"');
    expect(indexHtml).toContain('<textarea id="end-reason" required maxlength="1000"');
    expect(indexHtml.indexOf('id="danger-zone"')).toBeGreaterThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(appJs).toContain("function requestEnd()");
    expect(appJs).toContain("function disarmEnd()");
    expect(appJs).toContain(
      'q("#end-hint").textContent="A reason is required before this run can end."',
    );
    expect(appJs).toContain('q("#end-label").textContent="Confirm end run"');
    expect(appJs).toContain("const END_ARM_MS=5000");
    expect(appJs).toContain('q("#end").addEventListener("click",requestEnd)');
    expect(appJs).toContain('q("#danger-zone").hidden=q("#ending").hidden');
    expect(appJs).not.toContain("window.confirm");
    expect(appJs).not.toContain('command("end",{reason:q("#end-reason").value})');
    expect(appJs).toContain('q("#resume").hidden=["awaiting_approval","ended","finished"]');
    expect(appJs).toContain('document.querySelectorAll(".run-command")');
    expect(stylesCss).toContain("#end.armed{");
    expect(stylesCss).toContain(".danger-zone[hidden]{display:none}");
  });

  it("builds icon buttons and a selected-node toolbar without HTML injection", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(appJs).not.toContain("new RegExp");
    expect(indexHtml).toContain('<svg class="sprite" aria-hidden="true" focusable="false">');
    expect(indexHtml).toContain('<symbol id="icon-steer" viewBox="0 0 16 16">');
    expect(indexHtml).toContain('<symbol id="icon-resume" viewBox="0 0 16 16">');
    expect(indexHtml).toContain('<symbol id="icon-end" viewBox="0 0 16 16">');
    expect(indexHtml).toContain('<symbol id="icon-view" viewBox="0 0 16 16">');
    expect(indexHtml).toContain(
      '<div id="node-toolbar" class="node-toolbar" role="toolbar" aria-label="Selected node actions"',
    );
    expect(indexHtml.indexOf('id="node-toolbar"')).toBeLessThan(
      indexHtml.indexOf('id="artifact-identity"'),
    );
    expect(indexHtml).not.toContain("data:image");
    expect(indexHtml).not.toContain("<img");
    expect(appJs).toContain('const SVG_NS="http://www.w3.org/2000/svg"');
    expect(appJs).toContain('document.createElementNS(SVG_NS,"svg")');
    expect(appJs).toContain('document.createElementNS(SVG_NS,"use")');
    expect(appJs).toContain('use.setAttribute("href","#icon-"+name)');
    expect(appJs).toContain('svg.setAttribute("class","icon icon-"+name)');
    expect(appJs).not.toContain("svg.className=");
    expect(appJs).not.toContain("xlink:href");
    expect(appJs).not.toContain("data:image/svg");
    expect(appJs).toContain("function iconButton(id,name,label,className)");
    expect(appJs).toContain('button.setAttribute("aria-label",label)');
    expect(appJs).toContain("function renderNodeToolbar()");
    expect(appJs).toContain("function toolbarKeydown(event)");
    expect(appJs).toContain("buttons[next].tabIndex=0");
    expect(appJs).toContain("toolbar.hidden=node===undefined");
    expect(appJs).not.toContain('event.key==="Tab"');
    expect(stylesCss).toContain(".sprite{position:absolute;width:0;height:0;overflow:hidden}");
    expect(stylesCss).toContain(".icon{width:14px;height:14px");
    expect(stylesCss).toContain(".node-toolbar[hidden]{display:none}");
  });

  it("raises a pending question above the collapsible rails", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(indexHtml).toContain(
      '<section id="question-banner" class="question-banner" aria-labelledby="question-banner-title" hidden>',
    );
    expect(indexHtml.indexOf('id="question-banner"')).toBeLessThan(
      indexHtml.indexOf('id="workspace"'),
    );
    expect(indexHtml).toContain('<p id="question-alert" class="visually-hidden" role="alert">');
    expect(indexHtml).toContain('id="question-banner-answer" maxlength="4000"');
    expect(indexHtml).toContain(
      'id="question-banner-status" class="question-status" role="status" aria-live="polite"',
    );
    expect(indexHtml).not.toContain('id="question-banner-submit" class="run-command"');
    expect(appJs).toContain("function renderQuestionBanner()");
    expect(appJs).toContain("function updateQuestionElapsed()");
    expect(appJs).toContain("const QUESTION_OVERDUE_MS=60000");
    expect(appJs).toContain('elapsed.classList.toggle("overdue",waited>=QUESTION_OVERDUE_MS)');
    expect(appJs).toContain('openQuestions.some((question)=>question.status==="answerable")');
    expect(appJs).toContain('q("#run-status").textContent=awaitingAnswer?"waiting for answer"');
    expect(appJs).toContain('q("#last-command").textContent="waiting for your answer"');
    expect(appJs).toContain(
      'document.title=(awaitingAnswer?"● Answer needed — ":"")+"Senawa Run Console"',
    );
    expect(appJs).toContain('badge.textContent=questionPendingNow?"?"');
    expect(appJs).toContain("badge.hidden=!pending");
    expect(appJs).toContain(
      'const signature=openQuestions.map((question)=>question.questionId+":"+question.status).join("|")',
    );
    expect(appJs).toContain("if(signature===questionsSignature)return");
    expect(appJs).toContain("document.activeElement!==answer");
    expect(appJs).toContain('event.key==="Enter"&&(event.ctrlKey||event.metaKey)');
    expect(appJs).toContain('questions/"+encodeURIComponent(question.questionId)+"/answer');
    expect(appJs).toContain('prompt=text("p",question.question)');
    expect(stylesCss).toContain(".visually-hidden{position:absolute");
    expect(stylesCss).toContain(".question-banner-elapsed.overdue");
  });

  it("opens an asset full screen through a modal dialog", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(indexHtml).toContain(
      '<dialog id="asset-overlay" class="assetview" aria-labelledby="asset-title">',
    );
    expect(indexHtml).toContain(
      '<div id="asset-body" class="jsonview" aria-label="Asset payload">',
    );
    expect(indexHtml).toContain(
      'id="asset-close" class="assetview-close" type="button" aria-label="Close asset viewer"',
    );
    expect(indexHtml.indexOf('id="asset-overlay"')).toBeGreaterThan(
      indexHtml.indexOf('id="decision-controls"'),
    );
    expect(appJs).toContain("function renderJson(host,value,label)");
    expect(appJs).toContain("function openAsset(value,label,source)");
    expect(appJs).toContain("overlay.showModal()");
    expect(appJs).toContain('if(host.id!=="asset-body")toolbar.append(expandFull)');
    expect(appJs).toContain('renderJson(q("#asset-body"),value,label)');
    expect(appJs).toContain('document.documentElement.dataset.modal="true"');
    expect(appJs).toContain("delete document.documentElement.dataset.modal");
    expect(appJs).toContain("assetReturnFocus.focus()");
    expect(appJs).toContain('q("#asset-overlay").addEventListener("close",releaseAsset)');
    expect(appJs).toContain('if(event.key==="Escape"){event.preventDefault();closeAsset()}');
    expect(stylesCss).toContain('html[data-modal="true"]{overflow:hidden}');
    expect(stylesCss).toContain("dialog::backdrop");
    expect(stylesCss).toContain(".assetview .jsontree,.assetview .jsonraw{max-height:none");
    expect(stylesCss).toContain(".jsontree{max-height:360px");
    expect(stylesCss).toContain(".jsonraw{max-height:360px");
  });

  it("keeps output scrolling pinned to the reader", () => {
    expect(() => new Function(appJs)).not.toThrow();
    expect(appJs).not.toContain("innerHTML");
    expect(indexHtml).toContain('<div class="stage-output">');
    expect(indexHtml).toContain(
      '<div id="terminal" class="terminal" role="log" tabindex="0" aria-label="Agent output">',
    );
    expect(indexHtml).toContain(
      '<button id="output-jump" class="output-jump" type="button" hidden>Jump to latest</button>',
    );
    expect(appJs).toContain("const OUTPUT_PIN_SLACK=24");
    expect(appJs).toContain("function outputAtBottom(terminal)");
    expect(appJs).toContain(
      "terminal.scrollHeight-terminal.clientHeight-terminal.scrollTop<=OUTPUT_PIN_SLACK",
    );
    expect(appJs).toContain("if(outputPinned)terminal.scrollTop=terminal.scrollHeight");
    expect(appJs).toContain("else terminal.scrollTop=previousTop");
    expect(appJs).toContain("function updateOutputJump()");
    expect(appJs).toContain("function jumpToLatest()");
    expect(appJs).toContain("jump.hidden=outputPinned");
    expect(appJs).toContain("if(!outputPinned)outputUnseen+=1");
    expect(appJs).toContain('"Jump to latest ("+outputUnseen+" new)"');
    expect(appJs).toContain("{passive:true}");
    expect(appJs).toContain('event.key==="End"&&!event.shiftKey');
    expect(appJs).toContain("outputPinned=true;\n  outputUnseen=0;");
    expect(stylesCss).toContain(".stage-output{position:relative}");
    expect(stylesCss).toContain("overflow-anchor:none");
    expect(stylesCss).toContain(".output-jump[hidden]{display:none}");
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
      expect((await services.queries.status("async-command-run"))?.needs).toMatchObject({
        action: "approve-or-reject",
        phaseId: "define",
      });

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
    const queuedBrief = await queuedServices.queries.phaseBrief("queued-recovery-run", "define");
    if (queuedBrief.artifact === null) throw new Error("definition artifact is missing");
    const queuedCommand = {
      apiVersion: "senawa.dev/browser-command/v1",
      commandId: "44444444-4444-4444-8444-444444444444",
      command: "reject",
      phaseId: "define",
      expectedVersion: queuedBrief.artifact.version,
      expectedDigest: queuedBrief.artifact.digest,
      reason: "Recover queued command",
    } as const;
    await queuedServices.browserCommands.submit("queued-recovery-run", queuedCommand);
    const queuedSupervisor = await startWebSupervisor(queuedServices);
    try {
      const browser = await rawBrowserSession(queuedSupervisor);
      expect(await browser.terminal(queuedCommand.commandId)).toMatchObject({
        status: "completed",
        payload: {
          expectedVersion: queuedBrief.artifact.version,
          expectedDigest: queuedBrief.artifact.digest,
        },
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
      expect((await services.queries.status("production-demo-run"))?.needs).toMatchObject({
        action: "approve-or-reject",
        phaseId: "verify",
      });
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
      workerHost: new SimulatedWorkerAdapter(),
      workerHostIdentity: {
        kind: "simulated",
        adapter: "simulated-worker",
        adapterVersion: "1",
      },
      repositoryEvidence: {
        async captureBaseline(input) {
          return {
            version: 1,
            kind: "repository-baseline",
            runId: input.runId,
            taskId: input.taskId,
            attempt: input.attempt,
            dispatchId: input.dispatchId,
            turnId: input.turnId,
            expectation: input.expectation,
            authorizedPaths: input.authorizedPaths,
            frozenPaths: input.frozenPaths,
            head: "simulated-browser-head",
            entries: [],
            capturedAt: input.capturedAt,
            uncertainty: [],
            digest: "b".repeat(64),
            evidencePath: "evidence/repository/browser-baseline.json",
          };
        },
        async captureDelta(input) {
          return {
            version: 1,
            kind: "repository-delta",
            runId: input.baseline.runId,
            taskId: input.baseline.taskId,
            attempt: input.baseline.attempt,
            dispatchId: input.baseline.dispatchId,
            turnId: input.baseline.turnId,
            expectation: input.baseline.expectation,
            baselineDigest: input.baseline.digest,
            headBefore: input.baseline.head,
            headAfter: input.baseline.head,
            preExistingChanges: [],
            changedPaths: [
              { path: "packages/browser-fixture.ts", status: " M", digest: "c".repeat(64) },
            ],
            inScopeChanges: ["packages/browser-fixture.ts"],
            outOfScopeChanges: [],
            frozenChanges: [],
            uncertainty: [],
            workerClaim: {
              reported: input.workerClaim.reported,
              changed: input.workerClaim.changed,
              agreement: "disagree",
            },
            capturedAt: input.capturedAt,
            digest: "d".repeat(64),
            evidencePath: "evidence/repository/browser-delta.json",
          };
        },
      },
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
