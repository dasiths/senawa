import { canonicalValue } from "@senawa/kernel";
import type { WorkflowConfigurationDocument } from "./contracts.js";

export const STANDARD_TEMPLATE_DIRECTORY = ".senawa";
export const STANDARD_TEMPLATE_WORKFLOW_PATH = ".senawa/workflow.json";

const agentBudgets = Object.freeze([
  { unit: "work-attempt", limit: 3 },
  { unit: "dispatch-failure", limit: 2 },
  { unit: "sensor-retry", limit: 2 },
  { unit: "review-iteration", limit: 2 },
  { unit: "integration-attempt", limit: 2 },
  { unit: "rebase-attempt", limit: 2 },
]);

const taskShape = {
  type: "object",
  required: ["dependsOn", "id", "instruction", "title"],
  properties: {
    dependsOn: {
      type: "array",
      maxItems: 32,
      items: { type: "string", minLength: 1, maxLength: 256 },
      uniqueItems: true,
    },
    id: { type: "string", minLength: 1, maxLength: 256 },
    instruction: { type: "string", minLength: 1, maxLength: 16_384 },
    title: { type: "string", minLength: 1, maxLength: 512 },
  },
  additionalProperties: false,
};

export function createStandardWorkflowConfiguration(): WorkflowConfigurationDocument {
  return canonicalValue({
    apiVersion: "senawa.dev/workflow/v1alpha3",
    kind: "Workflow",
    execution: {
      workspaceMode: "repository",
      maxWriterConcurrency: 1,
      failurePolicy: "continue",
    },
    workflow: {
      key: "standard-delivery",
      generation: 1,
      input: { schema: "workflow-input" },
    },
    prompts: [
      { key: "definer", path: "prompts/definer.md", inputPaths: ["/request"] },
      {
        key: "implementor",
        path: "prompts/implementor.md",
        inputPaths: ["/dependsOn", "/id", "/instruction", "/title"],
      },
      {
        key: "planner",
        path: "prompts/planner.md",
        inputPaths: ["/definition", "/research"],
      },
      { key: "researcher", path: "prompts/researcher.md", inputPaths: ["/definition"] },
      {
        key: "verifier",
        path: "prompts/verifier.md",
        inputPaths: ["/definition", "/implementationEvidence", "/research", "/tasks"],
      },
    ],
    schemas: [
      schemaDeclaration("definition-input"),
      schemaDeclaration("definition-output"),
      schemaDeclaration("implementation-task-input"),
      schemaDeclaration("plan-input"),
      schemaDeclaration("plan-output"),
      schemaDeclaration("plan-task-collection"),
      schemaDeclaration("plan-task-item"),
      schemaDeclaration("research-input"),
      schemaDeclaration("research-output"),
      schemaDeclaration("verification-input"),
      schemaDeclaration("verification-output"),
      schemaDeclaration("workflow-input"),
    ],
    roles: [
      agentRole("definer", "define-delivery"),
      agentRole("implementor", "implement-task"),
      agentRole("planner", "plan-delivery"),
      agentRole("researcher", "research-delivery"),
      agentRole("verifier", "verify-delivery"),
    ],
    modelPolicies: [
      {
        key: "standard",
        routes: [
          {
            provider: "openai",
            model: "gpt-5",
            maxTurns: 12,
            maxSubmissions: 4,
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
      gate("define-valid", "define"),
      gate("implement-valid", "implement"),
      gate("plan-valid", "plan"),
      gate("research-valid", "research"),
      gate("verification-valid", "verify"),
    ],
    implementationEvidenceViews: [
      {
        key: "accepted-implementation",
        phase: "implement",
        evidenceKinds: ["task-completion"],
        sensitivityCeiling: "internal",
      },
    ],
    forEach: [
      {
        key: "plan-tasks",
        source: { kind: "phase-output", phase: "plan", output: "plan" },
        pointer: "/tasks",
        collectionSchema: "plan-task-collection",
        itemSchema: "plan-task-item",
        identityPointer: "/id",
        limits: {
          maxSelectedItems: 64,
          maxTotalTasks: 256,
          maxConcurrency: 1,
          exhaustion: "escalate",
        },
      },
    ],
    taskTemplates: [
      {
        key: "implementation",
        generation: 1,
        role: "implementor",
        budgets: agentBudgets,
        inputSchema: "implementation-task-input",
        inputMappings: [
          {
            key: "plan-item",
            source: { kind: "current-item", pointer: "" },
            destinationPointer: "",
          },
        ],
        dependencyIdentityPointer: "/dependsOn",
        repositoryChanges: "required",
        completionPolicy: completionPolicy("implemented", "task"),
      },
    ],
    phases: [
      agentPhase({
        key: "define",
        role: "definer",
        inputSchema: "definition-input",
        mappings: [mapping("request", { kind: "workflow-input", pointer: "/request" }, "/request")],
        outputs: [output("definition", "definition-output", "outputs/definition.json", 65_536)],
        gate: "define-valid",
      }),
      agentPhase({
        key: "research",
        role: "researcher",
        dependsOn: ["define"],
        inputSchema: "research-input",
        mappings: [
          mapping(
            "definition",
            { kind: "phase-output", phase: "define", output: "definition", pointer: "/definition" },
            "/definition",
          ),
        ],
        outputs: [output("research", "research-output", "outputs/research.json", 131_072)],
        gate: "research-valid",
      }),
      agentPhase({
        key: "plan",
        role: "planner",
        dependsOn: ["define", "research"],
        inputSchema: "plan-input",
        mappings: [
          mapping(
            "definition",
            { kind: "phase-output", phase: "define", output: "definition", pointer: "/definition" },
            "/definition",
          ),
          mapping(
            "research",
            { kind: "phase-output", phase: "research", output: "research", pointer: "/research" },
            "/research",
          ),
        ],
        outputs: [output("plan", "plan-output", "outputs/plan.json", 262_144)],
        gate: "plan-valid",
        actions: [{ kind: "import-plan", forEach: "plan-tasks" }],
      }),
      {
        key: "implement",
        generation: 1,
        dependsOn: ["plan"],
        input: {
          schema: "plan-output",
          mappings: [
            mapping(
              "plan",
              { kind: "phase-output", phase: "plan", output: "plan", pointer: "" },
              "",
            ),
          ],
        },
        executor: { kind: "task-frontier", forEach: "plan-tasks", template: "implementation" },
        outputs: [],
        iteration: {
          maximumAttempts: 1,
          onGateRejected: "fail",
          onApprovalRejected: "fail",
          onUpstreamChanged: "fail",
          onExhausted: "escalate",
        },
        exit: {
          requiredOutputs: [],
          gate: "implement-valid",
          approval: approval(),
        },
        actions: [],
      },
      agentPhase({
        key: "verify",
        role: "verifier",
        dependsOn: ["define", "implement", "plan", "research"],
        inputSchema: "verification-input",
        mappings: [
          mapping(
            "definition",
            { kind: "phase-output", phase: "define", output: "definition", pointer: "/definition" },
            "/definition",
          ),
          mapping(
            "implementation-evidence",
            {
              kind: "implementation-evidence",
              phase: "implement",
              view: "accepted-implementation",
              pointer: "",
            },
            "/implementationEvidence",
          ),
          mapping(
            "research",
            { kind: "phase-output", phase: "research", output: "research", pointer: "/research" },
            "/research",
          ),
          mapping(
            "tasks",
            { kind: "phase-output", phase: "plan", output: "plan", pointer: "/tasks" },
            "/tasks",
          ),
        ],
        outputs: [
          output("verification", "verification-output", "outputs/verification.json", 131_072),
        ],
        gate: "verification-valid",
      }),
    ],
  }) as unknown as WorkflowConfigurationDocument;
}

export function createStandardWorkflowResources(): Readonly<Record<string, string>> {
  const resources = {
    "prompts/definer.md": prompt(
      "Standard delivery definer prompt",
      "Produces a bounded delivery definition from the workflow request",
      "Define the requested delivery outcome, constraints, acceptance criteria, and non-goals. Publish only the declared definition output.\n\nRequest:\n\n${{ input.request }}",
    ),
    "prompts/implementor.md": prompt(
      "Standard delivery implementor prompt",
      "Implements one imported plan task",
      "Implement the assigned task in the repository and submit the required completion evidence. Do not claim authority for approval, plan import, or workflow closure.\n\nTask ID: ${{ input.id }}\n\nTitle: ${{ input.title }}\n\nInstruction:\n\n${{ input.instruction }}\n\nDependency IDs:\n\n${{ input.dependsOn }}",
    ),
    "prompts/planner.md": prompt(
      "Standard delivery planner prompt",
      "Produces a stable identity-based implementation plan",
      "Create an implementation plan whose tasks array contains stable string ids, concise titles, actionable instructions, and dependency IDs. Publish only the declared plan output.\n\nDefinition:\n\n${{ input.definition }}\n\nResearch:\n\n${{ input.research }}",
    ),
    "prompts/researcher.md": prompt(
      "Standard delivery researcher prompt",
      "Researches the accepted delivery definition",
      "Research the accepted definition. Identify repository evidence, constraints, risks, and unresolved questions. Publish only the declared research output.\n\nDefinition:\n\n${{ input.definition }}",
    ),
    "prompts/verifier.md": prompt(
      "Standard delivery verifier prompt",
      "Verifies accepted outputs and implementation evidence",
      "Verify the implementation against the accepted definition, research, plan, and implementation evidence. Publish only the declared verification output.\n\nDefinition:\n\n${{ input.definition }}\n\nResearch:\n\n${{ input.research }}\n\nPlanned tasks:\n\n${{ input.tasks }}\n\nImplementation evidence:\n\n${{ input.implementationEvidence }}",
    ),
    "schemas/definition-input.schema.json": schemaText(
      "definition-input",
      stringObject("request", 16_384),
    ),
    "schemas/definition-output.schema.json": schemaText(
      "definition-output",
      stringObject("definition", 32_768),
    ),
    "schemas/implementation-task-input.schema.json": schemaText(
      "implementation-task-input",
      taskShape,
    ),
    "schemas/plan-input.schema.json": schemaText("plan-input", {
      type: "object",
      required: ["definition", "research"],
      properties: {
        definition: { type: "string", minLength: 1, maxLength: 32_768 },
        research: { type: "string", minLength: 1, maxLength: 65_536 },
      },
      additionalProperties: false,
    }),
    "schemas/plan-output.schema.json": schemaText("plan-output", {
      type: "object",
      required: ["tasks"],
      properties: { tasks: { type: "array", minItems: 1, maxItems: 64, items: taskShape } },
      additionalProperties: false,
    }),
    "schemas/plan-task-collection.schema.json": schemaText("plan-task-collection", {
      type: "array",
      minItems: 1,
      maxItems: 64,
      items: taskShape,
    }),
    "schemas/plan-task-item.schema.json": schemaText("plan-task-item", taskShape),
    "schemas/research-input.schema.json": schemaText(
      "research-input",
      stringObject("definition", 32_768),
    ),
    "schemas/research-output.schema.json": schemaText(
      "research-output",
      stringObject("research", 65_536),
    ),
    "schemas/verification-input.schema.json": schemaText("verification-input", {
      type: "object",
      required: ["definition", "implementationEvidence", "research", "tasks"],
      properties: {
        definition: { type: "string", minLength: 1, maxLength: 32_768 },
        implementationEvidence: {},
        research: { type: "string", minLength: 1, maxLength: 65_536 },
        tasks: { type: "array", minItems: 1, maxItems: 64 },
      },
      additionalProperties: false,
    }),
    "schemas/verification-output.schema.json": schemaText("verification-output", {
      type: "object",
      required: ["summary", "verified"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 65_536 },
        verified: { type: "boolean" },
      },
      additionalProperties: false,
    }),
    "schemas/workflow-input.schema.json": schemaText(
      "workflow-input",
      stringObject("request", 16_384),
    ),
  };
  return canonicalValue(resources) as unknown as Readonly<Record<string, string>>;
}

export function createStandardTemplateFiles(): Readonly<Record<string, string>> {
  return Object.freeze({
    [STANDARD_TEMPLATE_WORKFLOW_PATH]: `${JSON.stringify(createStandardWorkflowConfiguration(), null, 2)}\n`,
    ...Object.fromEntries(
      Object.entries(createStandardWorkflowResources()).map(([path, content]) => [
        `${STANDARD_TEMPLATE_DIRECTORY}/${path}`,
        content,
      ]),
    ),
  });
}

function schemaDeclaration(key: string) {
  return { key, path: `schemas/${key}.schema.json` };
}

function agentRole(key: string, capability: string) {
  return { key, kind: "agent", capabilities: [capability], prompt: key, modelPolicy: "standard" };
}

function gate(key: string, phase: string) {
  return {
    key,
    phase,
    blocking: [
      {
        key: "clean-diff",
        condition: {
          operator: "equals",
          accessor: { sensorKey: "diff-check", pointer: "/exitCode" },
          expected: 0,
        },
      },
    ],
    advisory: [],
  };
}

function mapping(key: string, source: object, destinationPointer: string) {
  return { key, source, destinationPointer };
}

function output(key: string, schema: string, path: string, maxBytes: number) {
  return { key, schema, path, maxBytes, sensitivity: "internal" };
}

function completionPolicy(key: string, evidenceMode: "none" | "task") {
  return {
    criteria: [{ key, generation: 1, required: true, input: null }],
    evidencePolicy:
      evidenceMode === "none"
        ? { mode: "none", requirements: [] }
        : { mode: "task", requirements: [{ kind: "task-completion", minimumCount: 1 }] },
  };
}

function approval() {
  return { policy: "required", authority: { role: "release-manager" } };
}

function agentPhase(input: {
  readonly key: string;
  readonly role: string;
  readonly dependsOn?: readonly string[];
  readonly inputSchema: string;
  readonly mappings: readonly object[];
  readonly outputs: readonly object[];
  readonly gate: string;
  readonly actions?: readonly object[];
}) {
  return {
    key: input.key,
    generation: 1,
    dependsOn: input.dependsOn ?? [],
    input: { schema: input.inputSchema, mappings: input.mappings },
    executor: {
      kind: "agent",
      role: input.role,
      budgets: agentBudgets,
      completionPolicy: completionPolicy(`${input.key}-produced`, "none"),
      resumeAcrossAttempts: true,
    },
    outputs: input.outputs,
    iteration: {
      maximumAttempts: 2,
      onGateRejected: "iterate",
      onApprovalRejected: "iterate",
      ...(input.dependsOn === undefined || input.dependsOn.length === 0
        ? {}
        : { onUpstreamChanged: "iterate" }),
      onExhausted: "escalate",
    },
    exit: {
      requiredOutputs: input.outputs.map((candidate) => (candidate as { key: string }).key),
      gate: input.gate,
      approval: approval(),
    },
    actions: input.actions ?? [],
  };
}

function prompt(title: string, description: string, body: string): string {
  return `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`;
}

function stringObject(property: string, maxLength: number) {
  return {
    type: "object",
    required: [property],
    properties: { [property]: { type: "string", minLength: 1, maxLength } },
    additionalProperties: false,
  };
}

function schemaText(key: string, schema: object): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:senawa:standard-delivery:${key}`,
      ...schema,
    },
    null,
    2,
  )}\n`;
}
