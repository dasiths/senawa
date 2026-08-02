import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const manifest = {
  apiVersion: "senawa.dev/sensor/v1",
  name: "agent-review",
  version: "0.1.0",
  description: "Launch a reviewer with instructions and a rubric, accepting only a schema-valid tool submission.",
  kind: "inferential",
  configSchema: {
    type: "object",
    additionalProperties: false,
    required: ["instructions", "rubric", "subject"],
    properties: {
      instructions: { type: "string", minLength: 1 },
      rubric: { type: "string", minLength: 1 },
      subject: { type: "string", minLength: 1 },
    },
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["changedFiles"],
    properties: {
      changedFiles: { type: "array", items: { type: "string" } },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "findings", "data"],
    properties: {
      verdict: { enum: ["pass", "fail"] },
      summary: { type: "string", minLength: 1 },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["rule", "symbol", "severity", "message"],
          properties: {
            rule: { type: "integer", minimum: 1 },
            symbol: { type: "string" },
            severity: { enum: ["error", "warning", "info"] },
            message: { type: "string" },
          },
        },
      },
      data: {
        type: "object",
        additionalProperties: false,
        required: ["submissionAttempts"],
        properties: {
          submissionAttempts: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

export function create(config) {
  return {
    manifest,
    async run(input, context) {
      const rubric = readFileSync(resolve(context.root, config.rubric), "utf8");
      const subject = readFileSync(resolve(context.root, config.subject), "utf8");
      return context.agents.runStructured({
        instructions: config.instructions,
        prompt: `${rubric}\n\nChanged files: ${input.changedFiles.join(", ")}\n\n${subject}`,
        outputSchema: manifest.outputSchema,
        maxSubmissions: 2,
      });
    },
  };
}
