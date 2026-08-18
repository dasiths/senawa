---
title: Workflow authoring
description: How to describe a workflow in the three authored files senawa reads
ms.date: 2026-08-18
ms.topic: how-to
---

You describe a workflow in three files under `.senawa`, plus the prompts and
schemas they point at. Senawa compiles them into an immutable, content-addressed
snapshot. Nothing outside that snapshot can widen what a run may do.

Run `senawa doctor` after every change. It reports all problems at once, runs
nothing, and costs nothing.

## The three files

`senawa init` writes a working example of all three.

| File | What it says |
|---|---|
| `workflow.yaml` | The phases, their order, and what each one produces |
| `agents.yaml` | Who does the work, and which model and prompt each uses |
| `sensors.yaml` | The commands that measure the work, and the gates over them |

A fourth thing is not a file: senawa's own instructions to the agent. You never
write those. Senawa generates them at dispatch time from what the phase actually
allows, and adds them to the prompt. This is why no prompt you write mentions a
senawa command.

## workflow.yaml

```yaml
name: delivery
input: schemas/request.schema.json

phases:
  - name: plan
    agent: planner
    output: schemas/plan.schema.json

  - name: implement
    agent: implementor
    needs: [plan]
    output: schemas/implementation.schema.json
    gates: [clean-tree]
```

`needs` names the phases that must finish first, and it is also how a phase gets
its input: a phase can read the output of any phase it needs.

`output` names the schema the phase must produce. It is a promise the phase is
held to, not a suggestion. A phase cannot finish without producing output that
validates against it.

### Saying more about an output

The scalar form above is shorthand. The expanded form takes a ceiling, a
sensitivity, and a path to write the asset to:

```yaml
    output:
      schema: schemas/plan.schema.json
      sensitivity: confidential
      maxBytes: 262144
      path: docs/plan.md
```

`sensitivity: confidential` keeps the content out of context assembly for later
phases, out of the portal, and out of exported reports.

### Approval

```yaml
    approve: true
```

The phase stops after its gates pass and waits for a person. The expanded form
names who may decide and what happens when they reject:

```yaml
    approve:
      role: release-manager
    onGateRejected: fail
```

### Iteration

By default a phase that fails its gates tries again, up to a limit. State it
directly when you want something else:

```yaml
    attempts: 3
    onGateRejected: iterate
    onExhausted: escalate
```

`escalate` raises the decision to a person rather than failing the run.
`onGateRejected` and `onApprovalRejected` take `iterate` or `fail`.
`onExhausted` and `onUpstreamChanged` take `escalate` or `fail`.

### Fan-out

A phase can run once per item in an earlier phase's output:

```yaml
  - name: implement
    agent: implementor
    needs: [plan]
    forEach: plan.tasks
    collection: schemas/task-collection.schema.json
```

`collection` names the shape of the array being iterated. Senawa validates the
collection separately from the phase output, so you say it rather than letting it
be inferred.

## agents.yaml

```yaml
planner:
  model: gpt-5
  prompt: prompts/planner.md
```

The model and the prompt are all you supply. Senawa derives the rest.

### Model routing

Give an ordered list when a model may be unavailable or may run out of room.
Each entry is a route, not a bare name:

```yaml
planner:
  models:
    - model: gpt-5
      turns: 24
    - model: gpt-5-mini
      turns: 12
  prompt: prompts/planner.md
```

Senawa uses the first that works and records why it moved on. A route may also
set `submissions` and `spend`. Declare either `model` or `models`, never both.

### Session scope

```yaml
implementor:
  model: gpt-5
  prompt: prompts/implementor.md
  session: element
```

`session: element` gives each fan-out member its own conversation. The default
keeps one conversation for the phase.

## Prompts

A prompt describes the assignment. That is all.

```markdown
Write a plan for the request below.

Request: ${{ input.request }}
```

Do not write "call senawa worker complete" or "return JSON matching the schema".
Senawa adds its own instructions telling the agent exactly how to finish,
generated from the capabilities the dispatch actually grants. A prompt that also
tries to say it will contradict senawa the moment the phase changes.

`${{ input.request }}` reads from the workflow input. `${{ plan.tasks }}` reads
from a phase the current phase needs.

## sensors.yaml

A sensor runs a real command and returns a reading.

```yaml
sensors:
  clean-tree:
    run: git diff --exit-code
    deterministic: true

  coverage:
    run: pnpm test --coverage --reporter=json
    deterministic: true
    timeout: 10m
```

`deterministic: true` means the same input gives the same reading. Only a
deterministic reading can anchor a blocking gate, because a gate resting on a
model's opinion is a gate agreeing with whoever submitted the work.

### Gates

```yaml
gates:
  clean-tree:
    blocking:
      - sensor: clean-tree
        exitCode: 0

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

A blocking rule refuses. An advisory rule is recorded and shown but never
refuses. `field` names a path into the reading.

Every gate needs at least one blocking rule. A gate made only of advisory rules
refuses nothing, so senawa treats it as a mistake rather than a gate.

Comparisons available: `exitCode`, `equals`, `atLeast`, `atMost`, `exists`.

Senawa refuses a blocking gate with no deterministic reading behind it, and it
refuses it when you write it rather than when you run it.

## Defaults

Anything a phase does not say, it takes from `defaults`:

```yaml
defaults:
  attempts: 3
  onGateRejected: iterate
  onExhausted: escalate
```

A phase that states the same field overrides it. A default is not a
simplification if you cannot override it.

## Checking your work

```bash
senawa doctor
```

Doctor reads the three files, resolves every prompt and schema they reference,
and reports everything wrong at once. It never runs a command or spends a token.

Common refusals:

| Refusal | What to do |
|---|---|
| `unknown-field` | Check the spelling; senawa refuses fields it does not know rather than ignoring them |
| `missing-anchor` | Your blocking gate has no deterministic sensor behind it |
| `unresolved-reference` | A prompt, schema, or phase name points at something absent |
| `invalid-api-version` | The document is not a shape this senawa understands |

## Related

* [Getting started](getting-started.md) walks the first run end to end.
* [CLI reference](../reference/cli.md) lists every command.
* [Dataflow](../design/dataflow.md) explains how output moves between phases.
