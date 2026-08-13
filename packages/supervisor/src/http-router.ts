import { validateOpaqueIdentity } from "@senawa/protocol";

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
  | { readonly kind: "portal-session" }
  | {
      readonly kind:
        | "supervisor-status"
        | "supervisor-drain"
        | "supervisor-stop"
        | "supervisor-recovery";
    }
  | { readonly kind: "supervisor-logs"; readonly afterCursor?: number; readonly limit?: number };

export class SupervisorHttpRouteError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SupervisorHttpRouteError";
    this.status = status;
  }
}

export function matchSupervisorHttpRoute(method: string, target: string): SupervisorHttpRoute {
  const { segments, query } = parseRequestTarget(target);
  const route = matchPath(segments, query);
  const expectedMethod =
    route.kind === "commands" ||
    route.kind === "portal-session-bootstrap" ||
    route.kind === "supervisor-drain" ||
    route.kind === "supervisor-stop" ||
    route.kind === "supervisor-recovery"
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
  if (samePath(segments, ["supervisor", "v1alpha1", "status"])) {
    requireQuery(query, []);
    return { kind: "supervisor-status" };
  }
  if (samePath(segments, ["supervisor", "v1alpha1", "drain"])) {
    requireQuery(query, []);
    return { kind: "supervisor-drain" };
  }
  if (samePath(segments, ["supervisor", "v1alpha1", "stop"])) {
    requireQuery(query, []);
    return { kind: "supervisor-stop" };
  }
  if (samePath(segments, ["supervisor", "v1alpha1", "recoveries"])) {
    requireQuery(query, []);
    return { kind: "supervisor-recovery" };
  }
  if (samePath(segments, ["supervisor", "v1alpha1", "logs"])) {
    requireQuery(query, ["after", "limit"]);
    const afterCursor = optionalInteger(query, "after", 0, Number.MAX_SAFE_INTEGER);
    const limit = optionalInteger(query, "limit", 1, 1_024);
    return {
      kind: "supervisor-logs",
      ...(afterCursor === undefined ? {} : { afterCursor }),
      ...(limit === undefined ? {} : { limit }),
    };
  }
  if (samePath(segments, ["api", "v1alpha1", "capabilities"])) {
    requireQuery(query, []);
    return { kind: "capabilities" };
  }
  if (samePath(segments, ["api", "v1alpha1", "commands"])) {
    requireQuery(query, []);
    return { kind: "commands" };
  }
  if (
    segments.length === 6 &&
    samePath(segments.slice(0, 3), ["api", "v1alpha1", "commands"]) &&
    segments[4] === "receipt"
  ) {
    throw notFound();
  }
  if (
    segments.length === 5 &&
    samePath(segments.slice(0, 3), ["api", "v1alpha1", "commands"]) &&
    segments[4] === "receipt"
  ) {
    requireQuery(query, []);
    return { kind: "command-receipt", commandId: validateIdentity(segments[3]) };
  }
  if (samePath(segments, ["api", "v1alpha1", "portal-sessions"])) {
    requireQuery(query, []);
    return { kind: "portal-session-bootstrap" };
  }
  if (samePath(segments, ["portal", "bootstrap"])) {
    requireQuery(query, ["token"], ["token"]);
    const token = query.get("token");
    if (token === null || token.length === 0) throw badTarget();
    return { kind: "portal-bootstrap", token };
  }
  if (samePath(segments, ["api", "v1alpha1", "session"])) {
    requireQuery(query, []);
    return { kind: "portal-session" };
  }
  if (
    segments.length >= 7 &&
    samePath(segments.slice(0, 3), ["api", "v1alpha1", "repositories"]) &&
    segments[4] === "runs"
  ) {
    const repositoryId = validateIdentity(segments[3]);
    const runId = validateIdentity(segments[5]);
    const suffix = segments.slice(6);
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
