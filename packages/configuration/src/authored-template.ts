const AUTHORED_AGENTS = `# One entry per agent. The model and the prompt are all
# an author supplies; senawa derives the rest.
planner:
  model: gpt-5
  prompt: prompts/planner.md

implementor:
  model: gpt-5
  prompt: prompts/implementor.md
`;

const AUTHORED_WORKFLOW = `name: delivery
input: schemas/request.schema.json

phases:
  - name: plan
    agent: planner
    output: schemas/plan.schema.json

  - name: implement
    agent: implementor
    needs: [plan]
    output: schemas/implementation.schema.json
    gates: [clean-tree]
`;

const AUTHORED_SENSORS = `# A blocking gate needs at least one deterministic
# reading, so every sensor here executes a real command.
sensors:
  clean-tree:
    # This exits non-zero when tracked files differ from the index, so the gate
    # actually refuses rather than agreeing with whoever submitted it. Replace
    # it with your build or test command; a sensor that always exits zero is a
    # gate that measures nothing.
    run: git diff --exit-code
    deterministic: true
`;

const PLANNER_PROMPT = `You are the planner.

Read the request and produce a plan.

Request: \${{ input.request }}

Return JSON matching the plan schema.
`;

const IMPLEMENTOR_PROMPT = `You are the implementor.

Carry out the plan and leave the working tree clean.

Plan: \${{ input.plan }}

Return JSON matching the implementation schema.
`;

function authoredSchema(id: string, body: Record<string, unknown>): string {
  return `${JSON.stringify(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:senawa:${id}`,
      ...body,
    },
    null,
    2,
  )}\n`;
}

/**
 * The three-document project a consumer starts from.
 *
 * `createStandardTemplateFiles` still emits the lowered internal document, which
 * is what the compiler consumes but not what a person should ever write. This is
 * the authored surface, and it is what `senawa init` publishes.
 */
export function createAuthoredTemplateFiles(): Readonly<Record<string, string>> {
  return Object.freeze({
    ".senawa/agents.yaml": AUTHORED_AGENTS,
    ".senawa/workflow.yaml": AUTHORED_WORKFLOW,
    ".senawa/sensors.yaml": AUTHORED_SENSORS,
    ".senawa/prompts/planner.md": PLANNER_PROMPT,
    ".senawa/prompts/implementor.md": IMPLEMENTOR_PROMPT,
    ".senawa/schemas/request.schema.json": authoredSchema("request", {
      type: "object",
      required: ["request"],
      properties: { request: { type: "string", minLength: 1, maxLength: 16_384 } },
      additionalProperties: false,
    }),
    ".senawa/schemas/plan.schema.json": authoredSchema("plan", {
      type: "object",
      required: ["plan"],
      properties: { plan: { type: "string", minLength: 1, maxLength: 65_536 } },
      additionalProperties: false,
    }),
    ".senawa/schemas/implementation.schema.json": authoredSchema("implementation", {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string", minLength: 1, maxLength: 65_536 } },
      additionalProperties: false,
    }),
  });
}
