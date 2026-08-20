import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./contracts.js";
import {
  decodePortalAgentPage,
  decodePortalAllowanceReview,
  decodePortalArtifactContent,
  decodePortalDeliveryPage,
  decodePortalEventWindow,
  decodePortalGraphNodePage,
  decodePortalQuestionRecord,
  decodePortalRepositoryPage,
  decodePortalRunOverview,
  decodePortalSessionDescriptor,
  decodePortalTranscriptPage,
  decodePortalTranscriptRecord,
  encodePortalTranscriptRecord,
} from "./portal-codec.js";
import { PORTAL_CAPABILITIES, PORTAL_LIMITS, TRANSCRIPT_LIMITS } from "./portal-contracts.js";

const digest = "a".repeat(64);
const timestamp = "2026-08-14T12:00:00.000Z";

function sync() {
  return {
    workflowCursor: 1,
    contextRevision: 2,
    runnerRevision: 3,
    workspaceRevision: 4,
    humanRevision: 5,
    portalRevision: 6,
    transcriptRevision: 8,
    graphRevision: digest,
    lifecycleRevision: 7,
  };
}

describe("portal codecs", () => {
  it("decodes one exact allowance projection and rejects tampered authority facts", () => {
    const review = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      escalationCommandId: "runner-command_alpha",
      escalationDigest: digest,
      operationId: "operation_alpha",
      unit: "model-millidollars",
      requested: 5,
      available: 1,
      createdAt: timestamp,
      currentLimit: 10,
      maxIncrease: 15,
      ceiling: 25,
      allowancePolicyDigest: "b".repeat(64),
      resultingMax: 25,
      expectedGraphRevision: "c".repeat(64),
      expectedRunMode: "paused",
      expectedRunModeRevision: 3,
    } as const;
    expect(decodePortalAllowanceReview(review)).toEqual(review);
    for (const key of ["allowancePolicyDigest", "currentLimit", "expectedGraphRevision"] as const) {
      const tampered = { ...review } as Record<string, unknown>;
      delete tampered[key];
      expect(() => decodePortalAllowanceReview(tampered)).toThrow(/required/);
    }
    expect(() => decodePortalAllowanceReview({ ...review, maxIncrease: 16 })).toThrow(
      /ceiling minus currentLimit/,
    );
    expect(() => decodePortalAllowanceReview({ ...review, expectedRunMode: "ending" })).toThrow(
      /expectedRunMode/,
    );
    expect(() => decodePortalAllowanceReview({ ...review, clientCeiling: 25 })).toThrow(
      /clientCeiling.*not allowed/,
    );
  });

  it("decodes exact session and overview vectors without exposing session secrets", () => {
    expect(
      decodePortalSessionDescriptor({
        apiVersion: PROTOCOL_VERSION,
        expiresAt: timestamp,
        csrfMode: "read-only",
        capabilities: PORTAL_CAPABILITIES,
      }),
    ).toMatchObject({ csrfMode: "read-only" });
    expect(
      decodePortalRunOverview({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        displayName: "Run alpha",
        workflowName: "standard",
        mode: "running",
        runModeRevision: 0,
        terminal: false,
        updatedAt: timestamp,
        sync: sync(),
        counts: {
          phases: 1,
          tasks: 2,
          criteria: 3,
          humanNeeds: 0,
          activeEffects: 1,
          uncertainEffects: 0,
        },
      }).sync,
    ).toEqual(sync());
    expect(() =>
      decodePortalSessionDescriptor({
        apiVersion: PROTOCOL_VERSION,
        expiresAt: timestamp,
        csrfMode: "available",
        capabilities: [],
        token: "secret",
      }),
    ).toThrow(/token.*not allowed/);
  });

  it("requires lexical discovery and revision-bound graph pages capped at 200", () => {
    expect(() =>
      decodePortalRepositoryPage({
        apiVersion: PROTOCOL_VERSION,
        after: "repository_z",
        hasMore: false,
        repositories: [
          { repositoryId: "repository_a", displayName: "A", portalRevision: 1, runCount: 1 },
        ],
      }),
    ).toThrow(/lexically ascending/);

    const node = {
      nodeId: "task_a",
      kind: "task",
      title: "Task",
      definitionGeneration: 1,
      lifecycle: "ready",
      runState: "running",
      humanNeedCount: 0,
      evidenceCount: 0,
    };
    expect(
      decodePortalGraphNodePage({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        graphRevision: digest,
        after: 0,
        nextAfter: 1,
        hasMore: false,
        nodes: [node],
      }).nodes,
    ).toHaveLength(1);
    expect(() =>
      decodePortalGraphNodePage({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        graphRevision: digest,
        after: 0,
        nextAfter: PORTAL_LIMITS.maxGraphItems + 1,
        hasMore: false,
        nodes: Array.from({ length: PORTAL_LIMITS.maxGraphItems + 1 }, (_, index) => ({
          ...node,
          nodeId: `task_${index}`,
        })),
      }),
    ).toThrow(/at most 200/);
    expect(() =>
      decodePortalGraphNodePage({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        graphRevision: digest,
        after: 0,
        nextAfter: 1,
        hasMore: false,
        nodes: [{ ...node, normalizedInput: Array.from({ length: 10_000 }, () => null) }],
      }),
    ).toThrow(/10000 nodes/);
    const nodePage = (entry: Record<string, unknown>) => ({
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      graphRevision: digest,
      after: 0,
      nextAfter: 1,
      hasMore: false,
      nodes: [entry],
    });
    expect(
      decodePortalGraphNodePage(
        nodePage({ ...node, runState: "awaiting-human", attempt: 3, roleKey: "implementer" }),
      ).nodes[0],
    ).toMatchObject({ runState: "awaiting-human", attempt: 3, roleKey: "implementer" });
    expect(() => decodePortalGraphNodePage(nodePage({ ...node, runState: "queued" }))).toThrow(
      /runState must be one of/,
    );
    expect(() => decodePortalGraphNodePage(nodePage({ ...node, attempt: 0 }))).toThrow(
      /attempt must be a safe integer of at least 1/,
    );
    expect(() => decodePortalGraphNodePage(nodePage({ ...node, roleKey: "Implementer" }))).toThrow(
      /roleKey must be a lowercase consumer key/,
    );
    expect(() => decodePortalGraphNodePage(nodePage({ ...node, roleKey: "a".repeat(64) }))).toThrow(
      /roleKey must contain 1-63/,
    );
    expect(() => decodePortalGraphNodePage(nodePage({ ...node, runningState: "running" }))).toThrow(
      /runningState is not allowed/,
    );
    const { runState: _omitted, ...withoutRunState } = node;
    expect(() => decodePortalGraphNodePage(nodePage(withoutRunState))).toThrow(
      /runState is required/,
    );
  });

  it("accepts bounded delivery metadata and rejects body-bearing records", () => {
    const page = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      dataflowRevision: 7,
      taskFrontierRevision: 4,
      after: 0,
      nextAfter: 2,
      hasMore: false,
      records: [
        {
          identity: digest,
          kind: "phase-output",
          phaseId: "phase_plan",
          attempt: 1,
          outputName: "plan",
          schemaKey: "plan-output",
          contentDigest: "b".repeat(64),
          byteLength: 120,
          sensitivity: "internal",
          accepted: true,
        },
        {
          identity: "c".repeat(64),
          kind: "plan-import",
          evaluationDigest: "d".repeat(64),
          proposalDigest: "e".repeat(64),
          applicationDigest: "f".repeat(64),
          state: "applied",
        },
      ],
    } as const;
    expect(decodePortalDeliveryPage(page).records).toHaveLength(2);
    expect(() =>
      decodePortalDeliveryPage({
        ...page,
        records: [{ ...page.records[0], outputBody: { tasks: [] } }],
        nextAfter: 1,
      }),
    ).toThrow(/outputBody.*not allowed/);
    expect(() =>
      decodePortalDeliveryPage({
        ...page,
        nextAfter: PORTAL_LIMITS.maxDeliveryItems + 1,
        records: Array.from({ length: PORTAL_LIMITS.maxDeliveryItems + 1 }, (_, index) => ({
          identity: `record-${index}`,
          kind: "phase-attempt",
        })),
      }),
    ).toThrow(/at most 256/);
  });

  it("enforces mutually exclusive activity cursors and ascending bounded windows", () => {
    const event = (cursor: number) => ({
      apiVersion: PROTOCOL_VERSION,
      cursor,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      eventId: `event_${cursor}`,
      eventType: "work-updated",
      occurredAt: timestamp,
      payload: {},
      payloadDigest: digest,
    });
    expect(
      decodePortalEventWindow({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        direction: "before",
        before: 10,
        earliestCursor: 1,
        latestCursor: 20,
        hasEarlier: true,
        hasLater: true,
        events: [event(7), event(9)],
      }).events.map(({ cursor }) => cursor),
    ).toEqual([7, 9]);
    expect(() =>
      decodePortalEventWindow({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        direction: "before",
        before: 10,
        after: 1,
        earliestCursor: 1,
        latestCursor: 20,
        hasEarlier: false,
        hasLater: false,
        events: [],
      }),
    ).toThrow(/matching after or before cursor/);
    expect(() =>
      decodePortalEventWindow({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        direction: "tail",
        earliestCursor: 1,
        latestCursor: 200,
        hasEarlier: true,
        hasLater: false,
        events: Array.from({ length: PORTAL_LIMITS.maxActivityItems + 1 }, (_, index) =>
          event(index + 1),
        ),
      }),
    ).toThrow(/at most 100/);
  });

  it("represents the JSON viewer budget and caps exact artifact preview bytes", () => {
    const content = "x".repeat(PORTAL_LIMITS.maxArtifactPreviewBytes);
    expect(
      decodePortalArtifactContent({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        artifactId: "asset_alpha",
        contentDigest: digest,
        offset: 0,
        byteLength: PORTAL_LIMITS.maxArtifactPreviewBytes,
        totalByteLength: PORTAL_LIMITS.maxArtifactPreviewBytes,
        encoding: "utf8",
        content,
        complete: true,
        jsonNodeBudget: PORTAL_LIMITS.jsonViewerNodeBudget,
      }).jsonNodeBudget,
    ).toBe(500);
    expect(() =>
      decodePortalArtifactContent({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_alpha",
        runId: "run_alpha",
        artifactId: "asset_alpha",
        contentDigest: digest,
        offset: 0,
        byteLength: PORTAL_LIMITS.maxArtifactPreviewBytes + 1,
        totalByteLength: PORTAL_LIMITS.maxArtifactPreviewBytes + 1,
        encoding: "utf8",
        content: `${content}x`,
        complete: true,
        jsonNodeBudget: PORTAL_LIMITS.jsonViewerNodeBudget,
      }),
    ).toThrow(/65536/);
  });

  it("decodes one owner-scoped transcript page and refuses every transcript bound", () => {
    const record = (sequence: number, overrides: Record<string, unknown> = {}) => ({
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      owner: { kind: "dispatch", id: "dispatch_alpha" },
      sequence,
      occurredAt: timestamp,
      stream: "system",
      text: "session started",
      ...overrides,
    });
    const transcriptPage = (
      records: readonly Record<string, unknown>[],
      overrides: Record<string, unknown> = {},
    ) => ({
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      owner: { kind: "dispatch", id: "dispatch_alpha" },
      after: 0,
      nextAfter: records.length === 0 ? 0 : Number(records[records.length - 1]?.sequence),
      hasMore: false,
      records,
      ...overrides,
    });

    const page = decodePortalTranscriptPage(transcriptPage([record(1), record(2)]));
    expect(page).toEqual({
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      owner: { kind: "dispatch", id: "dispatch_alpha" },
      after: 0,
      nextAfter: 2,
      hasMore: false,
      records: [record(1), record(2)],
    });
    expect(encodePortalTranscriptRecord(record(1))).toBe(
      `{"apiVersion":"${PROTOCOL_VERSION}","occurredAt":"${timestamp}","owner":{"id":"dispatch_alpha","kind":"dispatch"},"repositoryId":"repository_alpha","runId":"run_alpha","sequence":1,"stream":"system","text":"session started"}`,
    );
    expect(
      decodePortalTranscriptRecord(record(7, { stream: "stdout", text: "column\tvalue" })).text,
    ).toBe("column\tvalue");
    expect(
      decodePortalTranscriptRecord(record(8, { owner: { kind: "run", id: "run_alpha" } })).owner,
    ).toEqual({ kind: "run", id: "run_alpha" });
    // A record is exactly one displayed row, so it can never forge another row.
    for (const forged of ["forged\nrow", "forged\r\nrow", "forged\u2028row"]) {
      expect(() => decodePortalTranscriptRecord(record(9, { text: forged }))).toThrow(/text/u);
    }

    expect(() => decodePortalTranscriptRecord(record(1, { toolArguments: {} }))).toThrow(
      /toolArguments is not allowed/,
    );
    expect(() => decodePortalTranscriptRecord(record(0))).toThrow(
      /sequence must be a safe integer of at least 1/,
    );
    expect(() => decodePortalTranscriptRecord(record(1, { stream: "stdin" }))).toThrow(
      /stream must be one of/,
    );
    expect(() =>
      decodePortalTranscriptRecord(record(1, { owner: { kind: "criterion", id: "c" } })),
    ).toThrow(/owner.kind must be one of/);
    expect(() =>
      decodePortalTranscriptRecord(record(1, { occurredAt: "2026-08-14 12:00" })),
    ).toThrow(/occurredAt must be a UTC RFC 3339 timestamp/);
    expect(() => decodePortalTranscriptRecord(record(1, { text: "" }))).toThrow(
      /text must contain/,
    );
    expect(() =>
      decodePortalTranscriptRecord(
        record(1, { text: "a".repeat(TRANSCRIPT_LIMITS.maxLineBytes + 1) }),
      ),
    ).toThrow(/text must contain 1-4096/);
    expect(() =>
      decodePortalTranscriptRecord(
        record(1, { text: "\u00e9".repeat(TRANSCRIPT_LIMITS.maxLineBytes / 2 + 1) }),
      ),
    ).toThrow(/at most 4096 UTF-8 bytes/);
    for (const hostile of ["bell\u0007", "escape\u001b[31m", "carriage\rreturn", "delete\u007f"]) {
      expect(() => decodePortalTranscriptRecord(record(1, { text: hostile }))).toThrow(
        /no control characters/,
      );
    }
    expect(() => decodePortalTranscriptRecord(record(1, { text: "lone\ud800surrogate" }))).toThrow(
      /unpaired UTF-16 surrogates/,
    );

    expect(() => decodePortalTranscriptPage(transcriptPage([record(2), record(2)]))).toThrow(
      /must be strictly ascending after the cursor/,
    );
    expect(() =>
      decodePortalTranscriptPage(transcriptPage([record(1)], { after: 4, nextAfter: 1 })),
    ).toThrow(/must be strictly ascending after the cursor/);
    expect(() =>
      decodePortalTranscriptPage(transcriptPage([record(1), record(2)], { nextAfter: 1 })),
    ).toThrow(/nextAfter must equal the last returned sequence/);
    expect(() => decodePortalTranscriptPage(transcriptPage([], { hasMore: true }))).toThrow(
      /hasMore must be false for an empty page/,
    );
    expect(() =>
      decodePortalTranscriptPage(
        transcriptPage([record(1, { owner: { kind: "task", id: "task_alpha" } })], {
          nextAfter: 1,
        }),
      ),
    ).toThrow(/must match the page owner/);
    // A run page merges owners, so its records name the capture owner instead.
    expect(
      decodePortalTranscriptPage(
        transcriptPage(
          [
            record(1, { owner: { kind: "dispatch", id: "dispatch_alpha" } }),
            record(2, { owner: { kind: "phase", id: "phase_alpha" } }),
          ],
          { owner: { kind: "run", id: "run_alpha" }, nextAfter: 2 },
        ),
      ).records.map(({ owner }) => owner),
    ).toEqual([
      { kind: "dispatch", id: "dispatch_alpha" },
      { kind: "phase", id: "phase_alpha" },
    ]);
    expect(() =>
      decodePortalTranscriptPage(
        transcriptPage([record(1, { owner: { kind: "run", id: "run_alpha" } })], {
          owner: { kind: "run", id: "run_alpha" },
          nextAfter: 1,
        }),
      ),
    ).toThrow(/must name a capture owner/);
    expect(() =>
      decodePortalTranscriptPage(
        transcriptPage([record(1, { runId: "run_beta" })], { nextAfter: 1 }),
      ),
    ).toThrow(/must match the page repository and run/);
    expect(() =>
      decodePortalTranscriptPage(
        transcriptPage(
          Array.from({ length: TRANSCRIPT_LIMITS.maxRecordsPerPage + 1 }, (_, index) =>
            record(index + 1),
          ),
        ),
      ),
    ).toThrow(/at most 200/);
  });
});

describe("a question record built from values the store already decoded", () => {
  function question(details: unknown) {
    return {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_alpha",
      runId: "run_alpha",
      source: {
        submissionId: "submission_alpha",
        dispatchId: "dispatch_alpha",
        taskId: "task_alpha",
        definitionGeneration: 1,
        contextId: "context_alpha",
        contextDigest: digest,
        contextRevisionDigest: digest,
        questionDigest: digest,
        submittedAt: timestamp,
      },
      prompt: "which endpoint is authoritative?",
      details,
      freshDispatch: { status: "not-required" },
    };
  }

  // `decodeCanonicalJsonValue` reads a string as JSON text, so a detail an
  // agent wrote as prose was parsed a second time and refused. One such
  // question emptied the whole portal question list, which is exactly when a
  // person most needs to read it.
  it("keeps a detail an agent wrote as prose", () => {
    expect(decodePortalQuestionRecord(question("the deployed one"))).toMatchObject({
      details: "the deployed one",
    });
  });

  it("keeps a detail an agent wrote as an object", () => {
    expect(decodePortalQuestionRecord(question({ candidates: ["a", "b"] }))).toMatchObject({
      details: { candidates: ["a", "b"] },
    });
  });

  // A refusal is written for a person. Validating it as a lowercase token made
  // the whole agent list fail as soon as any agent had been refused once, and
  // the run view fetches that list, so the portal went offline reporting a run
  // whose only problem was that an agent had been told no.
  it("keeps a refusal an agent was given in the words it was given", () => {
    const refusal =
      "Your previous turn ended without submitting a completion, so this is a fresh attempt.";
    expect(
      decodePortalAgentPage({
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_one",
        runId: "run_one",
        hasMore: false,
        agents: [
          {
            dispatchId: "dispatch_one",
            persona: "planner",
            phaseId: "phase_one",
            taskId: "task_one",
            attempt: 2,
            model: "claude-haiku-4.5",
            routeIndex: 0,
            state: "working",
            latestRefusal: refusal,
          },
        ],
      }),
    ).toMatchObject({ agents: [{ latestRefusal: refusal }] });
  });
});
