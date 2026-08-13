import type { LeaseGrant } from "@senawa/storage-sqlite";
import type { SqliteSupervisorAuthority } from "./command-queue.js";
import type { SupervisorReceipt } from "./contracts.js";
import { SupervisorRunController } from "./run-controller.js";

export interface ForegroundRecoveryInput {
  readonly repositoryId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly currentTime: string;
}

export async function recoverRunOnce(
  authority: SqliteSupervisorAuthority,
  input: ForegroundRecoveryInput,
): Promise<{ readonly lease: LeaseGrant; readonly receipt?: SupervisorReceipt }> {
  const controller = new SupervisorRunController({ authority });
  const result = await controller.runOnceAsync({
    repositoryId: input.repositoryId,
    runId: input.runId,
    ownerId: input.ownerId,
    currentTime: () => input.currentTime,
    attemptId: `${input.ownerId}-direct-recovery`,
  });
  return {
    lease: result.lease,
    ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
  };
}
