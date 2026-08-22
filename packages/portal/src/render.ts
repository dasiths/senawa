import {
  decodeCanonicalJsonValue,
  type JsonValue,
  MAX_ANSWER_LENGTH,
  type PortalAgentSummary,
  type PortalArtifactMetadata,
  type PortalDeliveryRecord,
  type PortalGraphEdge,
  type PortalGraphNode,
  type PortalHumanNeed,
} from "@senawa/protocol";
import { allowanceResult, allowanceReviewFromSource } from "./allowance-review.js";
import { type BoundedJsonNode, boundedJsonModel } from "./bounded-json.js";
import { narrationBusy, narrationText } from "./command-narrator.js";
import { focusGraphViewport } from "./graph-diagram.js";
import { drawGraphFlowEdges, graphFlowView } from "./graph-flow.js";
import { executionOrdered, graphLayout } from "./graph-layout.js";
import { chevronMark, copyMark, locateMark } from "./marks.js";
import { type NodeToolbarAction, nodeToolbarView } from "./node-toolbar.js";
import { nodeMark, statePill } from "./node-vocabulary.js";
import {
  attentionTitle,
  pendingQuestionNeed,
  type QuestionAttention,
  questionAttention,
} from "./question-attention.js";
import {
  dragRailWidth,
  RAIL_MAX,
  RAIL_MIN,
  type RailLayout,
  type RailSide,
  railCollapsed,
  railKeyboardLayout,
  railTrackToken,
  railTrackWidth,
  railWidth,
  resizeRail,
} from "./rail-layout.js";
import { PORTAL_ROUTES, type PortalRouteName } from "./router.js";
import {
  actionsLocked,
  currentFreshness,
  globalStatus,
  hasCapability,
  selectedOverview,
} from "./selectors.js";
import {
  artifactContentKey,
  DETAIL_TABS,
  type DetailTab,
  type DialogKind,
  type GraphMode,
  INITIAL_GRAPH_VIEWPORT,
  type PortalDialogState,
  type PortalGraphViewport,
  type PortalState,
  revisionKey,
  runKey,
} from "./state.js";
import { timelineMoments } from "./timeline.js";
import {
  captureTranscriptScroll,
  restoreTranscriptScroll,
  transcriptPaneView,
} from "./transcript-pane.js";
import type { TranscriptScope } from "./transcript-view-model.js";
import { transcriptNames } from "./transcript-view-model.js";

const GRAPH_MODES: readonly GraphMode[] = Object.freeze(["diagram", "tree"]);

export interface PortalRenderActions {
  readonly navigate: (route: PortalRouteName) => void;
  readonly selectRun: (repositoryId: string, runId: string) => void;
  readonly setFilter: (value: string) => void;
  readonly setGraphMode: (mode: GraphMode) => void;
  readonly setGraphViewport: (viewport: PortalGraphViewport) => void;
  readonly unfoldNode: (nodeId: string) => void;
  readonly toggleRecord: (recordKey: string) => void;
  readonly focusRecord: (recordId: string) => void;
  readonly openNeed: (need: PortalHumanNeed, triggerId: string) => void;
  readonly openRunControl: (kind: "pause" | "resume" | "end", triggerId: string) => void;
  readonly openAgentAction: (
    kind: "steer" | "override",
    agent: PortalAgentSummary,
    triggerId: string,
  ) => void;
  readonly closeDialog: () => void;
  readonly submitDialog: (kind: DialogKind, values: Readonly<Record<string, string>>) => void;
  readonly loadArtifact: (artifact: PortalArtifactMetadata) => void;
  readonly pageActivity: (kind: "events" | "receipts", before: number) => void;
  readonly toggleRightRail: (open: boolean) => void;
  readonly setTranscriptPinned: (pinned: boolean) => void;
  readonly setTranscriptScope: (scope: TranscriptScope) => void;
  readonly setDetailTab: (tab: DetailTab) => void;
  readonly sendReply: (need: PortalHumanNeed | undefined, text: string) => void;
  readonly setRailLayout: (layout: RailLayout) => void;
  readonly setRailCollapsed: (side: RailSide, collapsed: boolean) => void;
  readonly openAssetOverlay: (artifactId: string, triggerId: string) => void;
  readonly closeAssetOverlay: () => void;
  readonly saveAnswerDraft: (value: string) => void;
}

const renderedDialogs = new WeakMap<HTMLElement, PortalDialogState>();

declare global {
  interface Window {
    __senawaRailLayout?: {
      readonly left: number;
      readonly right: number;
      readonly leftCollapsed: boolean;
      readonly rightCollapsed: boolean;
    };
  }
}

export function renderPortal(
  root: HTMLElement,
  state: PortalState,
  actions: PortalRenderActions,
): void {
  const focus = focusIdentity(root);
  const transcriptScroll = captureTranscriptScroll(root);
  const dialogValues =
    renderedDialogs.get(root) === state.ui.dialog ? captureDialogValues(root) : undefined;
  const narrator = root.querySelector<HTMLParagraphElement>(".command-narrator") ?? undefined;
  const attention = questionAttention(pendingQuestionNeed(state.humanNeeds), Date.now());
  const shell = element("div", "portal-shell");
  shell.append(renderHeader(state, actions, narrator), renderNavigation(state, actions));
  const body = element("div", "portal-body");
  applyRailGeometry(body, state.ui.railLayout);
  body.append(
    renderMain(state, actions),
    railDivider("right", state, actions),
    renderRightRail(state, actions, attention),
  );
  shell.append(body);
  root.replaceChildren(shell);
  // Lines between the phases are measured from the laid-out flow, so they can
  // only be drawn once the flow is in the document.
  requestAnimationFrame(() => drawGraphFlowEdges(root));
  document.title = attentionTitle(attention !== undefined);
  if (state.ui.dialog !== undefined) {
    renderDialog(root, state.ui.dialog, actions);
    renderedDialogs.set(root, state.ui.dialog);
    if (dialogValues !== undefined) restoreDialogValues(root, dialogValues);
  } else {
    renderedDialogs.delete(root);
  }
  if (state.ui.dialog === undefined && state.ui.assetOverlay !== undefined)
    renderAssetOverlay(root, state, actions);
  restoreTranscriptScroll(root, transcriptScroll, state.ui.transcript.pinned);
  restoreFocus(focus);
}

/** Recomputes only the elapsed strings so a live question ages without a full rerender. */
export function refreshQuestionAttention(root: HTMLElement, state: PortalState): void {
  const banner = root.querySelector<HTMLElement>(".question-attention");
  const attention = questionAttention(pendingQuestionNeed(state.humanNeeds), Date.now());
  document.title = attentionTitle(attention !== undefined);
  if (banner === null || attention === undefined) return;
  const elapsed = banner.querySelector<HTMLElement>(".question-attention-elapsed");
  if (elapsed !== null && elapsed.textContent !== attention.label)
    elapsed.textContent = attention.label;
  banner.classList.toggle("overdue", attention.overdue);
  const overdue = banner.querySelector<HTMLElement>(".question-attention-overdue");
  if (overdue !== null) overdue.hidden = !attention.overdue;
}

function captureDialogValues(root: HTMLElement): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const form = root.querySelector<HTMLFormElement>(".review-dialog form");
  if (form === null) return values;
  for (const [name, value] of new FormData(form)) {
    if (typeof value === "string") values.set(name, value);
  }
  return values;
}

function restoreDialogValues(root: HTMLElement, values: ReadonlyMap<string, string>): void {
  for (const control of root.querySelectorAll<
    HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >(".review-dialog [name]")) {
    const value = values.get(control.name);
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      control.checked = value !== undefined && value === control.value;
    } else if (value !== undefined) {
      control.value = value;
    }
  }
}

type FocusIdentity =
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "key"; readonly value: string }
  | { readonly kind: "name"; readonly value: string }
  | { readonly kind: "tab"; readonly value: string };

function focusIdentity(root: HTMLElement): FocusIdentity | undefined {
  const active = document.activeElement;
  if (!isFocusable(active) || !root.contains(active)) return undefined;
  if (active.id.length > 0) return { kind: "id", value: active.id };
  if (active.dataset.focusKey !== undefined) {
    return { kind: "key", value: active.dataset.focusKey };
  }
  if (active.getAttribute("role") === "tab") {
    return { kind: "tab", value: active.textContent ?? "" };
  }
  const name = active.getAttribute("name");
  return name === null ? undefined : { kind: "name", value: name };
}

function isFocusable(value: Element | null): value is HTMLElement | SVGElement {
  return value instanceof HTMLElement || value instanceof SVGElement;
}

function focusableMatches(selector: string): readonly (HTMLElement | SVGElement)[] {
  return [...document.querySelectorAll(selector)].filter(isFocusable);
}

function restoreFocus(identity: FocusIdentity | undefined): void {
  if (identity === undefined) return;
  if (identity.kind === "id") {
    document.getElementById(identity.value)?.focus();
    return;
  }
  if (identity.kind === "key") {
    const target = focusableMatches("[data-focus-key]").find(
      (candidate) => candidate.dataset.focusKey === identity.value,
    );
    target?.focus();
    return;
  }
  const selector = identity.kind === "tab" ? "[role=tab]" : "[name]";
  const target = focusableMatches(selector).find((candidate) =>
    identity.kind === "tab"
      ? candidate.textContent === identity.value
      : candidate.getAttribute("name") === identity.value,
  );
  target?.focus();
}

function renderHeader(
  state: PortalState,
  actions: PortalRenderActions,
  narrator: HTMLParagraphElement | undefined,
): HTMLElement {
  const header = element("header", "app-header");
  const identity = element("div", "product-identity");
  identity.append(
    textElement("span", "product-mark", "S"),
    textElement("strong", "product-name", "Senawa"),
  );
  const runSwitch = element("label", "run-switcher");
  runSwitch.append(textElement("span", "visually-hidden", "Repository / run"));
  const select = document.createElement("select");
  select.id = "run-switcher";
  select.setAttribute("aria-label", "Select repository and run");
  const repositories = state.caches.repositories?.repositories ?? [];
  for (const repository of repositories) {
    const runs = state.caches.runsByRepository[repository.repositoryId]?.runs ?? [];
    for (const run of runs) {
      const option = document.createElement("option");
      option.value = `${repository.repositoryId}\u0000${run.runId}`;
      option.textContent = `${repository.displayName} / ${run.displayName}`;
      option.selected =
        repository.repositoryId === state.selectedRepositoryId && run.runId === state.selectedRunId;
      select.append(option);
    }
  }
  select.addEventListener("change", () => {
    const [repositoryId, runId] = select.value.split("\u0000");
    if (repositoryId !== undefined && runId !== undefined) actions.selectRun(repositoryId, runId);
  });
  runSwitch.append(select);
  const tools = element("div", "header-tools");
  // Opening a rail that is already open looks like a dead control, which is what
  // this was whenever the rail was left open. A badge that counts what needs you
  // should take you to it, and every need lives on the node it blocks.
  const needsButton = commandButton(`${String(state.humanNeeds.length)} waiting on you`, () => {
    if (state.humanNeeds.length > 0) actions.navigate("workflow");
    actions.toggleRightRail(true);
  });
  needsButton.className = state.humanNeeds.length > 0 ? "rail-toggle has-needs" : "rail-toggle";
  tools.append(renderStatusStrip(state, narrator), needsButton);
  header.append(identity, runSwitch, tools);
  return header;
}

/**
 * How the portal is doing sits beside the product name as one quiet cluster of
 * dots. It used to be a full-width band of four competing pills above the work.
 */
function renderStatusStrip(
  state: PortalState,
  narrator: HTMLParagraphElement | undefined,
): HTMLElement {
  const strip = element("section", "global-strip");
  strip.setAttribute("aria-label", "Portal status");
  const connection = statusBadge(state.connection.status, `Connection ${state.connection.status}`);
  connection.setAttribute("role", "status");
  connection.setAttribute("aria-live", "polite");
  const freshness = currentFreshness(state);
  const pending = Object.keys(state.pending).length;
  // Healthy is the common case and deserves the quietest rendering it can have
  // while still saying so. Only a count that is not zero earns emphasis.
  const dataBadge = statusBadge(freshness, `Data ${freshness}`);
  if (freshness === "current") dataBadge.classList.add("visually-hidden");
  // The needs pill beside this says the same number, in words a reader can act
  // on, so this one stays for assistive technology and leaves the eye alone.
  const needsBadge = statusBadge(
    state.humanNeeds.length > 0 ? "needs" : "clear",
    `${String(state.humanNeeds.length)} human needs`,
  );
  needsBadge.classList.add("visually-hidden");
  strip.append(
    statusBadge(state.session.status, state.session.status),
    connection,
    dataBadge,
    statusBadge(pending > 0 ? "pending" : "clear", `${String(pending)} pending commands`),
    needsBadge,
    renderCommandNarrator(state, narrator),
  );
  const summary = textElement("span", "visually-hidden", globalStatus(state));
  summary.setAttribute("aria-live", "polite");
  strip.append(summary);
  return strip;
}

/**
 * Reuses the same live-region node across renders so the narrator announces only
 * when the one pending command actually changes.
 */
function renderCommandNarrator(
  state: PortalState,
  narrator: HTMLParagraphElement | undefined,
): HTMLElement {
  const element_ = narrator ?? element("p", "command-narrator");
  element_.setAttribute("role", "status");
  element_.setAttribute("aria-live", "polite");
  const text = narrationText(state.ui.narration);
  if (element_.textContent !== text) element_.textContent = text;
  const busy = narrationBusy(state.ui.narration);
  element_.setAttribute("aria-busy", String(busy));
  element_.classList.toggle("busy", busy);
  return element_;
}

/**
 * The banner element persists while one question identity persists so its
 * `role="alert"` announces on arrival instead of on every rerender.
 */
function applyRailGeometry(body: HTMLElement, layout: RailLayout): void {
  body.dataset.railLeft = railTrackToken(layout, "left");
  body.dataset.railRight = railTrackToken(layout, "right");
  window.__senawaRailLayout = Object.freeze({
    left: layout.left,
    right: layout.right,
    leftCollapsed: layout.leftCollapsed,
    rightCollapsed: layout.rightCollapsed,
  });
}

function railDivider(
  side: RailSide,
  state: PortalState,
  actions: PortalRenderActions,
): HTMLElement {
  const layout = state.ui.railLayout;
  const name = side === "left" ? "navigation" : "attention";
  const divider = element("div", `rail-divider rail-divider-${side}`);
  const handle = element("div", "rail-handle");
  handle.id = `rail-handle-${side}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", `Resize ${name} rail`);
  handle.setAttribute("aria-controls", side === "left" ? "primary-nav" : "right-rail");
  handle.setAttribute("aria-valuemin", String(RAIL_MIN));
  handle.setAttribute("aria-valuemax", String(RAIL_MAX));
  handle.setAttribute("aria-valuenow", String(railTrackWidth(layout, side)));
  handle.tabIndex = 0;
  handle.addEventListener("keydown", (event) => {
    const next = railKeyboardLayout(layout, side, event.key, event.shiftKey);
    if (next === undefined) return;
    event.preventDefault();
    actions.setRailLayout(next);
  });
  attachRailDrag(handle, side, layout, actions);
  divider.append(handle);
  return divider;
}

/**
 * The drag paints the geometry directly and commits once on release, so a
 * rerender can never interrupt the gesture.
 */
function attachRailDrag(
  handle: HTMLElement,
  side: RailSide,
  layout: RailLayout,
  actions: PortalRenderActions,
): void {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = railWidth(layout, side);
    const body = handle.closest<HTMLElement>(".portal-body");
    let latest = startWidth;
    document.documentElement.dataset.railDragging = "true";
    const move = (moved: PointerEvent) => {
      latest = dragRailWidth(side, startWidth, moved.clientX - startX);
      handle.setAttribute("aria-valuenow", String(latest));
      if (body === null) return;
      if (side === "left") body.dataset.railLeft = String(latest);
      else body.dataset.railRight = String(latest);
    };
    const settle = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
      delete document.documentElement.dataset.railDragging;
      actions.setRailLayout(resizeRail(layout, side, latest));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  });
}

function railToggle(
  side: RailSide,
  state: PortalState,
  actions: PortalRenderActions,
): HTMLButtonElement {
  const collapsed = railCollapsed(state.ui.railLayout, side);
  const name = side === "left" ? "navigation" : "attention";
  const pointsRight = side === "left" ? collapsed : !collapsed;
  const button = commandButton(pointsRight ? "\u203a" : "\u2039", () =>
    actions.setRailCollapsed(side, !collapsed),
  );
  button.className = "rail-collapse";
  button.id = `rail-collapse-${side}`;
  button.setAttribute("aria-expanded", String(!collapsed));
  button.setAttribute("aria-controls", side === "left" ? "primary-nav" : "right-rail");
  button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${name} rail`);
  return button;
}

/**
 * Four doors across the top rather than a rail down the side. A rail that holds
 * four fixed destinations spends width on furniture, and the width belongs to
 * the work.
 */
function renderNavigation(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const nav = element("nav", "primary-nav");
  nav.id = "primary-nav";
  nav.setAttribute("aria-label", "Run views");
  const list = element("div", "nav-list");
  list.setAttribute("role", "tablist");
  for (const route of PORTAL_ROUTES) {
    const button = commandButton(routeLabel(route), () => actions.navigate(route));
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.route.name === route));
    button.tabIndex = state.route.name === route ? 0 : -1;
    button.className = state.route.name === route ? "nav-item active" : "nav-item";
    button.addEventListener("keydown", (event) => navigateTabs(event, button, list));
    list.append(button);
  }
  nav.append(list);
  return nav;
}

/**
 * What the run is and what it is doing. A revision and a cursor are how a reader
 * checks a claim, not how they form one, so they sit under a disclosure.
 */
function renderRunHead(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const head = element("div", "run-head");
  const overview = selectedOverview(state);
  const title = textElement(
    "h1",
    "run-title",
    overview?.displayName ?? routeLabel(state.route.name),
  );
  title.id = "route-heading";
  title.tabIndex = -1;
  head.append(title);
  if (overview !== undefined) {
    head.append(
      textElement("span", `state is-${overview.mode}`, overview.mode),
      textElement(
        "span",
        "run-progress",
        `${String(overview.counts.closedPhases)} of ${String(overview.counts.phases)} phases closed`,
      ),
    );
    // Pausing, resuming and ending are decisions about this run, so they belong
    // beside what the run is doing rather than under a disclosure of facts.
    const controls = element("div", "run-controls");
    const locked = actionsLocked(state) || !hasCapability(state, "portal-write-run-control");
    if (overview.mode === "running")
      controls.append(runControlButton("Pause", "pause", locked, actions));
    if (overview.mode === "paused")
      controls.append(runControlButton("Resume", "resume", locked, actions));
    if (!overview.terminal)
      controls.append(runControlButton("End run", "end", locked, actions, true));
    if (controls.childElementCount > 0) head.append(controls);
  }
  return head;
}

function renderIdentities(state: PortalState): HTMLElement {
  const overview = selectedOverview(state);
  const facts = element("dl", "nav-facts");
  appendFact(facts, "Mode", overview?.mode ?? "Unavailable");
  appendFact(facts, "Graph", overview?.sync.graphRevision.slice(0, 12) ?? "Unavailable");
  appendFact(facts, "Cursor", String(state.cursor));
  const proof = element("details", "proof");
  proof.append(textElement("summary", "disclosure-summary", "Identities and revisions"), facts);
  return proof;
}

function renderMain(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const main = element("main", "main-workspace");
  main.id = "main";
  main.tabIndex = -1;
  main.append(renderRunHead(state, actions));
  if (state.session.status === "expired" || state.session.status === "invalid") {
    const failure = element("section", "terminal-state");
    failure.setAttribute("role", "alert");
    failure.append(
      textElement(
        "h2",
        "section-heading",
        state.session.status === "expired" ? "Session expired" : "Session unavailable",
      ),
      textElement(
        "p",
        "",
        state.session.message ?? "Open a new portal bootstrap from the Senawa CLI.",
      ),
    );
    main.append(failure);
    return main;
  }
  if (state.selectedRepositoryId === undefined || state.selectedRunId === undefined) {
    main.append(textElement("p", "empty-state", "No discovered workflow run is available."));
    return main;
  }
  switch (state.route.name) {
    case "record":
      main.append(renderRecord(state, actions));
      break;
    case "workflow":
      main.append(renderWorkflow(state, actions));
      break;
    case "artifacts":
      main.append(renderArtifacts(state, actions));
      break;
    case "agents":
      main.append(renderAgents(state, actions));
      break;
  }
  main.append(renderIdentities(state));
  return main;
}

// What the run is, and what has happened to it, are the same question asked at
// two lengths. Separating them made the first tab seven revision counters and
// the second an undifferentiated log.
/**
 * What happened, in order, and what it produced.
 *
 * This was four cards inherited from a debugging view: counts, revisions, a
 * timeline and a list of receipts. It answered "what does the authority
 * contain", which is the question the authority's operator asks. A person
 * watching their own work get done arrives asking what happened, what it made,
 * and what they decided, so that is what this reads as now. The counts and the
 * revisions moved under the proof disclosure, where a fact you check but do not
 * form a view from belongs.
 */
function renderRecord(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "record-view");
  section.append(renderHistory(state, actions), renderIntegrations(state));
  const receipts = renderReceipts(state, actions);
  if (receipts !== undefined) section.append(receipts);
  section.append(renderRunFacts(state, actions));
  return section;
}

/** The commands this browser submitted, which is machinery, and folded away. */
function renderReceipts(state: PortalState, actions: PortalRenderActions): HTMLElement | undefined {
  const ids = selectedIds(state);
  if (ids === undefined) return undefined;
  const page = state.caches.receipts[runKey(ids.repositoryId, ids.runId)];
  const receipts = page?.receipts ?? [];
  if (receipts.length === 0) return undefined;
  const panel = element("section", "card activity-panel");
  const body = element("div", "pane");
  body.append(
    activityList(
      "Commands you submitted",
      receipts,
      state,
      actions,
      (entry) => `${entry.cursor} ${entry.status} ${entry.commandId}`,
    ),
  );
  const holder = element("details", "proof");
  holder.append(
    textElement(
      "summary",
      "disclosure-summary",
      `Commands you submitted (${String(receipts.length)})`,
    ),
    body,
  );
  panel.append(holder);
  if (page?.hasEarlier === true) {
    const paging = element("div", "paging-row");
    paging.append(
      commandButton("Earlier receipts", () =>
        actions.pageActivity("receipts", page.receipts[0]?.cursor ?? page.earliestCursor),
      ),
    );
    body.append(paging);
  }
  return panel;
}

/** What a reader checks a claim against, rather than forms a view from. */
function renderRunFacts(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const overview = selectedOverview(state);
  const proof = element("details", "proof");
  proof.append(textElement("summary", "disclosure-summary", "Counts, effects and revisions"));
  if (overview === undefined) {
    proof.append(textElement("p", "empty-state", "Loading run authority."));
    return proof;
  }
  const counts = element("dl", "count-grid");
  for (const [label, value] of [
    ["Phases", overview.counts.phases],
    ["Tasks", overview.counts.tasks],
    ["Criteria", overview.counts.criteria],
    ["Active effects", overview.counts.activeEffects],
    ["Uncertain effects", overview.counts.uncertainEffects],
  ] as const)
    appendMetric(counts, label, value);
  const vectorFacts = element("dl", "dense-facts");
  for (const [label, value] of Object.entries(overview.sync))
    appendFact(vectorFacts, label, String(value));
  proof.append(counts, vectorFacts);
  return proof;
}

/**
 * What happened, in order.
 *
 * Built from the event stream, which is the only projection carrying both a
 * time and a position. Delivery records carry neither, so what a phase produced
 * hangs off the moment that published it rather than standing in a table beside
 * it pretending to an order it does not have.
 */
function renderHistory(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading what happened");
  const key = runKey(ids.repositoryId, ids.runId);
  const events = state.caches.events[key]?.events ?? [];
  const revision = state.vector?.graphRevision;
  const nodes =
    revision === undefined
      ? []
      : (state.caches.graphNodes[revisionKey(ids.repositoryId, ids.runId, revision)]?.nodes ?? []);
  const produced = state.caches.delivery[key]?.records ?? [];
  const needle = state.ui.filter.toLocaleLowerCase();
  const moments = timelineMoments(events, nodes).filter((moment) =>
    `${moment.what} ${moment.where ?? ""} ${moment.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(needle),
  );
  const section = element("section", "card timeline-view");
  const header = element("header", "view-toolbar");
  header.append(
    textElement("h2", "card-heading", "What happened"),
    textElement(
      "span",
      "count",
      moments.length === 0 ? "nothing yet" : `${String(moments.length)} moments \u00b7 newest last`,
    ),
    filterInput(state, actions, "Filter what happened"),
  );
  section.append(header);
  if (moments.length === 0) {
    section.append(
      textElement(
        "p",
        "empty-state",
        needle.length > 0 ? "Nothing here matches that." : "This run has not done anything yet.",
      ),
    );
    return section;
  }
  const opened = new Set(state.ui.openedRecords);
  const list = element("ol", "timeline");
  let previous: string | undefined;
  for (const moment of moments) {
    if (moment.where !== undefined && moment.where !== previous) {
      list.append(textElement("li", "timeline-where", moment.where));
      previous = moment.where;
    }
    const item = element("li", `moment tone-${moment.tone}`);
    item.append(textElement("span", "moment-time", moment.time));
    const body = element("div", "moment-body");
    body.append(textElement("p", "moment-what", moment.what));
    if (moment.detail !== undefined) body.append(textElement("p", "moment-detail", moment.detail));
    const recordKey = `moment:${moment.momentId}`;
    body.append(
      recordDisclosure(recordKey, opened.has(recordKey), actions, () =>
        renderJson(asJson(moment.record), "Exact record"),
      ),
    );
    item.append(body);
    list.append(item);
  }
  section.append(list);
  // What a phase produced has no time of its own, so it is stated apart from the
  // order rather than folded into it as though it had one.
  if (produced.length > 0) {
    section.append(
      disclosure(
        `What the run produced (${String(produced.length)}, undated)`,
        summaryTable(
          ["Kind", "Phase or task", "Attempt", "State", "Detail"],
          produced.map((record) => [
            record.kind.replaceAll("-", " "),
            record.phaseId ?? record.taskId ?? "-",
            record.attempt === undefined ? "-" : String(record.attempt),
            deliveryState(record),
            deliveryMetadata(record),
          ]),
          "What the run produced",
        ),
      ),
    );
  }
  return section;
}

function deliveryState(record: PortalDeliveryRecord): string {
  if (record.kind === "phase-output") return record.accepted ? "accepted" : "published";
  if (record.kind === "fan-out-evaluation") return record.applied ? "applied" : "evaluated";
  return record.state ?? record.disposition ?? "recorded";
}

function deliveryMetadata(record: PortalDeliveryRecord): string {
  return [
    record.outputName,
    record.schemaKey,
    record.forEachKey,
    record.trigger,
    record.contentDigest?.slice(0, 12),
    record.taskSetDigest?.slice(0, 12),
    record.proposalDigest?.slice(0, 12),
  ]
    .filter((value): value is string => value !== undefined)
    .join(" / ");
}

function renderWorkflow(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "card graph-view");
  const ids = selectedIds(state);
  if (ids === undefined || state.vector === undefined)
    return emptySection("Loading graph revision");
  const key = revisionKey(ids.repositoryId, ids.runId, state.vector.graphRevision);
  const nodes = state.caches.graphNodes[key]?.nodes ?? [];
  const edges = state.caches.graphEdges[key]?.edges ?? [];
  const toolbar = element("header", "view-toolbar");
  const modes = element("div", "segmented-control");
  modes.setAttribute("role", "tablist");
  for (const mode of GRAPH_MODES) {
    const button = commandButton(graphModeLabel(mode), () => actions.setGraphMode(mode));
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.ui.graphMode === mode));
    modes.append(button);
  }
  const phases = nodes.filter((node) => node.kind === "phase").length;
  const work = nodes.filter((node) => node.kind === "task").length;
  toolbar.append(
    modes,
    textElement(
      "span",
      "count",
      `${String(phases)} ${phases === 1 ? "phase" : "phases"} \u00b7 ${String(work)} ${work === 1 ? "piece" : "pieces"} of work`,
    ),
    filterInput(state, actions, "Filter the workflow"),
  );
  section.append(toolbar);
  const filtered = nodes.filter((node) =>
    graphText(node).includes(state.ui.filter.toLocaleLowerCase()),
  );
  section.append(graphBody(state, actions, edges, filtered));
  // The graph wants the width, so it takes the column and detail sits under it.
  const split = element("div", state.ui.graphMode === "diagram" ? "split is-wide" : "split");
  split.append(section);
  const focused = nodes.find(({ nodeId }) => nodeId === state.ui.focusedRecord);
  split.append(
    focused === undefined
      ? emptyDetail("Select a piece of work to read what it is doing.")
      : graphDetail(focused, state, actions, nodes, edges),
  );
  return split;
}

function emptyDetail(message: string): HTMLElement {
  const detail = element("section", "card detail detail-panel");
  const pane = element("div", "pane");
  pane.append(textElement("p", "empty-state", message));
  detail.append(pane);
  return detail;
}

function graphBody(
  state: PortalState,
  actions: PortalRenderActions,
  edges: readonly PortalGraphEdge[],
  filtered: readonly PortalGraphNode[],
): HTMLElement {
  switch (state.ui.graphMode) {
    case "diagram":
      return graphFlow(state, actions, executionOrdered(filtered, edges), edges);
    case "tree":
      return workflowTree(executionOrdered(filtered, edges), state, actions);
  }
}

/** The mock's reading: phases as bands, their members as cards, artifacts on the line. */
function graphFlow(
  state: PortalState,
  actions: PortalRenderActions,
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): HTMLElement {
  const ids = selectedIds(state);
  const key = ids === undefined ? undefined : runKey(ids.repositoryId, ids.runId);
  const agents = key === undefined ? [] : (state.caches.agents[key]?.agents ?? []);
  const artifacts = key === undefined ? [] : (state.caches.artifacts[key]?.artifacts ?? []);
  const handedOn = new Map<string, string>();
  for (const artifact of artifacts) {
    if (artifact.taskId === undefined) continue;
    const id = String(artifact.taskId);
    if (!handedOn.has(id)) handedOn.set(id, formatBytes(artifact.byteLength));
  }
  return graphFlowView({
    nodes,
    edges,
    selectedNodeId: state.ui.focusedRecord,
    unfolded: state.ui.unfoldedNodes,
    handedOn,
    decorate: (node: PortalGraphNode) => {
      const working = agents.filter((agent) => String(agent.taskId) === node.nodeId);
      const latest = [...working].sort((left, right) => left.attempt - right.attempt).at(-1);
      // A card is one control. What it is waiting for is a badge on the card;
      // the control that acts on it lives on the detail surface beside it.
      const foot: HTMLElement[] = [];
      const blocking = state.humanNeeds.filter((need) => needBlocks(need, node));
      for (const need of blocking) foot.push(textElement("span", "asks", needBadgeLabel(need)));
      if (blocking.length === 0 && node.humanNeedCount > 0)
        foot.push(textElement("span", "asks", "asks"));
      return { who: latest === undefined ? undefined : agentWho(latest), foot };
    },
    actions: {
      select: (nodeId: string) => actions.focusRecord(nodeId),
      toggleFold: (nodeId: string) => actions.unfoldNode(nodeId),
      unfoldAll: () => {
        for (const node of nodes) if (node.kind === "phase") actions.unfoldNode(node.nodeId);
      },
    },
  });
}

function graphModeLabel(mode: GraphMode): string {
  const labels: Readonly<Record<GraphMode, string>> = {
    diagram: "Graph",
    tree: "Tree",
  };
  return labels[mode];
}

// A criterion is how a phase is allowed to finish, not a sibling of the phase.
// Reading them as peers is what made eight rows of one workflow look like a
// table of unrelated records.
const NODE_KIND_ROLE: Readonly<Record<string, string>> = {
  workflow: "run",
  phase: "phase",
  task: "work",
  criterion: "exit condition",
};

/** Who is doing the work, and on what model. */
function agentWho(agent: PortalAgentSummary): HTMLElement {
  const who = element("span", "who");
  who.append(textElement("span", "who-persona", agent.persona));
  if (agent.model !== undefined) who.append(textElement("span", "model", agent.model));
  return who;
}

function workflowTree(
  nodes: readonly PortalGraphNode[],
  state: PortalState,
  actions: PortalRenderActions,
): HTMLElement {
  const tree = element("ul", "graph-tree workflow-tree");
  tree.setAttribute("role", "tree");
  const ids = selectedIds(state);
  const agents =
    ids === undefined
      ? []
      : (state.caches.agents[runKey(ids.repositoryId, ids.runId)]?.agents ?? []);
  const visible = new Set(nodes.map(({ nodeId }) => nodeId));
  const workspaces =
    ids === undefined
      ? []
      : (state.caches.workspaces[runKey(ids.repositoryId, ids.runId)]?.workspaces ?? []);
  const roots = nodes.filter(
    ({ parentNodeId }) => parentNodeId === undefined || !visible.has(parentNodeId),
  );
  const appendChildren = (parent: HTMLElement, node: PortalGraphNode, level: number) => {
    const item = element("li", `tree-item workflow-node kind-${node.kind}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.dataset.focusKey = node.nodeId;
    item.dataset.kind = node.kind;
    if (state.ui.focusedRecord === node.nodeId) item.setAttribute("aria-selected", "true");
    item.tabIndex = parent.querySelector("[role=treeitem]") === null && level === 1 ? 0 : -1;
    const line = element("span", "node");
    line.append(
      textElement("span", "node-mark", nodeMark(node.kind)),
      textElement("span", "node-name", node.title),
    );
    const right = element("span", "node-right");
    line.append(right);
    if (node.kind !== "task")
      right.append(textElement("span", "node-sub", NODE_KIND_ROLE[node.kind] ?? node.kind));
    // An agent belongs inside the work it is doing. A column of "working on"
    // pointing back at a row three tabs away is the same fact told twice.
    const working = agents.filter((agent) => String(agent.taskId) === node.nodeId);
    const latest = [...working].sort((left, right_) => left.attempt - right_.attempt).at(-1);
    if (latest !== undefined) {
      right.append(agentWho(latest));
      if (working.length > 1)
        right.append(textElement("span", "node-sub", `attempt ${String(latest.attempt)}`));
      // Redirecting an agent, or accepting work it could not finish, is done
      // while looking at the work. Both controls lived on a list of agents that
      // named the work by identity, so acting on the right one meant matching a
      // digest by eye against this tree.
    }
    // A need belongs on the thing it blocks. Scattering them across three tabs
    // meant reading a phase told you nothing about why it had stopped.
    const blocking = state.humanNeeds.filter((need) => needBlocks(need, node));
    for (const need of blocking) right.append(needChip(need, state, actions, node.nodeId));
    if (blocking.length === 0 && node.humanNeedCount > 0)
      right.append(textElement("span", "asks", `${String(node.humanNeedCount)} waiting on you`));
    // Where a task's work is happening, and whether that work can be accepted,
    // is a fact about the task. It was a table of its own keyed by an identity
    // a reader had to match by eye against this tree.
    const workspace = workspaces.find((candidate) => String(candidate.taskId) === node.nodeId);
    if (workspace !== undefined) {
      const where = element("span", "workspace");
      where.append(
        textElement("span", "workspace-mode node-sub", workspace.mode),
        textElement("span", `workspace-state node-sub`, workspace.state),
      );
      if (!workspace.completionEligible)
        where.append(textElement("span", "node-sub", "cannot be accepted yet"));
      right.append(where);
    }
    right.append(statePill(node.runState));
    item.append(line);
    item.addEventListener("click", (event) => {
      // Rows nest, so without this every ancestor row also claims the click.
      event.stopPropagation();
      actions.focusRecord(node.nodeId);
    });
    item.addEventListener("keydown", treeKeydown);
    const children = nodes.filter(({ parentNodeId }) => parentNodeId === node.nodeId);
    if (children.length > 0) {
      item.setAttribute("aria-expanded", "true");
      const group = element("ul", "tree-group");
      group.setAttribute("role", "group");
      for (const child of children) appendChildren(group, child, level + 1);
      item.append(group);
    }
    parent.append(item);
  };
  for (const node of roots) appendChildren(tree, node, 1);
  return tree;
}

function agentActionButton(
  kind: "steer" | "override",
  label: string,
  agent: PortalAgentSummary,
  actions: PortalRenderActions,
): HTMLElement {
  const triggerId = `${kind}-${agent.dispatchId}`;
  const button = document.createElement("button");
  button.type = "button";
  button.id = triggerId;
  button.className = `command agent-action agent-action-${kind}`;
  button.textContent = label;
  button.addEventListener("click", (event) => {
    // The node is clickable, and this button sits inside it.
    event.stopPropagation();
    actions.openAgentAction(kind, agent, triggerId);
  });
  return button;
}

// A need is never about nothing. One that names a task belongs on that task; one
// that does not is about the run, which is the node the tree is rooted at.
function needBlocks(need: PortalHumanNeed, node: PortalGraphNode): boolean {
  if (need.taskId !== undefined) return need.taskId === node.nodeId;
  return node.kind === "workflow";
}

function needChip(
  need: PortalHumanNeed,
  state: PortalState,
  actions: PortalRenderActions,
  nodeId: string,
): HTMLElement {
  const triggerId = `review-node-${safeDomId(nodeId)}-${safeDomId(need.needId)}`;
  const button = commandButton(needChipLabel(need), () => actions.openNeed(need, triggerId));
  button.id = triggerId;
  button.className = "workflow-need";
  button.disabled =
    actionsLocked(state) ||
    need.allowedCommands.length === 0 ||
    !needAllowedByCapabilities(need, state);
  return button;
}

/** The short word a card wears while it waits. */
function needBadgeLabel(need: PortalHumanNeed): string {
  if (need.kind === "question") return "asks";
  if (need.kind === "escalation") return "needs budget";
  if (need.kind === "candidate-approval") return "needs approval";
  return need.kind;
}

function needChipLabel(need: PortalHumanNeed): string {
  if (need.kind === "question") return "Answer this question";
  if (need.kind === "escalation") return "Review the budget it asked for";
  if (need.kind === "candidate-approval") return "Approve or reject this phase";
  return `Review this ${need.kind}`;
}

/**
 * One detail surface, whatever the reader arrived from. What the agent is doing
 * now leads; what it was told, what it made, and what it is sit behind it.
 */
function graphDetail(
  node: PortalGraphNode,
  state: PortalState,
  actions: PortalRenderActions,
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): HTMLElement {
  const ids = selectedIds(state);
  const key = ids === undefined ? undefined : runKey(ids.repositoryId, ids.runId);
  const agents = key === undefined ? [] : (state.caches.agents[key]?.agents ?? []);
  const working = agents.filter((agent) => String(agent.taskId) === node.nodeId);
  const latest = [...working].sort((left, right) => left.attempt - right.attempt).at(-1);
  const detail = element("section", "card detail detail-panel");
  const header = element("header", "");
  const title = element("div", "detail-title");
  title.append(textElement("h2", "compact-heading", node.title));
  const parent = nodes.find(({ nodeId }) => nodeId === node.parentNodeId);
  const where = [
    parent?.title,
    latest === undefined
      ? (NODE_KIND_ROLE[node.kind] ?? node.kind)
      : `${latest.persona}${latest.model === undefined ? "" : ` on ${latest.model}`}`,
    latest === undefined ? undefined : `attempt ${String(latest.attempt)}`,
  ].filter((part): part is string => part !== undefined);
  title.append(textElement("span", "where", where.join(" \u00b7 ")));
  header.append(title);
  const toolbar = nodeToolbarView({
    nodeId: node.nodeId,
    actions: nodeActions(node, state, actions, nodes, edges),
  });
  // Redirecting an agent is the card's action, not another node control.
  const agentActions = element("div", "detail-actions");
  if (
    latest !== undefined &&
    latest.state === "working" &&
    hasCapability(state, "portal-write-steer-agent")
  )
    agentActions.append(agentActionButton("steer", "Steer", latest, actions));
  if (
    latest !== undefined &&
    latest.state === "finished" &&
    latest.latestRefusal !== undefined &&
    hasCapability(state, "portal-write-override-member")
  )
    agentActions.append(agentActionButton("override", "Accept anyway", latest, actions));
  header.append(toolbar);
  if (agentActions.childElementCount > 0) header.append(agentActions);
  detail.append(header);
  const tabs = element("div", "detail-tabs");
  tabs.setAttribute("role", "tablist");
  for (const tab of DETAIL_TABS) {
    const button = commandButton(DETAIL_TAB_LABELS[tab], () => actions.setDetailTab(tab));
    button.className = "detail-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.ui.detailTab === tab));
    tabs.append(button);
  }
  detail.append(tabs);
  const pane = element("div", "pane");
  switch (state.ui.detailTab) {
    case "live":
      pane.append(livePane(state, actions, node));
      break;
    case "answers":
      pane.append(answersPane(state, node));
      break;
    case "produced":
      pane.append(producedPane(state, node));
      break;
    case "about": {
      const facts = element("dl", "kv dense-facts");
      appendFact(facts, "Identity", node.nodeId);
      appendFact(facts, "Source", node.sourcePointer ?? "Not supplied");
      appendFact(facts, "Superseded by", node.supersededBy ?? "No successor");
      pane.append(facts);
      if (node.normalizedInput !== undefined)
        pane.append(renderJson(node.normalizedInput, "Input as given"));
      if (node.completionPolicy !== undefined)
        pane.append(renderJson(node.completionPolicy, "Completion policy"));
      break;
    }
  }
  detail.append(pane);
  return detail;
}

const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  live: "Live",
  answers: "Answers",
  produced: "Produced",
  about: "About",
};

/** What the agent is saying, and the line a reader answers it on. */
function livePane(
  state: PortalState,
  actions: PortalRenderActions,
  node: PortalGraphNode,
): HTMLElement {
  const ids = selectedIds(state);
  const holder = element("div", "live-pane");
  holder.append(
    transcriptPaneView({
      view: state.ui.transcript,
      scope: state.ui.transcriptScope,
      names:
        ids === undefined
          ? {}
          : transcriptNames(state.caches.agents[runKey(ids.repositoryId, ids.runId)]?.agents),
      actions: {
        setTranscriptPinned: (pinned) => actions.setTranscriptPinned(pinned),
        setTranscriptScope: (scope) => actions.setTranscriptScope(scope),
      },
    }),
  );
  holder.append(replyBox(state, actions, node));
  return holder;
}

/** Questions this work has already been answered on. */
function answersPane(state: PortalState, node: PortalGraphNode): HTMLElement {
  const list = element("ul", "answered");
  const ids = selectedIds(state);
  const key = ids === undefined ? undefined : runKey(ids.repositoryId, ids.runId);
  const events = key === undefined ? [] : (state.caches.events[key]?.events ?? []);
  for (const event of events) {
    if (!event.eventType.includes("answer") && !event.eventType.includes("decision")) continue;
    const item = element("li", "");
    item.append(
      textElement("p", "a-q", event.eventType),
      textElement("p", "a-when", event.occurredAt),
    );
    list.append(item);
  }
  if (list.childElementCount === 0)
    list.append(
      textElement("li", "empty-state", `Nothing has been answered on ${node.title} yet.`),
    );
  return list;
}

/** What this work handed on. */
function producedPane(state: PortalState, node: PortalGraphNode): HTMLElement {
  const ids = selectedIds(state);
  const key = ids === undefined ? undefined : runKey(ids.repositoryId, ids.runId);
  const artifacts = key === undefined ? [] : (state.caches.artifacts[key]?.artifacts ?? []);
  const mine = artifacts.filter((artifact) => String(artifact.taskId) === node.nodeId);
  if (mine.length === 0)
    return textElement("p", "empty-state", `${node.title} has produced nothing yet.`);
  return summaryTable(
    ["What", "Size", "Where it is"],
    mine.map((artifact) => [
      artifact.summary,
      formatBytes(artifact.byteLength),
      artifact.availability,
    ]),
    `What ${node.title} produced`,
  );
}

/**
 * A reply is given on the line under the words it answers. The same box carries
 * an answer, a steer and a grant, because they interrupt the same thing.
 */
function replyBox(
  state: PortalState,
  actions: PortalRenderActions,
  node: PortalGraphNode,
): HTMLElement {
  const reply = element("div", "reply");
  // A budget is a number under a policy, not prose, so it keeps its reviewed
  // form. What a person writes in words is answered and steered from here.
  const needs = state.humanNeeds.filter(
    (candidate) => needBlocks(candidate, node) && candidate.kind === "question",
  );
  const need = needs[0];
  const working = workingAgent(state, node);
  const sendable = need !== undefined || working !== undefined;
  reply.append(textElement("span", "reply-caret", "\u203a"));
  const box = document.createElement("textarea");
  box.className = "reply-input";
  box.rows = 2;
  const label = need === undefined ? "Steer this agent" : "Answer this question";
  box.setAttribute("aria-label", label);
  box.placeholder = sendable
    ? `${label}\u2026`
    : "Nothing here is waiting on you, and no agent is working";
  box.disabled = !sendable || actionsLocked(state);
  reply.append(box);
  const side = element("div", "reply-side");
  const send = commandButton("Send", () => {
    const text = box.value;
    box.value = "";
    actions.sendReply(need, text);
  });
  send.className = "send";
  send.id = `reply-${safeDomId(node.nodeId)}`;
  send.disabled = box.disabled;
  // Enter sends, because this is a reply and not a document.
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send.click();
  });
  const note = replyNote(state.ui.reply, label);
  side.append(send, note);
  reply.append(side);
  return reply;
}

/** What the box is doing, said where the reader is looking. */
function replyNote(reply: PortalState["ui"]["reply"], label: string): HTMLElement {
  if (reply.status === "sending") return textElement("span", "reply-note", "sending\u2026");
  if (reply.status === "sent") return textElement("span", "reply-note sent", "sent as written");
  if (reply.status === "failed")
    return textElement("span", "reply-note failed", reply.message ?? "could not send");
  return textElement("span", "reply-note", `${label} \u00b7 sent as written`);
}

/** The agent currently working the selected node, if there is one. */
function workingAgent(state: PortalState, node: PortalGraphNode): PortalAgentSummary | undefined {
  const ids = selectedIds(state);
  if (ids === undefined) return undefined;
  const agents = state.caches.agents[runKey(ids.repositoryId, ids.runId)]?.agents ?? [];
  return agents
    .filter((agent) => agent.state === "working" && String(agent.taskId) === node.nodeId)
    .sort((left, right) => left.attempt - right.attempt)
    .at(-1);
}

/**
 * Only authority the current command contracts already carry for this node is
 * offered. A node with no matching human need gets no authority control at all.
 */
function nodeActions(
  node: PortalGraphNode,
  state: PortalState,
  actions: PortalRenderActions,
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): readonly NodeToolbarAction[] {
  // The graph and the tree must agree about which node a need belongs to, or a
  // badge counts something the controls beside it refuse to act on.
  const needs = state.humanNeeds.filter(
    (candidate) =>
      needBlocks(candidate, node) &&
      (candidate.definitionGeneration === undefined ||
        candidate.definitionGeneration === node.definitionGeneration),
  );
  const reviewId = `node-review-${safeDomId(node.nodeId)}`;
  const unfolded = state.ui.unfoldedNodes.includes(node.nodeId);
  return Object.freeze([
    // A mark for the actions used constantly and understood instantly.
    Object.freeze({
      key: "copy",
      label: "Copy identity",
      mark: copyMark,
      name: "Copy identity",
      disabled: false,
      run: () => copyText(node.nodeId),
    }),
    Object.freeze({
      key: "focus",
      label: "Show this in the graph",
      mark: locateMark,
      name: "Show this in the graph",
      disabled: false,
      run: () => {
        const viewport =
          state.ui.graphMode === "diagram" ? state.ui.graphViewport : INITIAL_GRAPH_VIEWPORT;
        if (state.ui.graphMode !== "diagram") actions.setGraphMode("diagram");
        actions.setGraphViewport(
          focusGraphViewport(graphLayout(nodes, edges), viewport, node.nodeId),
        );
      },
    }),
    Object.freeze({
      key: "fold",
      // A phase folds itself once its work is done. This is only how a reader
      // disagrees, and the disagreement outlives the next poll.
      label: unfolded ? "Collapse this phase" : "Expand this phase",
      mark: () => chevronMark(unfolded),
      name: unfolded ? "Collapse this phase" : "Expand this phase",
      disabled: node.kind !== "phase",
      run: () => actions.unfoldNode(node.nodeId),
    }),
    // One control per need, named for the decision it is. A node waiting on an
    // answer and stopped for budget is two decisions, and offering only the
    // first hides the second behind a badge that counts both.
    ...(needs.length === 0
      ? [
          Object.freeze({
            key: "review",
            label: "Review linked human need",
            disabled: true,
            run: () => undefined,
          }),
        ]
      : needs.map((need, index) =>
          Object.freeze({
            key: `review-${String(index)}`,
            label: needChipLabel(need),
            disabled:
              actionsLocked(state) ||
              need.allowedCommands.length === 0 ||
              !needAllowedByCapabilities(need, state),
            run: () => actions.openNeed(need, `${reviewId}-${String(index)}`),
          }),
        )),
  ]);
}

function copyText(value: string): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard !== undefined) void clipboard.writeText(value).catch(() => undefined);
}

function activityList<Value>(
  title: string,
  values: readonly Value[],
  state: PortalState,
  actions: PortalRenderActions,
  label: (value: Value) => string,
): HTMLElement {
  const panel = element("section", "card activity-panel");
  const header = element("header", "view-toolbar");
  header.append(
    textElement("h2", "card-heading", title),
    textElement("span", "count", "open one to load its exact record"),
  );
  panel.append(header);
  const list = element("ol", "activity-list");
  const needle = state.ui.filter.toLocaleLowerCase();
  const opened = new Set(state.ui.openedRecords);
  for (const value of values) {
    const summary = label(value);
    if (!summary.toLocaleLowerCase().includes(needle)) continue;
    const item = element("li", "activity-item");
    item.append(textElement("p", "mono activity-summary", summary));
    // Every event rendered its whole record inline, which put twenty-four
    // thousand characters and a hundred and sixty-eight digests on a view whose
    // job is to say what happened and when. The record is the thing you open
    // once you have a question, so it is built only while it is open, and the
    // decision to open it outlives the next poll.
    const recordKey = `${title}:${summary}`;
    item.append(
      recordDisclosure(recordKey, opened.has(recordKey), actions, () =>
        renderJson(asJson(value), `${title} detail`),
      ),
    );
    list.append(item);
  }
  if (list.childElementCount === 0)
    list.append(textElement("li", "empty-state", "Nothing has been recorded here yet."));
  panel.append(list);
  return panel;
}

function recordDisclosure(
  recordKey: string,
  open: boolean,
  actions: PortalRenderActions,
  build: () => Node,
): HTMLElement {
  const wrapper = element("details", "disclosure");
  wrapper.append(textElement("summary", "disclosure-summary", "Exact record"));
  wrapper.open = open;
  if (open) wrapper.append(build());
  wrapper.addEventListener("toggle", () => {
    if (wrapper.open !== open) actions.toggleRecord(recordKey);
  });
  return wrapper;
}

/**
 * What the run made, one row per thing. Content is fetched when a row is opened,
 * never up front, and the row says so while it loads.
 */
function renderArtifacts(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading artifacts");
  const key = runKey(ids.repositoryId, ids.runId);
  const artifacts = state.caches.artifacts[key]?.artifacts ?? [];
  const section = element("section", "card artifact-view");
  const header = element("header", "view-toolbar");
  header.append(
    textElement("h2", "card-heading", "Files in the workspace"),
    textElement("span", "count", "open one to load its content"),
    textElement(
      "span",
      "result-count",
      `${String(artifacts.length)} ${artifacts.length === 1 ? "file" : "files"}`,
    ),
    filterInput(state, actions, "Filter loaded artifacts"),
  );
  section.append(header);
  const matching = artifacts.filter((artifact) =>
    `${artifact.summary} ${artifact.mediaType} ${artifact.artifactId}`
      .toLocaleLowerCase()
      .includes(state.ui.filter.toLocaleLowerCase()),
  );
  if (matching.length === 0) {
    section.append(textElement("p", "empty-state", "This run has made nothing yet."));
    return section;
  }
  const table = document.createElement("table");
  table.className = "grid";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["File", "Type", "Size", "Sensitivity", "Where it is"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const artifact of matching) {
    const row = document.createElement("tr");
    row.className = "artifact-row";
    const openable =
      artifact.availability === "verified-stored" && previewAllowed(artifact.mediaType);
    const preview =
      state.caches.artifactContent[
        artifactContentKey(ids.repositoryId, ids.runId, artifact.artifactId)
      ];
    const open = state.ui.openedRecords.includes(artifact.artifactId);
    if (openable) {
      row.tabIndex = 0;
      row.setAttribute("aria-expanded", String(open));
      const reveal = () => {
        actions.toggleRecord(artifact.artifactId);
        if (preview === undefined) actions.loadArtifact(artifact);
      };
      row.addEventListener("click", reveal);
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        reveal();
      });
    }
    // Why a row cannot be opened is the fact a reader needs when it cannot.
    const where = openable
      ? artifact.availability
      : artifact.availability === "metadata-only"
        ? "Verified bytes unavailable"
        : "No preview for this kind of file";
    for (const value of [
      artifact.summary,
      artifact.mediaType,
      formatBytes(artifact.byteLength),
      artifact.sensitivity,
      where,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
    if (!open) continue;
    const detail = document.createElement("tr");
    detail.className = "detail-row";
    detail.dataset.artifact = artifact.artifactId;
    const cell = document.createElement("td");
    cell.colSpan = 5;
    if (preview === undefined) {
      // The cost is visible, paid once, on the row the reader asked about.
      cell.append(textElement("p", "lazy", "Loading the exact record\u2026"));
    } else {
      const expandId = `artifact-expand-${safeDomId(artifact.artifactId)}`;
      const expand = commandButton("Expand full screen", () =>
        actions.openAssetOverlay(artifact.artifactId, expandId),
      );
      expand.id = expandId;
      cell.append(expand);
      cell.append(renderArtifactPreview(preview.content, preview.encoding, artifact.mediaType));
    }
    detail.append(cell);
    body.append(detail);
  }
  table.append(head, body);
  const scroll = element("div", "table-scroll");
  scroll.append(table);
  section.append(scroll);
  return section;
}

function renderArtifactPreview(
  content: string,
  encoding: "utf8" | "base64",
  mediaType: string,
): HTMLElement {
  const preview = element("section", "artifact-preview");
  preview.append(textElement("h3", "compact-heading", `Bounded ${encoding} preview`));
  if (encoding === "utf8" && mediaType === "application/json") {
    try {
      preview.append(renderJson(decodeCanonicalJsonValue(content), "JSON content"));
      return preview;
    } catch {
      preview.append(textElement("pre", "text-preview", content.slice(0, 65_536)));
      return preview;
    }
  }
  preview.append(textElement("pre", "text-preview", content.slice(0, 65_536)));
  return preview;
}

function renderAssetOverlay(
  root: HTMLElement,
  state: PortalState,
  actions: PortalRenderActions,
): void {
  const ids = selectedIds(state);
  const overlayState = state.ui.assetOverlay;
  if (ids === undefined || overlayState === undefined) return;
  const artifact = state.caches.artifacts[runKey(ids.repositoryId, ids.runId)]?.artifacts.find(
    ({ artifactId }) => artifactId === overlayState.artifactId,
  );
  const content =
    state.caches.artifactContent[
      artifactContentKey(ids.repositoryId, ids.runId, overlayState.artifactId)
    ];
  if (artifact === undefined || content === undefined) return;
  const overlay = document.createElement("dialog");
  overlay.className = "asset-overlay";
  overlay.setAttribute("aria-labelledby", "asset-overlay-heading");
  overlay.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    actions.closeAssetOverlay();
  });
  overlay.addEventListener("cancel", (event) => {
    event.preventDefault();
    actions.closeAssetOverlay();
  });
  const bar = element("div", "asset-overlay-bar");
  const heading = textElement("h2", "dialog-heading", artifact.summary);
  heading.id = "asset-overlay-heading";
  bar.append(heading, textElement("span", "mono", artifact.contentDigest));
  const close = commandButton("Close full screen", () => actions.closeAssetOverlay());
  close.id = "asset-overlay-close";
  bar.append(close);
  overlay.append(bar, renderArtifactPreview(content.content, content.encoding, artifact.mediaType));
  root.append(overlay);
  overlay.showModal();
}

function renderNeed(
  need: PortalHumanNeed,
  state: PortalState,
  actions: PortalRenderActions,
  scope: string,
  attention?: QuestionAttention,
): HTMLElement {
  const item = element("article", "need-row");
  // A queue entry says where the decision lives and what is being asked. It used
  // to lead with a sixty-four character digest and a revision counter, which
  // told a reader nothing they could act on.
  // Where it is, then what is being asked, then what kind of decision it is.
  // The kind is how a reader tells two integration needs apart, so it stays,
  // quietly, rather than leading as a badge.
  // A need that names no node is about the run, which is where it belongs;
  // saying its kind twice told a reader nothing either time.
  const where = needLocation(need, state);
  item.append(textElement("p", "q-where", where ?? "this run"));
  item.append(textElement("h3", "q-what", readableTitle(need.title)));
  item.append(textElement("p", "q-kind", need.kind));
  const triggerId = `review-${scope}-${safeDomId(need.needId)}`;
  const button = commandButton(needChipLabel(need), () => actions.openNeed(need, triggerId));
  button.id = triggerId;
  button.disabled =
    actionsLocked(state) ||
    need.allowedCommands.length === 0 ||
    !needAllowedByCapabilities(need, state);
  item.append(button);
  // How long a question has been waiting belongs on the question, not on a band
  // across the top of a page the reader is trying to read.
  if (attention !== undefined && attention.need.needId === need.needId) {
    item.classList.add("question-attention");
    item.classList.toggle("overdue", attention.overdue);
    item.dataset.needId = need.needId;
    const facts = element("p", "question-attention-facts");
    facts.append(textElement("span", "question-attention-elapsed", attention.label));
    const overdue = textElement("span", "question-attention-overdue", "Overdue");
    overdue.hidden = !attention.overdue;
    facts.append(overdue);
    item.append(facts);
  }
  return item;
}

/**
 * A sixty-four character digest in a heading pushes the words out of view. It is
 * elided for reading; the exact value is in the record the control opens.
 */
function readableTitle(title: string): string {
  return title.replace(
    /([a-z][a-z-]*_)([0-9a-f]{16,})/gu,
    (_, prefix: string, digest: string) => `${prefix}${digest.slice(0, 12)}\u2026`,
  );
}

/** The phase and task a need belongs to, named rather than identified. */
function needLocation(need: PortalHumanNeed, state: PortalState): string | undefined {
  if (need.taskId === undefined) return undefined;
  const ids = selectedIds(state);
  if (ids === undefined || state.vector === undefined) return undefined;
  const key = revisionKey(ids.repositoryId, ids.runId, state.vector.graphRevision);
  const nodes = state.caches.graphNodes[key]?.nodes ?? [];
  const node = nodes.find(({ nodeId }) => nodeId === need.taskId);
  if (node === undefined) return undefined;
  const parent = nodes.find(({ nodeId }) => nodeId === node.parentNodeId);
  return parent === undefined ? node.title : `${parent.title} \u00b7 ${node.title}`;
}

/**
 * Who is working, on what, and on which model.
 *
 * The graph says which phases are open. It cannot say which persona is on its
 * third attempt, which one was moved to a smaller model, or what the last thing
 * refused was, and those are the questions somebody watching a run actually has.
 */
/**
 * Who is working, and on what. Selecting an agent opens the same detail surface
 * the workflow opens, because it is the same subject reached another way.
 */
function renderAgents(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const ids = selectedIds(state);
  if (ids === undefined || state.vector === undefined) return emptySection("Loading agents");
  const key = runKey(ids.repositoryId, ids.runId);
  const agents = state.caches.agents[key]?.agents ?? [];
  const revision = revisionKey(ids.repositoryId, ids.runId, state.vector.graphRevision);
  const nodes = state.caches.graphNodes[revision]?.nodes ?? [];
  const edges = state.caches.graphEdges[revision]?.edges ?? [];
  const split = element("div", "split");
  const card = element("section", "card agent-view");
  const header = element("header", "view-toolbar");
  header.append(textElement("h2", "card-heading", "This run"));
  const working = agents.filter((agent) => agent.state === "working").length;
  const done = agents.length - working;
  header.append(
    textElement("span", "count", `${String(working)} working \u00b7 ${String(done)} done`),
  );
  card.append(header);
  if (agents.length === 0) {
    card.append(textElement("p", "empty-note", "No agent has been dispatched yet."));
    split.append(card, emptyDetail("Nothing is working yet."));
    return split;
  }
  const list = element("ul", "workflow-tree agent-roster");
  // One row per piece of work an agent holds, latest attempt first in the row.
  const byWork = new Map<string, PortalAgentSummary[]>();
  for (const agent of agents) {
    const groupKey = `${agent.persona}\u0000${String(agent.taskId)}`;
    const existing = byWork.get(groupKey);
    if (existing === undefined) byWork.set(groupKey, [agent]);
    else existing.push(agent);
  }
  for (const group of byWork.values()) {
    const attempts = [...group].sort((left, right) => left.attempt - right.attempt);
    const current = attempts[attempts.length - 1];
    if (current === undefined) continue;
    const nodeId = String(current.taskId);
    const item = element("li", "workflow-node agent-entry");
    if (state.ui.focusedRecord === nodeId) item.setAttribute("aria-selected", "true");
    const row = element("span", "node");
    row.dataset.focusKey = nodeId;
    row.append(
      textElement("span", "node-mark", "\u25cf"),
      textElement("span", "node-name", current.persona),
    );
    const right = element("span", "node-right");
    const work = textElement("span", "node-sub agent-work", current.taskName ?? nodeId);
    // The identity is kept for hovering, because a digest names nothing to a reader.
    work.title = nodeId;
    right.append(work);
    if (current.model !== undefined) right.append(textElement("span", "model", current.model));
    if (attempts.length > 1)
      right.append(textElement("span", "node-sub", `${String(attempts.length)} attempts`));
    if (current.latestRefusal !== undefined)
      right.append(textElement("span", "asks", "could not finish"));
    right.append(
      textElement("span", `state ${AGENT_TONES[current.state] ?? "is-waiting"}`, current.state),
    );
    row.append(right);
    item.append(row);
    item.addEventListener("click", () => actions.focusRecord(nodeId));
    list.append(item);
  }
  card.append(list);
  split.append(card);
  const focused = nodes.find(({ nodeId }) => nodeId === state.ui.focusedRecord);
  split.append(
    focused === undefined
      ? emptyDetail("Select an agent to read what it is doing.")
      : graphDetail(focused, state, actions, nodes, edges),
  );
  return split;
}

const AGENT_TONES: Readonly<Record<string, string>> = {
  working: "is-working",
  finished: "is-closed",
  failed: "is-failed",
};

// Integration is about a cohort rather than a task, so it has no node to sit on
// and belongs with the rest of the run's record.
function renderIntegrations(state: PortalState): HTMLElement {
  const ids = selectedIds(state);
  const section = element("section", "integration-view");
  const integrations =
    ids === undefined
      ? []
      : (state.caches.integrations[runKey(ids.repositoryId, ids.runId)]?.integrations ?? []);
  if (integrations.length === 0) return section;
  section.append(
    textElement("h2", "section-heading", "Integration, conflict, and rework"),
    summaryTable(
      ["Cohort", "Attempt", "State", "Members", "Diagnostic", "Successor"],
      integrations.map((integration) => [
        integration.cohortId,
        String(integration.attempt),
        integration.state,
        String(integration.memberCount),
        integration.diagnostic?.summary ?? "No sanitized diagnostic",
        integration.successorIntegrationId ?? "No successor",
      ]),
      "Integration attempts and sanitized diagnostics",
    ),
  );
  return section;
}

function renderRightRail(
  state: PortalState,
  actions: PortalRenderActions,
  attention: QuestionAttention | undefined,
): HTMLElement {
  const aside = element("aside", state.ui.rightRailOpen ? "right-rail open" : "right-rail");
  aside.id = "right-rail";
  aside.setAttribute("aria-label", "Human needs and pending commands");
  aside.dataset.collapsed = String(railCollapsed(state.ui.railLayout, "right"));
  if (!state.ui.rightRailOpen) {
    aside.inert = true;
    aside.setAttribute("aria-hidden", "true");
  }
  const heading = element("div", "rail-heading");
  heading.append(railToggle("right", state, actions));
  heading.append(textElement("h2", "compact-heading", "Waiting on you"));
  heading.append(textElement("span", "count", String(state.humanNeeds.length)));
  const close = commandButton("Close", () => actions.toggleRightRail(false));
  close.className = "rail-close";
  heading.append(close);
  const spine = textElement("span", "rail-spine", "Attention");
  spine.setAttribute("aria-hidden", "true");
  aside.append(heading, spine);
  const needsSection = element("section", "rail-section");
  for (const need of state.humanNeeds.slice(0, 20))
    needsSection.append(renderNeed(need, state, actions, "rail", attention));
  if (state.humanNeeds.length === 0)
    needsSection.append(textElement("p", "empty-state", "Nothing is waiting on you."));
  const pendingSection = element("section", "rail-section");
  pendingSection.append(textElement("h3", "rail-section-heading", "Pending receipts"));
  const pendingList = element("ul", "pending-list");
  for (const pending of Object.values(state.pending)) {
    const item = element("li", "pending-item");
    item.append(
      textElement("strong", "", pending.intent),
      textElement("span", "mono", pending.commandId),
      statusBadge(
        pending.receipt?.status ?? "recovering",
        pending.receipt?.status ?? "Recovering receipt",
      ),
    );
    pendingList.append(item);
  }
  if (pendingList.childElementCount === 0)
    pendingList.append(textElement("li", "empty-state", "No uncertain commands."));
  pendingSection.append(pendingList);
  aside.append(needsSection, pendingSection);
  return aside;
}

function renderDialog(
  root: HTMLElement,
  dialogState: PortalDialogState,
  actions: PortalRenderActions,
): void {
  const dialog = document.createElement("dialog");
  dialog.className = "review-dialog";
  dialog.setAttribute("aria-labelledby", "review-dialog-heading");
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    actions.closeDialog();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    actions.closeDialog();
  });
  const form = document.createElement("form");
  form.method = "dialog";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [key, value] of new FormData(form))
      if (typeof value === "string") values[key] = value;
    actions.submitDialog(dialogState.kind, Object.freeze(values));
  });
  form.append(textElement("h2", "dialog-heading", dialogState.title));
  form.lastElementChild?.setAttribute("id", "review-dialog-heading");
  form.append(textElement("p", "review-warning", dialogConsequence(dialogState.kind)));
  if (dialogState.loading)
    form.append(
      textElement("p", "", "Loading and verifying every referenced digest and revision."),
    );
  if (dialogState.source !== undefined) {
    const allowance =
      dialogState.kind === "allowance" ? allowanceReviewFromSource(dialogState.source) : undefined;
    form.append(
      allowance === undefined
        ? renderJson(asJson(dialogState.source), "Exact review source")
        : renderAllowanceReview(allowance),
    );
  }
  appendDialogFields(form, dialogState, actions);
  if (dialogState.message !== undefined) {
    const message = textElement("p", "dialog-message", dialogState.message);
    message.setAttribute("role", "alert");
    form.append(message);
  }
  const buttons = element("div", "dialog-actions");
  buttons.append(commandButton("Cancel", actions.closeDialog));
  const submit = commandButton(
    finalActionLabel(dialogState.kind),
    () => undefined,
    dialogState.kind === "end",
  );
  submit.type = "submit";
  submit.disabled = !dialogState.verified || dialogState.loading;
  buttons.append(submit);
  form.append(buttons);
  dialog.append(form);
  root.append(dialog);
  dialog.showModal();
  // Focus lands on the first focusable child otherwise, which is the exact-record
  // disclosure. A person opening this dialog came to write in it.
  form.querySelector<HTMLElement>("textarea, input:not([type=hidden]), select")?.focus();
}

function appendDialogFields(
  form: HTMLFormElement,
  dialogState: PortalDialogState,
  actions: PortalRenderActions,
): void {
  const kind = dialogState.kind;
  const source = dialogState.source;
  const loading = dialogState.loading;
  if (kind === "answer") {
    const field = textAreaField("answer", "Answer", true, loading);
    const input = field.querySelector("textarea");
    if (input !== null) {
      // The authority refuses a longer answer, and an answer cannot be replaced
      // once sent, so the limit belongs where it is typed rather than after.
      input.maxLength = MAX_ANSWER_LENGTH;
      const remaining = textElement("span", "field-hint", "");
      // Described, not labelled: inside the label the count becomes part of the
      // field's name, so a screen reader reads the number instead of "Answer".
      remaining.id = "answer-length";
      input.setAttribute("aria-describedby", remaining.id);
      const count = (): void => {
        remaining.textContent = `${input.value.length} of ${MAX_ANSWER_LENGTH} characters`;
      };
      if (dialogState.answerDraft !== undefined) input.value = dialogState.answerDraft;
      count();
      input.addEventListener("input", () => {
        actions.saveAnswerDraft(input.value);
        count();
      });
      form.append(field, remaining);
    } else {
      form.append(field);
    }
  }
  if (kind === "steer") {
    const field = element("label", "form-field");
    field.append(textElement("span", "field-label", "Instruction"));
    const input = document.createElement("textarea");
    input.name = "instruction";
    input.required = true;
    input.disabled = loading;
    field.append(input);
    form.append(field);

    const delivery = element("label", "form-field");
    delivery.append(textElement("span", "field-label", "When the agent sees it"));
    const select = document.createElement("select");
    select.name = "delivery";
    select.required = true;
    select.disabled = loading;
    for (const [value, label] of [
      ["queued", "When this turn ends"],
      ["live", "During this turn"],
      ["abort-retry", "Stop this turn and start again"],
    ]) {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(label);
      select.append(option);
    }
    delivery.append(select);
    form.append(delivery);
  }
  if (kind === "override") {
    const field = element("label", "form-field");
    field.append(textElement("span", "field-label", "Why this work is accepted"));
    const input = document.createElement("textarea");
    input.name = "reason";
    input.required = true;
    input.disabled = loading;
    field.append(input);
    form.append(field);
  }
  if (kind === "approval" || kind === "amendment") {
    const field = element("label", "form-field");
    field.append(textElement("span", "field-label", "Decision"));
    const select = document.createElement("select");
    select.name = "decision";
    select.required = true;
    select.disabled = loading;
    for (const value of ["approve", "reject"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value === "approve" ? "Approve exact record" : "Reject exact record";
      select.append(option);
    }
    field.append(select);
    form.append(field);
  }
  if (kind === "allowance") {
    const review = allowanceReviewFromSource(source);
    if (review === undefined) return;
    const field = element("label", "form-field");
    field.append(textElement("span", "field-label", "Allowance increase"));
    const input = document.createElement("input");
    input.name = "increaseBy";
    input.type = "number";
    input.min = "1";
    input.max = String(review.maxIncrease);
    input.step = "1";
    input.required = true;
    input.disabled = loading;
    const result = document.createElement("output");
    result.className = "field-result";
    result.textContent = "Resulting limit: enter an increase";
    input.addEventListener("input", () => {
      try {
        result.textContent = `Resulting limit: ${allowanceResult(review, Number(input.value))}`;
      } catch {
        result.textContent = `Resulting limit: must remain at or below ${review.resultingMax}`;
      }
    });
    field.append(input, result);
    form.append(field);
  }
  if (kind === "end") {
    const confirmation = element("label", "confirmation-check");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "confirmed";
    checkbox.value = "yes";
    checkbox.required = true;
    checkbox.disabled = loading;
    confirmation.append(
      checkbox,
      textElement("span", "", "I understand this run cannot resume after it ends."),
    );
    form.append(confirmation);
  }
}

function renderAllowanceReview(
  review: NonNullable<ReturnType<typeof allowanceReviewFromSource>>,
): HTMLElement {
  const section = element("section", "allowance-review");
  section.append(textElement("h3", "json-heading", "Exact allowance review"));
  const facts = element("dl", "artifact-facts");
  appendFact(facts, "Unit", review.unit);
  appendFact(facts, "Current limit", String(review.currentLimit));
  appendFact(facts, "Requested", String(review.requested));
  appendFact(facts, "Available", String(review.available));
  appendFact(facts, "Ceiling", String(review.ceiling));
  appendFact(facts, "Maximum result", String(review.resultingMax));
  section.append(facts);
  return section;
}

function renderJson(value: JsonValue, title: string): HTMLElement {
  const section = element("section", "json-viewer");
  section.append(textElement("h3", "json-heading", title));
  const model = boundedJsonModel(value);
  section.append(jsonNode(model.root));
  if (model.truncated)
    section.append(
      textElement(
        "p",
        "limit-notice",
        `Display bounded at ${model.visibleNodes} nodes and 4 KiB per string.`,
      ),
    );
  return section;
}

function jsonNode(node: BoundedJsonNode): HTMLElement {
  if (node.kind === "scalar" || node.kind === "limit") {
    const row = element("div", node.kind === "limit" ? "json-row limit" : "json-row");
    row.append(
      textElement("span", "json-key", node.label),
      textElement("span", "json-value", node.value),
    );
    if (node.kind === "scalar" && node.truncated)
      row.append(textElement("span", "limit-label", "prefix shown"));
    return row;
  }
  const details = document.createElement("details");
  details.className = "json-branch";
  details.open = node.label === "$";
  const summary = document.createElement("summary");
  summary.textContent = `${node.label} ${node.kind === "array" ? `[${node.children.length}]` : `{${node.children.length}}`}`;
  details.append(summary);
  const children = element("div", "json-children");
  for (const child of node.children) children.append(jsonNode(child));
  details.append(children);
  return details;
}

function summaryTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  captionText: string,
): HTMLElement {
  const wrapper = element("div", "table-scroll");
  const table = document.createElement("table");
  table.className = "dense-table summary-table";
  table.append(textElement("caption", "visually-hidden", captionText));
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) headRow.append(textElement("th", "", header));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const values of rows) {
    const row = document.createElement("tr");
    for (const [index, value] of values.entries()) {
      const cell = textElement("td", "", value);
      cell.dataset.label = headers[index] ?? "Value";
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  wrapper.append(table);
  return wrapper;
}

function filterInput(state: PortalState, actions: PortalRenderActions, label: string): HTMLElement {
  const field = element("label", "filter-field");
  field.append(textElement("span", "visually-hidden", label));
  const input = document.createElement("input");
  input.type = "search";
  input.value = state.ui.filter;
  input.placeholder = label;
  input.addEventListener("input", () => actions.setFilter(input.value));
  field.append(input);
  return field;
}

function textAreaField(
  name: string,
  label: string,
  required: boolean,
  disabled = false,
): HTMLElement {
  const field = element("label", "form-field");
  field.append(textElement("span", "field-label", label));
  const input = document.createElement("textarea");
  input.name = name;
  input.rows = 6;
  input.required = required;
  input.disabled = disabled;
  field.append(input);
  return field;
}

function runControlButton(
  label: string,
  kind: "pause" | "resume" | "end",
  disabled: boolean,
  actions: PortalRenderActions,
  destructive = false,
): HTMLButtonElement {
  const id = `run-control-${kind}`;
  const button = commandButton(label, () => actions.openRunControl(kind, id), destructive);
  button.id = id;
  button.disabled = disabled;
  return button;
}

function commandButton(label: string, action: () => void, destructive = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = destructive ? "command destructive" : "command";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function statusBadge(kind: string, label: string): HTMLElement {
  const badge = textElement("span", `status-badge status-${safeDomId(kind)}`, label);
  badge.dataset.status = kind;
  return badge;
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

function appendFact(list: HTMLElement, label: string, value: string): void {
  list.append(textElement("dt", "", label), textElement("dd", "mono", value));
}

/**
 * Wraps depth a reader can ask for rather than has to look past.
 *
 * Digests, sync vectors, and effect counters are what a reader wants once they
 * have a question, and noise before they do. `details` keeps them one action
 * away and, unlike a custom toggle, is reachable by keyboard and readable by
 * assistive technology without any code here.
 */
function disclosure(label: string, ...children: readonly Node[]): HTMLElement {
  const wrapper = element("details", "disclosure");
  wrapper.append(textElement("summary", "disclosure-summary", label), ...children);
  return wrapper;
}

function appendMetric(list: HTMLElement, label: string, value: number): void {
  const item = element("div", "count-item");
  item.append(textElement("dt", "", label), textElement("dd", "", String(value)));
  list.append(item);
}

function emptySection(message: string): HTMLElement {
  return textElement("section", "empty-state", message);
}

function selectedIds(
  state: PortalState,
): { readonly repositoryId: string; readonly runId: string } | undefined {
  return state.selectedRepositoryId === undefined || state.selectedRunId === undefined
    ? undefined
    : { repositoryId: state.selectedRepositoryId, runId: state.selectedRunId };
}

function asJson(value: unknown): JsonValue {
  return decodeCanonicalJsonValue(value);
}

function graphText(node: PortalGraphNode): string {
  return `${node.kind} ${node.title} ${node.runState} ${node.nodeId}`.toLocaleLowerCase();
}

function previewAllowed(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    mediaType === "application/octet-stream" ||
    mediaType.startsWith("text/plain")
  );
}

function needAllowedByCapabilities(need: PortalHumanNeed, state: PortalState): boolean {
  const mappings: Readonly<Record<string, string>> = {
    "answer-question": "portal-write-answer-question",
    "grant-allowance": "portal-write-grant-allowance",
    "record-amendment-decision": "portal-write-record-amendment-decision",
    "record-authority-decision": "portal-write-record-authority-decision",
    "pause-run": "portal-write-run-control",
    "resume-run": "portal-write-run-control",
    "end-run": "portal-write-run-control",
  };
  return need.allowedCommands.some((command) => {
    const capability = mappings[command];
    return capability !== undefined && hasCapability(state, capability);
  });
}

function routeLabel(route: PortalRouteName): string {
  const labels: Readonly<Record<PortalRouteName, string>> = {
    workflow: "Workflow",
    record: "Record",
    artifacts: "Artifacts",
    agents: "Agents",
  };
  return labels[route];
}

function dialogConsequence(kind: DialogKind): string {
  const consequences: Readonly<Record<DialogKind, string>> = {
    answer: "The agent reads this as written, and nobody can change it once sent.",
    approval: "This decision applies only to the displayed candidate digest and graph revision.",
    amendment: "Approval records a decision only. Trusted supervisor recovery owns application.",
    allowance: "This changes one bounded budget limit without resetting prior accounting.",
    pause: "Pause blocks new effect admission and does not cancel active effects.",
    resume: "Resume reopens admission at the displayed run mode revision.",
    end: "End fences current task scopes, requests cancellation, and is permanent after convergence.",
    steer: "This is recorded with your name and the time before anything tries to deliver it.",
    override:
      "This accepts work the run judged unfinished. Your reason is the only thing that explains it later.",
  };
  return consequences[kind];
}

function finalActionLabel(kind: DialogKind): string {
  const labels: Readonly<Record<DialogKind, string>> = {
    answer: "Submit exact answer",
    approval: "Record exact decision",
    amendment: "Record amendment decision",
    allowance: "Grant bounded allowance",
    pause: "Confirm pause",
    resume: "Confirm resume",
    end: "Confirm permanent end",
    steer: "Send to the agent",
    override: "Accept this work",
  };
  return labels[kind];
}

function formatBytes(value: number): string {
  return value < 1_024 ? `${value} B` : `${(value / 1_024).toFixed(1)} KiB`;
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function navigateTabs(
  event: KeyboardEvent,
  current: HTMLButtonElement,
  container: HTMLElement,
): void {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "Home" &&
    event.key !== "End"
  )
    return;
  event.preventDefault();
  const tabs = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const index = tabs.indexOf(current);
  const target =
    event.key === "Home"
      ? tabs[0]
      : event.key === "End"
        ? tabs.at(-1)
        : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  target?.focus();
  if (target !== undefined) {
    target.click();
  }
}

function treeKeydown(event: KeyboardEvent): void {
  const current = event.currentTarget;
  if (!(current instanceof HTMLElement)) return;
  const tree = current.closest("[role=tree]");
  if (tree === null) return;
  const items = [...tree.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const index = items.indexOf(current);
  let target: HTMLElement | undefined;
  if (event.key === "ArrowDown") target = items[index + 1];
  if (event.key === "ArrowUp") target = items[index - 1];
  if (event.key === "Home") target = items[0];
  if (event.key === "End") target = items.at(-1);
  if (event.key === "Enter" || event.key === " ") current.click();
  if (target !== undefined) {
    event.preventDefault();
    for (const item of items) item.tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  }
}
