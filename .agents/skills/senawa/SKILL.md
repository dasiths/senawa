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
| List workflows | `senawa workflow list` |
| Inspect a workflow | `senawa workflow info <name>` |
| Start requested work | `senawa work start "<goal>" --workflow <name> --detach` |
| Read bounded status | `senawa work show` |
| Open the run console | `senawa browser [<run>]` |
| Wait for a bounded interval | `senawa work wait --timeout <seconds>` |
| Continue a stopped run | `senawa work resume` |
| Approve an artifact | `senawa approve <phase>` |
| Reject an artifact | `senawa reject <phase> --reason "<reason>"` |
| Steer a worker | `senawa steer <task> "<instruction>"` |
| End abandoned work | `senawa work end --reason "<reason>"` |

## Decision rules

Relay approval, rejection, steering, pause, abort, or end only after the human
explicitly chooses it. Give the human the artifact path rather than a summary to
approve. Quote sanitized sensor findings when work is refused.

Exit code `2` from a start or resume is a normal decision point. Read `status`
and `needs`, then report exactly what the run requires. Any other nonzero exit is
a failure and should be relayed without reinterpretation.