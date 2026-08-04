<!-- markdownlint-disable-file -->
# Senawa Configuration Documentation Review

## Metadata

* Plan: `.copilot-tracking/plans/2026-08-04/senawa-configuration-docs-plan.instructions.md`
* Details: `.copilot-tracking/details/2026-08-04/senawa-configuration-docs-details.md`
* Date: 2026-08-04
* Scope: documentation and tracking artifacts only

## Outcome

The accepted configuration decisions are promoted consistently. Consumer
repositories own `.senawa/sensors.yaml`, `.senawa/agents/`,
`.senawa/workflows/`, and `.senawa/schemas/`. Profiles request capabilities;
effective authority is their request intersected with task scope, host support,
and Senawa's non-removable security ceiling. Runtime hooks, isolation, gate
evaluation, capability mapping, and audit remain Senawa-owned.

`.agents/skills/senawa/SKILL.md` is documented as the Copilot discovery
exception. It is not worker configuration or an authority grant. The skill's
commands and decision rules were reviewed and required no edit.

## Classification review

* Current production guidance was updated by the owning numbered guide and
  reflected concisely in the public README and repository guidance.
* POC-local `sensors.yaml`, `workflows/`, `schemas/`, and `extensions/` names
  remain unchanged because they identify reproducible fixture files.
* `.github/agents` and `.github/hooks` in findings remain unchanged where they
  identify measured Copilot substrate behavior.
* Rejected `.senawa/prompts/` and `.github/agents/` paths remain visible in Roads
  Not Taken, with concise notes naming the current replacement.
* Generic references to the `sensors.yaml` schema or format remain historical
  format names rather than asserted locations.
* The frozen monolith remained byte-for-byte unchanged.

## Residual references

* `docs/design/wip/decision-log.md` retains root `sensors.yaml` as the accepted
  decision's migration context.
* `docs/design/wip/poc-findings.md` retains one generic `sensors.yaml` format
  name inside the probe-derived change list; a preceding note names the current
  production path.
* `docs/design/wip/multi-agent-orchestration.md` retains all stale and generic
  paths because it is a frozen historical snapshot.
* `poc/orchestration/README.md` and `poc/sensors/README.md` retain local
  `sensors.yaml` entries because those files exist and reproduce the probes.
* Current guides retain `.github/agents` and `.github/hooks` only in explicit
  negative statements that repositories do not use them for Senawa.

## Validation

* Current-state and residual path scans: passed
* Relative links and heading anchors: 94 passed across 46 Markdown files
* Structured examples: 12 YAML and 12 JSON blocks parsed
* Mermaid: seven diagrams rendered with Mermaid 11.16.0; README topology
  inspected at 1440x483 and 390x131
* `pnpm typecheck`: passed
* `pnpm lint`: passed, 74 files
* `pnpm test`: passed, 31 tests in nine files
* `pnpm build`: passed
* `pnpm bundle:check`: passed
* `pnpm demo`: passed, no Copilot invoked
* Editor diagnostics: no errors
* Frozen monolith and audited POC README hashes: unchanged
* `git diff --check`: passed

Local Mermaid CLI rendering could not launch its ephemeral Chrome because the
container lacks `libnspr4`. Mermaid Ink accepted and rendered all seven diagrams
using Mermaid 11.16.0, so no repository dependency or container change was
needed.

## Review status

Complete. All planned documentation and executable validation passed.