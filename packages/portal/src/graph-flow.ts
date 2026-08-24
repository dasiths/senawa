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
  const parts = [members.length === 1 ? "1 piece of work" : `${String(members.length)} members`];
  const asking = members.filter((member) => member.humanNeedCount > 0).length;
  const failed = members.filter((member) => member.runState === "failed").length;
  if (asking > 0) parts.push(`${String(asking)} asks`);
  if (failed > 0) parts.push(`${String(failed)} stopped`);
  return parts.join(" \u00b7 ");
}

function memberCard(
  node: PortalGraphNode,
  selected: boolean,
  extras: GraphFlowNodeExtras,
  actions: GraphFlowActions,
): HTMLElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = `gnode kind-${node.kind} ${stateTone(node.runState)}`;
  card.dataset.node = node.nodeId;
  card.dataset.focusKey = node.nodeId;
  if (selected) card.setAttribute("aria-current", "true");
  card.append(textElement("span", "g-name", node.title));
  if (extras.who !== undefined) {
    const meta = element("span", "g-meta");
    meta.append(extras.who);
    card.append(meta);
  }
  const foot = element("span", "g-foot");
  foot.append(statePill(node.runState));
  for (const control of extras.foot ?? []) foot.append(control);
  card.append(foot);
  card.addEventListener("click", (event) => {
    if (event.target !== card && (event.target as HTMLElement).closest("button") !== card) return;
    actions.select(node.nodeId);
  });
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
  // them all under the last one.
  const membersOf = (phaseId: string): readonly PortalGraphNode[] => {
    const ordered: PortalGraphNode[] = [];
    for (const member of nodes.filter((node) => node.parentNodeId === phaseId)) {
      ordered.push(member, ...nodes.filter((node) => node.parentNodeId === member.nodeId));
    }
    return ordered;
  };
  const placed = new Set(phases.flatMap((phase) => membersOf(phase.nodeId).map((n) => n.nodeId)));
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
      body.append(memberCard(member, member.nodeId === selectedNodeId, decorate(member), actions));
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
    for (const node of orphans)
      loose.append(memberCard(node, node.nodeId === selectedNodeId, decorate(node), actions));
    flow.append(loose);
  }

  const end = textElement(
    "span",
    "finish",
    phases.length === 0
      ? "nothing has been compiled yet"
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
