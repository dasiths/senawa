import {
  decodePortalTranscriptRecord,
  type PortalTranscriptOwner,
  type PortalTranscriptPage,
  type PortalTranscriptRecord,
  type PortalTranscriptStream,
  PROTOCOL_VERSION,
  TRANSCRIPT_LIMITS,
} from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  emptyTranscriptView,
  localTranscriptTime,
  mergeTranscriptPage,
  sameTranscriptOwner,
  selectTranscriptOwner,
  setTranscriptPinned,
  type TranscriptView,
  transcriptDownloadName,
  transcriptNames,
  transcriptOwnerForNode,
  transcriptOwnerLabel,
  transcriptPlainText,
  transcriptRows,
  transcriptShowsOwner,
} from "./transcript-view-model.js";

const REPOSITORY = "repository_portal";
const RUN = "run_portal";
const TASK_OWNER: PortalTranscriptOwner = Object.freeze({ kind: "task", id: "task_verify" });
const DISPATCH_OWNER: PortalTranscriptOwner = Object.freeze({
  kind: "dispatch",
  id: "dispatch_verify",
});
const FIXED_CLOCK = (occurredAt: string) => occurredAt.slice(11, 19);

function record(
  sequence: number,
  text: string,
  stream: PortalTranscriptStream = "stdout",
  owner: PortalTranscriptOwner = TASK_OWNER,
): PortalTranscriptRecord {
  const seconds = String(sequence % 60).padStart(2, "0");
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: REPOSITORY,
    runId: RUN,
    owner,
    sequence,
    occurredAt: `2026-08-15T04:05:${seconds}.000Z`,
    stream,
    text,
  });
}

function page(
  records: readonly PortalTranscriptRecord[],
  options: { readonly owner?: PortalTranscriptOwner; readonly hasMore?: boolean } = {},
): PortalTranscriptPage {
  const owner = options.owner ?? TASK_OWNER;
  const after = (records[0]?.sequence ?? 1) - 1;
  return Object.freeze({
    apiVersion: PROTOCOL_VERSION,
    repositoryId: REPOSITORY,
    runId: RUN,
    owner,
    after,
    nextAfter: records.at(-1)?.sequence ?? after,
    hasMore: options.hasMore ?? false,
    records: Object.freeze(records),
  });
}

function selected(owner: PortalTranscriptOwner = TASK_OWNER): TranscriptView {
  return selectTranscriptOwner(emptyTranscriptView(), owner);
}

describe("transcript merge", () => {
  it("orders by sequence regardless of page arrival order and collapses duplicates", () => {
    const view = mergeTranscriptPage(
      mergeTranscriptPage(selected(), page([record(3, "third"), record(4, "fourth")])),
      page([record(1, "first"), record(2, "second"), record(3, "third")]),
    );
    expect(view.lines.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4]);
    expect(view.lines.map(({ text }) => text)).toEqual(["first", "second", "third", "fourth"]);
    expect(view.nextAfter).toBe(4);
  });

  it("keeps the highest observed cursor when an older page arrives late", () => {
    const view = mergeTranscriptPage(
      mergeTranscriptPage(selected(), page([record(9, "nine")])),
      page([record(2, "two")]),
    );
    expect(view.nextAfter).toBe(9);
    expect(view.lines.map(({ sequence }) => sequence)).toEqual([2, 9]);
  });

  it("discards a page addressed to another owner", () => {
    const view = mergeTranscriptPage(
      selected(),
      page([record(1, "other", "stdout", DISPATCH_OWNER)], { owner: DISPATCH_OWNER }),
    );
    expect(view.lines).toEqual([]);
    expect(view.nextAfter).toBe(0);
  });

  it("evicts the oldest lines at the retention ceiling", () => {
    const cap = TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner;
    const first = mergeTranscriptPage(
      selected(),
      page(Array.from({ length: cap }, (_, index) => record(index + 1, `line ${index + 1}`))),
    );
    expect(first.lines).toHaveLength(cap);
    const view = mergeTranscriptPage(
      first,
      page([record(cap + 1, "newest"), record(cap + 2, "newer still")]),
    );
    expect(view.lines).toHaveLength(cap);
    expect(view.lines[0]?.sequence).toBe(3);
    expect(view.lines.at(-1)?.text).toBe("newer still");
  });
});

describe("transcript follow state", () => {
  it("stays at the tail with no unseen count while pinned", () => {
    const view = mergeTranscriptPage(
      mergeTranscriptPage(selected(), page([record(1, "one")])),
      page([record(2, "two"), record(3, "three")]),
    );
    expect(view.pinned).toBe(true);
    expect(view.unseen).toBe(0);
  });

  it("counts only newly merged lines while unpinned and clears them on re-pin", () => {
    const started = mergeTranscriptPage(selected(), page([record(1, "one")]));
    const unpinned = setTranscriptPinned(started, false);
    expect(unpinned.unseen).toBe(0);
    const grown = mergeTranscriptPage(
      mergeTranscriptPage(unpinned, page([record(2, "two"), record(3, "three")])),
      page([record(3, "three"), record(4, "four")]),
    );
    expect(grown.pinned).toBe(false);
    expect(grown.unseen).toBe(3);
    expect(setTranscriptPinned(grown, true).unseen).toBe(0);
    expect(setTranscriptPinned(grown, false)).toBe(grown);
  });
});

describe("transcript owner scoping", () => {
  it("clears lines, cursor, pin, and unseen when the owner changes", () => {
    const unpinned = setTranscriptPinned(
      mergeTranscriptPage(selected(), page([record(1, "one"), record(2, "two")])),
      false,
    );
    const switched = selectTranscriptOwner(unpinned, DISPATCH_OWNER);
    expect(switched.owner).toEqual(DISPATCH_OWNER);
    expect(switched.lines).toEqual([]);
    expect(switched.nextAfter).toBe(0);
    expect(switched.pinned).toBe(true);
    expect(switched.unseen).toBe(0);
    expect(selectTranscriptOwner(unpinned, TASK_OWNER)).toBe(unpinned);
    expect(selectTranscriptOwner(unpinned, undefined).owner).toBeUndefined();
  });

  it("never mixes owners after a switch", () => {
    const first = mergeTranscriptPage(selected(), page([record(1, "task line")]));
    const second = mergeTranscriptPage(
      selectTranscriptOwner(first, DISPATCH_OWNER),
      page([record(1, "dispatch line", "stderr", DISPATCH_OWNER)], { owner: DISPATCH_OWNER }),
    );
    expect(second.lines.map(({ text }) => text)).toEqual(["dispatch line"]);
    expect(second.lines.every(({ owner }) => owner.kind === "dispatch")).toBe(true);
  });

  it("compares owners by kind and identity", () => {
    expect(sameTranscriptOwner(TASK_OWNER, { kind: "task", id: "task_verify" })).toBe(true);
    expect(sameTranscriptOwner(TASK_OWNER, { kind: "phase", id: "task_verify" })).toBe(false);
    expect(sameTranscriptOwner(undefined, undefined)).toBe(true);
    expect(sameTranscriptOwner(TASK_OWNER, undefined)).toBe(false);
  });

  it("derives the owner from the selected node and prefers its dispatch", () => {
    const task = { nodeId: "task_verify", kind: "task" } as const;
    expect(transcriptOwnerForNode(task, undefined)).toEqual(TASK_OWNER);
    expect(transcriptOwnerForNode(task, "dispatch_verify")).toEqual(DISPATCH_OWNER);
    expect(transcriptOwnerForNode({ nodeId: "phase_delivery", kind: "phase" }, undefined)).toEqual({
      kind: "phase",
      id: "phase_delivery",
    });
    expect(transcriptOwnerForNode(undefined, "dispatch_verify")).toBeUndefined();
    expect(
      transcriptOwnerForNode({ nodeId: "workflow_portal", kind: "workflow" }, "dispatch_verify"),
    ).toBeUndefined();
    expect(
      transcriptOwnerForNode({ nodeId: "criterion_verified", kind: "criterion" }, undefined),
    ).toBeUndefined();
  });

  it("resolves the node dispatch in repository mode where no workspace row exists", () => {
    // Repository mode never records a workspace, so the node's own current
    // dispatch is the only owner agreement the writer and the pane can share.
    expect(
      transcriptOwnerForNode(
        { nodeId: "task_verify", kind: "task", dispatchId: "dispatch_verify" },
        undefined,
      ),
    ).toEqual(DISPATCH_OWNER);
    expect(
      transcriptOwnerForNode(
        { nodeId: "task_verify", kind: "task", dispatchId: "dispatch_verify" },
        "dispatch_worktree",
      ),
    ).toEqual(DISPATCH_OWNER);
    expect(
      transcriptOwnerForNode({ nodeId: "task_verify", kind: "task" }, "dispatch_worktree"),
    ).toEqual({ kind: "dispatch", id: "dispatch_worktree" });
  });
});

describe("transcript projections", () => {
  it("projects exactly the displayed bounded text", () => {
    const view = mergeTranscriptPage(
      selected(),
      page([
        record(1, "session started", "system"),
        record(2, "tool call failed", "stderr"),
        record(3, "<script>alert(1)</script></div>"),
      ]),
    );
    expect(transcriptRows(view, FIXED_CLOCK)).toEqual([
      {
        sequence: 1,
        time: "04:05:01",
        stream: "system",
        text: "session started",
        owner: TASK_OWNER,
      },
      {
        sequence: 2,
        time: "04:05:02",
        stream: "stderr",
        text: "tool call failed",
        owner: TASK_OWNER,
      },
      {
        sequence: 3,
        time: "04:05:03",
        stream: "stdout",
        text: "<script>alert(1)</script></div>",
        owner: TASK_OWNER,
      },
    ]);
    expect(transcriptPlainText(view, FIXED_CLOCK)).toBe(
      [
        "04:05:01\tsystem\tsession started",
        "04:05:02\tstderr\ttool call failed",
        "04:05:03\tstdout\t<script>alert(1)</script></div>",
      ].join("\n"),
    );
    expect(transcriptPlainText(emptyTranscriptView(), FIXED_CLOCK)).toBe("");
  });

  it("keeps the originating owner of every line in the run-wide scope", () => {
    const runOwner: PortalTranscriptOwner = Object.freeze({ kind: "run", id: RUN });
    const view = mergeTranscriptPage(
      selected(runOwner),
      page(
        [
          record(1, "dispatch line", "system", DISPATCH_OWNER),
          record(2, "task line", "stdout", TASK_OWNER),
        ],
        { owner: runOwner },
      ),
    );

    expect(transcriptShowsOwner(view)).toBe(true);
    expect(transcriptRows(view, FIXED_CLOCK).map(({ owner }) => owner)).toEqual([
      DISPATCH_OWNER,
      TASK_OWNER,
    ]);
    expect(transcriptPlainText(view, FIXED_CLOCK)).toBe(
      [
        `04:05:01\t${transcriptOwnerLabel(DISPATCH_OWNER)}\tsystem\tdispatch line`,
        `04:05:02\t${transcriptOwnerLabel(TASK_OWNER)}\tstdout\ttask line`,
      ].join("\n"),
    );
    // A node scope names one owner already, so its rows stay unqualified.
    expect(transcriptShowsOwner(selected())).toBe(false);
  });

  it("names the agent that wrote a line rather than the dispatch that carried it", () => {
    const names = transcriptNames([
      { dispatchId: DISPATCH_OWNER.id, persona: "researcher" },
      { dispatchId: "dispatch_other", persona: "planner" },
    ]);
    const runOwner: PortalTranscriptOwner = Object.freeze({ kind: "run", id: RUN });
    const view = mergeTranscriptPage(
      selected(runOwner),
      page(
        [
          record(1, "dispatch line", "system", DISPATCH_OWNER),
          record(2, "task line", "stdout", TASK_OWNER),
        ],
        { owner: runOwner },
      ),
    );

    expect(transcriptOwnerLabel(DISPATCH_OWNER, names)).toBe("researcher");
    // No agent row claims this owner, so the identity is all there is to show.
    expect(transcriptOwnerLabel(TASK_OWNER, names)).toBe(`${TASK_OWNER.kind} ${TASK_OWNER.id}`);
    expect(transcriptPlainText(view, FIXED_CLOCK, names)).toBe(
      [
        `04:05:01\tresearcher\tsystem\tdispatch line`,
        `04:05:02\t${TASK_OWNER.kind} ${TASK_OWNER.id}\tstdout\ttask line`,
      ].join("\n"),
    );
    expect(transcriptNames([])).toEqual({});
    expect(transcriptNames(undefined)).toEqual({});
  });

  it("never lets one record forge an extra plain-text row", () => {
    const view = mergeTranscriptPage(
      selected(),
      page([record(1, "only line"), record(2, "second line")]),
    );
    const text = transcriptPlainText(view, FIXED_CLOCK);
    expect(text.split("\n")).toHaveLength(view.lines.length);
    for (const line of view.lines) {
      expect(line.text).not.toMatch(/[\n\r\u0085\u2028\u2029]/u);
    }
    // The codec is what makes the join above safe: a forged row never decodes.
    expect(() =>
      decodePortalTranscriptRecord(record(3, "forged\n04:05:04\tsystem\tapproved")),
    ).toThrow(/text/u);
  });

  it("projects only the retained lines after eviction", () => {
    const cap = TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner;
    const view = mergeTranscriptPage(
      selected(),
      page(Array.from({ length: cap + 5 }, (_, index) => record(index + 1, `line ${index + 1}`))),
    );
    const text = transcriptPlainText(view, FIXED_CLOCK);
    expect(text.split("\n")).toHaveLength(cap);
    expect(text.startsWith("04:05:06\tstdout\tline 6")).toBe(true);
    expect(text.endsWith(`line ${cap + 5}`)).toBe(true);
  });

  it("formats a wall-clock time without a meridiem and falls back to the raw stamp", () => {
    expect(localTranscriptTime("2026-08-15T04:05:06.000Z")).toMatch(/^\d{1,2}:\d{2}:\d{2}$/u);
    expect(localTranscriptTime("not-a-timestamp")).toBe("not-a-timestamp");
  });

  it("derives an inert label and download name from the owner identity", () => {
    expect(transcriptOwnerLabel(DISPATCH_OWNER)).toBe("dispatch dispatch_verify");
    expect(transcriptDownloadName(DISPATCH_OWNER)).toBe(
      "senawa-transcript-dispatch-dispatch_verify.txt",
    );
    expect(transcriptDownloadName({ kind: "phase", id: "phase/../../etc passwd" })).toBe(
      "senawa-transcript-phase-phase-..-..-etc-passwd.txt",
    );
  });
});
