<!-- markdownlint-disable-file -->
# Senawa Configuration Documentation Changes

## Scope

This log records the documentation-only promotion of the accepted repository
configuration boundary. Production source, POC fixtures, and the frozen
historical monolith are outside the edit scope.

## Reference classification

The inventory covers repository documentation and POC READMEs. Plan, details,
change, and review artifacts are workflow metadata and are excluded to avoid a
self-referential inventory. Line numbers describe the pre-edit files; grouped
line lists enumerate repeated occurrences with the same disposition.

| Source file | Line or lines | Literal path | Semantic owner | Classification | Intended action |
|-------------|---------------|--------------|----------------|----------------|-----------------|
| `README.md` | 93, 232 | `.senawa/agents/` | Consumer repository | Current production guidance | Retain and place in the complete consumer layout |
| `README.md` | 233 | `.senawa/workflows/` | Consumer repository | Current production guidance | Retain and clarify ownership |
| `README.md` | 234 | `.senawa/schemas/` | Consumer repository | Current production guidance | Retain and clarify ownership |
| `README.md` | 235 | `.senawa/extensions/` | Consumer repository | Current production guidance | Retain as an optional declared extension location |
| `README.md` | 236 | `.agents/skills/senawa/` | Copilot discovery | Current production guidance | Retain and explain as the discovery exception |
| `README.md` | 237 | `.agents/rubrics/` | Consumer repository | Current production guidance | Retain as optional inferential-sensor input |
| `README.md` | 238 | `sensors.yaml` | Consumer repository | Current production guidance | Change to `.senawa/sensors.yaml` |
| `docs/design/02-workflows-and-lifecycle.md` | 253 | `.senawa/agents/<role>.senawa.md` | Consumer repository | Current production guidance | Retain and add the complete `.senawa` layout |
| `docs/design/04-sensors-gates-and-enforcement.md` | 15, 257, 269 | `sensors.yaml` | Consumer repository | Current production guidance | Change to `.senawa/sensors.yaml` |
| `docs/design/04-sensors-gates-and-enforcement.md` | 78 | `.senawa/extensions/api-contract/index.mjs` | Consumer repository | Current production guidance | Retain as an explicitly declared local extension |
| `docs/design/04-sensors-gates-and-enforcement.md` | 117, 273 | `.agents/rubrics/` | Consumer repository | Current production guidance | Retain as sensor input and frozen policy |
| `docs/design/04-sensors-gates-and-enforcement.md` | 270-272 | `.senawa/{agents,workflows,schemas}/` | Consumer repository | Current production guidance | Retain in the frozen floor |
| `docs/design/04-sensors-gates-and-enforcement.md` | 284 | `.github/{agents,hooks}` | Copilot repository conventions | Rejected approach | Retain as an explicit negative boundary |
| `docs/design/06-provenance-and-observability.md` | 50 | `.senawa/agents/*.senawa.md` | Consumer repository | Current production guidance | Expand to exact workflow, schema, policy, and profile snapshot paths |
| `docs/design/07-implementation-and-operations.md` | 19 | `.senawa/agents/` | Consumer repository | Current production guidance | Retain and align initialization and package ownership |
| `docs/design/wip/decision-log.md` | 53 | root `sensors.yaml` | Superseded consumer layout | Measured historical evidence | Preserve as migration context |
| `docs/design/wip/decision-log.md` | 56, 58 | `.senawa/sensors.yaml` | Consumer repository | Accepted current decision | Retain and replace pending promotion with the owning guide link |
| `docs/design/wip/decision-log.md` | 72, 80 | `.senawa/agents/` | Consumer repository | Accepted current decision | Retain unchanged |
| `docs/design/wip/poc-findings.md` | 110 | `.github/hooks/*.json` | Copilot hook substrate | Measured historical evidence | Preserve measured path and add current Senawa ownership context nearby |
| `docs/design/wip/poc-findings.md` | 241 | `.github/agents/senawa-probe.agent.md` | Copilot custom-agent substrate | Measured historical evidence | Preserve measured path |
| `docs/design/wip/poc-findings.md` | 704-706 | `.github/skills/`, `.agents/skills/`, `.claude/skills/` | Copilot skill discovery | Measured historical evidence | Preserve; `.agents/skills/senawa/` remains the current discovery exception |
| `docs/design/wip/poc-findings.md` | 833 | `sensors.yaml` | Sensor policy format | Generic format name | Preserve historical wording and add current location context nearby |
| `docs/design/wip/roads-not-taken.md` | 162 | `sensors.yaml` | Consumer repository | Current-location statement inside rejected rationale | Clarify as `.senawa/sensors.yaml` |
| `docs/design/wip/roads-not-taken.md` | 213 | `.senawa/prompts/<phase>.md` | Consumer repository | Rejected approach | Preserve rejected path |
| `docs/design/wip/roads-not-taken.md` | 227 | `.github/agents/<role>.agent.md` | Copilot repository conventions | Rejected approach | Preserve and note replacement by `.senawa/agents/` |
| `poc/model-routing/README.md` | 13 | `.github/agents/` | Copilot custom-agent probe | Measured historical evidence | Preserve exact measured path |
| `poc/orchestration/README.md` | 248-249, 251 | `workflows/`, `schemas/`, `sensors.yaml` | Orchestration POC | POC-local fixture | Preserve actual fixture names |
| `poc/sensors/README.md` | 80-82, 85 | `extensions/`, `sensors.yaml`, `invalid-sensors.yaml`, `hygiene-sensors.yaml` | Sensor POC | POC-local fixture | Preserve actual fixture names |
| `docs/design/wip/multi-agent-orchestration.md` | 48, 403, 406, 506, 563, 745, 845, 902, 922, 1129, 1139, 1369, 1382-1389, 1443, 1455-1456, 1526, 1662, 1900-1907, 2001-2002, 2087, 2323, 2404, 2406, 2416 | Configuration, extension, agent, hook, rubric, workflow, schema, and skill paths | Historical design snapshot | Measured historical evidence or superseded design | Preserve the file byte-for-byte |
| `docs/design/wip/multi-agent-orchestration.md` | 2349, 2353, 2367, 2376, 2390, 2396, 2402 | `sensors.yaml` schema or shape | Sensor policy format | Generic format name in historical design | Preserve the file byte-for-byte |

## Ambiguities resolved

* Unqualified `sensors.yaml` in POC layout tables names a real local fixture,
  not production configuration.
* `.github/agents` and `.github/hooks` in probe findings name measured Copilot
  behavior. The same paths in current guides are negative statements about what
  Senawa does not require.
* Unqualified `sensors.yaml` in schema and toolchain discussions names the
  policy format. It does not imply a repository-root location.
* `.agents/skills/senawa/` is repository content only because Copilot discovers
  the user-facing skill there. Runtime worker profiles remain under
  `.senawa/agents/`.

## Implementation progress

* [x] Classified configuration path references before current-state edits
* [x] Updated current design guides by concept ownership
* [x] Updated public and repository agent guidance
* [x] Preserved POC-local and historical references
* [x] Promoted the accepted sensor-policy decision
* [x] Completed documentation and executable validation

## Validation progress

* Current-state path scan: passed; no root `sensors.yaml` and no positive
  `.github/agents` or `.github/hooks` requirement
* Residual path scan: migration history, generic format wording, frozen history,
  and POC-local fixtures only
* Relative links and heading anchors: 94 passed across 46 Markdown files
* YAML examples: 12 parsed
* JSON examples: 12 parsed
* Mermaid: seven diagrams rendered through Mermaid 11.16.0; the changed README
  topology was inspected at 1440 and 390 pixels without clipping or missing
  nodes
* `pnpm typecheck`: passed
* `pnpm lint`: passed, 74 files
* `pnpm test`: passed, 31 tests in nine files
* `pnpm build`: passed
* `pnpm bundle:check`: passed
* `pnpm demo`: passed with 77 journal events, 27 output records, five artifacts,
  two deterministic task rework events, and both tasks closed on attempt 2
* Frozen monolith SHA-256: unchanged at
  `760dd68f2b550bdfbdbf060839cfd0911de7a5ae8c45ec875380dfd161079de3`
* Audited POC README SHA-256 values: unchanged
* Editor diagnostics: no errors in edited documentation
* `git diff --check`: passed

## Files changed

* Public and repository guidance: `README.md`, `AGENTS.md`
* Current design: `docs/design/README.md`, guides 02, 03, 04, 06, and 07
* Working record: `docs/design/wip/decision-log.md`,
  `docs/design/wip/poc-findings.md`, and
  `docs/design/wip/roads-not-taken.md`
* Tracking: this log, the implementation plan, and the corresponding review

Guides 01 and 05 were reviewed and required no configuration namespace edits.
The Senawa skill required no command or location edit. Production source, POC
READMEs and fixtures, and the frozen monolith were not changed by this phase.