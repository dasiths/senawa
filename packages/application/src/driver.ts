import type { CommandActor } from "@senawa/domain";
import type { TransitionResult } from "./run-services.js";

export interface RunDriver {
  drive(runId: string, actor: CommandActor, maxTransitions?: number): Promise<TransitionResult>;
  advance(runId: string, actor: CommandActor): Promise<TransitionResult>;
}
