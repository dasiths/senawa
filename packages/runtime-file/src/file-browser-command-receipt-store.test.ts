import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrowserCommandClaimConflictError,
  BrowserCommandIdConflictError,
  BrowserCommandInProgressError,
  type RunChangeNotificationPort,
} from "@senawa/application";
import type { BrowserRunCommand } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import { FileBrowserCommandReceiptStore } from "./file-browser-command-receipt-store.js";
import { FileLeaseStore } from "./file-run-persistence.js";

const firstCommandId = "11111111-1111-4111-8111-111111111111";
const secondCommandId = "22222222-2222-4222-8222-222222222222";

describe("file browser command receipt store", () => {
  it("submits idempotently and conflicts on changed payload or another active command", async () => {
    const fixture = await createFixture();
    const command = resumeCommand(firstCommandId);

    const submitted = await fixture.store.submit(fixture.runId, command);
    const replayed = await fixture.store.submit(fixture.runId, command);

    expect(replayed).toEqual(submitted);
    await expect(
      fixture.store.submit(fixture.runId, {
        apiVersion: "senawa.dev/browser-command/v1",
        commandId: firstCommandId,
        command: "end",
        reason: "Changed payload",
      }),
    ).rejects.toBeInstanceOf(BrowserCommandIdConflictError);
    await expect(
      fixture.store.submit(fixture.runId, resumeCommand(secondCommandId)),
    ).rejects.toBeInstanceOf(BrowserCommandInProgressError);
  });

  it("persists terminal receipts and permits the next command", async () => {
    const fixture = await createFixture();
    await fixture.store.submit(fixture.runId, resumeCommand(firstCommandId));
    const lease = await fixture.leases.acquireLease(fixture.runId, "web", "web-one", 10_000);
    const claimed = await fixture.store.claim({
      runId: fixture.runId,
      webLease: lease,
      ttlMs: 5_000,
    });
    if (claimed === null) throw new Error("Expected a receipt claim");
    await fixture.store.complete({
      runId: fixture.runId,
      commandId: claimed.commandId,
      claimOwner: lease.owner,
      claimFence: lease.fence,
      result: { runId: fixture.runId, kind: "idle" },
    });

    const reopened = new FileBrowserCommandReceiptStore(
      fixture.root,
      new FileLeaseStore(fixture.root, fixture.now),
      fixture.now,
    );
    expect(await reopened.get(fixture.runId, firstCommandId)).toMatchObject({
      status: "completed",
      seq: 3,
      result: { kind: "idle" },
    });
    expect(await reopened.active(fixture.runId)).toBeNull();
    await expect(
      reopened.submit(fixture.runId, resumeCommand(secondCommandId)),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("replays durable receipt records after a cursor and notifies only for appends", async () => {
    const fixture = await createFixture();
    const observed: number[] = [];
    const unsubscribe = fixture.notifier.subscribe((changedRunId) => {
      if (changedRunId !== fixture.runId) return;
      void fixture.store.read(fixture.runId, 0, 500).then((receipts) => {
        observed.push(receipts.at(-1)?.seq ?? 0);
      });
    });
    const command = resumeCommand(firstCommandId);
    const submitted = await fixture.store.submit(fixture.runId, command);
    await fixture.store.submit(fixture.runId, command);
    const lease = await fixture.leases.acquireLease(fixture.runId, "web", "web-replay", 10_000);
    const claimed = await fixture.store.claim({
      runId: fixture.runId,
      webLease: lease,
      ttlMs: 5_000,
    });
    if (claimed === null) throw new Error("Expected a receipt claim");
    await fixture.store.renewClaim({
      runId: fixture.runId,
      commandId: claimed.commandId,
      claimOwner: lease.owner,
      claimFence: lease.fence,
      ttlMs: 5_000,
    });
    await fixture.store.complete({
      runId: fixture.runId,
      commandId: claimed.commandId,
      claimOwner: lease.owner,
      claimFence: lease.fence,
      result: { runId: fixture.runId, kind: "idle" },
    });
    unsubscribe();

    expect(submitted.seq).toBe(1);
    expect((await fixture.store.read(fixture.runId, 1, 2)).map((receipt) => receipt.seq)).toEqual([
      2, 3,
    ]);
    expect((await fixture.store.read(fixture.runId, 3, 500)).map((receipt) => receipt.seq)).toEqual(
      [4],
    );
    await expect(fixture.store.read(fixture.runId, -1, 1)).rejects.toThrow(
      "Invalid receipt replay cursor",
    );

    const reopened = new FileBrowserCommandReceiptStore(
      fixture.root,
      new FileLeaseStore(fixture.root, fixture.now),
      fixture.now,
    );
    await expect(reopened.read(fixture.runId, 3, 1)).resolves.toEqual([
      expect.objectContaining({ seq: 4, status: "completed" }),
    ]);
    await expect.poll(() => observed).toEqual([1, 2, 3, 4]);
  });

  it("reclaims expired running receipts and rejects stale-fence completion", async () => {
    const fixture = await createFixture();
    await fixture.store.submit(fixture.runId, resumeCommand(firstCommandId));
    const firstLease = await fixture.leases.acquireLease(fixture.runId, "web", "web-one", 100);
    await fixture.store.claim({ runId: fixture.runId, webLease: firstLease, ttlMs: 100 });

    fixture.advance(101);
    const secondLease = await fixture.leases.acquireLease(fixture.runId, "web", "web-two", 1_000);
    const reclaimed = await fixture.store.claim({
      runId: fixture.runId,
      webLease: secondLease,
      ttlMs: 500,
    });
    expect(reclaimed).toMatchObject({
      status: "running",
      attempt: 2,
      claimOwner: "web-two",
      claimFence: 2,
    });
    await expect(
      fixture.store.complete({
        runId: fixture.runId,
        commandId: firstCommandId,
        claimOwner: firstLease.owner,
        claimFence: firstLease.fence,
        result: { runId: fixture.runId, kind: "idle" },
      }),
    ).rejects.toBeInstanceOf(BrowserCommandClaimConflictError);
  });

  it("recovers an incomplete tail and a dead local lock", async () => {
    const fixture = await createFixture();
    await fixture.store.submit(fixture.runId, resumeCommand(firstCommandId));
    const directory = join(fixture.root, ".agents", ".copilot-tracking", fixture.runId);
    const receiptPath = join(directory, "browser-commands.jsonl");
    await appendFile(receiptPath, '{"incomplete":', "utf8");
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${receiptPath}.lock`,
      "2147483647:88888888-8888-4888-8888-888888888888\n",
      "utf8",
    );

    expect(await fixture.store.get(fixture.runId, firstCommandId)).toMatchObject({
      status: "queued",
    });
    const lease = await fixture.leases.acquireLease(fixture.runId, "web", "web-recovery", 1_000);
    await expect(
      fixture.store.claim({ runId: fixture.runId, webLease: lease, ttlMs: 500 }),
    ).resolves.toMatchObject({ status: "running" });
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "senawa-browser-command-"));
  const runId = "receipt-run";
  let timestamp = Date.parse("2026-08-06T12:00:00.000Z");
  const now = () => new Date(timestamp);
  const leases = new FileLeaseStore(root, now);
  const notifier = new TestNotifier();
  return {
    root,
    runId,
    now,
    leases,
    notifier,
    store: new FileBrowserCommandReceiptStore(root, leases, now, notifier),
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
  };
}

class TestNotifier implements RunChangeNotificationPort {
  private readonly listeners = new Set<(runId: string) => void>();

  subscribe(listener: (runId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishRunChanged(runId: string): void {
    for (const listener of this.listeners) listener(runId);
  }
}

function resumeCommand(commandId: string): BrowserRunCommand {
  return { apiVersion: "senawa.dev/browser-command/v1", commandId, command: "resume" };
}
