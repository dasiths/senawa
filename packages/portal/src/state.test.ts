import { type EventStreamFrame, type PortalRunOverview, PROTOCOL_VERSION } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { boundedJsonModel } from "./bounded-json.js";
import { parsePortalHash, portalHash } from "./router.js";
import { actionsLocked, transcriptRevisionsEqual, vectorsEqual } from "./selectors.js";
import { artifactContentKey, initialPortalState, portalReducer } from "./state.js";

const digest = "a".repeat(64);
const sync = Object.freeze({
  workflowCursor: 4,
  contextRevision: 2,
  runnerRevision: 3,
  workspaceRevision: 1,
  humanRevision: 2,
  portalRevision: 7,
  transcriptRevision: 5,
  graphRevision: digest,
  lifecycleRevision: 4,
});

describe("portal state", () => {
  // Rendering replaces the whole tree on every poll, so anything a reader
  // decided has to be a fact the next render reads rather than DOM it inspects.
  it("keeps a reader's folds and opened records across a poll", () => {
    const start = initialPortalState(parsePortalHash("#/runs/repository_one/run_one/workflow"));
    expect(start.ui.unfoldedNodes).toEqual([]);
    expect(start.ui.openedRecords).toEqual([]);

    const opened = portalReducer(
      portalReducer(start, { type: "graph-unfold", nodeId: "phase_research" }),
      { type: "record-disclosure", recordKey: "Events:7 phase-started" },
    );
    expect(opened.ui.unfoldedNodes).toEqual(["phase_research"]);
    expect(opened.ui.openedRecords).toEqual(["Events:7 phase-started"]);

    // Both are toggles: asking again is how a reader takes the decision back.
    const closed = portalReducer(
      portalReducer(opened, { type: "graph-unfold", nodeId: "phase_research" }),
      { type: "record-disclosure", recordKey: "Events:7 phase-started" },
    );
    expect(closed.ui.unfoldedNodes).toEqual([]);
    expect(closed.ui.openedRecords).toEqual([]);
  });

  it("keeps authority caches revision keyed and locks actions through gaps", () => {
    const original = initialPortalState(parsePortalHash("#/runs/repository_one/run_one/record"));
    const selected = portalReducer(original, {
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
      mode: "running",
      runModeRevision: 1,
      terminal: false,
      updatedAt: "2026-08-14T12:00:00.000Z",
      sync,
      counts: {
        phases: 1,
        closedPhases: 0,
        tasks: 2,
        criteria: 3,
        humanNeeds: 0,
        activeEffects: 0,
        uncertainEffects: 0,
      },
    };
    const loaded = portalReducer(selected, { type: "overview", overview });
    const fresh = portalReducer(loaded, {
      type: "freshness",
      resource: "record",
      freshness: { status: "fresh", vector: sync },
    });
    const writable = portalReducer(fresh, {
      type: "session-ready",
      descriptor: {
        apiVersion: PROTOCOL_VERSION,
        expiresAt: "2026-08-14T20:00:00.000Z",
        csrfMode: "available",
        capabilities: [],
      },
      csrfToken: "x".repeat(43),
    });
    const live = portalReducer(writable, { type: "connection", status: "live" });
    expect(actionsLocked(live)).toBe(false);
    const gapped = portalReducer(live, { type: "gap", message: "cursor expired" });
    expect(actionsLocked(gapped)).toBe(true);
    expect(gapped.caches.overviews).toEqual({});
    expect(original.selectedRunId).toBeUndefined();
  });

  it("deduplicates events and caps the visible ring at 500", () => {
    let state = initialPortalState({ name: "record" });
    for (let cursor = 1; cursor <= 510; cursor += 1) {
      const event: EventStreamFrame = {
        apiVersion: PROTOCOL_VERSION,
        cursor,
        repositoryId: "repository_one",
        runId: "run_one",
        eventId: `event_${cursor}`,
        eventType: "work-updated",
        occurredAt: "2026-08-14T12:00:00.000Z",
        payload: { cursor },
        payloadDigest: digest,
      };
      state = portalReducer(state, { type: "event", event });
    }
    expect(state.visibleEvents).toHaveLength(500);
    const duplicate = state.visibleEvents[0];
    if (duplicate === undefined) throw new Error("Visible event ring is empty");
    expect(portalReducer(state, { type: "event", event: duplicate })).toBe(state);
  });

  it("closes reviewed authority when the selected run changes", () => {
    const original = portalReducer(initialPortalState({ name: "record" }), {
      type: "dialog-open",
      dialog: {
        kind: "end",
        title: "End this run",
        triggerId: "run-control-end",
        verified: true,
        loading: false,
        source: { repositoryId: "repository_one", runId: "run_one", runModeRevision: 0 },
      },
    });
    const selected = portalReducer(original, {
      type: "select-run",
      repositoryId: "repository_two",
      runId: "run_two",
    });
    expect(selected.ui.dialog).toBeUndefined();
  });

  it("retains pending recovery identity when a session expires", async () => {
    const pending = {
      commandId: "command_pending",
      canonicalSubmission: "{}",
      payloadDigest: digest,
      intent: "pause-run" as const,
      repositoryId: "repository_one",
      runId: "run_one",
      storedAt: "2026-08-14T12:00:00.000Z",
      exactRetryUsed: false,
    };
    const withPending = portalReducer(initialPortalState({ name: "record" }), {
      type: "pending-add",
      pending,
    });
    const fresh = portalReducer(withPending, {
      type: "freshness",
      resource: "record",
      freshness: { status: "fresh", vector: sync },
    });
    const expired = portalReducer(fresh, {
      type: "session-expired",
      message: "Session expired",
    });
    expect(expired.pending).toEqual({ [pending.commandId]: pending });
    expect(expired.freshness).toEqual({});
    expect(expired.cursor).toBe(0);
    expect(expired.ui.dialog).toBeUndefined();
  });

  it("scopes artifact content cache keys by repository and run", () => {
    expect(artifactContentKey("repository_one", "run_one", "artifact_shared")).not.toBe(
      artifactContentKey("repository_one", "run_two", "artifact_shared"),
    );
  });

  it("discards retained transcript lines when the run, route, or stream changes", () => {
    const owner = { kind: "task", id: "task_verify" } as const;
    const record = {
      apiVersion: PROTOCOL_VERSION,
      repositoryId: "repository_one",
      runId: "run_one",
      owner,
      sequence: 1,
      occurredAt: "2026-08-14T12:00:00.000Z",
      stream: "stdout" as const,
      text: "one line",
    };
    const scoped = portalReducer(initialPortalState({ name: "workflow" }), {
      type: "transcript-owner",
      owner,
    });
    const loaded = portalReducer(scoped, {
      type: "transcript-page",
      page: {
        apiVersion: PROTOCOL_VERSION,
        repositoryId: "repository_one",
        runId: "run_one",
        owner,
        after: 0,
        nextAfter: 1,
        hasMore: false,
        records: [record],
      },
    });
    expect(loaded.ui.transcript.lines).toHaveLength(1);
    const unpinned = portalReducer(loaded, { type: "transcript-pin", pinned: false });
    expect(unpinned.ui.transcript.pinned).toBe(false);
    for (const action of [
      { type: "select-run", repositoryId: "repository_one", runId: "run_two" },
      { type: "route", route: { name: "record" } },
      { type: "gap", message: "Stream gap" },
      { type: "session-expired", message: "Session expired" },
    ] as const) {
      const cleared = portalReducer(unpinned, action);
      expect(cleared.ui.transcript.lines).toEqual([]);
      expect(cleared.ui.transcript.owner).toBeUndefined();
      expect(cleared.ui.transcript.pinned).toBe(true);
    }
    // The terminal opens on the whole run, so narrowing to one node is the
    // change that discards what was retained for the wider scope.
    const narrowed = portalReducer(loaded, { type: "transcript-scope", scope: "node" });
    expect(narrowed.ui.transcriptScope).toBe("node");
    expect(narrowed.ui.transcript.lines).toEqual([]);
    expect(portalReducer(narrowed, { type: "transcript-scope", scope: "node" })).toBe(narrowed);
  });
});

describe("portal pure models", () => {
  it("parses only exact routes and round trips identities", () => {
    const hash = portalHash("repository_one", "run_one", "workflow");
    expect(parsePortalHash(hash)).toEqual({
      name: "workflow",
      repositoryId: "repository_one",
      runId: "run_one",
    });
    expect(parsePortalHash("#/runs/../run_one/workflow")).toEqual({ name: "workflow" });
  });

  it("compares the assembly sync vector without the transcript component", () => {
    expect(vectorsEqual(sync, { ...sync })).toBe(true);
    expect(vectorsEqual(sync, { ...sync, humanRevision: 3 })).toBe(false);
    // Agent output must never make an actively writing run permanently stale.
    expect(vectorsEqual(sync, { ...sync, transcriptRevision: sync.transcriptRevision + 9 })).toBe(
      true,
    );
    expect(transcriptRevisionsEqual(sync, { ...sync })).toBe(true);
    expect(
      transcriptRevisionsEqual(sync, { ...sync, transcriptRevision: sync.transcriptRevision + 1 }),
    ).toBe(false);
    expect(transcriptRevisionsEqual(sync, { ...sync, humanRevision: 3 })).toBe(true);
  });

  it("bounds JSON nodes and string prefixes", () => {
    const model = boundedJsonModel({
      hostile: `<script>${"x".repeat(5_000)}</script>`,
      values: Array.from({ length: 600 }, (_, index) => index),
    });
    expect(model.visibleNodes).toBeLessThanOrEqual(500);
    expect(model.truncated).toBe(true);
    expect(JSON.stringify(model)).toContain("<script>");
  });
});
