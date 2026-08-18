import type {
  PortalGraphEdge,
  PortalGraphEdgeKind,
  PortalGraphNode,
  PortalGraphNodeKind,
  PortalGraphNodeRunState,
} from "@senawa/protocol";

export interface GraphLayoutPoint {
  readonly x: number;
  readonly y: number;
}

export interface GraphLayoutNode {
  readonly nodeId: string;
  readonly kind: PortalGraphNodeKind;
  readonly runState: PortalGraphNodeRunState;
  readonly title: string;
  readonly roleKey?: string;
  readonly humanNeedCount: number;
  readonly evidenceCount: number;
  readonly containerId?: string;
  readonly container: boolean;
  readonly row: number;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphLayoutEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: PortalGraphEdgeKind;
  readonly points: readonly GraphLayoutPoint[];
}

export interface GraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly GraphLayoutNode[];
  readonly edges: readonly GraphLayoutEdge[];
}

/** Height of the title band a phase box reserves above its members. */
export const GRAPH_CONTAINER_HEADER = 64;

const CANVAS_MARGIN = 24;
const OUTER_WIDTH = 260;
const OUTER_HEIGHT = 84;
const OUTER_COLUMN_GAP = 28;
const OUTER_ROW_GAP = 56;
const INNER_WIDTH = 216;
const INNER_HEIGHT = 76;
const INNER_COLUMN_GAP = 20;
const INNER_ROW_GAP = 32;
const CONTAINER_PADDING = 20;
const EDGE_ELBOW = 20;
const MAX_OWNER_DEPTH = 32;

interface Placement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PlacedSet {
  readonly positions: ReadonlyMap<string, Placement>;
  readonly width: number;
  readonly height: number;
}

interface Extent {
  readonly width: number;
  readonly height: number;
}

/**
 * Deterministic layered layout. The same records always produce the same
 * coordinates regardless of the order they arrive in.
 */
export function graphLayout(
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): GraphLayout {
  const nodeById = uniqueNodes(nodes);
  const edgeList = flowOriented(uniqueEdges(edges, nodeById));
  const containerById = containerAssignment(nodeById, ownerAssignment(nodeById, edgeList));
  const outer: string[] = [];
  const members = new Map<string, string[]>();
  for (const nodeId of nodeById.keys()) {
    const containerId = containerById.get(nodeId);
    if (containerId === undefined) {
      outer.push(nodeId);
      continue;
    }
    const existing = members.get(containerId);
    if (existing === undefined) members.set(containerId, [nodeId]);
    else existing.push(nodeId);
  }
  const memberSets = new Map<string, PlacedSet>();
  for (const [containerId, memberIds] of members) {
    memberSets.set(
      containerId,
      placeSet(memberIds, edgeList, innerExtent, INNER_COLUMN_GAP, INNER_ROW_GAP),
    );
  }
  const outerSet = placeSet(
    outer,
    edgeList,
    (nodeId) => outerExtent(memberSets.get(nodeId)),
    OUTER_COLUMN_GAP,
    OUTER_ROW_GAP,
  );
  const absolute = new Map<string, Placement>();
  for (const [nodeId, placement] of outerSet.positions) {
    absolute.set(nodeId, translate(placement, CANVAS_MARGIN, CANVAS_MARGIN));
  }
  for (const [containerId, placed] of memberSets) {
    const box = absolute.get(containerId);
    if (box === undefined) continue;
    const offsetX = box.x + Math.floor((box.width - placed.width) / 2);
    const offsetY = box.y + GRAPH_CONTAINER_HEADER;
    for (const [nodeId, placement] of placed.positions) {
      absolute.set(nodeId, translate(placement, offsetX, offsetY));
    }
  }
  return Object.freeze({
    width: outerSet.width + CANVAS_MARGIN * 2,
    height: outerSet.height + CANVAS_MARGIN * 2,
    nodes: layoutNodes(nodeById, containerById, memberSets, absolute),
    edges: layoutEdges(edgeList, containerById, absolute),
  });
}

/**
 * Orders nodes so prerequisites precede the nodes that depend on them.
 *
 * The diagram gets this ordering from layering. The table and tree render a
 * plain list, so without this they show whatever order the authority paged the
 * nodes in, which is digest order and unrelated to how the workflow runs.
 */
export function executionOrdered(
  nodes: readonly PortalGraphNode[],
  edges: readonly PortalGraphEdge[],
): readonly PortalGraphNode[] {
  const present = new Set(nodes.map(({ nodeId }) => nodeId));
  const ranks = longestPathRanks(
    nodes.map(({ nodeId }) => nodeId),
    flowOriented(
      edges.filter(
        (edge) =>
          edge.kind === "dependency" && present.has(edge.fromNodeId) && present.has(edge.toNodeId),
      ),
    ),
  );
  return Object.freeze(
    nodes
      .map((node, index) => ({ node, index }))
      .sort(
        (left, right) =>
          (ranks.get(left.node.nodeId) ?? 0) - (ranks.get(right.node.nodeId) ?? 0) ||
          left.index - right.index,
      )
      .map(({ node }) => node),
  );
}

/**
 * Orients edges so that "from" always precedes "to" in execution order.
 *
 * A `dependency` edge records that its source depends on its target, so it
 * points from the later node to the earlier one. Layering reads every edge as
 * "from precedes to", which is right for containment and backwards here, and
 * left unswapped it renders the workflow in reverse.
 */
function flowOriented(edges: readonly PortalGraphEdge[]): readonly PortalGraphEdge[] {
  return Object.freeze(
    edges.map((edge) =>
      edge.kind === "dependency"
        ? Object.freeze({ ...edge, fromNodeId: edge.toNodeId, toNodeId: edge.fromNodeId })
        : edge,
    ),
  );
}

function layoutNodes(
  nodeById: ReadonlyMap<string, PortalGraphNode>,
  containerById: ReadonlyMap<string, string>,
  memberSets: ReadonlyMap<string, PlacedSet>,
  absolute: ReadonlyMap<string, Placement>,
): readonly GraphLayoutNode[] {
  const tops = [...new Set([...absolute.values()].map(({ y }) => y))].sort(
    (left, right) => left - right,
  );
  const rowByTop = new Map(tops.map((top, index) => [top, index] as const));
  const ordered = [...absolute]
    .map(([nodeId, placement]) => ({ nodeId, placement, row: rowByTop.get(placement.y) ?? 0 }))
    .sort(
      (left, right) =>
        left.row - right.row ||
        left.placement.x - right.placement.x ||
        compareIdentity(left.nodeId, right.nodeId),
    );
  let column = 0;
  let previousRow = -1;
  const result: GraphLayoutNode[] = [];
  for (const entry of ordered) {
    const node = nodeById.get(entry.nodeId);
    if (node === undefined) continue;
    column = entry.row === previousRow ? column + 1 : 0;
    previousRow = entry.row;
    const containerId = containerById.get(entry.nodeId);
    result.push(
      Object.freeze({
        nodeId: entry.nodeId,
        kind: node.kind,
        runState: node.runState,
        title: node.title,
        ...(node.roleKey === undefined ? {} : { roleKey: node.roleKey }),
        humanNeedCount: node.humanNeedCount,
        evidenceCount: node.evidenceCount,
        ...(containerId === undefined ? {} : { containerId }),
        container: memberSets.has(entry.nodeId),
        row: entry.row,
        column,
        x: entry.placement.x,
        y: entry.placement.y,
        width: entry.placement.width,
        height: entry.placement.height,
      }),
    );
  }
  return Object.freeze(result);
}

function layoutEdges(
  edges: readonly PortalGraphEdge[],
  containerById: ReadonlyMap<string, string>,
  absolute: ReadonlyMap<string, Placement>,
): readonly GraphLayoutEdge[] {
  const result: GraphLayoutEdge[] = [];
  for (const edge of edges) {
    const from = absolute.get(edge.fromNodeId);
    const to = absolute.get(edge.toNodeId);
    if (from === undefined || to === undefined) continue;
    // A phase box already draws its own containment, so only containment edges
    // are dropped across boxes. Dependencies between phases must stay visible.
    if (
      edge.kind === "containment" &&
      containerById.get(edge.fromNodeId) !== containerById.get(edge.toNodeId)
    )
      continue;
    result.push(
      Object.freeze({
        edgeId: edge.edgeId,
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: edge.kind,
        points: orthogonalPoints(from, to),
      }),
    );
  }
  return Object.freeze(result);
}

function orthogonalPoints(from: Placement, to: Placement): readonly GraphLayoutPoint[] {
  const startX = from.x + Math.floor(from.width / 2);
  const startY = from.y + from.height;
  const endX = to.x + Math.floor(to.width / 2);
  const endY = to.y;
  if (endY > startY && startX === endX) {
    return Object.freeze([point(startX, startY), point(endX, endY)]);
  }
  const middleY = endY > startY ? startY + Math.floor((endY - startY) / 2) : startY + EDGE_ELBOW;
  return Object.freeze([
    point(startX, startY),
    point(startX, middleY),
    point(endX, middleY),
    point(endX, endY),
  ]);
}

function point(x: number, y: number): GraphLayoutPoint {
  return Object.freeze({ x, y });
}

function placeSet(
  nodeIds: readonly string[],
  edges: readonly PortalGraphEdge[],
  extent: (nodeId: string) => Extent,
  columnGap: number,
  rowGap: number,
): PlacedSet {
  const present = new Set(nodeIds);
  const ranked = longestPathRanks(
    nodeIds,
    edges.filter(
      (edge) =>
        edge.kind !== "supersession" && present.has(edge.fromNodeId) && present.has(edge.toNodeId),
    ),
  );
  const rows = new Map<number, string[]>();
  for (const nodeId of nodeIds) {
    const rank = ranked.get(nodeId) ?? 0;
    const existing = rows.get(rank);
    if (existing === undefined) rows.set(rank, [nodeId]);
    else existing.push(nodeId);
  }
  const rankOrder = [...rows.keys()].sort((left, right) => left - right);
  const widths = rankOrder.map((rank) => rowWidth(rows.get(rank) ?? [], extent, columnGap));
  const totalWidth = widths.reduce((largest, value) => Math.max(largest, value), 0);
  const positions = new Map<string, Placement>();
  let cursorY = 0;
  for (const [index, rank] of rankOrder.entries()) {
    const row = rows.get(rank) ?? [];
    let cursorX = Math.floor((totalWidth - (widths[index] ?? 0)) / 2);
    let rowHeight = 0;
    for (const nodeId of row) {
      const { width, height } = extent(nodeId);
      positions.set(nodeId, Object.freeze({ x: cursorX, y: cursorY, width, height }));
      cursorX += width + columnGap;
      rowHeight = Math.max(rowHeight, height);
    }
    cursorY += rowHeight + (index === rankOrder.length - 1 ? 0 : rowGap);
  }
  return { positions, width: totalWidth, height: cursorY };
}

function rowWidth(
  row: readonly string[],
  extent: (nodeId: string) => Extent,
  columnGap: number,
): number {
  if (row.length === 0) return 0;
  return (
    row.reduce((total, nodeId) => total + extent(nodeId).width, 0) + columnGap * (row.length - 1)
  );
}

/**
 * Rank each node by the longest path from any root over containment and
 * dependency edges. Nodes inside a cycle rank below their resolved
 * predecessors so a hostile graph still produces a bounded arrangement.
 */
function longestPathRanks(
  nodeIds: readonly string[],
  edges: readonly PortalGraphEdge[],
): ReadonlyMap<string, number> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const nodeId of nodeIds) {
    outgoing.set(nodeId, []);
    incoming.set(nodeId, []);
    remaining.set(nodeId, 0);
  }
  const seen = new Set<string>();
  for (const edge of edges) {
    const pair = `${edge.fromNodeId}\u0000${edge.toNodeId}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
    incoming.get(edge.toNodeId)?.push(edge.fromNodeId);
    remaining.set(edge.toNodeId, (remaining.get(edge.toNodeId) ?? 0) + 1);
  }
  for (const targets of outgoing.values()) targets.sort(compareIdentity);
  const ranks = new Map<string, number>();
  const ready: string[] = [];
  for (const nodeId of nodeIds) {
    if (remaining.get(nodeId) !== 0) continue;
    ranks.set(nodeId, 0);
    ready.push(nodeId);
  }
  const resolved = new Set<string>();
  while (ready.length > 0) {
    ready.sort(compareIdentity);
    const nodeId = ready.shift();
    if (nodeId === undefined) break;
    resolved.add(nodeId);
    const rank = ranks.get(nodeId) ?? 0;
    for (const target of outgoing.get(nodeId) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, rank + 1));
      const pending = (remaining.get(target) ?? 0) - 1;
      remaining.set(target, pending);
      if (pending === 0) ready.push(target);
    }
  }
  for (const nodeId of nodeIds) {
    if (resolved.has(nodeId)) continue;
    const settled = (incoming.get(nodeId) ?? [])
      .filter((source) => resolved.has(source))
      .map((source) => (ranks.get(source) ?? 0) + 1);
    ranks.set(
      nodeId,
      settled.reduce((largest, value) => Math.max(largest, value), 0),
    );
  }
  return ranks;
}

function uniqueNodes(nodes: readonly PortalGraphNode[]): ReadonlyMap<string, PortalGraphNode> {
  const byId = new Map<string, PortalGraphNode>();
  for (const node of [...nodes].sort((left, right) => compareIdentity(left.nodeId, right.nodeId))) {
    if (!byId.has(node.nodeId)) byId.set(node.nodeId, node);
  }
  return byId;
}

function uniqueEdges(
  edges: readonly PortalGraphEdge[],
  nodeById: ReadonlyMap<string, PortalGraphNode>,
): readonly PortalGraphEdge[] {
  const byId = new Map<string, PortalGraphEdge>();
  for (const edge of [...edges].sort((left, right) => compareIdentity(left.edgeId, right.edgeId))) {
    if (edge.fromNodeId === edge.toNodeId) continue;
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) continue;
    if (!byId.has(edge.edgeId)) byId.set(edge.edgeId, edge);
  }
  return [...byId.values()];
}

function ownerAssignment(
  nodeById: ReadonlyMap<string, PortalGraphNode>,
  edges: readonly PortalGraphEdge[],
): ReadonlyMap<string, string> {
  const owner = new Map<string, string>();
  for (const edge of edges) {
    if (edge.kind !== "containment" || owner.has(edge.toNodeId)) continue;
    owner.set(edge.toNodeId, edge.fromNodeId);
  }
  for (const [nodeId, node] of nodeById) {
    const parent = node.parentNodeId;
    if (parent === undefined || parent === nodeId || !nodeById.has(parent)) continue;
    if (!owner.has(nodeId)) owner.set(nodeId, parent);
  }
  return owner;
}

/** Every node is drawn inside its outermost ancestor phase, if it has one. */
function containerAssignment(
  nodeById: ReadonlyMap<string, PortalGraphNode>,
  owner: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const container = new Map<string, string>();
  for (const nodeId of nodeById.keys()) {
    const visited = new Set<string>([nodeId]);
    let current = owner.get(nodeId);
    let outermost: string | undefined;
    let depth = 0;
    while (current !== undefined && depth < MAX_OWNER_DEPTH && !visited.has(current)) {
      if (nodeById.get(current)?.kind === "phase") outermost = current;
      visited.add(current);
      current = owner.get(current);
      depth += 1;
    }
    if (outermost !== undefined) container.set(nodeId, outermost);
  }
  return container;
}

function innerExtent(): Extent {
  return { width: INNER_WIDTH, height: INNER_HEIGHT };
}

function outerExtent(members: PlacedSet | undefined): Extent {
  if (members === undefined) return { width: OUTER_WIDTH, height: OUTER_HEIGHT };
  return {
    width: Math.max(OUTER_WIDTH, members.width + CONTAINER_PADDING * 2),
    height: GRAPH_CONTAINER_HEADER + members.height + CONTAINER_PADDING,
  };
}

function translate(placement: Placement, offsetX: number, offsetY: number): Placement {
  return Object.freeze({
    x: placement.x + offsetX,
    y: placement.y + offsetY,
    width: placement.width,
    height: placement.height,
  });
}

function compareIdentity(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
