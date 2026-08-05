import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["severity", "message"],
  properties: {
    severity: { enum: ["error", "warning", "info"] },
    message: { type: "string" },
  },
};

export const manifest = {
  apiVersion: "senawa.dev/sensor/v1",
  name: "command",
  version: "0.1.0",
  description: "Run one executable without invoking a shell.",
  kind: "deterministic",
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
    },
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cwd"],
    properties: { cwd: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
      summary: { type: "string" },
      findings: { type: "array", items: findingSchema },
    },
  },
};

export function create(config) {
  return {
    manifest,
    async run(input, context) {
      const [file, ...args] = config.command;
      try {
        execFileSync(file, args, {
          cwd: resolve(context.root, input.cwd),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { verdict: "pass", summary: `${file} exited successfully`, findings: [] };
      } catch (error) {
        const message = context.sanitize(`${error.stdout ?? ""}${error.stderr ?? ""}`);
        return {
          verdict: "fail",
          summary: `${file} exited with a non-zero status`,
          findings: [{ severity: "error", message: message.slice(0, 500) }],
        };
      }
    },
  };
}
