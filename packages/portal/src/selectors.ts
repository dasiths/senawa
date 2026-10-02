import type { PortalRunOverview, PortalSyncVector } from "@senawa/protocol";
import { type PortalState, runKey } from "./state.js";

export function selectedOverview(state: PortalState): PortalRunOverview | undefined {
  if (state.selectedRepositoryId === undefined || state.selectedRunId === undefined)
    return undefined;
  return state.caches.overviews[runKey(state.selectedRepositoryId, state.selectedRunId)];
}

/**
 * Compares every component the bounded assembly window depends on.
 * `transcriptRevision` is deliberately excluded: agent output advances while a
 * run writes, and including it would make an actively writing run permanently
 * stale. `transcriptRevisionsEqual` covers that component on its own.
 */
export function vectorsEqual(left: PortalSyncVector, right: PortalSyncVector): boolean {
  return (
    left.workflowCursor === right.workflowCursor &&
    left.contextRevision === right.contextRevision &&
    left.runnerRevision === right.runnerRevision &&
    left.workspaceRevision === right.workspaceRevision &&
    left.humanRevision === right.humanRevision &&
    left.portalRevision === right.portalRevision &&
    left.graphRevision === right.graphRevision &&
    left.lifecycleRevision === right.lifecycleRevision
  );
}

export function transcriptRevisionsEqual(left: PortalSyncVector, right: PortalSyncVector): boolean {
  return left.transcriptRevision === right.transcriptRevision;
}

export function actionsLocked(state: PortalState): boolean {
  return (
    state.session.status !== "read-write" ||
    state.connection.status !== "live" ||
    state.vector === undefined ||
    state.freshness[state.route.name]?.status !== "fresh"
  );
}

export function hasCapability(state: PortalState, capability: string): boolean {
  return state.session.capabilities.includes(capability);
}

export function globalStatus(state: PortalState): string {
  const pending = Object.keys(state.pending).length;
  const needs = state.humanNeeds.length;
  const freshness = currentFreshness(state);
  return `${state.connection.status}; ${freshness}; ${pending} pending; ${needs} human needs`;
}

export function currentFreshness(state: PortalState): "current" | "loading" | "stale" {
  const statuses = Object.values(state.freshness).map(({ status }) => status);
  if (statuses.some((status) => status === "stale" || status === "failed")) return "stale";
  if (state.freshness[state.route.name]?.status !== "fresh") return "loading";
  return "current";
}
