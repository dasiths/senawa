import { describe, expect, it } from "vitest";
import { type CanonicalValue, canonicalValue, sha256Digest } from "./canonical.js";
import {
  type AccountingAssessment,
  assessCompletionAccounting,
  CompletionAccountingError,
  type CompletionAccountingErrorCode,
  type CompletionEvidenceItem,
  type CompletionEvidencePolicyMode,
  type CompletionEvidenceRequirement,
  type CompletionRequirements,
  type CompletionSubmission,
  type CriterionOutcome,
  type CriterionRequirement,
  reassessCompletionAccounting,
  type TaskGenerationReference,
  type TerminalDisposition,
  validateCompletionRequirements,
} from "./completion.js";
import { assetId, criterionId, definitionGeneration, taskId } from "./identity.js";

const CONTEXT_DIGEST = sha256Digest("a".repeat(64));

describe("completion accounting", () => {
  it("snapshots one complete criterion account and returns immutable completionEvidence accounting", () => {
    const requirements = requiredCriterionRequirements("task");
    const submission = completedSubmission();

    const assessment = assessCompletionAccounting(requirements, submission);
    submission.summary = "mutated";
    submission.completionEvidence[0] = {
      ...required(submission.completionEvidence[0]),
      descriptor: canonicalValue({ command: "mutated" }),
    };

    expect(assessment.submission.summary).toBe("Checks passed");
    expect(assessment.taskEvidence).toEqual([
      {
        kind: { name: "test-report", version: 1 },
        minimumCount: 1,
        attachmentCount: 1,
        satisfied: true,
      },
    ]);
    expect(assessment.completionEvidenceSatisfied).toBe(true);
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.submission)).toBe(true);
    expect(Object.isFrozen(assessment.criteria)).toBe(true);
    expect(Object.isFrozen(assessment.taskEvidence)).toBe(true);
  });

  it.each<TerminalDisposition>(["completed", "blocked", "waived", "skipped", "superseded"])(
    "accounts the %s terminal disposition",
    (disposition) => {
      const base = completedSubmission();
      const submission = {
        ...base,
        disposition,
        completionEvidence: [],
        ...(disposition === "superseded"
          ? {
              replacementTask: {
                taskId: taskId("task_replacement"),
                definitionGeneration: definitionGeneration(3),
                contextRevisionDigest: sha256Digest("b".repeat(64)),
              },
            }
          : {}),
      } as CompletionSubmission;

      expect(
        assessCompletionAccounting(requiredCriterionRequirements("none"), submission).submission,
      ).toEqual(expect.objectContaining({ disposition }));
    },
  );

  it("rejects empty summaries", () => {
    const submission = completedSubmission();
    submission.summary = " \n ";

    expectAccountingError("invalid-submission", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), submission),
    );
  });

  it.each([
    ["task identity", { taskId: taskId("task_other") }],
    ["definition generation", { definitionGeneration: definitionGeneration(3) }],
    ["context revision", { contextRevisionDigest: sha256Digest("b".repeat(64)) }],
  ])("rejects a mismatched task generation by %s", (_name, replacement) => {
    const submission = completedSubmission();
    submission.task = { ...submission.task, ...replacement };

    expectAccountingError("task-reference-mismatch", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), submission),
    );
  });

  it("rejects duplicate, unknown, and missing criterion outcomes", () => {
    const duplicate = completedSubmission();
    duplicate.criteria.push({
      criterionId: criterionId("criterion_tests"),
      disposition: "unsatisfied",
    });
    expectAccountingError("duplicate-criterion", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), duplicate),
    );

    const unknown = completedSubmission();
    unknown.criteria[0] = {
      criterionId: criterionId("criterion_unknown"),
      disposition: "satisfied",
    };
    expectAccountingError("unknown-criterion", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), unknown),
    );

    const missing = completedSubmission();
    missing.criteria = [];
    expectAccountingError("missing-criterion", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), missing),
    );
  });

  it("rejects duplicate declared criteria", () => {
    const requirements = requiredCriterionRequirements("none");
    requirements.criteria.push({
      criterionId: criterionId("criterion_tests"),
      required: false,
    });

    expectAccountingError("duplicate-criterion", () =>
      assessCompletionAccounting(requirements, {
        ...completedSubmission(),
        completionEvidence: [],
      }),
    );
    expectAccountingError("duplicate-criterion", () =>
      validateCompletionRequirements(requirements),
    );
  });

  it("validates completion requirements as an immutable canonical snapshot", () => {
    const requirements = requiredCriterionRequirements("task");
    const validated = validateCompletionRequirements(requirements);
    requirements.criteria[0] = {
      criterionId: criterionId("criterion_mutated"),
      required: false,
    };

    expect(validated.criteria[0]).toEqual({
      criterionId: criterionId("criterion_tests"),
      required: true,
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.criteria)).toBe(true);
  });

  it("forbids required skips and requires the exact configured waiver authority", () => {
    const skipped = completedSubmission();
    skipped.criteria = [{ criterionId: criterionId("criterion_tests"), disposition: "skipped" }];
    expectAccountingError("required-skip", () =>
      assessCompletionAccounting(requiredCriterionRequirements("none"), skipped),
    );

    const absentAuthority = completedSubmission();
    absentAuthority.criteria = [
      { criterionId: criterionId("criterion_tests"), disposition: "waived" },
    ];
    expectAccountingError("invalid-waiver", () =>
      assessCompletionAccounting(requiredCriterionRequirements("none"), absentAuthority),
    );

    const wrongAuthority = completedSubmission();
    wrongAuthority.criteria = [
      {
        criterionId: criterionId("criterion_tests"),
        disposition: "waived",
        authorityFact: canonicalValue({ principal: "principal_bob", role: "release-manager" }),
      },
    ];
    expectAccountingError("invalid-waiver", () =>
      assessCompletionAccounting(requiredCriterionRequirements("none"), wrongAuthority),
    );

    const exactAuthority = completedSubmission();
    exactAuthority.criteria = [
      {
        criterionId: criterionId("criterion_tests"),
        disposition: "waived",
        authorityFact: canonicalValue({ principal: "principal_alice", role: "release-manager" }),
      },
    ];
    expect(
      assessCompletionAccounting(requiredCriterionRequirements("none"), exactAuthority).criteria[0]
        ?.disposition,
    ).toBe("waived");
  });

  it("permits an optional criterion to be skipped without waiver authority", () => {
    const requirements = requiredCriterionRequirements("none");
    requirements.criteria[0] = {
      criterionId: criterionId("criterion_tests"),
      required: false,
    };
    const submission = completedSubmission();
    submission.criteria[0] = {
      criterionId: criterionId("criterion_tests"),
      disposition: "skipped",
    };

    expect(assessCompletionAccounting(requirements, submission).criteria[0]?.disposition).toBe(
      "skipped",
    );
  });

  it("requires superseded submissions to name a distinct replacement task only", () => {
    const missing = { ...completedSubmission(), disposition: "superseded" } as CompletionSubmission;
    expectAccountingError("invalid-supersession", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), missing),
    );

    const same = {
      ...completedSubmission(),
      disposition: "superseded",
      replacementTask: completedSubmission().task,
    } as CompletionSubmission;
    expectAccountingError("invalid-supersession", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), same),
    );

    const unexpected = {
      ...completedSubmission(),
      replacementTask: {
        taskId: taskId("task_replacement"),
        definitionGeneration: definitionGeneration(3),
        contextRevisionDigest: sha256Digest("b".repeat(64)),
      },
    } as CompletionSubmission;
    expectAccountingError("invalid-supersession", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), unexpected),
    );
  });

  it("reports no completionEvidence obligations for the none policy", () => {
    const assessment = assessCompletionAccounting(requiredCriterionRequirements("none"), {
      ...completedSubmission(),
      completionEvidence: [],
    });

    expect(assessment.taskEvidence).toEqual([]);
    expect(assessment.criteria[0]?.completionEvidence).toEqual([]);
    expect(assessment.completionEvidenceSatisfied).toBe(true);
  });

  it("counts task completionEvidence by canonical kind and reports unmet minimums", () => {
    const requirements = requiredCriterionRequirements("task");
    requirements.completionEvidencePolicy.requirements[0] = {
      kind: canonicalValue({ name: "test-report", version: 1 }),
      minimumCount: 2,
    };

    const assessment = assessCompletionAccounting(requirements, completedSubmission());

    expect(assessment.taskEvidence[0]).toEqual({
      kind: { name: "test-report", version: 1 },
      minimumCount: 2,
      attachmentCount: 1,
      satisfied: false,
    });
    expect(assessment.completionEvidenceSatisfied).toBe(false);
  });

  it("requires criterion completionEvidence for each required criterion under required-criteria", () => {
    const { requirements, submission } = twoCriterionFixture("required-criteria");
    submission.criteria[0] = {
      criterionId: criterionId("criterion_tests"),
      disposition: "unsatisfied",
    };
    submission.completionEvidence = [criterionEvidence("asset_required", "criterion_tests")];

    const assessment = assessCompletionAccounting(requirements, submission);

    expect(assessment.criteria[0]?.completionEvidenceSatisfied).toBe(true);
    expect(assessment.criteria[0]?.completionEvidence[0]?.attachmentCount).toBe(1);
    expect(assessment.criteria[1]?.completionEvidence).toEqual([]);
    expect(assessment.completionEvidenceSatisfied).toBe(true);
  });

  it("requires completionEvidence for every satisfied criterion under all-satisfied", () => {
    const { requirements, submission } = twoCriterionFixture("all-satisfied");
    submission.completionEvidence = [criterionEvidence("asset_required", "criterion_tests")];

    const assessment = assessCompletionAccounting(requirements, submission);

    expect(assessment.criteria[0]?.completionEvidenceSatisfied).toBe(true);
    expect(assessment.criteria[1]?.completionEvidenceSatisfied).toBe(false);
    expect(assessment.completionEvidenceSatisfied).toBe(false);
  });

  it("rejects duplicate completionEvidence assets and completionEvidence for unknown criteria", () => {
    const duplicate = completedSubmission();
    duplicate.completionEvidence.push({ ...required(duplicate.completionEvidence[0]) });
    expectAccountingError("duplicate-completionEvidence", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), duplicate),
    );

    const unknown = completedSubmission();
    unknown.completionEvidence[0] = criterionEvidence("asset_unknown", "criterion_unknown");
    expectAccountingError("unknown-criterion", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), unknown),
    );
  });

  it("rejects invalid completionEvidence policies and duplicate canonical kinds", () => {
    const empty = requiredCriterionRequirements("task");
    empty.completionEvidencePolicy.requirements = [];
    expectAccountingError("invalid-requirements", () =>
      assessCompletionAccounting(empty, completedSubmission()),
    );

    const duplicate = requiredCriterionRequirements("task");
    duplicate.completionEvidencePolicy.requirements.push({
      kind: canonicalValue({ version: 1, name: "test-report" }),
      minimumCount: 2,
    });
    expectAccountingError("invalid-requirements", () =>
      assessCompletionAccounting(duplicate, completedSubmission()),
    );
  });

  it("rejects accessors without invoking them and rejects sparse arrays", () => {
    let accessorReads = 0;
    const accessorSubmission = {
      ...completedSubmission(),
      get summary() {
        accessorReads += 1;
        return "forged";
      },
    } as CompletionSubmission;
    expectAccountingError("invalid-submission", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), accessorSubmission),
    );
    expect(accessorReads).toBe(0);

    const sparseSubmission = {
      ...completedSubmission(),
      criteria: new Array(1),
    } as CompletionSubmission;
    expectAccountingError("invalid-submission", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), sparseSubmission),
    );
  });

  it("rejects forged branded values and extra fields at runtime", () => {
    const forgedRequirements = {
      ...requiredCriterionRequirements("task"),
      task: {
        taskId: "phase_wrong-kind",
        definitionGeneration: 2,
        contextRevisionDigest: CONTEXT_DIGEST,
      },
    } as unknown as CompletionRequirements;
    expectAccountingError("invalid-requirements", () =>
      assessCompletionAccounting(forgedRequirements, completedSubmission()),
    );

    const forgedSubmission = {
      ...completedSubmission(),
      criteria: [{ criterionId: "task_wrong-kind", disposition: "satisfied" }],
    } as unknown as CompletionSubmission;
    expectAccountingError("invalid-submission", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), forgedSubmission),
    );

    const extraField = { ...completedSubmission(), status: "done" } as CompletionSubmission;
    expectAccountingError("invalid-submission", () =>
      assessCompletionAccounting(requiredCriterionRequirements("task"), extraField),
    );
  });

  it("reassesses an exact assessment and rejects recomputed semantic forgery", () => {
    const requirements = requiredCriterionRequirements("task");
    const assessment = assessCompletionAccounting(requirements, completedSubmission());

    expect(reassessCompletionAccounting(requirements, assessment)).toEqual(assessment);

    const forged = {
      submission: { ...assessment.submission, criteria: [], completionEvidence: [] },
      criteria: [],
      taskEvidence: [],
      completionEvidenceSatisfied: true,
    } as AccountingAssessment;
    expectAccountingError("invalid-assessment", () =>
      reassessCompletionAccounting(requirements, forged),
    );
  });

  it("snapshots reassessment inputs without invoking accessors", () => {
    let accessorReads = 0;
    const assessment = assessCompletionAccounting(
      requiredCriterionRequirements("task"),
      completedSubmission(),
    );
    const accessorAssessment = {
      ...assessment,
      get submission() {
        accessorReads += 1;
        return assessment.submission;
      },
    } as AccountingAssessment;

    expectAccountingError("invalid-assessment", () =>
      reassessCompletionAccounting(requiredCriterionRequirements("task"), accessorAssessment),
    );
    expect(accessorReads).toBe(0);
  });
});

function requiredCriterionRequirements(
  mode: CompletionRequirements["completionEvidencePolicy"]["mode"],
): MutableCompletionRequirements {
  return {
    task: {
      taskId: taskId("task_verify"),
      definitionGeneration: definitionGeneration(2),
      contextRevisionDigest: CONTEXT_DIGEST,
    },
    criteria: [{ criterionId: criterionId("criterion_tests"), required: true }],
    completionEvidencePolicy: {
      mode,
      requirements:
        mode === "none"
          ? []
          : [
              {
                kind: canonicalValue({ version: 1, name: "test-report" }),
                minimumCount: 1,
              },
            ],
      waiverAuthority: canonicalValue({ role: "release-manager", principal: "principal_alice" }),
    },
  };
}

function twoCriterionFixture(mode: "required-criteria" | "all-satisfied"): {
  requirements: MutableCompletionRequirements;
  submission: MutableCompletionSubmission;
} {
  const requirements = requiredCriterionRequirements(mode);
  requirements.criteria.push({
    criterionId: criterionId("criterion_optional"),
    required: false,
  });
  const submission = completedSubmission();
  submission.criteria.push({
    criterionId: criterionId("criterion_optional"),
    disposition: "satisfied",
  });
  return { requirements, submission };
}

function criterionEvidence(assetToken: string, criterionToken: string): CompletionEvidenceItem {
  return {
    assetId: assetId(assetToken),
    kind: canonicalValue({ name: "test-report", version: 1 }),
    descriptor: canonicalValue({ command: "pnpm test", exitCode: 0 }),
    criterionId: criterionId(criterionToken),
  };
}

function completedSubmission(): MutableCompletionSubmission {
  return {
    task: {
      taskId: taskId("task_verify"),
      definitionGeneration: definitionGeneration(2),
      contextRevisionDigest: CONTEXT_DIGEST,
    },
    disposition: "completed",
    summary: "Checks passed",
    criteria: [{ criterionId: criterionId("criterion_tests"), disposition: "satisfied" }],
    completionEvidence: [
      {
        assetId: assetId("asset_report"),
        kind: canonicalValue({ name: "test-report", version: 1 }),
        descriptor: canonicalValue({ command: "pnpm test", exitCode: 0 }),
      },
    ],
  };
}

function expectAccountingError(
  code: CompletionAccountingErrorCode,
  operation: () => unknown,
): void {
  try {
    operation();
    throw new Error(`Expected CompletionAccountingError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CompletionAccountingError);
    expect((error as CompletionAccountingError).code).toBe(code);
  }
}

interface MutableCompletionRequirements {
  task: TaskGenerationReference;
  criteria: CriterionRequirement[];
  completionEvidencePolicy: {
    mode: CompletionEvidencePolicyMode;
    requirements: CompletionEvidenceRequirement[];
    waiverAuthority?: CanonicalValue;
  };
}

interface MutableCompletionSubmission {
  task: TaskGenerationReference;
  disposition: TerminalDisposition;
  summary: string;
  criteria: CriterionOutcome[];
  completionEvidence: CompletionEvidenceItem[];
  replacementTask?: TaskGenerationReference;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Expected fixture value");
  }
  return value;
}
