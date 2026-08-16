import {
  type PortalGraphNode,
  type PortalTranscriptOwner,
  type PortalTranscriptPage,
  type PortalTranscriptRecord,
  type PortalTranscriptStream,
  TRANSCRIPT_LIMITS,
} from "@senawa/protocol";

export interface TranscriptView {
  readonly owner: PortalTranscriptOwner | undefined;
  readonly lines: readonly PortalTranscriptRecord[];
  readonly nextAfter: number;
  readonly pinned: boolean;
  readonly unseen: number;
  readonly hasMore: boolean;
}

export interface TranscriptRow {
  readonly sequence: number;
  readonly time: string;
  readonly stream: PortalTranscriptStream;
  readonly text: string;
}

export type TranscriptClock = (occurredAt: string) => string;

/** `node` follows the selected graph node; `run` merges every owner of the run. */
export type TranscriptScope = "node" | "run";

const EMPTY_VIEW: TranscriptView = Object.freeze({
  owner: undefined,
  lines: Object.freeze([]),
  nextAfter: 0,
  pinned: true,
  unseen: 0,
  hasMore: false,
});

export function emptyTranscriptView(): TranscriptView {
  return EMPTY_VIEW;
}

export function sameTranscriptOwner(
  left: PortalTranscriptOwner | undefined,
  right: PortalTranscriptOwner | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind && left.id === right.id;
}

/** Changing owner discards every retained line so two owners never share one view. */
export function selectTranscriptOwner(
  view: TranscriptView,
  owner: PortalTranscriptOwner | undefined,
): TranscriptView {
  if (sameTranscriptOwner(view.owner, owner)) return view;
  return Object.freeze({ ...EMPTY_VIEW, owner });
}

export function setTranscriptPinned(view: TranscriptView, pinned: boolean): TranscriptView {
  if (view.pinned === pinned) return view;
  return Object.freeze({ ...view, pinned, unseen: pinned ? 0 : view.unseen });
}

/**
 * Merges one bounded page by `(owner, sequence)`. Pages for another owner are
 * discarded, records are ordered by sequence rather than arrival, duplicates
 * collapse, and the oldest lines are evicted at the retention ceiling.
 */
export function mergeTranscriptPage(
  view: TranscriptView,
  page: PortalTranscriptPage,
): TranscriptView {
  if (!sameTranscriptOwner(view.owner, page.owner)) return view;
  const merged = new Map<number, PortalTranscriptRecord>();
  for (const line of view.lines) merged.set(line.sequence, line);
  let added = 0;
  for (const record of page.records) {
    if (!merged.has(record.sequence)) added += 1;
    merged.set(record.sequence, record);
  }
  const ordered = [...merged.values()].sort((left, right) => left.sequence - right.sequence);
  const lines = ordered.slice(-TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner);
  return Object.freeze({
    owner: view.owner,
    lines: Object.freeze(lines),
    nextAfter: Math.max(view.nextAfter, page.nextAfter),
    pinned: view.pinned,
    unseen: view.pinned
      ? 0
      : Math.min(view.unseen + added, TRANSCRIPT_LIMITS.maxRetainedLinesPerOwner),
    hasMore: page.hasMore,
  });
}

export function localTranscriptTime(occurredAt: string): string {
  const value = new Date(occurredAt);
  return Number.isNaN(value.getTime())
    ? occurredAt
    : value.toLocaleTimeString(undefined, { hour12: false });
}

export function transcriptRows(
  view: TranscriptView,
  clock: TranscriptClock = localTranscriptTime,
): readonly TranscriptRow[] {
  return Object.freeze(
    view.lines.map((line) =>
      Object.freeze({
        sequence: line.sequence,
        time: clock(line.occurredAt),
        stream: line.stream,
        text: line.text,
      }),
    ),
  );
}

/** The exact bounded text the pane displays, reused by copy and download. */
export function transcriptPlainText(
  view: TranscriptView,
  clock: TranscriptClock = localTranscriptTime,
): string {
  return transcriptRows(view, clock)
    .map((row) => `${row.time}\t${row.stream}\t${row.text}`)
    .join("\n");
}

export function transcriptOwnerLabel(owner: PortalTranscriptOwner): string {
  return `${owner.kind} ${owner.id}`;
}

/**
 * Scopes the pane to one selected graph node. The node's own current dispatch
 * wins because capture writes worker lines under the dispatch, and it is the
 * only dispatch owner that exists in repository mode, where no workspace row is
 * ever recorded. A worktree workspace dispatch is the fallback, then the node.
 */
export function transcriptOwnerForNode(
  node: Pick<PortalGraphNode, "nodeId" | "kind" | "dispatchId"> | undefined,
  workspaceDispatchId: string | undefined,
): PortalTranscriptOwner | undefined {
  if (node === undefined) return undefined;
  if (node.kind !== "task" && node.kind !== "phase") return undefined;
  const dispatchId = node.dispatchId ?? workspaceDispatchId;
  if (dispatchId !== undefined) return Object.freeze({ kind: "dispatch", id: dispatchId });
  return Object.freeze({ kind: node.kind, id: node.nodeId });
}

export function transcriptDownloadName(owner: PortalTranscriptOwner): string {
  const identity = owner.id.replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 96);
  return `senawa-transcript-${owner.kind}-${identity}.txt`;
}
