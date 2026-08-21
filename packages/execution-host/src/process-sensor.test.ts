import { constants as fsConstants, readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  open,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ExecutableSensorCommand,
  type ExecutableSensorMeasurementRequest,
  measureExecutableSensor,
  PROCESS_SECURITY_LIMITS,
} from "./process-sensor.js";

const helper = new URL("./test-fixtures/process-helper.mjs", import.meta.url).pathname;
const supervisor = new URL("../dist/senawa-process-supervisor", import.meta.url).pathname;
const liveProcessIds = new Set<number>();

afterEach(() => {
  for (const processId of liveProcessIds) {
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  liveProcessIds.clear();
});

describe("measureExecutableSensor", () => {
  it("preserves literal argv values without shell interpretation", async () => {
    const root = await temporaryRoot();
    const values = ["", "two words", "$(touch should-not-exist)", "; echo no"];
    const outcome = await measureExecutableSensor(request(root, command("argv", ...values)));

    expect(outcome).toMatchObject({ type: "measurement" });
    if (outcome.type !== "measurement") return;
    expect(JSON.parse(outcome.measurement.stdout.text)).toEqual(values);
    expect(outcome.measurement.exitCode).toBe(0);
  });

  it("builds the environment only from inherited names and the ambient map", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor({
      ...request(root, command("env")),
      ambientEnvironment: { ALLOWED: "present", NOT_ALLOWED: "absent" },
      command: { ...command("env"), inheritedEnvironment: ["ALLOWED"] },
    });

    expect(outcome).toMatchObject({ type: "measurement" });
    if (outcome.type !== "measurement") return;
    expect(JSON.parse(outcome.measurement.stdout.text)).toEqual({ ALLOWED: "present" });
  });

  it("requires inherited PATH for a bare executable", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor({
      ...request(root, command("argv")),
      command: { ...command("argv"), argv: ["node", helper, "argv"] },
      ambientEnvironment: { PATH: process.env.PATH },
    });

    expect(outcome).toMatchObject({
      type: "failure",
      failure: { code: "invalid-request" },
    });
  });

  it("bounds output prefixes while draining and counting both streams", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(
      request(root, { ...command("output", "2000000"), maxStdoutBytes: 17, maxStderrBytes: 19 }),
    );

    expect(outcome).toMatchObject({ type: "measurement" });
    if (outcome.type !== "measurement") return;
    expect(outcome.measurement.stdout).toEqual({
      text: "o".repeat(17),
      capturedBytes: 17,
      totalBytes: 2_000_000,
      truncated: true,
    });
    expect(outcome.measurement.stderr).toEqual({
      text: "e".repeat(19),
      capturedBytes: 19,
      totalBytes: 2_000_000,
      truncated: true,
    });
  });

  it.each([
    [1, ""],
    [2, ""],
    [3, "€"],
  ])("omits an incomplete trailing UTF-8 sequence at a %i byte limit", async (limit, text) => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(
      request(root, { ...command("euro"), maxStdoutBytes: limit }),
    );

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: {
        stdout: { text, capturedBytes: limit, totalBytes: 3, truncated: limit < 3 },
      },
    });
  });

  it("decodes invalid interior UTF-8 bytes with replacement characters", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(request(root, command("invalid-utf8")));

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: { stdout: { text: "a�b", capturedBytes: 3, totalBytes: 3 } },
    });
  });

  it("rejects timer and output bounds that exceed adapter limits", async () => {
    const root = await temporaryRoot();
    const delayedTimeout = await measureExecutableSensor(
      request(root, { ...command("wait"), timeoutMs: 2_147_483_648 }),
    );
    const excessiveOutput = await measureExecutableSensor(
      request(root, { ...command("wait"), maxStdoutBytes: 64 * 1024 * 1024 + 1 }),
    );

    expect(delayedTimeout).toMatchObject({
      type: "failure",
      failure: { code: "invalid-request" },
    });
    expect(excessiveOutput).toMatchObject({
      type: "failure",
      failure: { code: "invalid-request" },
    });
  });

  it("enforces argv and allowlisted environment count and UTF-8 byte ceilings", async () => {
    const root = await temporaryRoot();
    const atArgumentCount = command("argv", ...Array.from({ length: 253 }, () => ""));
    expect(atArgumentCount.argv).toHaveLength(PROCESS_SECURITY_LIMITS.maxArguments);
    await expect(measureExecutableSensor(request(root, atArgumentCount))).resolves.toMatchObject({
      type: "measurement",
    });
    await expect(
      measureExecutableSensor(
        request(root, command("argv", ...Array.from({ length: 254 }, () => ""))),
      ),
    ).resolves.toMatchObject({ type: "failure", failure: { code: "invalid-request" } });

    const baseBytes = command("argv").argv.reduce(
      (total, argument) => total + Buffer.byteLength(argument),
      0,
    );
    const byteLimit = "x".repeat(PROCESS_SECURITY_LIMITS.maxArgumentBytes - baseBytes);
    await expect(
      measureExecutableSensor(request(root, command("argv", byteLimit))),
    ).resolves.toMatchObject({ type: "measurement" });
    await expect(
      measureExecutableSensor(request(root, command("argv", `${byteLimit}€`))),
    ).resolves.toMatchObject({ type: "failure", failure: { code: "invalid-request" } });

    const names = Array.from(
      { length: PROCESS_SECURITY_LIMITS.maxEnvironmentEntries },
      (_, index) => `V${index}`,
    );
    const ambient = Object.fromEntries(names.map((name) => [name, ""]));
    await expect(
      measureExecutableSensor({
        ...request(root, command("env")),
        command: { ...command("env"), inheritedEnvironment: names },
        ambientEnvironment: ambient,
      }),
    ).resolves.toMatchObject({ type: "measurement" });
    await expect(
      measureExecutableSensor({
        ...request(root, command("env")),
        command: { ...command("env"), inheritedEnvironment: [...names, "OVER"] },
        ambientEnvironment: { ...ambient, OVER: "" },
      }),
    ).resolves.toMatchObject({ type: "failure", failure: { code: "invalid-request" } });

    const environmentValue = "€".repeat(
      Math.floor((PROCESS_SECURITY_LIMITS.maxEnvironmentBytes - 1) / 3),
    );
    await expect(
      measureExecutableSensor({
        ...request(root, command("env")),
        command: { ...command("env"), inheritedEnvironment: ["V"] },
        ambientEnvironment: { V: environmentValue },
      }),
    ).resolves.toMatchObject({ type: "measurement" });
    await expect(
      measureExecutableSensor({
        ...request(root, command("env")),
        command: { ...command("env"), inheritedEnvironment: ["V"] },
        ambientEnvironment: { V: `${environmentValue}€` },
      }),
    ).resolves.toMatchObject({ type: "failure", failure: { code: "invalid-request" } });
  });

  it("returns nonzero exits and signals as measurements", async () => {
    const root = await temporaryRoot();
    const nonzero = await measureExecutableSensor(request(root, command("nonzero", "23")));
    const signalled = await measureExecutableSensor(request(root, command("signal")));

    expect(nonzero).toMatchObject({ type: "measurement", measurement: { exitCode: 23 } });
    expect(signalled).toMatchObject({
      type: "measurement",
      measurement: { exitCode: null, signal: "SIGTERM" },
    });
  });

  it("terminates a timed-out process group", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(
      request(root, { ...command("wait"), timeoutMs: 50 }),
    );

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: { timedOut: true, cancelled: false, cleanup: "terminated" },
    });
  });

  it("forces a timed-out process group that ignores SIGTERM", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor({
      // Long enough that a loaded machine still reaches the grace period, short
      // enough that the test is not waiting on it.
      ...request(root, { ...command("ignore-term"), timeoutMs: 1_000 }),
      terminationGraceMs: 250,
    });

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: { timedOut: true, cleanup: "forced", signal: "SIGKILL" },
    });
  });

  it("supports AbortSignal cancellation as a measurement", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const outcome = await measureExecutableSensor({
      ...request(root, command("wait")),
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: { timedOut: false, cancelled: true, cleanup: "terminated" },
    });
  });

  it("reports spawn failures as failures", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor({
      ...request(root, command("argv")),
      command: { ...command("argv"), argv: [join(root, "missing-executable")] },
    });

    expect(outcome).toMatchObject({ type: "failure", failure: { code: "spawn-failed" } });
  });

  it("settles an early missing-supervisor error without an uncaught event", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(request(root, command("argv")), {
      supervisorPath: join(root, "missing-supervisor"),
      realpath,
      openRoot(path) {
        return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      },
    });

    expect(outcome).toMatchObject({ type: "failure", failure: { code: "spawn-failed" } });
  });

  it("observes cancellation during asynchronous setup before opening the root", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    let releaseRealpath: (() => void) | undefined;
    let rootOpened = false;
    const delayedRealpath = new Promise<string>((resolve) => {
      releaseRealpath = () => resolve(root);
    });
    const measurement = measureExecutableSensor(
      { ...request(root, command("wait")), signal: controller.signal },
      {
        supervisorPath: join(root, "must-not-spawn"),
        realpath() {
          return delayedRealpath;
        },
        async openRoot(path) {
          rootOpened = true;
          return open(
            path,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          );
        },
      },
    );

    controller.abort();
    releaseRealpath?.();
    await expect(measurement).resolves.toMatchObject({
      type: "measurement",
      measurement: { cancelled: true, timedOut: false, cleanup: "not-needed" },
    });
    expect(rootOpened).toBe(false);
  });

  it("refuses the thirty-third active process before setup", async () => {
    const root = await temporaryRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let allEntered: (() => void) | undefined;
    const enteredLimit = new Promise<void>((resolve) => {
      allEntered = resolve;
    });
    const dependencies = {
      supervisorPath: supervisor,
      async realpath(path: string) {
        entered += 1;
        if (entered === PROCESS_SECURITY_LIMITS.maxActiveProcesses) allEntered?.();
        await gate;
        return path;
      },
      openRoot(path: string) {
        return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      },
    };
    const active = Array.from({ length: PROCESS_SECURITY_LIMITS.maxActiveProcesses }, () =>
      measureExecutableSensor(request(root, command("argv")), dependencies),
    );
    await enteredLimit;
    await expect(
      measureExecutableSensor(request(root, command("argv")), dependencies),
    ).resolves.toMatchObject({
      type: "failure",
      failure: { code: "invalid-request", message: expect.stringContaining("capacity") },
    });
    release?.();
    await expect(Promise.all(active)).resolves.toHaveLength(
      PROCESS_SECURITY_LIMITS.maxActiveProcesses,
    );
  });

  it("queues cancellation in the post-spawn handoff until the supervisor is ready", async () => {
    const root = await temporaryRoot();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const controller = new AbortController();
      const outcome = await measureExecutableSensor(
        { ...request(root, command("wait")), signal: controller.signal },
        {
          supervisorPath: supervisor,
          realpath,
          openRoot(path) {
            return open(
              path,
              fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
            );
          },
          onSupervisorSpawned() {
            controller.abort();
          },
        },
      );

      expect(outcome).toMatchObject({
        type: "measurement",
        measurement: { cancelled: true, timedOut: false, cleanup: "terminated" },
      });
    }
  });

  it.each([
    [
      "duplicate readiness",
      "SENAWA1\tresult=ready\nSENAWA1\tresult=ready\nSENAWA1\tresult=command\tcode=0\tsignal=0\tcleanup=not-needed\n",
    ],
    [
      "readiness after terminal",
      "SENAWA1\tresult=command\tcode=0\tsignal=0\tcleanup=not-needed\nSENAWA1\tresult=ready\n",
    ],
    [
      "blank frame",
      "SENAWA1\tresult=ready\n\nSENAWA1\tresult=command\tcode=0\tsignal=0\tcleanup=not-needed\n",
    ],
    [
      "unterminated terminal",
      "SENAWA1\tresult=ready\nSENAWA1\tresult=command\tcode=0\tsignal=0\tcleanup=not-needed",
    ],
    [
      "truncated status",
      `SENAWA1\tresult=ready\nSENAWA1\tresult=command\tcode=0\tsignal=0\tcleanup=not-needed\n${"\n".repeat(5_000)}`,
    ],
  ])("rejects a %s supervisor status stream", async (_name, statusText) => {
    const root = await temporaryRoot();
    const fakeSupervisor = await writeFakeSupervisor(root, statusText);
    const outcome = await measureExecutableSensor(request(root, command("argv")), {
      supervisorPath: fakeSupervisor,
      realpath,
      openRoot(path) {
        return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      },
    });

    expect(outcome).toMatchObject({ type: "failure", failure: { code: "setup-failed" } });
  });

  it("rejects a cwd symlink that escapes the real root", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(await realpath(outside), join(root, "escape"), "dir");
    const outcome = await measureExecutableSensor({
      ...request(root, command("argv")),
      command: { ...command("argv"), cwd: "escape" },
    });

    expect(outcome).toMatchObject({ type: "failure", failure: { code: "cwd-escape" } });
  });

  it.each([
    ["timeout", "tree-timeout", 1_000],
    ["leader exit", "tree-exit", 2_000],
  ])("cleans child and grandchild processes after %s", async (_name, mode, timeoutMs) => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(
      request(root, { ...command(mode, root), timeoutMs }),
    );
    const processIds = await readTreeProcessIds(root);
    processIds.forEach((processId) => {
      liveProcessIds.add(processId);
    });

    expect(outcome).toMatchObject({ type: "measurement" });
    expect(processIds).toHaveLength(2);
    expect(await Promise.all(processIds.map(processIsAbsent))).toEqual([true, true]);
    processIds.forEach((processId) => {
      liveProcessIds.delete(processId);
    });
  });

  it("adopts, kills, and reaps a setsid descendant", async () => {
    const root = await temporaryRoot();
    const outcome = await measureExecutableSensor(
      request(root, { ...command("tree-setsid", root), timeoutMs: 2_000 }),
    );
    const processId = Number(await readFile(join(root, "setsid.pid"), "utf8"));
    liveProcessIds.add(processId);

    expect(outcome).toMatchObject({
      type: "measurement",
      measurement: { exitCode: 0, cleanup: "forced" },
    });
    expect(await processIsAbsent(processId)).toBe(true);
    liveProcessIds.delete(processId);
  });

  it("repeatedly reaps complete trees without zombie or supervisor residue", async () => {
    const zombieBaseline = directZombieCount();
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const root = await temporaryRoot();
      // Generous, because this test is about what is left behind rather than
      // about a budget: a tighter one kills the tree on a loaded machine before
      // the grandchild has recorded itself, and then there is nothing to check.
      const outcome = await measureExecutableSensor(
        request(root, { ...command("tree-exit", root), timeoutMs: 15_000 }),
      );
      expect(outcome).toMatchObject({ type: "measurement" });
      const processIds = await readTreeProcessIds(root);
      expect(await Promise.all(processIds.map(processIsAbsent))).toEqual([true, true]);
    }
    // Generous, because this asks about every child of the worker rather than
    // about the processes this test started, and a loaded machine reaps late.
    expect(await settles(() => directZombieCount() <= zombieBaseline, 30_000)).toBe(true);
    expect(await settles(() => directSupervisorProcessIds().length === 0, 30_000)).toBe(true);
  });
});

function command(mode: string, ...arguments_: string[]): ExecutableSensorCommand {
  return {
    argv: [process.execPath, helper, mode, ...arguments_],
    cwd: ".",
    timeoutMs: 2_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    inheritedEnvironment: [],
  };
}

function request(
  rootDirectory: string,
  sensorCommand: ExecutableSensorCommand,
): ExecutableSensorMeasurementRequest {
  return {
    rootDirectory,
    command: sensorCommand,
    ambientEnvironment: {},
    terminationGraceMs: 500,
  };
}

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "senawa-execution-host-"));
}

async function writeFakeSupervisor(root: string, statusText: string): Promise<string> {
  const path = join(root, "fake-supervisor.mjs");
  await writeFile(
    path,
    `#!${process.execPath}\nimport { writeSync } from "node:fs";\nwriteSync(3, ${JSON.stringify(statusText)});\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return path;
}

// The helper writes these as it starts, so a loaded machine can return from the
// sensor before the grandchild has recorded itself. Reading them once made the
// test fail on a missing file rather than on anything the sensor did.
async function readTreeProcessIds(root: string): Promise<number[]> {
  const paths = ["child.pid", "grandchild.pid"];
  let recorded: number[] = [];
  await settles(async () => {
    try {
      recorded = await Promise.all(
        paths.map(async (path) => Number(await readFile(join(root, path), "utf8"))),
      );
    } catch {
      return false;
    }
    return recorded.every((processId) => Number.isSafeInteger(processId) && processId > 0);
  });
  return recorded;
}

// Reaping is asynchronous, so "is it gone" is a question with a settling time.
// Asked the instant the sensor returned, these assertions held on a quiet
// machine and failed under a loaded one, which is a test that measures the
// machine rather than the code. What the sensor promises is that nothing is left
// behind, not that nothing is left behind within one event loop turn.
async function settles(
  holds: () => Promise<boolean> | boolean,
  withinMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (await holds()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processIsAbsent(processId: number): Promise<boolean> {
  return settles(async () => {
    try {
      await access(`/proc/${processId}`);
      return false;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  }, 30_000);
}

function directZombieCount(): number {
  return directProcessEntries().filter(({ stat }) => processState(stat) === "Z").length;
}

function directSupervisorProcessIds(): number[] {
  return directProcessEntries()
    .filter(({ command }) => command.includes("senawa-process-supervisor"))
    .map(({ processId }) => processId);
}

function directProcessEntries(): { processId: number; stat: string; command: string }[] {
  const childrenPath = `/proc/self/task/${process.pid}/children`;
  const childIds = readFileSync(childrenPath, "utf8").trim().split(/\s+/u);
  const entries: { processId: number; stat: string; command: string }[] = [];
  for (const childId of childIds) {
    if (childId.length === 0) continue;
    try {
      entries.push({
        processId: Number(childId),
        stat: readFileSync(`/proc/${childId}/stat`, "utf8"),
        command: readFileSync(`/proc/${childId}/cmdline`, "utf8"),
      });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return entries;
}

function processState(stat: string): string {
  return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] as string;
}
