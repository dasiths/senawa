import {
  type CanonicalValue,
  canonicalDigest,
  canonicalSerialize,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import {
  type DefinitionGeneration,
  isDefinitionGeneration,
  isPhaseId,
  isTaskId,
  type PhaseId,
  type TaskId,
} from "./identity.js";

export const INTEGRATION_BARRIER_API_VERSION = "senawa.dev/integration-barrier/v1alpha1";

export type GitObjectFormat = "sha1" | "sha256";

export interface GitObjectId {
  readonly objectFormat: GitObjectFormat;
  readonly oid: string;
}

export interface GitObjectBinding {
  readonly object: GitObjectId;
  readonly descriptorDigest: Sha256Digest;
}

export interface GitRevisionDescriptor {
  readonly commit: GitObjectId;
  readonly tree: GitObjectId;
}

export interface GitRevisionBinding {
  readonly revision: GitRevisionDescriptor;
  readonly descriptorDigest: Sha256Digest;
}

export interface IntegrationMemberInput {
  readonly taskId: TaskId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly contextDigest: Sha256Digest;
  readonly baseRevisionDigest: Sha256Digest;
  readonly resultTreeDigest: Sha256Digest;
  readonly completionFactDigest: Sha256Digest;
}

export interface IntegrationMember extends IntegrationMemberInput {
  readonly memberDigest: Sha256Digest;
}

export interface IntegrationBarrierInput {
  readonly phaseId: PhaseId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly graphRevisionDigest: Sha256Digest;
  readonly targetRef: string;
  readonly beforeRevision: GitRevisionDescriptor;
  readonly afterRevision: GitRevisionDescriptor;
  readonly members: readonly IntegrationMemberInput[];
  readonly gatePolicyDigest: Sha256Digest;
  readonly gateReadingDigest: Sha256Digest;
  readonly gateEvaluationDigest: Sha256Digest;
  readonly outcome: "integrated";
}

export interface IntegrationBarrier {
  readonly apiVersion: typeof INTEGRATION_BARRIER_API_VERSION;
  readonly phaseId: PhaseId;
  readonly definitionGeneration: DefinitionGeneration;
  readonly graphRevisionDigest: Sha256Digest;
  readonly targetRef: string;
  readonly targetRefDigest: Sha256Digest;
  readonly beforeRevision: GitRevisionBinding;
  readonly afterRevision: GitRevisionBinding;
  readonly members: readonly IntegrationMember[];
  readonly fanInDigest: Sha256Digest;
  readonly gatePolicyDigest: Sha256Digest;
  readonly gateReadingDigest: Sha256Digest;
  readonly gateEvaluationDigest: Sha256Digest;
  readonly outcome: "integrated";
  readonly barrierDigest: Sha256Digest;
}

export class IntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationError";
  }
}

export function bindGitObjectId(value: unknown, sha256: Sha256): GitObjectBinding {
  const object = validateGitObjectId(value);
  return canonicalValue({
    object,
    descriptorDigest: canonicalDigest(canonicalValue({ gitObject: object }), sha256),
  }) as unknown as GitObjectBinding;
}

export function bindGitRevision(value: unknown, sha256: Sha256): GitRevisionBinding {
  const snapshot = canonicalSnapshot(value, "Git revisions");
  assertExactKeys(snapshot, "Git revision", ["commit", "tree"]);
  const commit = validateGitObjectId(snapshot.commit);
  const tree = validateGitObjectId(snapshot.tree);
  if (commit.objectFormat !== tree.objectFormat) {
    throw new IntegrationError("Git revision commit and tree object formats must match");
  }
  const revision = canonicalValue({ commit, tree }) as unknown as GitRevisionDescriptor;
  return canonicalValue({
    revision,
    descriptorDigest: canonicalDigest(canonicalValue({ gitRevision: revision }), sha256),
  }) as unknown as GitRevisionBinding;
}

export function digestFanIn(
  membersValue: readonly IntegrationMemberInput[],
  sha256: Sha256,
): Sha256Digest {
  const members = compileMembers(membersValue, sha256);
  return canonicalDigest(canonicalValue({ members }), sha256);
}

export function createIntegrationBarrier(
  inputValue: IntegrationBarrierInput,
  sha256: Sha256,
): IntegrationBarrier {
  const input = canonicalSnapshot(inputValue, "Integration barriers");
  return compileIntegrationBarrier(input, sha256);
}

export function validateIntegrationBarrier(value: unknown, sha256: Sha256): IntegrationBarrier {
  const snapshot = canonicalSnapshot(value, "Integration barriers");
  assertExactKeys(snapshot, "Integration barrier", [
    "apiVersion",
    "phaseId",
    "definitionGeneration",
    "graphRevisionDigest",
    "targetRef",
    "targetRefDigest",
    "beforeRevision",
    "afterRevision",
    "members",
    "fanInDigest",
    "gatePolicyDigest",
    "gateReadingDigest",
    "gateEvaluationDigest",
    "outcome",
    "barrierDigest",
  ]);
  if (snapshot.apiVersion !== INTEGRATION_BARRIER_API_VERSION) {
    throw new IntegrationError("Integration barrier apiVersion is not recognized");
  }
  assertExactKeys(snapshot.beforeRevision, "Before revision binding", [
    "revision",
    "descriptorDigest",
  ]);
  assertExactKeys(snapshot.afterRevision, "After revision binding", [
    "revision",
    "descriptorDigest",
  ]);
  if (!Array.isArray(snapshot.members)) {
    throw new IntegrationError("Integration barrier members must be an array");
  }
  const input = {
    phaseId: snapshot.phaseId,
    definitionGeneration: snapshot.definitionGeneration,
    graphRevisionDigest: snapshot.graphRevisionDigest,
    targetRef: snapshot.targetRef,
    beforeRevision: snapshot.beforeRevision.revision,
    afterRevision: snapshot.afterRevision.revision,
    members: snapshot.members.map((member, index) => {
      assertExactKeys(member, `Integration member ${index}`, [
        "taskId",
        "definitionGeneration",
        "contextDigest",
        "baseRevisionDigest",
        "resultTreeDigest",
        "completionFactDigest",
        "memberDigest",
      ]);
      return {
        taskId: member.taskId,
        definitionGeneration: member.definitionGeneration,
        contextDigest: member.contextDigest,
        baseRevisionDigest: member.baseRevisionDigest,
        resultTreeDigest: member.resultTreeDigest,
        completionFactDigest: member.completionFactDigest,
      };
    }),
    gatePolicyDigest: snapshot.gatePolicyDigest,
    gateReadingDigest: snapshot.gateReadingDigest,
    gateEvaluationDigest: snapshot.gateEvaluationDigest,
    outcome: snapshot.outcome,
  } as unknown as IntegrationBarrierInput;
  const expected = compileIntegrationBarrier(canonicalValue(input), sha256);
  if (canonicalSerialize(snapshot) !== canonicalSerialize(canonicalValue(expected))) {
    throw new IntegrationError("Integration barrier does not match its exact source bindings");
  }
  return expected;
}

function compileIntegrationBarrier(input: CanonicalValue, sha256: Sha256): IntegrationBarrier {
  assertExactKeys(input, "Integration barrier input", [
    "phaseId",
    "definitionGeneration",
    "graphRevisionDigest",
    "targetRef",
    "beforeRevision",
    "afterRevision",
    "members",
    "gatePolicyDigest",
    "gateReadingDigest",
    "gateEvaluationDigest",
    "outcome",
  ]);
  if (!isPhaseId(input.phaseId) || !isDefinitionGeneration(input.definitionGeneration)) {
    throw new IntegrationError("Integration barrier requires a phase generation");
  }
  assertDigestFields(input, [
    "graphRevisionDigest",
    "gatePolicyDigest",
    "gateReadingDigest",
    "gateEvaluationDigest",
  ]);
  if (typeof input.targetRef !== "string" || !isFullLocalBranchRef(input.targetRef)) {
    throw new IntegrationError("Integration target must be a full refs/heads branch ref");
  }
  if (input.outcome !== "integrated") {
    throw new IntegrationError("Integration barrier outcome must be integrated");
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new IntegrationError("Integration barrier requires at least one member");
  }
  const beforeRevision = bindGitRevision(input.beforeRevision, sha256);
  const afterRevision = bindGitRevision(input.afterRevision, sha256);
  if (beforeRevision.revision.commit.objectFormat !== afterRevision.revision.commit.objectFormat) {
    throw new IntegrationError("Integration revisions must use the same Git object format");
  }
  const members = compileMembers(input.members as unknown as IntegrationMemberInput[], sha256);
  const fanInDigest = canonicalDigest(canonicalValue({ members }), sha256);
  const content = canonicalValue({
    apiVersion: INTEGRATION_BARRIER_API_VERSION,
    phaseId: input.phaseId,
    definitionGeneration: input.definitionGeneration,
    graphRevisionDigest: input.graphRevisionDigest,
    targetRef: input.targetRef,
    targetRefDigest: canonicalDigest(canonicalValue({ targetRef: input.targetRef }), sha256),
    beforeRevision,
    afterRevision,
    members,
    fanInDigest,
    gatePolicyDigest: input.gatePolicyDigest,
    gateReadingDigest: input.gateReadingDigest,
    gateEvaluationDigest: input.gateEvaluationDigest,
    outcome: input.outcome,
  });
  return canonicalValue({
    ...(content as unknown as Record<string, CanonicalValue>),
    barrierDigest: canonicalDigest(content, sha256),
  }) as unknown as IntegrationBarrier;
}

function compileMembers(
  membersValue: readonly IntegrationMemberInput[],
  sha256: Sha256,
): readonly IntegrationMember[] {
  const snapshot = canonicalSnapshot(membersValue, "Integration members");
  if (!Array.isArray(snapshot)) throw new IntegrationError("Integration members must be an array");
  if (snapshot.length === 0) throw new IntegrationError("Integration members must not be empty");
  const members = snapshot.map((member, index) => {
    assertExactKeys(member, `Integration member input ${index}`, [
      "taskId",
      "definitionGeneration",
      "contextDigest",
      "baseRevisionDigest",
      "resultTreeDigest",
      "completionFactDigest",
    ]);
    if (!isTaskId(member.taskId) || !isDefinitionGeneration(member.definitionGeneration)) {
      throw new IntegrationError(`Integration member ${index} requires a task generation`);
    }
    assertDigestFields(member, [
      "contextDigest",
      "baseRevisionDigest",
      "resultTreeDigest",
      "completionFactDigest",
    ]);
    const content = canonicalValue(member) as unknown as IntegrationMemberInput;
    return canonicalValue({
      ...content,
      memberDigest: canonicalDigest(canonicalValue(content), sha256),
    }) as unknown as IntegrationMember;
  });
  members.sort((left, right) => compareText(left.taskId, right.taskId));
  if (new Set(members.map((member) => member.taskId)).size !== members.length) {
    throw new IntegrationError("Integration members must contain each task at most once");
  }
  return Object.freeze(members);
}

function validateGitObjectId(value: unknown): GitObjectId {
  const snapshot = canonicalSnapshot(value, "Git object IDs");
  assertExactKeys(snapshot, "Git object ID", ["objectFormat", "oid"]);
  if (snapshot.objectFormat !== "sha1" && snapshot.objectFormat !== "sha256") {
    throw new IntegrationError("Git object format must be sha1 or sha256");
  }
  const length = snapshot.objectFormat === "sha1" ? 40 : 64;
  if (
    typeof snapshot.oid !== "string" ||
    !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(snapshot.oid)
  ) {
    throw new IntegrationError(
      `Git ${snapshot.objectFormat} object IDs must contain ${length} lowercase hexadecimal characters`,
    );
  }
  return snapshot as unknown as GitObjectId;
}

function assertDigestFields(value: Record<string, unknown>, fields: readonly string[]): void {
  for (const field of fields) {
    if (!isSha256Digest(value[field])) {
      throw new IntegrationError(`${field} must be a Senawa SHA-256 digest`);
    }
  }
}

function canonicalSnapshot(value: unknown, label: string): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    throw new IntegrationError(`${label} must contain only canonical values`);
  }
}

function assertExactKeys(
  value: unknown,
  label: string,
  expectedKeys: readonly string[],
): asserts value is Record<string, CanonicalValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntegrationError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new IntegrationError(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function isFullLocalBranchRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.length > 1_024 || value.includes(".."))
    return false;
  if (
    value.includes("@{") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x21 || code === 0x7f;
    })
  ) {
    return false;
  }
  if (["~", "^", ":", "?", "*", "[", "\\"].some((character) => value.includes(character))) {
    return false;
  }
  return value
    .slice("refs/heads/".length)
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        component !== "." &&
        component !== ".." &&
        !component.startsWith(".") &&
        !component.endsWith(".") &&
        !component.endsWith(".lock"),
    );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
