# Research, plan, implement

A workflow that asks a person what they actually want, plans the work, and then
builds it with one agent per task. The request is deliberately vague:

> Build me a tic-tac-toe game in Node.js.

The research agent is told to ask before it decides. Answering it is the point
of this example.

Everything here spends AI credits from your `copilot login`. Nothing runs
until you ask it to.

## Before you start

```bash
copilot login               # once, if you have not
pnpm --dir ../.. build      # builds the senawa this Makefile runs
make check                  # compiles the workflow and reports every problem
```

`make check` reads `.senawa/` and prints `./.senawa: valid`. It costs nothing and
contacts nothing.

## What is in here

| Path | What it is |
| --- | --- |
| `.senawa/agents.yaml` | Three personas, and which model each runs on |
| `.senawa/workflow.yaml` | The phases, what each reads and writes, and its gate |
| `.senawa/sensors.yaml` | The one command that measures the project, and the gate over it |
| `.senawa/prompts/` | What each agent is for. None of them mention senawa |
| `.senawa/schemas/` | The shape of everything that crosses a phase boundary |
| `scripts/check.mjs` | Runs the project's tests. The `tests` gate reads its exit code |
| `workspace/` | Where the agents write. Created by `make run`, removed by `make clean` |

The prompts say nothing about how to hand work in. Senawa appends its own
operating contract to every prompt at dispatch, which is the only place an agent
is told how to finish, how to ask, and what it may not do.

## Drive it from the browser

```bash
make run                    # writes the request, starts the run, starts the service
make portal                 # prints a single-use URL
```

`make portal` prints a bootstrap URL that is good once and expires in sixty
seconds. Open it and you have a read-write session for up to eight hours. Open a
second tab and it is read-only, because only one session may act. Run
`make portal` again for a fresh read-write session.

The views worth knowing:

* **Agents** — who is working, on what, and on which model. This is where you
  see that the research agent is a `claude-haiku-4.5` session working on
  `research`.
* **Questions** — what an agent stopped to ask. Type an answer and the run picks
  it up.
* **Run** — the phases, their attempts, and what each one produced.

Steering and overriding are buttons in the agent view. Neither needs the command
line.

## Drive it from the command line

```bash
make run
# note the run and repository it prints, then:
make status  REPO=repository_rpi-workflow RUN=run_...
make answer  REPO=repository_rpi-workflow RUN=run_... TEXT="Node.js 22."
make advance REPO=repository_rpi-workflow RUN=run_...
make agents  REPO=repository_rpi-workflow RUN=run_...
make game
```

`make status` lists what the run is waiting on, oldest first. `make answer`
answers that first question and prints which one it answered. `make advance`
takes one step: it delivers answers, closes phases, and starts the next one.

A typical session looks like this:

```
$ make status REPO=... RUN=...
waiting on you: 1
  - question: Which Node.js version should the tic-tac-toe game support?

$ make answer REPO=... RUN=... TEXT="Node.js 22. Nothing older needs to work."
answered: Which Node.js version should the tic-tac-toe game support?

$ make advance REPO=... RUN=...
dispatched research as dispatch_5631...
```

## What happens when the agent asks

1. The agent calls senawa rather than writing the question into its reply. A
   question in a reply reaches nobody.
2. The question is durable, and the run stops. Nothing else is dispatched while
   a question is unanswered.
3. You answer, in the portal or with `make answer`. The answer is bound to the
   exact question it answers.
4. `make advance` dispatches the phase again, carrying the question and your
   answer in your words. The agent reads them and carries on.

The answer arrives on a **new attempt**, because the turn that asked must not be
able to hand work in afterwards. So each question spends an attempt, which is
why the research phase authors `attempts: 8` rather than the default three.

## What the run does

```
research ── asks you what you actually want, records the answers
    │
   plan ── turns the request and the research into three to five tasks
    │
implement ── one agent per task, each gated on `node scripts/check.mjs`
```

`implement` fans out: one member per planned task, each with its own attempts and
its own gate. A member that cannot pass does not block the ones that did, because
the phase authors `onFailure: continue`.

## Watching it

```bash
make agents REPO=... RUN=...   # dispatch ids and their contexts
make status REPO=... RUN=...   # phases, agents, and what is waiting on you
make game                      # the files the agents wrote
node scripts/check.mjs         # the same check the gate runs
```

## Stopping and starting over

```bash
make stop     # drains and stops the service, leaves the run
make clean    # stops, then removes the run state and everything the agents wrote
```

`make clean` removes `.senawa-state/`, `workspace/`, and `request.json`. The
workflow itself is untouched.

## Notes

The service and the run are separate. `senawa start` writes the run and exits;
`senawa service start` runs the agents. `make run` does both, in that order,
because a service picks up work at startup.

The commands that write work — `advance`, `answer`, `approve`, `steer` — wake a
running service over its local socket, so you do not need to restart it after
answering.

Agents write only to `workspace/`. The workflow, the sensors, and this README are
outside it and no agent can reach them.
