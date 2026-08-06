import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LeaseConflictError } from "@senawa/application";
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
    expect(appJs).toContain("button.disabled=pending");
    expect(appJs).toContain('pendingCommand+" in progress…"');
    expect(appJs).toContain('activeTask.title+" · "+activeTask.status');
    expect(appJs).toContain('activePhase.id+" · "+activePhase.status');
    expect(appJs).toContain('state.status==="finished"');
    expect(appJs).toContain('textContent="run finished"');
    expect(appJs).toContain('/worker-events");');
    expect(appJs).toContain("appendWorkerRecord(JSON.parse(event.data))");
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
  return createSenawaServices(root, {
    ...composition,
    gateEvaluator: {
      async evaluate(input) {
        return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
      },
    },
  });
}

function sseReader(response: Response): () => Promise<{ seq: number }> {
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
        if (data !== undefined) return JSON.parse(data) as { seq: number };
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
      const response = await fetch(`${origin}/api/v1/runs/${supervisor.runId}/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(202);
      return body;
    },
  };
}

async function approve(browser: Awaited<ReturnType<typeof browserSession>>, phaseId: string) {
  return browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId,
  });
}
