import type { EventStreamFrame, PortalGraphNode } from "@senawa/protocol";

/**
 * What happened, in order. The event stream is the only projection that carries
 * both a time and a position, so a chronological reading has to be built from
 * it; delivery records have neither and can only hang off the event that
 * published them.
 */

export interface TimelineMoment {
  readonly cursor: number;
  /** UTC clock time, which is what the record is written in. */
  readonly time: string;
  /** What happened, in the reader's words. */
  readonly what: string;
  /** The phase or piece of work it happened to, named rather than identified. */
  readonly where: string | undefined;
  /** A detail worth one line, such as what was published. */
  readonly detail: string | undefined;
  readonly tone: "opened" | "closed" | "asked" | "failed" | "plain";
}

const WHAT: Readonly<Record<string, string>> = Object.freeze({
  "run-instantiated": "run created",
  "run-paused": "run paused",
  "run-resumed": "run resumed",
  "run-ended": "run ended",
  "phase-started": "phase opened",
  "phase-closed": "phase closed",
  "phase-output-published": "output published",
  "task-started": "work started",
  "task-completed": "work finished",
  "task-failed": "work could not finish",
  "question-raised": "an agent asked something",
  "question-answered": "you answered",
  "allowance-escalated": "ran out of budget",
  "allowance-granted": "you granted more budget",
  "candidate-proposed": "a phase asked to close",
  "candidate-approved": "you approved a phase",
  "amendment-proposed": "a change was proposed",
  "amendment-decision-recorded": "you decided on a change",
  "fan-out-evaluated": "work was fanned out",
  "integration-recorded": "work was integrated",
});

const TONES: Readonly<Record<string, TimelineMoment["tone"]>> = Object.freeze({
  "run-instantiated": "opened",
  "phase-started": "opened",
  "task-started": "opened",
  "run-ended": "closed",
  "phase-closed": "closed",
  "task-completed": "closed",
  "candidate-approved": "closed",
  "question-raised": "asked",
  "allowance-escalated": "asked",
  "candidate-proposed": "asked",
  "amendment-proposed": "asked",
  "task-failed": "failed",
});

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/** A word for the event, falling back to the event type read as words. */
export function momentWhat(eventType: string): string {
  return WHAT[eventType] ?? eventType.replaceAll("-", " ");
}

/** A clock a reader can compare against the transcript, which is also UTC. */
export function momentTime(occurredAt: string): string {
  const parsed = Date.parse(occurredAt);
  return Number.isNaN(parsed) ? "--:--:--" : new Date(parsed).toISOString().slice(11, 19);
}

export function timelineMoments(
  events: readonly EventStreamFrame[],
  nodes: readonly PortalGraphNode[],
): readonly TimelineMoment[] {
  const names = new Map(nodes.map((node) => [node.nodeId, node.title]));
  const named = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (names.get(id) ?? id);
  return [...events]
    .sort((left, right) => left.cursor - right.cursor)
    .map((event) => {
      const payload = event.payload;
      const where =
        named(readString(payload, "taskId")) ??
        named(readString(payload, "phaseId")) ??
        readString(payload, "phase") ??
        readString(payload, "task");
      const output = readString(payload, "outputName");
      const bytes = readNumber(payload, "byteLength");
      const detail =
        output === undefined
          ? readString(payload, "reason")
          : bytes === undefined
            ? output
            : `${output}, ${String(bytes)} bytes`;
      return Object.freeze({
        cursor: event.cursor,
        time: momentTime(event.occurredAt),
        what: momentWhat(event.eventType),
        where,
        detail,
        tone: TONES[event.eventType] ?? "plain",
      });
    });
}
