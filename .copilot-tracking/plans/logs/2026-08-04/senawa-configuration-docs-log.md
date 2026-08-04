<!-- markdownlint-disable-file -->
# Senawa Configuration Documentation Planning Log

## Discrepancy log

* Production sensor policy moved from root `sensors.yaml` to
  `.senawa/sensors.yaml` after the implementation and initial docs were written.
* POC folders intentionally retain local `sensors.yaml` fixtures. They are not
  production configuration and must not be mechanically moved or renamed.
* The WIP monolith is frozen historical context. Current guides supersede it, so
  this plan excludes it even though it contains old paths.
* Worker profiles changed ownership twice during implementation. Final decision:
  repository-owned `.senawa/agents/*.senawa.md`; hook and permission enforcement
  remains Senawa-owned code.

## Implementation paths considered

### Global string replacement

Rejected. It would corrupt POC layout documentation and rewrite historical
measurements.

### Update only the root README

Rejected. The sensor, snapshot, workflow, and worker-authority contracts live in
separate numbered guides and would remain contradictory.

### Ownership-based documentation pass

Selected. Update the guide that owns each concept, then align public and agent
guidance. Preserve evidence and history.

## Suggested follow-on work

* Add a generated configuration reference from Zod schemas once contract churn
  slows.
* Add a `senawa init` command that scaffolds `.senawa` consumer configuration.
* Add documentation CI for stale production paths, links, YAML, and Mermaid.
* Decide whether `.agents/skills/senawa` should be installed by Senawa rather
  than committed by every consumer repository.
