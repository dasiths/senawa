/**
 * How a node is drawn: its mark, the word for its lifecycle, and the tone that
 * word wears. The tree and the graph are two readings of one workflow, so they
 * read from one vocabulary rather than each keeping a copy.
 */

export const NODE_MARKS: Readonly<Record<string, string>> = Object.freeze({
  workflow: "\u25c7",
  phase: "\u25c6",
  task: "\u25cf",
  criterion: "\u25cb",
});

export const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  defined: "not started",
  "not-started": "not started",
  running: "working",
  "awaiting-human": "waiting on you",
  accepted: "done",
  failed: "failed",
  superseded: "superseded",
});

export const STATE_TONES: Readonly<Record<string, string>> = Object.freeze({
  defined: "is-idle",
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

export function stateTone(lifecycle: string): string {
  return STATE_TONES[lifecycle] ?? "is-waiting";
}

export function stateLabel(lifecycle: string): string {
  return STATE_LABELS[lifecycle] ?? lifecycle;
}

/** One dot and one word, the same in both readings. */
export function statePill(lifecycle: string): HTMLElement {
  const pill = document.createElement("span");
  pill.className = `state ${stateTone(lifecycle)}`;
  pill.textContent = stateLabel(lifecycle);
  return pill;
}
