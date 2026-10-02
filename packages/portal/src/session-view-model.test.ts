import {
  type PortalGraphNodePage,
  type PortalRunOverview,
  PROTOCOL_VERSION,
} from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { parsePortalHash } from "./router.js";
import { sessionAccess } from "./session.js";
import { initialPortalState, portalReducer, revisionKey } from "./state.js";
import { portalViewModel } from "./view-model.js";

const expiresAt = "2026-08-14T20:00:00.000Z";
const digest = "a".repeat(64);

describe("portal session access", () => {
  it("issues once, restores only an exact same-tab expiry, and otherwise stays read-only", () => {
    const available = {
      apiVersion: PROTOCOL_VERSION,
      expiresAt,
      csrfMode: "available",
      capabilities: [],
    } as const;
    const delivered = { ...available, csrfMode: "read-only" } as const;
    expect(sessionAccess(available, undefined, Date.parse(expiresAt) - 1)).toEqual({
      type: "issue-csrf",
    });
    expect(
      sessionAccess(delivered, { csrfToken: "x".repeat(43), expiresAt }, Date.parse(expiresAt) - 1),
    ).toEqual({
      type: "read-write",
      csrfToken: "x".repeat(43),
    });
    expect(sessionAccess(delivered, undefined, Date.parse(expiresAt) - 1)).toEqual({
      type: "read-only",
    });
    expect(
      sessionAccess(delivered, { csrfToken: "x".repeat(43), expiresAt }, Date.parse(expiresAt)),
    ).toEqual({ type: "read-only" });
  });
});

describe("portal route view model", () => {
  it("derives capability controls and a bounded filtered graph page without mutating state", () => {
    let state = initialPortalState(parsePortalHash("#/runs/repository_one/run_one/graph"));
    state = portalReducer(state, {
      type: "select-run",
      repositoryId: "repository_one",
      runId: "run_one",
    });
    const overview: PortalRunOverview = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_one",
      runId: "run_one",
      displayName: "Run one",
      workflowName: "Factory",
      mode: "paused",
      runModeRevision: 2,
      terminal: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
      sync: {
        workflowCursor: 4,
        contextRevision: 1,
        runnerRevision: 1,
        workspaceRevision: 1,
        humanRevision: 1,
        portalRevision: 4,
        transcriptRevision: 0,
        graphRevision: digest,
        lifecycleRevision: 2,
      },
      counts: {
        phases: 1,
        closedPhases: 0,
        tasks: 1,
        criteria: 1,
        humanNeeds: 0,
        activeEffects: 0,
        uncertainEffects: 0,
      },
    };
    state = portalReducer(state, { type: "overview", overview });
    state = portalReducer(state, {
      type: "session-ready",
      descriptor: {
        apiVersion: PROTOCOL_VERSION,
        expiresAt,
        csrfMode: "available",
        capabilities: ["portal-write-run-control"],
      },
      csrfToken: "x".repeat(43),
    });
    state = portalReducer(state, { type: "connection", status: "live" });
    const nodes: PortalGraphNodePage = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_one",
      runId: "run_one",
      graphRevision: digest,
      after: 0,
      nextAfter: 1,
      hasMore: false,
      nodes: [
        {
          nodeId: "task_one",
          kind: "task",
          title: "Compile release",
          definitionGeneration: 1,
          runState: "running",
          roleKey: "implementer",
          humanNeedCount: 0,
          evidenceCount: 0,
        },
      ],
    };
    state = portalReducer(state, {
      type: "cache",
      cache: "graphNodes",
      key: revisionKey("repository_one", "run_one", digest),
      value: nodes,
    });
    state = portalReducer(state, { type: "filter", value: "compile" });
    const model = portalViewModel(state);
    expect(model).toMatchObject({ runControlVisible: true, runMode: "paused" });
    expect(model.graphRows.map(({ nodeId }) => nodeId)).toEqual(["task_one"]);
    expect(state.ui.filter).toBe("compile");
  });
});
