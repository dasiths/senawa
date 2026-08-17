---
title: Senawa Consumer Guide
description: Index of the Senawa adoption, authoring, operations, and troubleshooting guides
ms.date: 2026-08-16
ms.topic: overview
---

The consumer set explains how to adopt, configure, operate, and troubleshoot the
Senawa without reading implementation history or source code.

Every page here describes behavior that the delivered
implementation proves. Optional, opt-in, and deferred behavior is labelled where
it appears.

## Start here

* [Getting started](getting-started.md) installs senawa, creates a workflow
  tree with `senawa init`, validates it with `senawa doctor`, starts the local
  supervisor, opens the portal, submits a command, reads receipts and events,
  and shuts down. The whole journey runs without model credits.

## Configure and run work

* [Workflow authoring](workflow-authoring.md) explains every field of
  `.senawa/workflow.json`: workflow input, phases, executors, roles, external
  prompt and schema files, mapped inputs, phase outputs, template substitution,
  schema-selected task loops, plan import, iteration and rework, approvals,
  gates, sensors, budgets, model policy, projected work, and
  `execution.workspaceMode`.
* [Portal](portal.md) explains the browser run console: the interactive workflow
  diagram, node run states, selection and keyboard traversal, the terminal-style
  agent output view, questions, approvals, allowances, run control, and the
  rails and toolbars.
* [Worktree mode](worktree-mode.md) explains the optional
  `execution.workspaceMode: worktree` setting, what it changes, what it requires,
  and the rule that examples and tests use a fresh temporary Git repository.

## Operate and secure

* [Operations](operations.md) covers private local paths, credentials, loopback
  sessions, backup, restore, integrity, repair, diagnostics, drain, logs,
  recovery, SDK session state, the platform matrix, live-worker opt-in, and
  failure handling.
* [Security](security.md) distinguishes principals, roles, capabilities, grants,
  approvals, proposal-only agents, stale results, local transport trust, remote
  control-plane trust, and what never leaves the host.
* [Troubleshooting and limits](troubleshooting.md) covers the platform
  matrix, required native build tools, JSON-only configuration, explicit
  live-model costs, common failures with their exact messages, and unsupported
  or deferred behavior.

## References

* [CLI reference](../reference/cli.md) is the complete command surface.
* [Local supervisor HTTP](../reference/local-supervisor-http.md) is the exact
  route, transport, and local security boundary.
* [Remote control plane](../reference/remote-control-plane.md) is the optional
  outbound connector, its enrollment, and its reference-server limits.

## Design set

The consumer set tells you what to do. The [design set](../design/README.md)
tells you why the system behaves that way.

* [Design overview](../design/overview.md) covers the governing principles.
* [Architecture](../design/architecture.md) covers components and boundaries.
* [Authority model](../design/authority-model.md) covers commands, receipts,
  effects, leases, and fences.
* [Workflow model](../design/workflow-model.md) covers the canonical graph,
  completion accounting, gates, and budgets.
* [Dataflow](../design/dataflow.md) covers input binding, phase outputs,
  fan-out, and plan import.
* [Durability](../design/durability.md) covers migrations, content addressing,
  backup, restore, and crash recovery.
* [Extending Senawa](../design/extending.md) covers adapters, sensors, workers,
  and transports.
* [Production enhancements](../design/WIP/redesign-1/production-enhancements.md) records
  deferred hardening that v1 does not claim as delivered.
