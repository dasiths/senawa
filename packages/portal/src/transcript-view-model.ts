import {
  type PortalAgentSummary,
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
  /** `you` is not a captured stream: it is what a person sent into this run. */
  readonly stream: PortalTranscriptStream | "you";
  readonly text: string;
  /** The capture owner of the line, which the run-wide scope merges but never erases. */
  readonly owner: PortalTranscriptOwner;
}

/** What a person sent an agent, so a conversation reads as one. */
export interface TranscriptTurn {
  readonly occurredAt: string;
  readonly text: string;
  readonly owner: PortalTranscriptOwner;
}

export type TranscriptClock = (occurredAt: string) => string;

/** `node` follows the selected graph node; `run` merges every owner of the run. */
export type TranscriptScope = "node" | "run";

/** Owner identity to the name a person recognises, keyed by `owner.id`. */
export type TranscriptNames = Readonly<Record<string, string>>;

const NO_NAMES: TranscriptNames = Object.freeze({});

/**
 * Builds the owner naming from whatever agent rows the run has loaded. A line
 * says who wrote it and what they were working on, because a persona alone
 * repeats four times over in a run that fanned out.
 */
export function transcriptNames(
  agents: readonly Pick<PortalAgentSummary, "dispatchId" | "persona" | "taskName">[] | undefined,
): TranscriptNames {
  if (agents === undefined || agents.length === 0) return NO_NAMES;
  const names: Record<string, string> = {};
  for (const agent of agents)
    names[agent.dispatchId] =
      agent.taskName === undefined ? agent.persona : `${agent.persona} \u00b7 ${agent.taskName}`;
  return Object.freeze(names);
}

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

/** An unparsable time must not poison the comparison; NaN makes a sort undefined. */
function momentOrder(occurredAt: string): number {
  const parsed = Date.parse(occurredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function transcriptRows(
  view: TranscriptView,
  clock: TranscriptClock = localTranscriptTime,
  mine: readonly TranscriptTurn[] = [],
): readonly TranscriptRow[] {
  const captured = view.lines.map((line) =>
    Object.freeze({
      sequence: line.sequence,
      time: clock(line.occurredAt),
      stream: line.stream,
      text: line.text,
      owner: line.owner,
    }),
  );
  if (mine.length === 0) return Object.freeze(captured);
  // An answer is half the conversation. Without it the pane shows an agent
  // asking and then, minutes later, carrying on for no visible reason, and a
  // reader who has just answered cannot tell whether it arrived.
  //
  // Captured lines keep the order they were captured in: a sequence is the only
  // total order a stream has, and its clock can repeat. So each turn is placed
  // among them rather than everything being sorted by time.
  const rows: TranscriptRow[] = [];
  const pending = [...mine].sort(
    (left, right) => momentOrder(left.occurredAt) - momentOrder(right.occurredAt),
  );
  let next = 0;
  for (const [index, line] of view.lines.entries()) {
    while (
      next < pending.length &&
      momentOrder(pending[next]?.occurredAt ?? "") <= momentOrder(line.occurredAt)
    ) {
      const turn = pending[next];
      next += 1;
      if (turn === undefined) continue;
      rows.push(
        Object.freeze({
          sequence: -next,
          time: clock(turn.occurredAt),
          stream: "you" as const,
          text: turn.text,
          owner: turn.owner,
        }),
      );
    }
    const row = captured[index];
    if (row !== undefined) rows.push(row);
  }
  for (const turn of pending.slice(next)) {
    rows.push(
      Object.freeze({
        sequence: -1 - rows.length,
        time: clock(turn.occurredAt),
        stream: "you" as const,
        text: turn.text,
        owner: turn.owner,
      }),
    );
  }
  return Object.freeze(rows);
}

/** A scope that merged owners names each one; a scope of a single owner does not. */
export function transcriptShowsOwner(view: TranscriptView): boolean {
  const owner = view.owner;
  if (owner === undefined) return false;
  return view.lines.some((line) => line.owner.kind !== owner.kind || line.owner.id !== owner.id);
}

/** The exact bounded text the pane displays, reused by copy and download. */
export function transcriptPlainText(
  view: TranscriptView,
  clock: TranscriptClock = localTranscriptTime,
  names: TranscriptNames = NO_NAMES,
): string {
  const withOwner = transcriptShowsOwner(view);
  return transcriptRows(view, clock)
    .map((row) =>
      withOwner
        ? `${row.time}\t${transcriptOwnerLabel(row.owner, names)}\t${row.stream}\t${row.text}`
        : `${row.time}\t${row.stream}\t${row.text}`,
    )
    .join("\n");
}

/**
 * Names the agent when the run has told us one, because `dispatch dispatch_d01b…`
 * identifies the line without saying who wrote it.
 */
export function transcriptOwnerLabel(
  owner: PortalTranscriptOwner,
  names: TranscriptNames = NO_NAMES,
): string {
  return names[owner.id] ?? `${owner.kind} ${owner.id}`;
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
