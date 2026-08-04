# Repository Guidance

These instructions apply to the entire repository.

## Source of truth

* [README.md](README.md) is the public overview. Keep it concise and consistent
  with the design guides.
* [docs/design/README.md](docs/design/README.md) defines reading order and concept
  ownership.
* Numbered files in `docs/design/` describe the current intended architecture.
  Update the one guide that owns the concept; link from other guides instead of
  duplicating the contract.
* `docs/design/wip/` is the non-authoritative working record for proposed ideas,
  evidence, and decision history. New ideas start in its decision log. Do not add
  current architecture to the historical monolith.
* Probe findings are authoritative for measured behavior. Current design guides
  are authoritative for intended behavior.

## Configuration and enforcement boundary

* Put repository sensor and gate policy in `.senawa/sensors.yaml`, worker
  profiles in `.senawa/agents/`, workflows in `.senawa/workflows/`, and artifact
  contracts in `.senawa/schemas/`.
* Keep Senawa worker configuration out of `.github/agents` and runtime
  enforcement out of `.github/hooks`.
* Keep the user-facing skill at `.agents/skills/senawa/SKILL.md`. This is a
  Copilot discovery exception, not a worker-profile location or authority grant.
* Implement capability ceilings, hook policy, isolation, gate evaluation, and
  audit in Senawa packages. Repository profiles request capabilities but cannot
  grant or weaken runtime authority.
* Preserve POC-local fixture names and measured historical paths. Do not replace
  them mechanically when production configuration moves.

## Mature an idea

Use this sequence for a new or changed idea:

1. Add an entry to `docs/design/wip/decision-log.md`. Name the owning design
  guide, current status, decision question, and evidence needed.
2. Turn the idea into one falsifiable question. Reuse the matching
  `poc/<subject>/` folder. Create a new subject only when no
   existing probe can answer the question without losing cohesion.
3. Build the smallest probe that can disprove the idea. Mark the decision entry
  as `probing`. Do not update current
   design guidance before evidence exists unless the text is explicitly marked
   as an open decision.
4. Run the probe and record the environment, command, observed result, limits,
   and date in the probe README.
5. Record the cross-cutting result in
   `docs/design/wip/poc-findings.md`, distinguishing live-model, offline,
  simulated, and documentation-only evidence. Update the decision entry with
  the result.
6. If accepted, update the numbered design guide that owns the concept, link its
  measured claim to the evidence, and mark the decision `accepted`.
7. If rejected or superseded, record the durable rationale in
  `docs/design/wip/roads-not-taken.md`, link it from the decision entry, and
  mark the decision accordingly.
8. Update the root README only when the public mental model, status, prerequisites,
   repository layout, or recommended entry path changed.

## POC conventions

* Keep one folder per subject and amend it as understanding changes. Minimize the
  total probe count.
* Every probe folder has a README with: goal, question or hypothesis, method,
  what it proves, what it does not prove, layout, reproduction command, and dated
  change log.
* `run.sh` is the safe default and must not spend AI credits. Credit-spending
  probes use a clearly named separate script and state the cost before execution.
* Make probes runnable from the repository root and independent of execution
  order or shared state.
* Prefer real substrate behavior over mocks. Label deterministic stand-ins and
  simulated hosts explicitly.
* Preserve exact versions, commands, timings, exit codes, and failure output
  needed to reproduce a claim.
* Delete superseded probe code or rename it to the evidence it still provides.
  Do not leave stale mechanisms looking current.

## Documentation conventions

* Markdown files use an H1 title and no documentation frontmatter. Executable
  manifests such as `SKILL.md` keep required YAML metadata.
* Keep current behavior, evidence, and rejected alternatives in their separate
  homes. Do not turn one document into all three.
* Describe contracts once. Use relative links for supporting context.
* Mark whether a claim is proposed, measured, or still unvalidated.
* Keep examples consistent with the real command grammar and caller authority.
* Classify configuration path references as current guidance, POC fixtures,
  measured history, rejected approaches, or generic format names before moving
  them.
* Validate relative links, heading anchors, YAML examples, Mermaid diagrams, and
  `git diff --check` after documentation changes.

## Before finishing

Confirm that the probe, findings record, owning design guide, design index, and
root README agree at every layer the change affects. Leave unrelated documents
alone.
