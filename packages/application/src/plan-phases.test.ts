import { PlanArtifactSchema } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import { expandPlanPhases, PLAN_PHASE_DEPENDENCY_LIMIT } from "./plan-phases.js";

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  paths: ["packages/domain"],
  acceptance: [{ description: `${key} is done` }],
  role: "implementor",
  ...extra,
});

describe("plan phase expansion", () => {
  it("leaves a plan without phases exactly as declared", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Legacy",
      tasks: [task("beta", { dependsOn: [] }), task("alpha")],
    });

    const expansion = expandPlanPhases(plan);

    expect(expansion.tasks).toBe(plan.tasks);
    expect(expansion).toMatchObject({ phases: [], derivedDependencies: [], collapsed: [] });
  });

  it("orders tasks by phase and derives dependencies from predecessor phases", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Phased",
      phases: [
        { id: "third", title: "Third", order: 3, dependsOn: ["second"] },
        { id: "first", title: "First", order: 1 },
        { id: "second", title: "Second", order: 2, dependsOn: ["first"] },
      ],
      tasks: [
        task("gamma", { phase: "third" }),
        task("beta", { phase: "second" }),
        task("alpha", { phase: "first" }),
      ],
    });

    const expansion = expandPlanPhases(plan);

    expect(expansion.tasks.map((entry) => entry.key)).toEqual(["alpha", "beta", "gamma"]);
    expect(expansion.tasks.map((entry) => entry.dependsOn)).toEqual([
      [],
      ["alpha"],
      ["beta", "alpha"],
    ]);
    expect(expansion.phases).toEqual(["first", "second", "third"]);
    expect(expansion.derivedDependencies).toEqual([
      { task: "beta", from: "second", added: ["alpha"] },
      { task: "gamma", from: "third", added: ["beta", "alpha"] },
    ]);
  });

  it("falls back to declaration order when a phase omits order", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Implicit order",
      phases: [
        { id: "first", title: "First" },
        { id: "second", title: "Second", dependsOn: ["first"] },
      ],
      tasks: [task("beta", { phase: "second" }), task("alpha", { phase: "first" })],
    });

    expect(expandPlanPhases(plan).tasks.map((entry) => entry.key)).toEqual(["alpha", "beta"]);
  });

  it("orders tasks within a phase by their declared order", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Within phase",
      phases: [{ id: "only", title: "Only" }],
      tasks: [
        task("second", { phase: "only", order: 2 }),
        task("first", { phase: "only", order: 1 }),
      ],
    });

    const expansion = expandPlanPhases(plan);

    expect(expansion.tasks.map((entry) => entry.key)).toEqual(["first", "second"]);
    expect(expansion.derivedDependencies).toEqual([]);
  });

  it("keeps declared dependencies and never duplicates a derived edge", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Declared plus derived",
      phases: [
        { id: "first", title: "First" },
        { id: "second", title: "Second", dependsOn: ["first"] },
      ],
      tasks: [
        task("alpha", { phase: "first" }),
        task("beta", { phase: "second", dependsOn: ["alpha"] }),
      ],
    });

    const expansion = expandPlanPhases(plan);

    expect(expansion.tasks.map((entry) => entry.dependsOn)).toEqual([[], ["alpha"]]);
    expect(expansion.derivedDependencies).toEqual([]);
  });

  it("collapses to immediate predecessors when the closure exceeds the cap", () => {
    const wide = Array.from({ length: PLAN_PHASE_DEPENDENCY_LIMIT }, (_, index) =>
      task(`wide-${index}`, { phase: "first" }),
    );
    const plan = PlanArtifactSchema.parse({
      summary: "Wide fan-in",
      phases: [
        { id: "first", title: "First" },
        { id: "second", title: "Second", dependsOn: ["first"] },
        { id: "third", title: "Third", dependsOn: ["second"] },
      ],
      tasks: [...wide, task("middle", { phase: "second" }), task("last", { phase: "third" })],
    });

    const expansion = expandPlanPhases(plan);

    expect(expansion.collapsed).toEqual(["last"]);
    expect(expansion.tasks.find((entry) => entry.key === "last")?.dependsOn).toEqual(["middle"]);
  });

  it("refuses a cyclic phase graph that bypassed schema validation", () => {
    const plan = {
      summary: "Cyclic",
      objectives: [],
      phases: [
        {
          id: "first",
          title: "First",
          parallelizable: false,
          dependsOn: ["second"],
          todos: [],
          exitCriteria: [],
          validation: [],
        },
        {
          id: "second",
          title: "Second",
          parallelizable: false,
          dependsOn: ["first"],
          todos: [],
          exitCriteria: [],
          validation: [],
        },
      ],
      decisions: [],
      dependencies: [],
      risks: [],
      successCriteria: [],
      validation: [],
      openQuestions: [],
      tasks: [
        { ...task("alpha", { phase: "first" }), dependsOn: [] },
        { ...task("beta", { phase: "second" }), dependsOn: [] },
      ],
    } as unknown as Parameters<typeof expandPlanPhases>[0];

    expect(() => expandPlanPhases(plan)).toThrow("forms a dependency cycle");
  });
});
