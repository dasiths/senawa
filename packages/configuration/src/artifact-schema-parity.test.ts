import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DefinitionArtifactSchema,
  PlanArtifactSchema,
  ResearchArtifactSchema,
  VerificationArtifactSchema,
} from "@senawa/domain";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface Fixture {
  readonly name: string;
  readonly valid: boolean;
  readonly value: unknown;
}

async function compile(schemaName: string) {
  const ajv = new Ajv2020.default({ allErrors: true, strict: true });
  addFormats.default(ajv);
  const source = await readFile(
    resolve(repositoryRoot, ".senawa/schemas", `${schemaName}.schema.json`),
    "utf8",
  );
  return ajv.compile(JSON.parse(source) as object);
}

const minimalDefinition = {
  summary: "Minimal definition",
  inScope: ["packages/domain"],
  outOfScope: [],
  acceptanceCriteria: [{ description: "The behavior is implemented" }],
  constraints: [{ statement: "Keep the public surface stable" }],
  openQuestions: [{ question: "Which backend owns ordering?" }],
};

const richDefinition = {
  summary: "Rich definition",
  problemStatement: "Plans carry no phases, so the frontier cannot be ordered.",
  currentBehavior: "Tasks are claimed in array order.",
  desiredBehavior: "Tasks are claimed in phase order.",
  inScope: ["packages/domain", ".senawa/schemas"],
  outOfScope: ["packages/browser"],
  nonGoals: ["Lifting frontier concurrency above one"],
  acceptanceCriteria: [
    { description: "Older artifacts still validate" },
    {
      id: "ac-phase-order",
      description: "A later-phase task cannot be claimed first",
      required: true,
      measurement: "Frontier ordering test",
      verifiedBy: "deterministic-gate",
    },
  ],
  constraints: [
    { statement: "Every new field is optional" },
    {
      id: "frozen-schemas",
      statement: "Schemas are frozen",
      source: ".senawa/sensors.yaml",
      kind: "policy",
    },
  ],
  assumptions: [
    {
      id: "no-pinned-fingerprint",
      statement: "No test pins a literal fingerprint",
      confidence: "high",
    },
  ],
  stakeholders: [
    { name: "Driver", role: "owner", concern: "Verdict authority stays with the driver" },
  ],
  risks: [
    {
      id: "schema-divergence",
      description: "zod and JSON Schema drift apart",
      likelihood: "medium",
      impact: "high",
      mitigation: "Fixture-corpus parity test",
    },
  ],
  evidenceNeeded: [
    {
      id: "prompt-size",
      question: "How much does the prompt grow?",
      expectedEvidenceKind: "measured",
    },
  ],
  openQuestions: [
    { question: "Should phases become required?" },
    { id: "coverage-blocking", question: "Should coverage block on day one?", blocking: false },
  ],
};

const definitionFixtures: readonly Fixture[] = [
  { name: "minimal definition", valid: true, value: minimalDefinition },
  {
    name: "minimal definition",
    valid: true,
    value: { summary: "s", inScope: ["a"], acceptanceCriteria: [{ description: "b" }] },
  },
  { name: "rich definition", valid: true, value: richDefinition },
  {
    name: "unknown property",
    valid: false,
    value: { ...minimalDefinition, findings: ["not allowed here"] },
  },
  { name: "empty inScope", valid: false, value: { ...minimalDefinition, inScope: [] } },
  {
    name: "criterion without description",
    valid: false,
    value: { ...minimalDefinition, acceptanceCriteria: [{ id: "ac-x" }] },
  },
  {
    name: "criterion with unknown verifiedBy",
    valid: false,
    value: {
      ...minimalDefinition,
      acceptanceCriteria: [{ description: "d", verifiedBy: "vibes" }],
    },
  },
  {
    name: "risk without mitigation",
    valid: false,
    value: { ...minimalDefinition, risks: [{ description: "unmitigated" }] },
  },
  {
    name: "constraint object without statement",
    valid: false,
    value: { ...minimalDefinition, constraints: [{ source: "somewhere" }] },
  },
  {
    name: "stakeholder with unknown role",
    valid: false,
    value: { ...minimalDefinition, stakeholders: [{ name: "n", role: "bystander" }] },
  },
  {
    name: "mixed-case criterion id",
    valid: true,
    value: {
      ...minimalDefinition,
      acceptanceCriteria: [{ id: "AC.PhaseOrder", description: "Order holds" }],
      assumptions: [{ id: "A1", statement: "No pinned fingerprint" }],
    },
  },
  {
    name: "criterion id with a space",
    valid: false,
    value: {
      ...minimalDefinition,
      acceptanceCriteria: [{ id: "AC One", description: "Order holds" }],
    },
  },
];

const minimalResearch = {
  summary: "Minimal research",
  findings: [{ claim: "The adapter is durable", source: "probe", evidenceKind: "measured" }],
  constraints: [],
  recommendations: [{ statement: "Implement the bounded plan" }],
};

const richResearch = {
  summary: "Rich research",
  findings: [
    {
      id: "f-zod-only",
      claim: "Only the plan artifact is zod-validated in production",
      detail: "Definition, research, and verification are Ajv-only.",
      source: "packages/application/src/run-services.ts",
      evidenceKind: "measured",
      confidence: "high",
      limits: ["Does not cover the simulated adapter"],
      answers: ["q-enforcement"],
    },
  ],
  questions: [
    {
      id: "q-enforcement",
      question: "Where is each rule enforced?",
      status: "answered",
      answeredBy: ["f-zod-only"],
    },
  ],
  alternatives: [
    {
      id: "alt-selector",
      option: "Use executor.selector for phases",
      verdict: "rejected",
      rationale: "The workflow is frozen before the plan exists",
      tradeoffs: ["Would need workflow mutation"],
      evidence: ["f-zod-only"],
    },
  ],
  constraints: [
    {
      statement: "Ajv runs strict",
      source: "packages/configuration/src/definitions.ts",
      kind: "technical",
    },
  ],
  risks: [{ description: "Payload growth", mitigation: "Tight caps" }],
  unknowns: [
    {
      id: "u-live",
      question: "Will live planners populate phases?",
      nextResearch: "Live-model probe",
      blocking: false,
    },
  ],
  recommendations: [
    { statement: "Ship additively under v1" },
    {
      id: "r-derive",
      statement: "Derive dependency edges at import",
      basis: ["f-zod-only"],
      confidence: "high",
    },
  ],
};

const researchFixtures: readonly Fixture[] = [
  { name: "minimal research", valid: true, value: minimalResearch },
  { name: "rich research", valid: true, value: richResearch },
  { name: "empty findings", valid: false, value: { ...minimalResearch, findings: [] } },
  {
    name: "unknown evidence kind",
    valid: false,
    value: { summary: "s", findings: [{ claim: "c", source: "s", evidenceKind: "hearsay" }] },
  },
  {
    name: "question without status",
    valid: false,
    value: { ...minimalResearch, questions: [{ question: "why?" }] },
  },
  {
    name: "alternative without rationale",
    valid: false,
    value: { ...minimalResearch, alternatives: [{ option: "o", verdict: "rejected" }] },
  },
  {
    name: "recommendation object without statement",
    valid: false,
    value: { ...minimalResearch, recommendations: [{ basis: ["f-1"] }] },
  },
  {
    name: "non-identifier finding id",
    valid: false,
    value: {
      summary: "s",
      findings: [{ id: "Finding One", claim: "c", source: "s", evidenceKind: "offline" }],
    },
  },
  {
    name: "mixed-case research cross references",
    valid: true,
    value: {
      summary: "s",
      findings: [
        { id: "F-ZodOnly", claim: "c", source: "s", evidenceKind: "offline", answers: ["Q_1"] },
      ],
      questions: [{ id: "Q_1", question: "why?", status: "answered", answeredBy: ["F-ZodOnly"] }],
      alternatives: [
        {
          id: "Alt.Selector",
          option: "o",
          verdict: "rejected",
          rationale: "r",
          evidence: ["F-ZodOnly"],
        },
      ],
      recommendations: [
        { id: "R1", statement: "s", basis: ["F-ZodOnly"], alternativesRejected: ["Alt.Selector"] },
      ],
    },
  },
  {
    name: "recommendation basis with a slash",
    valid: false,
    value: {
      ...minimalResearch,
      recommendations: [{ statement: "s", basis: ["findings/1"] }],
    },
  },
];

const minimalPlan = {
  summary: "Minimal plan",
  tasks: [
    {
      key: "implement-change",
      title: "Implement the change",
      dependsOn: [],
      paths: ["packages/domain"],
      repositoryChange: "required",
      acceptance: [{ description: "The behavior is implemented" }],
      role: "implementor",
    },
  ],
};

const richPlan = {
  summary: "Rich plan",
  objectives: ["Order the frontier by plan phases"],
  contextSummary: "Phases order tasks without touching claimReadyTask.",
  phases: [
    {
      id: "schemas",
      title: "Richer artifact schemas",
      order: 1,
      intent: "Add optional structure to all four artifacts",
      parallelizable: false,
      dependsOn: [],
      todos: [
        { text: "Extend zod" },
        { id: "todo-json", text: "Extend JSON Schema", taskKey: "extend-schemas" },
      ],
      exitCriteria: ["Older artifacts still validate"],
      validation: [{ command: "pnpm typecheck", expect: "exit 0", blocking: true }],
    },
    {
      id: "frontier",
      title: "Order the frontier",
      order: 2,
      parallelizable: false,
      dependsOn: ["schemas"],
      todos: [{ text: "Expand dependsOn at import" }],
    },
  ],
  decisions: [
    {
      id: "derive-edges",
      decision: "Derive dependency edges at import",
      rationale: "Both persistence backends already honor dependsOn",
      status: "accepted",
      evidence: ["packages/runtime-file/src/file-run-persistence.ts"],
      alternativesRejected: [
        { option: "Teach claimReadyTask about phases", reason: "Duplicates logic in two backends" },
      ],
    },
  ],
  dependencies: [{ description: "Frozen snapshot schemas", kind: "artifact", blocking: true }],
  risks: [
    { description: "Dependency fan-in", mitigation: "Cap expansion and record the collapse" },
  ],
  successCriteria: [
    { description: "Older plans behave exactly as before" },
    { id: "sc-order", description: "Phase order is respected", satisfies: ["ac-phase-order"] },
  ],
  validation: [{ id: "tests", command: "pnpm test" }],
  openQuestions: [{ question: "Should phases become required?", blocking: false }],
  tasks: [
    {
      key: "extend-schemas",
      title: "Extend the artifact schemas",
      dependsOn: [],
      paths: ["packages/domain"],
      repositoryChange: "required",
      acceptance: [
        {
          id: "ac-optional",
          description: "Every new field is optional",
          satisfies: ["ac-phase-order"],
        },
      ],
      role: "implementor",
      phase: "schemas",
      order: 1,
      rationale: "Shapes must exist before the importer can use them",
    },
    {
      key: "expand-dependencies",
      title: "Expand task dependencies at import",
      dependsOn: [],
      paths: ["packages/application"],
      acceptance: [{ description: "Phase order reaches the frontier" }],
      role: "implementor",
      phase: "frontier",
      order: 1,
    },
  ],
};

const planFixtures: readonly Fixture[] = [
  { name: "minimal plan", valid: true, value: minimalPlan },
  { name: "rich phased plan", valid: true, value: richPlan },
  { name: "empty tasks", valid: false, value: { ...minimalPlan, tasks: [] } },
  {
    name: "phase without title",
    valid: false,
    value: { ...minimalPlan, phases: [{ id: "only-id" }] },
  },
  {
    name: "phase order out of range",
    valid: false,
    value: { ...minimalPlan, phases: [{ id: "p", title: "P", order: 0 }] },
  },
  {
    name: "todo object without text",
    valid: false,
    value: {
      ...minimalPlan,
      phases: [{ id: "p", title: "P", todos: [{ taskKey: "implement-change" }] }],
    },
  },
  {
    name: "task order out of range",
    valid: false,
    value: { ...minimalPlan, tasks: [{ ...minimalPlan.tasks[0], order: 0 }] },
  },
  {
    name: "unknown plan property",
    valid: false,
    value: { ...minimalPlan, milestones: [] },
  },
  {
    name: "decision without rationale",
    valid: false,
    value: { ...minimalPlan, decisions: [{ decision: "d" }] },
  },
  {
    name: "validation command without command",
    valid: false,
    value: { ...minimalPlan, validation: [{ expect: "exit 0" }] },
  },
  {
    name: "mixed-case task key and phase id",
    valid: true,
    value: {
      summary: "Mixed case plan",
      phases: [{ id: "Phase.One", title: "First" }],
      tasks: [
        {
          key: "ExtendSchemas",
          title: "Extend the schemas",
          paths: ["packages/domain"],
          acceptance: [{ id: "AC.Optional", description: "Fields stay optional" }],
          role: "implementor",
          phase: "Phase.One",
          execution: { group: "SchemaWork" },
        },
      ],
    },
  },
  {
    name: "uppercase role",
    valid: false,
    value: { ...minimalPlan, tasks: [{ ...minimalPlan.tasks[0], role: "Implementor" }] },
  },
  {
    name: "task key with a slash",
    valid: false,
    value: { ...minimalPlan, tasks: [{ ...minimalPlan.tasks[0], key: "tasks/one" }] },
  },
  {
    name: "task key starting with a dot",
    valid: false,
    value: { ...minimalPlan, tasks: [{ ...minimalPlan.tasks[0], key: ".hidden" }] },
  },
];

const minimalVerification = {
  verdict: "pass",
  summary: "Legacy verification",
  checks: [{ name: "unit-tests", verdict: "pass", summary: "All tests passed" }],
  findings: [],
};

const richVerification = {
  verdict: "pass",
  summary: "Rich verification",
  checks: [
    {
      id: "chk-parity",
      name: "schema parity",
      verdict: "pass",
      summary: "zod and JSON Schema agree",
      evidence: "packages/configuration/src/artifact-schema-parity.test.ts",
      criterionId: "ac-optional",
      taskKey: "extend-schemas",
      phaseId: "schemas",
      command: "pnpm test",
      evidenceRefs: [{ kind: "file", ref: "packages/domain/src/artifacts.ts" }],
    },
  ],
  criteria: [
    {
      id: "ac-optional",
      source: "definition",
      verdict: "pass",
      summary: "Covered",
      checks: ["chk-parity"],
    },
  ],
  phases: [{ id: "schemas", verdict: "pass", checks: ["chk-parity"], tasks: ["extend-schemas"] }],
  deviations: [
    { description: "Report sections were not extended", rationale: "Out of scope", impact: "low" },
  ],
  findings: [],
};

const verificationFixtures: readonly Fixture[] = [
  { name: "minimal verification", valid: true, value: minimalVerification },
  { name: "rich verification", valid: true, value: richVerification },
  { name: "empty checks", valid: false, value: { ...minimalVerification, checks: [] } },
  {
    name: "unknown check verdict",
    valid: false,
    value: { ...minimalVerification, checks: [{ name: "n", verdict: "maybe", summary: "s" }] },
  },
  {
    name: "criterion without verdict",
    valid: false,
    value: { ...minimalVerification, criteria: [{ id: "ac-x", source: "definition" }] },
  },
  {
    name: "criterion with unknown source",
    valid: false,
    value: { ...minimalVerification, criteria: [{ id: "ac-x", source: "vibes", verdict: "pass" }] },
  },
  {
    name: "deviation without rationale",
    valid: false,
    value: { ...minimalVerification, deviations: [{ description: "d" }] },
  },
  {
    name: "evidence reference with unknown kind",
    valid: false,
    value: {
      ...minimalVerification,
      checks: [
        { name: "n", verdict: "pass", summary: "s", evidenceRefs: [{ kind: "rumor", ref: "r" }] },
      ],
    },
  },
  {
    name: "mixed-case verification cross references",
    valid: true,
    value: {
      ...minimalVerification,
      checks: [
        {
          id: "CHK.Parity",
          name: "n",
          verdict: "pass",
          summary: "s",
          criterionId: "AC.Optional",
          taskKey: "ExtendSchemas",
          phaseId: "Phase.One",
        },
      ],
      criteria: [{ id: "AC.Optional", source: "plan", verdict: "pass", checks: ["CHK.Parity"] }],
      phases: [{ id: "Phase.One", verdict: "pass", tasks: ["ExtendSchemas"] }],
    },
  },
  {
    name: "criterion id with a space",
    valid: false,
    value: {
      ...minimalVerification,
      criteria: [{ id: "AC One", source: "definition", verdict: "pass" }],
    },
  },
];

const corpus: readonly {
  readonly kind: string;
  readonly schema: z.ZodType;
  readonly fixtures: readonly Fixture[];
}[] = [
  { kind: "definition", schema: DefinitionArtifactSchema, fixtures: definitionFixtures },
  { kind: "research", schema: ResearchArtifactSchema, fixtures: researchFixtures },
  { kind: "plan", schema: PlanArtifactSchema, fixtures: planFixtures },
  { kind: "verification", schema: VerificationArtifactSchema, fixtures: verificationFixtures },
];

describe("artifact schema parity", () => {
  for (const { kind, schema, fixtures } of corpus) {
    it(`agrees between Ajv and zod for every ${kind} fixture`, async () => {
      const validate = await compile(kind);
      const disagreements = fixtures.flatMap((fixture) => {
        const ajvAccepted = validate(fixture.value);
        const zodAccepted = schema.safeParse(fixture.value).success;
        return ajvAccepted === fixture.valid && zodAccepted === fixture.valid
          ? []
          : [`${fixture.name}: expected ${fixture.valid}, ajv ${ajvAccepted}, zod ${zodAccepted}`];
      });

      expect(disagreements).toEqual([]);
    });
  }

  it("keeps plan integrity rules in zod only, because JSON Schema cannot express them", async () => {
    const validate = await compile("plan");
    const integrityFixtures: readonly Fixture[] = [
      {
        name: "duplicate phase id",
        valid: false,
        value: {
          ...richPlan,
          phases: [
            { id: "schemas", title: "First" },
            { id: "schemas", title: "Second" },
          ],
          tasks: richPlan.tasks.map((task) => ({ ...task, phase: "schemas" })),
        },
      },
      {
        name: "unknown phase dependency",
        valid: false,
        value: {
          ...richPlan,
          phases: [
            { id: "schemas", title: "S", dependsOn: ["absent"] },
            { id: "frontier", title: "F" },
          ],
        },
      },
      {
        name: "task naming a missing phase",
        valid: false,
        value: { ...richPlan, tasks: richPlan.tasks.map((task) => ({ ...task, phase: "absent" })) },
      },
      {
        name: "cyclic phase dependencies",
        valid: false,
        value: {
          ...richPlan,
          phases: [
            { id: "schemas", title: "S", dependsOn: ["frontier"] },
            { id: "frontier", title: "F", dependsOn: ["schemas"] },
          ],
        },
      },
      {
        name: "partially phased plan",
        valid: false,
        value: {
          ...richPlan,
          tasks: [richPlan.tasks[0], { ...richPlan.tasks[1], phase: undefined }],
        },
      },
      {
        name: "todo naming a missing task",
        valid: false,
        value: {
          ...richPlan,
          phases: [
            { id: "schemas", title: "S", todos: [{ text: "t", taskKey: "absent" }] },
            { id: "frontier", title: "F", dependsOn: ["schemas"] },
          ],
        },
      },
    ];

    for (const fixture of integrityFixtures) {
      expect(validate(fixture.value), `${fixture.name} should pass Ajv`).toBe(true);
      expect(
        PlanArtifactSchema.safeParse(fixture.value).success,
        `${fixture.name} should fail zod`,
      ).toBe(false);
    }
  });

  it("records the shape-level asymmetries between Ajv and zod", async () => {
    const definition = await compile("definition");
    const plan = await compile("plan");
    const whitespaceSummary = {
      summary: "   ",
      inScope: ["a"],
      acceptanceCriteria: [{ description: "b" }],
    };
    const traversalPath = {
      ...minimalPlan,
      tasks: [{ ...minimalPlan.tasks[0], paths: ["../outside"] }],
    };

    expect(definition(whitespaceSummary)).toBe(true);
    expect(DefinitionArtifactSchema.safeParse(whitespaceSummary).success).toBe(false);
    expect(plan(traversalPath)).toBe(true);
    expect(PlanArtifactSchema.safeParse(traversalPath).success).toBe(false);
  });
});
