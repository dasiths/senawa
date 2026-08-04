<!-- markdownlint-disable-file -->
# Senawa Configuration Documentation Plan

## User requests

* Update all documentation after moving repository sensor and gate policy to
  `.senawa/sensors.yaml`.
* Keep worker profiles and prompts repository-owned under
  `.senawa/agents/<role>.senawa.md`.
* Keep Senawa responsible for orchestration, capability ceilings, hook policy,
  isolation, gates, and audit rather than repository `.github` conventions.
* Preserve POC-local fixture names and historical evidence accurately.

## Objectives

Make every current-state document express one coherent configuration boundary:
consumer repositories define Senawa workflows, schemas, worker profiles, and
sensor/gate policy under `.senawa`; Senawa owns runtime enforcement and state;
the user-facing Senawa skill remains under `.agents/skills` because that path is
a Copilot discovery convention.

Avoid a blind path replacement. Distinguish production configuration, probe
fixtures, and historical records.

## Context summary

Repository guidance: `AGENTS.md`. Current design reading order and concept
ownership: `docs/design/README.md`. Accepted decisions:
`docs/design/wip/decision-log.md`, entries "Worker profile ownership" and
"Sensor policy location". Production implementation loads
`.senawa/sensors.yaml` in `packages/core/src/definitions.ts` and snapshots
profiles from `.senawa/agents/`.

The historical monolith under `docs/design/wip/` is frozen. POC folders own local
fixtures whose filenames need not match production layout.

## Implementation checklist

### Phase 1: Classify references
<!-- parallelizable: true -->

- [x] Inventory every `sensors.yaml`, `.github/agents`, `.github/hooks`,
      `.senawa/agents`, workflow, schema, extension, and skill path in Markdown.
- [x] Classify each as current production guidance, POC-local fixture, measured
      historical evidence, rejected approach, or generic format name.
- [x] Record ambiguous references before editing; do not infer them from string
      matching alone.

### Phase 2: Update current design guides
<!-- parallelizable: false -->

- [x] Update `docs/design/02-workflows-and-lifecycle.md` to define the complete
      `.senawa` consumer configuration layout and worker-profile grammar.
- [x] Update `docs/design/03-agents-and-interaction.md` to distinguish
      repository-requested capabilities from Senawa-granted effective authority.
- [x] Update `docs/design/04-sensors-gates-and-enforcement.md` so all production
      sensor, gate, extension, and frozen examples use `.senawa/sensors.yaml`.
- [x] Update `docs/design/06-provenance-and-observability.md` so snapshots name
      the exact `.senawa` assets and keep runtime output under tracking storage.
- [x] Update `docs/design/07-implementation-and-operations.md` package,
      initialization, demo, and ownership descriptions to match the implemented
      vertical slice.
- [x] Update `docs/design/01-system-model.md` and
      `docs/design/05-runtime-and-state.md` only where the configuration namespace
      changes their mental model or state ownership tables.

### Phase 3: Update public and agent guidance
<!-- parallelizable: true -->

- [x] Update root `README.md` repository layout, concepts, prerequisites, demo
      instructions, and topology labels.
- [x] Update `AGENTS.md` so future ideas and implementation changes preserve the
      `.senawa` configuration boundary.
- [x] Review `.agents/skills/senawa/SKILL.md` for stale command or location
      language; change only if the user-facing workflow needs it.
- [x] Update `docs/design/README.md` concept ownership only if the split guides
      changed responsibility.

### Phase 4: Preserve evidence and POCs
<!-- parallelizable: false -->

- [x] Keep POC-local `sensors.yaml` and related README layout entries unchanged
      when they describe real probe fixtures.
- [x] Keep `docs/design/wip/multi-agent-orchestration.md` frozen as a historical
      snapshot.
- [x] Review `docs/design/wip/poc-findings.md` and
      `docs/design/wip/roads-not-taken.md`; preserve measured historical filenames
      and add a concise current-location note only where readers could mistake
      history for current production guidance.
- [x] Update the sensor-policy decision entry promotion link after the owning
      current guide is corrected.

### Phase 5: Validate consistency
<!-- parallelizable: false -->

- [x] Search current-state docs for root `sensors.yaml`, repository
      `.github/agents`, and repository `.github/hooks`; allow only explicitly
      historical or POC-local contexts.
- [x] Validate all relative links and heading anchors.
- [x] Parse every YAML and JSON example.
- [x] Parse every Mermaid diagram and inspect changed diagrams at desktop and
      mobile sizes when applicable.
- [x] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`,
      `pnpm bundle:check`, `pnpm demo`, and `git diff --check`.
- [x] Update tracking changes and review logs with exact validation results.

## Files in scope

* `README.md`
* `AGENTS.md`
* `.agents/skills/senawa/SKILL.md`, review only unless stale
* `docs/design/README.md`
* `docs/design/01-system-model.md` through
  `docs/design/07-implementation-and-operations.md`
* `docs/design/wip/decision-log.md`
* `docs/design/wip/poc-findings.md`, limited current-location clarification
* `docs/design/wip/roads-not-taken.md`, limited current-location clarification
* `poc/**/README.md`, audit only unless a production-path claim is stale

## Excluded files

* `docs/design/wip/multi-agent-orchestration.md`, frozen historical monolith
* POC fixture manifests and scripts, unless validation proves their own README is
  inaccurate
* Production source code; the configuration move is already complete

## Success criteria

* Current guidance consistently places repository-owned Senawa configuration at:
  `.senawa/sensors.yaml`, `.senawa/workflows/`, `.senawa/schemas/`, and
  `.senawa/agents/`.
* Current guidance states that profiles request capabilities while Senawa applies
  host support, task scope, and a non-removable security ceiling.
* No current guidance requires `.github/agents` or `.github/hooks` for Senawa.
* The `.agents/skills/senawa/` exception is explained as a Copilot-facing user
  interaction asset, not runtime worker configuration.
* POC-local and historical names remain accurate rather than mechanically
  rewritten.
* Documentation and full executable validation pass.
