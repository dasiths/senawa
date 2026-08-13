---
title: CLI Reference
description: Commands for creating and validating Senawa alpha workflow configuration
ms.date: 2026-08-13
ms.topic: reference
---

## Commands

Create a sensor-free `senawa.dev/workflow/v1alpha1` JSON example without
overwriting an existing destination:

```bash
senawa init [path]
```

The path defaults to `senawa.json`. The command uses exclusive creation, so
concurrent invocations allow exactly one writer. Existing files, including
partial files, remain unchanged. Success means the complete content and its
parent directory have been synced. A failed write or sync can leave the newly
created partial path in place; init does not remove it because another actor
could have replaced the pathname.

Validate a JSON workflow configuration and report all deterministic compiler
diagnostics:

```bash
senawa doctor [path]
```

The path defaults to `senawa.json`. A valid document exits with code `0`.
Invalid configuration, invalid JSON, and read failures exit with code `1`.
JSON failures include a normalized syntax category and line and column.
Filesystem failures expose an allowlisted error code without stack traces or
internal paths. Doctor does not execute sensors, start work, invoke models, or
contact a runner.

Display command help or the alpha version:

```bash
senawa --help
senawa --version
```

The supervisor and workflow runtime commands remain assigned to
[Phase 8](../design/implementation-plan.md#phase-8-local-supervisor-http-sse-and-cli).