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
| 0 | Settle the shape | In progress | |
| 1 | An authored workflow becomes a run | Not started | |
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
