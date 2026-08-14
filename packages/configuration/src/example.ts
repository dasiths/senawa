import { canonicalValue } from "@senawa/kernel";
import type { WorkflowConfigurationDocument } from "./contracts.js";

export function createExampleWorkflowConfiguration(): WorkflowConfigurationDocument {
  return canonicalValue({
    apiVersion: "senawa.dev/workflow/v1alpha2",
    kind: "Workflow",
    execution: {
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    },
    workflow: {
      key: "example",
      generation: 1,
      input: { purpose: "Describe the work this workflow coordinates" },
    },
    schemas: [],
    roles: [
      {
        key: "worker",
        kind: "agent",
        capabilities: ["execute-work"],
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
    sensors: [],
    gates: [],
    phases: [
      {
        key: "work",
        generation: 1,
        dependsOn: [],
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
    ],
    projectedWork: [],
  }) as unknown as WorkflowConfigurationDocument;
}

export function renderExampleWorkflowConfiguration(): string {
  return `${JSON.stringify(createExampleWorkflowConfiguration(), null, 2)}\n`;
}
