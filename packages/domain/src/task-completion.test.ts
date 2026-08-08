import { describe, expect, it } from "vitest";
import type { AcceptanceCriterion } from "./artifacts.js";
import type { RepositoryDeltaEvidence } from "./runtime.js";
import type { SensorReading } from "./sensors.js";
import {
  assessTaskCompletion,
  type EvidenceReference,
  type TaskCompletionAssessmentInput,
  type TaskCompletionSubmission,
  TaskCompletionSubmissionSchema,
} from "./task-completion.js";

const criterion: AcceptanceCriterion = {
  id: "ac-one",
  description: "The change is implemented",
  required: true,
};

describe("task completion submission", () => {
  it("requires an account for every criterion", () => {
    const parsed = TaskCompletionSubmissionSchema.parse({
      summary: "Implemented",
      criteria: [
        {
          id: "ac-one",
          outcome: "satisfied",
          summary: "Rewrote the parser and added a regression test",
          evidence: [
            { kind: "file", path: "packages/domain/src/runtime.ts", relationship: "modified" },
          ],
        },
      ],
    });

    expect(parsed.criteria[0]?.evidence).toHaveLength(1);
    expect(
      TaskCompletionSubmissionSchema.safeParse({
        summary: "Implemented",
        criteria: [{ id: "ac-one", outcome: "satisfied" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown evidence kind", () => {
    expect(() =>
      TaskCompletionSubmissionSchema.parse({
        summary: "Implemented",
        criteria: [
          {
            id: "ac-one",
            outcome: "satisfied",
            summary: "what was done",
            evidence: [{ kind: "vibes" }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("assessTaskCompletion", () => {
  it("satisfies a criterion whose claim resolves against the measured in-scope delta", () => {
    const assessment = assess({
      submission: claim({
        kind: "file",
        path: "packages/domain/src/runtime.ts",
        relationship: "modified",
      }),
    });

    expect(assessment.verdict).toBe("pass");
    expect(assessment.criteria[0]).toMatchObject({ verdict: "satisfied", claimed: "satisfied" });
  });

  it("records a claimed path that the measured delta does not show", () => {
    const assessment = assess({
      submission: claim({
        kind: "file",
        path: "packages/domain/src/invented.ts",
        relationship: "modified",
      }),
    });

    // The claim is the evidence. Senawa notes the disagreement without refusing the criterion.
    expect(assessment.verdict).toBe("pass");
    expect(assessment.criteria[0]?.verdict).toBe("satisfied");
    expect(assessment.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
    expect(assessment.criteria[0]?.evidence[0]?.detail).toContain("no change was measured");
  });

  it("records a claimed path outside the suggested write scope", () => {
    const assessment = assess({
      submission: claim({ kind: "file", path: "README.md", relationship: "modified" }),
    });

    expect(assessment.verdict).toBe("pass");
    expect(assessment.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
  });

  it("refuses a path inside a frozen path", () => {
    const assessment = assess({
      frozenPaths: ["packages/domain/src/frozen.ts"],
      authorizedPaths: ["packages/domain"],
      submission: claim({
        kind: "file",
        path: "packages/domain/src/frozen.ts",
        relationship: "modified",
      }),
    });

    expect(assessment.criteria[0]?.evidence[0]).toMatchObject({
      resolution: "contradicted",
      source: "frozen-paths",
    });
  });

  it("accepts a reviewed claim as a stated account", () => {
    const assessment = assess({
      submission: claim({
        kind: "file",
        path: "packages/domain/src/reviewed.ts",
        relationship: "reviewed",
      }),
    });

    expect(assessment.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
    expect(assessment.criteria[0]?.verdict).toBe("satisfied");
    expect(assessment.verdict).toBe("pass");
  });

  it("records sensor claims without adjudicating them", () => {
    const passing = assess({
      stage: "final",
      submission: claim({ kind: "sensor", sensorId: "typecheck" }),
      readings: [reading("typecheck", true, "pass")],
    });
    const failing = assess({
      stage: "final",
      submission: claim({ kind: "sensor", sensorId: "typecheck" }),
      readings: [reading("typecheck", false, "fail")],
    });
    const unknown = assess({
      stage: "final",
      submission: claim({ kind: "sensor", sensorId: "invented" }),
      readings: [reading("typecheck", true, "pass")],
    });

    expect(passing.verdict).toBe("pass");
    expect(failing.criteria[0]?.verdict).toBe("satisfied");
    expect(unknown.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
  });

  it("resolves a command claim only when it matches a configured gate sensor command", () => {
    const matched = assess({
      stage: "final",
      submission: claim({ kind: "command", command: "pnpm typecheck" }),
      readings: [reading("typecheck", true, "pass")],
    });
    const freeText = assess({
      stage: "final",
      submission: claim({ kind: "command", command: "pnpm invented" }),
      readings: [reading("typecheck", true, "pass")],
    });

    expect(matched.verdict).toBe("pass");
    expect(freeText.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
  });

  it("closes an audit criterion that claims the measured empty delta", () => {
    const assessment = assess({
      repositoryDelta: delta({ changedPaths: [], inScopeChanges: [] }),
      submission: claim({ kind: "repository-delta", scope: "none" }),
    });

    expect(assessment.verdict).toBe("pass");
    expect(assessment.criteria[0]?.verdict).toBe("satisfied");
  });

  it("records a no-change claim even when a change was measured", () => {
    const assessment = assess({ submission: claim({ kind: "repository-delta", scope: "none" }) });

    expect(assessment.criteria[0]?.verdict).toBe("satisfied");
    expect(assessment.criteria[0]?.evidence[0]).toMatchObject({ resolution: "recorded" });
  });

  it("leaves every required criterion unmet when no submission arrived", () => {
    const assessment = assess({ submission: null, submissionPresent: false });

    expect(assessment.verdict).toBe("fail");
    expect(assessment.criteria[0]).toMatchObject({ claimed: "unreported", verdict: "unclaimed" });
    expect(assessment.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "acceptance-submission-missing" })]),
    );
  });

  it("reports an invalid submission separately from a missing one", () => {
    const assessment = assess({ submission: null, submissionPresent: true });

    expect(assessment.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "acceptance-submission-invalid" })]),
    );
  });

  it.each(["blocked", "not-applicable"] as const)(
    "never satisfies a required criterion reported as %s",
    (outcome) => {
      const assessment = assess({
        submission: {
          summary: "Reported",
          criteria: [{ id: "ac-one", outcome, summary: "what was done", evidence: [] }],
        },
      });

      expect(assessment.verdict).toBe("fail");
      expect(assessment.criteria[0]?.verdict).toBe("unresolved");
    },
  );

  it("waives an optional criterion reported as not-applicable", () => {
    const assessment = assess({
      criteria: [{ id: "ac-one", description: "Optional", required: false }],
      submission: {
        summary: "Reported",
        criteria: [
          { id: "ac-one", outcome: "not-applicable", summary: "what was done", evidence: [] },
        ],
      },
    });

    expect(assessment.verdict).toBe("pass");
    expect(assessment.criteria[0]?.verdict).toBe("waived");
  });

  it("refuses a claim for a criterion the task does not define", () => {
    const assessment = assess({
      submission: {
        summary: "Reported",
        criteria: [
          {
            id: "ac-one",
            outcome: "satisfied",
            summary: "what was done",
            evidence: [inScopeFileClaim()],
          },
          { id: "ac-invented", outcome: "satisfied", summary: "what was done", evidence: [] },
        ],
      },
    });

    expect(assessment.verdict).toBe("fail");
    expect(assessment.unmatchedClaims).toEqual(["ac-invented"]);
  });

  it("warns when the worker submits completion more than once", () => {
    const assessment = assess({ duplicateCount: 3, submission: claim(inScopeFileClaim()) });

    expect(assessment.verdict).toBe("pass");
    expect(assessment.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "acceptance-submission-duplicated" }),
      ]),
    );
  });

  it("marks a recovered assessment as uncertain", () => {
    expect(assess({ recovered: true, submission: claim(inScopeFileClaim()) }).uncertainty).toEqual([
      "assessment-computed-during-recovery",
    ]);
  });
});

function inScopeFileClaim(): EvidenceReference {
  return { kind: "file", path: "packages/domain/src/runtime.ts", relationship: "modified" };
}

function claim(reference: EvidenceReference): TaskCompletionSubmission {
  return {
    summary: "Reported",
    criteria: [
      { id: "ac-one", outcome: "satisfied", summary: "what was done", evidence: [reference] },
    ],
  };
}

function reading(sensorId: string, matched: boolean, verdict: "pass" | "fail"): SensorReading {
  return {
    sensorId,
    extension: "@senawa/sensor-command",
    result: { verdict, summary: `${sensorId} ${verdict}`, findings: [] },
    expect: { path: "/verdict", operator: "equals", value: "pass" },
    matched,
    advisory: false,
    durationMs: 1,
    evidencePaths: [],
  };
}

function delta(overrides: Partial<RepositoryDeltaEvidence> = {}): RepositoryDeltaEvidence {
  return {
    version: 1,
    kind: "repository-delta",
    runId: "run",
    taskId: "task",
    attempt: 1,
    dispatchId: "dispatch",
    turnId: "turn",
    expectation: "optional",
    baselineDigest: "a".repeat(64),
    headBefore: "head",
    headAfter: "head",
    preExistingChanges: [],
    changedPaths: [
      { path: "packages/domain/src/runtime.ts", status: " M", digest: "b".repeat(64) },
    ],
    inScopeChanges: ["packages/domain/src/runtime.ts"],
    outOfScopeChanges: [],
    frozenChanges: [],
    uncertainty: [],
    workerClaim: { reported: true, changed: true, agreement: "agree" },
    capturedAt: "2026-08-07T00:00:00.000Z",
    digest: "c".repeat(64),
    evidencePath: "evidence/repository/delta.json",
    ...overrides,
  };
}

function assess(
  overrides: Partial<TaskCompletionAssessmentInput> & {
    readonly submission: TaskCompletionSubmission | null;
  },
) {
  return assessTaskCompletion({
    stage: "pre-gate",
    runId: "run",
    taskId: "task",
    attempt: 1,
    dispatchId: "dispatch",
    turnId: "turn",
    gateId: "task-done",
    criteria: [criterion],
    submissionPresent: overrides.submission !== null,
    duplicateCount: overrides.submission === null ? 0 : 1,
    repositoryDelta: delta(),
    authorizedPaths: ["packages/domain"],
    frozenPaths: [".senawa/**"],
    gateSensors: [
      { sensorId: "typecheck", command: "pnpm typecheck", scope: ["packages"], advisory: false },
    ],
    readings: [],
    recovered: false,
    assessedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  });
}
