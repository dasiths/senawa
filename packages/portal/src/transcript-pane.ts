import {
  type TranscriptRow,
  type TranscriptScope,
  type TranscriptView,
  transcriptDownloadName,
  transcriptOwnerLabel,
  transcriptPlainText,
  transcriptRows,
  transcriptShowsOwner,
} from "./transcript-view-model.js";

export interface TranscriptPaneActions {
  readonly setTranscriptPinned: (pinned: boolean) => void;
  readonly setTranscriptScope: (scope: TranscriptScope) => void;
}

export interface TranscriptPaneInput {
  readonly view: TranscriptView;
  readonly scope: TranscriptScope;
  readonly actions: TranscriptPaneActions;
}

export interface TranscriptPaneSnapshot {
  readonly ownerKind: string | undefined;
  readonly ownerId: string | undefined;
  readonly scope: TranscriptScope;
  readonly lineCount: number;
  readonly pinned: boolean;
  readonly unseen: number;
  readonly plainText: string;
}

declare global {
  interface Window {
    __senawaTranscriptPane?: TranscriptPaneSnapshot;
  }
}

const LOG_SELECTOR = ".agent-terminal-log";
/** Sub-pixel and rounding slack that still counts as sitting at the tail. */
const TAIL_SLACK = 12;

export function transcriptPaneView(input: TranscriptPaneInput): HTMLElement {
  const { view, scope, actions } = input;
  const pane = element("section", "agent-terminal");
  const rows = transcriptRows(view);
  const plainText = transcriptPlainText(view);
  pane.append(bar(view, scope, rows.length, plainText, actions));
  pane.append(log(view, rows, actions));
  window.__senawaTranscriptPane = Object.freeze({
    ownerKind: view.owner?.kind,
    ownerId: view.owner?.id,
    scope,
    lineCount: rows.length,
    pinned: view.pinned,
    unseen: view.unseen,
    plainText,
  });
  return pane;
}

function bar(
  view: TranscriptView,
  scope: TranscriptScope,
  lineCount: number,
  plainText: string,
  actions: TranscriptPaneActions,
): HTMLElement {
  const header = element("div", "agent-terminal-bar");
  header.append(textElement("h2", "compact-heading", "Agent output"));
  header.append(
    textElement(
      "span",
      "agent-terminal-scope mono",
      view.owner === undefined ? "No node selected" : transcriptOwnerLabel(view.owner),
    ),
  );
  const controls = element("div", "agent-terminal-controls");
  const runWide = commandButton(
    scope === "run" ? "Scope to selected node" : "Scope to whole run",
    () => actions.setTranscriptScope(scope === "run" ? "node" : "run"),
  );
  runWide.className = "command agent-terminal-run-scope";
  runWide.setAttribute("aria-pressed", scope === "run" ? "true" : "false");
  controls.append(runWide);
  const copy = commandButton("Copy output", () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard !== undefined) void clipboard.writeText(plainText).catch(() => undefined);
  });
  copy.disabled = lineCount === 0;
  const download = commandButton("Download output", () => {
    if (view.owner !== undefined) downloadText(plainText, transcriptDownloadName(view.owner));
  });
  download.disabled = lineCount === 0 || view.owner === undefined;
  controls.append(copy, download);
  if (!view.pinned) {
    const jump = commandButton(`Jump to latest (${view.unseen} unseen)`, () =>
      actions.setTranscriptPinned(true),
    );
    jump.className = "command agent-terminal-jump";
    controls.append(jump);
  }
  controls.append(textElement("span", "agent-terminal-count", `${lineCount} retained lines`));
  header.append(controls);
  return header;
}

function log(
  view: TranscriptView,
  rows: readonly TranscriptRow[],
  actions: TranscriptPaneActions,
): HTMLElement {
  const label =
    view.owner === undefined
      ? "Agent output"
      : `Agent output for ${transcriptOwnerLabel(view.owner)}`;
  const pane = element("div", "agent-terminal-log");
  pane.setAttribute("role", "log");
  pane.setAttribute("aria-label", label);
  pane.tabIndex = 0;
  if (rows.length === 0) {
    pane.append(
      textElement(
        "p",
        "agent-terminal-empty",
        view.owner === undefined
          ? "Select a phase or task node to read its agent output."
          : view.owner.kind === "run"
            ? "No durable agent output is recorded for this run."
            : "No durable agent output is recorded for this node.",
      ),
    );
    return pane;
  }
  for (const row of rows) {
    const line = element("div", `agent-terminal-row ${row.stream}`);
    line.dataset.sequence = String(row.sequence);
    line.append(textElement("span", "agent-terminal-time", row.time));
    if (transcriptShowsOwner(view)) {
      line.dataset.owner = transcriptOwnerLabel(row.owner);
      line.append(textElement("span", "agent-terminal-owner", transcriptOwnerLabel(row.owner)));
    }
    line.append(
      textElement("span", "agent-terminal-stream", row.stream),
      textElement("span", "agent-terminal-text", row.text),
    );
    pane.append(line);
  }
  pane.addEventListener(
    "scroll",
    () => {
      const atTail = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= TAIL_SLACK;
      if (atTail !== view.pinned) actions.setTranscriptPinned(atTail);
    },
    { passive: true },
  );
  pane.addEventListener("keydown", (event) => {
    if (event.key !== "End") return;
    event.preventDefault();
    pane.scrollTop = pane.scrollHeight;
    if (!view.pinned) actions.setTranscriptPinned(true);
  });
  return pane;
}

export function captureTranscriptScroll(root: HTMLElement): number | undefined {
  return root.querySelector<HTMLElement>(LOG_SELECTOR)?.scrollTop;
}

export function restoreTranscriptScroll(
  root: HTMLElement,
  offset: number | undefined,
  pinned: boolean,
): void {
  const pane = root.querySelector<HTMLElement>(LOG_SELECTOR);
  if (pane === null) return;
  pane.scrollTop = pinned ? pane.scrollHeight : (offset ?? 0);
}

function downloadText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function commandButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "command";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function element<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
): HTMLElementTagNameMap[Tag] {
  const value = document.createElement(tag);
  value.className = className;
  return value;
}

function textElement<Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className: string,
  text: string,
): HTMLElementTagNameMap[Tag] {
  const value = element(tag, className);
  value.textContent = text;
  return value;
}
