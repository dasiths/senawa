# Authoring reference

A consumer authors three YAML documents plus prompts and JSON schemas. This page
lists every field each accepts, what it defaults to when omitted, and what senawa
says when it is wrong. [The authoring guide](../guide/workflow-authoring.md)
teaches the same surface by example.

Every value here was read from the compiler rather than from documentation, so a
field absent from this page is a field senawa refuses.

## The project layout

```text
.senawa/agents.yaml
.senawa/workflow.yaml
.senawa/sensors.yaml
.senawa/prompts/*.md
.senawa/schemas/*.schema.json
```

`senawa init` creates all five. `senawa doctor` validates them.

## workflow.yaml

### Top level

| Key | Required | Shape | Default |
|---|---|---|---|
| `name` | Yes | Non-empty string | None |
| `input` | Yes | Path to the schema the run's request satisfies | None |
| `phases` | Yes | List of phases, in order | None |
| `defaults` | No | Iteration policy inherited by every phase | Empty |

`defaults` accepts the same five iteration keys a phase accepts: `attempts`,
`onGateRejected`, `onApprovalRejected`, `onUpstreamChanged`, and `onExhausted`.

### execution

```yaml
execution:
  workspace: worktree
  maxWriters: 3
  integrationRef: refs/heads/main
```

| Key | Required | Shape | Default |
|---|---|---|---|
| `workspace` | No | `repository` or `worktree` | `repository` |
| `maxWriters` | No | Positive whole number | `1` |
| `integrationRef` | With `worktree` | Full local ref, such as `refs/heads/main` | None |

By default one agent writes at a time, directly in the repository, which is the
shape a person can reason about without knowing anything about worktrees.

`worktree` gives each writer its own checkout, which is the only way more than
one can safely run at once; see [worktree mode](../guide/worktree-mode.md).
More than one writer in a shared `repository` is refused rather than allowed to
produce edits nobody can attribute.
A phase that states one overrides the default for itself alone.

### A phase

| Key | Required | Shape | Default |
|---|---|---|---|
| `name` | Yes | Non-empty string, unique in the workflow | None |
| `agent` | Yes | A key from `agents.yaml` | None |
| `output` | Yes | Schema path, or the expanded form below | None |
| `needs` | No | Names of earlier phases this one reads | Empty |
| `input` | Conditional | Schema path | Derived from `needs` |
| `gates` | No | Gate or sensor names | Empty |
| `approve` | No | `true`, or the expanded form below | No approval |
| `attempts` | No | Whole number 1 to 20 | `defaults.attempts`, else 3 |
| `onGateRejected` | No | `iterate` or `fail` | `iterate` |
| `onApprovalRejected` | No | `iterate` or `fail` | `iterate` |
| `onUpstreamChanged` | No | `iterate` or `fail` | `iterate` |
| `onExhausted` | No | `escalate` or `fail` | `escalate` |
| `onFailure` | No | `continue` or `fail-fast` | `continue` |
| `forEach` | No | `phase.field`, naming an upstream collection | No fan-out |
| `collection` | With `forEach` | Schema the selected array satisfies | None |
| `completionEvidence` | No | The expanded form below | Collects none |
| `completionEvidenceFrom` | No | The expanded form below | Reads none |

An unknown key is refused by name, so a misspelled `approve` is a diagnostic
rather than a phase that silently never asks anyone.

#### Deriving `input`

A phase that names no `needs` reads the workflow input. A phase that names one
reads that phase's output schema. A phase that names more than one is asked to
say what the merged shape is, because senawa will not invent it:

```text
workflow.yaml#/phases/2/input [missing-field] Phase verify reads 2 upstream outputs, so it must declare an input schema
```

#### Expanded `output`

```yaml
    output:
      schema: schemas/verification.schema.json
      sensitivity: confidential
      maxBytes: 65536
```

`sensitivity` is one of `public`, `internal`, `confidential`, or `restricted`,
and defaults to `internal`. `maxBytes` is at most 262144, which is also the
default. The scalar form `output: schemas/x.schema.json` means the same as
naming only `schema`.

#### Expanded `approve`

```yaml
    approve:
      role: release-manager
```

`approve: true` requires a decision without naming who may give it.

#### Expanded `completionEvidence`

```yaml
    completionEvidence:
      mode: task
      require:
        - kind: task-completion
          min: 1
```

`mode` is one of `none`, `task`, `required-criteria`, or `all-satisfied`, and
defaults to `none`. `min` defaults to 1. Requiring evidence under `mode: none`
is refused, because a mode that collects nothing cannot owe anything.

#### Expanded `completionEvidenceFrom`

```yaml
    completionEvidenceFrom:
      - phase: implement
        kinds: [task-completion]
        maxSensitivity: internal
```

The kinds are an allowlist and `maxSensitivity` caps what may cross the phase
boundary. It defaults to `internal`.

#### Fan-out

A fan-out needs three schemas, not two: the collection it iterates, the element
one member reads, and the output a member produces.

```yaml
  - name: implement
    agent: implementor
    needs: [plan]
    forEach: plan.tasks
    collection: schemas/task-collection.schema.json
    input: schemas/task.schema.json
    output: schemas/implementation.schema.json
    onFailure: continue
```

v1 compiles a fan-out and does not yet run one. Nesting a fan-out inside a
fan-out is refused when it is written.

## agents.yaml

Each top-level key names an agent.

| Key | Required | Shape | Default |
|---|---|---|---|
| `prompt` | Yes | Path to a prompt template | None |
| `model` | One of two | Model identifier | None |
| `models` | One of two | Ordered route list | None |
| `provider` | No | Provider name | `github-copilot` |
| `session` | No | `run`, `phase`, or `element` | `run` |
| `credits` | No | Positive number | 1 |

Declaring both `model` and `models` is refused. A route in `models` is an object,
never a bare string:

```yaml
planner:
  prompt: prompts/planner.md
  models:
    - model: gpt-5
      turns: 7
      submissions: 3
      spend: 250
    - model: gpt-5-mini
      turns: 2
```

Per route, `turns` defaults to 12, `submissions` to 4, and `spend` to 5000.

Routes are tried in the order they are written. An attempt that has to be retried
moves to the next route, because repeating a route that just failed spends an
attempt to learn nothing, and the agent is told it changed model rather than
being swapped silently. Once the list runs out, retries stay on the last route.

An agent's prompt describes the work and never mentions senawa. The operating
contract that tells an agent how to finish is generated at dispatch and appended
after the prompt; see [the CLI reference](cli.md#the-agent-channel).

### session

`session` says how much an agent remembers between the times it works.

| Value | The agent remembers |
| --- | --- |
| `run` (default) | everything it did earlier in this run |
| `phase` | its earlier attempts at the phase it is working on |
| `element` | nothing; it starts fresh each time |

Each agent holds its own conversation, and one agent never resumes into
another's. Under `run`, a fan-out member still gets a conversation of its own,
because a member is a piece of work rather than a train of thought.

A remembered conversation is only resumed when the work around it has not moved
underneath it. Under `phase`, a changed graph or configuration starts a fresh
conversation rather than a misleading one; under `run`, only a configuration
change does. When a conversation is dropped this way, the run says so instead of
quietly starting over.

### sessionTurns

`sessionTurns` bounds how many turns one conversation carries before it is
renewed, and defaults to 24. A conversation that never ends grows until it costs
more than it is worth, so a long-lived `session` needs a bound.

```yaml
reviewer:
  model: gpt-5
  prompt: prompts/reviewer.md
  session: run
  sessionTurns: 12
```

Reaching the bound is a renewal, which is the policy working as authored. It is
reported separately from a conversation lost because the work moved under it.

> [!NOTE]
> A conversation is renewed whole rather than summarised into its successor.

## sensors.yaml

### A sensor

| Key | Required | Shape | Default |
|---|---|---|---|
| `run` | Yes | Command line, split on whitespace | None |
| `deterministic` | No | Boolean | `true` |
| `cwd` | No | Working directory | `.` |
| `timeout` | No | Milliseconds, or a duration like `10m` | 300000 |
| `maxOutput` | No | Bytes, or a size like `64k` | 65536 |
| `env` | No | Variable names to inherit | `PATH` only |
| `attempts` | No | Whole number 1 to 16 | 3 |
| `reconciliationAttempts` | No | Whole number 1 to 16 | 2 |

`PATH` is always present whatever `env` says. A value outside the 1 to 16 range
is refused rather than clamped, because a clamped value is a policy the author
did not write and cannot see.

### A gate

```yaml
gates:
  coverage:
    blocking:
      - sensor: coverage
        field: /total/lines/pct
        atLeast: 80
    advisory:
      - sensor: coverage
        field: /total/branches/pct
        atLeast: 70
```

A gate needs at least one blocking rule, and at least one blocking rule must rest
on a deterministic sensor. A gate that measures without ever refusing is not a
gate, and a blocking gate resting on a sensor that can disagree with itself is
the harness agreeing with whoever submitted the work.

Each rule names a sensor and exactly one comparison: `exitCode`, `equals`,
`atLeast`, `atMost`, or `exists`. `field` is a JSON pointer into the reading, and
is required for every comparison except `exitCode`, which defaults to
`/exitCode`.

A phase may name a sensor directly in `gates`. That is shorthand for a blocking
rule requiring that sensor's exit code to be zero.

## What an author cannot set

These are host limits rather than workflow policy, so they are named here rather
than presented as defaults an author forgot to change.

| Limit | Value | Why |
|---|---|---|
| Members running at once | 1 | v1 executes sequentially |
| Writers at once | 1 | Same decision |
| Selected collection items | 64 | Host ceiling |
| Total generated tasks | 256 | Host ceiling |
| Output bytes | 262144 | Protocol limit |
| Prompt pack bytes | 65536 | Protocol limit |

## Refusals

Every diagnostic names the file, the path inside it, and the reason:

```text
- [invalid-prompt-template] prompts/implementor.md: Invalid prompt template token at character offset 20
- [unknown-reference] workflow.yaml#/phases/1/agent: Unknown agent implementor
```

| Code | It means |
|---|---|
| `missing-field` | A required key is absent |
| `invalid-field` | A key carries a value the field does not accept |
| `unknown-field` | A key the reader does not know, usually a misspelling |
| `unknown-reference` | A name that points at nothing declared |
| `duplicate-key` | The same phase name twice |
| `invalid-gate` | A gate with no blocking rule, no anchor, or no comparison |
| `invalid-sensor` | A sensor with no command |
| `invalid-prompt-template` | A prompt whose substitution tokens do not parse |
| `missing-resource-path` | A prompt or schema the tree does not contain |
| `invalid-document` | YAML that does not parse, or is not a mapping |

Nothing compiles partially. A document senawa cannot compile is refused whole,
rather than compiled with the part it did not understand dropped.

## Related reading

* [Workflow authoring](../guide/workflow-authoring.md) teaches this surface.
* [The CLI reference](cli.md) covers the loop and the agent channel.
* [Getting started](../guide/getting-started.md) walks a first project.
