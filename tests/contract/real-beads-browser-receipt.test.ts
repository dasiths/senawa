import { type ChildProcess, execFile, fork } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startWebSupervisor, type WebSupervisor } from "@senawa/browser";
import { BeadsClient } from "@senawa/runtime-beads";
import { createRuntimeFixture } from "@senawa/testing";
import { SimulatedWorkerHost } from "@senawa/workers";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { createRuntimeComposition } from "../../apps/senawa/src/composition.js";
import { createSenawaServices } from "../../apps/senawa/src/services.js";

const execute = promisify(execFile);
const runId = "run-real-beads-browser-receipt";
const commandId = "11111111-2222-4333-8444-555555555555";
const leaseTtlMs = 2_000;
const command = {
  apiVersion: "senawa.dev/browser-command/v1",
  commandId,
  command: "approve",
  phaseId: "phase",
} as const;

describe("real Beads browser receipt recovery", () => {
  it.skipIf(process.platform === "win32")(
    "recovers one durably acknowledged command after supervisor SIGKILL",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "senawa-beads-browser-receipt-"));
      const bundleRoot = await mkdtemp(
        join(fileURLToPath(new URL(".", import.meta.url)), ".senawa-contract-bundle-"),
      );
      let crashChild: ChildProcess | undefined;
      let crashChildExit: ReturnType<typeof waitForExit> | undefined;
      let restartedSupervisor: WebSupervisor | undefined;
      try {
        await initializeRepository(root);
        await seedAwaitingApproval(root);
        const childBundle = await buildCrashChild(bundleRoot);
        crashChild = fork(childBundle, [root, runId, String(leaseTtlMs)], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        crashChildExit = waitForExit(crashChild);
        const childSupervisor = await waitForChildSupervisor(crashChild);
        const childBrowser = await browserSession(childSupervisor);

        expect(await childBrowser.snapshot()).toMatchObject({
          backend: "beads",
          status: "awaiting_approval",
          phases: [{ id: "phase", status: "awaiting_approval" }],
        });
        const submitted = await childBrowser.post(command);
        expect(submitted.response.status).toBe(202);
        expect(submitted.response.headers.get("location")).toBe(
          `/api/v1/runs/${runId}/commands/${commandId}`,
        );
        expect(submitted.body.receipt).toMatchObject({
          commandId,
          status: "queued",
          seq: 1,
          attempt: 0,
        });

        const receiptPath = join(
          root,
          ".agents",
          ".copilot-tracking",
          runId,
          "browser-commands.jsonl",
        );
        const queuedRecords = await readJsonLines(receiptPath);
        expect(queuedRecords).toHaveLength(1);
        expect(queuedRecords[0]).toMatchObject({ commandId, status: "queued", seq: 1 });
        expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);

        expect(crashChild.kill("SIGKILL")).toBe(true);
        expect(await crashChildExit).toEqual({ code: null, signal: "SIGKILL" });
        crashChild = undefined;
        crashChildExit = undefined;

        await waitForPersistedLeaseExpiry(root);
        const restartedComposition = createRuntimeComposition(root, "beads");
        const restartedServices = createSenawaServices(root, {
          ...restartedComposition,
          runtimeBackend: "beads",
          workerHost: new SimulatedWorkerHost(),
          workerHostIdentity: {
            kind: "simulated",
            adapter: "simulated-worker",
            adapterVersion: "1",
            legacy: false,
          },
        });
        restartedSupervisor = await startWebSupervisor(restartedServices, {
          runId,
          leaseTtlMs,
        });
        const restartedBrowser = await browserSession(restartedSupervisor);
        const completed = await restartedBrowser.terminal(commandId);

        expect(completed).toMatchObject({
          commandId,
          status: "completed",
          attempt: 1,
          claimFence: 2,
          result: { kind: "finished" },
        });
        expect((await restartedBrowser.active()).receipt).toBeNull();
        const replay = await restartedBrowser.post(command);
        expect(replay.response.status).toBe(202);
        expect(replay.body.receipt).toEqual(completed);

        const receiptRecords = await readJsonLines(receiptPath);
        expect(receiptRecords.map((record) => record.seq)).toEqual(
          receiptRecords.map((_record, index) => index + 1),
        );
        expect(receiptRecords[0]).toMatchObject({ status: "queued", attempt: 0 });
        expect(receiptRecords.slice(1, -1).every((record) => record.status === "running")).toBe(
          true,
        );
        expect(receiptRecords.at(-1)).toMatchObject({ status: "completed", attempt: 1 });
        expect(await restartedBrowser.snapshot()).toMatchObject({
          backend: "beads",
          status: "finished",
        });
        const correlated = (await restartedServices.queries.journal(runId)).filter(
          (event) => Reflect.get(event.data, "commandId") === commandId,
        );
        expect(correlated.filter((event) => event.event === "phase.approved")).toHaveLength(1);
        expect(correlated.filter((event) => event.event === "work.resumed")).toHaveLength(1);

        const issues = await new BeadsClient(root).json<Array<{ readonly issue_type: string }>>([
          "list",
          "--all",
          "--limit",
          "0",
        ]);
        expect(issues.some((issue) => issue.issue_type !== "event")).toBe(true);
        await expect(
          stat(join(root, ".agents", ".copilot-tracking", runId, "runtime-state.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await restartedSupervisor?.close();
        if (crashChild !== undefined) {
          crashChild.kill("SIGKILL");
          await crashChildExit;
        }
        await rm(root, { recursive: true, force: true });
        await rm(bundleRoot, { recursive: true, force: true });
      }
    },
  );
});

async function initializeRepository(root: string): Promise<void> {
  await execute("git", ["init", "--quiet", root]);
  await execute("git", ["-C", root, "config", "user.email", "contract@example.com"]);
  await execute("git", ["-C", root, "config", "user.name", "contract"]);
  await execute("git", ["-C", root, "config", "beads.role", "maintainer"]);
}

async function seedAwaitingApproval(root: string): Promise<void> {
  const state = createRuntimeFixture(runId);
  state.identity.backend = "beads";
  state.status = "awaiting_approval";
  const phase = state.phases[0];
  if (phase === undefined) throw new Error("Runtime fixture has no phase");
  phase.status = "awaiting_approval";
  phase.iteration = 1;
  phase.artifactVersion = 1;
  state.artifacts.push({
    phaseId: phase.id,
    version: 1,
    path: `artifacts/${phase.id}/v1.json`,
    createdAt: state.identity.createdAt,
    content: { summary: "Seeded approval artifact" },
    consumed: {},
  });
  await createRuntimeComposition(root, "beads").persistence.createRun(state, "seed-awaiting");
}

async function buildCrashChild(bundleRoot: string): Promise<string> {
  const outfile = join(bundleRoot, "real-beads-browser-receipt-crash-child.mjs");
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("./fixtures/real-beads-browser-receipt-crash-child.ts", import.meta.url),
      ),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import{createRequire as __createRequire}from"node:module";const require=__createRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  return outfile;
}

interface ChildSupervisor {
  readonly runId: string;
  readonly url: string;
  readonly bootstrapUrl: string;
}

function waitForChildSupervisor(child: ChildProcess): Promise<ChildSupervisor> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      reject(
        new Error(
          `Crash child exited before readiness: ${String(code)}/${String(signal)}${stderr === "" ? "" : `: ${stderr.trim()}`}`,
        ),
      );
    });
    child.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      if (Reflect.get(message, "type") === "error") {
        reject(new Error(String(Reflect.get(message, "message"))));
        return;
      }
      if (Reflect.get(message, "type") !== "ready") return;
      resolve({
        runId: String(Reflect.get(message, "runId")),
        url: String(Reflect.get(message, "url")),
        bootstrapUrl: String(Reflect.get(message, "bootstrapUrl")),
      });
    });
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPersistedLeaseExpiry(root: string): Promise<void> {
  const leasePath = join(root, ".agents", ".copilot-tracking", runId, "leases", "web.json");
  const envelope = JSON.parse(await readFile(leasePath, "utf8")) as {
    readonly lease: { readonly expiresAt: string } | null;
  };
  if (envelope.lease === null) throw new Error("Crash child did not persist a web lease");
  const expiresAt = Date.parse(envelope.lease.expiresAt);
  const delayMs = Math.max(0, expiresAt - Date.now() + 100);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  expect(Date.now()).toBeGreaterThan(expiresAt);
}

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function browserSession(supervisor: ChildSupervisor | WebSupervisor) {
  const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap did not issue a session cookie");
  const origin = new URL(supervisor.url).origin;
  const runPrefix = `${origin}/api/v1/runs/${supervisor.runId}`;
  const commandPrefix = `${runPrefix}/commands`;
  return {
    async snapshot(): Promise<Record<string, unknown>> {
      const response = await fetch(`${runPrefix}/snapshot`, { headers: { Cookie: cookie } });
      return (await response.json()) as Record<string, unknown>;
    },
    async post(payload: unknown) {
      const response = await fetch(commandPrefix, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return {
        response,
        body: (await response.json()) as { readonly receipt: Record<string, unknown> },
      };
    },
    async active() {
      const response = await fetch(`${commandPrefix}/active`, { headers: { Cookie: cookie } });
      return (await response.json()) as { readonly receipt: Record<string, unknown> | null };
    },
    async terminal(id: string): Promise<Record<string, unknown>> {
      for (;;) {
        const response = await fetch(`${commandPrefix}/${id}`, { headers: { Cookie: cookie } });
        const body = (await response.json()) as { readonly receipt: Record<string, unknown> };
        if (body.receipt.status === "completed" || body.receipt.status === "refused") {
          return body.receipt;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}
