# Probe: v1 authoring format

## Question

Can three small YAML documents replace the fourteen-key, 853-line
`.senawa/workflow.json` without weakening the graph the kernel compiles?

The v1 brief argues that the current complexity is redundant rather than
load-bearing: the compiler already validates that hand-written JSON Pointer
mappings agree with the schemas and the prompt input paths, so it could derive
them instead. This probe tests that claim by compiling the authored form and
comparing the resulting graph against the one the current template produces.

## What it measures

* Whether an authored surface with no JSON Pointers produces a graph the kernel
  accepts.
* Whether fan-out members expressed as a `forEach` over a prior phase output
  lower into member phases that group under their parent.
* The size and nesting reduction against the generated `workflow.json`.

## What it does not prove

* It does not run an agent, spend credits, or execute a sensor.
* It does not prove the derived mappings are the ones an author intended in
  ambiguous cases; it reports ambiguity rather than resolving it.
* It compiles to the kernel graph directly. It does not exercise
  `compileWorkflowConfiguration`, whose production wiring is Phase 1 work.

## Running it

```bash
node experiments/probes/v1-authoring/probe.mjs
```

Offline. No credits.

## Change log

* 2026-08-16: created for the v1 redesign Phase 0 authoring format spike.
