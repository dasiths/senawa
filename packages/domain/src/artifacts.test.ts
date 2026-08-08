import { describe, expect, it } from "vitest";
import {
  deriveAcceptanceCriterionId,
  normalizeAcceptance,
  PlanArtifactSchema,
} from "./artifacts.js";

describe("plan acceptance criteria", () => {
  it("keeps string acceptance valid and derives a stable id from the description", () => {
    const plan = PlanArtifactSchema.parse({
      summary: "Legacy plan",
      tasks: [
        {
          key: "legacy",
          title: "Legacy task",
          paths: ["packages/domain"],
          acceptance: ["The behavior is implemented"],
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
    const first = normalizeAcceptance(["Alpha", "Beta"]).map((criterion) => criterion.id);
    const second = normalizeAcceptance(["Beta", "Alpha"]).map((criterion) => criterion.id);

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
            acceptance: ["Same", "Same"],
            role: "implementor",
          },
        ],
      }),
    ).toThrow("Duplicate acceptance criterion id");
  });
});
