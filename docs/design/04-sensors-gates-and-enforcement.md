# Sensors, Gates, and Enforcement

## Purpose

A sensor perceives. A gate decides. Backpressure is the refusal a worker receives
when measured work does not satisfy the gate.

Keeping those responsibilities separate lets Senawa add new ways to measure work
without changing its decision engine, and change policy without rewriting sensor
implementations.

## Sensor extension contract

A sensor extension is a versioned implementation type. A sensor entry in
`.senawa/sensors.yaml` is one configured instance.

```ts
interface ISensor<TInput, TOutput extends SensorAssessment> {
  readonly manifest: SensorManifest;
  run(input: TInput, context: SensorContext): Promise<TOutput>;
}

interface SensorExtension<TConfig, TInput, TOutput extends SensorAssessment> {
  readonly manifest: SensorManifest;
  create(config: TConfig): ISensor<TInput, TOutput>;
}

interface SensorManifest {
  apiVersion: "senawa.dev/sensor/v1";
  name: string;
  version: string;
  description: string;
  configSchema: JsonSchema;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}
```

Every output extends a common envelope:

```ts
interface SensorAssessment {
  verdict: "pass" | "fail";
  summary: string;
  findings: SensorFinding[];
  data?: unknown;
}
```

Senawa validates four boundaries:

1. Manifest during extension loading
2. Configuration during `senawa doctor`
3. Input immediately before execution
4. Output before caching, journalling, or gate evaluation

An execution error is not a failing assessment. Required sensor errors block
progress while remaining distinguishable from valid negative evidence.

The production vertical slice implements this boundary in `@senawa/sensors`.
It supports the explicitly declared `@senawa/sensor-artifact` and
`@senawa/sensor-command` built-ins. Artifact checks inspect the candidate phase
artifact. Command checks use snapshotted configuration, run in the repository
root with a bounded timeout, and receive the run ID, owner ID, and attempt in
their environment. Arbitrary extension loading, inferential sensors, and reading
caching remain pending.

## Explicit discovery

Extensions are declared. Senawa does not scan installed packages, because
presence in `node_modules` must not execute code or alter the resolved sensor set.

```yaml
version: 1
extensions:
  - package: "@senawa/sensor-command"
  - package: "@senawa/sensor-agent-review"
  - path: "./.senawa/extensions/api-contract/index.mjs"
```

The extension owns `config` and validates it with its schema. Senawa owns fields
that affect orchestration:

| Field | Owner | Reason |
|-------|-------|--------|
| `config` | Extension | Implementation-specific behavior |
| `cost` | Senawa | Orders cheap readings before expensive ones |
| `trust` | Senawa | Controls whether a reading may block |
| `stability` | Senawa | Records evidence supporting promotion |
| `scope` | Senawa | Determines relevant files and cache identity |

An extension cannot promote itself by placing `trust` inside its private config.

## Sensor configuration

```yaml
sensors:
  - id: typecheck
    extension: "@senawa/sensor-command"
    description: Type-check the project
    cost: cheap
    config:
      command: "npx tsc --noEmit --pretty false"
      parser: tsc-text

  - id: architecture-review
    extension: "@senawa/sensor-agent-review"
    description: Check structural architecture rules
    cost: expensive
    trust: advisory
    stability:
      samples: 5
      agreement: 1.0
      measured_on: structural-violations
    config:
      agent: architecture-reviewer
      rubric: .agents/rubrics/architecture.md
      model: claude-sonnet-5
```

Inferential extensions may launch reviewer sessions, but they do not own session
isolation, permissions, budgets, or journalling. Those capabilities arrive
through `SensorContext`.

An inferential reviewer receives one `submit_sensor_result` tool backed by the
output schema. Ordinary assistant prose is ignored. Failure to submit valid tool
arguments within the retry limit produces a sensor error.

## Gate contract

A gate is a collection of checks over sensor assessments:

```yaml
gates:
  - id: task-done
    description: Implementation satisfies its acceptance contract
    checks:
      - sensor: typecheck
        expect:
          path: /verdict
          operator: equals
          value: pass
      - sensor: unit-tests
        expect:
          path: /verdict
          operator: equals
          value: pass
      - sensor: coverage
        expect:
          path: /data/regression
          operator: equals
          value: false
      - sensor: architecture-review
        expect:
          path: /verdict
          operator: equals
          value: pass
        advisory: true
    on_fail: rework
    max_rework: 3
    escalate_on_exhaustion: true
```

JSON Pointer lets a gate inspect extension-specific `data` without embedding
JavaScript. The first operator vocabulary is closed:

* `equals`
* `notEquals`
* `greaterThan`
* `greaterThanOrEqual`
* `contains`
* `matches`
* `exists`

`senawa doctor` rejects unknown operators, missing sensors, impossible
pointer-schema combinations, and blocking gates with no deterministic anchor.

## Completion backpressure

The typed worker completion operation is a request. It never closes a bead first
and validates later. A public `task done` CLI command remains deferred until it
can authenticate and bind the requesting worker turn.

A refusal returns the gate, attempt count, remaining allowance, failed readings,
sanitized findings, and a rework prompt. The driver resumes the same worker
session with that evidence. Accepted readings close the task through Senawa.

The driver also evaluates the gate after a worker turn. Correctness does not
depend on the worker remembering to call the completion tool.

Worker hosts return only a session ID, an optional artifact, and output records.
They cannot return a gate verdict. `RunCommandService` invokes the injected
`GateEvaluator` after every phase or task turn, journals sensor and gate evidence,
and uses only that evaluation to accept, close, rework, or pause work.

## Trusted task-change evidence

Every imported task carries a `repositoryChange` expectation. The standard task
frontier permits only `required`, so a model-authored plan cannot weaken the
contract. Senawa captures a path-limited baseline before worker execution and a
post-turn delta before gate evaluation. The delta separates pre-existing,
in-scope, out-of-scope, frozen, and uncertain changes and binds the measurement
to run, task, attempt, dispatch, and turn identifiers.

The worker's reported patch is advisory. The deterministic `task-change` sensor
uses the trusted delta and reports disagreement. A required no-op, an
out-of-scope change, a frozen-path change, or unresolved recovery attribution
blocks before typecheck and tests can make the task look successful. These
refusal paths are [confirmed offline](wip/probe-findings.md#live-default-and-evidence-contracts).

The `work-done` gate is schema-aware. It requires the current verification
artifact to declare `verdict: pass` and requires resolvable current evidence; a
schema-valid failing verdict cannot finish work. Simulated verification remains
simulated evidence and cannot establish live implementation quality.

## Evaluation order

Sensors run in this order:

1. Cheap deterministic readings
2. More expensive deterministic readings
3. Inferential readings, only when deterministic checks are green

A failure short-circuits later blocking work. Advisory findings do not block, but
they still reach the worker and report.

The measured cost difference supports this ordering: the deterministic probe set
completed in milliseconds, while one inferential run took tens of seconds. See
the [probe findings](wip/probe-findings.md#the-sensor-model).

## Counter-metrics

Counter-metrics use ordinary checks over extension data:

```yaml
- sensor: coverage
  expect:
    path: /data/regression
    operator: equals
    value: false
```

The sensor owns the baseline and reports whether the count moved in the wrong
direction. The gate reads the answer. This avoids a special
`must_not_regress` language and works on codebases that are not already clean.

## Reading cache

A reading is keyed by:

```text
(sensor id, relevant tree hash, sensor definition hash)
```

Unrelated edits can reuse a green reading. Changing relevant files or the sensor
definition invalidates it. Cache entries live in the work directory; beads stores
only the digest needed for a cheap freshness query.

## Evidence hygiene

Sensor output is untrusted input entering a model context and possibly a report.
The runner:

* Parses output into structured findings.
* Strips control characters.
* Neutralizes instruction-like tags.
* Caps evidence size.
* Orders truncation deterministically by severity.
* Writes full output to disk and returns a path when it exceeds the cap.

A hostile-output fixture remains a regression test. Evidence handling is a trust
boundary, not presentation polish.

## Two kinds of gate

| Gate | Represents | Storage |
|------|------------|---------|
| Senawa gate | A decision over sensor readings | `.senawa/sensors.yaml` and cached readings |
| Beads gate | An external condition such as human approval, CI, or a timer | Runtime graph |

A phase with both a quality gate and `approval: human` waits for both. The quality
result can be recomputed; the human decision is a durable graph event.

## Frozen definitions

Workers cannot edit the references used to judge them:

```yaml
frozen:
  - .senawa/sensors.yaml
  - .senawa/agents/**
  - .senawa/workflows/**
  - .senawa/schemas/**
  - .agents/rubrics/**
  - test/**
  - tests/**
```

The run snapshot prevents the current run from following configuration edits.
The frozen set prevents a worker from weakening the next run.
Repository-owned worker profiles are part of the mandatory frozen-definition
floor. Repository policy may add paths but cannot remove profiles, workflows,
schemas, or `.senawa/sensors.yaml` from that floor. Hook and permission policy remains an
embedded Senawa runtime asset. Worker sessions do not depend on
`.github/agents` or `.github/hooks`.

## Enforcement layers

| Mechanism | Strength | Failure mode |
|-----------|----------|--------------|
| Capability absent from environment | Absolute for that capability | No executable or tool exists to invoke |
| Explicit available tool set | Strong | Tool is never offered to the model |
| SDK permission callback | Strong | In-process decision with actionable feedback |
| Command hook | Moderate | Fails open on timeout |
| Deny pattern | Weak | Shell indirection can bypass stem matching |

Hooks return an empty response or a denial. They never return `allow`, because an
allow result bypasses the stronger permission handler.

Command hooks must stay fast. A timed-out policy hook is silently ignored, so
expensive checks belong behind explicit completion requests rather than in the
per-tool hot path.

## Sensor trust

Inferential trust is measured against a class of input, not granted globally to
a sensor. Repeated runs on unchanged input compare verdict and cited rules.
Promotion to blocking requires reproducible agreement for the declared scope.
Aesthetic or subjective checks remain advisory even if the same reviewer is
stable on structural violations.

`senawa sensor audit` reruns those measurements on a cadence and reports drift.
The audit reads recorded evidence rather than asking an agent whether the sensor
is reliable. The current offline implementation groups recorded outcomes,
computes agreement and verdict transitions, and reports p95 execution latency.
Hook latency is exposed as `unreported` until the hook emits durable timing
samples; no value is inferred from an unrelated process clock.

Individual `sensor run` remains omitted. A configured sensor instance does not
carry a standalone gate expectation, so running it outside a named gate would
produce an assessment without an authoritative interpretation.

## Next reading

Continue with [Runtime and State](05-runtime-and-state.md) for the driver, beads
adapter, reconciliation, and concurrency internals.
