# What proves each claim

The documentation makes claims about how senawa behaves. Every claim here names
the test that proves it, and a check refuses the build when a name stops
matching anything real.

An index of claims nobody is proving reads more trustworthy than saying nothing
at all, so the links are checked rather than written down and forgotten. Run it
with `pnpm check:claims`.

A claim missing from this table is not necessarily unproven. The table grows as
claims are made; it does not certify the ones that are absent.

## Authoring

| Claim | Where it is stated | Proven by |
|---|---|---|
| An authored tree compiles with no diagnostics | docs/reference/authoring.md | `authored-parity.test.ts > compiles with no diagnostics` |
| Authored YAML lost no mechanism the internal template had | docs/reference/authoring.md | `template-parity.test.ts > reaches for every mechanism the internal template reaches for` |
| A concise workflow stays small because defaults exist | docs/reference/authoring.md | `authored-parity.test.ts > compiles the scaffold, which states almost no policy` |
| An explicit workflow loses no policy, because defaults are overridable | docs/reference/authoring.md | `authored-parity.test.ts > loses no policy in the explicit tree, because every default is overridable` |
| A prompt never carries senawa protocol text | docs/reference/authoring.md | `authored-parity.test.ts > carries no senawa protocol text in any authored prompt` |
| A gate measures a number and an advisory reading does not block | docs/reference/authoring.md | `authored-parity.test.ts > gates on a measured number and keeps an advisory reading non-blocking` |

## Where agents work

| Claim | Where it is stated | Proven by |
|---|---|---|
| One writer works in the repository by default | docs/reference/authoring.md | `brief-scenarios.test.ts > defaults to one writer in the repository, which needs no worktree` |
| Worktree mode isolates writers and names where work integrates | docs/guide/worktree-mode.md | `brief-scenarios.test.ts > lets an author isolate writers in worktrees and say where work integrates` |
| Parallel writers sharing one directory are refused | docs/reference/authoring.md | `brief-scenarios.test.ts > refuses parallel writers that would share one directory` |
| An integration ref the runtime would reject is refused at authoring | docs/reference/authoring.md | `brief-scenarios.test.ts > refuses a branch name the runtime would reject when the run started` |

## Sessions

| Claim | Where it is stated | Proven by |
|---|---|---|
| A run-scoped persona keeps one conversation across phases | docs/reference/authoring.md | `brief-scenarios.test.ts > carries one conversation across two phases of the same run` |
| One persona never resumes into another's conversation | docs/reference/authoring.md | `brief-scenarios.test.ts > gives each persona its own line, so one never resumes into another's` |
| A persona that starts fresh leaves nothing to resume | docs/reference/authoring.md | `brief-scenarios.test.ts > records nothing for a persona that starts fresh every time it works` |
| A conversation is renewed at the turns it was allowed | docs/reference/authoring.md | `brief-scenarios.test.ts > renews a conversation that has reached the turns it was allowed` |

## Models

| Claim | Where it is stated | Proven by |
|---|---|---|
| A retry moves to the next authored route | docs/reference/authoring.md | `brief-scenarios.test.ts > moves a retry to the next authored route and tells the agent it moved` |
| Retries settle on the last route when alternatives run out | docs/reference/authoring.md | `brief-scenarios.test.ts > settles on the last route once the policy runs out of alternatives` |

## Steering

| Claim | Where it is stated | Proven by |
|---|---|---|
| A steering is recorded with its actor before delivery | docs/reference/cli.md | `brief-scenarios.test.ts > records who redirected the run and what they said before delivering it` |
| `abort-retry` starts the attempt again carrying the instruction | docs/reference/cli.md | `brief-scenarios.test.ts > starts the attempt again carrying the instruction when asked to abort` |
| A queued instruction reaches the agent when it next stops | docs/reference/cli.md | `brief-scenarios.test.ts > hands a queued instruction to the agent when it next stops to ask` |
| An agent that has finished cannot be redirected | docs/reference/cli.md | `brief-scenarios.test.ts > refuses to redirect an agent that has already finished` |
| A live instruction reaches the agent mid-turn | docs/reference/cli.md | `copilot-worker.test.ts > delivers a person's instruction to the agent working right now` |
| A fan-out member can be redirected while it works | docs/reference/cli.md | `brief-scenarios.test.ts > records a fan-out steering against the member's own dispatch` |
| Every member of a fan-out runs, not only the first | docs/reference/authoring.md | `brief-scenarios.test.ts > dispatches the second member after the first one finishes` |
| A fan-out closes once every member has finished | docs/reference/authoring.md | `brief-scenarios.test.ts > closes the phase once every member has finished` |
| One member failing does not stop the rest under `continue` | docs/reference/authoring.md | `brief-scenarios.test.ts > runs the members that can finish when an earlier one cannot` |
| `fail-fast` stops the fan-out at the first failing member | docs/reference/authoring.md | `brief-scenarios.test.ts > stops the fan-out on the first failing member under fail-fast` |
| A person can accept work the run would not, and the run continues | docs/reference/cli.md | `brief-scenarios.test.ts > carries on after a person accepts the work the run would not` |
| An override is refused when nothing failed | docs/reference/cli.md | `brief-scenarios.test.ts > refuses an override when nothing reported that it could not finish` |

## A real agent

| Claim | Where it is stated | Proven by |
|---|---|---|
| An authored project drives a real Copilot agent to a finished run | docs/guide/getting-started.md | `live-run.test.ts > runs a project from clean directory to finished run` |
| A real agent finds the handshake from the generated contract alone | docs/reference/cli.md | `live-loop.test.ts > completes a phase it was never told how to complete` |

## The command line

| Claim | Where it is stated | Proven by |
|---|---|---|
| A consumer can scaffold, validate, start, drive, and finish a run | docs/guide/getting-started.md | `command-surface.test.ts > scaffolds, validates, starts, and drives a run` |
| An agent reads its own context and schema through its channel | docs/reference/cli.md | `command-surface.test.ts > lets a dispatched agent read its own context and schema` |
| The IPC credential never appears in status or diagnostics | docs/guide/security.md | `command-surface.test.ts > keeps the IPC credential out of status and diagnostics` |
| A broken prompt is refused at validation | docs/guide/troubleshooting.md | `command-surface.test.ts > refuses to validate an authored tree with a broken prompt` |
