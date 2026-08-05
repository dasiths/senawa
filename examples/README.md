# Senawa Examples

Examples are supported illustrations of intended Senawa behavior. They exercise
public commands and production package boundaries rather than defining runtime
semantics.

## Demos

* [File-backed offline demo](demos/file-offline/README.md) runs the complete
  deterministic CLI and browser workflow without AI credits. The file runtime
  remains a development and test adapter.
* [Beads-backed offline demo](demos/beads-offline/README.md) runs the same
  deterministic CLI and browser workflow against real Beads without spending
  AI credits.
* [Documentation consistency demo](demos/documentation-consistency/README.md)
  creates a persistent clone and Git branch, runs the production Beads and SDK
  workflow with explicit human decisions, and verifies the completed work.
* [Live Copilot worker demo](demos/live-copilot-worker/README.md) is an opt-in,
  credit-spending worker-host check. It does not yet establish full production
  readiness.

Measured substrate experiments live under
[`experiments/probes/`](../experiments/probes/README.md), not here. A probe
becomes an example only after its behavior is implemented and covered by
acceptance tests.