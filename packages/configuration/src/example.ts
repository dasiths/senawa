import { canonicalValue } from "@senawa/kernel";
import type { WorkflowConfigurationDocument } from "./contracts.js";

export function createExampleWorkflowConfiguration(): WorkflowConfigurationDocument {
  return canonicalValue({
    apiVersion: "senawa.dev/workflow/v1",
    kind: "Workflow",
    execution: {
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    },
    workflow: {
      key: "example",
      generation: 1,
      input: { schema: "work-input" },
    },
    prompts: [
      {
        key: "worker",
        path: "prompts/worker.md",
        inputPaths: ["/instruction"],
      },
    ],
    schemas: [{ key: "work-input", path: "schemas/work-input.schema.json" }],
    roles: [
      {
        key: "worker",
        kind: "agent",
        capabilities: ["execute-work"],
        prompt: "worker",
        modelPolicy: "default",
      },
    ],
    modelPolicies: [
      {
        key: "default",
        routes: [
          {
            provider: "openai",
            model: "gpt-5",
            maxTurns: 8,
            maxSubmissions: 3,
            maxMillidollars: 5_000,
          },
        ],
      },
    ],
    sensors: [
      {
        key: "diff-check",
        argv: ["git", "diff", "--check"],
        cwd: ".",
        timeoutMs: 30_000,
        maxStdoutBytes: 65_536,
        maxStderrBytes: 65_536,
        inheritedEnvironment: ["PATH"],
        maxAttempts: 3,
        maxReconciliationAttempts: 2,
      },
    ],
    gates: [
      {
        key: "clean-diff",
        phase: "work",
        blocking: [
          {
            key: "exit-code-zero",
            condition: {
              operator: "equals",
              accessor: { sensorKey: "diff-check", pointer: "/exitCode" },
              expected: 0,
            },
          },
        ],
        advisory: [],
      },
    ],
    implementationEvidenceViews: [],
    forEach: [],
    taskTemplates: [],
    phases: [
      {
        key: "work",
        generation: 1,
        dependsOn: [],
        input: {
          schema: "work-input",
          mappings: [
            {
              key: "workflow-input",
              source: { kind: "workflow-input", pointer: "" },
              destinationPointer: "",
            },
          ],
        },
        executor: {
          kind: "task-set",
          work: [
            {
              key: "first-task",
              generation: 1,
              role: "worker",
              budgets: [
                { unit: "work-attempt", limit: 3 },
                { unit: "dispatch-failure", limit: 2 },
                { unit: "sensor-retry", limit: 2 },
                { unit: "review-iteration", limit: 3 },
                { unit: "integration-attempt", limit: 2 },
                { unit: "rebase-attempt", limit: 2 },
              ],
              dependsOn: [],
              inputSchema: "work-input",
              input: { instruction: "Replace this example task with your work" },
              completionPolicy: {
                criteria: [
                  {
                    key: "completed",
                    generation: 1,
                    required: true,
                    input: null,
                  },
                ],
                evidencePolicy: { mode: "none", requirements: [] },
              },
            },
          ],
        },
        outputs: [],
        iteration: {
          maximumAttempts: 1,
          onGateRejected: "fail",
          onApprovalRejected: "fail",
          onExhausted: "fail",
        },
        exit: {
          requiredOutputs: [],
          gate: "clean-diff",
          approval: { policy: "none" },
        },
        actions: [],
      },
    ],
  }) as unknown as WorkflowConfigurationDocument;
}

export function createExampleWorkflowResources(): Readonly<Record<string, string>> {
  return canonicalValue({
    "prompts/worker.md": "Complete the assigned instruction: ${{ input.instruction }}\n",
    "schemas/work-input.schema.json": JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:senawa:example-work-input",
      type: "object",
      required: ["instruction"],
      properties: { instruction: { type: "string" } },
      additionalProperties: false,
    }),
  }) as unknown as Readonly<Record<string, string>>;
}

export function renderExampleWorkflowConfiguration(): string {
  return `${JSON.stringify(createExampleWorkflowConfiguration(), null, 2)}\n`;
}
