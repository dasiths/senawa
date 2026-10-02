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
  type DataMappingDeclaration,
  evaluateDataMappings,
  type MappingEvaluationPolicy,
  type MappingSourceBinding,
  valueAtJsonPointer,
} from "./dataflow.js";
import {
  type ConsumerKey,
  consumerKey,
  type DefinitionGeneration,
  isConsumerKey,
  isDefinitionGeneration,
  isTaskId,
  type PhaseId,
  type TaskId,
  taskId,
} from "./identity.js";

export const FAN_OUT_EVALUATION_API_VERSION = "senawa.dev/fan-out-evaluation/v1";
const MAX_IDENTITY_BYTES = 256;
const UTF8 = new TextEncoder();

export interface FanOutLimits {
  readonly maxSelectedItems: number;
  readonly maxTotalTasks: number;
  readonly maxConcurrency: number;
  readonly exhaustion: "escalate" | "fail";
}

export interface FanOutTaskTemplate {
  readonly key: ConsumerKey;
  readonly parentPhaseId: PhaseId;
  readonly generation: DefinitionGeneration;
  readonly templateDigest: Sha256Digest;
  readonly inputSchemaDigest: Sha256Digest;
  readonly inputMappings: readonly DataMappingDeclaration[];
  readonly dependencyIdentityPointer?: string;
}

export interface FanOutEvaluationInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly attemptDigest: Sha256Digest;
  readonly forEachKey: ConsumerKey;
  readonly definitionDigest: Sha256Digest;
  readonly sourceBindingDigest: Sha256Digest;
  readonly sourceValue: CanonicalValue;
  readonly collectionPointer: string;
  readonly collectionSchemaDigest: Sha256Digest;
  readonly itemSchemaDigest: Sha256Digest;
  readonly identityPointer: string;
  readonly template: FanOutTaskTemplate;
  readonly sourceBindings: readonly MappingSourceBinding[];
  readonly mappingPolicy: MappingEvaluationPolicy;
  readonly limits: FanOutLimits;
  readonly acceptedTotalTasks: number;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
}

export interface FanOutSchemaValidator {
  validate(schemaDigest: Sha256Digest, value: CanonicalValue): readonly unknown[];
}

export interface FanOutMember {
  readonly identity: string;
  readonly itemDigest: Sha256Digest;
  readonly taskKey: ConsumerKey;
  readonly taskId: TaskId;
  readonly generation: DefinitionGeneration;
  readonly dependencyIdentities: readonly string[];
  readonly dependencyTaskIds: readonly TaskId[];
  readonly input: CanonicalValue;
  readonly inputDigest: Sha256Digest;
  readonly mappingSetDigest: Sha256Digest;
  readonly memberDigest: Sha256Digest;
}

export interface FanOutEvaluation {
  readonly apiVersion: typeof FAN_OUT_EVALUATION_API_VERSION;
  readonly repositoryId: string;
  readonly runId: string;
  readonly attemptDigest: Sha256Digest;
  readonly forEachKey: ConsumerKey;
  readonly definitionDigest: Sha256Digest;
  readonly sourceBindingDigest: Sha256Digest;
  readonly collectionDigest: Sha256Digest;
  readonly collectionSchemaDigest: Sha256Digest;
  readonly itemSchemaDigest: Sha256Digest;
  readonly identityPointer: string;
  readonly templateDigest: Sha256Digest;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly limits: FanOutLimits;
  readonly members: readonly FanOutMember[];
  readonly taskSetDigest: Sha256Digest;
  readonly evaluationDigest: Sha256Digest;
}

export interface FanOutDiff {
  readonly status: "idempotent" | "additions" | "review-required";
  readonly additions: readonly FanOutMember[];
  readonly changes: readonly Readonly<{
    readonly before: FanOutMember;
    readonly after: FanOutMember;
  }>[];
  readonly removals: readonly FanOutMember[];
  readonly priorEvaluationDigest?: Sha256Digest;
  readonly evaluationDigest: Sha256Digest;
  readonly diffDigest: Sha256Digest;
}

export type FanOutErrorCode =
  | "invalid-fan-out"
  | "fan-out-bound-exceeded"
  | "collection-schema-invalid"
  | "item-schema-invalid"
  | "task-input-schema-invalid"
  | "invalid-item-identity"
  | "duplicate-item-identity"
  | "unknown-item-dependency"
  | "item-dependency-cycle"
  | "task-identity-collision";

export class FanOutError extends Error {
  readonly code: FanOutErrorCode;

  constructor(code: FanOutErrorCode, message: string) {
    super(message);
    this.name = "FanOutError";
    this.code = code;
  }
}

export function evaluateTaskFrontier(
  input: FanOutEvaluationInput,
  validator: FanOutSchemaValidator,
  sha256: Sha256,
): FanOutEvaluation {
  validateLimits(input.limits);
  const collection = valueAtJsonPointer(input.sourceValue, input.collectionPointer);
  if (!Array.isArray(collection)) fail("invalid-fan-out", "Fan-out selection must be an array");
  if (validator.validate(input.collectionSchemaDigest, collection).length > 0) {
    fail("collection-schema-invalid", "Fan-out selection does not satisfy its collection schema");
  }
  if (collection.length > input.limits.maxSelectedItems) {
    fail("fan-out-bound-exceeded", "Fan-out selection exceeds maxSelectedItems");
  }
  if (input.acceptedTotalTasks + collection.length > input.limits.maxTotalTasks) {
    fail("fan-out-bound-exceeded", "Fan-out selection exceeds maxTotalTasks");
  }

  const selected = collection.map((item) => {
    if (validator.validate(input.itemSchemaDigest, item).length > 0) {
      fail("item-schema-invalid", "Fan-out item does not satisfy its item schema");
    }
    let identity: string;
    try {
      identity = stableIdentity(valueAtJsonPointer(item, input.identityPointer));
    } catch (error) {
      if (error instanceof FanOutError) throw error;
      fail("invalid-item-identity", "Fan-out identity pointer does not select a value");
    }
    const dependencyIdentities =
      input.template.dependencyIdentityPointer === undefined
        ? []
        : dependencyIdentitiesAt(item, input.template.dependencyIdentityPointer);
    return { identity, item, dependencyIdentities };
  });
  selected.sort((left, right) => compareUtf8(left.identity, right.identity));
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index - 1]?.identity === selected[index]?.identity) {
      fail(
        "duplicate-item-identity",
        `Fan-out identity ${selected[index]?.identity} is duplicated`,
      );
    }
  }

  const identitySet = new Set(selected.map(({ identity }) => identity));
  for (const item of selected) {
    for (const dependency of item.dependencyIdentities) {
      if (!identitySet.has(dependency)) {
        fail("unknown-item-dependency", `Fan-out dependency ${dependency} is not selected`);
      }
    }
  }
  assertAcyclic(selected);

  const taskIdentityByItem = new Map<string, { taskKey: ConsumerKey; taskId: TaskId }>();
  const seenTaskKeys = new Map<string, string>();
  const seenTaskIds = new Map<string, string>();
  for (const { identity } of selected) {
    const identityDigest = canonicalDigest(canonicalValue({ identity }), sha256);
    const taskKey = consumerKey(`${input.template.key}-${identityDigest.slice(0, 16)}`);
    const task = taskId(`task_${identityDigest}`);
    assertTaskIdentityCollision(seenTaskKeys, taskKey, identity);
    assertTaskIdentityCollision(seenTaskIds, task, identity);
    taskIdentityByItem.set(identity, { taskKey, taskId: task });
  }

  const members = selected.map(({ identity, item, dependencyIdentities }) => {
    const currentItemBinding: MappingSourceBinding = {
      source: { kind: "current-item" },
      sourceBindingDigest: canonicalDigest(
        canonicalValue({ sourceBindingDigest: input.sourceBindingDigest, identity }),
        sha256,
      ),
      value: item,
    };
    const mapped = evaluateDataMappings(
      input.template.inputMappings,
      [...input.sourceBindings, currentItemBinding],
      { ...input.mappingPolicy, allowCurrentItem: true },
      sha256,
    );
    if (validator.validate(input.template.inputSchemaDigest, mapped.value).length > 0) {
      fail("task-input-schema-invalid", `Generated input for ${identity} is schema-invalid`);
    }
    const taskIdentity = taskIdentityByItem.get(identity);
    if (taskIdentity === undefined) fail("invalid-fan-out", "Generated task identity is missing");
    const dependencyTaskIds = dependencyIdentities.map((dependency) => {
      const resolved = taskIdentityByItem.get(dependency);
      if (resolved === undefined) fail("unknown-item-dependency", "Dependency task is missing");
      return resolved.taskId;
    });
    const content = {
      identity,
      itemDigest: canonicalDigest(item, sha256),
      taskKey: taskIdentity.taskKey,
      taskId: taskIdentity.taskId,
      generation: input.template.generation,
      dependencyIdentities,
      dependencyTaskIds,
      input: mapped.value,
      inputDigest: mapped.contentDigest,
      mappingSetDigest: mapped.sourceSetDigest,
    };
    return canonicalValue({
      ...content,
      memberDigest: canonicalDigest(canonicalValue(content), sha256),
    }) as unknown as FanOutMember;
  });
  const collectionDigest = canonicalDigest(
    canonicalValue({
      items: selected.map(({ identity, item }) => ({
        identity,
        itemDigest: canonicalDigest(item, sha256),
      })),
    }),
    sha256,
  );
  const taskSetDigest = canonicalDigest(
    canonicalValue({ members: members.map(({ memberDigest }) => memberDigest) }),
    sha256,
  );
  const content = {
    repositoryId: input.repositoryId,
    runId: input.runId,
    attemptDigest: input.attemptDigest,
    forEachKey: input.forEachKey,
    definitionDigest: input.definitionDigest,
    sourceBindingDigest: input.sourceBindingDigest,
    collectionDigest,
    collectionSchemaDigest: input.collectionSchemaDigest,
    itemSchemaDigest: input.itemSchemaDigest,
    identityPointer: input.identityPointer,
    templateDigest: input.template.templateDigest,
    graphRevisionDigest: input.graphRevisionDigest,
    configurationSnapshotDigest: input.configurationSnapshotDigest,
    limits: input.limits,
    members,
    taskSetDigest,
  };
  const apiVersion = FAN_OUT_EVALUATION_API_VERSION;
  return canonicalValue({
    apiVersion,
    ...content,
    evaluationDigest: canonicalDigest(canonicalValue({ apiVersion, ...content }), sha256),
  }) as unknown as FanOutEvaluation;
}

export function compareFanOutEvaluations(
  current: FanOutEvaluation,
  prior: FanOutEvaluation | undefined,
  sha256: Sha256,
): FanOutDiff {
  const priorByIdentity = new Map(prior?.members.map((member) => [member.identity, member]));
  const currentByIdentity = new Map(current.members.map((member) => [member.identity, member]));
  const additions = current.members.filter((member) => !priorByIdentity.has(member.identity));
  const changes = current.members.flatMap((member) => {
    const before = priorByIdentity.get(member.identity);
    return before !== undefined && before.memberDigest !== member.memberDigest
      ? [{ before, after: member }]
      : [];
  });
  const removals = prior?.members.filter((member) => !currentByIdentity.has(member.identity)) ?? [];
  const status =
    changes.length > 0 || removals.length > 0
      ? "review-required"
      : additions.length > 0
        ? "additions"
        : "idempotent";
  const content = {
    status,
    additions,
    changes,
    removals,
    ...(prior === undefined ? {} : { priorEvaluationDigest: prior.evaluationDigest }),
    evaluationDigest: current.evaluationDigest,
  };
  return canonicalValue({
    ...content,
    diffDigest: canonicalDigest(canonicalValue(content), sha256),
  }) as unknown as FanOutDiff;
}

export function validateFanOutEvaluation(value: unknown, sha256: Sha256): FanOutEvaluation {
  const snapshot = canonicalValue(value) as unknown as FanOutEvaluation;
  const keys = [
    "apiVersion",
    "repositoryId",
    "runId",
    "attemptDigest",
    "forEachKey",
    "definitionDigest",
    "sourceBindingDigest",
    "collectionDigest",
    "collectionSchemaDigest",
    "itemSchemaDigest",
    "identityPointer",
    "templateDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "limits",
    "members",
    "taskSetDigest",
    "evaluationDigest",
  ].sort();
  if (
    snapshot.apiVersion !== FAN_OUT_EVALUATION_API_VERSION ||
    canonicalSerialize(canonicalValue(Object.keys(snapshot).sort())) !==
      canonicalSerialize(canonicalValue(keys)) ||
    !Array.isArray(snapshot.members)
  ) {
    fail("invalid-fan-out", "Persisted fan-out evaluation shape is invalid");
  }
  validateLimits(snapshot.limits);
  const members = snapshot.members.map((member) => validateMember(member, sha256));
  const identities = members.map(({ identity }) => identity);
  if (
    identities.some(
      (identity, index) => index > 0 && compareUtf8(identities[index - 1] ?? "", identity) >= 0,
    ) ||
    new Set(members.map(({ taskKey }) => taskKey)).size !== members.length ||
    new Set(members.map(({ taskId }) => taskId)).size !== members.length
  ) {
    fail("invalid-fan-out", "Persisted fan-out members are not uniquely identity-sorted");
  }
  const taskSetDigest = canonicalDigest(
    canonicalValue({ members: members.map(({ memberDigest }) => memberDigest) }),
    sha256,
  );
  if (snapshot.taskSetDigest !== taskSetDigest) {
    fail("invalid-fan-out", "Persisted fan-out task set digest is invalid");
  }
  const { evaluationDigest: _evaluationDigest, ...content } = snapshot;
  const expectedDigest = canonicalDigest(canonicalValue(content), sha256);
  if (snapshot.evaluationDigest !== expectedDigest) {
    fail("invalid-fan-out", "Persisted fan-out evaluation digest is invalid");
  }
  return canonicalValue(snapshot) as unknown as FanOutEvaluation;
}

function validateMember(value: FanOutMember, sha256: Sha256): FanOutMember {
  const member = canonicalValue(value) as unknown as FanOutMember;
  const keys = [
    "identity",
    "itemDigest",
    "taskKey",
    "taskId",
    "generation",
    "dependencyIdentities",
    "dependencyTaskIds",
    "input",
    "inputDigest",
    "mappingSetDigest",
    "memberDigest",
  ].sort();
  if (
    canonicalSerialize(canonicalValue(Object.keys(member).sort())) !==
      canonicalSerialize(canonicalValue(keys)) ||
    !isSha256Digest(member.itemDigest) ||
    !isSha256Digest(member.inputDigest) ||
    !isSha256Digest(member.mappingSetDigest) ||
    !isSha256Digest(member.memberDigest) ||
    stableIdentity(member.identity) !== member.identity ||
    !isConsumerKey(member.taskKey) ||
    !isTaskId(member.taskId) ||
    !isDefinitionGeneration(member.generation) ||
    !Array.isArray(member.dependencyIdentities) ||
    !Array.isArray(member.dependencyTaskIds) ||
    canonicalDigest(member.input, sha256) !== member.inputDigest
  ) {
    fail("invalid-fan-out", "Persisted fan-out member shape is invalid");
  }
  const { memberDigest: _memberDigest, ...content } = member;
  if (canonicalDigest(canonicalValue(content), sha256) !== member.memberDigest) {
    fail("invalid-fan-out", "Persisted fan-out member digest is invalid");
  }
  return member;
}

function stableIdentity(value: unknown): string {
  if (typeof value !== "string") fail("invalid-item-identity", "Fan-out identity must be a string");
  const normalized = value.normalize("NFC");
  if (
    normalized !== value ||
    UTF8.encode(value).byteLength > MAX_IDENTITY_BYTES ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    fail("invalid-item-identity", "Fan-out identity must be NFC, control-free, and bounded");
  }
  return value;
}

function dependencyIdentitiesAt(item: CanonicalValue, pointer: string): string[] {
  // An item that says nothing depends on nothing. Requiring every item to carry
  // an empty list would make the common fan-out, over items with no ordering,
  // the one that needs extra authoring.
  let value: unknown;
  try {
    value = valueAtJsonPointer(item, pointer);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) fail("invalid-fan-out", "Item dependencies must be an array");
  const identities = value.map(stableIdentity).sort(compareUtf8);
  if (new Set(identities).size !== identities.length) {
    fail("invalid-fan-out", "Item dependencies must be unique");
  }
  return identities;
}

function assertAcyclic(
  items: readonly { identity: string; dependencyIdentities: readonly string[] }[],
): void {
  const dependencies = new Map(items.map((item) => [item.identity, item.dependencyIdentities]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (identity: string): void => {
    if (visiting.has(identity))
      fail("item-dependency-cycle", "Fan-out item dependencies contain a cycle");
    if (visited.has(identity)) return;
    visiting.add(identity);
    for (const dependency of dependencies.get(identity) ?? []) visit(dependency);
    visiting.delete(identity);
    visited.add(identity);
  };
  for (const { identity } of items) visit(identity);
}

function assertTaskIdentityCollision(
  seen: Map<string, string>,
  value: string,
  identity: string,
): void {
  const owner = seen.get(value);
  if (owner !== undefined && owner !== identity) {
    fail("task-identity-collision", "Distinct fan-out identities derived the same task identity");
  }
  seen.set(value, identity);
}

function validateLimits(limits: FanOutLimits): void {
  if (
    !Number.isSafeInteger(limits.maxSelectedItems) ||
    limits.maxSelectedItems < 1 ||
    limits.maxSelectedItems > 256 ||
    !Number.isSafeInteger(limits.maxTotalTasks) ||
    limits.maxTotalTasks < 1 ||
    limits.maxTotalTasks > 1024 ||
    !Number.isSafeInteger(limits.maxConcurrency) ||
    limits.maxConcurrency < 1 ||
    limits.maxConcurrency > 32 ||
    !["escalate", "fail"].includes(limits.exhaustion)
  ) {
    fail("invalid-fan-out", "Fan-out limits exceed the v1 contract");
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8.encode(left);
  const rightBytes = UTF8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function fail(code: FanOutErrorCode, message: string): never {
  throw new FanOutError(code, message);
}
