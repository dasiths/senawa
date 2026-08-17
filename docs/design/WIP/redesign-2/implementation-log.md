---
title: Senawa v1 implementation log
description: Narrative record of decisions, deviations, and validation across the v1 redesign
ms.date: 2026-08-16
ms.topic: concept-article
---

This is the narrative of the v1 redesign. It records what was decided, what was
deviated from, and what was learned, so the reasoning survives past the diff.
[The plan](plan.md) carries the checklist; this carries the story.

Entries are appended in order. Decisions are numbered `D-nnn` and referenced from
commit messages where they explain a choice.

## Status

| Phase | Title | State | Commit |
|---|---|---|---|
| 0 | Settle the shape | Complete | |
| 1 | An authored workflow becomes a run | In progress | |
| 2 | One phase runs a real agent end to end | Not started | |
| 3 | The consumer command line | Not started | |
| 4 | Sensors, gates, and anchors | Not started | |
| 5 | Human decisions and escalation | Not started | |
| 6 | Fan-out and fan-in | Not started | |
| 7 | Sessions and steering | Not started | |
| 8 | The portal earns its density | Not started | |
| 9 | Remove what the evidence condemns | Not started | |
| 10 | Name it v1 and document it | Not started | |
| 11 | Restore the loop engineering narrative | Not started | |

## Phase 0 log

### Decision D-001: Fan-out members become phases, and grouping needs no new concept

* Date: 2026-08-16
* Status: Accepted
* Decision: A fanned-out member is a phase parented to the fan-out phase, rather
  than a task. Grouping in the portal comes from the existing container layout.
* Alternatives: Keep members as tasks and add nesting, per-member gates,
  per-member approval, and per-member override as new task-level concepts.
* Rationale: All four capabilities already exist at phase level. A spike compiled
  five phases with three members parented to `implement` and rendered them
  through the portal's real layout: the parent was marked a container, its
  members drew inside it in dependency order, and the top-level sequence stayed
  `plan`, `implement`, `verify`. Nine nodes and twelve edges compiled with no
  kernel change, because `ContainsEdge` already admits a phase inside a phase and
  `PhaseDefinitionInput.parentId` already accepts a phase.
* Consequence: `containerAssignment` resolves to the outermost phase ancestor and
  the layout builds one member level, so depth 1 groups correctly and deeper
  structure flattens into the top group rather than failing. That matches the
  agreed bound of one level and makes deeper nesting a contained layout change
  rather than a graph model change.

### Decision D-002: Tasks survive beneath phases

* Date: 2026-08-16
* Status: Accepted
* Decision: A fan-out member is a phase that contains one reserved unit of
  executable work. The task layer is not removed.
* Alternatives: Remove tasks entirely and let phases carry criteria directly;
  or keep fan-out members as tasks and add nesting at task level.
* Rationale: The compiler already does this. A phase declaring an `agent`
  executor synthesises exactly one task keyed `phase-executor`, parented to the
  phase and carrying the phase's completion policy and criteria, with its source
  pointer rewritten so diagnostics still point at the authored line. An agent
  phase is therefore already a phase containing one task, and the author never
  writes it. Removing tasks would instead mean breaking `isTaskId` at three
  independent enforcement points and adding a `PhaseId -> CriterionId` edge the
  model does not have.
* Consequence: The `continue` failure policy falls out for free. Candidate
  formation selects a phase's tasks by direct parentage, so a member phase's task
  is invisible to the parent's candidate set and a failed member cannot block it.
  The runner needs no change at all: budgets are keyed by unit, capacity by
  resource, and claims by operation, none of them by task.
* Risk accepted: amendment quiescence computes affected task scopes with a
  single-level parent filter, so introducing a nesting level silently narrows the
  sweep. A member could then claim against a superseded definition, which is
  exactly what fencing exists to prevent. Phase 6 must make that descent
  transitive and cover it with a test. Recorded here so it is not discovered
  later.

### Decision D-003: Submission identity is a content digest senawa computes

* Date: 2026-08-16
* Status: Accepted
* Decision: `submissionId` becomes `submission_` followed by the SHA-256 of the
  canonical submission with its own identifier removed. Senawa computes it during
  admission. The agent never supplies it.
* Alternatives: An agent-supplied nonce, or a senawa-issued attempt ordinal handed
  out at dispatch.
* Rationale: The preimage already carries repository, run, dispatch, task,
  context, principal, and payload, so the identifier is cryptographically scoped
  to one dispatch without trusting the agent. This is the repository's existing
  style: `dispatchId` and both command bridge identifiers are already content
  digests. Exact replay becomes unconditional rather than depending on a client
  reproducing an opaque token. Both alternatives put a key in the model's hands,
  and submissions live in one flat map per state root, which would make an
  agent-chosen identifier a cross-dispatch squatting surface.
* Consequence: The submission-conflict branch becomes unreachable for derived
  identifiers, because different content is now a different key. It stays for
  durable rehydration and any wire-supplied identifier, and conflict detection
  moves to rules that already exist and are already tested. Two deliberately
  identical submissions collapse into one, which is benign except for a repeated
  question; that surfaces to the agent as already open rather than being papered
  over with a salt.

### Decision D-004: The authoring surface is three YAML documents

* Date: 2026-08-16
* Status: Accepted
* Decision: A consumer authors `agents.yaml`, `workflow.yaml`, and `sensors.yaml`,
  with schemas and input and output as JSON. Everything the current template makes
  an author write by hand is derived.
* Rationale: Proven by the `v1-authoring` probe rather than argued. 115 lines of
  YAML compile into a graph of 23 nodes and 29 edges that the kernel accepts,
  against 853 lines across 18 files with a nesting depth of 7 today. The author
  writes no JSON Pointer and no budget unit. A phase names `needs`, and the
  binding is the earlier phase's declared output; a phase names `forEach`, and
  members lower into grouped member phases.
* Consequence: Diagnostics must be part of the format rather than an afterthought.
  The probe already detects an unknown agent, an unknown gate, and a `forEach`
  that reads a phase the author forgot to declare in `needs`. That last one is the
  class of mistake the pointer-based format made impossible by making the author
  state everything twice, so deriving the binding means the compiler has to catch
  it instead.

### Validation

* `v1-authoring` probe: compiles clean, and reports all three seeded diagnostics
  when the authored workflow is deliberately broken.
* Nested phase spike: nine nodes and twelve edges compiled, parent rendered as a
  container with members inside in dependency order.

## Phase 1 log

### Decision D-005: One required budget unit, not six

* Date: 2026-08-17
* Status: Accepted
* Decision: `REQUIRED_WORK_BUDGETS` drops to `review-iteration` alone. The other
  five units remain declarable but are no longer demanded of every phase.
* Rationale: research established that only `review-iteration` is enforced at
  runtime. `dispatch-failure` has an implementation whose planner has no
  production caller, `integration-attempt` is superseded by a hard-coded
  constant, and `work-attempt`, `sensor-retry`, and `rebase-attempt` are never
  counted. Requiring six units made every phase declare seventy-two lines of
  limits that nothing reads.
* Consequence: authored workflows declare no budgets at all; the lowering emits
  the single enforced counter. Existing tests pass unchanged, which is the
  evidence that the other five were never load-bearing.

### Decision D-006: Prompt input paths are read from the template

* Date: 2026-08-17
* Status: Accepted
* Decision: The authoring layer derives a prompt's declared input paths by
  parsing the template the author already wrote.
* Rationale: the compiler validates declared input paths against the template's
  own placeholders, in both directions. The declaration therefore carries no
  information the template does not already have, and its only effect is to fail
  when an author updates one and forgets the other.
* Consequence: `lowerAuthoredWorkflow` needs the prompt texts, so the caller
  supplies them. This keeps the configuration package free of filesystem access.

### Deviation: the acceptance criterion measured the wrong artifact

The plan asked for a generated document under 150 lines at depth 3. The lowered
internal document is 714 lines at depth 7, and that is correct: it is machine
generated and no human reads it. What matters is the authored surface, which is
117 lines across three files against 853 across eighteen. The criterion was
rewritten to measure that instead, rather than being quietly marked as met.

### Deviation: an authored fan-out is refused rather than ignored

The lowering does not yet turn `forEach` into member phases, which is Phase 6
work. Lowering such a phase as an ordinary agent phase would compile cleanly
while silently discarding the collection the author asked to iterate. The
compiler now refuses it with a diagnostic naming the file and path, and the
probe's fan-out phase is commented out with a note pointing at Phase 6.

### Validation

* 6 new authoring tests, including that the lowered document survives the real
  compiler and that a wrong reference names its file, path, and reason.
* Full suite: 105 files and 1,330 tests passed with 2 skipped opt-in live tests.
* Typecheck, boundaries across 467 files, documentation links across 45 files.
* Biome: 33 warnings, all `noTemplateCurlyInString` on intentional prompt
  templates, two of them newly added by the authoring tests.
