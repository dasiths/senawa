import type { PortalGraphEdge, PortalGraphNode, PortalGraphNodeRunState } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import {
  fitGraphViewport,
  focusGraphViewport,
  graphDiagramModel,
  graphViewBoxAttribute,
  panGraphViewport,
  traverse,
  zoomGraphViewport,
} from "./graph-diagram.js";
import { graphLayout } from "./graph-layout.js";

const HOSTILE_TITLE =
  "<img src=x onerror=alert(1)></svg><script>alert(2)</script>\u2028\"onclick='x'";

describe("graph diagram model", () => {
  it("derives classes, lines, badges, and an accessible name per node", () => {
    const model = graphDiagramModel(
      graphLayout(
        [
          phase("node_phase"),
          {
            ...task("node_task", "running"),
            roleKey: "implementer",
            humanNeedCount: 2,
            evidenceCount: 3,
          },
        ],
        [containment("edge_1", "node_phase", "node_task")],
      ),
      "node_task",
    );
    const [container, leaf] = model.nodes;
    expect(container?.className).toBe(
      "diagram-node diagram-kind-phase diagram-state-not-started diagram-container",
    );
    expect(container?.lines).toEqual(["Phase node_phase", "Not started"]);
    expect(container?.badges).toEqual([]);
    expect(leaf?.className).toBe(
      "diagram-node diagram-kind-task diagram-state-running diagram-selected",
    );
    expect(leaf?.lines).toEqual(["Title node_task", "Role implementer", "Running"]);
    expect(leaf?.badges.map(({ className, label }) => `${className} ${label}`)).toEqual([
      "diagram-badge diagram-badge-needs Needs 2",
      "diagram-badge diagram-badge-evidence Evidence 3",
    ]);
    expect(leaf?.ariaLabel).toBe(
      "task Title node_task, Running, role implementer, 2 human needs, 3 evidence records",
    );
    expect(model.selectedNodeId).toBe("node_task");
    expect(model.rows).toEqual([["node_phase"], ["node_task"]]);
  });

  it("ignores a selection that is absent from the revision", () => {
    const model = graphDiagramModel(graphLayout([task("node_a")], []), "node_missing");
    expect(model.selectedNodeId).toBeUndefined();
    expect(model.nodes[0]?.className).not.toContain("diagram-selected");
  });

  it("keeps hostile node text inert and out of every class name", () => {
    const hostile: PortalGraphNode = {
      ...task("node_hostile"),
      title: HOSTILE_TITLE,
      roleKey: '"><script>alert(3)</script>',
      runState: "</svg><script>alert(4)</script>" as PortalGraphNodeRunState,
      humanNeedCount: 1,
    };
    const model = graphDiagramModel(graphLayout([hostile], []), undefined);
    const node = model.nodes[0];
    expect(node?.lines).toEqual([HOSTILE_TITLE, 'Role "><script>alert(3)</script>', "Unknown"]);
    expect(node?.className).toBe("diagram-node diagram-kind-task diagram-state-unknown");
    expect(node?.className).toMatch(/^[a-z0-9 -]+$/u);
    for (const badge of node?.badges ?? []) expect(badge.className).toMatch(/^[a-z0-9 -]+$/u);
    expect(node?.ariaLabel).toBe(
      `task ${HOSTILE_TITLE}, Unknown, role "><script>alert(3)</script>, 1 human needs`,
    );
    expect(JSON.stringify(model.edges)).not.toContain("script");
    const payloads = ["<img", "</svg>", "<script>"];
    for (const payload of payloads) {
      const fields = Object.entries(node ?? {}).filter(([, value]) =>
        JSON.stringify(value).includes(payload),
      );
      expect(fields.map(([name]) => name).sort()).toEqual(["ariaLabel", "lines"]);
    }
  });

  it("maps hostile edge kinds onto an allowlisted class", () => {
    const model = graphDiagramModel(
      graphLayout(
        [task("node_a"), task("node_b")],
        [
          {
            edgeId: "edge_1",
            fromNodeId: "node_a",
            toNodeId: "node_b",
            kind: "<script>" as PortalGraphEdge["kind"],
          },
        ],
      ),
      undefined,
    );
    expect(model.edges.map(({ className }) => className)).toEqual([
      "diagram-edge diagram-edge-unknown",
    ]);
  });
});

describe("graph diagram traversal", () => {
  const model = graphDiagramModel(
    graphLayout(
      [task("node_a"), task("node_b"), task("node_c"), task("node_d")],
      [
        dependency("edge_1", "node_a", "node_b"),
        dependency("edge_2", "node_a", "node_c"),
        dependency("edge_3", "node_b", "node_d"),
        dependency("edge_4", "node_c", "node_d"),
      ],
    ),
    undefined,
  );

  it("orders rows and columns deterministically", () => {
    expect(model.rows).toEqual([["node_a"], ["node_b", "node_c"], ["node_d"]]);
  });

  it("moves within a rank and across ranks", () => {
    expect(traverse(model, "node_b", "ArrowRight")).toBe("node_c");
    expect(traverse(model, "node_c", "ArrowLeft")).toBe("node_b");
    expect(traverse(model, "node_c", "ArrowRight")).toBeUndefined();
    expect(traverse(model, "node_a", "ArrowDown")).toBe("node_b");
    expect(traverse(model, "node_c", "ArrowUp")).toBe("node_a");
    expect(traverse(model, "node_c", "ArrowDown")).toBe("node_d");
    expect(traverse(model, "node_a", "ArrowUp")).toBeUndefined();
    expect(traverse(model, "node_a", "Escape")).toBeUndefined();
    expect(traverse(model, "node_absent", "ArrowDown")).toBeUndefined();
  });
});

describe("graph diagram viewport", () => {
  const layout = graphLayout(
    [task("node_a"), task("node_b"), task("node_c")],
    [dependency("edge_1", "node_a", "node_b"), dependency("edge_2", "node_b", "node_c")],
  );

  it("fits the whole revision by default", () => {
    expect(fitGraphViewport()).toEqual({ scale: 1, panX: 0, panY: 0 });
    expect(graphViewBoxAttribute(layout, fitGraphViewport())).toBe("0 0 308 412");
  });

  it("zooms around the current center and clamps to the canvas", () => {
    const zoomedIn = zoomGraphViewport(layout, fitGraphViewport(), "in");
    expect(zoomedIn).toEqual({ scale: 1.5, panX: 52, panY: 69 });
    expect(graphViewBoxAttribute(layout, zoomedIn)).toBe("52 69 205 275");
    const zoomedOut = zoomGraphViewport(layout, fitGraphViewport(), "out");
    expect(zoomedOut).toEqual({ scale: 0.75, panX: 0, panY: 0 });
    expect(graphViewBoxAttribute(layout, zoomedOut)).toBe("0 0 411 549");
  });

  it("stops at the zoom ladder ends", () => {
    let widest = fitGraphViewport();
    for (let step = 0; step < 6; step += 1) widest = zoomGraphViewport(layout, widest, "out");
    expect(widest.scale).toBe(0.5);
    let closest = fitGraphViewport();
    for (let step = 0; step < 6; step += 1) closest = zoomGraphViewport(layout, closest, "in");
    expect(closest.scale).toBe(3);
  });

  it("centers the selected node and clamps at the canvas edge", () => {
    expect(focusGraphViewport(layout, { scale: 2, panX: 0, panY: 0 }, "node_c")).toEqual({
      scale: 2,
      panX: 77,
      panY: 206,
    });
    expect(focusGraphViewport(layout, { scale: 2, panX: 5, panY: 7 }, "node_absent")).toEqual({
      scale: 2,
      panX: 5,
      panY: 7,
    });
  });

  it("pans within the canvas and refuses to leave it", () => {
    expect(panGraphViewport(layout, { scale: 2, panX: 0, panY: 0 }, 50, 30)).toEqual({
      scale: 2,
      panX: 50,
      panY: 30,
    });
    expect(panGraphViewport(layout, { scale: 2, panX: 0, panY: 0 }, -50, 9_000)).toEqual({
      scale: 2,
      panX: 0,
      panY: 206,
    });
    expect(panGraphViewport(layout, fitGraphViewport(), 400, 400)).toEqual({
      scale: 1,
      panX: 0,
      panY: 0,
    });
  });

  it("recovers from a non-finite scale", () => {
    expect(graphViewBoxAttribute(layout, { scale: Number.NaN, panX: 0, panY: 0 })).toBe(
      "0 0 308 412",
    );
  });
});

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
