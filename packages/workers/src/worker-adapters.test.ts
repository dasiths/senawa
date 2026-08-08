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

  it("enforces frozen and repository containment while task paths stay advisory", () => {
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
        { path: "packages/workers/src/link.ts", resolvedPath: "../outside/link.ts" },
      ]).allowed,
    ).toBe(false);
    // Task paths are advisory, so a write outside them is recorded rather than refused.
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "packages/domain/src/index.ts" }]),
    ).toEqual({ allowed: true });
  });

  it("permits glob-shaped read requests while keeping writes concrete", () => {
    const authorization = resolveWorkerAuthorization({
      ownerKind: "task",
      requestedCapabilities: profile.spec.tools,
      adapterCapabilities: profile.spec.tools,
      taskPaths: ["packages/workers/src"],
      frozenPaths: ["packages/workers/src/frozen/**"],
    });
    for (const path of [
      "**",
      "**/*.mjs",
      "experiments/**/*.mjs",
      "experiments/probes/*.mjs",
      "*.md",
      ".",
      "packages/workers/src/authorization.ts",
    ]) {
      expect(authorizeWorkerPaths(authorization, "read", [{ path }])).toEqual({ allowed: true });
    }
    for (const path of ["../outside/**", "/etc/**", "c:/windows/**", "..*/secrets", ".."]) {
      expect(authorizeWorkerPaths(authorization, "read", [{ path }])).toEqual({
        allowed: false,
        path,
        reason: "Path is not repository-relative",
      });
    }
    expect(
      authorizeWorkerPaths(authorization, "read", [
        { path: "packages/**", resolvedPath: "../outside/**" },
      ]),
    ).toEqual({
      allowed: false,
      path: "packages/**",
      reason: "Resolved path escapes the repository",
    });
  });

  it("refuses pattern-shaped writes without weakening containment", () => {
    const authorization = resolveWorkerAuthorization({
      ownerKind: "task",
      requestedCapabilities: profile.spec.tools,
      adapterCapabilities: profile.spec.tools,
      taskPaths: ["packages/workers/src"],
      frozenPaths: ["packages/workers/src/frozen/**"],
    });
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "packages/workers/src/*.ts" }]),
    ).toEqual({
      allowed: false,
      path: "packages/workers/src/*.ts",
      reason: "Write path must be a concrete repository-relative file",
    });
    expect(authorizeWorkerPaths(authorization, "write", [{ path: "..*/secrets.ts" }])).toEqual({
      allowed: false,
      path: "..*/secrets.ts",
      reason: "Path is not repository-relative",
    });
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "packages/workers/src/index.ts" }]),
    ).toEqual({ allowed: true });
    expect(
      authorizeWorkerPaths(authorization, "write", [
        { path: "packages/workers/src/frozen/data.ts" },
      ]).allowed,
    ).toBe(false);
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "packages/domain/src/index.ts" }])
        .allowed,
    ).toBe(true);
  });

  it("keeps policy scope normalization free of interior wildcards", () => {
    const authorizationInput = {
      ownerKind: "task" as const,
      requestedCapabilities: profile.spec.tools,
      adapterCapabilities: profile.spec.tools,
      frozenPaths: [],
    };
    expect(() =>
      resolveWorkerAuthorization({ ...authorizationInput, taskPaths: ["packages/*/src"] }),
    ).toThrow("Invalid repository-relative policy path");
    expect(() =>
      resolveWorkerAuthorization({ ...authorizationInput, taskPaths: ["packages/**/src"] }),
    ).toThrow("Invalid repository-relative policy path");
    expect(
      resolveWorkerAuthorization({ ...authorizationInput, taskPaths: ["packages/workers/**"] })
        .taskPaths,
    ).toContain("packages/workers/**");
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

  it("exposes the per-criterion completion contract on the task completion binding", () => {
    const authorization: WorkerAuthorization = {
      runId: turn.runId,
      owner: turn.owner,
      profileDigest: turn.profileDigest,
      semanticCapabilities: ["senawa.task.done"],
      readablePaths: [],
      writablePaths: ["packages/workers"],
      frozenPaths: [],
      allowedCommands: [],
    };
    const binding = new DeterministicWorkerBindingRegistry(
      recordingBindingHandlers([]),
    ).bindingsFor(turn, authorization)[0];

    expect(binding?.inputSchema).toMatchObject({
      required: ["summary"],
      additionalProperties: false,
      properties: {
        criteria: {
          type: "array",
          items: {
            required: ["id", "outcome", "summary"],
            properties: {
              outcome: { enum: ["satisfied", "blocked", "not-applicable"] },
              evidence: {
                items: {
                  properties: {
                    kind: { enum: ["file", "sensor", "command", "repository-delta"] },
                    relationship: {
                      enum: [
                        "created",
                        "modified",
                        "deleted",
                        "reviewed",
                        "validated",
                        "referenced",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });
});
