import { describe, expect, it } from "vitest";
import { canonicalValue, type Sha256, sha256Digest } from "./canonical.js";
import {
  compareFanOutEvaluations,
  evaluateTaskFrontier,
  type FanOutError,
  validateFanOutEvaluation,
} from "./fanout.js";
import { consumerKey, definitionGeneration, phaseId } from "./identity.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const DIGEST = sha256Digest("1".repeat(64));
const validator = { validate: () => [] };

describe("task-frontier fan-out", () => {
  it("is independent of source order and resolves generated dependencies", () => {
    const first = evaluateTaskFrontier(input([item("b", ["a"]), item("a", [])]), validator, sha256);
    const second = evaluateTaskFrontier(
      input([item("a", []), item("b", ["a"])]),
      validator,
      sha256,
    );

    expect(first.members.map(({ identity }) => identity)).toEqual(["a", "b"]);
    expect(first.taskSetDigest).toBe(second.taskSetDigest);
    expect(first.evaluationDigest).toBe(second.evaluationDigest);
    expect(validateFanOutEvaluation(first, sha256)).toEqual(first);
    expectError("invalid-fan-out", () =>
      validateFanOutEvaluation({ ...first, taskSetDigest: DIGEST }, sha256),
    );
    expect(first.members[1]?.dependencyTaskIds).toEqual([first.members[0]?.taskId]);
    expect(compareFanOutEvaluations(second, first, sha256).status).toBe("idempotent");
  });

  it("rejects duplicate or missing identities and dependency cycles", () => {
    expectError("duplicate-item-identity", () =>
      evaluateTaskFrontier(input([item("a", []), item("a", [])]), validator, sha256),
    );
    expectError("invalid-item-identity", () =>
      evaluateTaskFrontier(input([canonicalValue({ dependencies: [] })]), validator, sha256),
    );
    expectError("item-dependency-cycle", () =>
      evaluateTaskFrontier(input([item("a", ["b"]), item("b", ["a"])]), validator, sha256),
    );
  });

  it("classifies additions separately from changed and removed accepted members", () => {
    const prior = evaluateTaskFrontier(input([item("a", []), item("b", [])]), validator, sha256);
    const added = evaluateTaskFrontier(
      input([item("a", []), item("b", []), item("c", [])]),
      validator,
      sha256,
    );
    expect(compareFanOutEvaluations(added, prior, sha256)).toMatchObject({
      status: "additions",
      additions: [{ identity: "c" }],
      changes: [],
      removals: [],
    });

    const changed = evaluateTaskFrontier(
      input([item("a", []), canonicalValue({ identity: "b", dependencies: [], value: 2 })]),
      validator,
      sha256,
    );
    expect(compareFanOutEvaluations(changed, prior, sha256)).toMatchObject({
      status: "review-required",
      changes: [{ before: { identity: "b" }, after: { identity: "b" } }],
    });
  });

  it("rejects schema failures and non-canonical identities", () => {
    expectError("collection-schema-invalid", () =>
      evaluateTaskFrontier(input([item("a", [])]), { validate: () => ["invalid"] }, sha256),
    );
    expectError("invalid-item-identity", () =>
      evaluateTaskFrontier(input([item("e\u0301", [])]), validator, sha256),
    );
    expectError("invalid-item-identity", () =>
      evaluateTaskFrontier(input([item("bad\u0000identity", [])]), validator, sha256),
    );
  });

  it("detects a derived task key and ID collision", () => {
    const collidingSha256: Sha256 = { digest: () => "a".repeat(64) };
    expectError("task-identity-collision", () =>
      evaluateTaskFrontier(input([item("a", []), item("b", [])]), validator, collidingSha256),
    );
  });
});

function item(identity: string, dependencies: string[]) {
  return canonicalValue({ identity, dependencies, value: 1 });
}

function input(items: readonly ReturnType<typeof item>[]) {
  return {
    repositoryId: "repository",
    runId: "run_example",
    attemptDigest: DIGEST,
    forEachKey: consumerKey("tasks"),
    definitionDigest: DIGEST,
    sourceBindingDigest: DIGEST,
    sourceValue: canonicalValue({ tasks: items }),
    collectionPointer: "/tasks",
    collectionSchemaDigest: DIGEST,
    itemSchemaDigest: DIGEST,
    identityPointer: "/identity",
    template: {
      key: consumerKey("implement"),
      parentPhaseId: phaseId("phase_implement"),
      generation: definitionGeneration(1),
      templateDigest: DIGEST,
      inputSchemaDigest: DIGEST,
      inputMappings: [
        {
          key: consumerKey("item"),
          source: { kind: "current-item" as const, pointer: "" },
          destinationPointer: "",
        },
      ],
      dependencyIdentityPointer: "/dependencies",
    },
    sourceBindings: [],
    mappingPolicy: {
      dependencyPhases: [],
      declaredPhaseOutputs: [],
      implementationEvidenceViews: [],
      allowCurrentItem: true,
    },
    limits: {
      maxSelectedItems: 256,
      maxTotalTasks: 1024,
      maxConcurrency: 32,
      exhaustion: "escalate" as const,
    },
    acceptedTotalTasks: 0,
    graphRevisionDigest: DIGEST,
    configurationSnapshotDigest: DIGEST,
  };
}

function expectError(code: string, action: () => unknown): void {
  try {
    action();
    throw new Error("Expected fan-out failure");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as FanOutError).code).toBe(code);
  }
}
