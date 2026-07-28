#!/usr/bin/env node
// Throwaway `senawa` - the smallest thing that exercises the whole design end
// to end, CLI only. Not production shape: one file, no packages, no tests.
//
// What it proves:
//   * durable graph state in beads, with execution hints read before dispatch
//   * a worker session that CANNOT close its own task
//   * `task done` running sensors and REFUSING with actionable findings
//   * an orchestrator-driven rework loop that RESUMES the same worker session
//   * an append-only journal the agent cannot author
//   * a rendered run report
//
// Every quirk found in poc/01-07 is applied here rather than rediscovered.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.env.SENAWA_ROOT ?? process.cwd();
const WORKDIR = join(ROOT, ".agents", ".copilot-tracking", "run");
const JOURNAL = join(WORKDIR, "journal.jsonl");
const STATE = join(WORKDIR, "work.json");
const MAX_ATTEMPTS = 3;

// --- bd adapter -------------------------------------------------------------
// POC 02: bd init blocks on an interactive prompt; list/show carry no
// schema_version without the envelope. Both handled once, here.
const BD_ENV = {
  ...process.env,
  BD_NON_INTERACTIVE: "1",
  DO_NOT_TRACK: "1",
  BD_JSON_ENVELOPE: "1",
  BEADS_DIR: join(ROOT, ".beads"),
};

function bd(args, { json = true } = {}) {
  const out = execFileSync("bd", args, { env: BD_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!json) return out;
  const parsed = JSON.parse(out);
  // Envelope mode wraps everything as { schema_version, data }.
  if (parsed?.schema_version !== undefined && "data" in parsed) return parsed.data;
  return parsed;
}
const one = (v) => (Array.isArray(v) ? v[0] : v);

// --- journal ----------------------------------------------------------------
// Written only by this file. No agent can append to it, which is the whole
// point: the record is a side effect of harness operations, not a claim.
let seq = 0;
function emit(event, fields = {}) {
  mkdirSync(WORKDIR, { recursive: true });
  if (seq === 0 && existsSync(JOURNAL)) {
    seq = readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).length;
  }
  const line = JSON.stringify({ seq: ++seq, ts: new Date().toISOString(), event, ...fields });
  appendFileSync(JOURNAL, line + "\n");
}
const readJournal = () =>
  existsSync(JOURNAL)
    ? readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

// --- sensors ----------------------------------------------------------------
// A sensor is any executable that exits non-zero on failure. Deterministic and
// cheap ones run first and short-circuit the rest, exactly as the design says.
const SENSORS = [
  { id: "syntax", cmd: ["node", ["--check", "src/sum.mjs"]], cost: "trivial" },
  { id: "unit-tests", cmd: ["node", ["test.mjs"]], cost: "medium" },
];

function runSensors() {
  const readings = [];
  for (const s of SENSORS) {
    const started = Date.now();
    try {
      execFileSync(s.cmd[0], s.cmd[1], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      readings.push({ sensor: s.id, verdict: "pass", duration_ms: Date.now() - started });
    } catch (err) {
      // POC: sensor output is untrusted. Cap it and strip control characters
      // before it is allowed anywhere near a model's context.
      const raw = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      const clean = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 2000);
      readings.push({
        sensor: s.id,
        verdict: "fail",
        duration_ms: Date.now() - started,
        findings: clean.split("\n").filter((l) => l.trim()).slice(0, 6).map((message) => ({ message })),
      });
      break; // short-circuit: do not pay for later sensors on already-red work
    }
  }
  return readings;
}

// --- gate -------------------------------------------------------------------
function evaluateGate(taskId, actor) {
  const readings = runSensors();
  const failed = readings.filter((r) => r.verdict === "fail");
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const attempt = state.attempt ?? 1;
  const accepted = failed.length === 0;

  emit("gate.evaluated", {
    task: taskId,
    actor,
    gate: "task-done",
    verdict: accepted ? "pass" : "fail",
    attempt,
    failed: failed.map((f) => f.sensor),
    readings: readings.map((r) => ({ sensor: r.sensor, verdict: r.verdict, duration_ms: r.duration_ms })),
  });

  return {
    accepted,
    task: taskId,
    gate: "task-done",
    attempt,
    attempts_remaining: MAX_ATTEMPTS - attempt,
    readings,
    next_prompt: accepted
      ? null
      : "The harness refused this work. Senawa ran the sensors and they are red.\n\n" +
        failed
          .map((f) => `[${f.sensor}]\n` + f.findings.map((x) => "  " + x.message).join("\n"))
          .join("\n\n") +
        "\n\nFix the cause, then call `senawa task done " + taskId + "` again.",
  };
}

// --- commands ---------------------------------------------------------------
const [, , cmd, sub, ...rest] = process.argv;

if (cmd === "init") {
  // POC 02: bd init asks "Contributing to someone else's repo? [y/N]" and waits
  // forever, even with --quiet and even with stdin closed. Automation MUST pass
  // --non-interactive and --role or it hangs with no output and no timeout.
  execFileSync(
    "bd",
    ["init", "--quiet", "--stealth", "--non-interactive", "--role", "maintainer"],
    { cwd: ROOT, env: BD_ENV, stdio: ["ignore", "ignore", "pipe"] },
  );
  mkdirSync(WORKDIR, { recursive: true });
  console.log("initialised");
}

else if (cmd === "work" && sub === "start") {
  mkdirSync(WORKDIR, { recursive: true });
  const epic = one(bd(["create", rest.join(" ") || "throwaway run", "-t", "epic", "--json"]));
  const task = one(
    bd(["create", "Make sum() total an array of numbers correctly", "-t", "task", "--parent", epic.id, "--json"]),
  );
  // The execution hints the orchestrator must read BEFORE spawning, because
  // model and effort cannot be changed after launch.
  bd([
    "update", task.id, "--metadata",
    JSON.stringify({
      senawa: { role: "implementor", max_attempts: MAX_ATTEMPTS },
      execution_agent_type: "worker",
      execution_suggested_model: "claude-haiku-4.5",
      execution_reasoning_effort: "medium",
    }),
    "--json",
  ]);
  writeFileSync(STATE, JSON.stringify({ epic: epic.id, task: task.id, attempt: 1, sessionId: randomUUID() }, null, 2));
  emit("work.started", { epic: epic.id, task: task.id });
  emit("plan.imported", { epic: epic.id, tasks: 1 });
  console.log(JSON.stringify({ epic: epic.id, task: task.id }));
}

else if (cmd === "task" && sub === "next") {
  // POC 02+03: one atomic call. Selecting and owning must not be two steps.
  const claimed = one(bd(["ready", "--claim", "--json"]));
  if (!claimed?.id) { console.log("{}"); process.exit(0); }
  const full = one(bd(["show", claimed.id, "--json"]));
  emit("task.claimed", { task: claimed.id, hints: {
    model: full?.metadata?.execution_suggested_model,
    effort: full?.metadata?.execution_reasoning_effort,
  }});
  console.log(JSON.stringify({ id: claimed.id, title: claimed.title, metadata: full?.metadata ?? {} }));
}

else if (cmd === "task" && sub === "brief") {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(`# Task ${state.task}

## Scope
\`src/sum.mjs\` exports \`sum(values)\`. It is meant to total an array of numbers.
It currently mishandles at least one case. Make it correct.

## Rules
- You may NOT close this task. Submit it by running: \`senawa task done ${state.task}\`
- The harness runs the sensors. If they are red it will refuse and tell you why.
- Do not edit \`test.mjs\`. Changing the sensor is not the same as passing it.
- Do not run git commands.

Start now. Edit the file, then submit.`);
}

else if (cmd === "task" && sub === "done") {
  const taskId = rest[0] ?? JSON.parse(readFileSync(STATE, "utf8")).task;
  const result = evaluateGate(taskId, { role: "implementor", via: "worker" });
  console.log(JSON.stringify(result, null, 2));
  // A worker calling this NEVER closes the bead. Only the orchestrator does.
  process.exit(result.accepted ? 0 : 1);
}

else if (cmd === "work" && sub === "report") {
  const events = readJournal();
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  const gates = events.filter((e) => e.event === "gate.evaluated");
  const esc = (s) => String(s ?? "").replace(/[<>|`]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "|": "\\|", "`": "'" })[c]);

  const lines = [];
  lines.push(`# Run report`, ``, `Epic \`${state.epic}\` — task \`${state.task}\``, ``);
  lines.push(`## How the work was decomposed`, ``, "```mermaid", "flowchart TD");
  lines.push(`  ${state.epic}["${esc("epic: throwaway run")}"]`);
  lines.push(`  ${state.task}["${esc("task: make sum() correct")}"]`);
  lines.push(`  ${state.epic} --> ${state.task}`, "```", ``);

  lines.push(`## Who did what`, ``, `| Task | Role | Model | Gate runs | Outcome |`, `|---|---|---|---|---|`);
  const claimed = events.find((e) => e.event === "task.claimed");
  const closed = events.find((e) => e.event === "task.closed");
  const dispatched = events.find((e) => e.event === "task.dispatched");
  lines.push(
    `| ${state.task} | implementor | ${esc(dispatched?.actor?.model ?? claimed?.hints?.model ?? "?")} | ${gates.length} | ${closed ? "closed" : "open"} |`,
  );
  lines.push(``);

  lines.push(`## Where the harness pushed back`, ``);
  // The baseline gate runs BEFORE any worker touches the code, so it is not
  // pushback against anybody. Only gates after dispatch count.
  const dispatchSeq = events.find((e) => e.event === "task.dispatched")?.seq ?? 0;
  const postDispatch = gates.filter((g) => g.seq > dispatchSeq);
  const red = postDispatch.filter((g) => g.verdict === "fail");
  lines.push(
    red.length === 0
      ? `The task passed \`task-done\` on the first attempt after dispatch.`
      : `The harness refused this work ${red.length} time(s) before accepting it.`,
    ``,
  );
  if (postDispatch.length) {
    lines.push(`| Attempt | Verdict | Failed sensors | Requested by |`, `|---|---|---|---|`);
    for (const g of postDispatch) {
      lines.push(
        `| ${g.attempt} | ${g.verdict} | ${esc(g.failed.join(", ") || "—")} | ${esc(g.actor?.via ?? g.actor?.role ?? "?")} |`,
      );
    }
    lines.push(``);
  }

  // Did the worker honour the "you must submit through senawa" instruction?
  const workerSubmissions = gates.filter((g) => g.actor?.via === "worker").length;
  lines.push(
    `The worker was instructed to submit its work with \`senawa task done\`. ` +
      `It did so **${workerSubmissions} time(s)**. ` +
      (workerSubmissions === 0
        ? `It did not comply. The task was still evaluated and closed correctly, because the ` +
          `harness never relied on the worker to declare itself done.`
        : `Compliance is welcome but not depended upon.`),
    ``,
  );

  lines.push(`## Full event log`, ``, `${events.length} events recorded in \`journal.jsonl\`.`, ``);
  lines.push("```text");
  for (const e of events) lines.push(`${String(e.seq).padStart(3)}  ${e.event}`);
  lines.push("```");

  const path = join(WORKDIR, "report.md");
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(path);
}

else if (cmd === "internal" && sub === "gate") {
  // Orchestrator-authoritative gate run (see run.sh).
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  console.log(JSON.stringify(evaluateGate(state.task, { role: "orchestrator" })));
}

else if (cmd === "internal" && sub === "bump") {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  state.attempt = (state.attempt ?? 1) + 1;
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  emit("task.reworked", { task: state.task, attempt: state.attempt });
}

else if (cmd === "internal" && sub === "close") {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  bd(["set-state", state.task, "senawa=done", "--reason", "task-done gate passed"], { json: false });
  bd(["close", state.task, "--reason", "accepted by task-done gate"], { json: false });
  emit("task.closed", { task: state.task });
  emit("work.finished", { epic: state.epic });
}

else if (cmd === "internal" && sub === "emit") {
  emit(rest[0], JSON.parse(rest[1] ?? "{}"));
}

else {
  console.error("usage: senawa work start|report | task next|brief|done <id>");
  process.exit(2);
}
