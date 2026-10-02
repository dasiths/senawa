# Worker Sessions Probe

## Goal

Senawa dispatches one session per task. That design only pays off if a resumed
session still remembers what it built, because handing sensor failures back to
the worker that wrote the code is cheaper and better than re-briefing a fresh
one. It is also only tolerable if those sessions stay out of the human's session
picker, since a fifty-task work item would otherwise bury their own history.

## Tmux and browser-terminal question

> Can Senawa assign one stable tmux session or pane to each worker turn, capture
> bounded terminal output and lifecycle identity without entering the worker
> session, and project each terminal independently in the browser run console?

The hypothesis is that tmux can provide stable per-turn process identity,
bounded capture, and detach and reconnect behavior while Senawa remains the run
driver and the browser remains a presentation and command channel. The browser
projection fixture passes offline, but the tmux portion skipped in the recorded
environment because tmux was unavailable. The production question remains open.

### What the no-credit probe tests

* Whether session and pane identity remain stable for one deterministic shell
  process per worker turn
* Whether bounded stdout and stderr capture, exit status, detach and reconnect,
  and cleanup can be observed without entering the worker session
* Whether control characters and terminal output can be sanitized before
  independent per-turn projection in the browser run console

### What the planned probe would not prove

* That tmux should become a production worker host or runtime dependency
* That a live Copilot model can create, resume, or complete a worker turn
* That tmux behavior is portable beyond the recorded environment and version
* That terminal projection grants workflow, approval, or worker authority

### Method

`run.sh` creates a unique temporary directory and tmux socket, so concurrent or
repeated runs do not use a shared server or persistent probe state. It starts two
deterministic shell workers in detached, named sessions. Each worker has stable
run, task owner, session, turn, session-name, pane-ID, and pane-PID fields.

Control files advance each worker independently. The runner reads pane metadata
through tmux format strings, captures at most 80 pane-history lines, and reads
stdout, stderr, and lifecycle JSONL through Node file APIs. Before projection,
the fixture strips ANSI and unsafe controls, redacts secret-shaped values,
replaces the temporary root, limits each line to 256 characters, limits each
stream to 1,024 characters, and keeps at most 20 lifecycle records.

The runner verifies detached operation, repeated control-client reconnection,
stable identity, independent updates, expected exit codes `0` and `7`, pane
disappearance, and idempotent cleanup. The browser fixture keys terminals by
turn ID and replaces only the updated turn's immutable projection.

### Scripts

| Path                           | State       | Role |
|--------------------------------|-------------|------|
| `run.sh`                       | Implemented | Safe no-credit default; skips with an installation prerequisite when tmux is unavailable |
| `run-no-credit.mjs`            | Implemented | Isolated tmux orchestration and structured assertions |
| `worker-stand-in.sh`           | Implemented | Deterministic stdout, stderr, lifecycle, update, and exit fixture |
| `browser-terminal-fixture.mjs` | Implemented | Bounded sanitized projection and per-turn browser store |
| `browser-terminal.test.mjs`    | Implemented | Offline independent-update and sanitization tests |
| `run-live.sh`                  | Guarded     | Existing five-turn live session checks; discloses cost and requires `SENAWA_LIVE_PROBE_APPROVED=1` |

The no-credit tmux probe must pass in an environment with tmux before any live
tmux follow-up. The guarded `run-live.sh` predates this question and does not
test tmux. It was not executed for this result.

### Recorded no-credit result

Date: 2026-08-07

Environment:

* Node.js `v22.17.0`
* Debian GNU/Linux 12
* Linux `6.18.33.2-microsoft-standard-WSL2` on `x86_64`
* Tmux unavailable on `PATH`

The safe default returned exit code `0` with this actionable skip:

```text
SKIP: tmux is not installed; install tmux and rerun:
  bash experiments/probes/worker-sessions/run.sh
```

The standalone browser fixture test completed with two passing tests, zero
failures, and no AI credits:

```text
tests 2
pass 2
fail 0
```

This result confirms the offline projection contract only. It does not measure
tmux session, pane, capture, reconnect, exit, or cleanup behavior. No live
script was executed, no model was invoked, and no cost or live evidence is
claimed.

## External worker staged path

Running workers as separate non-hosted processes with live browser terminals is
unimplemented and stays probe-gated. Each stage answers one falsifiable question,
and a stage begins only after the previous one has recorded evidence. Nothing
before Stage 4 spends AI credits.

| Stage | Question it must answer | Method |
|-------|-------------------------|--------|
| 0 | Does tmux behave as hypothesised in this environment at all? | Install tmux and run the existing no-credit probe, then record session and pane identity stability, bounded capture, detach and reconnect, exit status, pane disappearance, cleanup, and `capture-pane` and `pipe-pane` timing |
| 1 | Can a fresh Senawa process prove a detached turn is active, completed with an exit code, or genuinely unknown? | Extend the no-credit probe so a new process reconstructs turn observation from durable state alone, across a restart, without entering the pane |
| 2 | Can a per-turn command bridge admit only its own turn's bindings? | Isolated probe of a per-turn Unix domain socket at mode `0600` with the path passed through the environment and a deterministic shell client; assert that another turn's client, a stale turn, and a removed socket are all refused. No tmux and no model |
| 3 | Can read-only terminal streaming stay bounded, sanitized, and correct across reconnect? | Reuse the existing sanitization fixture, add a byte-cursor stream frame and a bounded scrollback ring behind the existing loopback authentication, and assert independent panes, bounded replay, and no input path |
| 4 | Does a live worker behave the same way under a terminal host? | One clearly labelled live run in the style of `run-live.sh`, with an explicit opt-in and the cost disclosed before execution |

Stage 0 is the prerequisite for everything below it. The entire proposal
currently rests on zero tmux measurements.

Three things stay outside this sequence and need their own decision entries:
terminal input, several concurrent workers in one working tree, and promoting
tmux to a production runtime dependency.

### Human terminal input is not an authority channel

Read-only terminal projection is compatible with the design. Human keyboard
input into a worker terminal is not, and this is a finding rather than a
preference.

A typed instruction produces no journal event, no actor attribution, no version
binding, and no receipt. Senawa records the actor and channel on every steering,
answer, approval, and rejection, and binds approval to an exact artifact version
and digest. Keyboard bytes bypass all four properties at once, so a human could
redirect a run invisibly to the audit trail, and a worker could treat typed text
as authorization to complete work that no gate accepted.

If a writable terminal is ever wanted, it must be a distinct and explicitly
labelled capability rather than a substitute for `senawa steer` and
`senawa answer`. Every byte would have to be journalled with actor, time, run,
owner, session, and turn; it would have to be refused while a gate is evaluating
a turn and while a phase awaits approval; it must not become a path to `bd` or to
another task's completion; and repository delta evidence for that turn would
have to carry an explicit uncertainty marker. Until those conditions are proven,
terminal projection stays read-only.

## What it proves

Session identity is durable and caller-chosen. `--session-id <uuid>` creates a
session at an identifier senawa picks, and `--resume=<uuid>` continues it
non-interactively. Asked which word it had written to a file, without reading the
file, the resumed worker answered correctly. A fresh session asked the same
question had no prior context.

The rework loop is therefore sound as designed, and `--share` writes a transcript
that senawa can archive per task.

Cost accounting does not need a collector. `--output-format json` emits
`session.usage_checkpoint` events alongside `assistant.message`,
`model.call_start`, and a terminal `result`, so per-session accounting is
available directly from the subprocess path. Since senawa dispatches one session
per task, per-session attribution is per-task attribution.

Isolation works on both dispatch paths. A default client saw 34 sessions before
a worker was created under an isolated `baseDirectory` and 34 after, while the
isolated client saw its own. `COPILOT_HOME` achieves the same for the subprocess
path, and `deleteSession` removes the session once its transcript is archived.

## What it does not prove

* Whether trace context genuinely joins spans across two sessions, which needs a
  collector rather than a session listing
* Whether a session parked on a human gate survives a multi-day pause

## Layout

| Path                           | Role |
|--------------------------------|------|
| `run.sh`                       | Safe no-credit entry point |
| `run-no-credit.mjs`            | Tmux substrate runner |
| `worker-stand-in.sh`           | Deterministic shell worker |
| `browser-terminal-fixture.mjs` | Structured bounded browser projection fixture |
| `browser-terminal.test.mjs`    | No-credit projection test |
| `resume.sh`                    | Creates and resumes a caller-chosen live session and checks JSONL |
| `isolation.mjs`                | Checks live SDK and subprocess session isolation |
| `run-live.sh`                  | Cost-disclosing, explicit-opt-in wrapper for five live model turns |

## Reproduction

Run the safe default from the repository root:

```bash
bash experiments/probes/worker-sessions/run.sh
```

When tmux is unavailable, run the projection test independently:

```bash
node --test experiments/probes/worker-sessions/browser-terminal.test.mjs
```

The separately named live wrapper spends AI credits on five short
`claude-haiku-4.5` turns. Review that disclosure and opt in explicitly before
running it:

```bash
SENAWA_LIVE_PROBE_APPROVED=1 bash experiments/probes/worker-sessions/run-live.sh
```

## Change log

| Date       | Change                                                                                                                              |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | Session resume probe. Confirmed caller-chosen identity, genuine recall on resume, control isolation for a fresh session, and the `session.usage_checkpoint` cost path. |
| 2026-07-28 | Session isolation probe. Confirmed `baseDirectory`, `COPILOT_HOME`, and `deleteSession`, and established that `parentAgentTaskId` is intra-session telemetry that cannot correlate dispatched sessions. |
| 2026-08-02 | Merged `05-session-resume` and `10-session-isolation` into one folder covering the worker session lifecycle. Corrected the earlier claim that this probe demonstrated cross-session tracing; it does not. |
| 2026-08-07 | Added the unanswered tmux and browser-terminal question plus the planned no-credit substrate and separately cost-labeled live split. No tmux behavior was measured. |
| 2026-08-07 | Implemented the isolated no-credit tmux runner, deterministic shell workers, bounded sanitized browser projection, independent per-turn test, and guarded live wrapper. The browser fixture passed two offline tests; tmux was unavailable, so the substrate run skipped and the production question remains probing. |
| 2026-08-07 | Recorded the staged external-worker path from tmux substrate to one labelled live run, and the finding that human terminal input cannot serve as an authority channel. No new measurement was taken; tmux remains unavailable. |
| 2026-08-08 | Replaced the credential-shaped literal in the no-credit leak assertion with a residue matcher built at runtime from the fixture's exported redaction key list. The assertion is stronger: it now catches any unredacted value for every redaction key, not only a doubled `password` shape. A content-exclusion policy had masked the previous literal, making the probe look syntactically broken to any worker reading it. |
| 2026-08-08 | Tmux `3.3a` was available, so the substrate runner executed instead of skipping, and it failed. An 80-column pane wrapped `token=worker-alpha-secret` across a line boundary, and assignment-shaped redaction masked only `token=worker`. The stronger residue matcher caught the surviving `-alpha-secret` fragment. `run.sh` exited nonzero at that point in the sequence before the fix below. |
| 2026-08-08 | Documentation/code fix: `sanitizeTerminalText` in `browser-terminal-fixture.mjs` split the single secret pattern into a default pattern (no newline-continuation clause) and a pane-capture pattern (retains the wrap-continuation clause), because only `tmux capture-pane` can hard-wrap a line; stdout and stderr are read from files and never wrap. `projectBrowserTerminal` now passes the `"paneCapture"` stream kind only for `input.paneCapture`; stdout and stderr use the default. Added two offline unit tests to `browser-terminal.test.mjs`: one proving a real newline in stdout survives redaction with the line count unchanged (regression for the `alpha step=2` swallowing bug), and one proving a pane capture with a value wrapped across a hard newline is still fully redacted to `token=[redacted]` with `findTerminalResidue` returning `null`. This entry is `documentation`/`offline`: it records a source change and node-level unit-test additions authored in this session. This session has no command-execution capability, so the `bash experiments/probes/worker-sessions/run.sh` pass under real tmux (`measured-no-credit`, tmux `3.3a` was the last version observed on this host) is not re-verified here; it is left to the configured gate sensor that runs after this turn. |
| 2026-08-08 | Re-reviewed the sanitizer fix and the five tests in `browser-terminal.test.mjs` on a second implementor attempt for the same task. Confirmed by static trace that the three pre-existing tests are unchanged in file and in intent, and that the two wrap-boundary regression tests (real-newline survival on the default stream; full masking of a pane-captured wrapped secret) exercise exactly the counterexamples in the finding above. This entry is `documentation`/`offline`: no source or test logic changed. The command `node --test experiments/probes/worker-sessions/browser-terminal.test.mjs` and the tmux-backed `bash experiments/probes/worker-sessions/run.sh` were not executed in this session, which has no command-execution capability; both are left to the configured gate sensor that runs after this turn. |
| 2026-08-08 | Measured with the pane-scoped fix applied: tmux `3.3a` (same Debian 12 dev container, `x86_64`), command `bash experiments/probes/worker-sessions/run.sh`, result **PASS**. Both steps printed `PASS`/`pass`: the offline `node --test browser-terminal.test.mjs` step and the tmux-backed `node run-no-credit.mjs` step, whose emitted JSON reports `"result": "pass"` and `"evidenceKind": "measured-no-credit"` with `"aiCreditsSpent": false`. `assert.match(stdout, /alpha step=2/u)` at `run-no-credit.mjs` line 38 now passes because `sanitizeTerminalText` no longer applies the wrap-continuation clause to file-backed stdout: the worker-alpha stdout fixture's real newline between `token=worker-alpha-secret` and `worker-alpha step=2` survives redaction. The pane capture in the same run still fully redacts the wrap-split `token=worker-alpha-secret` to `token=[redacted]` with no residue. Evidence class: `measured-no-credit` (real tmux, deterministic shell workers, no model invoked, no AI cost). This result comes from the `run-probe` dependency task's second attempt, which closed on this measurement; this documentation update did not execute the command itself, since this session has no command-execution capability. |
