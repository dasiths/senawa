import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { BrowserRunCommand, CommandActor } from "@senawa/domain";
import { createSenawaServices, type SenawaServices } from "@senawa/orchestrator";
import { startWebSupervisor, type WebSupervisor } from "@senawa/web";
import { beforeAll, describe, expect, it } from "vitest";
import { runCli } from "./program.js";

const driverActor: CommandActor = { channel: "driver" };
const fixedNow = () => new Date("2026-08-04T12:00:00.000Z");
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("Commander CLI", () => {
  it("supports repository diagnostics and workflow inspection", async () => {
    const services = createSenawaServices(process.cwd());
    const output: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: () => undefined };

    expect(await runCli(["doctor"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      ok: true,
      workflows: ["standard-delivery"],
    });
    expect(await runCli(["workflow", "render", "standard-delivery"], { services, io })).toBe(0);
    expect(output.pop()).toContain("flowchart LR");
  });

  it.each([
    {
      name: "invalid built-in sensor configuration",
      mutate: (source: string) => source.replace("parser: raw", "parser: json"),
      message: "Sensor typecheck has invalid @senawa/sensor-command configuration",
    },
    {
      name: "missing deterministic gate anchor",
      mutate: (source: string) => source.replace("kind: deterministic", "kind: inferential"),
      message: "Gate definition-accepted has no deterministic non-advisory sensor anchor",
    },
  ])("fails doctor preflight for $name", async ({ mutate, message }) => {
    const root = await copyRepositoryConfiguration();
    const policyPath = resolve(root, ".senawa/sensors.yaml");
    await writeFile(policyPath, mutate(await readFile(policyPath, "utf8")));
    const services = createSenawaServices(root);
    const errors: string[] = [];
    const io = { stdout: () => undefined, stderr: (value: string) => errors.push(value) };

    await expect(runCli(["doctor"], { services, io })).resolves.toBe(1);
    expect(errors.join("\n")).toContain(message);
  });

  it("opens a fresh browser bootstrap or prints it for manual use", async () => {
    const services = await createRun("browser-command-run");
    const output: string[] = [];
    const opened: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: () => undefined };

    expect(
      await runCli(["browser", "browser-command-run"], {
        services,
        io,
        holdWeb: false,
        openBrowser: async (url) => {
          opened.push(url);
        },
      }),
    ).toBe(0);
    const automatic = JSON.parse(output.pop() ?? "{}") as {
      url: string;
      browserUrl: string;
      opened: boolean;
    };
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/bootstrap/");
    expect(automatic.opened).toBe(true);
    expect(automatic.url).toBe(opened[0]);
    expect(automatic.browserUrl).not.toContain("bootstrap=");

    expect(
      await runCli(["browser", "browser-command-run", "--no-open"], {
        services,
        io,
        holdWeb: false,
        openBrowser: async (url) => {
          opened.push(url);
        },
      }),
    ).toBe(0);
    const manual = JSON.parse(output.pop() ?? "{}") as {
      url: string;
      opened: boolean;
    };
    expect(opened).toHaveLength(1);
    expect(manual.opened).toBe(false);
    expect(manual.url).toContain("/bootstrap/");
  });

  it("keeps CLI and HTTP command effects identical apart from actor channel", async () => {
    const cliServices = await createRun("parity-run");
    const webServices = await createRun("parity-run");
    const supervisor = await startWebSupervisor(webServices, { runId: "parity-run" });
    const browser = await browserSession(supervisor);
    const io = { stdout: () => undefined, stderr: () => undefined };

    try {
      await pair(
        cliServices,
        webServices,
        () =>
          runCli(["reject", "define", "--reason", "Clarify boundaries"], {
            services: cliServices,
            io,
          }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "reject",
            phaseId: "define",
            reason: "Clarify boundaries",
          }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["work", "resume"], { services: cliServices, io }),
        () => browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["approve", "define"], { services: cliServices, io }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "approve",
            phaseId: "define",
          }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["work", "resume"], { services: cliServices, io }),
        () => browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["approve", "research"], { services: cliServices, io }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "approve",
            phaseId: "research",
          }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["work", "resume"], { services: cliServices, io }),
        () => browser.command({ apiVersion: "senawa.dev/browser-command/v1", command: "resume" }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["approve", "plan"], { services: cliServices, io }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "approve",
            phaseId: "plan",
          }),
      );

      await cliServices.commands.advance("parity-run", driverActor);
      await webServices.commands.advance("parity-run", driverActor);
      await pair(
        cliServices,
        webServices,
        () =>
          runCli(["steer", "implement-change", "Preserve the graph boundary"], {
            services: cliServices,
            io,
          }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "steer",
            taskId: "implement-change",
            instruction: "Preserve the graph boundary",
          }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["work", "end", "--reason", "Parity complete"], { services: cliServices, io }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            command: "end",
            reason: "Parity complete",
          }),
      );
      expect(await cliServices.queries.activeRunId()).toBeNull();
      expect(await webServices.queries.activeRunId()).toBeNull();
    } finally {
      await supervisor.close();
    }
  });
});

async function createRun(runId: string): Promise<SenawaServices> {
  const root = await mkdtemp(join(tmpdir(), "senawa-parity-"));
  const services = createSenawaServices(root, { now: fixedNow });
  await services.commands.start({
    actor: driverActor,
    definitions,
    request: { goal: "Exercise adapter parity", constraints: [] },
    runId,
  });
  await services.commands.drive(runId, driverActor);
  return services;
}

async function copyRepositoryConfiguration(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "senawa-doctor-"));
  await cp(resolve(process.cwd(), ".senawa"), resolve(root, ".senawa"), { recursive: true });
  await cp(resolve(process.cwd(), ".agents"), resolve(root, ".agents"), { recursive: true });
  return root;
}

async function pair(
  cliServices: SenawaServices,
  webServices: SenawaServices,
  cliAction: () => Promise<unknown>,
  webAction: () => Promise<unknown>,
): Promise<void> {
  await cliAction();
  await webAction();
  expect(await webServices.queries.status("parity-run")).toEqual(
    await cliServices.queries.status("parity-run"),
  );
  expect(normalizeJournal(await webServices.queries.journal("parity-run"))).toEqual(
    normalizeJournal(await cliServices.queries.journal("parity-run")),
  );
}

function normalizeJournal(events: Awaited<ReturnType<SenawaServices["queries"]["journal"]>>) {
  const nondeterministicFields = new Set([
    "dispatchId",
    "durationMs",
    "operationId",
    "sessionId",
    "turnId",
  ]);
  return events.map(({ actor: _actor, ...event }) => ({
    ...event,
    data: Object.fromEntries(
      Object.entries(event.data).filter(([key]) => !nondeterministicFields.has(key)),
    ),
  }));
}

async function browserSession(supervisor: WebSupervisor) {
  const bootstrap = await fetch(supervisor.bootstrapUrl, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Bootstrap did not issue a session cookie");
  const origin = new URL(supervisor.url).origin;
  return {
    async command(command: BrowserRunCommand) {
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
