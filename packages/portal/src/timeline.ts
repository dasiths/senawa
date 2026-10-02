import type { DurableReceipt, EventStreamFrame, PortalGraphNode } from "@senawa/protocol";

/**
 * What happened, in order. The event stream is the only projection that carries
 * both a time and a position, so a chronological reading has to be built from
 * it; delivery records have neither and can only hang off the event that
 * published them.
 */

export interface TimelineMoment {
  /** The event's own identity, because a cursor is not unique in a replay. */
  readonly momentId: string;
  readonly cursor: number;
  /** When it happened, which is the only order records from different sources share. */
  readonly at: number;
  /** UTC clock time, which is what the record is written in. */
  readonly time: string;
  /** What happened, in the reader's words. */
  readonly what: string;
  /** The phase or piece of work it happened to, named rather than identified. */
  readonly where: string | undefined;
  /** A detail worth one line, such as what was published. */
  readonly detail: string | undefined;
  readonly tone: "opened" | "closed" | "asked" | "failed" | "plain";
  /** What the moment happened to, by identity, so records can be hung off it. */
  readonly scope: { readonly taskId?: string; readonly phaseId?: string } | undefined;
  /** The exact record behind the moment, built only when a reader opens it. */
  readonly record: unknown;
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

/**
 * What a command was for, read from the name it was given.
 *
 * The event stream carries `command-queued`, `command-claimed` and
 * `command-completed`, and every payload is the status it already announced: no
 * task, no phase, no reason. Read alone it is a queue's ticker rather than a
 * history. The command's own identity is the only part that says what was
 * happening, because the driver names each one after the thing it is doing.
 */
function commandPhrase(commandId: string):
  | {
      what: string;
      where: string | undefined;
      tone: TimelineMoment["tone"] | undefined;
    }
  | undefined {
  // A gate command carries the candidate digest as well as its own, so the
  // trailing identities come off together rather than one at a time.
  const name = commandId.replace(/^command_/u, "").replace(/(?:-[0-9a-f]{16,})+$/u, "");
  const plain = { where: undefined, tone: undefined };
  if (name.startsWith("instantiate"))
    return { what: "the run was created", where: undefined, tone: "opened" };
  if (name.startsWith("worker-completion"))
    return { what: "an agent handed its work in", ...plain };
  if (name.startsWith("fanout-propose"))
    return { what: "splitting the work was proposed", ...plain };
  if (name.startsWith("fanout-decide")) return { what: "the split was decided", ...plain };
  if (name.startsWith("fanout-apply"))
    return { what: "the work was split into members", where: undefined, tone: "opened" };
  const staged = /^(gate|close|advance)-(.+?)(?:-(\d+))?$/u.exec(name);
  if (staged !== null) {
    const [, verb, phase, attempt] = staged;
    const at = attempt === undefined ? "" : `, attempt ${attempt}`;
    if (verb === "advance") return { what: `${phase} opened${at}`, where: phase, tone: "opened" };
    if (verb === "close") return { what: `${phase} closed${at}`, where: phase, tone: "closed" };
    return { what: `${phase} was checked${at}`, where: phase, tone: undefined };
  }
  // A command the portal submitted is named by a fresh identity, so its name
  // says nothing. What it did is already told by the answer or the grant it
  // carried, and the receipts below list every one of them exactly.
  return undefined;
}

/**
 * The task a command's receipt says it was for, and what the agent said it did.
 *
 * A `worker-completion` command is named after its own digest, so its name says
 * nothing about the work. The receipt is where the task and the agent's own
 * summary are, and both are what a reader is looking for.
 */
function receiptFacts(receipt: DurableReceipt | undefined): {
  readonly taskId: string | undefined;
  readonly summary: string | undefined;
} {
  const assessment = readObject(receipt?.result, "assessment");
  const submission = readObject(assessment, "submission");
  return {
    taskId: readString(readObject(submission, "task"), "taskId"),
    summary: oneLine(readString(submission, "summary")),
  };
}

function readObject(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** A summary is written as prose, and a moment has room for the first line of it. */
function oneLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const flat = text.replaceAll(/\s+/gu, " ").trim();
  if (flat.length <= 140) return flat;
  const cut = flat.slice(0, 140);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/**
 * One moment per command, rather than three.
 *
 * A command is queued, claimed and completed, which is one thing happening and
 * three rows saying so. What a reader wants is the thing, and whether it took.
 */
function commandMoments(
  events: readonly EventStreamFrame[],
  named: (id: string | undefined) => string | undefined,
  receipts: ReadonlyMap<string, DurableReceipt>,
): readonly TimelineMoment[] {
  const byCommand = new Map<string, EventStreamFrame[]>();
  const loose: EventStreamFrame[] = [];
  for (const event of events) {
    if (event.commandId === undefined || !event.eventType.startsWith("command-")) {
      loose.push(event);
      continue;
    }
    const held = byCommand.get(String(event.commandId));
    if (held === undefined) byCommand.set(String(event.commandId), [event]);
    else held.push(event);
  }
  const moments: TimelineMoment[] = [];
  for (const [commandId, frames] of byCommand) {
    const ordered = [...frames].sort((left, right) => left.cursor - right.cursor);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === undefined || last === undefined) continue;
    const phrase = commandPhrase(commandId);
    if (phrase === undefined) continue;
    const refused = last.eventType === "command-refused";
    // The frames only ever say which stage a command reached. Its receipt is
    // where the result and the refusal reason are, so the two are read together.
    const receipt = receipts.get(commandId);
    const facts = receiptFacts(receipt);
    moments.push(
      Object.freeze({
        momentId: String(first.eventId),
        cursor: first.cursor,
        at: momentOrder(first.occurredAt),
        time: momentTime(first.occurredAt),
        what: refused ? `${phrase.what} \u2014 refused` : phrase.what,
        where: phrase.where ?? named(facts.taskId),
        detail: refused ? receipt?.error?.message : facts.summary,
        tone: (refused ? "failed" : (phrase.tone ?? "plain")) as TimelineMoment["tone"],
        scope: facts.taskId === undefined ? undefined : { taskId: facts.taskId },
        record:
          receipt === undefined
            ? ordered.length === 1
              ? first
              : ordered
            : { receipt, events: ordered },
      }),
    );
  }
  for (const event of loose) {
    const payload = event.payload;
    const where =
      named(readString(payload, "taskId")) ??
      named(readString(payload, "phaseId")) ??
      readString(payload, "phase") ??
      readString(payload, "task");
    const output = readString(payload, "outputName");
    const bytes = readNumber(payload, "byteLength");
    moments.push(
      Object.freeze({
        momentId: String(event.eventId),
        cursor: event.cursor,
        at: momentOrder(event.occurredAt),
        time: momentTime(event.occurredAt),
        what: momentWhat(event.eventType),
        where,
        detail:
          output === undefined
            ? readString(payload, "reason")
            : bytes === undefined
              ? output
              : `${output}, ${String(bytes)} bytes`,
        tone: TONES[event.eventType] ?? "plain",
        scope: eventScope(payload),
        record: event,
      }),
    );
  }
  return moments;
}

function eventScope(payload: unknown): TimelineMoment["scope"] {
  const taskId = readString(payload, "taskId");
  const phaseId = readString(payload, "phaseId");
  if (taskId === undefined && phaseId === undefined) return undefined;
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(phaseId === undefined ? {} : { phaseId }),
  };
}

/**
 * One order for moments that come from different records.
 *
 * A frame has a cursor and a question has only a time, so the clock is the one
 * thing they share. Frames that share a millisecond still fall back to the
 * cursor, which is the only total order the stream has.
 */
function momentOrder(occurredAt: string): number {
  const parsed = Date.parse(occurredAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** What an agent asked and what it was told, which is the part people remember. */
function questionMoments(
  questions: readonly TimelineQuestion[],
  named: (id: string | undefined) => string | undefined,
): readonly TimelineMoment[] {
  const moments: TimelineMoment[] = [];
  for (const question of questions) {
    const where = named(String(question.source.taskId));
    moments.push(
      Object.freeze({
        momentId: `asked:${String(question.source.submissionId)}`,
        cursor: 0,
        at: momentOrder(question.source.submittedAt),
        time: momentTime(question.source.submittedAt),
        what: "an agent asked",
        where,
        detail: question.prompt,
        tone: "asked" as const,
        scope: { taskId: String(question.source.taskId) },
        record: question,
      }),
    );
    if (question.answer === undefined) continue;
    moments.push(
      Object.freeze({
        momentId: `answered:${String(question.answer.answerId)}`,
        cursor: 0,
        at: momentOrder(question.answer.answeredAt),
        time: momentTime(question.answer.answeredAt),
        what: "you answered",
        where,
        detail: answerText(question.answer.answer),
        tone: "closed" as const,
        scope: { taskId: String(question.source.taskId) },
        record: question.answer,
      }),
    );
  }
  return moments;
}

function answerText(answer: unknown): string | undefined {
  if (typeof answer === "string") return answer;
  const held = readString(answer, "answer") ?? readString(answer, "text");
  return held ?? (answer === undefined ? undefined : JSON.stringify(answer));
}

export interface TimelineQuestion {
  readonly source: {
    readonly submissionId: string;
    readonly taskId: string;
    readonly submittedAt: string;
  };
  readonly prompt: string;
  readonly answer?: {
    readonly answerId: string;
    readonly answeredAt: string;
    readonly answer: unknown;
  };
}

export function timelineMoments(
  events: readonly EventStreamFrame[],
  nodes: readonly PortalGraphNode[],
  questions: readonly TimelineQuestion[] = [],
  receipts: readonly DurableReceipt[] = [],
): readonly TimelineMoment[] {
  const names = new Map(nodes.map((node) => [node.nodeId, node.title]));
  const named = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (names.get(id) ?? id);
  const byCommand = new Map(receipts.map((receipt) => [String(receipt.commandId), receipt]));
  return [...commandMoments(events, named, byCommand), ...questionMoments(questions, named)].sort(
    (left, right) => left.at - right.at || left.cursor - right.cursor,
  );
}
