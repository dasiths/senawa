---
title: Senawa Design Documents
description: What each document in the design folder owns, and which one to update when understanding changes
author: Senawa
ms.date: 2026-08-02
ms.topic: reference
keywords:
  - design
  - architecture
  - documentation map
estimated_reading_time: 4
---

## Overview

Four documents carry the design, and they are deliberately separated by what
kind of claim they hold. Keeping that separation is what stops the architecture
document from quietly absorbing guesses, and what stops the evidence record from
turning into a second design.

| Document                                                       | Owns                                                                 | Update it when                                          |
|----------------------------------------------------------------|----------------------------------------------------------------------|---------------------------------------------------------|
| [multi-agent-orchestration.md](multi-agent-orchestration.md)   | The architecture: how the harness works, the contracts, and the decisions behind them | The intended solution shape changes                     |
| [poc-findings.md](poc-findings.md)                             | What execution established, including the assumptions that did not survive | A probe produces a new measurement                      |
| [roads-not-taken.md](roads-not-taken.md)                       | The approaches we tried and dropped, and what would bring each one back | An approach leaves the architecture document            |
| This file                                                      | The map of the folder                                                | A document is added, split, or retired                  |

## multi-agent-orchestration.md

The architecture document. It describes the current solution shape: a
deterministic run driver, role-scoped worker sessions, beads as durable graph
state, the `senawa` CLI as the single policy seam, sensor extensions and their
JSON Schema contracts, gates and their expected results, declarative workflows
with re-enterable phases and human approvals, the journal and run report, and the
failure modes worth designing against.

Read "How it works" first for the operating model, then the sections that go
deep on whichever part you are building.

Claims that were checked by execution are marked as measured, and every measured
claim has a corresponding entry in the findings document. Claims that rest on
documentation alone should say so, because the probes have already contradicted
the reference more than once.

## poc-findings.md

The evidence record. It states each claim that was tested, the verdict, and what
the result forces the design to change. It is organised by subject rather than
by chronology, and it ends with the questions that remain open and how to settle
them.

This document should stay honest about its own limits. When a probe uses a fake
host or a deterministic stand-in, the finding says so, because "confirmed
offline" and "confirmed against a live model" are different kinds of evidence.

## roads-not-taken.md

The discard pile. Every approach that was in the architecture document and is no
longer there gets an entry: what it was, why it was attractive, what removed it,
and what evidence would justify revisiting it.

It exists because an undocumented rejection is not a decision, it is a gap that
refills. Without the record, a discarded idea returns looking new and costs the
same argument a second time.

The rule that keeps it from contradicting the architecture: an approach lives in
exactly one of the two documents. When something is removed from the design, it
moves here in the same change. If it ever returns, its entry here is deleted.

## Relationship to the probes

Each folder under [`poc/`](../../poc/README.md) owns one subject and carries its
own README with a goal, its limits, and a dated change log. The findings document
is the cross-cutting summary; the probe READMEs are the local history.

When new research changes our understanding, the order of operations is:

1. Amend the probe that owns the subject and add a dated change log entry.
2. Record the measurement in the findings document.
3. Update the architecture document so it describes the shape we now intend.
4. If the change removed an approach, move it to the roads-not-taken document
   rather than deleting it.

Doing it in that order keeps the architecture document a statement of intent
backed by evidence, rather than a wish list that the probes are expected to
justify later.
