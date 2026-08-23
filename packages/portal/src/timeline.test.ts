import type { DurableReceipt, EventStreamFrame, PortalGraphNode } from "@senawa/protocol";
import { describe, expect, it } from "vitest";
import { momentTime, momentWhat, timelineMoments } from "./timeline.js";

function frame(overrides: Partial<EventStreamFrame>): EventStreamFrame {
  return {
    apiVersion: "1",
    cursor: 1,
    repositoryId: "repository_a",
    runId: "run_a",
    eventId: "event_a",
    eventType: "phase-started",
    occurredAt: "2026-08-21T04:23:44.118Z",
    payload: {},
    payloadDigest: "digest",
    ...overrides,
  } as EventStreamFrame;
}

const NODES: readonly PortalGraphNode[] = [
  { nodeId: "task_verify", title: "check the game rules" } as PortalGraphNode,
];

describe("timeline", () => {
  it("reads in cursor order however the events arrived", () => {
    const moments = timelineMoments(
      [frame({ cursor: 9, eventType: "phase-closed" }), frame({ cursor: 2 })],
      [],
    );
    expect(moments.map(({ cursor }) => cursor)).toEqual([2, 9]);
  });

  it("says what happened in words rather than in event types", () => {
    expect(momentWhat("phase-output-published")).toBe("output published");
    // An event nobody has written a word for still reads as words.
    expect(momentWhat("cohort-rebased")).toBe("cohort rebased");
  });

  it("names where it happened rather than identifying it", () => {
    const [moment] = timelineMoments([frame({ payload: { taskId: "task_verify" } })], NODES);
    expect(moment?.where).toBe("check the game rules");
  });

  it("falls back to the identity when the graph does not know the node", () => {
    const [moment] = timelineMoments([frame({ payload: { taskId: "task_absent" } })], NODES);
    expect(moment?.where).toBe("task_absent");
  });

  it("carries what was published as the moment's one detail", () => {
    const [moment] = timelineMoments(
      [
        frame({
          eventType: "phase-output-published",
          payload: { outputName: "plan", byteLength: 3627 },
        }),
      ],
      [],
    );
    expect(moment?.detail).toBe("plan, 3627 bytes");
  });

  it("tones a moment by what kind of thing it was", () => {
    const tones = timelineMoments(
      [
        frame({ cursor: 1, eventType: "phase-started" }),
        frame({ cursor: 2, eventType: "question-raised" }),
        frame({ cursor: 3, eventType: "phase-closed" }),
        frame({ cursor: 4, eventType: "task-failed" }),
        frame({ cursor: 5, eventType: "cohort-rebased" }),
      ],
      [],
    ).map(({ tone }) => tone);
    expect(tones).toEqual(["opened", "asked", "closed", "failed", "plain"]);
  });

  it("reads the clock in the same zone the record is written in", () => {
    expect(momentTime("2026-08-21T04:23:44.118Z")).toBe("04:23:44");
    // A record with no readable time says so rather than inventing one.
    expect(momentTime("not a time")).toBe("--:--:--");
  });

  it("says why a command was refused, and opens the receipt that says so", () => {
    const events = [
      frame({ cursor: 4, eventType: "command-queued", commandId: "command_close-implement-5" }),
      frame({ cursor: 5, eventType: "command-refused", commandId: "command_close-implement-5" }),
    ];
    const receipt = {
      commandId: "command_close-implement-5",
      status: "refused",
      error: { message: "candidate-exists: Completion cannot change after candidate creation" },
    } as unknown as DurableReceipt;

    const [moment] = timelineMoments(events, [], [], [receipt]);

    expect(moment?.detail).toBe(
      "candidate-exists: Completion cannot change after candidate creation",
    );
    // Opening the moment has to reach the receipt, because the frames only
    // ever carry the status they already announced.
    expect(moment?.record).toMatchObject({ receipt: { status: "refused" } });
  });

  it("leaves the frames as the record when no receipt was kept", () => {
    const [moment] = timelineMoments(
      [frame({ cursor: 4, eventType: "command-queued", commandId: "command_close-implement-5" })],
      [],
    );
    expect(moment?.detail).toBeUndefined();
    expect(moment?.record).toMatchObject({ eventType: "command-queued" });
  });
});
