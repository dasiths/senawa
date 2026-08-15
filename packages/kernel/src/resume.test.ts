import { describe, expect, it } from "vitest";
import { type Sha256, sha256Digest } from "./canonical.js";
import { contextId, definitionGeneration, dispatchId, taskId } from "./identity.js";
import { createAgentSessionResumeBinding, decideAgentSessionResume } from "./resume.js";

const sha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};
const DIGEST = sha256Digest("1".repeat(64));
const OTHER_DIGEST = sha256Digest("2".repeat(64));

describe("agent session resume binding", () => {
  it("resumes only an exact predecessor binding", () => {
    const binding = createAgentSessionResumeBinding(input(), sha256);
    expect(decideAgentSessionResume(binding, binding, sha256)).toMatchObject({
      action: "resume",
      mismatchFields: [],
    });
  });

  it.each([
    "promptPackDigest",
    "mappedInputDigest",
    "contextDigest",
    "graphRevisionDigest",
    "configurationSnapshotDigest",
    "modelSelectionDigest",
    "repositoryTreeDigest",
  ] as const)("starts a new session when %s differs", (field) => {
    const predecessor = createAgentSessionResumeBinding(input(), sha256);
    const requested = createAgentSessionResumeBinding(
      { ...input(), [field]: OTHER_DIGEST },
      sha256,
    );
    expect(decideAgentSessionResume(requested, predecessor, sha256)).toMatchObject({
      action: "new-session",
      mismatchFields: [field],
    });
  });

  it("does not use hidden session memory as authority", () => {
    const binding = createAgentSessionResumeBinding(input(), sha256);
    expect(Object.keys(binding)).not.toContain("memory");
    expect(decideAgentSessionResume(binding, undefined, sha256).action).toBe("new-session");
  });
});

function input() {
  return {
    predecessorDispatchId: dispatchId("dispatch_predecessor"),
    predecessorSessionId: "sdk-session",
    promptResourceDigest: DIGEST,
    promptContentDigest: DIGEST,
    promptPackDigest: DIGEST,
    mappedInputDigest: DIGEST,
    contextId: contextId("context_example"),
    contextDigest: DIGEST,
    graphRevisionDigest: DIGEST,
    configurationSnapshotDigest: DIGEST,
    taskId: taskId("task_example"),
    taskGeneration: definitionGeneration(1),
    modelSelectionDigest: DIGEST,
    repositoryCommitDigest: DIGEST,
    repositoryTreeDigest: DIGEST,
  };
}
