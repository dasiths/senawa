<!-- markdownlint-disable-file -->
# Senawa Configuration Documentation Details

## References

* Plan:
  `.copilot-tracking/plans/2026-08-04/senawa-configuration-docs-plan.instructions.md`
* Accepted decisions: `docs/design/wip/decision-log.md`
* Design index: `docs/design/README.md`
* Production loader: `packages/core/src/definitions.ts`
* Production configuration: `.senawa/sensors.yaml`, `.senawa/workflows/`,
  `.senawa/schemas/`, `.senawa/agents/`

## Phase 1 details

Build a reference table with columns: source file, line, literal path, semantic
owner, classification, and intended action. Treat headings such as
"sensors.yaml schema" as format references only when location is not implied.

Success: every occurrence has a reasoned disposition before editing.

## Phase 2 details

The owning guide for sensor and gate policy is
`04-sensors-gates-and-enforcement.md`. It must introduce
`.senawa/sensors.yaml` on first mention and use that path in frozen-set examples.
The owning guide for worker profiles is `02-workflows-and-lifecycle.md`; it must
show the strict `.senawa/agents/<role>.senawa.md` frontmatter and explain snapshot
and fingerprint behavior.

`03-agents-and-interaction.md` owns effective worker authority. State the
intersection explicitly:

```text
profile request ∩ task scope ∩ host support ∩ Senawa security ceiling
```

`06-provenance-and-observability.md` owns snapshot contents. Name exact profile,
workflow, schema, and policy paths without implying runtime hook files are
repository inputs.

Success: each contract has one owning guide and other guides link rather than
repeat it.

## Phase 3 details

The root README should show the implemented vertical slice honestly: file-backed
runtime store, deterministic browser demo, guarded but unvalidated live worker,
and pending beads adapter. Repository layout should contain no root
`sensors.yaml`, `.github/agents`, or `.github/hooks` Senawa entries.

`AGENTS.md` should tell future agents that new repository configuration belongs
under `.senawa` and that enforcement code remains in Senawa packages.

Success: a new consumer can identify what files they author versus what Senawa
provides.

## Phase 4 details

Do not rename POC fixture files. For example, `poc/sensors/sensors.yaml` remains
the actual sensor probe input and `poc/orchestration/sensors.yaml` remains the
orchestration probe fixture. Historical findings should continue to name what
was measured.

The frozen monolith remains unchanged by repository convention. If its stale path
is likely to confuse readers, rely on its existing historical warning rather
than rewriting history.

Success: evidence remains reproducible and no historical claim is silently
retrofitted.

## Phase 5 details

Use a path-aware search that excludes `node_modules`, `dist`, the frozen
monolith, and POC fixture descriptions when asserting no stale production paths.
Validate Markdown links and anchors with the existing repository script pattern;
parse YAML examples with the installed YAML package and Mermaid blocks with the
available parser/browser tooling.

Success: zero unexplained current-state path references and all executable checks
pass.
