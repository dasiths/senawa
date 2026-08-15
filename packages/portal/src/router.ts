export const PORTAL_ROUTES = Object.freeze([
  "overview",
  "graph",
  "delivery",
  "activity",
  "artifacts",
  "needs",
  "amendments",
  "workspaces",
] as const);

export type PortalRouteName = (typeof PORTAL_ROUTES)[number];

export interface PortalRoute {
  readonly name: PortalRouteName;
  readonly repositoryId?: string;
  readonly runId?: string;
}

const IDENTITY = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export function parsePortalHash(hash: string): PortalRoute {
  const normalized = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 4 && segments[0] === "runs") {
    const repositoryId = decodeIdentity(segments[1]);
    const runId = decodeIdentity(segments[2]);
    const name = segments[3];
    if (repositoryId !== undefined && runId !== undefined && isRouteName(name)) {
      return Object.freeze({ name, repositoryId, runId });
    }
  }
  return Object.freeze({ name: "overview" });
}

export function portalHash(repositoryId: string, runId: string, name: PortalRouteName): string {
  if (!IDENTITY.test(repositoryId) || !IDENTITY.test(runId))
    throw new TypeError("Invalid route identity");
  return `#/runs/${encodeURIComponent(repositoryId)}/${encodeURIComponent(runId)}/${name}`;
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
