import type { WorkerProfile } from "@senawa/core";
import { describe, expect, it } from "vitest";
import {
  buildCopilotArguments,
  DeterministicWorkerHost,
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
  role: "definer",
  profile: definerProfile,
  profileDigest: "a".repeat(64),
  resolvedModel: definerProfile.spec.model,
  attempt: 1,
  sessionId: null,
  goal: "Prove repository profile controls",
  rejectionReason: null,
  steering: [],
  prompt: "Return the definition artifact",
};

describe("repository worker profiles", () => {
  it("fails closed when a turn carries a mismatched profile", async () => {
    await expect(
      new DeterministicWorkerHost().execute({ ...baseTurn, role: "repository-defined-role" }),
    ).rejects.toThrow("does not match profile");
  });

  it("builds subprocess prompts and controls from the resolved role", () => {
    const arguments_ = buildCopilotArguments(baseTurn, "session-role-test");

    expect(arguments_).toContain("test-model");
    expect(arguments_).toContain(`${definerProfile.prompt}\n\n${baseTurn.prompt}`);
    expect(arguments_).toContain("view");
    expect(arguments_).toContain("write");
    expect(arguments_).toContain("shell");
    expect(arguments_).not.toContain("shell(senawa:*)");
    expect(optionValue(arguments_, "--available-tools")).toBe("view,glob,grep,bash");
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
    const taskArguments = buildCopilotArguments(taskTurn, "session-implementor");
    const phasePolicy = resolveWorkerPolicy({
      ...taskTurn,
      owner: { kind: "phase", id: "define" },
    });

    expect(taskArguments).toContain("write");
    expect(taskArguments).toContain("shell(senawa:*)");
    expect(taskArguments).not.toContain("repository.edit");
    expect(optionValue(taskArguments, "--available-tools")).toBe(
      "view,glob,grep,edit,create,apply_patch,bash",
    );
    expect(phasePolicy.effectiveCapabilities).toEqual(["repository.read"]);
    expect(phasePolicy.copilot.denyTools).toEqual(["write", "shell"]);
    expect(phasePolicy.copilot.availableTools).toEqual(["view", "glob", "grep"]);
  });

  it("does not depend on repository hook or custom-agent files", () => {
    const arguments_ = buildCopilotArguments(baseTurn, "session-role-test");
    expect(arguments_.join(" ")).not.toMatch(/\.github\/(?:agents|hooks)/u);
    expect(arguments_).not.toContain("--hooks");
  });
});

function optionValue(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index < 0 ? undefined : arguments_[index + 1];
}
