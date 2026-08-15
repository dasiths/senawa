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
  type ContextId,
  type DefinitionGeneration,
  type DispatchId,
  isContextId,
  isDefinitionGeneration,
  isDispatchId,
  isTaskId,
  type TaskId,
} from "./identity.js";

export const AGENT_SESSION_RESUME_BINDING_API_VERSION =
  "senawa.dev/agent-session-resume-binding/v1alpha1";

export interface AgentSessionResumeBindingInput {
  readonly predecessorDispatchId: DispatchId;
  readonly predecessorSessionId: string;
  readonly promptResourceDigest: Sha256Digest;
  readonly promptContentDigest: Sha256Digest;
  readonly promptPackDigest: Sha256Digest;
  readonly mappedInputDigest: Sha256Digest;
  readonly contextId: ContextId;
  readonly contextDigest: Sha256Digest;
  readonly graphRevisionDigest: Sha256Digest;
  readonly configurationSnapshotDigest: Sha256Digest;
  readonly taskId: TaskId;
  readonly taskGeneration: DefinitionGeneration;
  readonly modelSelectionDigest: Sha256Digest;
  readonly repositoryCommitDigest: Sha256Digest;
  readonly repositoryTreeDigest: Sha256Digest;
}

export interface AgentSessionResumeBinding extends AgentSessionResumeBindingInput {
  readonly apiVersion: typeof AGENT_SESSION_RESUME_BINDING_API_VERSION;
  readonly bindingDigest: Sha256Digest;
}

export interface AgentSessionResumeDecision {
  readonly action: "resume" | "new-session";
  readonly requestedBindingDigest: Sha256Digest;
  readonly predecessorBindingDigest?: Sha256Digest;
  readonly mismatchFields: readonly (keyof AgentSessionResumeBindingInput)[];
  readonly decisionDigest: Sha256Digest;
}

export class ResumeBindingError extends Error {
  readonly code: "invalid-resume-binding";

  constructor(message: string) {
    super(message);
    this.name = "ResumeBindingError";
    this.code = "invalid-resume-binding";
  }
}

export function createAgentSessionResumeBinding(
  input: AgentSessionResumeBindingInput,
  sha256: Sha256,
): AgentSessionResumeBinding {
  validateInput(input);
  const apiVersion = AGENT_SESSION_RESUME_BINDING_API_VERSION;
  return canonicalValue({
    apiVersion,
    ...input,
    bindingDigest: canonicalDigest(canonicalValue({ apiVersion, ...input }), sha256),
  }) as unknown as AgentSessionResumeBinding;
}

export function validateAgentSessionResumeBinding(
  value: unknown,
  sha256: Sha256,
): AgentSessionResumeBinding {
  const snapshot = canonicalValue(value) as unknown as AgentSessionResumeBinding;
  const keys = Object.keys(snapshot).sort();
  const expectedKeys = ["apiVersion", "bindingDigest", ...RESUME_FIELDS].sort();
  if (
    canonicalSerialize(canonicalValue(keys)) !== canonicalSerialize(canonicalValue(expectedKeys))
  ) {
    throw new ResumeBindingError("Agent session resume binding fields are not exact");
  }
  const input = Object.fromEntries(RESUME_FIELDS.map((field) => [field, snapshot[field]]));
  const expected = createAgentSessionResumeBinding(
    input as unknown as AgentSessionResumeBindingInput,
    sha256,
  );
  if (
    canonicalSerialize(snapshot as unknown as CanonicalValue) !==
    canonicalSerialize(canonicalValue(expected))
  ) {
    throw new ResumeBindingError("Agent session resume binding is not exact canonical authority");
  }
  return expected;
}

export function decideAgentSessionResume(
  requestedValue: unknown,
  predecessorValue: unknown | undefined,
  sha256: Sha256,
): AgentSessionResumeDecision {
  const requested = validateAgentSessionResumeBinding(requestedValue, sha256);
  const predecessor =
    predecessorValue === undefined
      ? undefined
      : validateAgentSessionResumeBinding(predecessorValue, sha256);
  const mismatchFields =
    predecessor === undefined
      ? []
      : RESUME_FIELDS.filter((field) => requested[field] !== predecessor[field]);
  const action =
    predecessor !== undefined && mismatchFields.length === 0 ? "resume" : "new-session";
  const content = {
    action,
    requestedBindingDigest: requested.bindingDigest,
    ...(predecessor === undefined ? {} : { predecessorBindingDigest: predecessor.bindingDigest }),
    mismatchFields,
  };
  return canonicalValue({
    ...content,
    decisionDigest: canonicalDigest(canonicalValue(content), sha256),
  }) as unknown as AgentSessionResumeDecision;
}

const RESUME_FIELDS = Object.freeze([
  "predecessorDispatchId",
  "predecessorSessionId",
  "promptResourceDigest",
  "promptContentDigest",
  "promptPackDigest",
  "mappedInputDigest",
  "contextId",
  "contextDigest",
  "graphRevisionDigest",
  "configurationSnapshotDigest",
  "taskId",
  "taskGeneration",
  "modelSelectionDigest",
  "repositoryCommitDigest",
  "repositoryTreeDigest",
] as const satisfies readonly (keyof AgentSessionResumeBindingInput)[]);

function validateInput(input: AgentSessionResumeBindingInput): void {
  if (
    !isDispatchId(input.predecessorDispatchId) ||
    typeof input.predecessorSessionId !== "string" ||
    input.predecessorSessionId.length === 0 ||
    input.predecessorSessionId.length > 256 ||
    !isContextId(input.contextId) ||
    !isTaskId(input.taskId) ||
    !isDefinitionGeneration(input.taskGeneration) ||
    !DIGEST_FIELDS.every((field) => isSha256Digest(input[field]))
  ) {
    throw new ResumeBindingError("Agent session resume binding fields are invalid");
  }
}

const DIGEST_FIELDS = Object.freeze([
  "promptResourceDigest",
  "promptContentDigest",
  "promptPackDigest",
  "mappedInputDigest",
  "contextDigest",
  "graphRevisionDigest",
  "configurationSnapshotDigest",
  "modelSelectionDigest",
  "repositoryCommitDigest",
  "repositoryTreeDigest",
] as const satisfies readonly (keyof AgentSessionResumeBindingInput)[]);
