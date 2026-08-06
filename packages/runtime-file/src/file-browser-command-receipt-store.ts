import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, truncate } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  BrowserCommandClaimConflictError,
  BrowserCommandIdConflictError,
  BrowserCommandInProgressError,
  type BrowserCommandReceipt,
  type BrowserCommandReceiptError,
  type BrowserCommandReceiptStore,
  type LeaseStoragePort,
  type RunChangeNotificationPort,
} from "@senawa/application";
import {
  BrowserCommandReceiptSchema,
  type BrowserRunCommand,
  BrowserRunCommandSchema,
  type RuntimeLease,
} from "@senawa/domain";

type RunningBrowserCommandReceipt = Extract<BrowserCommandReceipt, { readonly status: "running" }>;
type CompletedBrowserCommandReceipt = Extract<
  BrowserCommandReceipt,
  { readonly status: "completed" }
>;

export class FileBrowserCommandReceiptStore implements BrowserCommandReceiptStore {
  private readonly trackingDirectory: string;

  constructor(
    repositoryRoot: string,
    private readonly leases: LeaseStoragePort,
    private readonly now: () => Date = () => new Date(),
    private readonly notifications?: RunChangeNotificationPort,
  ) {
    this.trackingDirectory = resolve(repositoryRoot, ".agents", ".copilot-tracking");
  }

  submit(runId: string, payload: BrowserRunCommand): Promise<BrowserCommandReceipt> {
    const parsed = BrowserRunCommandSchema.parse(payload);
    return this.update(runId, async (current, append) => {
      const digest = payloadDigest(parsed);
      const existing = current.get(parsed.commandId);
      if (existing !== undefined) {
        if (existing.payloadDigest !== digest) {
          throw new BrowserCommandIdConflictError(parsed.commandId);
        }
        return existing;
      }
      const active = [...current.values()].find((receipt) => isNonterminal(receipt.status));
      if (active !== undefined) throw new BrowserCommandInProgressError(active.commandId);
      const submittedAt = this.now().toISOString();
      return append({
        apiVersion: "senawa.dev/browser-command-receipt/v1",
        seq: 0,
        commandId: parsed.commandId,
        runId,
        payload: parsed,
        payloadDigest: digest,
        status: "queued",
        attempt: 0,
        submittedAt,
      });
    });
  }

  async get(runId: string, commandId: string): Promise<BrowserCommandReceipt | null> {
    assertCommandId(commandId);
    return structuredClone((await this.current(runId)).get(commandId) ?? null);
  }

  async active(runId: string): Promise<BrowserCommandReceipt | null> {
    const receipt = [...(await this.current(runId)).values()]
      .filter((candidate) => isNonterminal(candidate.status))
      .toSorted((left, right) => right.seq - left.seq)[0];
    return receipt === undefined ? null : structuredClone(receipt);
  }

  async read(
    runId: string,
    after: number,
    limit: number,
  ): Promise<readonly BrowserCommandReceipt[]> {
    validateReplay(after, limit);
    return (await readReceipts(this.path(runId)))
      .filter((receipt) => receipt.seq > after)
      .slice(0, limit)
      .map((receipt) => structuredClone(receipt));
  }

  claim(input: {
    readonly runId: string;
    readonly webLease: RuntimeLease;
    readonly ttlMs: number;
  }): Promise<BrowserCommandReceipt | null> {
    validateTtl(input.ttlMs);
    return this.update(input.runId, async (current, append) => {
      await this.assertWebLease(input.runId, input.webLease.owner, input.webLease.fence);
      const now = this.now();
      const active = [...current.values()]
        .filter((candidate) => isNonterminal(candidate.status))
        .toSorted((left, right) => left.seq - right.seq)[0];
      if (active === undefined) return null;
      if (
        active.status === "running" &&
        active.claimOwner === input.webLease.owner &&
        active.claimFence === input.webLease.fence &&
        active.claimExpiresAt !== undefined &&
        Date.parse(active.claimExpiresAt) > now.getTime()
      ) {
        return null;
      }
      return append({
        ...active,
        seq: 0,
        status: "running",
        attempt: active.attempt + 1,
        startedAt: now.toISOString(),
        claimOwner: input.webLease.owner,
        claimFence: input.webLease.fence,
        claimExpiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      });
    });
  }

  renewClaim(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly ttlMs: number;
  }): Promise<BrowserCommandReceipt> {
    validateTtl(input.ttlMs);
    return this.updateClaim(input, async (receipt, append) => {
      await this.assertWebLease(input.runId, input.claimOwner, input.claimFence);
      return append({
        ...receipt,
        seq: 0,
        claimExpiresAt: new Date(this.now().getTime() + input.ttlMs).toISOString(),
      });
    });
  }

  complete(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly result: CompletedBrowserCommandReceipt["result"];
  }): Promise<BrowserCommandReceipt> {
    return this.updateClaim(input, (receipt, append) =>
      append({
        ...receipt,
        seq: 0,
        status: "completed",
        completedAt: this.now().toISOString(),
        result: input.result,
      }),
    );
  }

  refuse(input: {
    readonly runId: string;
    readonly commandId: string;
    readonly claimOwner: string;
    readonly claimFence: number;
    readonly error: BrowserCommandReceiptError;
  }): Promise<BrowserCommandReceipt> {
    return this.updateClaim(input, (receipt, append) =>
      append({
        ...receipt,
        seq: 0,
        status: "refused",
        completedAt: this.now().toISOString(),
        error: input.error,
      }),
    );
  }

  private updateClaim(
    input: {
      readonly runId: string;
      readonly commandId: string;
      readonly claimOwner: string;
      readonly claimFence: number;
    },
    operation: (
      receipt: RunningBrowserCommandReceipt,
      append: (receipt: BrowserCommandReceipt) => Promise<BrowserCommandReceipt>,
    ) => Promise<BrowserCommandReceipt> | BrowserCommandReceipt,
  ): Promise<BrowserCommandReceipt> {
    assertCommandId(input.commandId);
    return this.update(input.runId, async (current, append) => {
      await this.assertWebLease(input.runId, input.claimOwner, input.claimFence);
      const receipt = current.get(input.commandId);
      if (receipt === undefined || receipt.status !== "running") {
        throw new BrowserCommandClaimConflictError(input.commandId);
      }
      if (
        receipt.claimOwner !== input.claimOwner ||
        receipt.claimFence !== input.claimFence ||
        Date.parse(receipt.claimExpiresAt) <= this.now().getTime()
      ) {
        throw new BrowserCommandClaimConflictError(input.commandId);
      }
      return operation(receipt, append);
    });
  }

  private async assertWebLease(runId: string, owner: string, fence: number): Promise<void> {
    const lease = await this.leases.inspectLease(runId, "web");
    if (
      lease === null ||
      lease.owner !== owner ||
      lease.fence !== fence ||
      Date.parse(lease.expiresAt) <= this.now().getTime()
    ) {
      throw new BrowserCommandClaimConflictError("active");
    }
  }

  private async current(runId: string): Promise<Map<string, BrowserCommandReceipt>> {
    const current = new Map<string, BrowserCommandReceipt>();
    for (const receipt of await readReceipts(this.path(runId))) {
      current.set(receipt.commandId, receipt);
    }
    return current;
  }

  private update<T>(
    runId: string,
    operation: (
      current: Map<string, BrowserCommandReceipt>,
      append: (receipt: BrowserCommandReceipt) => Promise<BrowserCommandReceipt>,
    ) => Promise<T>,
  ): Promise<T> {
    const path = this.path(runId);
    return withLock(`${path}.lock`, async () => {
      const receipts = await readReceipts(path);
      const current = new Map<string, BrowserCommandReceipt>();
      for (const receipt of receipts) current.set(receipt.commandId, receipt);
      const append = async (receipt: BrowserCommandReceipt) => {
        const assigned = { ...receipt, seq: (receipts.at(-1)?.seq ?? 0) + 1 };
        await appendReceipt(path, assigned);
        receipts.push(assigned);
        current.set(assigned.commandId, assigned);
        this.notifications?.publishRunChanged(runId);
        return structuredClone(assigned);
      };
      return operation(current, append);
    });
  }

  private path(runId: string): string {
    assertIdentifier(runId, "run ID");
    return join(this.trackingDirectory, runId, "browser-commands.jsonl");
  }
}

function isNonterminal(status: BrowserCommandReceipt["status"]): boolean {
  return status === "queued" || status === "running";
}

function payloadDigest(payload: BrowserRunCommand): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function appendReceipt(path: string, receipt: BrowserCommandReceipt): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await discardIncompleteTail(path);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readReceipts(path: string): Promise<BrowserCommandReceipt[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const completeContent = content.endsWith("\n")
    ? content
    : content.slice(0, Math.max(0, content.lastIndexOf("\n") + 1));
  return completeContent
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => BrowserCommandReceiptSchema.parse(JSON.parse(line)));
}

async function withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
        return await operation();
      } finally {
        await handle.close();
        await rm(path, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const lockStat = await stat(path).catch(() => null);
      if (
        lockStat !== null &&
        ((await localLockOwnerIsDead(path)) || Date.now() - lockStat.mtimeMs > 30_000)
      ) {
        await rm(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${path}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
}

async function discardIncompleteTail(path: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (content.endsWith("\n")) return;
  const completeContent = content.slice(0, Math.max(0, content.lastIndexOf("\n") + 1));
  await truncate(path, Buffer.byteLength(completeContent));
}

async function localLockOwnerIsDead(path: string): Promise<boolean> {
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  const match = /^(\d+):[0-9a-f-]+\s*$/u.exec(value);
  if (match?.[1] === undefined) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error, "ESRCH");
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function assertCommandId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`Invalid command ID: ${value}`);
  }
}

function validateTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
    throw new Error("Command claim TTL must be positive");
}

function validateReplay(after: number, limit: number): void {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid receipt replay cursor");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("Invalid receipt replay limit");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
