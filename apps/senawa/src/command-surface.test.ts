import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "..", "dist", "main.js");
const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

/** Runs the built executable the way a consumer does, with its own state root. */
async function senawa(
  cwd: string,
  stateRoot: string,
  ...argv: readonly (string | NodeJS.ProcessEnv)[]
): Promise<{ readonly stdout: string; readonly code: number }> {
  const last = argv[argv.length - 1];
  const extra = typeof last === "object" ? last : {};
  const args = argv.filter((value): value is string => typeof value === "string");
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_STATE_HOME: stateRoot,
        XDG_RUNTIME_DIR: join(stateRoot, "run"),
        ...extra,
      },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { readonly stdout?: string; readonly code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

/** Polls until the supervisor has done the work, because driving is now its job. */
async function waitFor<T>(read: () => Promise<T | undefined>, attempts = 60): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The supervisor did not reach the expected state");
}

describe("the command surface end to end", () => {
  it("scaffolds, validates, starts, and drives a run", async () => {
    const project = await mkdtemp(join(tmpdir(), "senawa-cli-"));
    roots.add(project);
    const stateRoot = join(project, "state");

    const created = await senawa(project, stateRoot, "init");
    expect(created.stdout).toContain(".senawa: created");

    const valid = await senawa(project, stateRoot, "doctor");
    expect(valid.stdout).toContain("valid");

    await writeFile(join(project, "request.json"), JSON.stringify({ request: "Add health" }));
    const started = await senawa(project, stateRoot, "start", "request.json", "run_cli");

    // Start blocks, so it reports the dispatch and then what the run waits for.
    expect(started.stdout).toContain("run: run_cli");
    expect(started.stdout).toContain("phase: plan");
    expect(started.stdout).toContain("waiting for the agent");

    // The rest of what a consumer needs, in the order they need it, with no
    // internal contract read and no digest computed by hand.
    const repository = /repository: (\S+)/u.exec(started.stdout)?.[1];
    if (repository === undefined) throw new Error("start did not name the repository");

    const status = await senawa(project, stateRoot, "status", repository, "run_cli");
    expect(status.stdout).toContain("mode: running");
    expect(status.stdout).toContain("agents dispatched: 1");

    const gates = await senawa(project, stateRoot, "run-gates", "plan");
    expect(gates.stdout.length).toBeGreaterThan(0);

    const agents = await senawa(project, stateRoot, "agent", "list", repository, "run_cli");
    expect(agents.stdout).toContain("dispatch_");

    const artifacts = await senawa(project, stateRoot, "artifact", "list", repository, "run_cli");
    expect(artifacts.stdout).toContain("no artifacts yet");

    // Intervening on a run that owes nobody a decision has to say so rather
    // than fail obscurely.
    const approve = await senawa(project, stateRoot, "approve", repository, "run_cli");
    expect(approve.stdout).toContain("Nothing is waiting for a decision");
    expect(approve.stdout).toContain("senawa status");

    // Raising a budget was reachable only from the portal, so a run left to a
    // terminal stopped on a budget with nothing anyone there could do about it.
    const grant = await senawa(project, stateRoot, "grant", repository, "run_cli");
    expect(grant.stdout).toContain("No allowance has been asked for");
    expect(grant.stdout).toContain("senawa status");
  }, 60_000);

  it("keeps the IPC credential out of status and diagnostics", async () => {
    const project = await mkdtemp(join(tmpdir(), "senawa-cli-"));
    roots.add(project);
    const stateRoot = join(project, "state");

    await senawa(project, stateRoot, "init");
    await senawa(project, stateRoot, "service", "start");
    try {
      const credential = (
        await readFile(join(stateRoot, "run", "senawa", "credential"), "utf8")
      ).trim();
      expect(credential.length).toBeGreaterThan(16);

      const surfaces = await Promise.all([
        senawa(project, stateRoot, "service", "status"),
        senawa(project, stateRoot, "diagnostics", "create", "diagnostics"),
        senawa(project, stateRoot, "doctor"),
      ]);

      // The bearer token is the whole of local trust. It has to stay in its
      // private file rather than leaking through an operator-facing surface.
      for (const surface of surfaces) {
        expect(surface.stdout).not.toContain(credential);
      }
      const bundle = join(project, "diagnostics");
      for (const entry of await readdir(bundle, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const contents = await readFile(join(entry.parentPath, entry.name), "utf8");
        expect(contents).not.toContain(credential);
      }
    } finally {
      await senawa(project, stateRoot, "service", "stop");
    }
  }, 60_000);

  it("lets a dispatched agent read its own context and schema", async () => {
    const project = await mkdtemp(join(tmpdir(), "senawa-cli-"));
    roots.add(project);
    const stateRoot = join(project, "state");

    await senawa(project, stateRoot, "init");
    await senawa(project, stateRoot, "service", "start");
    try {
      await writeFile(join(project, "request.json"), JSON.stringify({ request: "Add health" }));
      const started = await senawa(project, stateRoot, "start", "request.json", "run_agent");
      const credential = /^credential: (.+)$/m.exec(started.stdout)?.[1];
      const dispatch = /^dispatch: (.+)$/m.exec(started.stdout)?.[1];
      if (credential === undefined || dispatch === undefined) {
        throw new Error(`start reported no agent credential:\n${started.stdout}`);
      }

      // This is the whole point: the process that dispatched is gone, and the
      // agent talks to the daemon, which never saw the mint or the dispatch.
      const agent = { SENAWA_WORKER_CREDENTIAL: credential, SENAWA_WORKER_DISPATCH: dispatch };
      // The authored prompt says nothing about Senawa. Everything the worker
      // needs to hand in work is discovered through the channel.
      const authored = await readFile(join(project, ".senawa", "prompts", "planner.md"), "utf8");
      expect(authored).not.toMatch(/senawa|submit_completion|worker complete/i);

      const context = await senawa(project, stateRoot, "worker", "context", agent);
      expect(context.stdout).toContain("worker-context-base");

      const schema = await senawa(project, stateRoot, "worker", "output-schema", agent);
      expect(schema.stdout).toContain("schemaKey");

      // The agent hands in work the phase declared, and it is accepted.
      await writeFile(
        join(project, "plan.json"),
        JSON.stringify({ plan: "Add a health endpoint." }),
      );
      const handed = await senawa(
        project,
        stateRoot,
        "worker",
        "complete",
        "--output",
        "plan=plan.json",
        "--summary",
        "did it",
        agent,
      );
      expect(handed.stdout).toContain('"status": "accepted"');

      // Output that does not satisfy the declared schema is refused by name.
      await writeFile(join(project, "wrong.json"), JSON.stringify({ nope: 1 }));
      const refused = await senawa(
        project,
        stateRoot,
        "worker",
        "complete",
        "--output",
        "plan=wrong.json",
        agent,
      );
      expect(refused.stdout).toContain("does not satisfy plan");

      // The whole point of the redesign: an authored workflow reaching its next
      // phase on the strength of an agent's work, without a person driving it.
      // The supervisor drives, so `advance` hands the job to it rather than
      // moving the same run from a second process.
      const repository = /^repository: (.+)$/m.exec(started.stdout)?.[1] ?? "";
      const advanced = await senawa(project, stateRoot, "advance", repository, "run_agent");
      expect(advanced.stdout).toContain("asked the running supervisor to drive");

      const closed = await waitFor(async () => {
        const status = await senawa(project, stateRoot, "status", repository, "run_agent");
        return status.stdout.includes("agents dispatched: 2") ? status.stdout : undefined;
      });
      expect(closed).toContain("agents dispatched: 2");

      // A finished run has to show what it produced.
      const artifacts = await senawa(
        project,
        stateRoot,
        "artifact",
        "list",
        repository,
        "run_agent",
      );
      expect(artifacts.stdout).toContain("verified-stored");
    } finally {
      await senawa(project, stateRoot, "service", "stop");
    }
  }, 60_000);

  it("refuses to validate an authored tree with a broken prompt", async () => {
    const project = await mkdtemp(join(tmpdir(), "senawa-cli-bad-"));
    roots.add(project);
    const stateRoot = join(project, "state");

    await senawa(project, stateRoot, "init");
    await writeFile(join(project, ".senawa", "prompts", "planner.md"), "Plan ${{ broken\n");

    const result = await senawa(project, stateRoot, "doctor");

    // The refusal names the prompt, not a file the author never wrote.
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("prompts/planner.md");
    expect(result.stdout).not.toContain("workflow.json");
  }, 60_000);
});
