import { describe, expect, it } from "vitest";
import { type Sha256, sha256Digest } from "./canonical.js";
import { definitionGeneration, phaseId, taskId } from "./identity.js";
import {
  bindGitObjectId,
  bindGitRevision,
  createIntegrationBarrier,
  digestFanIn,
  type IntegrationBarrier,
  type IntegrationBarrierInput,
  IntegrationError,
  type IntegrationMemberInput,
  validateIntegrationBarrier,
} from "./integration.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const digest = (character: string) => sha256Digest(character.repeat(64));

describe("Git descriptor bindings", () => {
  it("keeps raw object formats separate from Senawa SHA-256 descriptor digests", () => {
    const object = bindGitObjectId(
      { objectFormat: "sha1", oid: "a".repeat(40) },
      deterministicSha256,
    );
    const revision = bindGitRevision(
      {
        commit: { objectFormat: "sha1", oid: "b".repeat(40) },
        tree: { objectFormat: "sha1", oid: "c".repeat(40) },
      },
      deterministicSha256,
    );

    expect(object.object.oid).toHaveLength(40);
    expect(object.descriptorDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(revision.revision.commit.oid).toHaveLength(40);
    expect(revision.descriptorDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    { objectFormat: "sha1", oid: "a".repeat(64) },
    { objectFormat: "sha256", oid: "a".repeat(40) },
    { objectFormat: "sha1", oid: "A".repeat(40) },
    { objectFormat: "md5", oid: "a".repeat(40) },
  ])("rejects invalid raw Git object descriptor %#", (object) => {
    expect(() => bindGitObjectId(object, deterministicSha256)).toThrow(IntegrationError);
  });

  it("rejects revisions that mix Git object formats", () => {
    expect(() =>
      bindGitRevision(
        {
          commit: { objectFormat: "sha1", oid: "a".repeat(40) },
          tree: { objectFormat: "sha256", oid: "b".repeat(64) },
        },
        deterministicSha256,
      ),
    ).toThrow(IntegrationError);
  });
});

describe("integration barriers", () => {
  it("produces identical sorted fan-in and barriers for every member completion permutation", () => {
    const members = integrationMembers();
    const barriers = permutations(members).map((orderedMembers) =>
      createIntegrationBarrier(
        { ...integrationInput(), members: orderedMembers },
        deterministicSha256,
      ),
    );

    expect(barriers).toHaveLength(6);
    for (const barrier of barriers) {
      expect(barrier).toEqual(barriers[0]);
      expect(barrier.members.map(({ taskId: id }) => id)).toEqual([
        "task_alpha",
        "task_beta",
        "task_gamma",
      ]);
      expect(barrier.fanInDigest).toBe(digestFanIn(members, deterministicSha256));
      expect(validateIntegrationBarrier(barrier, deterministicSha256)).toEqual(barrier);
      expect(Object.isFrozen(barrier)).toBe(true);
      expect(Object.isFrozen(barrier.members)).toBe(true);
    }
  });

  const tamperCases: ReadonlyArray<readonly [string, (barrier: MutableBarrier) => void]> = [
    [
      "graph",
      (barrier) => {
        barrier.graphRevisionDigest = digest("f");
      },
    ],
    [
      "target ref",
      (barrier) => {
        barrier.targetRef = "refs/heads/other";
      },
    ],
    [
      "target ref digest",
      (barrier) => {
        barrier.targetRefDigest = digest("f");
      },
    ],
    [
      "before revision",
      (barrier) => {
        barrier.beforeRevision.revision.commit.oid = "f".repeat(40);
      },
    ],
    [
      "before descriptor digest",
      (barrier) => {
        barrier.beforeRevision.descriptorDigest = digest("f");
      },
    ],
    [
      "after revision",
      (barrier) => {
        barrier.afterRevision.revision.tree.oid = "e".repeat(40);
      },
    ],
    [
      "member context",
      (barrier) => {
        required(barrier.members[0]).contextDigest = digest("f");
      },
    ],
    [
      "member result tree",
      (barrier) => {
        required(barrier.members[0]).resultTreeDigest = digest("f");
      },
    ],
    [
      "member completion fact",
      (barrier) => {
        required(barrier.members[0]).completionFactDigest = digest("f");
      },
    ],
    [
      "member digest",
      (barrier) => {
        required(barrier.members[0]).memberDigest = digest("f");
      },
    ],
    [
      "fan-in",
      (barrier) => {
        barrier.fanInDigest = digest("f");
      },
    ],
    [
      "gate policy",
      (barrier) => {
        barrier.gatePolicyDigest = digest("f");
      },
    ],
    [
      "gate reading",
      (barrier) => {
        barrier.gateReadingDigest = digest("f");
      },
    ],
    [
      "gate evaluation",
      (barrier) => {
        barrier.gateEvaluationDigest = digest("f");
      },
    ],
    [
      "barrier digest",
      (barrier) => {
        barrier.barrierDigest = digest("f");
      },
    ],
  ];

  it.each(tamperCases)("rejects %s tampering", (_name, mutate) => {
    const barrier = mutableBarrier(
      createIntegrationBarrier(integrationInput(), deterministicSha256),
    );
    mutate(barrier);

    expect(() => validateIntegrationBarrier(barrier, deterministicSha256)).toThrow(
      IntegrationError,
    );
  });

  it.each(["main", "refs/tags/release", "refs/heads/.hidden", "refs/heads/a..b"])(
    "rejects invalid integration ref %s",
    (targetRef) => {
      expect(() =>
        createIntegrationBarrier({ ...integrationInput(), targetRef }, deterministicSha256),
      ).toThrow(IntegrationError);
    },
  );

  it("rejects duplicate task membership and extra completion-order metadata", () => {
    const duplicate = integrationInput();
    duplicate.members = [
      duplicate.members[0] as IntegrationMemberInput,
      duplicate.members[0] as IntegrationMemberInput,
    ];
    expect(() => createIntegrationBarrier(duplicate, deterministicSha256)).toThrow(
      IntegrationError,
    );

    const extra = integrationInput();
    extra.members = extra.members.map((member, completionOrder) => ({
      ...member,
      completionOrder,
    })) as unknown as IntegrationMemberInput[];
    expect(() => createIntegrationBarrier(extra, deterministicSha256)).toThrow(IntegrationError);
    expect(() => digestFanIn([], deterministicSha256)).toThrow(IntegrationError);
  });
});

function integrationInput(): MutableIntegrationInput {
  return {
    phaseId: phaseId("phase_delivery"),
    definitionGeneration: definitionGeneration(1),
    graphRevisionDigest: digest("1"),
    targetRef: "refs/heads/senawa/integration",
    beforeRevision: {
      commit: { objectFormat: "sha1", oid: "1".repeat(40) },
      tree: { objectFormat: "sha1", oid: "2".repeat(40) },
    },
    afterRevision: {
      commit: { objectFormat: "sha1", oid: "3".repeat(40) },
      tree: { objectFormat: "sha1", oid: "4".repeat(40) },
    },
    members: integrationMembers(),
    gatePolicyDigest: digest("5"),
    gateReadingDigest: digest("6"),
    gateEvaluationDigest: digest("7"),
    outcome: "integrated",
  };
}

function integrationMembers(): IntegrationMemberInput[] {
  return ["alpha", "beta", "gamma"].map((name, index) => ({
    taskId: taskId(`task_${name}`),
    definitionGeneration: definitionGeneration(1),
    contextDigest: digest(String(index + 1)),
    baseRevisionDigest: digest("8"),
    resultTreeDigest: digest(String(index + 4)),
    completionFactDigest: digest(String(index + 7)),
  }));
}

function permutations<Value>(values: readonly Value[]): Value[][] {
  if (values.length === 0) return [[]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [
      value,
      ...tail,
    ]),
  );
}

function mutableBarrier(value: IntegrationBarrier): MutableBarrier {
  return JSON.parse(JSON.stringify(value)) as MutableBarrier;
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

type MutableIntegrationInput = {
  -readonly [Key in keyof IntegrationBarrierInput]: Key extends "members"
    ? IntegrationMemberInput[]
    : IntegrationBarrierInput[Key];
};

type DeepMutable<Value> = Value extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
    : Value;

type MutableBarrier = DeepMutable<IntegrationBarrier>;
