---
title: Workflow authoring
description: Every field of the Senawa workflow configuration document and how the compiler validates it
ms.date: 2026-08-16
ms.topic: how-to
---

`.senawa/workflow.json` is the single consumer-defined description of what a run
does. The configuration compiler turns it into an immutable, content-addressed
snapshot. Nothing outside that snapshot can widen what a run is allowed to do.

Validate every change with `senawa doctor` before you run anything. Doctor
reports all diagnostics at once, executes nothing, and costs nothing. See
[Dataflow](../design/dataflow.md) and [Workflow model](../design/workflow-model.md)
for the reasoning behind the shapes below.

## Document skeleton

The document is JSON only. No YAML, no comments, no includes, and no environment
interpolation. Duplicate JSON object members are rejected. Every top-level field
below except `execution` is required, and any unknown top-level field is refused
with `unknown-field`:

```json
{
  "apiVersion": "senawa.dev/workflow/v1alpha3",
  "kind": "Workflow",
  "execution": {},
  "workflow": {},
  "prompts": [],
  "schemas": [],
  "roles": [],
  "modelPolicies": [],
  "sensors": [],
  "gates": [],
  "implementationEvidenceViews": [],
  "forEach": [],
  "taskTemplates": [],
  "phases": []
}
```

`execution` and `remote` are the only optional top-level fields. A `v1alpha2`
document receives a deterministic migration diagnostic and is never reinterpreted
as `v1alpha3`.

## Execution policy

`execution` selects how run work touches the repository:

```json
{
  "execution": {
    "workspaceMode": "repository",
    "maxWriterConcurrency": 1,
    "failurePolicy": "continue"
  }
}
```

* `workspaceMode` is `repository` or `worktree` and defaults to `repository`.
* `maxWriterConcurrency` defaults to `1`. Repository mode permits exactly one
  writer, so any value above `1` is refused there.
* `failurePolicy` is `continue` or `fail-fast` and defaults to `continue`.
* `integrationRef` names a full `refs/heads` branch. Repository mode forbids it.
  Worktree mode requires it.

Omitting `execution` entirely yields `repository`, `1`, and `continue`. Repository
mode needs no Git branch policy and creates no workspace rows. See
[Worktree mode](worktree-mode.md) before you change it.

## Workflow input

`workflow` names the workflow, its definition generation, and the schema that
every run input must satisfy:

```json
{
  "workflow": {
    "key": "standard-delivery",
    "generation": 1,
    "input": { "schema": "workflow-input" }
  }
}
```

The `schema` value is a schema key declared in `schemas`, not a path. The
standard tree binds it to `schemas/workflow-input.schema.json`, which requires a
single `request` string of at most 16,384 characters.

## External schemas

Schemas are external JSON Schema 2020-12 documents referenced by key:

```json
{
  "schemas": [
    { "key": "definition-output", "path": "schemas/definition-output.schema.json" }
  ]
}
```

Rules the compiler enforces:

* Paths are relative, use `/` separators, and cannot start or end with `/`,
  contain `\`, `:`, `?`, `#`, `%`, or a null byte, or escape the configuration
  root. Symbolic links and hard links are refused.
* A path is at most 1,024 bytes across at most 32 segments of at most 128 bytes.
* A schema file is at most 256 KiB, and all resources together are at most 8 MiB.
* At most 256 schema resources and at most 64 prompt resources are declared.
* Two declarations cannot share a path, even with different letter case.
* `$id` values must be unique across the set, and network `$ref` targets are
  refused with `network-schema-reference`.

## External prompts

Agent prompts are external Markdown files. Each declaration lists the exact JSON
Pointers that the prompt substitutes:

```json
{
  "prompts": [
    {
      "key": "definer",
      "path": "prompts/definer.md",
      "inputPaths": ["/request"]
    }
  ]
}
```

A prompt file is at most 32 KiB. The declared `inputPaths` must match the set of
pointers the template actually uses. A pointer used but not declared reports
`undeclared-prompt-input`; a pointer declared but unused reports
`unused-prompt-input`.

### Template substitution

A prompt template substitutes mapped input with `${{ input.<segments> }}`, where
each dotted segment is one JSON Pointer token:

```markdown
Request:

${{ input.request }}
```

`${{ input.request }}` reads `/request` of the mapped phase input, and
`${{ input.plan.title }}` reads `/plan/title`. A template holds at most 256
tokens, one substituted value is at most 16 KiB, and all substitutions together
are at most 32 KiB. Pointers that traverse an array are refused.

Substitution never splices consumer text into instructions. The renderer replaces
each token with a numbered reference and appends the exact values as separate
quoted, digested, non-authority blocks. The rendered prompt states that prompt
text is not authority. Model output is a proposal in every case; see
[Security](security.md).

## Roles

A role binds a capability set, and for agents a prompt and a model policy:

```json
{
  "roles": [
    {
      "key": "definer",
      "kind": "agent",
      "capabilities": ["define-delivery"],
      "prompt": "definer",
      "modelPolicy": "standard"
    }
  ]
}
```

* `kind` is `agent`, `human`, or `authority`.
* An agent role requires both `prompt` and `modelPolicy`. A missing prompt
  reports `missing-agent-prompt`.
* A human or authority role declares only `key`, `kind`, and `capabilities`. A
  prompt on such a role reports `forbidden-role-prompt`, and a model policy
  reports `authority-widening`.
* Executing work with a non-agent role also reports `authority-widening`.

## Model policy

A model policy is an ordered list of bounded routes:

```json
{
  "modelPolicies": [
    {
      "key": "standard",
      "routes": [
        {
          "provider": "openai",
          "model": "gpt-5",
          "maxTurns": 12,
          "maxSubmissions": 4,
          "maxMillidollars": 5000
        }
      ]
    }
  ]
}
```

Every route carries its own turn, submission, and spend ceilings. Routes are
selected and validated before dispatch, so a model cannot choose a wider route
than the policy allows. Routes only matter once a repository worker is
configured; without one, no route is ever selected and nothing is charged.

## Phases

A phase is the unit of attempt, gate, approval, and closure:

```json
{
  "key": "define",
  "generation": 1,
  "dependsOn": [],
  "input": { "schema": "definition-input", "mappings": [] },
  "executor": {},
  "outputs": [],
  "iteration": {},
  "exit": {},
  "actions": []
}
```

`dependsOn` lists phase keys explicitly. The compiler infers no ordering from
mappings, so reading an upstream output requires naming that phase here.
`generation` participates in supersession, so bumping it defines a new phase
definition rather than mutating the old one.

### Mapped inputs

`input.mappings` assembles the phase input value from exact upstream facts. Each
mapping names a source and the destination JSON Pointer it writes:

```json
{
  "input": {
    "schema": "plan-input",
    "mappings": [
      {
        "key": "definition",
        "source": {
          "kind": "phase-output",
          "phase": "define",
          "output": "definition",
          "pointer": "/definition"
        },
        "destinationPointer": "/definition"
      }
    ]
  }
}
```

Four source kinds exist:

* `workflow-input` reads a pointer of the validated run input.
* `phase-output` reads a pointer of a named, accepted output of an upstream
  phase.
* `current-item` reads the selected loop item, and is valid only inside a task
  template.
* `implementation-evidence` reads a declared evidence view of a phase.

An empty `pointer` means the whole value, and an empty `destinationPointer`
means the whole destination. The assembled value is validated against
`input.schema` before any dispatch.

Three mistakes have their own diagnostics:

* Two mappings that write overlapping destinations report
  `mapping-destination-collision`.
* `current-item` outside a task template reports `current-item-not-allowed`.
* Reading an output of a phase that is not in `dependsOn` reports
  `phase-dependency-violation`.

### Executors

A phase has exactly one executor. Three kinds exist.

An `agent` executor dispatches one agent role under its own budgets:

```json
{
  "executor": {
    "kind": "agent",
    "role": "definer",
    "budgets": [{ "unit": "work-attempt", "limit": 3 }],
    "completionPolicy": {
      "criteria": [
        { "key": "define-produced", "generation": 1, "required": true, "input": null }
      ],
      "evidencePolicy": { "mode": "none", "requirements": [] }
    },
    "resumeAcrossAttempts": true
  }
}
```

A `task-set` executor declares a fixed list of tasks in `work`, each with its own
key, generation, role, budgets, optional `dependsOn`, optional input schema and
input value, and completion policy.

A `task-frontier` executor declares no tasks at all. It names a loop and a task
template, and its tasks are projected at run time:

```json
{
  "executor": { "kind": "task-frontier", "forEach": "plan-tasks", "template": "implementation" }
}
```

### Phase outputs

Outputs are declared slots, each with a schema, a stored path, a byte ceiling,
and a sensitivity classification:

```json
{
  "outputs": [
    {
      "key": "definition",
      "schema": "definition-output",
      "path": "outputs/definition.json",
      "maxBytes": 65536,
      "sensitivity": "internal"
    }
  ]
}
```

`sensitivity` is `public`, `internal`, `confidential`, or `restricted`. An agent
submits an output through the broker, which validates it against the declared
schema and refuses anything oversized, malformed, or conflicting with an already
accepted slot. Only accepted outputs become readable by downstream mappings.

The alpha exposes the first declared output slot per dispatch; see
[PE-002](../design/WIP/redesign-1/production-enhancements.md) for the deferred multi-slot case.

### Iteration and rework

`iteration` decides what happens when a phase does not exit cleanly:

```json
{
  "iteration": {
    "maximumAttempts": 2,
    "onGateRejected": "iterate",
    "onApprovalRejected": "iterate",
    "onUpstreamChanged": "iterate",
    "onExhausted": "escalate"
  }
}
```

* `onGateRejected` and `onApprovalRejected` are `iterate` or `fail`.
* `onUpstreamChanged` is optional and controls rework when an upstream phase
  produces a new accepted output.
* `onExhausted` is `escalate` or `fail` and applies once `maximumAttempts` is
  spent.

Each new attempt is a new immutable attempt record. Nothing rewrites the previous
attempt's evidence.

### Exit, gates, and approvals

`exit` states what a phase must produce and who may close it:

```json
{
  "exit": {
    "requiredOutputs": ["definition"],
    "gate": "define-valid",
    "approval": { "policy": "required", "authority": { "role": "release-manager" } }
  }
}
```

`approval.policy` is `none` or `required`. A required approval names the exact
authority that may decide. Approvals are recorded as immutable human decisions;
an agent can never satisfy one.

### Phase actions

The only phase action is `import-plan`, which admits a reviewed plan into the
task frontier:

```json
{ "actions": [{ "kind": "import-plan", "forEach": "plan-tasks" }] }
```

## Sensors

A sensor is a bounded local process whose exact output feeds gate evaluation:

```json
{
  "sensors": [
    {
      "key": "diff-check",
      "argv": ["git", "diff", "--check"],
      "cwd": ".",
      "timeoutMs": 30000,
      "maxStdoutBytes": 65536,
      "maxStderrBytes": 65536,
      "inheritedEnvironment": ["PATH"],
      "maxAttempts": 3,
      "maxReconciliationAttempts": 2
    }
  ]
}
```

Sensors carry no implicit environment. `inheritedEnvironment` is an explicit
allowlist of at most 128 names totalling at most 64 KiB with their values.
`argv` admits at most 256 arguments and 64 KiB of aggregate argument bytes. A
process stream is capped at 64 MiB, retries share a 1 GiB aggregate output
budget, and active process and workspace capacity cannot exceed 32.

Sensors never run during `senawa doctor`.

## Gates

A gate binds a phase to blocking and advisory rules over sensor readings:

```json
{
  "gates": [
    {
      "key": "define-valid",
      "phase": "define",
      "blocking": [
        {
          "key": "clean-diff",
          "condition": {
            "operator": "equals",
            "accessor": { "sensorKey": "diff-check", "pointer": "/exitCode" },
            "expected": 0
          }
        }
      ],
      "advisory": []
    }
  ]
}
```

Operators are `all`, `any`, `not`, `exists`, `equals`, `not-equals`,
`greater-than`, `greater-than-or-equal`, `less-than`, and
`less-than-or-equal`. An accessor names a declared sensor key and a JSON Pointer
into its reading. A blocking rule that fails or cannot be evaluated rejects the
gate. Advisory rules record their result without blocking.

## Budgets

Every autonomous loop carries a finite budget. The budget units are
`work-attempt`, `dispatch-failure`, `sensor-retry`, `review-iteration`,
`integration-attempt`, `rebase-attempt`, `elapsed-time-ms`, and `spend-nano`.
The standard tree uses the first six:

```json
{
  "budgets": [
    { "unit": "work-attempt", "limit": 3 },
    { "unit": "dispatch-failure", "limit": 2 }
  ]
}
```

Exhausting a budget escalates to a human decision instead of looping. A human can
grant a bounded allowance increase from the portal, within the policy ceiling.

## Task loops and projected work

A `forEach` declaration selects a bounded collection out of an upstream value and
describes how items become tasks:

```json
{
  "forEach": [
    {
      "key": "plan-tasks",
      "source": { "kind": "phase-output", "phase": "plan", "output": "plan" },
      "pointer": "/tasks",
      "collectionSchema": "plan-task-collection",
      "itemSchema": "plan-task-item",
      "identityPointer": "/id",
      "limits": {
        "maxSelectedItems": 64,
        "maxTotalTasks": 256,
        "maxConcurrency": 1,
        "exhaustion": "escalate"
      }
    }
  ]
}
```

* `source` is a `phase-output` or a `phase-input`.
* `collectionSchema` validates the selected collection and `itemSchema`
  validates every item, so a malformed plan can never project a task.
* `identityPointer` gives each item a stable identity, which makes fan-out
  idempotent across retries.
* `limits` bound selected items, total tasks, and concurrency. `exhaustion` is
  `escalate` or `fail`.

A task template describes the task each selected item becomes:

```json
{
  "taskTemplates": [
    {
      "key": "implementation",
      "generation": 1,
      "role": "implementor",
      "budgets": [{ "unit": "work-attempt", "limit": 3 }],
      "inputSchema": "implementation-task-input",
      "inputMappings": [
        {
          "key": "plan-item",
          "source": { "kind": "current-item", "pointer": "" },
          "destinationPointer": ""
        }
      ],
      "dependencyIdentityPointer": "/dependsOn",
      "repositoryChanges": "required",
      "completionPolicy": {
        "criteria": [
          { "key": "implemented", "generation": 1, "required": true, "input": null }
        ],
        "evidencePolicy": {
          "mode": "task",
          "requirements": [{ "kind": "task-completion", "minimumCount": 1 }]
        }
      }
    }
  ]
}
```

`dependencyIdentityPointer` reads item dependencies by the same identity the loop
selected, so projected tasks inherit the plan's ordering.
`repositoryChanges` is `required`, `allowed`, or `forbidden`.

Projected work exists only at run time. The compiled snapshot of a
`task-frontier` phase contains no task nodes, and a top-level `projectedWork`
field in the document is refused with `unknown-field`. Tasks appear after an
`import-plan` action admits a reviewed plan.

## Plan import

Plan import is a reviewed, bounded transition rather than an automatic
expansion. The `plan` phase publishes a schema-validated plan output, its gate
and approval run, and the declared `import-plan` action then evaluates the loop.
The projected task set is recorded as an exact diff so a human decision applies
to exactly the reviewed set. Re-evaluating the same plan produces the same task
identities and adds nothing.

## Implementation evidence views

An evidence view exposes a bounded, classified slice of a phase's evidence to a
downstream mapping:

```json
{
  "implementationEvidenceViews": [
    {
      "key": "accepted-implementation",
      "phase": "implement",
      "evidenceKinds": ["task-completion"],
      "sensitivityCeiling": "internal"
    }
  ]
}
```

The `verify` phase of the standard tree maps this view into
`/implementationEvidence` so verification reads accepted evidence rather than
model prose.

## Completion policy and evidence

Every executor and task template carries a completion policy:

* `criteria` are keyed, generation-stamped statements. `required` criteria must
  be satisfied for completion.
* `evidencePolicy.mode` is `none`, `task`, `required-criteria`, or
  `all-satisfied`.
* `requirements` state a minimum count per evidence kind.
* `waiverAuthority` names who may waive, when a waiver is permitted at all.

Completion accounting is derived from immutable records. An agent asserting that
it finished does not close anything by itself.

## Amendments

A separate `senawa.dev/workflow-amendment/v1alpha1` document proposes additive
changes to a running graph. It carries the base snapshot and context digests and
a list of `add-phase` or `add-task` operations. Amendments cannot remove or
rewrite existing nodes. Review them with `senawa amendment list`, `get`,
`source`, and `status`, and decide with `approve`, `reject`, or `withdraw`. See
[Workflow model](../design/workflow-model.md) for the supersession rules.

## Authoring checklist

* Run `senawa doctor` after every edit and fix all diagnostics, not the first.
* Keep prompt `inputPaths` and template tokens in exact agreement.
* Give every schema a unique `$id` and no network references.
* Bound every loop with `limits` and every executor with budgets.
* Choose `sensitivity` deliberately; it drives what can leave the host.
* Leave `execution.workspaceMode` at `repository` unless you have read
  [Worktree mode](worktree-mode.md).
