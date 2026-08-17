import {
  PORTAL_LIMITS,
  type PortalRecordKind,
  type PortalTranscriptOwnerKind,
  TRANSCRIPT_LIMITS,
  validateOpaqueIdentity,
} from "@senawa/protocol";

const MAX_REQUEST_TARGET_LENGTH = 2_048;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const INVALID_PERCENT_PATTERN = /%(?![0-9a-fA-F]{2})/u;
const ENCODED_PATH_SYNTAX_PATTERN = /%(?:2f|5c|2e)/iu;
const ENCODED_CONTROL_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu;

export type SupervisorHttpRoute =
  | { readonly kind: "capabilities" }
  | { readonly kind: "commands" }
  | { readonly kind: "command-receipt"; readonly commandId: string }
  | {
      readonly kind: "receipt-page" | "event-page" | "event-stream" | "phase-lifecycle";
      readonly repositoryId: string;
      readonly runId: string;
      readonly afterCursor?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "amendment-list" | "amendment-record" | "amendment-source";
      readonly repositoryId: string;
      readonly runId: string;
      readonly amendmentId?: string;
    }
  | { readonly kind: "portal-session-bootstrap" }
  | { readonly kind: "portal-bootstrap"; readonly token: string }
  | { readonly kind: "portal-session-descriptor" | "portal-session-csrf" }
  | { readonly kind: "portal-shell" }
  | { readonly kind: "portal-asset"; readonly name: string }
  | { readonly kind: "portal-repository-list"; readonly after?: string; readonly limit?: number }
  | {
      readonly kind: "portal-run-list";
      readonly repositoryId: string;
      readonly after?: string;
      readonly limit?: number;
    }
  | {
      readonly kind:
        | "portal-run-overview"
        | "portal-graph-summary"
        | "portal-human-needs"
        | "portal-question-list"
        | "portal-artifact-list"
        | "portal-workspace-list"
        | "portal-integration-list";
      readonly repositoryId: string;
      readonly runId: string;
      readonly after?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: "portal-delivery-list";
      readonly repositoryId: string;
      readonly runId: string;
      readonly afterCursor?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "portal-transcript";
      readonly repositoryId: string;
      readonly runId: string;
      readonly ownerKind: PortalTranscriptOwnerKind;
      readonly ownerId: string;
      readonly afterCursor?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "portal-graph-nodes" | "portal-graph-edges";
      readonly repositoryId: string;
      readonly runId: string;
      readonly graphRevision: string;
      readonly afterCursor?: number;
      readonly limit?: number;
    }
  | {
      readonly kind: "portal-record";
      readonly repositoryId: string;
      readonly runId: string;
      readonly recordKind: PortalRecordKind;
      readonly digest: string;
    }
  | {
      readonly kind:
        | "portal-allowance-review"
        | "portal-question"
        | "portal-artifact"
        | "portal-artifact-download";
      readonly repositoryId: string;
      readonly runId: string;
      readonly resourceId: string;
    }
  | {
      readonly kind: "portal-artifact-content";
      readonly repositoryId: string;
      readonly runId: string;
      readonly resourceId: string;
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly kind: "portal-receipt-window" | "portal-event-window";
      readonly repositoryId: string;
      readonly runId: string;
      readonly afterCursor?: number;
      readonly beforeCursor?: number;
      readonly limit?: number;
    }
  | {
      readonly kind:
        | "supervisor-status"
        | "supervisor-drain"
        | "supervisor-stop"
        | "supervisor-recovery"
        | "supervisor-backup";
    }
  | { readonly kind: "supervisor-logs"; readonly afterCursor?: number; readonly limit?: number }
  | {
      // Worker routes are deliberately separate from the command path, which
      // carries human authority a worker must never reach.
      readonly kind: "worker-context" | "worker-output-schema" | "worker-submission";
      readonly dispatchId: string;
    };

export class SupervisorHttpRouteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SupervisorHttpRouteError";
    this.status = status;
  }
}

export function matchSupervisorHttpRoute(method: string, target: string): SupervisorHttpRoute {
  if (target === "/portal/") {
    if (method !== "GET") {
      throw new SupervisorHttpRouteError(405, "Method is not allowed for this route");
    }
    return { kind: "portal-shell" };
  }
  const { segments, query } = parseRequestTarget(target);
  let route = matchPath(segments, query);
  if (route.kind === "portal-session-descriptor" && method === "POST") {
    route = { kind: "portal-session-csrf" };
  }
  const expectedMethod =
    route.kind === "commands" ||
    route.kind === "worker-submission" ||
    route.kind === "portal-session-csrf" ||
    route.kind === "portal-session-bootstrap" ||
    route.kind === "supervisor-drain" ||
    route.kind === "supervisor-stop" ||
    route.kind === "supervisor-recovery" ||
    route.kind === "supervisor-backup"
      ? "POST"
      : "GET";
  if (method !== expectedMethod) {
    throw new SupervisorHttpRouteError(405, "Method is not allowed for this route");
  }
  return route;
}

function parseRequestTarget(target: string): {
  readonly segments: readonly string[];
  readonly query: URLSearchParams;
} {
  if (
    target.length === 0 ||
    target.length > MAX_REQUEST_TARGET_LENGTH ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    containsControlCharacter(target) ||
    target.includes("#")
  ) {
    throw badTarget();
  }
  const question = target.indexOf("?");
  const rawPath = question === -1 ? target : target.slice(0, question);
  const rawQuery = question === -1 ? "" : target.slice(question + 1);
  if (
    INVALID_PERCENT_PATTERN.test(rawPath) ||
    INVALID_PERCENT_PATTERN.test(rawQuery) ||
    ENCODED_CONTROL_PATTERN.test(rawPath) ||
    ENCODED_CONTROL_PATTERN.test(rawQuery) ||
    ENCODED_PATH_SYNTAX_PATTERN.test(rawPath)
  ) {
    throw badTarget();
  }
  const rawSegments = rawPath === "/" ? [] : rawPath.slice(1).split("/");
  if (rawSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw badTarget();
  }
  let segments: readonly string[];
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    throw badTarget();
  }
  if (segments.some(containsControlCharacter)) throw badTarget();
  const query = new URLSearchParams(rawQuery);
  for (const [key, value] of query) {
    if (containsControlCharacter(key) || containsControlCharacter(value)) throw badTarget();
  }
  return { segments, query };
}

function matchPath(segments: readonly string[], query: URLSearchParams): SupervisorHttpRoute {
  if (samePath(segments, ["supervisor", "v1", "status"])) {
    requireQuery(query, []);
    return { kind: "supervisor-status" };
  }
  if (samePath(segments, ["supervisor", "v1", "drain"])) {
    requireQuery(query, []);
    return { kind: "supervisor-drain" };
  }
  if (samePath(segments, ["supervisor", "v1", "stop"])) {
    requireQuery(query, []);
    return { kind: "supervisor-stop" };
  }
  if (samePath(segments, ["supervisor", "v1", "recoveries"])) {
    requireQuery(query, []);
    return { kind: "supervisor-recovery" };
  }
  if (samePath(segments, ["supervisor", "v1", "backups"])) {
    requireQuery(query, []);
    return { kind: "supervisor-backup" };
  }
  if (samePath(segments, ["supervisor", "v1", "logs"])) {
    requireQuery(query, ["after", "limit"]);
    const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(query, "limit", 1, 1_024);
    return {
      kind: "supervisor-logs",
      ...(afterCursor === undefined ? {} : { afterCursor }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  if (samePath(segments, ["api", "v1", "capabilities"])) {
    requireQuery(query, []);
    return { kind: "capabilities" };
  }
  if (samePath(segments, ["api", "v1", "commands"])) {
    requireQuery(query, []);
    return { kind: "commands" };
  }
  if (
    segments.length === 6 &&
    samePath(segments.slice(0, 3), ["api", "v1", "commands"]) &&
    segments[4] === "receipt"
  ) {
    throw notFound();
  }
  if (
    segments.length === 5 &&
    samePath(segments.slice(0, 3), ["api", "v1", "commands"]) &&
    segments[4] === "receipt"
  ) {
    requireQuery(query, []);
    return { kind: "command-receipt", commandId: validateIdentity(segments[3]) };
  }
  if (
    segments.length === 5 &&
    samePath(segments.slice(0, 3), ["api", "v1", "worker"]) &&
    (segments[4] === "context" || segments[4] === "output-schema" || segments[4] === "submissions")
  ) {
    requireQuery(query, []);
    const dispatchId = validateIdentity(segments[3]);
    if (segments[4] === "context") return { kind: "worker-context", dispatchId };
    if (segments[4] === "output-schema") return { kind: "worker-output-schema", dispatchId };
    return { kind: "worker-submission", dispatchId };
  }
  if (samePath(segments, ["api", "v1", "portal-sessions"])) {
    requireQuery(query, []);
    return { kind: "portal-session-bootstrap" };
  }
  if (samePath(segments, ["portal", "bootstrap"])) {
    requireQuery(query, ["token"], ["token"]);
    const token = query.get("token");
    if (token === null || token.length === 0) throw badTarget();
    return { kind: "portal-bootstrap", token };
  }
  if (samePath(segments, ["api", "v1", "session"])) {
    requireQuery(query, []);
    return { kind: "portal-session-descriptor" };
  }
  if (segments.length === 3 && samePath(segments.slice(0, 2), ["portal", "assets"])) {
    requireQuery(query, []);
    return { kind: "portal-asset", name: validateAssetName(segments[2]) };
  }
  if (samePath(segments, ["api", "v1", "repositories"])) {
    const page = lexicalPage(query, PORTAL_LIMITS.maxDiscoveryItems);
    return { kind: "portal-repository-list", ...page };
  }
  if (
    segments.length === 5 &&
    samePath(segments.slice(0, 3), ["api", "v1", "repositories"]) &&
    segments[4] === "runs"
  ) {
    const page = lexicalPage(query, PORTAL_LIMITS.maxDiscoveryItems);
    return {
      kind: "portal-run-list",
      repositoryId: validateIdentity(segments[3]),
      ...page,
    };
  }
  if (
    segments.length >= 7 &&
    samePath(segments.slice(0, 3), ["api", "v1", "repositories"]) &&
    segments[4] === "runs"
  ) {
    const repositoryId = validateIdentity(segments[3]);
    const runId = validateIdentity(segments[5]);
    const suffix = segments.slice(6);
    if (samePath(suffix, ["overview"])) {
      requireQuery(query, []);
      return { kind: "portal-run-overview", repositoryId, runId };
    }
    if (samePath(suffix, ["graph"])) {
      requireQuery(query, []);
      return { kind: "portal-graph-summary", repositoryId, runId };
    }
    if (samePath(suffix, ["delivery"])) {
      requireQuery(query, ["after", "limit"]);
      const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(query, "limit", 1, PORTAL_LIMITS.maxDeliveryItems);
      return {
        kind: "portal-delivery-list",
        repositoryId,
        runId,
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    if (suffix.length === 3 && suffix[0] === "transcript") {
      requireQuery(query, ["after", "limit"]);
      const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(query, "limit", 1, TRANSCRIPT_LIMITS.maxRecordsPerPage);
      return {
        kind: "portal-transcript",
        repositoryId,
        runId,
        ownerKind: validateTranscriptOwnerKind(suffix[1]),
        ownerId: validateIdentity(suffix[2]),
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    if (samePath(suffix, ["graph", "nodes"]) || samePath(suffix, ["graph", "edges"])) {
      requireQuery(query, ["revision", "after", "limit"], ["revision"]);
      const graphRevision = query.get("revision");
      if (graphRevision === null || !/^[0-9a-f]{64}$/u.test(graphRevision)) throw badTarget();
      const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(query, "limit", 1, PORTAL_LIMITS.maxGraphItems);
      return {
        kind: suffix[1] === "nodes" ? "portal-graph-nodes" : "portal-graph-edges",
        repositoryId,
        runId,
        graphRevision,
        ...(afterCursor === undefined ? {} : { afterCursor }),
        ...(limit === undefined ? {} : { limit }),
      };
    }
    if (suffix.length === 3 && suffix[0] === "records") {
      requireQuery(query, []);
      return {
        kind: "portal-record",
        repositoryId,
        runId,
        recordKind: validateRecordKind(suffix[1]),
        digest: validateDigest(suffix[2]),
      };
    }
    if (samePath(suffix, ["needs"])) {
      return {
        kind: "portal-human-needs",
        repositoryId,
        runId,
        ...lexicalPage(query, PORTAL_LIMITS.maxHumanNeeds),
      };
    }
    if (suffix.length === 2 && suffix[0] === "allowances") {
      requireQuery(query, []);
      return {
        kind: "portal-allowance-review",
        repositoryId,
        runId,
        resourceId: validateIdentity(suffix[1]),
      };
    }
    if (samePath(suffix, ["questions"])) {
      return {
        kind: "portal-question-list",
        repositoryId,
        runId,
        ...lexicalPage(query, PORTAL_LIMITS.maxHumanNeeds),
      };
    }
    if (suffix.length === 2 && suffix[0] === "questions") {
      requireQuery(query, []);
      return {
        kind: "portal-question",
        repositoryId,
        runId,
        resourceId: validateIdentity(suffix[1]),
      };
    }
    if (samePath(suffix, ["artifacts"])) {
      return {
        kind: "portal-artifact-list",
        repositoryId,
        runId,
        ...lexicalPage(query, PORTAL_LIMITS.maxArtifactItems),
      };
    }
    if (suffix.length === 2 && suffix[0] === "artifacts") {
      requireQuery(query, []);
      return {
        kind: "portal-artifact",
        repositoryId,
        runId,
        resourceId: validateIdentity(suffix[1]),
      };
    }
    if (suffix.length === 3 && suffix[0] === "artifacts" && suffix[2] === "content") {
      requireQuery(query, ["offset", "length"], ["offset", "length"]);
      return {
        kind: "portal-artifact-content",
        repositoryId,
        runId,
        resourceId: validateIdentity(suffix[1]),
        offset: requiredInteger(query, "offset", 0, Number.MAX_SAFE_INTEGER),
        length: requiredInteger(query, "length", 1, PORTAL_LIMITS.maxArtifactPreviewBytes),
      };
    }
    if (suffix.length === 3 && suffix[0] === "artifacts" && suffix[2] === "download") {
      requireQuery(query, []);
      return {
        kind: "portal-artifact-download",
        repositoryId,
        runId,
        resourceId: validateIdentity(suffix[1]),
      };
    }
    if (samePath(suffix, ["workspaces"])) {
      return {
        kind: "portal-workspace-list",
        repositoryId,
        runId,
        ...lexicalPage(query, PORTAL_LIMITS.maxWorkspaceItems),
      };
    }
    if (samePath(suffix, ["integrations"])) {
      return {
        kind: "portal-integration-list",
        repositoryId,
        runId,
        ...lexicalPage(query, PORTAL_LIMITS.maxIntegrationItems),
      };
    }
    if (samePath(suffix, ["activity", "receipts"]) || samePath(suffix, ["activity", "events"])) {
      const window = activityWindow(query);
      return {
        kind: suffix[1] === "receipts" ? "portal-receipt-window" : "portal-event-window",
        repositoryId,
        runId,
        ...window,
      };
    }
    if (samePath(suffix, ["receipts"])) {
      return pageRoute("receipt-page", repositoryId, runId, query);
    }
    if (samePath(suffix, ["events"])) {
      return pageRoute("event-page", repositoryId, runId, query);
    }
    if (samePath(suffix, ["events", "stream"])) {
      return pageRoute("event-stream", repositoryId, runId, query, false);
    }
    if (samePath(suffix, ["projections", "phase-lifecycle"])) {
      requireQuery(query, []);
      return { kind: "phase-lifecycle", repositoryId, runId };
    }
    if (samePath(suffix, ["amendments"])) {
      requireQuery(query, []);
      return { kind: "amendment-list", repositoryId, runId };
    }
    if (suffix.length === 2 && suffix[0] === "amendments") {
      requireQuery(query, []);
      return {
        kind: "amendment-record",
        repositoryId,
        runId,
        amendmentId: validateIdentity(suffix[1]),
      };
    }
    if (suffix.length === 3 && suffix[0] === "amendments" && suffix[2] === "source") {
      requireQuery(query, []);
      return {
        kind: "amendment-source",
        repositoryId,
        runId,
        amendmentId: validateIdentity(suffix[1]),
      };
    }
  }
  throw notFound();
}

function pageRoute(
  kind: "receipt-page" | "event-page" | "event-stream",
  repositoryId: string,
  runId: string,
  query: URLSearchParams,
  allowLimit = true,
): SupervisorHttpRoute {
  const allowed = allowLimit ? ["after", "limit"] : ["after"];
  requireQuery(query, allowed);
  const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
  const limit = allowLimit ? optionalInteger(query, "limit", 1, 1_024) : undefined;
  return {
    kind,
    repositoryId,
    runId,
    ...(afterCursor === undefined ? {} : { afterCursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function lexicalPage(
  query: URLSearchParams,
  maximum: number,
): { readonly after?: string; readonly limit?: number } {
  requireQuery(query, ["after", "limit"]);
  const after = query.get("after") ?? undefined;
  if (after !== undefined) validateIdentity(after);
  const limit = optionalInteger(query, "limit", 1, maximum);
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function activityWindow(query: URLSearchParams): {
  readonly afterCursor?: number;
  readonly beforeCursor?: number;
  readonly limit?: number;
} {
  requireQuery(query, ["after", "before", "limit"]);
  const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
  const beforeCursor = optionalInteger(query, "before", 0, Number.MAX_SAFE_INTEGER);
  if (afterCursor !== undefined && beforeCursor !== undefined) throw badTarget();
  const limit = optionalInteger(query, "limit", 1, PORTAL_LIMITS.maxActivityItems);
  return {
    ...(afterCursor === undefined ? {} : { afterCursor }),
    ...(beforeCursor === undefined ? {} : { beforeCursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function requireQuery(
  query: URLSearchParams,
  allowed: readonly string[],
  required: readonly string[] = [],
): void {
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.includes(key) || seen.has(key)) throw badTarget();
    seen.add(key);
  }
  if (required.some((key) => !seen.has(key))) throw badTarget();
}

function optionalInteger(
  query: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  if (!DECIMAL_PATTERN.test(raw)) throw badTarget();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw badTarget();
  return value;
}

function requiredInteger(
  query: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = optionalInteger(query, key, minimum, maximum);
  if (value === undefined) throw badTarget();
  return value;
}

function validateDigest(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/u.test(value)) throw badTarget();
  return value;
}

function validateRecordKind(value: string | undefined): PortalRecordKind {
  if (!new Set(["candidate", "gate", "decision", "closure", "escalation"]).has(value ?? "")) {
    throw notFound();
  }
  return value as PortalRecordKind;
}

function validateAssetName(value: string | undefined): string {
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) throw badTarget();
  return value;
}

function validateTranscriptOwnerKind(value: string | undefined): PortalTranscriptOwnerKind {
  if (!new Set(["dispatch", "task", "phase", "run"]).has(value ?? "")) throw notFound();
  return value as PortalTranscriptOwnerKind;
}

function validateIdentity(value: string | undefined): string {
  try {
    return validateOpaqueIdentity(value);
  } catch {
    throw badTarget();
  }
}

function samePath(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function badTarget(): SupervisorHttpRouteError {
  return new SupervisorHttpRouteError(400, "Request target is invalid");
}

function notFound(): SupervisorHttpRouteError {
  return new SupervisorHttpRouteError(404, "Route was not found");
}
