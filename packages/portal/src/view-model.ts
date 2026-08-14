import type { PortalGraphNode } from "@senawa/protocol";
import { actionsLocked, globalStatus, hasCapability, selectedOverview } from "./selectors.js";
import type { PortalState } from "./state.js";

export interface PortalViewModel {
  readonly status: string;
  readonly mutationLocked: boolean;
  readonly runControlVisible: boolean;
  readonly runMode: string;
  readonly graphRows: readonly PortalGraphNode[];
}

export function portalViewModel(state: PortalState): PortalViewModel {
  const overview = selectedOverview(state);
  const graphRows = Object.values(state.caches.graphNodes)
    .flatMap(({ nodes }) => nodes)
    .filter((node) => graphSearchText(node).includes(state.ui.filter.toLocaleLowerCase()))
    .slice(0, 200);
  return Object.freeze({
    status: globalStatus(state),
    mutationLocked: actionsLocked(state),
    runControlVisible: hasCapability(state, "portal-write-run-control") && overview !== undefined,
    runMode: overview?.mode ?? "unavailable",
    graphRows: Object.freeze(graphRows),
  });
}

function graphSearchText(node: PortalGraphNode): string {
  return `${node.kind} ${node.title} ${node.lifecycle} ${node.nodeId}`.toLocaleLowerCase();
}
