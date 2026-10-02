/**
 * How a node is drawn: its mark, the word for its run state, and the tone that
 * word wears. The tree and the graph are two readings of one workflow, so they
 * read from one vocabulary rather than each keeping a copy.
 *
 * The state is `runState`. A node also carries `lifecycle`, which is always the
 * literal `defined` and therefore says nothing about what the node is doing.
 */

export const NODE_MARKS: Readonly<Record<string, string>> = Object.freeze({
  workflow: "\u25c7",
  phase: "\u25c6",
  task: "\u25cf",
  criterion: "\u25cb",
});

export const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "not-started": "not started",
  running: "working",
  "awaiting-human": "waiting on you",
  accepted: "done",
  failed: "failed",
  superseded: "superseded",
});

export const STATE_TONES: Readonly<Record<string, string>> = Object.freeze({
  "not-started": "is-idle",
  running: "is-working",
  "awaiting-human": "is-waiting",
  accepted: "is-closed",
  failed: "is-failed",
  superseded: "is-idle",
});

export function nodeMark(kind: string): string {
  return NODE_MARKS[kind] ?? "\u25cb";
}

export function stateTone(runState: string): string {
  return STATE_TONES[runState] ?? "is-waiting";
}

export function stateLabel(runState: string): string {
  return STATE_LABELS[runState] ?? runState;
}

/** One dot and one word, the same in both readings. */
export function statePill(runState: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = `state ${stateTone(runState)}`;
  pill.textContent = stateLabel(runState);
  return pill;
}
