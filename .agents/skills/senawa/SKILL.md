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
| Open the run console | `senawa browser [<run>]` |
| Wait for a bounded interval | `senawa work wait --timeout <seconds>` |
| Continue a stopped run | `senawa work resume` |
| Pause an idle driver | `senawa work pause` |
| Audit recorded sensor stability | `senawa sensor audit [<run>]` |
| Render the complete run report | `senawa work report [<run>]` |
| Approve an artifact | `senawa approve <phase>` |
| Reject an artifact | `senawa reject <phase> --reason "<reason>"` |
| Steer a worker | `senawa steer <task> "<instruction>"` |
| End abandoned work | `senawa work end --reason "<reason>"` |
| Force-end a stranded worker | `senawa work end --force --reason "<reason>"` |

## Decision rules

Relay approval, rejection, steering, pause, abort, or end only after the human
explicitly chooses it. Give the human the artifact path rather than a summary to
approve. Quote sanitized sensor findings when work is refused.

Exit code `2` from a start or resume is a normal decision point. Read `status`
and `needs`, then report exactly what the run requires. Any other nonzero exit is
a failure and should be relayed without reinterpretation.

Beads is the default runtime. Use global `--runtime file` only for development,
tests, or the file-backed demo. Never retry a failed Beads command with the file
runtime. Start and resume are foreground commands; no detached driver is
available. Use forced end only after the human explicitly chooses abandonment;
it cancels the active worker, waits a bounded grace period, takes a fenced stale
lease, reconciles the dispatch, and releases repository ownership last.