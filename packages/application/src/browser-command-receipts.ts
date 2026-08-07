import type {
  BrowserCommandReceipt,
  BrowserCommandReceiptError,
  BrowserRunCommand,
  RuntimeLease,
} from "@senawa/domain";
import type { SchedulerPort } from "./ports.js";
import type { TransitionResult } from "./run-services.js";

export type { BrowserCommandReceipt, BrowserCommandReceiptError } from "@senawa/domain";

export interface BrowserCommandReceiptStore {
  submit(runId: string, payload: BrowserRunCommand): Promise<BrowserCommandReceipt>;
  get(runId: string, commandId: string): Promise<BrowserCommandReceipt | null>;
  active(runId: string): Promise<BrowserCommandReceipt | null>;
  read(runId: string, after: number, limit: number): Promise<readonly BrowserCommandReceipt[]>;
  claim(input: {
    readonly runId: string;
    readonly webLease: RuntimeLease;
    readonly ttlMs: number;
  }): Promise<BrowserCommandReceipt | null>;
  renewClaim(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly ttlMs: number;
  }): Promise<BrowserCommandReceipt>;
  complete(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly result: TransitionResult;
  }): Promise<BrowserCommandReceipt>;
  refuse(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly error: BrowserCommandReceiptError;
  }): Promise<BrowserCommandReceipt>;
}

export class BrowserCommandIdConflictError extends Error {
  constructor(readonly commandId: string) {
    super(`Command ID ${commandId} was submitted with different content`);
    this.name = "BrowserCommandIdConflictError";
  }
}

export class BrowserCommandInProgressError extends Error {
  constructor(readonly commandId: string) {
    super(`Command ${commandId} is already in progress`);
    this.name = "BrowserCommandInProgressError";
  }
}

export class BrowserCommandClaimConflictError extends Error {
  constructor(readonly commandId: string) {
    super(`Command ${commandId} is not held by the current web supervisor claim`);
    this.name = "BrowserCommandClaimConflictError";
  }
}

export interface BrowserCommandExecutor {
  executeBrowserCommand(runId: string, payload: BrowserRunCommand): Promise<TransitionResult>;
}

export class DurableBrowserCommandService {
  constructor(
    private readonly receiptStore: BrowserCommandReceiptStore,
    private readonly commands: BrowserCommandExecutor,
    private readonly scheduler: SchedulerPort,
  ) {}

  submit(runId: string, payload: BrowserRunCommand): Promise<BrowserCommandReceipt> {
    return this.receiptStore.submit(runId, payload);
  }

  receipt(runId: string, commandId: string): Promise<BrowserCommandReceipt | null> {
    return this.receiptStore.get(runId, commandId);
  }

  activeReceipt(runId: string): Promise<BrowserCommandReceipt | null> {
    return this.receiptStore.active(runId);
  }

  receipts(runId: string, after: number, limit: number): Promise<readonly BrowserCommandReceipt[]> {
    return this.receiptStore.read(runId, after, limit);
  }

  async processNext(runId: string, webLease: RuntimeLease, claimTtlMs: number): Promise<boolean> {
    const receipt = await this.receiptStore.claim({ runId, webLease, ttlMs: claimTtlMs });
    if (receipt === null) return false;
    const claim = {
      runId,
      commandId: receipt.commandId,
      claimOwner: webLease.owner,
      claimFence: webLease.fence,
    };
    let claimFailure: unknown;
    const stopHeartbeat = this.scheduler.scheduleEvery(
      Math.max(1_000, Math.floor(claimTtlMs / 3)),
      () => {
        void this.receiptStore
          .renewClaim({ ...claim, ttlMs: claimTtlMs })
          .catch((error: unknown) => {
            claimFailure = error;
          });
      },
    );
    try {
      const result = await this.commands.executeBrowserCommand(runId, receipt.payload);
      if (claimFailure !== undefined) throw claimFailure;
      await this.receiptStore.complete({ ...claim, result });
    } catch (error) {
      if (claimFailure === undefined) {
        await this.receiptStore
          .refuse({ ...claim, error: sanitizedCommandError(error) })
          .catch(() => undefined);
      }
    } finally {
      stopHeartbeat();
    }
    return true;
  }
}

function sanitizedCommandError(error: unknown): BrowserCommandReceiptError {
  const message = error instanceof Error ? error.message : "";
  const publicMessage = /^(?:Cannot |No active |Phase |Run |Task |The run )/u.test(message)
    ? message.replace(/[\r\n\t]+/gu, " ").slice(0, 500)
    : "The command could not be completed";
  return { code: "command_refused", message: publicMessage };
}
