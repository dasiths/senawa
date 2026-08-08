import { describe, expect, it } from "vitest";
import {
  DefinitionArtifactSchema,
  deriveAcceptanceCriterionId,
  normalizeAcceptance,
  PlanArtifactSchema,
  ResearchArtifactSchema,
  VerificationArtifactSchema,
} from "./artifacts.js";
import { ArtifactIdSchema, IdentifierSchema } from "./common.js";

describe("plan acceptance criteria", () => {
  it("keeps string acceptance valid and derives a stable id from the description", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Legacy plan",
      tasks: [
        {
          key: "legacy",
          title: "Legacy task",
          paths: ["packages/domain"],
          acceptance: [{ description: "The behavior is implemented" }],
          role: "implementor",
        },
      ],
    });

    expect(normalizeAcceptance(plan.tasks[0]?.acceptance ?? [])).toEqual([
      {
        id: deriveAcceptanceCriterionId("The behavior is implemented"),
        description: "The behavior is implemented",
        required: true,
      },
    ]);
  });

  it("keeps derived ids stable when a plan reorders criteria", () => {
    const first = normalizeAcceptance([{ description: "Alpha" }, { description: "Beta" }]).map(
      (criterion) => criterion.id,
    );
    const second = normalizeAcceptance([{ description: "Beta" }, { description: "Alpha" }]).map(
      (criterion) => criterion.id,
    );

    expect(second).toEqual([first[1], first[0]]);
  });

  it("accepts structured criteria and defaults required to true", () => {
    expect(
      normalizeAcceptance([
        { id: "ac-explicit", description: "Explicit", required: false },
        { description: "Derived" },
      ]),
    ).toEqual([
      { id: "ac-explicit", description: "Explicit", required: false },
      { id: deriveAcceptanceCriterionId("Derived"), description: "Derived", required: true },
    ]);
  });

  it("rejects duplicate acceptance criterion ids", () => {
    expect(() =>
      PlanArtifactSchema.parse({
        summary: "Duplicate criteria",
        tasks: [
          {
            key: "duplicate",
            title: "Duplicate task",
            paths: ["packages/domain"],
            acceptance: [
              { id: "ac-same", description: "First" },
              { id: "ac-same", description: "Second" },
            ],
            role: "implementor",
          },
        ],
      }),
    ).toThrow("Duplicate acceptance criterion id: ac-same");
  });

  it("rejects duplicate derived ids from repeated descriptions", () => {
    expect(() =>
      PlanArtifactSchema.parse({
        summary: "Repeated criteria",
        tasks: [
          {
            key: "repeated",
            title: "Repeated task",
            paths: ["packages/domain"],
            acceptance: [{ description: "Same" }, { description: "Same" }],
            role: "implementor",
          },
        ],
      }),
    ).toThrow("Duplicate acceptance criterion id");
  });
});

describe("plan phases", () => {
  const task = (key: string, phase?: string) => ({
    key,
    title: `Task ${key}`,
    paths: ["packages/domain"],
    acceptance: [{ description: `${key} is done` }],
    role: "implementor",
    ...(phase === undefined ? {} : { phase }),
  });
  const parse = (plan: Record<string, unknown>) => PlanArtifactSchema.parse(plan);

  it("defaults phases to an empty list so legacy plans keep parsing", () => {
    expect(parse({ summary: "Legacy", tasks: [task("only")] }).phases).toEqual([]);
  });

  it("accepts an ordered phased plan with todos", () => {
    const plan = parse({
      summary: "Phased",
      phases: [
        { id: "first", title: "First", order: 1, todos: [{ text: "Do it", taskKey: "alpha" }] },
        { id: "second", title: "Second", order: 2, dependsOn: ["first"] },
      ],
      tasks: [task("alpha", "first"), task("beta", "second")],
    });

    expect(plan.phases.map((phase) => phase.id)).toEqual(["first", "second"]);
    expect(plan.phases[0]?.parallelizable).toBe(false);
  });

  it("rejects a duplicate phase id", () => {
    expect(() =>
      parse({
        summary: "Duplicate phases",
        phases: [
          { id: "same", title: "First" },
          { id: "same", title: "Second" },
        ],
        tasks: [task("alpha", "same")],
      }),
    ).toThrow("Duplicate plan phase id: same");
  });

  it("rejects an unknown phase dependency", () => {
    expect(() =>
      parse({
        summary: "Unknown dependency",
        phases: [{ id: "first", title: "First", dependsOn: ["absent"] }],
        tasks: [task("alpha", "first")],
      }),
    ).toThrow("Unknown plan phase dependency: absent");
  });

  it("rejects a task naming a missing phase", () => {
    expect(() =>
      parse({
        summary: "Missing phase",
        phases: [{ id: "first", title: "First" }],
        tasks: [task("alpha", "absent")],
      }),
    ).toThrow("Unknown task phase: absent");
  });

  it("rejects a cycle in phase dependencies", () => {
    expect(() =>
      parse({
        summary: "Cyclic phases",
        phases: [
          { id: "first", title: "First", dependsOn: ["second"] },
          { id: "second", title: "Second", dependsOn: ["first"] },
        ],
        tasks: [task("alpha", "first")],
      }),
    ).toThrow("Plan phase dependencies form a cycle");
  });

  it("rejects a partially phased plan", () => {
    expect(() =>
      parse({
        summary: "Half phased",
        phases: [{ id: "first", title: "First" }],
        tasks: [task("alpha", "first"), task("beta")],
      }),
    ).toThrow("must assign every task to a phase or assign none of them");
  });

  it("rejects a todo naming a missing task", () => {
    expect(() =>
      parse({
        summary: "Dangling todo",
        phases: [{ id: "first", title: "First", todos: [{ text: "Do it", taskKey: "absent" }] }],
        tasks: [task("alpha", "first")],
      }),
    ).toThrow("Unknown plan phase todo task: absent");
  });
});

describe("model-authored artifact ids", () => {
  const mixedCasePlan = {
    summary: "Mixed case plan",
    phases: [
      { id: "Phase.One", title: "First", dependsOn: [] },
      { id: "PHASE_2", title: "Second", dependsOn: ["Phase.One"] },
    ],
    decisions: [{ id: "D1", decision: "Ship it", rationale: "Evidence supports it" }],
    successCriteria: [
      { id: "SC-Order", description: "Order holds", satisfies: ["AC-Phase-Order"] },
    ],
    validation: [{ id: "Typecheck", command: "pnpm typecheck" }],
    risks: [{ id: "R1", description: "Drift", mitigation: "Parity test" }],
    openQuestions: [{ id: "Q1", question: "Should phases be required?" }],
    tasks: [
      {
        key: "ExtendSchemas",
        title: "Extend the schemas",
        paths: ["packages/domain"],
        acceptance: [
          { id: "AC.Optional", description: "Fields stay optional", satisfies: ["SC-Order"] },
        ],
        role: "implementor",
        phase: "Phase.One",
        execution: { group: "SchemaWork" },
      },
      {
        key: "ExpandFrontier",
        title: "Expand the frontier",
        dependsOn: ["ExtendSchemas"],
        paths: ["packages/application"],
        acceptance: [{ description: "Order reaches the frontier" }],
        role: "implementor",
        phase: "PHASE_2",
      },
    ],
  };

  it("accepts uppercase and mixed-case ids across a plan", () => {
    const plan = PlanArtifactSchema.parse(mixedCasePlan);

    expect(plan.tasks.map((entry) => entry.key)).toEqual(["ExtendSchemas", "ExpandFrontier"]);
    expect(plan.phases.map((phase) => phase.id)).toEqual(["Phase.One", "PHASE_2"]);
  });

  it("accepts mixed-case cross references in research, definition, and verification", () => {
    expect(
      ResearchArtifactSchema.safeParse({
        summary: "Mixed case research",
        findings: [
          {
            id: "F-ZodOnly",
            claim: "Only the plan is zod-validated",
            source: "packages/application",
            evidenceKind: "measured",
            answers: ["Q_Enforcement"],
          },
        ],
        questions: [
          {
            id: "Q_Enforcement",
            question: "Where?",
            status: "answered",
            answeredBy: ["F-ZodOnly"],
          },
        ],
        alternatives: [
          {
            id: "Alt.Selector",
            option: "Use the selector",
            verdict: "rejected",
            rationale: "The workflow is frozen first",
            evidence: ["F-ZodOnly"],
          },
        ],
        unknowns: [{ id: "U1", question: "Will planners populate phases?" }],
        recommendations: [
          {
            id: "R-Derive",
            statement: "Derive edges at import",
            basis: ["F-ZodOnly"],
            alternativesRejected: ["Alt.Selector"],
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      DefinitionArtifactSchema.safeParse({
        summary: "Mixed case definition",
        inScope: ["packages/domain"],
        acceptanceCriteria: [{ id: "AC-PhaseOrder", description: "Order holds" }],
        assumptions: [{ id: "A1", statement: "No pinned fingerprint" }],
        evidenceNeeded: [{ id: "E1", question: "How much does the prompt grow?" }],
        constraints: [{ id: "C1", statement: "Schemas are frozen" }],
        openQuestions: [{ id: "Q1", question: "Blocking?" }],
        risks: [{ id: "R1", description: "Drift", mitigation: "Parity test" }],
      }).success,
    ).toBe(true);

    expect(
      VerificationArtifactSchema.safeParse({
        verdict: "pass",
        summary: "Mixed case verification",
        checks: [
          {
            id: "CHK.Parity",
            name: "parity",
            verdict: "pass",
            summary: "Agrees",
            criterionId: "AC.Optional",
            taskKey: "ExtendSchemas",
            phaseId: "Phase.One",
          },
        ],
        criteria: [{ id: "AC.Optional", source: "plan", verdict: "pass", checks: ["CHK.Parity"] }],
        phases: [
          {
            id: "Phase.One",
            verdict: "pass",
            checks: ["CHK.Parity"],
            tasks: ["ExtendSchemas"],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("still rejects ids that are unsafe as a path segment or empty", () => {
    const withKey = (key: string) => ({
      summary: "Unsafe key",
      tasks: [
        {
          key,
          title: "Task",
          paths: ["packages/domain"],
          acceptance: [{ description: "Done" }],
          role: "implementor",
        },
      ],
    });

    for (const key of [
      "",
      "has space",
      "has/slash",
      "has\\backslash",
      ".hidden",
      "..",
      "a\u0000b",
    ]) {
      expect(PlanArtifactSchema.safeParse(withKey(key)).success).toBe(false);
    }
  });

  it("keeps referential integrity working for mixed-case ids", () => {
    expect(() =>
      PlanArtifactSchema.parse({
        ...mixedCasePlan,
        tasks: [
          { ...mixedCasePlan.tasks[0], dependsOn: ["extendschemas"] },
          mixedCasePlan.tasks[1],
        ],
      }),
    ).toThrow("Unknown task dependency: extendschemas");
  });

  it("keeps a derived acceptance criterion id valid under the artifact id shape", () => {
    expect(ArtifactIdSchema.safeParse(deriveAcceptanceCriterionId("Anything")).success).toBe(true);
  });

  it("does not relax the repository-config identifier", () => {
    expect(IdentifierSchema.safeParse("Implementor").success).toBe(false);
    expect(IdentifierSchema.safeParse("implementor").success).toBe(true);
    expect(
      PlanArtifactSchema.safeParse({
        ...mixedCasePlan,
        tasks: mixedCasePlan.tasks.map((entry) => ({ ...entry, role: "Implementor" })),
      }).success,
    ).toBe(false);
  });
});
