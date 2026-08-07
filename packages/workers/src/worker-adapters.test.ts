import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerAuthorization, WorkerBindingName, WorkerTurn } from "@senawa/application";
import type { JsonObject, WorkerProfile } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import { authorizeWorkerPaths, resolveWorkerAuthorization } from "./authorization.js";
import { DeterministicWorkerBindingRegistry, recordingBindingHandlers } from "./bindings.js";
import {
  buildCopilotArguments,
  DeterministicWorkerAdapter,
  RecordingWorkerAdapter,
  SimulatedWorkerAdapter,
  SubprocessWorkerAdapter,
} from "./worker-adapters.js";
import { runWorkerSessionConformance } from "./worker-conformance.test-support.js";

const profile: WorkerProfile = {
  apiVersion: "senawa.dev/worker-profile/v1",
  kind: "WorkerProfile",
  metadata: { name: "implementor" },
  spec: {
    model: { id: "test-model", effort: "high" },
    tools: ["repository.read", "repository.edit", "senawa.task.done", "senawa.note"],
  },
  prompt: "Implement the requested outcome.",
};
const turn: WorkerTurn = {
  runId: "run-worker",
  owner: { kind: "task", id: "task-one" },
  operation: "create",
  turnId: "turn-one",
  dispatchId: "dispatch-one",
  operationId: "operation-one",
  traceId: "a".repeat(32),
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  role: "implementor",
  profile,
  profileDigest: "a".repeat(64),
  resolvedModel: profile.spec.model,
  attempt: 1,
  sessionId: "session-one",
  goal: "Exercise worker lifecycle",
  rejectionReason: null,
  steering: [],
  prompt: "Complete the task",
  authorization: {
    taskPaths: ["packages/workers"],
    frozenPaths: ["packages/workers/frozen/**"],
  },
};

runWorkerSessionConformance(
  [
    { name: "simulated", createAdapter: () => new SimulatedWorkerAdapter() },
    {
      name: "fake subprocess",
      async createAdapter() {
        const root = await mkdtemp(join(tmpdir(), "senawa-worker-conformance-"));
        const executable = join(root, "fake-copilot.mjs");
        await writeFile(
          executable,
          '#!/usr/bin/env node\nprocess.stdout.write("completed fake subprocess");\n',
        );
        await chmod(executable, 0o755);
        return new SubprocessWorkerAdapter({
          enabled: true,
          repositoryRoot: root,
          isolationRoot: root,
          executable,
          timeoutMs: 1_000,
        });
      },
    },
  ],
  turn,
);

describe("worker adapter conformance", () => {
  it("streams subprocess stdout and stderr before returning the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-worker-stream-"));
    const executable = join(root, "stream-worker.mjs");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stdout.write("out");process.stderr.write("err");\n',
    );
    await chmod(executable, 0o755);
    const adapter = new SubprocessWorkerAdapter({
      enabled: true,
      repositoryRoot: root,
      isolationRoot: root,
      executable,
      timeoutMs: 1_000,
    });
    const events: Array<{ kind: string; stream?: string; text?: string }> = [];

    await adapter.execute(turn, async (event) => {
      events.push(event);
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", stream: "stdout", text: "out" }),
        expect.objectContaining({ kind: "text", stream: "stderr", text: "err" }),
      ]),
    );
  });

  it.each([
    ["simulated", () => new SimulatedWorkerAdapter()],
    ["recording", () => new RecordingWorkerAdapter()],
  ])(
    "supports create, resume, inspect, cancel, and release for %s",
    async (_name, createAdapter) => {
      const adapter = createAdapter();
      const first = await adapter.create(turn);
      expect((await first.result).sessionId).toBe(turn.sessionId);
      expect((await adapter.inspect(turn)).state).toBe("completed");

      const resumed = { ...turn, operation: "resume" as const, turnId: "turn-two" };
      const second = await adapter.resume(resumed);
      const events = [];
      for await (const event of second.events) events.push(event);
      expect(events.map((event) => event.kind)).toEqual([
        "lifecycle",
        "lifecycle",
        "model",
        "text",
        "text",
        "text",
        "diff",
        "usage",
        "lifecycle",
      ]);
      expect((await adapter.inspect(resumed)).state).toBe("completed");

      const pending = { ...turn, operation: "resume" as const, turnId: "turn-three" };
      expect(await adapter.cancel(pending, "operator request")).toMatchObject({
        cancelled: true,
      });
      expect((await adapter.inspect(pending)).state).toBe("cancelled");
      await adapter.release(turn.sessionId, "archive-delete");
      expect((await adapter.inspect({ ...turn, turnId: "unknown" })).state).toBe("missing");
    },
  );

  it("preserves the deprecated deterministic adapter constructor", () => {
    expect(new DeterministicWorkerAdapter()).toBeInstanceOf(SimulatedWorkerAdapter);
  });

  it("fails capability negotiation closed and reports absent typed transport", async () => {
    const adapter = new SubprocessWorkerAdapter({
      enabled: false,
      repositoryRoot: "/tmp",
      isolationRoot: "/tmp",
    });
    const plan = await adapter.negotiate({
      requiredCapabilities: ["repository.read"],
      preferredCapabilities: ["senawa.ask"],
      requireResume: true,
      requirePathEnforcement: false,
      requestedModel: profile.spec.model,
    });
    expect(plan.toolTransport).toBe("none");
    expect(plan.unsupportedPreferences).toEqual(["senawa.ask"]);
    await expect(
      adapter.negotiate({
        requiredCapabilities: ["repository.edit"],
        requireResume: true,
        requirePathEnforcement: true,
        requestedModel: profile.spec.model,
      }),
    ).rejects.toThrow("lacks required capabilities");
  });

  it("builds distinct create and resume arguments without live execution", () => {
    const createArguments = buildCopilotArguments(turn);
    const resumeArguments = buildCopilotArguments({
      ...turn,
      operation: "resume",
      turnId: "turn-two",
    });
    expect(createArguments).toContain("--session-id");
    expect(createArguments).not.toContain(`--resume=${turn.sessionId}`);
    expect(resumeArguments).toContain(`--resume=${turn.sessionId}`);
    expect(resumeArguments).not.toContain("--session-id");
    expect(resumeArguments).not.toContain("--model");
  });

  it("runs create and resume through a recording fake subprocess", async () => {
    const root = await mkdtemp(join(tmpdir(), "senawa-worker-"));
    const executable = join(root, "fake-copilot.mjs");
    const record = join(root, "arguments.jsonl");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write("completed fake subprocess");\n`,
    );
    await chmod(executable, 0o755);
    const adapter = new SubprocessWorkerAdapter({
      enabled: true,
      repositoryRoot: root,
      isolationRoot: root,
      executable,
      timeoutMs: 1_000,
    });

    await (await adapter.create(turn)).result;
    await (await adapter.resume({ ...turn, operation: "resume", turnId: "turn-two" })).result;

    const [createArguments, resumeArguments] = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(createArguments).toContain("--session-id");
    expect(createArguments).not.toContain(`--resume=${turn.sessionId}`);
    expect(resumeArguments).toContain(`--resume=${turn.sessionId}`);
    expect(resumeArguments).not.toContain("--model");
  });

  it("enforces normalized task and frozen path authorization", () => {
    const authorization = resolveWorkerAuthorization({
      ownerKind: "task",
      requestedCapabilities: profile.spec.tools,
      adapterCapabilities: profile.spec.tools,
      taskPaths: ["packages\\workers/./src"],
      frozenPaths: ["packages/workers/src/frozen/**"],
    });
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "packages/workers/src/index.ts" }]),
    ).toEqual({ allowed: true });
    expect(authorizeWorkerPaths(authorization, "write", [{ path: "../outside.ts" }]).allowed).toBe(
      false,
    );
    expect(authorizeWorkerPaths(authorization, "read", [{ path: "." }]).allowed).toBe(true);
    expect(
      authorizeWorkerPaths(authorization, "write", [
        { path: "packages/workers/src/frozen/data.ts" },
      ]).allowed,
    ).toBe(false);
    expect(
      authorizeWorkerPaths(authorization, "write", [
        { path: "packages/workers/src/link.ts", resolvedPath: "outside/link.ts" },
      ]).allowed,
    ).toBe(false);
  });

  it("binds authorized operations and rejects malformed or cross-owner calls", async () => {
    const calls: Array<{ readonly name: WorkerBindingName; readonly input: JsonObject }> = [];
    const authorization: WorkerAuthorization = {
      runId: turn.runId,
      owner: turn.owner,
      profileDigest: turn.profileDigest,
      semanticCapabilities: ["senawa.task.done", "senawa.note"],
      readablePaths: [],
      writablePaths: ["packages/workers"],
      frozenPaths: [],
      allowedCommands: [],
    };
    const registry = new DeterministicWorkerBindingRegistry(recordingBindingHandlers(calls));
    const bindings = registry.bindingsFor(turn, authorization);
    expect(bindings.map((binding) => binding.name)).toEqual(["senawa.task.done", "senawa.note"]);
    const context = {
      runId: turn.runId,
      owner: turn.owner,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      authorization,
    };
    expect(await bindings[0]?.handle({}, context)).toMatchObject({
      accepted: false,
      code: "invalid_input",
    });
    expect(
      await bindings[0]?.handle({ summary: "done" }, { ...context, runId: "other" }),
    ).toMatchObject({ accepted: false, code: "owner_mismatch" });
    expect(await bindings[0]?.handle({ summary: "done" }, context)).toMatchObject({
      accepted: true,
    });
    expect(calls).toHaveLength(1);
  });
});
