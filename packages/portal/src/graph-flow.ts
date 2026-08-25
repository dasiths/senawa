import type { PortalGraphEdge, PortalGraphNode } from "@senawa/protocol";
import { nodeMark, statePill, stateTone } from "./node-vocabulary.js";

/**
 * The workflow read as a flow of phases rather than as a box-and-line drawing.
 * A phase is a band, its members are cards inside it, and what a phase handed on
 * is a chip on the line between them. Edges are measured from the laid-out
 * nodes after mount, so the picture survives wrapping, renaming and folding.
 */

export interface GraphFlowNodeExtras {
  /** Who is doing it, and on what model. */
  readonly who?: HTMLElement | undefined;
  /** Controls and badges that belong on the card's foot. */
  readonly foot?: readonly HTMLElement[];
}

export interface GraphFlowActions {
  select(nodeId: string): void;
  toggleFold(nodeId: string): void;
  unfoldAll(): void;
}

export interface GraphFlowOptions {
  /** Phases and their members, already in execution order. */
  readonly nodes: readonly PortalGraphNode[];
  readonly edges: readonly PortalGraphEdge[];
  readonly selectedNodeId: string | undefined;
  /** Phases a reader opened by hand, which outrank the automatic rule. */
  readonly unfolded: readonly string[];
  /** Whether the run is over, so the flow does not describe it in future tense. */
  readonly terminal?: boolean;
  /** What each task handed on, keyed by node id. */
  readonly handedOn: ReadonlyMap<string, { readonly name: string; readonly size: string }>;
  readonly decorate: (node: PortalGraphNode) => GraphFlowNodeExtras;
  readonly actions: GraphFlowActions;
}

const SVG = "http://www.w3.org/2000/svg";

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className.length > 0) node.className = className;
  return node;
}

function textElement(tag: string, className: string, text: string): HTMLElement {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}

/** A phase stays open while anything in it is still running or asking. */
function phaseIsOpen(
  phase: PortalGraphNode,
  members: readonly PortalGraphNode[],
  unfolded: readonly string[],
): boolean {
  if (unfolded.includes(phase.nodeId)) return true;
  if (members.length === 0) return false;
  return members.some((member) => member.runState !== "accepted" || member.humanNeedCount > 0);
}

function foldSummary(members: readonly PortalGraphNode[]): string {
  if (members.length === 0) return "no work yet";
  const parts = [
    members.length === 1 ? "1 piece of work" : `${String(members.length)} pieces of work`,
  ];
  const asking = members.filter((member) => member.humanNeedCount > 0).length;
  const failed = members.filter((member) => member.runState === "failed").length;
  if (asking > 0) parts.push(`${String(asking)} asks`);
  if (failed > 0) parts.push(`${String(failed)} stopped`);
  return parts.join(" \u00b7 ");
}

/**
 * What a node still owes, drawn on the node that owes it.
 *
 * A criterion is how a piece of work is allowed to finish, not another piece of
 * work, and drawing it as a peer card made four tasks look like eight members
 * and gave a thing that never ran a green `done` pill. A mark is lit once the
 * node has produced what it owed and dark while it is still owed, so it reports
 * possession rather than execution. It stays selectable because the detail pane
 * already reads a criterion correctly as an exit condition.
 */
function criterionMarks(
  criteria: readonly PortalGraphNode[],
  selectedNodeId: string | undefined,
  actions: GraphFlowActions,
): HTMLElement {
  const marks = element("span", "g-marks");
  for (const criterion of criteria) {
    const mark = document.createElement("button");
    mark.type = "button";
    const produced = criterion.runState === "accepted";
    mark.className = `g-mark ${produced ? "is-produced" : "is-owed"}`;
    mark.dataset.node = criterion.nodeId;
    mark.dataset.focusKey = criterion.nodeId;
    // Four members of one fan-out owe criteria with the same name, so the name
    // alone does not say which task is owed. Saying which node it sits on is
    // what the mark adds over the card it used to be.
    mark.setAttribute(
      "aria-label",
      `${criterion.title}: ${produced ? "produced" : "not produced yet"}`,
    );
    mark.title = criterion.title;
    if (criterion.nodeId === selectedNodeId) mark.setAttribute("aria-current", "true");
    mark.append(
      textElement("span", "g-mark-dot", nodeMark("criterion")),
      textElement("span", "g-mark-name", criterion.title),
    );
    mark.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.select(criterion.nodeId);
    });
    marks.append(mark);
  }
  return marks;
}

function memberCard(
  node: PortalGraphNode,
  criteria: readonly PortalGraphNode[],
  selected: boolean,
  selectedNodeId: string | undefined,
  extras: GraphFlowNodeExtras,
  actions: GraphFlowActions,
): HTMLElement {
  // The card holds the node and everything the node owes, so it is a container
  // rather than a control; the control that opens the node fills it.
  const card = element("div", `gnode kind-${node.kind} ${stateTone(node.runState)}`);
  card.dataset.node = node.nodeId;
  if (selected) card.setAttribute("aria-current", "true");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "g-open";
  open.dataset.focusKey = node.nodeId;
  open.append(textElement("span", "g-name", node.title));
  if (extras.who !== undefined) {
    const meta = element("span", "g-meta");
    meta.append(extras.who);
    open.append(meta);
  }
  const foot = element("span", "g-foot");
  foot.append(statePill(node.runState));
  for (const control of extras.foot ?? []) foot.append(control);
  open.append(foot);
  open.addEventListener("click", () => actions.select(node.nodeId));
  card.append(open);
  if (criteria.length > 0) card.append(criterionMarks(criteria, selectedNodeId, actions));
  // The whole card still selects the node, including the padding around the
  // control and the space beside the marks. A mark stops its own click, so the
  // only thing that reaches here is the card itself.
  card.addEventListener("click", () => actions.select(node.nodeId));
  return card;
}

export function graphFlowView(options: GraphFlowOptions): HTMLElement {
  const { nodes, selectedNodeId, unfolded, handedOn, decorate, actions } = options;
  const container = element("div", "graph");
  container.id = "graph-flow";
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "graph-edges");
  svg.setAttribute("aria-hidden", "true");
  container.append(svg);
  const flow = element("div", "graph-flow");

  const start = textElement("span", "finish", "what you asked for");
  start.dataset.node = "start";
  flow.append(start);

  // The run itself is named by the page heading; a band is a phase.
  const phases = nodes.filter((node) => node.kind === "phase");
  // A phase owns its tasks, and a task owns what it had to produce. Matching on
  // the direct parent alone left every criterion out of its own band and piled
  // them all under the last one, so what a task owes travels with the task.
  const owedBy = (nodeId: string): readonly PortalGraphNode[] =>
    nodes.filter((node) => node.parentNodeId === nodeId && node.kind === "criterion");
  const membersOf = (phaseId: string): readonly PortalGraphNode[] =>
    nodes.filter((node) => node.parentNodeId === phaseId && node.kind !== "criterion");
  const placed = new Set(
    phases.flatMap((phase) =>
      membersOf(phase.nodeId).flatMap((member) => [
        member.nodeId,
        ...owedBy(member.nodeId).map((criterion) => criterion.nodeId),
      ]),
    ),
  );
  const orphans = nodes.filter(
    (node) => node.kind !== "phase" && node.kind !== "workflow" && !placed.has(node.nodeId),
  );
  let previous = "start";
  for (const phase of phases) {
    const members = membersOf(phase.nodeId);
    const band = document.createElement("details");
    band.className = "band";
    band.dataset.node = phase.nodeId;
    band.dataset.from = previous;
    band.open = phaseIsOpen(phase, members, unfolded);
    const summary = document.createElement("summary");
    summary.append(
      textElement("span", "node-mark", nodeMark("phase")),
      textElement("span", "band-name", phase.title),
      statePill(phase.runState),
      textElement("span", "fold-sub", foldSummary(members)),
    );
    summary.addEventListener("click", (event) => {
      event.preventDefault();
      actions.toggleFold(phase.nodeId);
    });
    band.append(summary);
    const body = element("div", "band-body");
    for (const member of members) {
      body.append(
        memberCard(
          member,
          owedBy(member.nodeId),
          member.nodeId === selectedNodeId,
          selectedNodeId,
          decorate(member),
          actions,
        ),
      );
    }
    if (members.length === 0)
      body.append(textElement("p", "empty-state", "Nothing has been dispatched here yet."));
    band.append(body);
    flow.append(band);
    previous = phase.nodeId;
    // What a phase handed on is the reason the next phase could start.
    const carried = members
      .map((member) => handedOn.get(member.nodeId))
      .find((v) => v !== undefined);
    if (carried !== undefined) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.dataset.node = `artifact-${phase.nodeId}`;
      chip.dataset.from = phase.nodeId;
      // The line between two phases is where a reader looks for what crossed
      // it, and the phase's own name is already on the band above.
      const name = textElement("b", "", carried.name);
      chip.append(name, textElement("span", "fan", carried.size));
      chip.addEventListener("click", () => actions.select(phase.nodeId));
      flow.append(chip);
      previous = `artifact-${phase.nodeId}`;
    }
  }

  if (orphans.length > 0) {
    const loose = element("div", "band-body");
    // A criterion whose task is not in the band still has to be reachable, so
    // it keeps a card of its own here rather than disappearing with its task.
    for (const node of orphans)
      loose.append(
        memberCard(
          node,
          owedBy(node.nodeId),
          node.nodeId === selectedNodeId,
          selectedNodeId,
          decorate(node),
          actions,
        ),
      );
    flow.append(loose);
  }

  const end = textElement(
    "span",
    "finish",
    phases.length === 0
      ? "nothing has been compiled yet"
      : // A run that is over has finished. Saying what it will do when every
        // phase is accepted, to a reader looking at a run where every phase
        // already is, describes something that has happened as something that
        // is going to.
        options.terminal === true
        ? "every phase was accepted, and the run finished"
        : "the run finishes when every phase is accepted",
  );
  end.dataset.node = "end";
  end.dataset.from = previous;
  flow.append(end);
  container.append(flow);

  const legend = element("div", "graph-legend");
  const carriedKey = element("span", "");
  carriedKey.append(element("i", "solid"), textElement("span", "", "carried"));
  const notYet = element("span", "");
  notYet.append(element("i", "dashed"), textElement("span", "", "not yet"));
  legend.append(
    carriedKey,
    notYet,
    textElement("span", "", "a phase stays open while anything in it is running"),
  );
  const legendActions = element("span", "legend-actions");
  const unfoldAll = document.createElement("button");
  unfoldAll.type = "button";
  unfoldAll.id = "graph-unfold-all";
  unfoldAll.textContent = unfolded.length > 0 ? "Follow the work" : "Unfold all";
  unfoldAll.addEventListener("click", () => actions.unfoldAll());
  legendActions.append(unfoldAll);
  legend.append(legendActions);
  container.append(legend);
  return container;
}

/**
 * Measures the laid-out flow and draws the lines between it. A line a run has
 * actually travelled is solid; one it has not is dashed.
 */
export function drawGraphFlowEdges(root: ParentNode): void {
  const graph = root.querySelector<HTMLElement>("#graph-flow");
  if (graph === null) return;
  const svg = graph.querySelector("svg.graph-edges");
  if (svg === null) return;
  if (graph.offsetParent === null && graph.getClientRects().length === 0) return;
  const box = graph.getBoundingClientRect();
  if (box.width === 0) return;
  const seen = new Set<string>();
  const paths: SVGPathElement[] = [];
  for (const target of graph.querySelectorAll<HTMLElement>("[data-from]")) {
    const to = anchor(target).getBoundingClientRect();
    for (const id of (target.dataset.from ?? "").split(",")) {
      const source = graph.querySelector<HTMLElement>(`[data-node="${cssEscape(id.trim())}"]`);
      if (source === null) continue;
      const from = anchor(source).getBoundingClientRect();
      const x1 = from.left - box.left + from.width / 2;
      const y1 = from.bottom - box.top;
      const x2 = to.left - box.left + to.width / 2;
      const y2 = to.top - box.top;
      if (y2 <= y1) continue;
      const bend = Math.max(14, (y2 - y1) * 0.55);
      const carried = !source.classList.contains("gnode") || source.classList.contains("is-closed");
      const d = `M${String(x1)} ${String(y1)} C${String(x1)} ${String(y1 + bend)}, ${String(x2)} ${String(y2 - bend)}, ${String(x2)} ${String(y2 - 5)}`;
      const key = `${d}|${String(carried)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", carried ? "edge is-done" : "edge");
      path.setAttribute("marker-end", carried ? "url(#flow-tip-done)" : "url(#flow-tip)");
      path.setAttribute("d", d);
      paths.push(path);
    }
  }
  svg.setAttribute("viewBox", `0 0 ${String(box.width)} ${String(box.height)}`);
  const defs = document.createElementNS(SVG, "defs");
  defs.append(arrowMarker("flow-tip", "#cfd4dc"), arrowMarker("flow-tip-done", "#b6c2d2"));
  svg.replaceChildren(defs, ...paths);
}

function arrowMarker(id: string, fill: string): SVGMarkerElement {
  const marker = document.createElementNS(SVG, "marker");
  marker.setAttribute("id", id);
  marker.setAttribute("viewBox", "0 0 8 8");
  marker.setAttribute("refX", "4");
  marker.setAttribute("refY", "4");
  marker.setAttribute("markerWidth", "5");
  marker.setAttribute("markerHeight", "5");
  marker.setAttribute("orient", "auto");
  const head = document.createElementNS(SVG, "path");
  head.setAttribute("d", "M0 0 L8 4 L0 8 z");
  head.setAttribute("fill", fill);
  marker.append(head);
  return marker;
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/gu, "\\$&");
}

/** A folded member has no box, so its line attaches to the band that swallowed it. */
function anchor(node: HTMLElement): HTMLElement {
  let at = node;
  while (at.offsetWidth === 0 && at.parentElement !== null) {
    at = at.parentElement.closest<HTMLElement>("[data-node]") ?? at.parentElement;
  }
  return at;
}
