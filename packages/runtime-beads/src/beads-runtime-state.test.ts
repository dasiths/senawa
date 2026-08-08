import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeGraphDefinition, StoredRuntimeState } from "@senawa/application";
import type { RuntimeTask } from "@senawa/domain";
import { describe, expect, it } from "vitest";
import { BeadsClient, type BeadsCommandRunner } from "./beads-client.js";
import { BeadsRuntimeStateStore } from "./beads-runtime-state.js";

const runId = "run-converge";

const graph: RuntimeGraphDefinition = {
  phases: [
    { id: "plan", title: "Plan", dependsOn: [], executorKind: "agent" },
    { id: "build", title: "Build", dependsOn: ["plan"], executorKind: "task-frontier" },
  ],
};

describe("BeadsRuntimeStateStore convergence", () => {
  it("issues no node writes when every phase and task already matches", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    beads.reset();

    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "noop",
      state,
    });

    expect(beads.writesTouching(beads.graphNodeIssueIds())).toEqual([]);
  });

  it("converges only the nodes whose desired state changed", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    const next = structuredClone(state);
    requirePhase(next, "build").status = "running";
    requireTask(next, "task-two").status = "closed";
    beads.reset();

    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "advance",
      state: next,
    });

    expect(beads.commandsFor(beads.issueId("plan")).map(name)).toEqual([]);
    expect(beads.commandsFor(beads.issueId("task-one")).map(name)).toEqual([]);
    expect(beads.commandsFor(beads.issueId("build")).map(name)).toEqual([
      "update",
      "update",
      "set-state",
      "update",
    ]);
    expect(beads.commandsFor(beads.issueId("task-two")).map(name)).toEqual([
      "update",
      "close",
      "set-state",
      "update",
    ]);
  });

  it("still converges a node whose previous transition left a pending operation", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    beads.interrupt("plan");
    beads.reset();

    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "recover",
      state,
    });

    expect(beads.commandsFor(beads.issueId("plan")).map(name)).toEqual([
      "update",
      "set-state",
      "update",
    ]);
    expect(beads.metadataStatus("plan")).toBe("pending");
    expect(beads.pendingOperation("plan")).toBeUndefined();
  });

  it("releases a stale claim on an otherwise converged task", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    beads.assign("task-one", "worker");
    beads.reset();

    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "release",
      state,
    });

    expect(beads.commandsFor(beads.issueId("task-one")).map(name)).toEqual([
      "update",
      "update",
      "set-state",
      "update",
    ]);
    expect(beads.assigneeOf("task-one")).toBe("");
    expect(beads.commandsFor(beads.issueId("task-two"))).toEqual([]);
  });

  it("creates and resolves a human gate around an approval", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    const waiting = structuredClone(state);
    requirePhase(waiting, "plan").status = "awaiting_approval";
    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "await-human",
      state: waiting,
    });
    expect(
      beads.commands.filter((command) => command[1] === "create" && command[0] === "gate"),
    ).toHaveLength(1);

    const accepted = structuredClone(state);
    requirePhase(accepted, "plan").status = "accepted";
    beads.reset();
    await store.commitRuntimeState({
      runId,
      expectedRevision: "2",
      operationId: "approve-human",
      state: accepted,
    });

    expect(
      beads.commands.filter((command) => command[0] === "gate").map((command) => command[1]),
    ).toEqual(["resolve"]);
    expect(beads.metadataStatus("plan")).toBe("accepted");
  });

  it("assembles one issue snapshot per read and two per commit", async () => {
    const { store, beads } = await harness();
    const state = fixture();
    await store.createRuntimeState(runId, state, "create", graph);
    beads.reset();

    await store.readRuntimeState(runId);
    expect(beads.commands.filter((command) => command[0] === "list")).toHaveLength(1);

    beads.reset();
    const next = structuredClone(state);
    requirePhase(next, "build").status = "running";
    await store.commitRuntimeState({
      runId,
      expectedRevision: "1",
      operationId: "advance",
      state: next,
    });

    expect(beads.commands.filter((command) => command[0] === "list")).toHaveLength(2);
  });
});

async function harness(): Promise<{
  readonly store: BeadsRuntimeStateStore;
  readonly beads: FakeBeads;
}> {
  const root = await mkdtemp(join(tmpdir(), "senawa-beads-converge-"));
  await mkdir(join(root, ".beads"), { recursive: true });
  const beads = new FakeBeads();
  const store = new BeadsRuntimeStateStore(root, {
    client: new BeadsClient(root, { runCommand: beads.runCommand }),
  });
  return { store, beads };
}

function fixture(): StoredRuntimeState {
  return {
    apiVersion: "senawa.dev/runtime/v1",
    status: "running",
    endReason: null,
    phases: [
      {
        id: "plan",
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      },
      {
        id: "build",
        status: "pending",
        iteration: 0,
        artifactVersion: null,
        sessionId: null,
        rejectionReason: null,
      },
    ],
    tasks: [task("task-one"), task("task-two")],
    activeTurn: null,
    dispatches: [],
  };
}

function task(key: string): RuntimeTask {
  return {
    key,
    title: key,
    dependsOn: [],
    paths: [`src/${key}.ts`],
    repositoryChange: "required",
    acceptance: [{ description: `${key} passes`, required: true, satisfies: [] }],
    role: "worker",
    status: "pending",
    attempt: 0,
    dispatchFailures: 0,
    sessionId: null,
    steering: [],
    reworkFindings: [],
  };
}

function requirePhase(state: StoredRuntimeState, id: string): StoredRuntimeState["phases"][number] {
  const phase = state.phases.find((candidate) => candidate.id === id);
  if (phase === undefined) throw new Error(`fixture has no phase ${id}`);
  return phase;
}

function requireTask(state: StoredRuntimeState, key: string): RuntimeTask {
  const found = state.tasks.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`fixture has no task ${key}`);
  return found;
}

function name(command: readonly string[]): string {
  return command[0] ?? "";
}

interface FakeSenawa {
  kind?: string;
  node_id?: string;
  status?: string;
  pending_operation?: unknown;
}

interface FakeMetadata {
  senawa?: FakeSenawa;
}

interface FakeIssue {
  id: string;
  title: string;
  status: string;
  issue_type: string;
  assignee?: string | undefined;
  metadata?: FakeMetadata | undefined;
}

/** Enough of `bd` to count the commands a convergence issues, with no subprocess or database. */
class FakeBeads {
  readonly commands: string[][] = [];
  private readonly issues: FakeIssue[] = [];
  private sequence = 0;

  readonly runCommand: BeadsCommandRunner = async (_executable, arguments_) => {
    const argv = [...arguments_];
    this.commands.push(argv);
    return { stdout: this.dispatch(argv), stderr: "" };
  };

  reset(): void {
    this.commands.length = 0;
  }

  graphNodeIssueIds(): ReadonlySet<string> {
    return new Set(
      this.nodes()
        .filter((issue) => senawaOf(issue)?.kind !== "run")
        .map((issue) => issue.id),
    );
  }

  issueId(nodeId: string): string {
    return this.node(nodeId).id;
  }

  assign(nodeId: string, assignee: string): void {
    this.node(nodeId).assignee = assignee;
  }

  assigneeOf(nodeId: string): string | undefined {
    return this.node(nodeId).assignee;
  }

  /** Replays the durable marker a crash between the pending and final metadata writes leaves. */
  interrupt(nodeId: string): void {
    this.senawa(nodeId).pending_operation = { id: "interrupted" };
  }

  pendingOperation(nodeId: string): unknown {
    return this.senawa(nodeId).pending_operation;
  }

  metadataStatus(nodeId: string): unknown {
    return this.senawa(nodeId).status;
  }

  commandsFor(issueId: string): string[][] {
    return this.commands.filter(
      (command) => command[0] !== "list" && command[0] !== "version" && command[1] === issueId,
    );
  }

  writesTouching(issueIds: ReadonlySet<string>): string[][] {
    return this.commands.filter(
      (command) =>
        command[0] !== "list" &&
        command[0] !== "version" &&
        command.some((argument) => issueIds.has(argument)),
    );
  }

  private dispatch(argv: readonly string[]): string {
    switch (argv[0]) {
      case "version":
        return "bd version 1.1.2 (fake)\n";
      case "list":
        return envelope(structuredClone(this.issues));
      case "create":
        return envelope(this.create(argv));
      case "update":
        return envelope(this.update(argv));
      case "close":
        return envelope(this.setStatus(argv, "closed"));
      case "set-state":
        return envelope(this.setState(argv));
      case "gate":
        return this.gate(argv);
      case "dep":
        return envelope(null);
      default:
        throw new Error(`Unsupported fake bd command: ${argv.join(" ")}`);
    }
  }

  private create(argv: readonly string[]): FakeIssue {
    const metadata = flag(argv, "--metadata");
    const issue: FakeIssue = {
      id: this.nextId("bd"),
      title: argv[1] ?? "",
      status: "open",
      issue_type: flag(argv, "--type") ?? "task",
      ...(metadata === undefined
        ? {}
        : { metadata: JSON.parse(metadata) as FakeIssue["metadata"] }),
    };
    this.issues.push(issue);
    return structuredClone(issue);
  }

  private update(argv: readonly string[]): FakeIssue {
    const issue = this.byId(argv[1] ?? "");
    const metadata = flag(argv, "--metadata");
    if (metadata !== undefined) issue.metadata = JSON.parse(metadata) as FakeIssue["metadata"];
    const status = flag(argv, "--status");
    if (status !== undefined) issue.status = status;
    const assignee = flag(argv, "--assignee");
    if (assignee !== undefined) issue.assignee = assignee;
    return structuredClone(issue);
  }

  private setStatus(argv: readonly string[], status: string): FakeIssue {
    const issue = this.byId(argv[1] ?? "");
    issue.status = status;
    return structuredClone(issue);
  }

  private setState(argv: readonly string[]): FakeIssue {
    const issue = this.byId(argv[1] ?? "");
    const event: FakeIssue = {
      id: this.nextId("bd"),
      title: `${issue.id} ${argv[2] ?? ""}`,
      status: "closed",
      issue_type: "event",
    };
    this.issues.push(event);
    return structuredClone(event);
  }

  private gate(argv: readonly string[]): string {
    if (argv[1] === "resolve") {
      this.issues.splice(this.issues.indexOf(this.byId(argv[2] ?? "")), 1);
      return "";
    }
    const gate: FakeIssue = {
      id: this.nextId("gate"),
      title: flag(argv, "--reason") ?? "",
      status: "open",
      issue_type: "gate",
    };
    this.issues.push(gate);
    return envelope(structuredClone(gate));
  }

  private nodes(): FakeIssue[] {
    return this.issues.filter((issue) => senawaOf(issue) !== undefined);
  }

  private node(nodeId: string): FakeIssue {
    const issue = this.nodes().find((candidate) => senawaOf(candidate)?.node_id === nodeId);
    if (issue === undefined) throw new Error(`fake beads has no node ${nodeId}`);
    return issue;
  }

  private senawa(nodeId: string): FakeSenawa {
    const senawa = senawaOf(this.node(nodeId));
    if (senawa === undefined) throw new Error(`fake beads node ${nodeId} lost its metadata`);
    return senawa;
  }

  private byId(id: string): FakeIssue {
    const issue = this.issues.find((candidate) => candidate.id === id);
    if (issue === undefined) throw new Error(`fake beads has no issue ${id}`);
    return issue;
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

function senawaOf(issue: FakeIssue): FakeSenawa | undefined {
  return issue.metadata?.senawa;
}

function flag(argv: readonly string[], flagName: string): string | undefined {
  const index = argv.indexOf(flagName);
  return index === -1 ? undefined : argv[index + 1];
}

function envelope(data: unknown): string {
  return JSON.stringify({ schema_version: 1, data });
}
