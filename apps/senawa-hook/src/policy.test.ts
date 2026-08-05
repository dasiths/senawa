import { describe, expect, it } from "vitest";
import { createEmbeddedSessionPolicy, decideHook } from "./policy.js";

describe("senawa-hook policy", () => {
  it("denies dangerous shell commands without granting safe commands", () => {
    expect(
      decideHook("pre-tool", { toolName: "bash", toolArgs: { command: "git commit -m test" } }),
    ).toMatchObject({ permissionDecision: "deny" });
    expect(
      decideHook("pre-tool", { toolName: "bash", toolArgs: { command: "pnpm test" } }),
    ).toEqual({});
  });

  it("denies frozen writes with the permission-request response shape", () => {
    expect(
      decideHook("permission", {
        toolName: "apply_patch",
        toolArgs: { filePath: ".senawa/workflows/standard-delivery.yaml" },
      }),
    ).toEqual({
      behavior: "deny",
      message:
        "senawa refused this: .senawa/workflows/standard-delivery.yaml is a frozen policy or validation path",
      interrupt: true,
    });
    expect(
      decideHook("permission", {
        toolName: "write",
        toolArgs: { filePath: ".senawa/agents/implementor.senawa.md" },
      }),
    ).toMatchObject({ behavior: "deny" });
  });

  it("returns no allow decision after edits", () => {
    expect(decideHook("post-edit", {})).toEqual({});
  });

  it("provides future SDK callbacks that return only denial or no decision", () => {
    const policy = createEmbeddedSessionPolicy();
    const responses = [
      policy.preToolUse({ toolName: "bash", toolArgs: { command: "pnpm test" } }),
      policy.preToolUse({ toolName: "bash", toolArgs: { command: "git push" } }),
      policy.permissionRequest({
        toolName: "write",
        toolArgs: { filePath: ".senawa/sensors.yaml" },
      }),
      policy.postToolUse({
        toolName: "write",
        toolArgs: { filePath: "packages/core/src/index.ts" },
      }),
    ];

    expect(responses).toContainEqual({});
    expect(responses.some((response) => JSON.stringify(response).includes("allow"))).toBe(false);
    expect(responses.filter((response) => Object.keys(response).length > 0)).toEqual([
      {
        permissionDecision: "deny",
        permissionDecisionReason:
          "senawa refused this: repository history and remote publication require an explicit human action",
      },
      {
        behavior: "deny",
        message: "senawa refused this: .senawa/sensors.yaml is a frozen policy or validation path",
        interrupt: true,
      },
    ]);
  });
});
