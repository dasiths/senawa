import {
  type CanonicalValue,
  canonicalDigest,
  canonicalValue,
  isSha256Digest,
  type Sha256,
  type Sha256Digest,
} from "./canonical.js";
import { GraphValidationError, validateWorkflowGraph, type WorkflowGraph } from "./graph.js";
import {
  type EventId,
  isEventId,
  isRunId,
  isWorkflowId,
  type RunId,
  type WorkflowId,
} from "./identity.js";

export interface InstantiateRunCommand {
  readonly type: "instantiate-run";
  readonly eventId: EventId;
  readonly eventContentDigest: Sha256Digest;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly workflowId: WorkflowId;
  readonly graph: WorkflowGraph;
  readonly facts: unknown;
}

export interface AcceptGraphRevisionCommand {
  readonly type: "accept-graph-revision";
  readonly eventId: EventId;
  readonly eventContentDigest: Sha256Digest;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly workflowId: WorkflowId;
  readonly expectedRevisionDigest: Sha256Digest;
  readonly graph: WorkflowGraph;
  readonly facts: unknown;
}

export type RunCommand = InstantiateRunCommand | AcceptGraphRevisionCommand;

export interface RunInstantiatedEventContent {
  readonly type: "run-instantiated";
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly workflowId: WorkflowId;
  readonly revisionDigest: Sha256Digest;
  readonly graph: WorkflowGraph;
  readonly facts: CanonicalValue;
}

export interface GraphRevisionAcceptedEventContent {
  readonly type: "graph-revision-accepted";
  readonly sequence: number;
  readonly occurredAt: string;
  readonly runId: RunId;
  readonly workflowId: WorkflowId;
  readonly beforeRevisionDigest: Sha256Digest;
  readonly afterRevisionDigest: Sha256Digest;
  readonly graph: WorkflowGraph;
  readonly facts: CanonicalValue;
}

export type RunEventContent = RunInstantiatedEventContent | GraphRevisionAcceptedEventContent;

export type RunInstantiatedEvent = Readonly<
  RunInstantiatedEventContent & {
    readonly eventId: EventId;
    readonly contentDigest: Sha256Digest;
  }
>;

export type GraphRevisionAcceptedEvent = Readonly<
  GraphRevisionAcceptedEventContent & {
    readonly eventId: EventId;
    readonly contentDigest: Sha256Digest;
  }
>;

export type RunEvent = RunInstantiatedEvent | GraphRevisionAcceptedEvent;

export interface RunState {
  readonly runId: RunId;
  readonly workflowId: WorkflowId;
  readonly revisionDigest: Sha256Digest;
  readonly graph: WorkflowGraph;
  readonly lastSequence: number;
  readonly eventIds: readonly EventId[];
}

export type RunTransitionErrorCode =
  | "run-already-instantiated"
  | "run-not-instantiated"
  | "invalid-command"
  | "invalid-event"
  | "invalid-event-digest"
  | "invalid-event-identity"
  | "invalid-sequence"
  | "duplicate-event"
  | "identity-mismatch"
  | "stale-revision"
  | "invalid-revision";

export class RunTransitionError extends Error {
  readonly code: RunTransitionErrorCode;

  constructor(code: RunTransitionErrorCode, message: string) {
    super(message);
    this.name = "RunTransitionError";
    this.code = code;
  }
}

export function digestRunEventContent(content: RunEventContent, sha256: Sha256): Sha256Digest {
  return canonicalDigest(canonicalValue(content), sha256);
}

export function decideRunCommand(
  state: RunState | undefined,
  command: RunCommand,
  sha256: Sha256,
): readonly RunEvent[] {
  if (command.type === "instantiate-run") {
    if (state !== undefined) {
      fail("run-already-instantiated", `Run ${state.runId} is already instantiated`);
    }
    assertCommandEnvelope(command);
    const graph = validateCommandGraph(command.graph, sha256);
    assertCommandIdentities(command.runId, command.workflowId, graph);
    if (command.sequence !== 1) {
      fail("invalid-sequence", "The run-instantiated event must have sequence 1");
    }

    const content: RunInstantiatedEventContent = {
      type: "run-instantiated",
      sequence: command.sequence,
      occurredAt: command.occurredAt,
      runId: command.runId,
      workflowId: command.workflowId,
      revisionDigest: graph.revisionDigest,
      graph,
      facts: canonicalCommandFacts(command.facts),
    };
    return Object.freeze([
      createEvent(content, command.eventId, command.eventContentDigest, sha256),
    ]);
  }

  if (command.type !== "accept-graph-revision") {
    fail("invalid-command", "Unknown run command type");
  }
  if (state === undefined) {
    fail("run-not-instantiated", "A graph revision cannot be accepted before run instantiation");
  }
  assertCommandEnvelope(command);
  assertStateCommandIdentities(state, command.runId, command.workflowId);
  if (state.eventIds.includes(command.eventId)) {
    fail("duplicate-event", `Event identity ${command.eventId} has already been applied`);
  }
  if (command.sequence !== state.lastSequence + 1) {
    fail(
      "invalid-sequence",
      `Expected event sequence ${state.lastSequence + 1}, received ${command.sequence}`,
    );
  }
  if (command.expectedRevisionDigest !== state.revisionDigest) {
    fail(
      "stale-revision",
      `Expected current revision ${state.revisionDigest}, received ${command.expectedRevisionDigest}`,
    );
  }

  const graph = validateCommandGraph(command.graph, sha256);
  assertCommandIdentities(command.runId, command.workflowId, graph);
  if (graph.revisionDigest === state.revisionDigest) {
    fail("invalid-revision", "A graph revision acceptance must introduce a new revision");
  }

  const content: GraphRevisionAcceptedEventContent = {
    type: "graph-revision-accepted",
    sequence: command.sequence,
    occurredAt: command.occurredAt,
    runId: command.runId,
    workflowId: command.workflowId,
    beforeRevisionDigest: state.revisionDigest,
    afterRevisionDigest: graph.revisionDigest,
    graph,
    facts: canonicalCommandFacts(command.facts),
  };
  return Object.freeze([createEvent(content, command.eventId, command.eventContentDigest, sha256)]);
}

export function applyRunEvent(
  state: RunState | undefined,
  event: RunEvent,
  sha256: Sha256,
): RunState {
  const submittedEvent = snapshotRunEvent(event);
  const content = eventContent(submittedEvent);
  assertEventEnvelope(submittedEvent, content, sha256);
  const graph = validateEventGraph(submittedEvent.graph, sha256);

  if (state?.eventIds.includes(submittedEvent.eventId) === true) {
    fail("duplicate-event", `Event identity ${submittedEvent.eventId} has already been applied`);
  }
  const expectedSequence = state === undefined ? 1 : state.lastSequence + 1;
  if (submittedEvent.sequence !== expectedSequence) {
    fail(
      "invalid-sequence",
      `Expected event sequence ${expectedSequence}, received ${submittedEvent.sequence}`,
    );
  }

  if (submittedEvent.type === "run-instantiated") {
    if (state !== undefined) {
      fail("run-already-instantiated", `Run ${state.runId} is already instantiated`);
    }
    assertEventIdentities(submittedEvent.runId, submittedEvent.workflowId, graph);
    if (submittedEvent.revisionDigest !== graph.revisionDigest) {
      fail("invalid-revision", "Run instantiation revision does not match its graph revision");
    }
    return freezeState(submittedEvent, graph, Object.freeze([submittedEvent.eventId]));
  }

  if (state === undefined) {
    fail("run-not-instantiated", "A graph revision event cannot precede run instantiation");
  }
  assertStateCommandIdentities(state, submittedEvent.runId, submittedEvent.workflowId);
  assertEventIdentities(submittedEvent.runId, submittedEvent.workflowId, graph);
  if (submittedEvent.beforeRevisionDigest !== state.revisionDigest) {
    fail(
      "stale-revision",
      `Revision event expected ${submittedEvent.beforeRevisionDigest}, current revision is ${state.revisionDigest}`,
    );
  }
  if (submittedEvent.afterRevisionDigest !== graph.revisionDigest) {
    fail("invalid-revision", "Accepted revision does not match its graph revision");
  }
  if (submittedEvent.afterRevisionDigest === submittedEvent.beforeRevisionDigest) {
    fail("invalid-revision", "A graph revision event must introduce a new revision");
  }

  return freezeState(
    submittedEvent,
    graph,
    Object.freeze([...state.eventIds, submittedEvent.eventId]),
  );
}

export function replayRunEvents(events: readonly RunEvent[], sha256: Sha256): RunState {
  let state: RunState | undefined;
  for (const event of events) {
    state = applyRunEvent(state, event, sha256);
  }
  if (state === undefined) {
    fail("run-not-instantiated", "A run cannot be rebuilt from an empty event sequence");
  }
  return state;
}

function createEvent<Content extends RunEventContent>(
  content: Content,
  suppliedEventId: EventId,
  suppliedDigest: Sha256Digest,
  sha256: Sha256,
): Extract<RunEvent, { readonly type: Content["type"] }> {
  assertEventMetadata(suppliedEventId, suppliedDigest, content, sha256);
  return canonicalValue({
    ...content,
    eventId: suppliedEventId,
    contentDigest: suppliedDigest,
  }) as unknown as Extract<RunEvent, { readonly type: Content["type"] }>;
}

function eventContent(event: RunEvent): RunEventContent {
  if (event.type === "run-instantiated") {
    assertExactEventKeys(event, [
      "type",
      "sequence",
      "occurredAt",
      "runId",
      "workflowId",
      "revisionDigest",
      "graph",
      "facts",
      "eventId",
      "contentDigest",
    ]);
    return {
      type: event.type,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      runId: event.runId,
      workflowId: event.workflowId,
      revisionDigest: event.revisionDigest,
      graph: event.graph,
      facts: event.facts,
    };
  }
  if (event.type !== "graph-revision-accepted") {
    fail("invalid-event", "Unknown run event type");
  }
  assertExactEventKeys(event, [
    "type",
    "sequence",
    "occurredAt",
    "runId",
    "workflowId",
    "beforeRevisionDigest",
    "afterRevisionDigest",
    "graph",
    "facts",
    "eventId",
    "contentDigest",
  ]);
  return {
    type: event.type,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    runId: event.runId,
    workflowId: event.workflowId,
    beforeRevisionDigest: event.beforeRevisionDigest,
    afterRevisionDigest: event.afterRevisionDigest,
    graph: event.graph,
    facts: event.facts,
  };
}

function assertCommandEnvelope(command: RunCommand): void {
  assertSequence(command.sequence);
  assertTimestamp(command.occurredAt, "invalid-command");
  if (!isEventId(command.eventId)) {
    fail("invalid-event-identity", `Invalid event identity: ${String(command.eventId)}`);
  }
  if (!isSha256Digest(command.eventContentDigest)) {
    fail("invalid-event-digest", "Command event content digest is not a SHA-256 digest");
  }
}

function assertEventEnvelope(event: RunEvent, content: RunEventContent, sha256: Sha256): void {
  assertSequence(event.sequence);
  assertTimestamp(event.occurredAt, "invalid-event");
  assertEventMetadata(event.eventId, event.contentDigest, content, sha256);
}

function canonicalCommandFacts(value: unknown): CanonicalValue {
  try {
    return canonicalValue(value);
  } catch {
    fail("invalid-command", "Run command facts must be canonical JSON values");
  }
}

function assertEventMetadata(
  suppliedEventId: EventId,
  suppliedDigest: Sha256Digest,
  content: RunEventContent,
  sha256: Sha256,
): void {
  if (!isSha256Digest(suppliedDigest)) {
    fail("invalid-event-digest", "Event content digest is not a SHA-256 digest");
  }
  const computedDigest = digestRunEventContent(content, sha256);
  if (suppliedDigest !== computedDigest) {
    fail(
      "invalid-event-digest",
      `Event content digest ${suppliedDigest} does not match computed digest ${computedDigest}`,
    );
  }
  const expectedEventId = `event_${computedDigest}`;
  if (!isEventId(suppliedEventId) || suppliedEventId !== expectedEventId) {
    fail(
      "invalid-event-identity",
      `Event identity must be the content-addressed identity ${expectedEventId}`,
    );
  }
}

function snapshotRunEvent(event: unknown): RunEvent {
  try {
    return canonicalValue(event) as unknown as RunEvent;
  } catch {
    fail("invalid-event", "Run events must be canonical JSON values");
  }
}

function validateCommandGraph(graph: unknown, sha256: Sha256): WorkflowGraph {
  try {
    return validateWorkflowGraph(graph, sha256);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail("invalid-command", error.message);
    }
    throw error;
  }
}

function validateEventGraph(graph: unknown, sha256: Sha256): WorkflowGraph {
  try {
    return validateWorkflowGraph(graph, sha256);
  } catch (error) {
    if (error instanceof GraphValidationError) {
      fail("invalid-event", error.message);
    }
    throw error;
  }
}

function assertExactEventKeys(event: RunEvent, expectedKeys: readonly string[]): void {
  const actualKeys = Object.keys(event).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    fail("invalid-event", `Run event fields must be exactly: ${expected.join(", ")}`);
  }
}

function assertCommandIdentities(runId: RunId, workflowId: WorkflowId, graph: WorkflowGraph): void {
  if (!isRunId(runId) || !isWorkflowId(workflowId)) {
    fail("identity-mismatch", "Run commands require valid run and workflow identities");
  }
  if (workflowId !== graph.workflowId) {
    fail(
      "identity-mismatch",
      `Command workflow ${workflowId} does not match graph workflow ${graph.workflowId}`,
    );
  }
}

function assertEventIdentities(runId: RunId, workflowId: WorkflowId, graph: WorkflowGraph): void {
  if (!isRunId(runId) || !isWorkflowId(workflowId) || workflowId !== graph.workflowId) {
    fail("identity-mismatch", "Event run or workflow identity is invalid for its graph");
  }
}

function assertStateCommandIdentities(state: RunState, runId: RunId, workflowId: WorkflowId): void {
  if (runId !== state.runId || workflowId !== state.workflowId) {
    fail(
      "identity-mismatch",
      `Expected run ${state.runId} and workflow ${state.workflowId}, received ${runId} and ${workflowId}`,
    );
  }
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    fail("invalid-sequence", "Event sequences must be positive safe integers");
  }
}

function assertTimestamp(
  timestamp: string,
  errorCode: Extract<RunTransitionErrorCode, "invalid-command" | "invalid-event">,
): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    fail(errorCode, "Event timestamps must use the UTC ISO 8601 millisecond form");
  }
}

function freezeState(
  event: RunEvent,
  graph: WorkflowGraph,
  eventIds: readonly EventId[],
): RunState {
  const revisionDigest =
    event.type === "run-instantiated" ? event.revisionDigest : event.afterRevisionDigest;
  return Object.freeze({
    runId: event.runId,
    workflowId: event.workflowId,
    revisionDigest,
    graph,
    lastSequence: event.sequence,
    eventIds,
  });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: RunTransitionErrorCode, message: string): never {
  throw new RunTransitionError(code, message);
}
