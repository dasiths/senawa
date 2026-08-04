<!-- markdownlint-disable-file -->
# Production Demo Planning Log

## Discrepancy log

* Browser inclusion differs from one subagent recommendation to defer it. The
  conversation explicitly established browser approval and observation as the
  intended demo experience, so it is included.
* Full beads integration is deferred behind the graph package interface for the
  first vertical slice. This is a scoped implementation deviation, not a design
  change; current runtime truth semantics remain centralized and durable.
  Phase 2 implemented and validated `FileRuntimeStore`; the beads adapter remains
  follow-on work and must not be described as complete in public status.
* The deterministic default proves orchestration without spend. Live Copilot is
  opt-in and does not gate offline acceptance.
* Initial Phase 1 treated `.github/agents` and `.github/hooks` as repository
  definitions. The user corrected ownership: Senawa must embed worker profiles
  and SDK hook policy, materializing or registering them when sessions are
  created. Repository conventions do not own these files.
* The user then sharpened the orchestrator boundary: workflows name consumer
  roles, so their prompts and requested capabilities belong with repository
  workflow configuration, not embedded Senawa behavior. Selected
  `.senawa/agents/<role>.senawa.md` profiles. Hook and permission enforcement
  remains embedded because profiles may request capabilities but cannot grant
  themselves authority.
* Phase 1.5 now implements that ownership boundary. Exact profile sources enter
  snapshots and fingerprints, turns resolve profiles from runtime state, hosts
  apply Senawa-owned capability ceilings, and missing workflow or plan roles
  fail closed.
* Phase 2 initially placed an acceptance verdict on `WorkerResult`. That let a
  worker host participate in its own gate decision and contradicted the
  backpressure architecture. The repaired contract contains only session ID,
  optional artifact, and output. An injected `GateEvaluator`, implemented by
  `CommandGateEvaluator` in `@senawa/sensors`, is now the sole quality-decision
  source for phase and task transitions.
* Final review tightened subprocess tool visibility to the resolved profile
  capability ceiling and removed invalid Resume controls from terminal browser
  states. The guarded live launcher remains a starting point rather than a fully
  automated live journey.
* The root `sensors.yaml` exception contradicted the selected repository
  configuration namespace. Moved production policy to `.senawa/sensors.yaml`.
  POC-local manifests remain unchanged because they are probe fixtures. Broad
  prose updates are intentionally deferred to a separate documentation plan.

## Implementation paths considered

### Promote POC files

Not selected. They combine concerns and include fake state mutation paths.

### Build all seven design slices

Not selected. It includes unrelated scale and observability work before a demo
can exercise the control path.

### Vertical slice over package boundaries

Selected. It preserves architectural ownership, produces executable feedback,
and leaves adapters replaceable.

## Suggested follow-on work

* Add a beads-backed runtime store and parity tests against the file store.
* Add SDK-hosted live workers after revalidating the installed SDK version.
* Probe forced stale-lease termination.
* Add inferential reviewer extensions and sensor stability audits.
* Add generic declared extension loading and reading caching beyond the two
  production built-ins.
* Explore worktrees and multiple runs only after version 1 is stable.
