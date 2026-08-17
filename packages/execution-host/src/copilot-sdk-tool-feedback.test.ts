import { createRequire } from "node:module";
import { CopilotSession, defineTool } from "@github/copilot-sdk";
import { validateSchemaInstance } from "@senawa/configuration";
import { canonicalValue } from "@senawa/kernel";
import { describe, expect, it } from "vitest";
import type { CopilotSdkToolInvocation, CopilotSdkToolResult } from "./copilot-sdk-port.js";

// Phase 14G probe. It exercises the pinned SDK's real tool-result normalization
// offline: no client, no connection, no model, no credit.

const PINNED_SDK_VERSION = "1.0.9";

interface PendingToolCall {
  readonly requestId: string;
  readonly result?: unknown;
  readonly error?: string;
}

function probeSession(recorded: PendingToolCall[]): {
  execute(
    toolCallId: string,
    handler: (args: unknown, invocation: CopilotSdkToolInvocation) => unknown,
    args: unknown,
  ): Promise<void>;
} {
  // The SDK marks this constructor internal, so the probe reaches it through an exact cast.
  const SessionConstructor = CopilotSession as unknown as new (
    sessionId: string,
    connection: unknown,
    workspacePath: unknown,
    traceContextProvider: unknown,
    options: unknown,
  ) => object;
  const session = new SessionConstructor(
    "session_probe",
    undefined,
    undefined,
    undefined,
    undefined,
  );
  (session as unknown as { _rpc: unknown })._rpc = {
    tools: {
      handlePendingToolCall(call: PendingToolCall) {
        recorded.push(call);
        return Promise.resolve();
      },
      getCurrentMetadata() {
        throw new Error("The probe must not request tool metadata");
      },
    },
  };
  return {
    execute(toolCallId, handler, args) {
      return (
        session as unknown as {
          _executeToolAndRespond(
            requestId: string,
            toolName: string,
            toolCallId: string,
            args: unknown,
            handler: (args: unknown, invocation: CopilotSdkToolInvocation) => unknown,
          ): Promise<void>;
        }
      )._executeToolAndRespond(
        `request_${toolCallId}`,
        "senawa_complete",
        toolCallId,
        args,
        handler,
      );
    },
  };
}

const acceptedOutputSchema = canonicalValue({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://senawa.test/probe/verification-output",
  type: "object",
  additionalProperties: false,
  required: ["verified", "summary"],
  properties: {
    verified: { type: "boolean" },
    summary: { type: "string", minLength: 1, maxLength: 200 },
  },
});

function boundedFindings(instance: unknown): CopilotSdkToolResult {
  const findings = validateSchemaInstance(acceptedOutputSchema, instance);
  if (findings.length === 0) {
    return Object.freeze({
      resultType: "success",
      textResultForLlm: JSON.stringify({ status: "accepted" }),
    });
  }
  return Object.freeze({
    resultType: "failure",
    textResultForLlm: JSON.stringify({
      status: "rejected",
      code: "output-schema-invalid",
      findings: findings.slice(0, 8).map(({ pointer, schemaPointer, keyword }) => ({
        instancePointer: pointer,
        ...(schemaPointer === undefined ? {} : { schemaPointer }),
        ...(keyword === undefined ? {} : { keyword }),
      })),
    }),
  });
}

describe("Phase 14G Copilot SDK custom-tool feedback probe", () => {
  it("pins the probed SDK version", () => {
    const require = createRequire(import.meta.url);
    const manifest = require("../package.json") as {
      readonly peerDependencies: Readonly<Record<string, string>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    expect(manifest.peerDependencies["@github/copilot-sdk"]).toBe(PINNED_SDK_VERSION);
    expect(manifest.devDependencies["@github/copilot-sdk"]).toBe(PINNED_SDK_VERSION);
  });

  it("preserves raw JSON Schema parameters and the handler through defineTool", () => {
    const handler = () => ({ resultType: "success", textResultForLlm: "{}" });
    const tool = defineTool("senawa_complete", {
      description: "probe",
      parameters: acceptedOutputSchema as unknown as Record<string, unknown>,
      handler,
      skipPermission: true,
      defer: "never",
    });
    expect(tool.name).toBe("senawa_complete");
    expect(tool.parameters).toBe(acceptedOutputSchema);
    expect(tool.handler).toBe(handler);
    expect(tool.defer).toBe("never");
  });

  it("returns a structured failure result to the model verbatim", async () => {
    const recorded: PendingToolCall[] = [];
    await probeSession(recorded).execute(
      "call_1",
      () => boundedFindings({ verified: "yes" }),
      undefined,
    );
    const call = recorded.at(0);
    expect(call?.error).toBeUndefined();
    const result = call?.result as CopilotSdkToolResult;
    expect(result.resultType).toBe("failure");
    const payload = JSON.parse(result.textResultForLlm) as {
      readonly code: string;
      readonly findings: readonly { readonly instancePointer: string; readonly keyword?: string }[];
    };
    expect(payload.code).toBe("output-schema-invalid");
    expect(payload.findings.length).toBeGreaterThan(0);
    expect(payload.findings.some(({ instancePointer }) => instancePointer === "/verified")).toBe(
      true,
    );
    expect(result.textResultForLlm).not.toContain("json-schema.org");
    expect(result.textResultForLlm).not.toContain("additionalProperties");
  });

  it("accepts a corrected second call in the same session", async () => {
    const recorded: PendingToolCall[] = [];
    const session = probeSession(recorded);
    const handler = (args: unknown) => boundedFindings(args);
    await session.execute("call_1", handler, { verified: "yes" });
    await session.execute("call_2", handler, { verified: true, summary: "Both tasks completed" });
    expect(recorded.map(({ result }) => (result as CopilotSdkToolResult).resultType)).toEqual([
      "failure",
      "success",
    ]);
    expect(recorded.map(({ requestId }) => requestId)).toEqual([
      "request_call_1",
      "request_call_2",
    ]);
    expect(recorded.every(({ error }) => error === undefined)).toBe(true);
  });

  it("loses structure when a handler throws instead of returning a result", async () => {
    const recorded: PendingToolCall[] = [];
    await probeSession(recorded).execute(
      "call_1",
      () => {
        throw new Error("handler exploded");
      },
      undefined,
    );
    expect(recorded.at(0)?.result).toBeUndefined();
    expect(recorded.at(0)?.error).toBe("handler exploded");
  });

  it("classifies a result object without textResultForLlm as success", async () => {
    const recorded: PendingToolCall[] = [];
    await probeSession(recorded).execute("call_1", () => ({ status: "failed" }), undefined);
    expect(recorded.at(0)?.result).toBe('{"status":"failed"}');
  });
});
