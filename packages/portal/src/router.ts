export const PORTAL_ROUTES = Object.freeze(["workflow", "agents", "timeline"] as const);

export type PortalRouteName = (typeof PORTAL_ROUTES)[number];

export interface PortalRoute {
  readonly name: PortalRouteName;
  readonly repositoryId?: string;
  readonly runId?: string;
  /** The node the detail view is scoped to, so a phase view can be linked. */
  readonly focus?: string;
}

const IDENTITY = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function parsePortalHash(hash: string): PortalRoute {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = normalized.split("/").filter(Boolean);
  if ((segments.length === 4 || segments.length === 5) && segments[0] === "runs") {
    const repositoryId = decodeIdentity(segments[1]);
    const runId = decodeIdentity(segments[2]);
    const name = segments[3];
    if (repositoryId !== undefined && runId !== undefined && isRouteName(name)) {
      const focus = segments.length === 5 ? decodeIdentity(segments[4]) : undefined;
      // A fifth segment that is not an identity is a link somebody mangled, not
      // a reason to refuse the run it names.
      return Object.freeze({
        name,
        repositoryId,
        runId,
        ...(focus === undefined ? {} : { focus }),
      });
    }
  }
  // The workflow and the working agent are what a reader opens the portal for.
  // Counters and digests are one action away rather than the first thing shown.
  return Object.freeze({ name: "workflow" });
}

export function portalHash(
  repositoryId: string,
  runId: string,
  name: PortalRouteName,
  focus?: string,
): string {
  if (!IDENTITY.test(repositoryId) || !IDENTITY.test(runId))
    throw new TypeError("Invalid route identity");
  const base = `#/runs/${encodeURIComponent(repositoryId)}/${encodeURIComponent(runId)}/${name}`;
  return focus === undefined || !IDENTITY.test(focus)
    ? base
    : `${base}/${encodeURIComponent(focus)}`;
}

function decodeIdentity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return IDENTITY.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isRouteName(value: string | undefined): value is PortalRouteName {
  return PORTAL_ROUTES.some((candidate) => candidate === value);
}
