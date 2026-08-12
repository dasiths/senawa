import { describe, expect, it } from "vitest";
import {
  type CanonicalValue,
  canonicalSerialize,
  canonicalValue,
  type Sha256,
  type Sha256Digest,
  sha256Digest,
} from "./canonical.js";
import { compileWorkflowGraph, type WorkflowGraph } from "./graph.js";
import {
  consumerKey,
  definitionGeneration,
  eventId,
  phaseId,
  runId,
  taskId,
  workflowId,
} from "./identity.js";
import {
  type AcceptGraphRevisionCommand,
  applyRunEvent,
  decideRunCommand,
  digestRunEventContent,
  type GraphRevisionAcceptedEventContent,
  type InstantiateRunCommand,
  type RunEvent,
  type RunEventContent,
  type RunInstantiatedEventContent,
  type RunState,
  RunTransitionError,
  type RunTransitionErrorCode,
  replayRunEvents,
} from "./run.js";

const deterministicSha256: Sha256 = {
  digest(bytes) {
    let accumulator = 0x811c9dc5;
    for (const byte of bytes) {
      accumulator = Math.imul(accumulator ^ byte, 0x01000193) >>> 0;
    }
    return accumulator.toString(16).padStart(8, "0").repeat(8);
  },
};

const RUN_ID = runId("run_fixed");
const WORKFLOW_ID = workflowId("workflow_fixed");
const OTHER_RUN_ID = runId("run_other");
const OTHER_WORKFLOW_ID = workflowId("workflow_other");
const INSTANTIATED_AT = "2026-08-12T10:00:00.000Z";
const REVISED_AT = "2026-08-12T10:05:00.000Z";

describe("run commands and events", () => {
  it("instantiates a run as one immutable canonical content-addressed event", () => {
    const graph = workflowGraph(1);
    const command = instantiateCommand(graph, {
      request: { owner: "factory", priority: 2 },
      source: "fixed-test",
    });

    const events = decideRunCommand(undefined, command, deterministicSha256);
    const event = required(events[0]);

    expect(event).toEqual(
      expect.objectContaining({
        type: "run-instantiated",
        sequence: 1,
        occurredAt: INSTANTIATED_AT,
        runId: RUN_ID,
        workflowId: WORKFLOW_ID,
        revisionDigest: graph.revisionDigest,
        eventId: command.eventId,
        contentDigest: command.eventContentDigest,
      }),
    );
    expect(event.eventId).toBe(`event_${event.contentDigest}`);
    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.graph)).toBe(true);
    expect(Object.isFrozen(event.facts)).toBe(true);
  });

  it("emits byte-identical events for the same facts in different property orders", () => {
    const graph = workflowGraph(1);
    const first = instantiateCommand(graph, {
      zeta: 3,
      nested: { beta: true, alpha: "fixed" },
      alpha: [2, 1],
    });
    const second = instantiateCommand(graph, {
      alpha: [2, 1],
      nested: { alpha: "fixed", beta: true },
      zeta: 3,
    });

    const firstEvent = required(decideRunCommand(undefined, first, deterministicSha256)[0]);
    const secondEvent = required(decideRunCommand(undefined, second, deterministicSha256)[0]);

    expect(first.eventId).toBe(second.eventId);
    expect(canonicalSerialize(canonicalValue(firstEvent))).toBe(
      canonicalSerialize(canonicalValue(secondEvent)),
    );
  });

  it("accepts an exact new graph revision and rebuilds equivalent state by replay", () => {
    const initialGraph = workflowGraph(1);
    const revisedGraph = workflowGraph(2);
    const instantiated = required(
      decideRunCommand(
        undefined,
        instantiateCommand(initialGraph, { source: "fixed-test" }),
        deterministicSha256,
      )[0],
    );
    const initialState = replayRunEvents([instantiated], deterministicSha256);
    const revised = required(
      decideRunCommand(
        initialState,
        revisionCommand(initialState, revisedGraph, { approval: "approved", ticket: 42 }),
        deterministicSha256,
      )[0],
    );

    const incrementallyApplied = applyRunEvent(initialState, revised, deterministicSha256);
    const replayed = replayRunEvents([instantiated, revised], deterministicSha256);

    expect(revised).toEqual(
      expect.objectContaining({
        type: "graph-revision-accepted",
        beforeRevisionDigest: initialGraph.revisionDigest,
        afterRevisionDigest: revisedGraph.revisionDigest,
      }),
    );
    expect(replayed).toEqual(incrementallyApplied);
    expect(replayed.graph).toEqual(revisedGraph);
    expect(replayed.eventIds).toEqual([instantiated.eventId, revised.eventId]);
    expect(Object.isFrozen(replayed)).toBe(true);
    expect(Object.isFrozen(replayed.eventIds)).toBe(true);
  });

  it("rejects a stale expected revision before emitting an event", () => {
    const state = instantiatedState();
    const command = revisionCommand(state, workflowGraph(2), { approval: "approved" });
    const stale = {
      ...command,
      expectedRevisionDigest: sha256Digest("a".repeat(64)),
    };

    expectTransitionError("stale-revision", () =>
      decideRunCommand(state, stale, deterministicSha256),
    );
  });

  it("rejects malformed command and replay sequences", () => {
    const initialGraph = workflowGraph(1);
    const malformedCommand = {
      ...instantiateCommand(initialGraph, { source: "fixed-test" }),
      sequence: 2,
    };
    expectTransitionError("invalid-sequence", () =>
      decideRunCommand(undefined, malformedCommand, deterministicSha256),
    );

    const instantiated = runEvent(
      instantiateContent(initialGraph, canonicalValue({ source: "fixed-test" })),
    );
    const state = applyRunEvent(undefined, instantiated, deterministicSha256);
    const skipped = runEvent({
      ...revisionContent(state, workflowGraph(2), canonicalValue({ approval: "approved" })),
      sequence: 3,
    });
    expectTransitionError("invalid-sequence", () =>
      applyRunEvent(state, skipped, deterministicSha256),
    );
  });

  it("rejects duplicate event identities in decisions and replay", () => {
    const instantiated = runEvent(
      instantiateContent(workflowGraph(1), canonicalValue({ source: "fixed-test" })),
    );
    const state = applyRunEvent(undefined, instantiated, deterministicSha256);
    const command = revisionCommand(state, workflowGraph(2), { approval: "approved" });
    const duplicateCommand = { ...command, eventId: instantiated.eventId };

    expectTransitionError("duplicate-event", () =>
      decideRunCommand(state, duplicateCommand, deterministicSha256),
    );
    expectTransitionError("duplicate-event", () =>
      applyRunEvent(state, instantiated, deterministicSha256),
    );
  });

  it("rejects wrong run and workflow identities in commands and events", () => {
    const graph = workflowGraph(1);
    const wrongWorkflowCommand = instantiateCommand(graph, { source: "fixed-test" });
    const commandWithWrongWorkflow = {
      ...wrongWorkflowCommand,
      workflowId: OTHER_WORKFLOW_ID,
    };
    expectTransitionError("identity-mismatch", () =>
      decideRunCommand(undefined, commandWithWrongWorkflow, deterministicSha256),
    );

    const state = instantiatedState();
    const wrongRunEvent = runEvent({
      ...revisionContent(state, workflowGraph(2), canonicalValue({ approval: "approved" })),
      runId: OTHER_RUN_ID,
    });
    expectTransitionError("identity-mismatch", () =>
      applyRunEvent(state, wrongRunEvent, deterministicSha256),
    );
  });

  it.each([
    [
      "before revision",
      "stale-revision" as const,
      (content: GraphRevisionAcceptedEventContent) => ({
        ...content,
        beforeRevisionDigest: sha256Digest("b".repeat(64)),
      }),
    ],
    [
      "after revision",
      "invalid-revision" as const,
      (content: GraphRevisionAcceptedEventContent) => ({
        ...content,
        afterRevisionDigest: sha256Digest("c".repeat(64)),
      }),
    ],
  ])("rejects an event with the wrong %s", (_name, code, mutate) => {
    const state = instantiatedState();
    const content = revisionContent(
      state,
      workflowGraph(2),
      canonicalValue({ approval: "approved" }),
    );

    expectTransitionError(code, () =>
      applyRunEvent(state, runEvent(mutate(content)), deterministicSha256),
    );
  });

  it("rejects event content or identity that does not match its supplied digest", () => {
    const event = runEvent(
      instantiateContent(workflowGraph(1), canonicalValue({ source: "fixed-test" })),
    );
    const alteredFacts = canonicalValue({ source: "altered" });
    const alteredContent = { ...event, facts: alteredFacts } as RunEvent;
    expectTransitionError("invalid-event-digest", () =>
      applyRunEvent(undefined, alteredContent, deterministicSha256),
    );

    const wrongIdentity = {
      ...event,
      eventId: eventId(`event_${"d".repeat(64)}`),
    } as RunEvent;
    expectTransitionError("invalid-event-identity", () =>
      applyRunEvent(undefined, wrongIdentity, deterministicSha256),
    );
  });

  it("maps fabricated command graphs to invalid-command", () => {
    const fabricated = {
      workflowId: WORKFLOW_ID,
      revisionDigest: "a".repeat(64),
      nodes: [],
      edges: [],
    } as unknown as WorkflowGraph;
    const command = instantiateCommand(fabricated, { source: "fixed-test" });

    expectTransitionError("invalid-command", () =>
      decideRunCommand(undefined, command, deterministicSha256),
    );
  });

  it("maps noncanonical command facts to invalid-command", () => {
    const command = instantiateCommand(workflowGraph(1), { source: "fixed-test" });
    const malformed = { ...command, facts: { value: undefined } };

    expectTransitionError("invalid-command", () =>
      decideRunCommand(undefined, malformed, deterministicSha256),
    );
  });

  it("maps malformed event timestamps to invalid-event", () => {
    const event = runEvent(
      instantiateContent(workflowGraph(1), canonicalValue({ source: "fixed-test" })),
    );
    const malformed = { ...event, occurredAt: "not-a-timestamp" } as RunEvent;

    expectTransitionError("invalid-event", () =>
      applyRunEvent(undefined, malformed, deterministicSha256),
    );
  });

  it("rejects forged event graph authority after verifying its recomputed event digest", () => {
    const graph = mutableGraph(workflowGraph(1));
    graph.edges.push({
      kind: "depends-on",
      from: taskId("task_primary"),
      to: taskId("task_primary"),
    });
    const content = instantiateContent(
      graph as unknown as WorkflowGraph,
      canonicalValue({ source: "fixed-test" }),
    );

    expectTransitionError("invalid-event", () =>
      applyRunEvent(undefined, runEvent(content), deterministicSha256),
    );
  });

  it("maps wrong graph digests and malformed graph brands in events to invalid-event", () => {
    const wrongDigest = mutableGraph(workflowGraph(1));
    wrongDigest.revisionDigest = "b".repeat(64);
    const malformedBrand = mutableGraph(workflowGraph(1));
    required(malformedBrand.nodes[0]).definition.id = "task_wrong-kind";

    expectTransitionError("invalid-event", () =>
      applyRunEvent(
        undefined,
        runEvent(
          instantiateContent(
            wrongDigest as unknown as WorkflowGraph,
            canonicalValue({ source: "fixed-test" }),
          ),
        ),
        deterministicSha256,
      ),
    );
    expectTransitionError("invalid-event", () =>
      applyRunEvent(
        undefined,
        runEvent(
          instantiateContent(
            malformedBrand as unknown as WorkflowGraph,
            canonicalValue({ source: "fixed-test" }),
          ),
        ),
        deterministicSha256,
      ),
    );
  });

  it("stores only recompiled graphs after apply and replay", () => {
    const mutableEvent = mutableRunEvent(
      runEvent(instantiateContent(workflowGraph(1), canonicalValue({ source: "fixed-test" }))),
    );
    const submittedEvent = mutableEvent as unknown as RunEvent;
    const applied = applyRunEvent(undefined, submittedEvent, deterministicSha256);
    const replayed = replayRunEvents([submittedEvent], deterministicSha256);
    required(mutableEvent.graph.nodes[0]).definition.input = { mutated: true };
    mutableEvent.graph.edges.length = 0;

    expect(applied.graph).toEqual(workflowGraph(1));
    expect(replayed.graph).toEqual(workflowGraph(1));
    expect(applied.graph).not.toBe(mutableEvent.graph);
    expect(replayed.graph).not.toBe(mutableEvent.graph);
  });
});

interface MutableGraph {
  workflowId: string;
  revisionDigest: string;
  nodes: Array<{ kind: string; definition: Record<string, unknown> }>;
  edges: Array<{ kind: string; from: string; to: string }>;
}

interface MutableRunEvent {
  graph: MutableGraph;
  [key: string]: unknown;
}

function mutableGraph(graph: WorkflowGraph): MutableGraph {
  return JSON.parse(JSON.stringify(graph)) as MutableGraph;
}

function mutableRunEvent(event: RunEvent): MutableRunEvent {
  return JSON.parse(JSON.stringify(event)) as MutableRunEvent;
}

function workflowGraph(revision: 1 | 2): WorkflowGraph {
  return compileWorkflowGraph(
    {
      workflow: {
        id: WORKFLOW_ID,
        key: consumerKey("fixed"),
        generation: definitionGeneration(1),
        source: { locator: "fixture://fixed", pointer: "" },
        input: { domain: "non-software", owner: "operations" },
      },
      phases: [
        {
          id: phaseId("phase_execute"),
          key: consumerKey("execute"),
          generation: definitionGeneration(1),
          parentId: WORKFLOW_ID,
          source: { locator: "fixture://fixed", pointer: "/phases/execute" },
        },
      ],
      executableWork: [
        {
          id: taskId("task_primary"),
          key: consumerKey("primary"),
          generation: definitionGeneration(1),
          parentId: phaseId("phase_execute"),
          source: { locator: "fixture://fixed", pointer: "/tasks/primary" },
          input: { action: "inspect" },
          completionPolicy: { criteria: [], evidencePolicy: { mode: "none", requirements: [] } },
        },
        ...(revision === 2
          ? [
              {
                id: taskId("task_followup"),
                key: consumerKey("followup"),
                generation: definitionGeneration(1),
                parentId: phaseId("phase_execute"),
                dependsOn: [taskId("task_primary")],
                source: { locator: "fixture://fixed", pointer: "/tasks/followup" },
                input: { action: "report" },
                completionPolicy: {
                  criteria: [],
                  evidencePolicy: { mode: "none" as const, requirements: [] },
                },
              },
            ]
          : []),
      ],
      criteria: [],
    },
    deterministicSha256,
  );
}

function instantiateCommand(graph: WorkflowGraph, facts: unknown): InstantiateRunCommand {
  const content = instantiateContent(graph, canonicalValue(facts));
  const metadata = eventMetadata(content);
  return {
    type: "instantiate-run",
    ...metadata,
    sequence: content.sequence,
    occurredAt: content.occurredAt,
    runId: content.runId,
    workflowId: content.workflowId,
    graph,
    facts,
  };
}

function revisionCommand(
  state: RunState,
  graph: WorkflowGraph,
  facts: unknown,
): AcceptGraphRevisionCommand {
  const content = revisionContent(state, graph, canonicalValue(facts));
  const metadata = eventMetadata(content);
  return {
    type: "accept-graph-revision",
    ...metadata,
    sequence: content.sequence,
    occurredAt: content.occurredAt,
    runId: content.runId,
    workflowId: content.workflowId,
    expectedRevisionDigest: state.revisionDigest,
    graph,
    facts,
  };
}

function instantiateContent(
  graph: WorkflowGraph,
  facts: CanonicalValue,
): RunInstantiatedEventContent {
  return {
    type: "run-instantiated",
    sequence: 1,
    occurredAt: INSTANTIATED_AT,
    runId: RUN_ID,
    workflowId: WORKFLOW_ID,
    revisionDigest: graph.revisionDigest,
    graph,
    facts,
  };
}

function revisionContent(
  state: RunState,
  graph: WorkflowGraph,
  facts: CanonicalValue,
): GraphRevisionAcceptedEventContent {
  return {
    type: "graph-revision-accepted",
    sequence: state.lastSequence + 1,
    occurredAt: REVISED_AT,
    runId: state.runId,
    workflowId: state.workflowId,
    beforeRevisionDigest: state.revisionDigest,
    afterRevisionDigest: graph.revisionDigest,
    graph,
    facts,
  };
}

function eventMetadata(content: RunEventContent): {
  readonly eventId: ReturnType<typeof eventId>;
  readonly eventContentDigest: Sha256Digest;
} {
  const eventContentDigest = digestRunEventContent(content, deterministicSha256);
  return {
    eventId: eventId(`event_${eventContentDigest}`),
    eventContentDigest,
  };
}

function runEvent(content: RunEventContent): RunEvent {
  const metadata = eventMetadata(content);
  return canonicalValue({
    ...content,
    eventId: metadata.eventId,
    contentDigest: metadata.eventContentDigest,
  }) as unknown as RunEvent;
}

function instantiatedState(): RunState {
  const event = runEvent(
    instantiateContent(workflowGraph(1), canonicalValue({ source: "fixed-test" })),
  );
  return applyRunEvent(undefined, event, deterministicSha256);
}

function expectTransitionError(code: RunTransitionErrorCode, action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RunTransitionError);
    expect((error as RunTransitionError).code).toBe(code);
    return;
  }
  throw new Error(`Expected run transition to fail with ${code}`);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("Expected a value");
  }
  return value;
}
