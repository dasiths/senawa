import type { WorkerProfile } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import {
  authorizeWorkerPaths,
  buildCopilotArguments,
  DeterministicWorkerHost,
  resolveWorkerAuthorization,
  resolveWorkerPolicy,
  type WorkerTurn,
} from "./worker-host.js";

const definerProfile: WorkerProfile = {
  apiVersion: "senawa.dev/worker-profile/v1",
  kind: "WorkerProfile",
  metadata: { name: "definer" },
  spec: {
    model: { id: "test-model", effort: "high" },
    tools: ["repository.read", "senawa.phase.submit"],
  },
  prompt: "Define the requested outcome.",
};

const baseTurn: WorkerTurn = {
  runId: "run-role-test",
  owner: { kind: "phase", id: "define" },
  operation: "create",
  turnId: "turn-role-test",
  dispatchId: "dispatch-role-test",
  operationId: "operation-role-test",
  traceId: "a".repeat(32),
  traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
  role: "definer",
  profile: definerProfile,
  profileDigest: "a".repeat(64),
  resolvedModel: definerProfile.spec.model,
  attempt: 1,
  sessionId: "session-role-test",
  goal: "Prove repository profile controls",
  rejectionReason: null,
  steering: [],
  prompt: "Return the definition artifact",
  authorization: {
    taskPaths: [],
    frozenPaths: [".senawa/sensors.yaml", ".senawa/agents/**"],
  },
};

describe("repository worker profiles", () => {
  it("fails closed when a turn carries a mismatched profile", async () => {
    await expect(
      new DeterministicWorkerHost().execute({ ...baseTurn, role: "repository-defined-role" }),
    ).rejects.toThrow("does not match profile");
  });

  it("builds subprocess prompts and controls from the resolved role", () => {
    const arguments_ = buildCopilotArguments(baseTurn);

    expect(arguments_).toContain("test-model");
    expect(arguments_).toContain(`${definerProfile.prompt}\n\n${baseTurn.prompt}`);
    expect(arguments_).toContain("view");
    expect(arguments_).toContain("write");
    expect(arguments_).toContain("shell");
    expect(arguments_).not.toContain("shell(senawa:*)");
    expect(optionValue(arguments_, "--available-tools")).toBe("view,glob,grep");
    expect(optionValue(arguments_, "--excluded-tools")).toBe(
      "task,list_agents,read_agent,write_agent",
    );
  });

  it("intersects requested capabilities with the Senawa host ceiling", () => {
    const profile: WorkerProfile = {
      ...definerProfile,
      metadata: { name: "implementor" },
      spec: {
        ...definerProfile.spec,
        tools: ["repository.read", "repository.edit", "process.run", "senawa.task.done"],
      },
    };
    const taskTurn = {
      ...baseTurn,
      owner: { kind: "task" as const, id: "implement" },
      role: "implementor",
      profile,
    };
    const taskArguments = buildCopilotArguments({
      ...taskTurn,
      sessionId: "session-implementor",
    });
    const phasePolicy = resolveWorkerPolicy({
      ...taskTurn,
      owner: { kind: "phase", id: "define" },
    });

    expect(optionValues(taskArguments, "--allow-tool")).not.toContain("write");
    expect(optionValues(taskArguments, "--allow-tool")).not.toContain("shell(senawa:*)");
    expect(taskArguments).not.toContain("repository.edit");
    expect(optionValue(taskArguments, "--available-tools")).toBe("view,glob,grep");
    expect(phasePolicy.effectiveCapabilities).toEqual(["repository.read"]);
    expect(phasePolicy.copilot.denyTools).toEqual(["write", "shell"]);
    expect(phasePolicy.copilot.availableTools).toEqual(["view", "glob", "grep"]);
  });

  it("does not depend on repository hook or custom-agent files", () => {
    const arguments_ = buildCopilotArguments(baseTurn);
    expect(arguments_.join(" ")).not.toMatch(/\.github\/(?:agents|hooks)/u);
    expect(arguments_).not.toContain("--hooks");
  });

  it("normalizes task scope and denies frozen, traversal, absolute, and symlink escapes", () => {
    const authorization = resolveWorkerAuthorization({
      ownerKind: "task",
      requestedCapabilities: ["repository.read", "repository.edit", "process.run"],
      adapterCapabilities: ["repository.read", "repository.edit", "process.run"],
      taskPaths: ["packages\\orchestrator/./src", "docs/design"],
      frozenPaths: ["packages/orchestrator/src/frozen/**", "docs/design/README.md"],
    });

    expect(authorization.taskPaths).toEqual(["docs/design", "packages/orchestrator/src"]);
    expect(authorization.frozenPaths).toContain(".senawa/agents/**");
    expect(
      authorizeWorkerPaths(authorization, "write", [
        { path: "packages/orchestrator/src/run-services.ts" },
        { path: "docs/design/01-system-model.md" },
      ]),
    ).toEqual({ allowed: true });
    expect(
      authorizeWorkerPaths(authorization, "write", [
        { path: "packages/orchestrator/src/run-services.ts" },
        { path: "packages/orchestrator/src/frozen/generated.ts" },
      ]),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        path: "packages/orchestrator/src/frozen/generated.ts",
      }),
    );
    expect(authorizeWorkerPaths(authorization, "write", [{ path: "../outside.ts" }]).allowed).toBe(
      false,
    );
    expect(
      authorizeWorkerPaths(authorization, "write", [{ path: "/tmp/outside.ts" }]).allowed,
    ).toBe(false);
    expect(
      authorizeWorkerPaths(authorization, "write", [
        {
          path: "packages/orchestrator/src/link.ts",
          resolvedPath: "../outside.ts",
        },
      ]).allowed,
    ).toBe(false);
  });

  it("withholds subprocess edit and shell capabilities without proven containment", () => {
    const profile: WorkerProfile = {
      ...definerProfile,
      metadata: { name: "implementor" },
      spec: {
        ...definerProfile.spec,
        tools: ["repository.read", "repository.edit", "process.run", "senawa.task.done"],
      },
    };
    const arguments_ = buildCopilotArguments({
      ...baseTurn,
      owner: { kind: "task", id: "implement" },
      role: "implementor",
      profile,
      authorization: {
        taskPaths: ["packages/orchestrator"],
        frozenPaths: ["packages/orchestrator/src/frozen/**"],
      },
    });

    expect(optionValue(arguments_, "--available-tools")).toBe("view,glob,grep");
    expect(optionValues(arguments_, "--allow-tool")).not.toContain("write");
    expect(optionValues(arguments_, "--allow-tool")).not.toContain("shell(senawa:*)");
    expect(optionValues(arguments_, "--deny-tool")).toEqual(
      expect.arrayContaining(["write", "shell"]),
    );
  });
});

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}

function optionValues(arguments_: readonly string[], name: string): string[] {
  return arguments_.flatMap((argument, index) =>
    argument === name && arguments_[index + 1] !== undefined
      ? [arguments_[index + 1] as string]
      : [],
  );
}
