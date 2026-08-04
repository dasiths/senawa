import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandActor, loadRepositoryDefinitions } from "@senawa/core";
import { LeaseConflictError } from "@senawa/graph";
import { createSenawaServices } from "@senawa/orchestrator";
import { beforeAll, describe, expect, it } from "vitest";
import { appJs } from "./static-assets.js";
import { startWebSupervisor, type WebSupervisor } from "./supervisor.js";

const actor: CommandActor = { channel: "direct-cli" };
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("loopback web supervisor", () => {
  it("refuses a second supervisor and invalidates the one-time bootstrap", async () => {
    const services = await createRun("singleton-run");
    const first = await startWebSupervisor(services);
    try {
      await expect(startWebSupervisor(services)).rejects.toBeInstanceOf(LeaseConflictError);
      const bootstrap = await fetch(first.bootstrapUrl, { redirect: "manual" });
      expect(bootstrap.status).toBe(303);
      expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
      expect((await fetch(first.bootstrapUrl, { redirect: "manual" })).status).toBe(401);
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

      await services.commands.reject("replay-run", "define", "Produce another version", actor);
      await services.commands.resume("replay-run", actor);
      expect((await next()).seq).toBe(3);
      expect((await next()).seq).toBe(4);
    } finally {
      controller.abort();
      await supervisor.close();
    }
  });

  it("uses DOM text nodes for all dynamic browser values", () => {
    expect(appJs).not.toContain("innerHTML");
    expect(appJs).toContain("textContent");
    expect(appJs).toContain("document.createElement");
    expect(appJs).toContain('q("#resume").hidden=["awaiting_approval","ended","finished"]');
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
      await browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" });
      await approveAndResume(browser, "define");
      await approveAndResume(browser, "research");
      await approveAndResume(browser, "plan");
      expect((await services.queries.status("production-demo-run"))?.needs?.phaseId).toBe("verify");
      await approveAndResume(browser, "verify");

      expect((await services.queries.status("production-demo-run"))?.status).toBe("finished");
      expect(await services.queries.report("production-demo-run")).toContain(
        "Status: **finished**",
      );
    } finally {
      await supervisor.close();
    }
  });
});

async function createRun(runId: string) {
  const root = await mkdtemp(join(tmpdir(), "senawa-web-"));
  const services = createSenawaServices(root, {
    gateEvaluator: {
      async evaluate(input) {
        return { gateId: input.gateId, accepted: true, readings: [], findings: [] };
      },
    },
  });
  await services.commands.start({
    actor,
    definitions,
    request: { goal: "Exercise the browser supervisor", constraints: [] },
    runId,
  });
  await services.commands.drive(runId, actor);
  return services;
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
      expect(response.status).toBe(202);
      return response.json();
    },
  };
}

async function approveAndResume(
  browser: Awaited<ReturnType<typeof browserSession>>,
  phaseId: string,
) {
  await browser.command({
    apiVersion: "senawa.dev/browser-command/v1",
    command: "approve",
    phaseId,
  });
  return browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" });
}
