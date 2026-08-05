import type { WorkerSessionPort, WorkerTurn } from "@senawa/application";
import { describe, expect, it } from "vitest";

export interface WorkerConformanceCase {
  readonly name: string;
  createAdapter(): WorkerSessionPort | Promise<WorkerSessionPort>;
}

export function runWorkerSessionConformance(
  cases: readonly WorkerConformanceCase[],
  baseTurn: WorkerTurn,
): void {
  describe.each(cases)("$name worker session conformance", ({ createAdapter }) => {
    it("supports caller-chosen create, resume, inspect, and archive-delete release", async () => {
      const adapter = await createAdapter();
      const created = await adapter.create(baseTurn);
      expect((await created.result).sessionId).toBe(baseTurn.sessionId);
      expect((await adapter.inspect(baseTurn)).state).toBe("completed");

      const resumedTurn = {
        ...baseTurn,
        operation: "resume" as const,
        turnId: `${baseTurn.turnId}-resume`,
      };
      const resumed = await adapter.resume(resumedTurn);
      expect((await resumed.result).sessionId).toBe(baseTurn.sessionId);
      expect((await adapter.inspect(resumedTurn)).state).toBe("completed");

      await adapter.release(baseTurn.sessionId, "archive-delete");
      expect((await adapter.inspect({ ...baseTurn, turnId: "unknown" })).state).toBe("missing");
    });
  });
}
