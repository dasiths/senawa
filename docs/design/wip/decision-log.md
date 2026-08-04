# Design Decision Log

This is the working entry point for new design ideas. Entries are
non-authoritative until accepted and promoted into a numbered design guide.

Keep entries short. Put executable evidence in `poc/`, measurements in
[poc-findings.md](poc-findings.md), and durable rejected rationale in
[roads-not-taken.md](roads-not-taken.md).

## Status lifecycle

```text
proposed -> probing -> accepted
                    -> rejected
                    -> superseded
```

| Status | Meaning |
|--------|---------|
| `proposed` | The question and required evidence are defined |
| `probing` | A POC is gathering evidence |
| `accepted` | Evidence supports the decision and the owning guide is updated |
| `rejected` | Evidence or constraints ruled it out; rationale is in Roads Not Taken |
| `superseded` | A later decision replaced it |

## Entry template

Copy this section for each idea and update it in place as the idea matures.

```markdown
### YYYY-MM-DD: Decision title

* Status: `proposed`
* Owner: `docs/design/NN-guide.md`
* Question: One decision the evidence can answer
* Context: Why the decision matters now
* Options: The credible alternatives
* Evidence needed: What would distinguish the options
* POC: `poc/<subject>/README.md`, or `not started`
* Outcome: `pending`
* Promotion: Link to the accepted guide section or Roads Not Taken entry
```

## Decisions

### 2026-08-04: Worker autopilot completion

* Status: `proposed`
* Owner: `docs/design/03-agents-and-interaction.md`
* Question: Can worker autopilot trigger the gate without treating
    `task_complete` as proof of completion?
* Evidence needed: A live worker run where the harness remains authoritative
    across success, refusal, and exhausted continuation paths
* POC: `poc/orchestration/README.md`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Verification representation

* Status: `proposed`
* Owner: `docs/design/02-workflows-and-lifecycle.md`
* Question: Should verification be a sensor, a phase node, or both?
* Evidence needed: Compare graph clarity, iteration behavior, report provenance,
    and cost for each representation
* POC: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Non-additive plan revision

* Status: `proposed`
* Owner: `docs/design/02-workflows-and-lifecycle.md`
* Question: Should plan revision retract work as well as append it?
* Evidence needed: A case where task abort plus additive revision cannot express
    the intended correction cleanly
* POC: `poc/orchestration/README.md`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Run-wide spend limits

* Status: `proposed`
* Owner: `docs/design/07-implementation-and-operations.md`
* Question: Should a run-wide AIU ceiling supplement task and phase limits?
* Evidence needed: Cost traces from representative runs showing whether local
    limits bound total spend predictably
* POC: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Tracking directory retention

* Status: `proposed`
* Owner: `docs/design/06-provenance-and-observability.md`
* Question: Should the tracking directory be committed to the main branch or an
    archive branch?
* Evidence needed: Review one real run through both storage models and compare
    discoverability, repository noise, and retention
* POC: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Journal segmentation

* Status: `proposed`
* Owner: `docs/design/06-provenance-and-observability.md`
* Question: Do long runs require segmented journals while preserving append-only
    order?
* Evidence needed: Journal size, render latency, and recovery behavior from a
    multi-day or high-event run
* POC: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Human review cadence

* Status: `proposed`
* Owner: `docs/design/01-system-model.md`
* Question: Which checkpoint cadence prevents comprehension debt on large task
    frontiers?
* Evidence needed: Human review experience at task-count, merge-slot, and spend
    thresholds on a representative run
* POC: `not started`
* Outcome: `pending`
* Promotion: `pending`

### 2026-08-04: Counter-metric selection

* Status: `proposed`
* Owner: `docs/design/04-sensors-gates-and-enforcement.md`
* Question: Which counter-metrics remain cheap, stable, and independent of their
    primary gates?
* Evidence needed: Repeated cost, stability, and correlation measurements for
    coverage, public API surface, and candidate structural counts
* POC: `poc/sensors/README.md`
* Outcome: `pending`
* Promotion: `pending`
