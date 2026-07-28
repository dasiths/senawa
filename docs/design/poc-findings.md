---
title: Senawa Proof-of-Concept Findings
description: What eight independent probes established about Copilot CLI hooks, sessions, models, the copilot SDK, and beads, and which design assumptions survived contact with the substrate
author: Senawa
ms.date: 2026-07-28
ms.topic: reference
keywords:
  - proof of concept
  - github copilot cli
  - copilot sdk
  - beads
  - hooks
  - backpressure
estimated_reading_time: 20
---

## Purpose

[The design](multi-agent-orchestration.md) rests on a set of claims about what
GitHub Copilot CLI, `@github/copilot-sdk`, and `bd` actually do. Most of those
claims came from reading reference documentation. This document records what
happened when each one was executed instead.

Every result below was produced by a script in [`poc/`](../../poc/README.md).
The probes are independent: no shared state, no ordering requirement. Re-running
any of them reproduces the corresponding section.

Read this before implementing. Six design assumptions did not survive, two of
them in ways that would have produced a harness that looked like it was
enforcing policy while quietly not doing so.

## Environment

| Component | Version |
|-----------|---------|
| GitHub Copilot CLI | 1.0.75 |
| `@github/copilot-sdk` | 1.0.7 (see note below) |
| `bd` (beads) | 1.1.0 |
| Node | 22.17.0 |
| Platform | Debian 12 dev container, 16 cores |

The design cites SDK 1.0.8. The npm mirror this container is pinned to serves
1.0.7 as `latest`, so the SDK probe ran against 1.0.7. Any conclusion drawn
about the SDK should be re-checked when the mirror catches up.

## Summary

| # | Claim under test | Verdict |
|---|------------------|---------|
| 1 | A bundled Node CLI starts in ~34 ms | **Wrong.** 66 ms for a realistic CLI; 33 ms only for a stripped hot path |
| 2 | `preToolUse` deny genuinely blocks a tool call | **Confirmed** |
| 3 | A hook that exceeds `timeoutSec` fails open | **Confirmed, and it is as dangerous as feared** |
| 4 | Exit code 2 denies even when stdout says allow | **Confirmed** |
| 5 | Repository hooks load in `-p` with the env var set | **Confirmed** |
| 6 | `--resume` restores the worker's own memory | **Confirmed** |
| 7 | The SDK exposes no subagent or agent stop hook | **Confirmed** |
| 8 | `onPreToolUse` and `onPermissionRequest` compose | **Wrong, and dangerous.** `allow` from the hook silences the permission handler entirely |
| 9 | `general-purpose` emits no subagent hooks | **Contradicted by observation** |
| 10 | OTel gives per-role cost accounting | **Wrong in `-p` mode.** No subagent spans are exported |
| 11 | The AIU attribute is `github.copilot.aiu` | **Wrong.** It is `github.copilot.nano_aiu` |
| 12 | `bd --json` list output lacks `schema_version` | **Confirmed, and worse than documented.** `bd show` lacks it too |
| 13 | `bd ready --claim` is atomic under contention | **Confirmed** |
| 14 | Concurrent `bd` writers contend | **Partly wrong.** They serialize silently, without error or loss |
| 15 | `bd` is fast enough to sit behind a CLI call | **Wrong.** 166-563 ms per invocation |
| 16 | `bd init` can be scripted | **Wrong as written.** It blocks on an interactive prompt forever |
| 17 | One `findings[]` shape can normalize every tool | **Confirmed** across node, python, eslint and tsc |
| 18 | Cheap sensors short-circuit expensive ones | **Confirmed** |
| 19 | Fingerprinted readings can be cached and invalidated | **Confirmed.** 23 ms cold, 0 ms warm, invalidated on edit |
| 20 | Sensor output is a prompt-injection vector | **Confirmed, and defensible.** 50 KB hostile output reduced to 941 B, tags neutralised |
| 21 | Inferential sensors are too unstable to gate on | **It depends, and the difference is measurable.** 5/5 agreement on a clear violation, 3/2 split on a judgment call |
| 22 | `execution_reasoning_effort` can be forwarded to any model | **Wrong.** Passing `--effort` to a model that lacks it is a hard error that kills the dispatch |
| 23 | Workers reliably follow "submit through senawa" | **Unreliable.** Observed both compliance and silent non-compliance across runs |
| 24 | Worker sessions inevitably pollute the user's session history | **Wrong.** `baseDirectory` isolates them completely |
| 25 | `parentAgentTaskId` can correlate a worker session to its parent | **Wrong.** It is read-only telemetry for in-process subagents, and is absent from `MessageOptions` |
| 26 | Cross-session distributed tracing is possible | **Confirmed.** `onGetTraceContext` injects W3C context into `session.create`, `session.resume` and `session.send` |

## 1. Hook latency

`poc/01-hook-latency` builds the same `preToolUse` decision two ways and times
a cold start, best of 20.

| Invocation | Measured |
|------------|----------|
| `/bin/true` | 1 ms |
| `node -e ''` | 16 ms |
| Bundled hot path, 260 KB (yaml only) | **33 ms** |
| Bundled full CLI, 1.2 MB (commander, zod, yaml, execa) | **66 ms** |
| Same full CLI unbundled, through `node_modules` | **183 ms** |

The design's 34 ms figure describes the hot path, not a realistic CLI. A CLI
carrying Zod 4, Commander and execa costs twice that, and the bundle is 1.2 MB
rather than the 365 KB the design assumed. Zod 4 is substantially larger than
Zod 3, which is most of the difference.

66 ms is still viable. But it is 66 ms on *every tool call*, and the gap between
33 and 66 is entirely dependencies that the hot path does not need: a hook
decision requires no argument parsing, no subprocess spawning, and no schema
validation beyond three field checks.

**Implication.** Ship two entry points from one codebase. `senawa-hook` is the
minimal binary wired into `.github/hooks/*.json`; `senawa` is the full CLI that
workers call for `task done`, where 66 ms is irrelevant next to sensor runtime.

**Build gotcha.** esbuild's ESM output cannot `require` CommonJS dependencies,
and both `commander` and `yaml` are CJS. Every bundle needs:

```text
--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"
```

Without it the bundle throws `Dynamic require of "node:events" is not supported`
at import time. This is not optional and it is not obvious; it cost two failed
runs to find.

## 2. Hooks really do enforce, and really do fail open

`poc/04-hooks-enforcement` runs four real Copilot sessions against a scratch git
repository, asking each to run `git commit --allow-empty -m HOOK_POC_MARKER`,
and then counts commits.

| Scenario | Hook fired | Commit created | Reading |
|----------|-----------|----------------|---------|
| `preToolUse` returns deny | yes | **0** | The gate holds |
| Hook sleeps 12 s against `timeoutSec: 3` | yes | **1** | The gate silently evaporated |
| Hook prints `{"permissionDecision":"allow"}` then `exit 2` | yes | **0** | Exit 2 wins over stdout |
| No hooks (control) | n/a | 1 | The command itself works |

Three things worth keeping.

**Repository hooks do load in `-p` mode** when
`GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=true` is set, and `sessionStart` fires
too. Topology B1 is viable.

**The timeout hole is real and silent.** The hook returned a valid deny. It was
ignored because it was late, the commit went through, and nothing in the agent's
transcript indicated that a policy check had been skipped. A harness whose gates
are enforced by command hooks is one slow disk away from enforcing nothing. The
design's advice to alert on the hook duration tail is not defensive
over-engineering; it is the only way to detect this.

**The agent invents explanations for denials.** Given
`permissionDecisionReason: "may-commit is red: typecheck failed"` the model
reported that "git refused to create the commit due to a pre-commit hook that
checks for type safety" — a plausible, confident, and entirely fabricated
mechanism. Denial reasons should therefore name the harness explicitly
("senawa refused this: ..."), or the model will misattribute the refusal and may
try to work around the wrong obstacle.

## 3. The SDK: two confirmations and one trap

`poc/07-sdk-surface` reads the shipped `.d.ts` rather than the README, then runs
a live session.

### Hook surface, from the type declarations

Present: `onPreToolUse`, `onPreMcpToolCall`, `onPostToolUse`,
`onPostToolUseFailure`, `onUserPromptSubmitted`, `onSessionStart`,
`onSessionEnd`, `onErrorOccurred`.

Absent: `onSubagentStart`, `onSubagentStop`, `onAgentStop`, `onPreCompact`,
`onNotification`.

This confirms the design's revision. Topology B2 cannot use the "block until
green" pattern, and the orchestrator must drive the rework loop explicitly.
`onPreMcpToolCall` is a bonus that the README does not list.

### What works exactly as designed

`defineTool` with a Zod schema exposes `senawa task done` as a first-class typed
tool. The probe registered one that always refuses, and the agent called it,
received the structured refusal, and reported it. Workers genuinely never need
shell access to reach the harness.

`resumeSession(id)` restored the conversation: a second connection to the same
session correctly recalled the summary string passed to the custom tool in the
first.

### The trap: `onPreToolUse` silences `onPermissionRequest`

`poc/07-sdk-surface/precedence.mjs` runs the same shell request three ways with
a permission handler that always rejects shell commands.

| `onPreToolUse` returns | `onPreToolUse` calls | `onPermissionRequest` calls | Command ran? |
|------------------------|----------------------|------------------------------|--------------|
| `{ permissionDecision: "allow" }` | 1 | **0** | **yes** |
| `{}` | 1 | 1 | no |
| (hook not registered) | 0 | 1 | no |

A hook that returns `allow` short-circuits the permission service, so the
permission handler is never consulted and its rejection never happens. The
design proposes using both mechanisms together; done naively, the fast one
disables the strong one.

**Rule for the implementation.** `onPreToolUse` must return `{}` unless it is
actively denying. It may never return `allow`. The same caution applies to
`permissionRequest` command hooks, which are documented to short-circuit the
permission flow on `allow` in exactly the same way.

When the handler is allowed to run, its `feedback` string reaches the model
intact: the agent reported "refused because the `may-commit` permission is
currently red", which is the actionable backpressure the design is after.

## 4. Sessions and the rework loop

`poc/05-session-resume` is the cleanest result in this document.

- `--session-id <uuid>` creates a session at a caller-chosen identifier.
- `--resume=<uuid> -p "..."` continues it non-interactively.
- Asked what word it had written to a file, **without reading the file**, the
  resumed worker answered `ZEPHYR-15172` correctly.
- A fresh session asked the same question said it had no prior context.
- `--share` wrote a transcript file.

The rework loop is sound. Resuming the worker that built the change is
materially better than re-briefing a new one, and it works today.

`--output-format json` emits JSONL with a richer event set than expected:
`assistant.message`, `assistant.reasoning`, `assistant.turn_start/turn_end`,
`model.call_start`, `session.usage_checkpoint`, `session.tools_updated`, and a
terminal `result`. **`session.usage_checkpoint` means the journal can capture
cost from `-p` runs without standing up an OTel collector at all**, which is a
significantly cheaper path to the per-task accounting the design wants.

## 5. Model routing and subagent hooks

`poc/06-model-routing` uses the OTel file exporter as the measuring instrument,
because asking a model which model it is produces confident fiction.

**Custom agents are discovered and delegated to correctly.** A
`.github/agents/senawa-probe.agent.md` profile appeared in the agent list
alongside the built-ins, and `subagentStart` and `subagentStop` both fired with
`agentName: "senawa-probe"`. The payload also carries `agentId`
(`call_...`), `agentType`, `agentDisplayName`, and `agentDescription`, which is
more than the reference documents.

**`general-purpose` appears to emit subagent hooks after all.** When the main
agent delegated to `general-purpose`, two hook events were captured with
`agentName: "general-purpose"`. The documentation states plainly that this agent
emits neither event. Treat the documented behaviour as unreliable rather than
inverted: keep the design's rule of always dispatching a named custom agent,
since that costs nothing and does not depend on which claim is right.

**OTel does not deliver per-role cost in `-p` mode.** Only the top-level
`invoke_agent` span was exported. No subagent spans appeared, so the
"AIU per closed task, by role and model" metric cannot be built this way for
subprocess workers. Use the `session.usage_checkpoint` JSONL events instead, or
attribute cost per dispatched session rather than per in-process subagent.

**The AIU attribute name in the design is wrong.** Observed attributes on
`invoke_agent` include `github.copilot.nano_aiu` and `github.copilot.cost`.
There is no `github.copilot.aiu`. Also present and undocumented in the design:
`github.copilot.agent.type`, `github.copilot.context.custom_agent_names`,
`github.copilot.context.skills`, `github.copilot.git.branch`, and
`gen_ai.usage.reasoning.output_tokens`. `gen_ai.agent.name` was **absent** on
the top-level span, which carried `gen_ai.agent.id: github.copilot.default`
instead.

**The Auto trap is unresolved.** With `--model auto`, the top-level span
recorded `gen_ai.request.model: auto`, and because no subagent spans are
exported there was no way to observe which model the subagent actually received.
The design's rule stands on documentation alone: pin an explicit model on the
principal session. This is the highest-value unvalidated claim remaining.

## 6. The beads contract

`poc/02-beads-contract` walks the whole `@senawa/graph` surface.

### `bd init` blocks forever on a prompt

The first two probe runs hung for over twenty minutes. `bd init --quiet
--stealth` asks **"Contributing to someone else's repo? [y/N]"** and waits, even
with `--quiet`, even with stdin closed.

```bash
export BD_NON_INTERACTIVE=1 DO_NOT_TRACK=1
bd init --quiet --stealth --non-interactive --role maintainer </dev/null
```

`senawa init` must pass `--non-interactive` and `--role`. Without this, any
automated or CI setup path hangs with no output and no timeout.

### `schema_version` is missing from more commands than the design says

| Command | Legacy output shape | `schema_version` |
|---------|--------------------|------------------|
| `bd create --json` | object | present (`1`) |
| `bd show --json` | **array** | **absent** |
| `bd ready --json` | array | absent |
| any, with `BD_JSON_ENVELOPE=1` | `{schema_version, data}` | present |

The design assumed object commands like `show` carried the version. They do not;
`show` returns a single-element array. Envelope mode is not an optimisation, it
is the only way to get a version guard at all.

```bash
BD_JSON_ENVELOPE=1 bd show <id> --json | jq '.data[0]'
```

### What works exactly as designed

- **Metadata round-trips.** A nested `senawa` namespace survives intact, numbers
  stay numbers, and `bd list --metadata-field execution_parallel_group=X` filters
  on the execution hints directly.
- **Dependency direction.** `bd dep add <dependent> <blocker>` blocks correctly;
  `bd blocked --json` reports `blocked_by`.
- **Gate lifecycle.** `bd gate create --type=human --blocks <id>` then
  `bd gate resolve` opens and closes cleanly.
- **`bd swarm validate` is the plan-lint sensor.** It printed ready fronts as
  numbered waves, estimated worker-sessions, max parallelism, `Swarmable: YES`,
  and a warning. Use it as-is.

### Three things that need design changes

**`bd set-state` writes an event bead that ordinary queries cannot see.** It
reports `Event: <issue>.1` and adds the `senawa:rework` label. The label query
works. But `bd list --type event --json` returns **zero**; the event only
appears via `bd list --all`. The journal reader must use `--all` or walk children.

**`bd batch` cannot set metadata.** Its grammar is its own, unrelated to the CLI
flags:

```text
create <type> <priority> <title...>
update <id> <key>=<value>      # only status, priority, title, assignee
close <id> [reason...]
dep add <from-id> <to-id> [type]
```

`update <id> metadata={}` fails with `unsupported key "metadata"`. The design's
"close a task, record its verdict, and append a note in one batch" is therefore
only partly achievable; metadata writes stay separate calls.

**`bd dep tree --format=mermaid` does not render children.** Run against an epic
with two child tasks it emitted a single node for the epic. It follows
dependency edges, not parent-child. The run report's decomposition diagram must
be generated from the graph by `@senawa/report`, not delegated to `bd`.

## 7. Concurrency

`poc/03-beads-concurrency` runs six workers against one database.

**`bd ready --claim` is atomic.** Six concurrent claims returned six distinct
issue ids with no duplicates. The frontier is safe for parallel pull, which is
the single most important correctness property in the parallelism design.

**Concurrent writers do not fail, they just do not help.**

| Mode | Wall time for 6 creates |
|------|-------------------------|
| 6 concurrent | 4564 ms |
| 6 sequential | 4725 ms |

All twelve writes succeeded, nothing was lost, and no error surfaced. This
refines the design, which implies contention produces failures. It does not: the
embedded single writer serializes transparently. Funnelling writes through
`senawa` is therefore justified by **policy and throughput accounting**, not by
correctness.

**`bd` is slow, and this is the most under-appreciated finding here.**

| Command | Best of 3 |
|---------|-----------|
| `bd ready --json` | 299 ms |
| `bd show <id> --json` | 166-563 ms |
| `bd list --json` | 378-440 ms |
| one `bd create` | ~760 ms |

At 300-500 ms per call, a `senawa work show` that makes four `bd` calls costs
around two seconds. Two consequences:

1. **No hook may ever touch the graph.** A 33 ms hot path plus one `bd show` is
   a 400 ms `preToolUse` hook, which is both a latency tax on every tool call and
   a step towards the timeout hole from section 2.
2. **`@senawa/graph` needs a read cache** with explicit invalidation on write,
   or the PA's polling loop will dominate wall-clock time.

## 8. The sensor model

`poc/08-sensors` is the first probe that tests the design's actual subject
matter rather than its plumbing.

### Normalization holds across four tools

One `findings[]` shape — `{ file, line, column, severity, message }` — carried
output from four unrelated tools:

| Sensor | Tool | Raw | Normalized to |
|--------|------|-----|---------------|
| `syntax-js` | `node --check` | 167 B | `bad.js:4 SyntaxError: Unexpected end of input` |
| `syntax-py` | `python3 -m py_compile` | 106 B | `broken.py:2 SyntaxError: expected ':'` |
| `lint` | `eslint --format json` | 482 B | `bad.js:4 Parsing error: Unexpected token` |
| `typecheck` | `tsc --pretty false` | 204 B | `parse.ts:4 …(TS2307)` |
| `unit-tests` | bare process, no parser | 50 KB | five clipped lines |

Adding a language means adding one function to `normalizers.mjs`. Nothing else
in the runner changes. The design's "a sensor is any executable that exits
non-zero" contract is sound, and the parser layer is genuinely thin.

### Ordering and caching behave

Sorting by declared `cost` and stopping at the first red sensor meant one
trivial sensor ran and four were skipped — including the expensive inferential
one. Fingerprinting over `(sensor definition, contents of watched files)` gave
23 ms cold, **0 ms** warm with all readings reused, and correctly invalidated
every cached reading the moment a watched file was touched.

### Hostile sensor output is containable

`fixture/hostile.mjs` emits what a badly behaved test suite emits by accident:
a prompt-injection payload, ANSI escapes, a NUL byte, and 50 KB of filler.

| Property | Result |
|----------|--------|
| Raw output | 50,272 B |
| Forwarded to the model | **941 B** |
| Control characters survived | none |
| `<system>` / `<IMPORTANT>` tags survived | none, replaced with `[stripped-tag]` |
| Longest single finding | 301 chars |

This is worth keeping as a regression test rather than a one-off check. It is
the cheapest defence in the whole design and it works.

### Inferential stability is measurable, and the answer is "it depends"

The design defers this with "start advisory, promote on measured trust".
Promotion needs a measurement, so the probe runs the **same rubric** against
**unchanged input** five times and counts.

**A clear-cut violation** (a domain class doing file I/O):

| Run | Verdict | Findings | Rules cited |
|-----|---------|----------|-------------|
| 1-5 | `fail` | 1 | rule 2, every time |

100% verdict agreement, identical finding, 5/5 rule citation. Stable.

**A judgment call** (is this abstraction worth its weight?):

| Run | Verdict | Findings | Rules cited |
|-----|---------|----------|-------------|
| 1 | `pass` | 0 | — |
| 2 | `fail` | 1 | 3 |
| 3 | `pass` | 0 | — |
| 4 | `fail` | 2 | 1, 3 |
| 5 | `fail` | 1 | 3 |

60% agreement, findings ranging 0 to 2, one rule cited in 3/5 runs and another
in 1/5. On identical bytes.

**This gives the promotion criterion the design was missing.** Trust is not a
property of a sensor, it is a property of a *sensor against a class of input*.
The same rubric and the same model is gate-worthy on structural violations and
pure noise on aesthetic ones.

Concretely: run the rubric N times over a representative sample, and promote to
blocking only where verdict agreement is 100%. Anything less creates
backpressure the worker cannot reproduce, which is indistinguishable from a
flaky test — and a flaky gate is worse than no gate, because it teaches the
worker that refusals are arbitrary.

**Cost confirms the ordering rule.** All five deterministic sensors together
cost 23 ms. One inferential run cost **16,000-30,000 ms**. That is a factor of
roughly a thousand, which is why inferential sensors run last and only on
otherwise-green work.

## 9. The whole loop, end to end

`poc/09-end-to-end` is a throwaway `senawa` that runs the real thing: a beads
graph, a real `copilot -p` worker, real sensors, a real refusal, and a rendered
report. It is CLI only — no MCP, no SDK.

It works. A representative run:

```text
0. senawa init                 bd init, non-interactively
1. work start                  epic + task poured, execution hints attached
2. task next                   claimed atomically -> model=claude-haiku-4.5
3. baseline gate               accepted=false failed=unit-tests
4. dispatch                    copilot -p at a caller-chosen session id
5. gate                        accepted=true
6. outcome                     bead closed BY THE HARNESS
7. report                      rendered from journal.jsonl
```

Four things this established that no isolated probe could.

**Capability removal is practical.** The worker's environment is *constructed*,
not filtered: a bin directory containing exactly the executables it may reach,
with `bd` deliberately absent. `PATH` verification confirmed the worker could
reach `senawa` and could not reach `bd`. This is far simpler to reason about
than a deny list, and it is the direct application of the POC 04 finding.

**The bead status is the proof.** Across every run, including failed ones, the
task's status only ever changed when the orchestrator changed it. The worker
never closed its own work, and never edited `test.mjs`.

**Instruction-only compliance is unreliable, and it does not matter.** In one
run the worker called `senawa task done` as instructed. In another it silently
skipped it, edited the file and ended its turn. The outcome was correct both
times, because the orchestrator's gate run is authoritative and never depended
on the worker declaring itself finished. This is the design's central thesis
being load-tested by accident, and it held.

**Effort hints cannot be forwarded blindly.** Passing `--effort medium` to
`claude-haiku-4.5` is a hard error: *"Model claude-haiku-4.5 does not support
reasoning effort configuration"*. The dispatch died before the worker started,
and because the session was never created, the two rework attempts then failed
with `--resume` errors. One bad flag cascaded into a completely wasted task
budget. `senawa dispatch` must map `execution_reasoning_effort` through a model
capability table and drop it when unsupported.

That cascade is worth dwelling on: the harness behaved *correctly* throughout —
it refused three times, exhausted the budget, and escalated. It just refused for
a reason that had nothing to do with the code. **A dispatch failure is not a
work failure, and the gate cannot tell the difference.** The design needs a
distinct `dispatch.failed` event and a separate budget, or a misconfigured flag
burns a task's entire rework allowance and reports it as the worker's fault.

1. Split the binary. `senawa-hook` (minimal, ~33 ms) for hooks; `senawa` (full)
   for everything else. Update the latency section's numbers to 66 ms and 183 ms.
2. Add the `createRequire` banner to the esbuild configuration and keep a test
   asserting the bundle imports cleanly.
3. State the rule that `onPreToolUse` and `permissionRequest` hooks must never
   return `allow`, only `{}` or a denial, and explain why.
4. Replace `github.copilot.aiu` with `github.copilot.nano_aiu` throughout.
5. Replace the OTel-based per-role cost metric with `session.usage_checkpoint`
   parsing from `--output-format json`, and note that subagent spans are not
   exported in `-p` mode.
6. Record that `senawa init` must call `bd init --non-interactive --role ...`
   with `BD_NON_INTERACTIVE=1`, or automation hangs indefinitely.
7. Correct the `schema_version` claim: `bd show` is an array without it, so
   `BD_JSON_ENVELOPE=1` is mandatory rather than advisable.
8. Note that `bd batch` cannot write metadata, and that event beads need
   `bd list --all`.
9. Generate the run report's mermaid diagram in `@senawa/report`, not from
   `bd dep tree`.
10. Soften the parallelism rationale: concurrent `bd` writes serialize safely,
    so the seam exists for policy and accounting, not to prevent corruption.
11. Add a read cache to `@senawa/graph` and budget for 300-500 ms per `bd` call.
12. Keep the "always dispatch a named custom agent" rule, but stop justifying it
    with the `general-purpose` hook claim, which observation contradicts.
13. Map `execution_reasoning_effort` through a model capability table in
    `senawa dispatch` and drop the flag when the model does not support it.
    Forwarding it blindly is a hard error that kills the dispatch.
14. Add a `dispatch.failed` journal event and a dispatch budget separate from
    the rework budget, so an infrastructure failure cannot consume a task's
    attempts and be recorded as the worker's fault.
15. Adopt the inferential promotion criterion: N runs over representative input,
    promote to blocking only at 100% verdict agreement, and record the sample
    size in `sensors.yaml` next to `trust`.
16. Keep `poc/08-sensors/fixture/hostile.mjs` as a regression test for evidence
    hygiene in `@senawa/sensors`.
17. Dispatch every worker session under an isolated `baseDirectory` (SDK) or
    `COPILOT_HOME` (subprocess), so the human's session picker stays theirs.
    Delete the session after its transcript is archived.
18. Specify the trace propagation contract: one span per dispatch, W3C context
    returned from `onGetTraceContext`, and `trace_id` recorded on every journal
    event so the two systems can be joined after the fact.

## What remains unvalidated

| Question | Why it was not settled | How to settle it |
|----------|------------------------|------------------|
| Does session model `Auto` override a subagent profile's `model`? | No subagent spans are exported in `-p` mode | Run the probe inside an SDK-hosted session, or with an OTLP collector rather than the file exporter |
| Does `subagentStop` returning `block` actually force another turn, and cap at 8? | Not probed; needs a deliberately failing worker | Extend `poc/04` with a `subagentStop` hook that blocks a counted number of times |
| Does `--worktree` isolate two implementors safely end to end? | Experimental flag, needs two concurrent writers on real files | A two-worker probe with a deliberate file conflict |
| Does inferential stability hold on *real diffs* rather than whole files? | `poc/08` measured whole-file review on two hand-built subjects | Repeat the measurement against 20 real commits from this repository |
| Does `senawa prime` fit a `sessionStart` hook's budget? | Depends on the `bd` read cache that does not exist yet | Re-measure once `@senawa/graph` caching lands |
| Does the human relay survive a real multi-day pause? | Every probe ran to completion in minutes | Park a task on a `human` gate, restart everything, resume |
| SDK behaviour at 1.0.8+ | The npm mirror serves 1.0.7 | Re-run `poc/07` when the mirror updates |

## Reproducing

```bash
bash poc/01-hook-latency/run.sh        # offline
bash poc/02-beads-contract/run.sh      # offline, slow (bd init)
bash poc/03-beads-concurrency/run.sh   # offline, slow
bash poc/04-hooks-enforcement/run.sh   # spends AI credits
bash poc/05-session-resume/run.sh      # spends AI credits
bash poc/06-model-routing/run.sh       # spends AI credits
bash poc/07-sdk-surface/run.sh         # spends AI credits
node poc/07-sdk-surface/precedence.mjs # spends AI credits
node poc/08-sensors/runner.mjs         # offline
bash poc/08-sensors/run.sh             # spends AI credits (inferential half)
bash poc/09-end-to-end/run.sh          # spends AI credits
bash poc/10-session-isolation/run.sh   # spends AI credits
```

The end-to-end probe is non-deterministic by nature: the worker sometimes fixes
both seeded bugs in one turn and sometimes needs a refusal round-trip. Both
outcomes are informative, and the run report distinguishes them.
