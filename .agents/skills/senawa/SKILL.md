---
name: senawa
description: Drive Senawa workflows through bounded commands while preserving explicit human decisions.
---

# Senawa

Use the `senawa` command as the complete interface to repository work. Do not
call `bd`, inspect runtime tracking files, enter worker sessions, or choose the
next workflow transition.

## Commands

| Intent | Command |
|--------|---------|
| Validate repository definitions | `senawa doctor` |
| Validate a workflow | `senawa workflow validate [<name>]` |
| List workflows | `senawa workflow list` |
| Inspect a workflow | `senawa workflow info <name>` |
| Start requested work | `senawa work start "<goal>" --workflow <name>` |
| Read bounded status | `senawa work show` |
| Read an approval overview | `senawa phase brief <phase>` |
| Inspect a phase artifact before approval | `senawa phase artifact <phase>` |
| Open the run console | `senawa browser [<run>]` |
| Wait for a bounded interval | `senawa work wait --timeout <seconds>` |
| Continue a stopped run | `senawa work resume` |
| Pause an idle driver | `senawa work pause` |
| Audit recorded sensor stability | `senawa sensor audit [<run>]` |
| Render the complete run report | `senawa work report [<run>]` |
| Approve an exact artifact | `senawa --caller principal-agent approve <phase> --expected-version <version> --expected-digest <digest>` |
| Reject an exact artifact | `senawa --caller principal-agent reject <phase> --expected-version <version> --expected-digest <digest> --reason "<reason>"` |
| Steer a worker | `senawa steer <task> "<instruction>"` |
| End abandoned work | `senawa work end --reason "<reason>"` |
| Force-end a stranded worker | `senawa work end --force --reason "<reason>"` |

## Decision rules

Relay approval, rejection, steering, pause, abort, or end only after the human
explicitly chooses it. The `--caller principal-agent` option records PA
provenance. It does not grant human authority or satisfy a `human-direct`
approval requirement. Quote sanitized sensor findings when work is refused.

After every bounded stop from start, resume, wait, or exit code `2`, follow this
sequence:

1. Run `senawa work show` and report the bounded state and `needs`.
2. When approval is required, run `senawa phase brief <phase>`. Present its exact
	artifact path, version, digest, and Senawa-generated overview without adding
	an approval recommendation.
3. Present the complete artifact with `senawa phase artifact <phase> --version
	<version>` or present the brief's supported full-artifact command.
4. Ask neutrally whether the human chooses to approve that exact artifact,
	reject it with a reason, or leave it pending.
5. Relay only the explicit human choice. Include `--caller principal-agent`,
	`--expected-version <version>`, and `--expected-digest <digest>` on approval
	or rejection. Do not infer a decision from silence, prior approval, wording
	about quality, or a request to continue.
6. Run `senawa work resume`, then report the next bounded state. Do not choose
	the next workflow transition yourself.

Exit code `2` from a start or resume is a normal decision point. Read `status`
and `needs`, then report exactly what the run requires. Any other nonzero exit is
a failure and should be relayed without reinterpretation.

Beads is the default runtime. Use global `--runtime file` only for development,
tests, or the file-backed demo. The persisted `copilot-sdk` worker host is the
canonical choice for normal work. Select `--worker-host simulated` explicitly
only for tests, simulations, and no-credit probes. Never retry a failed live
worker command through simulation, and never retry a failed Beads command with
the file runtime. Start and resume are foreground commands; no detached driver
is available. Use forced end only after the human explicitly chooses
abandonment; it cancels the active worker, waits a bounded grace period, takes a
fenced stale lease, reconciles the dispatch, and releases repository ownership
last.