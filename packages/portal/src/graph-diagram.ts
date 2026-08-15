import type { PortalGraphEdge, PortalGraphNode } from "@senawa/protocol";
import {
  GRAPH_CONTAINER_HEADER,
  type GraphLayout,
  type GraphLayoutNode,
  graphLayout,
} from "./graph-layout.js";
import type { PortalGraphViewport } from "./state.js";

export interface GraphDiagramBadge {
  readonly className: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

export interface GraphDiagramNode {
  readonly nodeId: string;
  readonly className: string;
  readonly ariaLabel: string;
  readonly lines: readonly string[];
  readonly badges: readonly GraphDiagramBadge[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelWidth: number;
  readonly labelHeight: number;
}

export interface GraphDiagramEdge {
  readonly edgeId: string;
  readonly className: string;
  readonly points: string;
}

export interface GraphDiagramModel {
  readonly nodes: readonly GraphDiagramNode[];
  readonly edges: readonly GraphDiagramEdge[];
  readonly rows: readonly (readonly string[])[];
  readonly selectedNodeId: string | undefined;
}

export interface GraphDiagramSnapshot {
  readonly nodeIds: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly viewBox: string;
  readonly scale: number;
  readonly selectedNodeId: string | undefined;
}

export interface GraphDiagramActions {
  readonly select: (nodeId: string) => void;
  readonly setViewport: (viewport: PortalGraphViewport) => void;
}

export interface GraphDiagramInput {
  readonly nodes: readonly PortalGraphNode[];
  readonly edges: readonly PortalGraphEdge[];
  readonly selectedNodeId: string | undefined;
  readonly viewport: PortalGraphViewport;
  readonly actions: GraphDiagramActions;
}

declare global {
  interface Window {
    __senawaGraphDiagram?: GraphDiagramSnapshot;
  }
}

export const GRAPH_SCALE_STEPS: readonly number[] = Object.freeze([0.5, 0.75, 1, 1.5, 2, 3]);

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const LABEL_PADDING = 10;
const LINE_HEIGHT = 18;
const BADGE_GUTTER = 92;
const BADGE_INSET = 10;
const KNOWN_KINDS: readonly string[] = Object.freeze(["workflow", "phase", "task", "criterion"]);
const KNOWN_STATES: readonly string[] = Object.freeze([
  "not-started",
  "running",
  "awaiting-human",
  "accepted",
  "failed",
  "superseded",
]);
const KNOWN_EDGE_KINDS: readonly string[] = Object.freeze([
  "containment",
  "dependency",
  "supersession",
]);
const STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "not-started": "Not started",
  running: "Running",
  "awaiting-human": "Awaiting human",
  accepted: "Accepted",
  failed: "Failed",
  superseded: "Superseded",
});

/**
 * Derives every rendered string, class, and coordinate. Attacker-controlled
 * text reaches this model only as display text; identifiers that become class
 * names pass through a closed allowlist first.
 */
export function graphDiagramModel(
  layout: GraphLayout,
  selectedNodeId: string | undefined,
): GraphDiagramModel {
  const selected = layout.nodes.some((node) => node.nodeId === selectedNodeId)
    ? selectedNodeId
    : undefined;
  const nodes = layout.nodes.map((node) => diagramNode(node, node.nodeId === selected));
  const rows: string[][] = [];
  for (const node of layout.nodes) {
    const row = rows[node.row];
    if (row === undefined) rows[node.row] = [node.nodeId];
    else row.push(node.nodeId);
  }
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(
      layout.edges.map((edge) =>
        Object.freeze({
          edgeId: edge.edgeId,
          className: `diagram-edge diagram-edge-${token(edge.kind, KNOWN_EDGE_KINDS)}`,
          points: edge.points.map(({ x, y }) => `${x},${y}`).join(" "),
        }),
      ),
    ),
    rows: Object.freeze(rows.map((row) => Object.freeze([...row]))),
    selectedNodeId: selected,
  });
}

function diagramNode(node: GraphLayoutNode, selected: boolean): GraphDiagramNode {
  const stateLabel = STATE_LABELS[node.runState] ?? "Unknown";
  const lines = [node.title];
  if (node.roleKey !== undefined && node.roleKey.length > 0) lines.push(`Role ${node.roleKey}`);
  lines.push(stateLabel);
  const badges: GraphDiagramBadge[] = [];
  const badgeX = node.x + node.width - BADGE_INSET;
  if (node.humanNeedCount > 0) {
    badges.push(
      Object.freeze({
        className: "diagram-badge diagram-badge-needs",
        label: `Needs ${node.humanNeedCount}`,
        x: badgeX,
        y: node.y + 24,
      }),
    );
  }
  if (node.evidenceCount > 0) {
    badges.push(
      Object.freeze({
        className: "diagram-badge diagram-badge-evidence",
        label: `Evidence ${node.evidenceCount}`,
        x: badgeX,
        y: node.y + 24 + LINE_HEIGHT,
      }),
    );
  }
  const labelHeight = node.container ? GRAPH_CONTAINER_HEADER : node.height;
  const gutter = badges.length === 0 ? 0 : BADGE_GUTTER;
  return Object.freeze({
    nodeId: node.nodeId,
    className: diagramNodeClass(node, selected),
    ariaLabel: diagramNodeAriaLabel(node, stateLabel),
    lines: Object.freeze(lines),
    badges: Object.freeze(badges),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    labelX: node.x + LABEL_PADDING,
    labelY: node.y + LABEL_PADDING,
    labelWidth: Math.max(1, node.width - LABEL_PADDING * 2 - gutter),
    labelHeight: Math.max(1, labelHeight - LABEL_PADDING * 2),
  });
}

function diagramNodeClass(node: GraphLayoutNode, selected: boolean): string {
  const classes = [
    "diagram-node",
    `diagram-kind-${token(node.kind, KNOWN_KINDS)}`,
    `diagram-state-${token(node.runState, KNOWN_STATES)}`,
  ];
  if (node.container) classes.push("diagram-container");
  if (selected) classes.push("diagram-selected");
  return classes.join(" ");
}

function diagramNodeAriaLabel(node: GraphLayoutNode, stateLabel: string): string {
  const parts = [`${token(node.kind, KNOWN_KINDS)} ${node.title}`, stateLabel];
  if (node.roleKey !== undefined && node.roleKey.length > 0) parts.push(`role ${node.roleKey}`);
  if (node.humanNeedCount > 0) parts.push(`${node.humanNeedCount} human needs`);
  if (node.evidenceCount > 0) parts.push(`${node.evidenceCount} evidence records`);
  return parts.join(", ");
}

function token(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "unknown";
}

export interface GraphViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function graphViewBox(layout: GraphLayout, viewport: PortalGraphViewport): GraphViewBox {
  const scale = clampScale(viewport.scale);
  const width = Math.max(1, Math.round(layout.width / scale));
  const height = Math.max(1, Math.round(layout.height / scale));
  return Object.freeze({
    x: clamp(Math.round(viewport.panX), 0, Math.max(0, layout.width - width)),
    y: clamp(Math.round(viewport.panY), 0, Math.max(0, layout.height - height)),
    width,
    height,
  });
}

export function graphViewBoxAttribute(layout: GraphLayout, viewport: PortalGraphViewport): string {
  const view = graphViewBox(layout, viewport);
  return `${view.x} ${view.y} ${view.width} ${view.height}`;
}

export function fitGraphViewport(): PortalGraphViewport {
  return Object.freeze({ scale: 1, panX: 0, panY: 0 });
}

export function zoomGraphViewport(
  layout: GraphLayout,
  viewport: PortalGraphViewport,
  direction: "in" | "out",
): PortalGraphViewport {
  const index = scaleIndex(viewport.scale);
  const next =
    GRAPH_SCALE_STEPS[
      direction === "in"
        ? Math.min(index + 1, GRAPH_SCALE_STEPS.length - 1)
        : Math.max(index - 1, 0)
    ] ?? 1;
  const view = graphViewBox(layout, viewport);
  return centered(layout, next, view.x + view.width / 2, view.y + view.height / 2);
}

export function focusGraphViewport(
  layout: GraphLayout,
  viewport: PortalGraphViewport,
  nodeId: string | undefined,
): PortalGraphViewport {
  const node = layout.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (node === undefined) return normalize(layout, viewport);
  return centered(layout, viewport.scale, node.x + node.width / 2, node.y + node.height / 2);
}

export function panGraphViewport(
  layout: GraphLayout,
  viewport: PortalGraphViewport,
  deltaX: number,
  deltaY: number,
): PortalGraphViewport {
  return normalize(layout, {
    scale: viewport.scale,
    panX: viewport.panX + deltaX,
    panY: viewport.panY + deltaY,
  });
}

function centered(
  layout: GraphLayout,
  scale: number,
  centerX: number,
  centerY: number,
): PortalGraphViewport {
  const clamped = clampScale(scale);
  const width = Math.max(1, Math.round(layout.width / clamped));
  const height = Math.max(1, Math.round(layout.height / clamped));
  return normalize(layout, {
    scale: clamped,
    panX: Math.round(centerX - width / 2),
    panY: Math.round(centerY - height / 2),
  });
}

function normalize(layout: GraphLayout, viewport: PortalGraphViewport): PortalGraphViewport {
  const view = graphViewBox(layout, viewport);
  return Object.freeze({ scale: clampScale(viewport.scale), panX: view.x, panY: view.y });
}

function scaleIndex(scale: number): number {
  let best = 0;
  for (const [index, step] of GRAPH_SCALE_STEPS.entries()) {
    const current = GRAPH_SCALE_STEPS[best] ?? 1;
    if (Math.abs(step - scale) < Math.abs(current - scale)) best = index;
  }
  return best;
}

function clampScale(scale: number): number {
  const lowest = GRAPH_SCALE_STEPS[0] ?? 1;
  const highest = GRAPH_SCALE_STEPS[GRAPH_SCALE_STEPS.length - 1] ?? 1;
  return Number.isFinite(scale) ? clamp(scale, lowest, highest) : 1;
}

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest);
}

export function graphDiagramView(input: GraphDiagramInput): HTMLElement {
  const layout = graphLayout(input.nodes, input.edges);
  const model = graphDiagramModel(layout, input.selectedNodeId);
  const viewport = normalize(layout, input.viewport);
  const frame = document.createElement("figure");
  frame.className = "diagram-frame";
  const canvas = renderCanvas(layout, model, viewport, input.actions);
  frame.append(renderToolbar(layout, model, viewport, input.actions), canvas);
  if (model.nodes.length === 0) {
    const empty = document.createElement("figcaption");
    empty.className = "empty-state";
    empty.textContent = "The selected graph revision has no loaded nodes.";
    frame.append(empty);
  }
  window.__senawaGraphDiagram = Object.freeze({
    nodeIds: Object.freeze(model.nodes.map(({ nodeId }) => nodeId)),
    rows: model.rows,
    viewBox: graphViewBoxAttribute(layout, viewport),
    scale: viewport.scale,
    selectedNodeId: model.selectedNodeId,
  });
  return frame;
}

function renderToolbar(
  layout: GraphLayout,
  model: GraphDiagramModel,
  viewport: PortalGraphViewport,
  actions: GraphDiagramActions,
): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "diagram-toolbar";
  toolbar.append(
    toolbarButton("Fit", () => actions.setViewport(fitGraphViewport())),
    toolbarButton("Zoom out", () =>
      actions.setViewport(zoomGraphViewport(layout, viewport, "out")),
    ),
    toolbarButton("Zoom in", () => actions.setViewport(zoomGraphViewport(layout, viewport, "in"))),
  );
  const focus = toolbarButton("Focus selected", () =>
    actions.setViewport(focusGraphViewport(layout, viewport, model.selectedNodeId)),
  );
  focus.disabled = model.selectedNodeId === undefined;
  toolbar.append(focus);
  const zoom = document.createElement("span");
  zoom.className = "diagram-zoom-level";
  zoom.textContent = `${Math.round(viewport.scale * 100)}%`;
  toolbar.append(zoom);
  return toolbar;
}

function toolbarButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "command";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderCanvas(
  layout: GraphLayout,
  model: GraphDiagramModel,
  viewport: PortalGraphViewport,
  actions: GraphDiagramActions,
): SVGSVGElement {
  const canvas = svgElement("svg", "diagram-canvas");
  canvas.setAttribute("viewBox", graphViewBoxAttribute(layout, viewport));
  canvas.setAttribute("preserveAspectRatio", "xMidYMin meet");
  canvas.setAttribute("role", "group");
  canvas.setAttribute("aria-label", "Workflow diagram");
  const edgeLayer = svgElement("g", "diagram-edge-layer");
  for (const edge of model.edges) {
    const line = svgElement("polyline", edge.className);
    line.setAttribute("points", edge.points);
    edgeLayer.append(line);
  }
  const nodeLayer = svgElement("g", "diagram-node-layer");
  const elements = new Map<string, SVGGElement>();
  for (const node of model.nodes) {
    const group = renderNode(node, model, elements, actions);
    elements.set(node.nodeId, group);
    nodeLayer.append(group);
  }
  canvas.append(edgeLayer, nodeLayer);
  attachPan(canvas, layout, viewport, actions);
  return canvas;
}

function renderNode(
  node: GraphDiagramNode,
  model: GraphDiagramModel,
  elements: ReadonlyMap<string, SVGGElement>,
  actions: GraphDiagramActions,
): SVGGElement {
  const group = svgElement("g", node.className);
  group.tabIndex = 0;
  group.setAttribute("role", "button");
  group.setAttribute("aria-label", node.ariaLabel);
  group.setAttribute("aria-pressed", String(node.nodeId === model.selectedNodeId));
  group.dataset.focusKey = node.nodeId;
  group.dataset.nodeId = node.nodeId;
  const shape = svgElement("rect", "diagram-node-shape");
  setNumbers(shape, { x: node.x, y: node.y, width: node.width, height: node.height, rx: 4 });
  group.append(shape);
  const label = svgElement("svg", "diagram-node-label");
  setNumbers(label, {
    x: node.labelX,
    y: node.labelY,
    width: node.labelWidth,
    height: node.labelHeight,
  });
  for (const [index, line] of node.lines.entries()) {
    const text = svgElement("text", `diagram-line diagram-line-${index}`);
    setNumbers(text, { x: 0, y: 16 + index * LINE_HEIGHT });
    text.textContent = line;
    label.append(text);
  }
  group.append(label);
  for (const badge of node.badges) {
    const text = svgElement("text", badge.className);
    setNumbers(text, { x: badge.x, y: badge.y });
    text.setAttribute("text-anchor", "end");
    text.textContent = badge.label;
    group.append(text);
  }
  group.addEventListener("click", () => actions.select(node.nodeId));
  group.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      actions.select(node.nodeId);
      return;
    }
    const next = traverse(model, node.nodeId, event.key);
    if (next === undefined) return;
    event.preventDefault();
    elements.get(next)?.focus();
  });
  return group;
}

/** Arrow traversal follows the deterministic row and column order of the layout. */
export function traverse(
  model: GraphDiagramModel,
  nodeId: string,
  key: string,
): string | undefined {
  const row = model.rows.findIndex((candidate) => candidate.includes(nodeId));
  if (row < 0) return undefined;
  const current = model.rows[row] ?? [];
  const column = current.indexOf(nodeId);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return current[column + (key === "ArrowRight" ? 1 : -1)];
  }
  if (key !== "ArrowDown" && key !== "ArrowUp") return undefined;
  const target = model.rows[row + (key === "ArrowDown" ? 1 : -1)];
  if (target === undefined || target.length === 0) return undefined;
  return target[Math.min(column, target.length - 1)];
}

function attachPan(
  canvas: SVGSVGElement,
  layout: GraphLayout,
  viewport: PortalGraphViewport,
  actions: GraphDiagramActions,
): void {
  let origin: { readonly pointerId: number; readonly x: number; readonly y: number } | undefined;
  let latest = viewport;
  canvas.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest(".diagram-node") !== null) return;
    origin = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (origin === undefined || origin.pointerId !== event.pointerId) return;
    const box = canvas.getBoundingClientRect();
    const view = graphViewBox(layout, viewport);
    const unitsPerPixel = Math.max(
      box.width === 0 ? 0 : view.width / box.width,
      box.height === 0 ? 0 : view.height / box.height,
    );
    latest = panGraphViewport(
      layout,
      viewport,
      Math.round((origin.x - event.clientX) * unitsPerPixel),
      Math.round((origin.y - event.clientY) * unitsPerPixel),
    );
    canvas.setAttribute("viewBox", graphViewBoxAttribute(layout, latest));
  });
  const settle = (event: PointerEvent) => {
    if (origin === undefined || origin.pointerId !== event.pointerId) return;
    origin = undefined;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (latest.panX !== viewport.panX || latest.panY !== viewport.panY) actions.setViewport(latest);
  };
  canvas.addEventListener("pointerup", settle);
  canvas.addEventListener("pointercancel", settle);
}

function svgElement<Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  className: string,
): SVGElementTagNameMap[Tag] {
  const value = document.createElementNS(SVG_NAMESPACE, tag);
  value.setAttribute("class", className);
  return value;
}

function setNumbers(element: SVGElement, values: Readonly<Record<string, number>>): void {
  for (const [name, value] of Object.entries(values)) element.setAttribute(name, String(value));
}
