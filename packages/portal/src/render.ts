import {
  decodeCanonicalJsonValue,
  type JsonValue,
  type PortalArtifactMetadata,
  type PortalDeliveryRecord,
  type PortalGraphEdge,
  type PortalGraphNode,
  type PortalHumanNeed,
} from "@senawa/protocol";
import { allowanceResult, allowanceReviewFromSource } from "./allowance-review.js";
import { type BoundedJsonNode, boundedJsonModel } from "./bounded-json.js";
import { narrationBusy, narrationText } from "./command-narrator.js";
import { focusGraphViewport, graphDiagramView } from "./graph-diagram.js";
import { graphLayout } from "./graph-layout.js";
import { type NodeToolbarAction, nodeToolbarView } from "./node-toolbar.js";
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
  type DialogKind,
  type GraphMode,
  INITIAL_GRAPH_VIEWPORT,
  type PortalDialogState,
  type PortalGraphViewport,
  type PortalState,
  revisionKey,
  runKey,
} from "./state.js";
import {
  captureTranscriptScroll,
  restoreTranscriptScroll,
  transcriptPaneView,
} from "./transcript-pane.js";

const GRAPH_MODES: readonly GraphMode[] = Object.freeze(["diagram", "table", "tree"]);

export interface PortalRenderActions {
  readonly navigate: (route: PortalRouteName) => void;
  readonly selectRun: (repositoryId: string, runId: string) => void;
  readonly setFilter: (value: string) => void;
  readonly setGraphMode: (mode: GraphMode) => void;
  readonly setGraphViewport: (viewport: PortalGraphViewport) => void;
  readonly focusRecord: (recordId: string) => void;
  readonly openNeed: (need: PortalHumanNeed, triggerId: string) => void;
  readonly openRunControl: (kind: "pause" | "resume" | "end", triggerId: string) => void;
  readonly closeDialog: () => void;
  readonly submitDialog: (kind: DialogKind, values: Readonly<Record<string, string>>) => void;
  readonly loadArtifact: (artifact: PortalArtifactMetadata) => void;
  readonly pageActivity: (kind: "events" | "receipts", before: number) => void;
  readonly toggleRightRail: (open: boolean) => void;
  readonly setTranscriptPinned: (pinned: boolean) => void;
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
  const banner = root.querySelector<HTMLElement>(".question-attention") ?? undefined;
  const attention = questionAttention(pendingQuestionNeed(state.humanNeeds), Date.now());
  const shell = element("div", "portal-shell");
  shell.append(renderHeader(state, actions), renderStatusStrip(state, narrator));
  const attentionBanner = renderQuestionAttention(state, actions, attention, banner);
  if (attentionBanner !== undefined) shell.append(attentionBanner);
  const body = element("div", "portal-body");
  applyRailGeometry(body, state.ui.railLayout);
  body.append(
    renderNavigation(state, actions),
    railDivider("left", state, actions),
    renderMain(state, actions),
    railDivider("right", state, actions),
    renderRightRail(state, actions),
  );
  shell.append(body);
  root.replaceChildren(shell);
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

function renderHeader(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const header = element("header", "app-header");
  const identity = element("div", "product-identity");
  identity.append(
    textElement("span", "product-mark", "S"),
    textElement("strong", "product-name", "Senawa"),
  );
  const runSwitch = element("label", "run-switcher");
  runSwitch.append(textElement("span", "field-label", "Repository / run"));
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
  const needsButton = commandButton(`Needs ${state.humanNeeds.length}`, () =>
    actions.toggleRightRail(true),
  );
  needsButton.className = "rail-toggle";
  tools.append(needsButton, statusBadge(state.session.status, state.session.status));
  header.append(identity, runSwitch, tools);
  return header;
}

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
  strip.append(
    connection,
    statusBadge(freshness, `Data ${freshness}`),
    statusBadge(
      Object.keys(state.pending).length > 0 ? "pending" : "clear",
      `${Object.keys(state.pending).length} pending commands`,
    ),
    statusBadge(
      state.humanNeeds.length > 0 ? "needs" : "clear",
      `${state.humanNeeds.length} human needs`,
    ),
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
function renderQuestionAttention(
  state: PortalState,
  actions: PortalRenderActions,
  attention: QuestionAttention | undefined,
  previous: HTMLElement | undefined,
): HTMLElement | undefined {
  if (attention === undefined) return undefined;
  const need = attention.need;
  const reused = previous !== undefined && previous.dataset.needId === need.needId;
  const banner =
    reused && previous !== undefined ? previous : element("section", "question-attention");
  banner.className = attention.overdue ? "question-attention overdue" : "question-attention";
  banner.setAttribute("role", "alert");
  banner.dataset.needId = need.needId;
  const heading = textElement("p", "question-attention-title", need.title);
  const facts = element("p", "question-attention-facts");
  facts.append(textElement("span", "question-attention-elapsed", attention.label));
  const overdue = textElement("span", "question-attention-overdue", "Overdue");
  overdue.hidden = !attention.overdue;
  facts.append(overdue);
  const triggerId = `question-attention-${safeDomId(need.needId)}`;
  const review = commandButton("Answer this question", () => actions.openNeed(need, triggerId));
  review.id = triggerId;
  review.disabled =
    actionsLocked(state) ||
    need.allowedCommands.length === 0 ||
    !needAllowedByCapabilities(need, state);
  banner.replaceChildren(heading, facts, review);
  return banner;
}

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

function renderNavigation(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const nav = element("nav", "primary-nav");
  nav.id = "primary-nav";
  nav.setAttribute("aria-label", "Run views");
  nav.dataset.collapsed = String(railCollapsed(state.ui.railLayout, "left"));
  const heading = element("div", "rail-heading");
  heading.append(
    textElement("p", "nav-label", "Run workspace"),
    railToggle("left", state, actions),
  );
  const spine = textElement("span", "rail-spine", "Views");
  spine.setAttribute("aria-hidden", "true");
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
  const overview = selectedOverview(state);
  const facts = element("dl", "nav-facts");
  appendFact(facts, "Mode", overview?.mode ?? "Unavailable");
  appendFact(facts, "Graph", overview?.sync.graphRevision.slice(0, 12) ?? "Unavailable");
  appendFact(facts, "Cursor", String(state.cursor));
  nav.append(heading, spine, list, facts);
  return nav;
}

function renderMain(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const main = element("main", "main-workspace");
  main.id = "main";
  main.tabIndex = -1;
  const heading = textElement("h1", "route-heading", routeLabel(state.route.name));
  heading.id = "route-heading";
  heading.tabIndex = -1;
  main.append(heading);
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
    case "overview":
      main.append(renderOverview(state, actions));
      break;
    case "graph":
      main.append(renderGraph(state, actions));
      break;
    case "delivery":
      main.append(renderDelivery(state));
      break;
    case "activity":
      main.append(renderActivity(state, actions));
      break;
    case "artifacts":
      main.append(renderArtifacts(state, actions));
      break;
    case "needs":
      main.append(renderNeeds(state, actions));
      break;
    case "amendments":
      main.append(renderAmendments(state));
      break;
    case "workspaces":
      main.append(renderWorkspaces(state));
      break;
  }
  return main;
}

function renderOverview(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "overview-view");
  const overview = selectedOverview(state);
  if (overview === undefined) return emptySection("Loading run authority");
  const modeBand = element("div", "mode-band");
  const title = element("div", "mode-title");
  title.append(
    textElement("h2", "section-heading", overview.displayName),
    textElement("p", "subtle", overview.workflowName),
  );
  const controls = element("div", "run-controls");
  const locked = actionsLocked(state) || !hasCapability(state, "portal-write-run-control");
  if (overview.mode === "running")
    controls.append(runControlButton("Pause", "pause", locked, actions));
  if (overview.mode === "paused")
    controls.append(runControlButton("Resume", "resume", locked, actions));
  if (!overview.terminal)
    controls.append(runControlButton("End run", "end", locked, actions, true));
  modeBand.append(title, statusBadge(overview.mode, `Run ${overview.mode}`), controls);
  const counts = element("dl", "count-grid");
  for (const [label, value] of [
    ["Phases", overview.counts.phases],
    ["Tasks", overview.counts.tasks],
    ["Criteria", overview.counts.criteria],
    ["Human needs", overview.counts.humanNeeds],
    ["Active effects", overview.counts.activeEffects],
    ["Uncertain effects", overview.counts.uncertainEffects],
  ] as const)
    appendMetric(counts, label, value);
  const vector = element("section", "vector-panel");
  vector.append(textElement("h2", "compact-heading", "Authority vector"));
  const vectorFacts = element("dl", "dense-facts");
  for (const [label, value] of Object.entries(overview.sync))
    appendFact(vectorFacts, label, String(value));
  vector.append(vectorFacts);
  section.append(modeBand, counts, vector);
  return section;
}

function renderDelivery(state: PortalState): HTMLElement {
  const section = element("section", "delivery-view");
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading delivery metadata");
  const page = state.caches.delivery[runKey(ids.repositoryId, ids.runId)];
  if (page === undefined) return emptySection("Loading delivery metadata");
  const stale = currentFreshness(state) === "stale";
  const summary = element("div", "mode-band");
  summary.append(
    textElement("h2", "section-heading", "Standard delivery authority"),
    statusBadge(stale ? "stale" : "fresh", stale ? "Projection stale" : "Projection current"),
  );
  const facts = element("dl", "inline-facts");
  appendFact(facts, "Dataflow revision", String(page.dataflowRevision));
  appendFact(facts, "Task frontier revision", String(page.taskFrontierRevision));
  appendFact(facts, "Loaded records", String(page.records.length));
  section.append(summary, facts);
  if (page.records.length === 0) {
    section.append(
      textElement("p", "empty-state", "No phase delivery metadata has been recorded."),
    );
    return section;
  }
  section.append(
    summaryTable(
      ["Kind", "Phase or task", "Attempt", "State", "Metadata"],
      page.records.map((record) => [
        record.kind,
        record.phaseId ?? record.taskId ?? "-",
        record.attempt === undefined ? "-" : String(record.attempt),
        deliveryState(record),
        deliveryMetadata(record),
      ]),
      "Standard delivery metadata records",
    ),
  );
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

function renderGraph(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "graph-view");
  const ids = selectedIds(state);
  if (ids === undefined || state.vector === undefined)
    return emptySection("Loading graph revision");
  const key = revisionKey(ids.repositoryId, ids.runId, state.vector.graphRevision);
  const summary = state.caches.graphSummaries[runKey(ids.repositoryId, ids.runId)];
  const nodes = state.caches.graphNodes[key]?.nodes ?? [];
  const edges = state.caches.graphEdges[key]?.edges ?? [];
  const toolbar = element("div", "view-toolbar");
  toolbar.append(filterInput(state, actions, "Filter loaded graph nodes"));
  const modes = element("div", "segmented-control");
  modes.setAttribute("role", "tablist");
  for (const mode of GRAPH_MODES) {
    const button = commandButton(graphModeLabel(mode), () => actions.setGraphMode(mode));
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.ui.graphMode === mode));
    modes.append(button);
  }
  toolbar.append(
    modes,
    textElement("span", "result-count", `${nodes.length} of ${summary?.nodeCount ?? 0} nodes`),
  );
  section.append(toolbar);
  const filtered = nodes.filter((node) =>
    graphText(node).includes(state.ui.filter.toLocaleLowerCase()),
  );
  section.append(graphBody(state, actions, nodes, edges, filtered));
  const focused = nodes.find(({ nodeId }) => nodeId === state.ui.focusedRecord);
  if (focused !== undefined) section.append(graphDetail(focused, state, actions, nodes, edges));
  section.append(
    transcriptPaneView({
      view: state.ui.transcript,
      actions: { setTranscriptPinned: (pinned) => actions.setTranscriptPinned(pinned) },
    }),
  );
  return section;
}

function graphBody(
  state: PortalState,
  actions: PortalRenderActions,
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
  filtered: readonly PortalGraphNode[],
): HTMLElement {
  switch (state.ui.graphMode) {
    case "diagram":
      return graphDiagramView({
        nodes,
        edges,
        selectedNodeId: state.ui.focusedRecord,
        viewport: state.ui.graphViewport,
        actions: {
          select: (nodeId) => actions.focusRecord(nodeId),
          setViewport: (viewport) => actions.setGraphViewport(viewport),
        },
      });
    case "table":
      return graphTable(filtered, actions);
    case "tree":
      return graphTree(filtered, actions);
  }
}

function graphModeLabel(mode: GraphMode): string {
  const labels: Readonly<Record<GraphMode, string>> = {
    diagram: "Diagram",
    table: "Table",
    tree: "Tree",
  };
  return labels[mode];
}

function graphTable(nodes: readonly PortalGraphNode[], actions: PortalRenderActions): HTMLElement {
  const wrapper = element("div", "table-scroll");
  const table = document.createElement("table");
  table.className = "dense-table graph-table";
  const caption = textElement("caption", "visually-hidden", "Loaded workflow graph nodes");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["Kind", "Title", "Generation", "Lifecycle", "Needs", "Evidence"])
    headRow.append(textElement("th", "", label));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const node of nodes) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.dataset.focusKey = node.nodeId;
    row.addEventListener("click", () => actions.focusRecord(node.nodeId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        actions.focusRecord(node.nodeId);
      }
    });
    const cells = [
      textElement("td", "mono", node.kind),
      textElement("td", "row-title", node.title),
      textElement("td", "numeric", String(node.definitionGeneration)),
      textElement("td", "", node.lifecycle),
      textElement("td", "numeric", String(node.humanNeedCount)),
      textElement("td", "numeric", String(node.evidenceCount)),
    ];
    for (const [index, cell] of cells.entries())
      cell.dataset.label =
        ["Kind", "Title", "Generation", "Lifecycle", "Needs", "Evidence"][index] ?? "Value";
    row.append(...cells);
    body.append(row);
  }
  table.append(caption, head, body);
  wrapper.append(table);
  return wrapper;
}

function graphTree(nodes: readonly PortalGraphNode[], actions: PortalRenderActions): HTMLElement {
  const tree = element("ul", "graph-tree");
  tree.setAttribute("role", "tree");
  const visible = new Set(nodes.map(({ nodeId }) => nodeId));
  const roots = nodes.filter(
    ({ parentNodeId }) => parentNodeId === undefined || !visible.has(parentNodeId),
  );
  const appendChildren = (parent: HTMLElement, node: PortalGraphNode, level: number) => {
    const item = element("li", "tree-item");
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(level));
    item.dataset.focusKey = node.nodeId;
    item.tabIndex = parent.querySelector("[role=treeitem]") === null && level === 1 ? 0 : -1;
    item.textContent = `${node.kind}: ${node.title} (${node.lifecycle})`;
    item.addEventListener("click", () => actions.focusRecord(node.nodeId));
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

function graphDetail(
  node: PortalGraphNode,
  state: PortalState,
  actions: PortalRenderActions,
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): HTMLElement {
  const detail = element("section", "detail-panel");
  detail.append(textElement("h2", "compact-heading", node.title));
  detail.append(
    nodeToolbarView({
      nodeId: node.nodeId,
      actions: nodeActions(node, state, actions, nodes, edges),
    }),
  );
  const facts = element("dl", "dense-facts");
  appendFact(facts, "Identity", node.nodeId);
  appendFact(facts, "Source", node.sourcePointer ?? "Not supplied");
  appendFact(facts, "Superseded by", node.supersededBy ?? "No successor");
  detail.append(facts);
  if (node.normalizedInput !== undefined)
    detail.append(renderJson(node.normalizedInput, "Normalized input"));
  if (node.completionPolicy !== undefined)
    detail.append(renderJson(node.completionPolicy, "Completion policy"));
  return detail;
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
  const need = state.humanNeeds.find(
    (candidate) =>
      candidate.taskId === node.nodeId &&
      (candidate.definitionGeneration === undefined ||
        candidate.definitionGeneration === node.definitionGeneration),
  );
  const reviewId = `node-review-${safeDomId(node.nodeId)}`;
  return Object.freeze([
    Object.freeze({
      key: "copy",
      label: "Copy identity",
      disabled: false,
      run: () => copyText(node.nodeId),
    }),
    Object.freeze({
      key: "focus",
      label: "Focus in diagram",
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
      key: "review",
      label: "Review linked human need",
      disabled:
        need === undefined ||
        actionsLocked(state) ||
        need.allowedCommands.length === 0 ||
        !needAllowedByCapabilities(need, state),
      run: () => {
        if (need !== undefined) actions.openNeed(need, reviewId);
      },
    }),
  ]);
}

function copyText(value: string): void {
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (clipboard !== undefined) void clipboard.writeText(value).catch(() => undefined);
}

function renderActivity(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "activity-view");
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading activity");
  const key = runKey(ids.repositoryId, ids.runId);
  const events = state.caches.events[key];
  const receipts = state.caches.receipts[key];
  section.append(filterInput(state, actions, "Filter loaded activity"));
  const columns = element("div", "activity-columns");
  columns.append(
    activityList(
      "Events",
      events?.events ?? state.visibleEvents,
      state.ui.filter,
      (entry) => `${entry.cursor} ${entry.eventType} ${entry.occurredAt}`,
    ),
    activityList(
      "Receipts",
      receipts?.receipts ?? [],
      state.ui.filter,
      (entry) => `${entry.cursor} ${entry.status} ${entry.commandId}`,
    ),
  );
  section.append(columns);
  const paging = element("div", "paging-row");
  if (events?.hasEarlier === true)
    paging.append(
      commandButton("Earlier events", () =>
        actions.pageActivity("events", events.events[0]?.cursor ?? events.earliestCursor),
      ),
    );
  if (receipts?.hasEarlier === true)
    paging.append(
      commandButton("Earlier receipts", () =>
        actions.pageActivity("receipts", receipts.receipts[0]?.cursor ?? receipts.earliestCursor),
      ),
    );
  section.append(paging);
  return section;
}

function activityList<Value>(
  title: string,
  values: readonly Value[],
  filter: string,
  label: (value: Value) => string,
): HTMLElement {
  const panel = element("section", "activity-panel");
  panel.append(textElement("h2", "compact-heading", title));
  const list = element("ol", "activity-list");
  const needle = filter.toLocaleLowerCase();
  for (const value of values) {
    const summary = label(value);
    if (!summary.toLocaleLowerCase().includes(needle)) continue;
    const item = element("li", "activity-item");
    item.append(textElement("p", "mono activity-summary", summary));
    item.append(renderJson(asJson(value), `${title} detail`));
    list.append(item);
  }
  panel.append(list);
  return panel;
}

function renderArtifacts(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "artifact-view");
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading artifacts");
  const key = runKey(ids.repositoryId, ids.runId);
  const artifacts = state.caches.artifacts[key]?.artifacts ?? [];
  section.append(filterInput(state, actions, "Filter loaded artifacts"));
  const list = element("div", "artifact-list");
  for (const artifact of artifacts) {
    if (
      !`${artifact.summary} ${artifact.mediaType} ${artifact.artifactId}`
        .toLocaleLowerCase()
        .includes(state.ui.filter.toLocaleLowerCase())
    )
      continue;
    const row = element("article", "artifact-row");
    const facts = element("dl", "artifact-facts");
    appendFact(facts, "Artifact", artifact.summary);
    appendFact(facts, "Type", artifact.mediaType);
    appendFact(facts, "Size", formatBytes(artifact.byteLength));
    appendFact(facts, "Sensitivity", artifact.sensitivity);
    appendFact(facts, "Digest", artifact.contentDigest);
    row.append(facts, statusBadge(artifact.availability, artifact.availability));
    const preview =
      state.caches.artifactContent[
        artifactContentKey(ids.repositoryId, ids.runId, artifact.artifactId)
      ];
    if (artifact.availability === "verified-stored" && previewAllowed(artifact.mediaType)) {
      row.append(commandButton("Preview bounded content", () => actions.loadArtifact(artifact)));
    } else {
      row.append(
        textElement(
          "p",
          "subtle",
          artifact.availability === "metadata-only"
            ? "Verified bytes unavailable"
            : "Active preview prohibited for this media type",
        ),
      );
    }
    if (preview !== undefined) {
      const expandId = `artifact-expand-${safeDomId(artifact.artifactId)}`;
      const expand = commandButton("Expand full screen", () =>
        actions.openAssetOverlay(artifact.artifactId, expandId),
      );
      expand.id = expandId;
      row.append(expand);
      row.append(renderArtifactPreview(preview.content, preview.encoding, artifact.mediaType));
    }
    list.append(row);
  }
  section.append(list);
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

function renderNeeds(state: PortalState, actions: PortalRenderActions): HTMLElement {
  const section = element("section", "needs-view");
  section.append(filterInput(state, actions, "Filter human needs"));
  const list = element("div", "need-list");
  for (const need of state.humanNeeds) {
    if (
      !`${need.title} ${need.kind}`
        .toLocaleLowerCase()
        .includes(state.ui.filter.toLocaleLowerCase())
    )
      continue;
    list.append(renderNeed(need, state, actions, "main"));
  }
  if (list.childElementCount === 0)
    list.append(textElement("p", "empty-state", "No matching human needs."));
  section.append(list);
  return section;
}

function renderNeed(
  need: PortalHumanNeed,
  state: PortalState,
  actions: PortalRenderActions,
  scope: string,
): HTMLElement {
  const item = element("article", "need-row");
  item.append(textElement("h3", "row-title", need.title), statusBadge(need.kind, need.kind));
  const facts = element("dl", "inline-facts");
  appendFact(facts, "Created", need.createdAt);
  appendFact(facts, "Revision", String(need.sourceRevision));
  item.append(facts);
  const triggerId = `review-${scope}-${safeDomId(need.needId)}`;
  const button = commandButton("Review exact record", () => actions.openNeed(need, triggerId));
  button.id = triggerId;
  button.disabled =
    actionsLocked(state) ||
    need.allowedCommands.length === 0 ||
    !needAllowedByCapabilities(need, state);
  item.append(button);
  return item;
}

function renderAmendments(state: PortalState): HTMLElement {
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading amendments");
  const value = state.caches.amendments[runKey(ids.repositoryId, ids.runId)];
  const section = element("section", "amendment-view");
  section.append(
    textElement(
      "p",
      "scope-note",
      "Worker source, reviewed result graph, affected scopes, and structural operations are shown as bounded inert data. Trusted application controls are not available in the portal.",
    ),
  );
  if (value === undefined)
    section.append(textElement("p", "empty-state", "No amendment records are loaded."));
  else section.append(renderJson(asJson(value), "Amendment source, impact, and diff"));
  return section;
}

function renderWorkspaces(state: PortalState): HTMLElement {
  const ids = selectedIds(state);
  if (ids === undefined) return emptySection("Loading workspaces");
  const key = runKey(ids.repositoryId, ids.runId);
  const section = element("section", "workspace-view");
  const workspaces = state.caches.workspaces[key]?.workspaces ?? [];
  const integrations = state.caches.integrations[key]?.integrations ?? [];
  section.append(
    textElement("h2", "section-heading", "Task workspaces"),
    summaryTable(
      ["Task", "Generation", "Mode", "State", "Completion", "Result"],
      workspaces.map((workspace) => [
        workspace.taskId,
        String(workspace.definitionGeneration),
        workspace.mode,
        workspace.state,
        workspace.completionEligible ? "Eligible" : "Blocked",
        workspace.resultDigest ?? "No captured result",
      ]),
      "Task workspace authority",
    ),
  );
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

function renderRightRail(state: PortalState, actions: PortalRenderActions): HTMLElement {
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
  heading.append(textElement("h2", "compact-heading", "Attention"));
  const close = commandButton("Close", () => actions.toggleRightRail(false));
  close.className = "rail-close";
  heading.append(close);
  const spine = textElement("span", "rail-spine", "Attention");
  spine.setAttribute("aria-hidden", "true");
  aside.append(heading, spine);
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
  const needsSection = element("section", "rail-section");
  needsSection.append(textElement("h3", "rail-section-heading", "Human queue"));
  for (const need of state.humanNeeds.slice(0, 20))
    needsSection.append(renderNeed(need, state, actions, "rail"));
  aside.append(pendingSection, needsSection);
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
      if (dialogState.answerDraft !== undefined) input.value = dialogState.answerDraft;
      input.addEventListener("input", () => actions.saveAnswerDraft(input.value));
    }
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
  input.placeholder = "Filter loaded records";
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
  return `${node.kind} ${node.title} ${node.lifecycle} ${node.nodeId}`.toLocaleLowerCase();
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
    overview: "Overview",
    graph: "Graph",
    delivery: "Delivery",
    activity: "Activity",
    artifacts: "Artifacts",
    needs: "Human needs",
    amendments: "Amendments",
    workspaces: "Workspaces",
  };
  return labels[route];
}

function dialogConsequence(kind: DialogKind): string {
  const consequences: Readonly<Record<DialogKind, string>> = {
    answer: "This records an immutable answer and requires a fresh dispatch boundary.",
    approval: "This decision applies only to the displayed candidate digest and graph revision.",
    amendment: "Approval records a decision only. Trusted supervisor recovery owns application.",
    allowance: "This changes one bounded budget limit without resetting prior accounting.",
    pause: "Pause blocks new effect admission and does not cancel active effects.",
    resume: "Resume reopens admission at the displayed run mode revision.",
    end: "End fences current task scopes, requests cancellation, and is permanent after convergence.",
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
