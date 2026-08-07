import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  RepositoryEvidencePort,
  WorkerExecutionPort,
  WorkerModelCatalogEntry,
  WorkerModelCatalogPort,
  WorkerSessionPlan,
  WorkerSessionPort,
} from "@senawa/application";
import { startWebSupervisor, type WebSupervisor } from "@senawa/browser";
import { loadRepositoryDefinitions } from "@senawa/configuration";
import type { BrowserRunCommand, CommandActor } from "@senawa/domain";
import { createFileTestComposition } from "@senawa/testing";
import { SimulatedWorkerHost } from "@senawa/workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type CliRunOptions, runCli as runCliWithRuntime } from "./program.js";
import { createSenawaServices, type SenawaServices } from "./services.js";
import { LazyWorkerHostResolver } from "./worker-host-resolver.js";

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
  it("documents every registered leaf command", async () => {
    const services = createTestServices(process.cwd());
    const documentedPaths = new Set(
      [
        ...(await readFile(resolve(process.cwd(), "docs/reference/cli.md"), "utf8")).matchAll(
          /^## senawa (.+)$/gmu,
        ),
      ].map((match) => match[1]),
    );
    const registeredLeaves = await collectLeafCommandPaths(services);

    expect(registeredLeaves.filter((path) => !documentedPaths.has(path))).toEqual([]);
  });

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

  it("keeps SDK construction lazy for reads and bounds the explicit model catalog", async () => {
    const root = await copyRepositoryConfiguration();
    const composition = createFileTestComposition(root);
    let constructions = 0;
    const resolver = new LazyWorkerHostResolver({
      "copilot-sdk": () => {
        constructions += 1;
        return catalogWorkerHost();
      },
    });
    const services = createSenawaServices(root, {
      ...composition,
      workerHostResolver: resolver,
    });
    const output: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: () => undefined };

    expect(await runCli(["workflow", "list"], { services, io })).toBe(0);
    expect(constructions).toBe(0);
    expect(await runCli(["work", "show"], { services, io })).toBe(0);
    expect(constructions).toBe(0);
    expect(await runCli(["model", "list"], { services, io })).toBe(0);
    expect(constructions).toBe(1);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      count: 2,
      bounded: false,
      models: [{ id: "claude-opus-5" }, { id: "claude-sonnet-5" }],
    });
    expect(await runCli(["doctor", "--live"], { services, io })).toBe(0);
    expect(constructions).toBe(1);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      ok: true,
      live: {
        workerHost: { kind: "copilot-sdk" },
        profiles: expect.arrayContaining([
          {
            role: "implementor",
            requestedModel: {
              id: "claude-sonnet-5",
              effort: "high",
              effortMode: "preferred",
            },
            resolvedModel: {
              id: "claude-sonnet-5",
              effort: "medium",
              effortMode: "preferred",
            },
          },
        ]),
      },
    });
  });

  it("preflights exact role models and persists SDK as the new-work default", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-sdk-default-"));
    const composition = createFileTestComposition(root);
    const requested: Array<{ role: string; model: string; effort?: string; mode?: string }> = [];
    const host = catalogWorkerHost(requested);
    const services = createSenawaServices(root, {
      ...composition,
      workerHostResolver: new LazyWorkerHostResolver({ "copilot-sdk": () => host }),
    });

    await services.commands.start({
      actor: driverActor,
      definitions,
      request: { goal: "Validate live defaults", constraints: [] },
      runId: "sdk-default-run",
    });
    await services.commands.revisePlan(
      "sdk-default-run",
      {
        summary: "Use Opus for one exceptional implementation task",
        tasks: [
          {
            key: "high-risk-change",
            title: "Implement a high-risk change",
            dependsOn: [],
            paths: ["packages/application"],
            repositoryChange: "required",
            acceptance: ["Focused checks pass"],
            role: "implementor",
            execution: {
              model: "claude-opus-5",
              effort: "high",
              effortMode: "required",
            },
          },
        ],
      },
      driverActor,
    );

    expect(await services.queries.status("sdk-default-run")).toMatchObject({
      workerHost: { kind: "copilot-sdk", adapter: "copilot-sdk", adapterVersion: "1.0.7" },
    });
    expect(requested).toEqual([
      { role: "definer", model: "claude-opus-5" },
      { role: "implementor", model: "claude-sonnet-5", effort: "high", mode: "preferred" },
      { role: "planner", model: "claude-opus-5" },
      { role: "researcher", model: "claude-sonnet-5" },
      { role: "verifier", model: "claude-opus-5" },
      { role: "implementor", model: "claude-opus-5", effort: "high", mode: "required" },
    ]);
  });

  it("does not fall back to simulation after SDK readiness failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-sdk-failure-"));
    const composition = createFileTestComposition(root);
    let simulatedConstructions = 0;
    const failing = catalogWorkerHost();
    failing.negotiate = async () => {
      throw new Error("authentication unavailable");
    };
    const services = createSenawaServices(root, {
      ...composition,
      workerHostResolver: new LazyWorkerHostResolver({
        "copilot-sdk": () => failing,
        simulated: () => {
          simulatedConstructions += 1;
          return new SimulatedWorkerHost();
        },
      }),
    });

    await expect(
      services.commands.start({
        actor: driverActor,
        definitions,
        request: { goal: "Fail closed", constraints: [] },
        runId: "sdk-failure-run",
      }),
    ).rejects.toThrow("authentication unavailable");
    expect(simulatedConstructions).toBe(0);
    expect(await services.queries.status()).toBeNull();
  });

  it("refuses an explicit resume host that differs from persisted identity", async () => {
    const services = await createRun("resume-host-run");
    const errors: string[] = [];
    const io = { stdout: () => undefined, stderr: (value: string) => errors.push(value) };

    expect(await runCli(["--worker-host", "copilot-sdk", "work", "resume"], { services, io })).toBe(
      1,
    );
    expect(errors.join("\n")).toContain(
      "bound to worker host simulated; refusing explicit copilot-sdk",
    );
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
    expect(await runCli(["phase", "brief", "define"], { services, io })).toBe(0);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      phase: "define",
      status: "awaiting_approval",
      artifact: {
        path: "artifacts/define/v1.json",
        version: 1,
        digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        kind: "../schemas/definition.schema.json",
        createdAt: expect.any(String),
        declared: {
          summary: { value: expect.any(String), attribution: "artifact-declared" },
        },
        counts: expect.any(Array),
        fullArtifactCommand: "senawa phase artifact define --run operations-run --version 1",
      },
    });
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
      mutate: (source: string) => source.replaceAll("kind: deterministic", "kind: inferential"),
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

  it("records principal-agent caller attribution for relayed approval", async () => {
    const services = await createRun("principal-agent-run");
    const errors: string[] = [];
    const io = { stdout: () => undefined, stderr: (value: string) => errors.push(value) };
    const brief = await services.queries.phaseBrief("principal-agent-run", "define");
    if (brief.artifact === null) throw new Error("definition artifact is missing");

    expect(
      await runCli(
        ["approve", "define", "--expected-version", String(brief.artifact.version + 1)],
        { services, io },
      ),
    ).toBe(1);
    expect(errors.pop()).toContain("Stale decision for phase define");
    expect(
      await runCli(
        ["reject", "define", "--reason", "Stale digest", "--expected-digest", "0".repeat(64)],
        { services, io },
      ),
    ).toBe(1);
    expect(errors.pop()).toContain("Stale decision for phase define");

    expect(
      await runCli(
        [
          "--caller",
          "principal-agent",
          "approve",
          "define",
          "--expected-version",
          String(brief.artifact.version),
          "--expected-digest",
          brief.artifact.digest,
        ],
        { services, io },
      ),
    ).toBe(0);

    const approval = (await services.queries.journal("principal-agent-run")).find(
      (event) => event.event === "phase.approved",
    );
    expect(approval?.actor.channel).toBe("principal-agent");
    expect(errors).toEqual([]);
  });

  it("documents the ordered artifact-bound principal-agent decision protocol", async () => {
    const skill = await readFile(resolve(process.cwd(), ".agents/skills/senawa/SKILL.md"), "utf8");
    const show = skill.indexOf("Run `senawa work show`");
    const brief = skill.indexOf("run `senawa phase brief <phase>`");
    const identity = skill.indexOf("artifact path, version, digest");
    const complete = skill.indexOf("Present the complete artifact");
    const neutral = skill.indexOf("approve that exact artifact");
    const relay = skill.indexOf("Relay only the explicit human choice");
    const resume = skill.indexOf("Run `senawa work resume`");

    expect([show, brief, identity, complete, neutral, relay, resume]).toEqual(
      [...[show, brief, identity, complete, neutral, relay, resume]].toSorted(
        (left, right) => left - right,
      ),
    );
    expect(show).toBeGreaterThan(-1);
    expect(skill).toContain("reject it with a reason, or leave it pending");
    expect(skill).toContain("--caller principal-agent");
    expect(skill).toContain("--expected-version <version>");
    expect(skill).toContain("--expected-digest <digest>");
    expect(skill).toContain("It does not grant human authority");
    expect(skill).toContain("Never retry a failed live\nworker command through simulation");
  });

  it("keeps CLI and HTTP command effects identical apart from actor channel", async () => {
    const cliServices = await createRun("parity-run", simulatedChangeEvidence());
    const webServices = await createRun("parity-run", simulatedChangeEvidence());
    const supervisor = await startWebSupervisor(webServices, { runId: "parity-run" });
    const browser = await browserSession(supervisor);
    const io = { stdout: () => undefined, stderr: () => undefined };

    try {
      await pair(
        cliServices,
        webServices,
        async () => {
          await runCli(["reject", "define", "--reason", "Clarify boundaries"], {
            services: cliServices,
            io,
          });
          return runCli(["work", "resume"], { services: cliServices, io });
        },
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            commandId: randomUUID(),
            command: "reject",
            phaseId: "define",
            reason: "Clarify boundaries",
          }),
      );
      await pair(
        cliServices,
        webServices,
        async () => {
          await runCli(["approve", "define"], { services: cliServices, io });
          return runCli(["work", "resume"], { services: cliServices, io });
        },
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            commandId: randomUUID(),
            command: "approve",
            phaseId: "define",
          }),
      );
      await pair(
        cliServices,
        webServices,
        async () => {
          await runCli(["approve", "research"], { services: cliServices, io });
          return runCli(["work", "resume"], { services: cliServices, io });
        },
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            commandId: randomUUID(),
            command: "approve",
            phaseId: "research",
          }),
      );
      await pair(
        cliServices,
        webServices,
        async () => {
          await runCli(["approve", "plan"], { services: cliServices, io });
          return runCli(["work", "resume"], { services: cliServices, io });
        },
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            commandId: randomUUID(),
            command: "approve",
            phaseId: "plan",
          }),
      );
      await pair(
        cliServices,
        webServices,
        () => runCli(["work", "end", "--reason", "Parity complete"], { services: cliServices, io }),
        () =>
          browser.command({
            apiVersion: "senawa.dev/browser-command/v1",
            commandId: randomUUID(),
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

async function collectLeafCommandPaths(services: SenawaServices): Promise<string[]> {
  const leaves: string[] = [];

  async function visit(path: readonly string[]): Promise<void> {
    const output: string[] = [];
    const io = { stdout: (value: string) => output.push(value), stderr: () => undefined };
    expect(await runCli([...path, "--help"], { services, io })).toBe(0);
    const children = commandNames(output.join("\n"));
    if (children.length === 0) {
      leaves.push(path.join(" "));
      return;
    }
    await Promise.all(children.map((child) => visit([...path, child])));
  }

  await visit([]);
  return leaves.sort();
}

function commandNames(help: string): string[] {
  const commands = help.match(/(?:^|\n)Commands:\n((?: {2}.+\n?)*)/u)?.[1];
  if (commands === undefined) return [];
  return [...commands.matchAll(/^ {2}([^\s[]+).*$/gmu)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined && name !== "help");
}

async function createRun(
  runId: string,
  repositoryEvidence?: RepositoryEvidencePort,
): Promise<SenawaServices> {
  const root = await mkdtemp(join(tmpdir(), "senawa-parity-"));
  const services = createTestServices(root, fixedNow, repositoryEvidence);
  await services.commands.start({
    actor: driverActor,
    definitions,
    request: { goal: "Exercise adapter parity", constraints: [] },
    runId,
  });
  await services.commands.drive(runId, driverActor);
  return services;
}

function createTestServices(
  root: string,
  now: () => Date = () => new Date(),
  repositoryEvidence?: RepositoryEvidencePort,
): SenawaServices {
  const composition = createFileTestComposition(root, now);
  return createSenawaServices(root, {
    ...composition,
    repositoryEvidence: repositoryEvidence ?? composition.repositoryEvidence,
    now,
    workerHost: new SimulatedWorkerHost(),
    workerHostIdentity: {
      kind: "simulated",
      adapter: "simulated-worker",
      adapterVersion: "1",
      legacy: false,
    },
  });
}

function simulatedChangeEvidence(): RepositoryEvidencePort {
  return {
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
        head: "parity-head",
        entries: [],
        capturedAt: input.capturedAt,
        uncertainty: [],
        digest: "b".repeat(64),
        evidencePath: "evidence/repository/parity-baseline.json",
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
          { path: "packages/simulated-change.ts", status: " M", digest: "c".repeat(64) },
        ],
        inScopeChanges: ["packages/simulated-change.ts"],
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
        evidencePath: "evidence/repository/parity-delta.json",
      };
    },
  };
}

type CatalogWorkerHost = WorkerExecutionPort &
  WorkerModelCatalogPort &
  Pick<WorkerSessionPort, "describe" | "negotiate">;

function catalogWorkerHost(
  requested: Array<{ role: string; model: string; effort?: string; mode?: string }> = [],
): CatalogWorkerHost {
  const models: readonly WorkerModelCatalogEntry[] = [
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      supportedEfforts: ["low", "medium", "high"],
      defaultEffort: "medium",
    },
    {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      supportedEfforts: ["low", "medium"],
      defaultEffort: "medium",
    },
  ];
  return {
    async describe() {
      return {
        name: "copilot-sdk",
        version: "1.0.7",
        capabilities: [
          "repository.read",
          "repository.edit",
          "senawa.task.done",
          "senawa.phase.submit",
          "senawa.ask",
          "senawa.discover",
          "senawa.note",
        ],
        features: {
          callerChosenIdentity: true,
          resume: true,
          inspect: "session-only",
          replay: false,
          streaming: true,
          cancellation: true,
          nativeTypedTools: true,
          commandBridge: false,
          pathEnforcement: "policy",
          usageCheckpoints: true,
          permissionFeedback: true,
          modelDiscovery: true,
          traceInjection: true,
        },
      };
    },
    async listModels() {
      return models;
    },
    async negotiate(requirements): Promise<WorkerSessionPlan> {
      const role = Reflect.get(requirements, "role");
      if (typeof role === "string") {
        requested.push({
          role,
          model: requirements.requestedModel.id,
          ...(requirements.requestedModel.effort === undefined
            ? {}
            : { effort: requirements.requestedModel.effort }),
          ...(requirements.requestedModel.effortMode === undefined
            ? {}
            : { mode: requirements.requestedModel.effortMode }),
        });
      }
      const model = models.find((candidate) => candidate.id === requirements.requestedModel.id);
      if (model === undefined)
        throw new Error(`model is unavailable: ${requirements.requestedModel.id}`);
      const requestedEffort = requirements.requestedModel.effort;
      const effort =
        requestedEffort === undefined || model.supportedEfforts.includes(requestedEffort)
          ? requestedEffort
          : model.defaultEffort;
      const resolvedModel = {
        id: model.id,
        ...(effort === undefined ? {} : { effort: effort as "low" | "medium" | "high" | "xhigh" }),
        ...(requirements.requestedModel.effortMode === undefined
          ? {}
          : { effortMode: requirements.requestedModel.effortMode }),
      };
      return {
        adapter: await this.describe(),
        resolvedModel,
        grantedCapabilities: requirements.requiredCapabilities,
        toolTransport: "native",
        unsupportedPreferences: [],
      };
    },
    async execute() {
      throw new Error("Catalog test host does not execute turns");
    },
  };
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
    "commandId",
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
      const submitted = (await response.json()) as {
        receipt: { commandId: string; status: string; error?: { message: string } };
      };
      expect(response.status, JSON.stringify(submitted)).toBe(202);
      for (;;) {
        const receiptResponse = await fetch(
          `${origin}/api/v1/runs/${supervisor.runId}/commands/${submitted.receipt.commandId}`,
          { headers: { Cookie: cookie } },
        );
        const current = (await receiptResponse.json()) as typeof submitted;
        if (current.receipt.status === "completed") return current;
        if (current.receipt.status === "refused") {
          throw new Error(current.receipt.error?.message ?? "Browser command was refused");
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    },
  };
}
