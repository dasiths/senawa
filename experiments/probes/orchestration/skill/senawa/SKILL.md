# Senawa

Senawa runs a phased workflow: it decomposes a goal, dispatches role-scoped
worker sessions, and refuses to let work advance until its sensors and gates say
it is sound. You drive it through the `senawa` command and nothing else.

## Mental model

A run has phases such as define, research, plan, implement, and verify. A phase
produces an artifact. Some phases require the user's approval before the run
continues, and a rejected phase runs again on top of what it already produced.

The harness grants completion; agents never claim it. Your job is to translate
what the user wants into `senawa` commands, and to explain what came back.

## Commands you use

| Intent | Command |
|--------|---------|
| What can we run here | `senawa workflow list` |
| What does a workflow do | `senawa workflow info <name>` |
| Check the configuration is sound | `senawa doctor` |
| Start work | `senawa work start "<goal>" --workflow <name>` |
| Continue after the user decides | `senawa work resume` |
| Where is the run | `senawa work show` |
| Accept a phase | `senawa approve <phase>` |
| Send a phase back | `senawa reject <phase> --reason "<why>"` |
| Add work after verification | `senawa plan revise --add <file>` |
| Redirect a running worker | `senawa steer <task> "<instruction>"` |

## Exit codes

`senawa work start` and `senawa work resume` drive the run and then stop.

* `0` means the run finished and the user accepted it.
* `2` means the run needs the user. This is normal, not an error. Read the
  output, then tell the user what is needed.
* Anything else is a real failure. Report it verbatim.

## Reading status

`senawa work show` returns JSON. Answer from `status` and `needs`:

* `status` is one of `running`, `awaiting_approval`, `paused`, `escalated`, `finished`.
* `needs` is null, or exactly what the user owes the run.

## Rules

Quote sensor findings verbatim when explaining a refusal. Never describe a
mechanism you did not read in the output; if you do not know why something was
refused, say so and show the finding.

Hand the user the artifact path when a phase needs approval. Do not summarise an
artifact and let the user approve your summary.

Approve or reject only when the user has told you to. Their judgement is the
thing the harness is protecting.

Never run `bd`, read `journal.jsonl`, or open files under
`.agents/.copilot-tracking/`. `senawa` is the whole interface. Task identifiers
are opaque handles; do not interpret them.

Do not decide what runs next. The harness owns that, and guessing at it produces
answers that contradict the run.
