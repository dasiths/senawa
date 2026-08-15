import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "./contracts.js";
import {
  decodePortalAllowanceReview,
  decodePortalArtifactContent,
  decodePortalDeliveryPage,
  decodePortalEventWindow,
  decodePortalGraphNodePage,
  decodePortalRepositoryPage,
  decodePortalRunOverview,
  decodePortalSessionDescriptor,
} from "./portal-codec.js";
import { PORTAL_CAPABILITIES, PORTAL_LIMITS } from "./portal-contracts.js";

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
});
