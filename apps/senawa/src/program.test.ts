import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebSupervisor, type WebSupervisor } from "@senawa/browser";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { BrowserRunCommand, CommandActor } from "@senawa/domain";
import { createFileTestComposition } from "@senawa/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { type CliRunOptions, runCli as runCliWithRuntime } from "./program.js";
import { createSenawaServices, type SenawaServices } from "./services.js";

const driverActor: CommandActor = { channel: "driver" };
const fixedNow = () => new Date("2026-08-04T12:00:00.000Z");
let definitions: Awaited<ReturnType<typeof loadRepositoryDefinitions>>;

function runCli(arguments_: readonly string[], options: CliRunOptions): Promise<number> {
  return runCliWithRuntime(["--runtime", "file", ...arguments_], options);
}

beforeAll(async () => {
  definitions = await loadRepositoryDefinitions(process.cwd());
});

describe("Commander CLI", () => {
  it("supports repository diagnostics and workflow inspection", async () => {
    const services = createTestServices(process.cwd());
    const output: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: () => undefined };

    expect(await runCli(["doctor"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      ok: true,
      workflows: ["standard-delivery"],
    });
    expect(await runCli(["--worker-host", "sdk", "doctor"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ ok: true });
    expect(await runCli(["workflow", "render", "standard-delivery"], { services, io })).toBe(0);
    expect(output.pop()).toContain("flowchart LR");
  });

  it("supports stable inspection and durable operator commands", async () => {
    const services = await createRun("operations-run");
    const repositoryServices = createTestServices(process.cwd());
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };

    expect(
      await runCli(["workflow", "validate", "standard-delivery"], {
        services: repositoryServices,
        io,
      }),
    ).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ ok: true });
    expect(await runCli(["sensor", "list"], { services: repositoryServices, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "[]").length).toBeGreaterThan(0);
    expect(
      await runCli(["sensor", "info", "artifact-present"], {
        services: repositoryServices,
        io,
      }),
    ).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ id: "artifact-present" });
    expect(await runCli(["task", "--help"], { services, io })).toBe(0);
    const taskHelp = output.pop() ?? "";
    expect(taskHelp).not.toContain("done");
    expect(taskHelp).not.toContain("abort");
    expect(await runCli(["phase", "show", "define"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ id: "define" });
    expect(await runCli(["phase", "artifact", "define"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      phaseId: "define",
      version: 1,
      content: expect.objectContaining({ summary: expect.any(String) }),
    });
    expect(
      await runCli(["gate", "check", "definition-accepted", "--phase", "define"], {
        services,
        io,
      }),
    ).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      gateId: "definition-accepted",
      accepted: true,
    });
    expect(await runCli(["sensor", "audit", "operations-run"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      runId: "operations-run",
      hookLatency: { samples: 0, status: "unreported" },
    });

    expect(await runCli(["ask", "Which boundary is authoritative?"], { services, io })).toBe(0);
    const question = JSON.parse(output.pop() ?? "{}") as { questionId?: string };
    expect(question.questionId).toMatch(/^question-/u);
    expect(
      await runCli(["answer", question.questionId ?? "", "The application boundary"], {
        services,
        io,
      }),
    ).toBe(0);
    expect(await runCli(["discover", "A follow-up validation"], { services, io })).toBe(0);
    expect(await runCli(["note", "Keep this decision durable"], { services, io })).toBe(0);

    const planPath = resolve(services.repositoryRoot, "extra-plan.json");
    await writeFile(
      planPath,
      JSON.stringify({
        summary: "Add one bounded task",
        tasks: [
          {
            key: "follow-up",
            title: "Run follow-up validation",
            dependsOn: [],
            paths: ["packages/application"],
            acceptance: ["Focused checks pass"],
            role: "implementor",
          },
        ],
      }),
    );
    expect(await runCli(["plan", "revise", "--add", planPath], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ added: ["follow-up"] });
    expect(await runCli(["task", "show", "follow-up"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ key: "follow-up" });
    expect(await runCli(["work", "pause"], { services, io })).toBe(0);
    expect(await services.queries.status("operations-run")).toMatchObject({
      backend: "file",
      status: "paused",
    });
    expect(errors).toEqual([]);
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
    const services = createTestServices(root);
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
  const services = createTestServices(root, fixedNow);
  await services.commands.start({
    actor: driverActor,
    definitions,
    request: { goal: "Exercise adapter parity", constraints: [] },
    runId,
  });
  await services.commands.drive(runId, driverActor);
  return services;
}

function createTestServices(root: string, now: () => Date = () => new Date()): SenawaServices {
  const composition = createFileTestComposition(root, now);
  return createSenawaServices(root, { ...composition, now });
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
