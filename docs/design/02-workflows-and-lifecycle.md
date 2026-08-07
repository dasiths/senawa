# Workflows and Lifecycle

## Purpose

A workflow is the static contract that Senawa compiles into a live beads graph.
It defines phases, dependencies, roles, artifacts, gates, approval points, and
finite loop policies. The workflow never becomes a second mutable source of
runtime state.

## Repository configuration

Consumer repositories own the definitions that describe their work under one
namespace:

```text
.senawa/sensors.yaml
.senawa/agents/<role>.senawa.md
.senawa/workflows/<workflow>.yaml
.senawa/schemas/<artifact>.schema.json
```

`.senawa/sensors.yaml` declares sensor instances, gates, and the frozen set.
Workflows select roles and reference schemas relative to their own file.
Repositories may also keep explicitly declared local sensor implementations
under `.senawa/extensions/`; their paths are entries in the policy, not an
additional discovery mechanism.

The user-facing skill remains at `.agents/skills/senawa/SKILL.md` because
Copilot discovers skills there. That exception is an interaction asset, not a
worker profile or a source of runtime authority. Senawa owns definition schemas,
loading, validation, snapshots, capability ceilings, hooks, gates, and audit.

## Workflow contract

```yaml
apiVersion: senawa.dev/workflow/v1
kind: Workflow
metadata:
  name: standard-delivery
spec:
  inputSchema: ../schemas/work-request.schema.json
  completesWhen: verify-accepted
  phases:
    - id: define
      executor:
        kind: agent
        role: definer
        resumeAcrossIterations: true
        output:
          path: artifacts/definition.json
          schema: ../schemas/definition.schema.json
      exit:
        gate: definition-accepted
        approval: human
      iteration:
        max: 5
        onUpstreamChange: flag

    - id: research
      dependsOn: [define]
      executor:
        kind: agent
        role: researcher
        resumeAcrossIterations: true
        input:
          definition: phases.define.output
        output:
          path: artifacts/research.json
          schema: ../schemas/research.schema.json
      exit:
        gate: research-accepted
        approval: human
      iteration:
        max: 5
        onUpstreamChange: flag

    - id: plan
      dependsOn: [research]
      executor:
        kind: agent
        role: planner
        resumeAcrossIterations: true
        input:
          definition: phases.define.output
          research: phases.research.output
        output:
          path: artifacts/plan.json
          schema: ../schemas/plan.schema.json
      actions:
        - kind: import-plan
          source: phases.plan.output
      exit:
        gate: plan-accepted
        approval: human
      iteration:
        max: 5
        onUpstreamChange: flag

    - id: implement
      dependsOn: [plan]
      executor:
        kind: task-frontier
        role: implementor
        selector:
          phase: implement
        repositoryChanges: [required]
        concurrency: 1
        reentrant: true
      loop:
        until: all-selected-tasks-closed
        each:
          gate: task-done
          rework:
            resumeSession: true
            maxAttempts: 3
          dispatch:
            maxFailures: 2
          onExhausted: escalate
      iteration:
        max: 10
        onUpstreamChange: independent

    - id: verify
      dependsOn: [implement]
      executor:
        kind: agent
        role: verifier
        resumeAcrossIterations: true
        input:
          definition: phases.define.output
          research: phases.research.output
          plan: phases.plan.output
          implementation: evidence.implementation
        output:
          path: artifacts/verification.json
          schema: ../schemas/verification.schema.json
      exit:
        gate: work-done
        approval: human
      iteration:
        max: 10
        onUpstreamChange: independent
```

The first version uses a closed executor vocabulary:

| Executor | Behavior |
|----------|----------|
| `agent` | Produces one schema-constrained phase artifact |
| `task-frontier` | Claims and completes dependency-aware implementation tasks |
| `sensor-only` | Evaluates a gate without an agent artifact |
| `human` | Waits for an explicit human decision |
| `foreach` | Applies a bounded operation to a schema-valid collection |

There is no general expression language and no arbitrary `while`. Every loop
names its termination condition and finite limits.

## Starting a run

```bash
senawa work start "Refactor the ingest pipeline" \
  --workflow standard-delivery \
  --input request.json
```

From the caller's perspective, startup is one transaction:

1. Resolve the named workflow or repository default.
2. Validate extensions, sensors, gates, roles, schemas, references, dependencies,
   selectors, and finite limits.
3. Merge the goal and optional input, then validate the workflow input contract.
4. Snapshot the resolved definitions and record one content fingerprint.
5. Create the epic and static phase nodes with dependency edges.
6. Record `work.started` and `workflow.instantiated`.
7. Acquire the driver lease and begin advancing the graph.

An active run reads its snapshot. Later source edits are drift, not silent changes
to the current rules.

## Phase lifecycle

A phase can be entered more than once:

```text
pending -> running -> awaiting_approval -> accepted
                             |
                             +-> rejected -> running (iteration n+1)
```

`senawa reject <phase> --reason "..."` starts the next iteration. The reason is
both journalled and passed into the resumed phase session. Rejection is a normal
refinement mechanism, not an error path.

### Versioned artifacts

Artifacts are validated before persistence and never overwritten:

```text
artifacts/
  plan/
    v1.json
    v2.json
    current -> v2.json
```

Each phase iteration records the exact upstream versions it consumed. Session
memory provides continuity, but the artifact remains the source of truth.

`dependsOn` controls readiness. `executor.input` controls dataflow through the
closed `phases.<phase>.output` and `evidence.implementation` reference grammar.
Before dispatch, Senawa resolves each input to one manifest entry containing the
logical name, owner, path, version, digest, schema kind, bounded summary, and
content. The same manifest drives the prompt, dispatch recovery, artifact
`consumed` provenance, verification context, and report. An accepted artifact
never claims an available but undeclared input.

### Upstream changes

| Policy | Behavior | Typical use |
|--------|----------|-------------|
| `cascade` | Reopen downstream phases automatically | A changed premise invalidates all later work |
| `flag` | Keep downstream phases closed but mark them stale | Human review should decide whether rerun is needed |
| `independent` | Do not infer invalidation | Additive implementation and verification |

### Additive planning

`senawa plan revise --add <file>` appends new tasks without reopening completed
ones. Stable task keys make revision idempotent. The implementation phase becomes
ready again when its selector finds open work, and structural plan validation runs
against the enlarged graph.

Task retraction is intentionally separate. The public `task abort` command
remains deferred until worker cancellation and active-dispatch reconciliation
can preserve why the task was removed without racing the driver.

## Artifact contracts

Agent phase output uses the same structured submission rule as inferential sensor
output. The phase receives one submission tool backed by its JSON Schema. Senawa
persists only schema-valid arguments.

Artifacts consumed by Senawa itself have Senawa-owned schemas. The plan importer,
for example, expects stable task identity and enough information to enforce
scope:

```json
{
  "tasks": [
    {
      "key": "split-parse-batch",
      "title": "Split parse_batch into stages",
      "dependsOn": ["extract-reader"],
      "paths": ["src/ingest/parse.py"],
      "repositoryChange": "required",
      "acceptance": ["parse_batch delegates to named stage functions"],
      "role": "implementor",
      "execution": {
        "model": "claude-sonnet-5",
        "effort": "high",
        "effortMode": "preferred",
        "group": "ingest-adapters"
      }
    }
  ]
}
```

| Field | Runtime use |
|-------|-------------|
| `key` | Stable identity across plan revisions |
| `dependsOn` | Beads dependency edges |
| `paths` | Enforced write scope |
| `repositoryChange` | Required, optional, or forbidden trusted repository-delta policy |
| `acceptance` | Task brief and completion contract |
| `role` | Worker profile selection |
| `execution` | Portable dispatch hints |

A repository may extend a Senawa-owned schema with `allOf`; it may not redefine
the shape consumed by the importer.

## Phase briefs

`senawa phase brief <phase>` composes two parts:

| Part | Contents | Lifetime |
|------|----------|----------|
| `guidelines` | Harness framing, rules, and output contract | Stable across iterations |
| `turn` | Request, input paths, current versions, and rejection context | Specific to one iteration |

Under the SDK topology, guidelines extend the system message and the turn becomes
the user prompt. Under the subprocess topology, both are concatenated on the
first turn and only the turn is sent on resume.

## Worker profiles

Repositories define every workflow and task role in
`.senawa/agents/<role>.senawa.md`. The file combines strict YAML frontmatter
with a non-empty Markdown prompt:

```markdown
---
apiVersion: senawa.dev/worker-profile/v1
kind: WorkerProfile
metadata:
  name: implementor
spec:
  model:
    id: claude-sonnet-5
    effort: high
    effortMode: preferred
  tools:
    - repository.read
    - repository.edit
    - process.run
    - senawa.task.done
    - senawa.ask
    - senawa.discover
---

# Implementor

Implement only the claimed task and stay within its declared paths.
```

The filename stem must equal `metadata.name`. Unknown frontmatter fields and
capabilities are invalid. Version 1 recognizes `repository.read`,
`repository.edit`, `process.run`, `senawa.task.done`, `senawa.phase.submit`,
`senawa.ask`, and `senawa.discover`. Model effort, when present, is `low`,
`medium`, `high`, or `xhigh`. `effortMode` is `required` or `preferred`.
Unsupported required effort stops preflight; unsupported preferred effort may
resolve to the catalog default and remains visible as requested versus resolved
metadata.

Startup validates every static workflow role. Plan import validates each dynamic
task role before creating tasks. Missing roles fail closed. Task execution model
and effort hints override profile defaults for that dispatch, but cannot alter
capabilities.

The repository currently requests Sonnet 5 and Opus 5 role IDs. These are
configuration requests, not evidence of invocation. New work must confirm each
exact ID and effort through the authenticated SDK catalog before the run is
created. A connected `doctor --live` diagnostic resolved the configured IDs on
2026-08-07 without invoking a model; invocation and role quality remain
unvalidated until an explicitly approved paid workflow probe.

Snapshot version 2 stores the parsed profile and exact source file. Its source
digest contributes to the repository fingerprint, and each turn receives the
snapshotted profile and digest. A resumed run never rereads the live profile,
and Senawa never rewrites an earlier snapshot version in place.

Profiles request capabilities; they do not grant authority. The host intersects
each request with owner scope, supported host operations, and Senawa's mandatory
security ceiling before mapping it to provider-specific controls.

## Approval semantics

A phase may declare one of two approval channels:

| Value | Meaning |
|-------|---------|
| `human` | Direct approval or an explicit decision relayed by the principal agent |
| `human-direct` | Input must come from the driver's own terminal |

A sensor gate and a human approval are separate conditions. The sensor gate can
be recomputed from readings. Approval is a durable event represented by a beads
human gate. A crash between those conditions does not lose either result.

The approval object is one immutable artifact identified by path, version, and
digest. `senawa phase brief` returns that identity, an attributed bounded
overview, deterministic structural counts, and the complete-artifact command.
Approve and reject accept expected version and digest guards and refuse a stale
decision. The [offline evidence](wip/probe-findings.md#live-default-and-evidence-contracts)
covers exact input manifests, task provenance, and artifact-bound decisions.

## Exit and resume

| Exit | Meaning | Resume |
|------|---------|--------|
| `0` | Completion condition accepted | Not needed |
| `2` | Human decision or exhausted budget | Yes |
| `130` | Operator interruption | Yes |
| `1` | Unexpected error | Yes, after correction |

`senawa work resume` is the only recovery command. It clears a deliberate pause
when present, reconciles incomplete intent records, and resumes driving. The
caller does not need to know why the process stopped.

## Ending a run

`senawa work end --reason "..."` deliberately abandons an unfinished run. It is
not an error reset and does not erase evidence.

The operation stops dispatch, lets or aborts the current worker according to the
normal shutdown grace period, resolves open human gates, marks unfinished phases
and tasks terminal, writes `work.ended`, updates the status projection, and
releases the repository active-run pointer last. The next run archives the ended
work directory before creating its own.

The terminal states have distinct meanings:

| State | Meaning | May resume |
|-------|---------|------------|
| `paused` | Deliberately stopped before completion | Yes |
| `ended` | Deliberately abandoned with a recorded reason | No |
| `finished` | Workflow completion condition accepted | Not needed |

`work end --force` is an emergency takeover for a driver that does not stop
within the grace period or whose lease is stale. It must still write terminal
state and preserve the work directory before releasing the singleton. It never
means deleting a lock file without reconciling the run.

## Next reading

Continue with [Agents and Interaction](03-agents-and-interaction.md) for the
principal agent, workers, session isolation, and command authority.
