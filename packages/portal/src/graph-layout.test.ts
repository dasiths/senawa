import type { PortalGraphEdge, PortalGraphNode, PortalGraphNodeRunState } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { type GraphLayout, graphLayout } from "./graph-layout.js";

describe("deterministic graph layout", () => {
  it("stacks a linear dependency chain in one column", () => {
    const layout = graphLayout(
      [task("node_a"), task("node_b"), task("node_c")],
      [dependency("edge_1", "node_a", "node_b"), dependency("edge_2", "node_b", "node_c")],
    );
    expect(boxes(layout)).toEqual([
      "node_a 24,24 260x84 r0c0",
      "node_b 24,164 260x84 r1c0",
      "node_c 24,304 260x84 r2c0",
    ]);
    expect(layout.width).toBe(308);
    expect(layout.height).toBe(412);
    expect(polylines(layout)).toEqual([
      "edge_1 dependency 154,108 154,164",
      "edge_2 dependency 154,248 154,304",
    ]);
  });

  it("centers every rank of a diamond and routes orthogonal elbows", () => {
    const layout = graphLayout(
      [task("node_a"), task("node_b"), task("node_c"), task("node_d")],
      [
        dependency("edge_1", "node_a", "node_b"),
        dependency("edge_2", "node_a", "node_c"),
        dependency("edge_3", "node_b", "node_d"),
        dependency("edge_4", "node_c", "node_d"),
      ],
    );
    expect(boxes(layout)).toEqual([
      "node_a 168,24 260x84 r0c0",
      "node_b 24,164 260x84 r1c0",
      "node_c 312,164 260x84 r1c1",
      "node_d 168,304 260x84 r2c0",
    ]);
    expect(layout.width).toBe(596);
    expect(polylines(layout)).toEqual([
      "edge_1 dependency 298,108 298,136 154,136 154,164",
      "edge_2 dependency 298,108 298,136 442,136 442,164",
      "edge_3 dependency 154,248 154,276 298,276 298,304",
      "edge_4 dependency 442,248 442,276 298,276 298,304",
    ]);
  });

  it("grows a phase box around three contained tasks", () => {
    const layout = graphLayout(
      [phase("node_phase"), task("node_t1"), task("node_t2"), task("node_t3")],
      [
        containment("edge_1", "node_phase", "node_t1"),
        containment("edge_2", "node_phase", "node_t2"),
        containment("edge_3", "node_phase", "node_t3"),
      ],
    );
    expect(boxes(layout)).toEqual([
      "node_phase 24,24 728x160 r0c0",
      "node_t1 44,88 216x76 r1c0",
      "node_t2 280,88 216x76 r1c1",
      "node_t3 516,88 216x76 r1c2",
    ]);
    expect(layout.width).toBe(776);
    expect(layout.height).toBe(208);
    expect(layout.nodes.map(({ container }) => container)).toEqual([true, false, false, false]);
    expect(layout.nodes.map(({ containerId }) => containerId)).toEqual([
      undefined,
      "node_phase",
      "node_phase",
      "node_phase",
    ]);
    expect(polylines(layout)).toEqual([]);
  });

  it("ranks contained tasks by their own dependency", () => {
    const layout = graphLayout(
      [phase("node_phase"), task("node_t1"), task("node_t2")],
      [
        containment("edge_1", "node_phase", "node_t1"),
        containment("edge_2", "node_phase", "node_t2"),
        dependency("edge_3", "node_t1", "node_t2"),
      ],
    );
    expect(boxes(layout)).toEqual([
      "node_phase 24,24 260x268 r0c0",
      "node_t1 46,88 216x76 r1c0",
      "node_t2 46,196 216x76 r2c0",
    ]);
    expect(polylines(layout)).toEqual(["edge_3 dependency 154,164 154,196"]);
  });

  it("keeps a superseded node on its rank and draws the supersession elbow", () => {
    const layout = graphLayout(
      [task("node_a", "superseded"), task("node_b", "running")],
      [supersession("edge_1", "node_a", "node_b")],
    );
    expect(boxes(layout)).toEqual(["node_a 24,24 260x84 r0c0", "node_b 312,24 260x84 r0c1"]);
    expect(layout.nodes.map(({ runState }) => runState)).toEqual(["superseded", "running"]);
    expect(polylines(layout)).toEqual(["edge_1 supersession 154,108 154,128 442,128 442,24"]);
  });

  it("renders a dependency whose endpoints live in different phases", () => {
    const layout = graphLayout(
      [phase("node_p1"), phase("node_p2"), task("node_t1"), task("node_t2")],
      [
        containment("edge_1", "node_p1", "node_t1"),
        containment("edge_2", "node_p2", "node_t2"),
        dependency("edge_3", "node_p1", "node_p2"),
        dependency("edge_4", "node_t1", "node_t2"),
      ],
    );
    expect(boxes(layout)).toEqual([
      "node_p1 24,24 260x160 r0c0",
      "node_t1 46,88 216x76 r1c0",
      "node_p2 24,240 260x160 r2c0",
      "node_t2 46,304 216x76 r3c0",
    ]);
    expect(polylines(layout)).toEqual([
      "edge_3 dependency 154,184 154,240",
      "edge_4 dependency 154,164 154,304",
    ]);
  });

  it("produces identical output for shuffled input and never mutates it", () => {
    const nodes = [
      phase("node_phase"),
      task("node_t1"),
      task("node_t2"),
      task("node_t3", "running"),
      task("node_free"),
    ];
    const edges = [
      containment("edge_1", "node_phase", "node_t1"),
      containment("edge_2", "node_phase", "node_t2"),
      containment("edge_3", "node_phase", "node_t3"),
      dependency("edge_4", "node_t1", "node_t2"),
      dependency("edge_5", "node_phase", "node_free"),
    ];
    const originalNodes = JSON.stringify(nodes);
    const originalEdges = JSON.stringify(edges);
    const expected = JSON.stringify(graphLayout(nodes, edges));
    for (const rotation of [1, 2, 3, 4]) {
      expect(JSON.stringify(graphLayout(rotate(nodes, rotation), rotate(edges, rotation)))).toBe(
        expected,
      );
    }
    expect(JSON.stringify(nodes)).toBe(originalNodes);
    expect(JSON.stringify(edges)).toBe(originalEdges);
  });

  it("bounds a cyclic dependency instead of looping", () => {
    const layout = graphLayout(
      [task("node_a"), task("node_b")],
      [dependency("edge_1", "node_a", "node_b"), dependency("edge_2", "node_b", "node_a")],
    );
    expect(layout.nodes.map(({ nodeId, row }) => `${nodeId} r${row}`)).toEqual([
      "node_a r0",
      "node_b r0",
    ]);
  });

  it("returns an empty canvas for an empty page", () => {
    const layout = graphLayout([], []);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect([layout.width, layout.height]).toEqual([48, 48]);
  });
});

function boxes(layout: GraphLayout): readonly string[] {
  return layout.nodes.map(
    (node) =>
      `${node.nodeId} ${node.x},${node.y} ${node.width}x${node.height} r${node.row}c${node.column}`,
  );
}

function polylines(layout: GraphLayout): readonly string[] {
  return layout.edges.map(
    (edge) => `${edge.edgeId} ${edge.kind} ${edge.points.map(({ x, y }) => `${x},${y}`).join(" ")}`,
  );
}

function rotate<Value>(values: readonly Value[], offset: number): readonly Value[] {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function task(nodeId: string, runState: PortalGraphNodeRunState = "not-started"): PortalGraphNode {
  return {
    nodeId,
    kind: "task",
    title: `Title ${nodeId}`,
    definitionGeneration: 1,
    lifecycle: "defined",
    runState,
    humanNeedCount: 0,
    evidenceCount: 0,
  };
}

function phase(nodeId: string): PortalGraphNode {
  return {
    nodeId,
    kind: "phase",
    title: `Phase ${nodeId}`,
    definitionGeneration: 1,
    lifecycle: "defined",
    runState: "not-started",
    humanNeedCount: 0,
    evidenceCount: 0,
  };
}

function containment(edgeId: string, fromNodeId: string, toNodeId: string): PortalGraphEdge {
  return { edgeId, fromNodeId, toNodeId, kind: "containment" };
}

/**
 * Builds a dependency edge the way the kernel does: from the dependent node to
 * the prerequisite it waits on. Callers name the pair in execution order.
 */
function dependency(edgeId: string, earlier: string, later: string): PortalGraphEdge {
  return { edgeId, fromNodeId: later, toNodeId: earlier, kind: "dependency" };
}

function supersession(edgeId: string, fromNodeId: string, toNodeId: string): PortalGraphEdge {
  return { edgeId, fromNodeId, toNodeId, kind: "supersession" };
}
