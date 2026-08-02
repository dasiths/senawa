---
title: Sensors Probe
description: Whether sensors can be schema-contracted extensions that normalize, cache, defang hostile output, and earn trust
author: Senawa
ms.date: 2026-08-02
ms.topic: reference
keywords:
  - sensors
  - extensions
  - json schema
  - evidence hygiene
  - inferential trust
estimated_reading_time: 5
---

## Goal

Sensors are how the harness perceives the work, so they carry the most weight in
the design. This probe covers the whole sensor story: the extension boundary and
its contracts, the evidence hygiene that keeps sensor output safe to show a
model, and the measurement that decides whether an inferential sensor may block.

## What it proves

### Extensions and contracts

Sensor implementations load from explicitly declared extensions rather than by
scanning installed packages. Each extension exports a versioned manifest with a
description and JSON Schemas for its configuration, input, and output, and every
schema is compiled when the registry loads.

The CLI surface behaves coherently: `doctor`, `sensor list`, `sensor info`,
`sensor run <id>`, and `sensor run`. Against a deliberately malformed
configuration, `doctor` reported four independent failures in one pass: a
configuration value of the wrong type, a missing sensor reference, an unknown
expectation operator, and a blocking gate with no deterministic anchor.

An inferential extension obtains a structured result rather than parsing prose.
It receives instructions, a rubric, a subject, an output schema, and a bounded
submission count. A host that submits `{"verdict": "maybe"}` is rejected against
the schema, and the following valid submission is accepted.

### Evidence hygiene

One `findings[]` shape carried output from four unrelated tools, so adding a
language means adding one parser function and nothing else:

| Tool                     | Raw    | Normalized to                              |
|--------------------------|--------|--------------------------------------------|
| `node --check`           | 167 B  | `bad.js:4 SyntaxError: Unexpected end of input` |
| `python3 -m py_compile`  | 106 B  | `broken.py:2 SyntaxError: expected ':'`    |
| `eslint --format json`   | 482 B  | `bad.js:4 Parsing error: Unexpected token` |
| `tsc --pretty false`     | 204 B  | `parse.ts:24 Type 'string' is not assignable (TS2322)` |

Cost ordering short-circuits: the first red sensor stops the run, so the
expensive readings never execute. Fingerprinting over the sensor definition and
the contents of watched files gave 23 ms cold and 0 ms warm, and every cached
reading was invalidated the moment a watched file changed.

Hostile output is containable. A fixture emitting a prompt-injection payload,
ANSI escapes, a NUL byte, and 50 KB of filler was reduced to 941 B of findings
with no control characters and every instruction tag neutralised.

### Inferential trust

Running the same rubric against unchanged input five times produced a clear
answer on a structural violation and an unstable one on a judgment call:

| Subject                              | Verdict agreement | Findings per run |
|--------------------------------------|-------------------|------------------|
| Domain type performing file I/O      | 5 of 5            | 1, same rule     |
| Is this abstraction worth its weight | 3 of 5            | 0 to 2           |

Trust is therefore a property of a sensor against a class of input, not of the
sensor alone. Promote to blocking only at full agreement over a representative
sample, because a flaky gate teaches the worker that refusals are arbitrary.

Cost confirms the ordering rule: all deterministic sensors together cost 23 ms,
while one inferential run cost 16 to 30 seconds.

## What it does not prove

* Whether a live SDK reviewer reliably calls the schema-backed submission tool,
  since the structured host here is a deterministic fake
* Whether extensions resolve correctly by package name rather than by path
* Whether inferential stability holds on real diffs rather than whole files

## Layout

| Path                    | Role                                                        |
|-------------------------|--------------------------------------------------------------|
| `cli.mjs`               | Extension registry, schema validation at four boundaries, and the CLI surface |
| `extensions/`           | A deterministic command extension and an inferential review extension |
| `sensors.yaml`          | Current configuration: declared extensions, configured sensors, one gate |
| `invalid-sensors.yaml`  | Deliberately malformed configuration used to prove `doctor` fails usefully |
| `hygiene.mjs`           | Normalization, cost ordering, fingerprint caching, hostile output |
| `normalizers.mjs`       | One parser per tool, all producing the same findings shape   |
| `hygiene-sensors.yaml`  | Configuration for the hygiene run                            |
| `stability.mjs`         | Repeated-rubric agreement measurement                        |
| `rubric.md`             | The architecture rubric used by both the extension and the stability run |
| `fixture/`              | Broken, hostile, and architecturally interesting subjects    |

## Running

```bash
bash poc/sensors/run.sh        # offline
bash poc/sensors/stability.sh  # spends AI credits
```

## Change log

| Date       | Change                                                                                                                                          |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First run. Established normalization across four tools, cost ordering with short-circuit, fingerprint caching, hostile output defanging, and the inferential promotion criterion. Sensors were hard-coded branches in the runner and the inferential half scraped the first JSON-looking substring out of model prose. |
| 2026-08-02 | Added the extension registry with JSON Schema contracts, the `list`, `info`, `doctor`, and `run` surface, and structured submissions with bounded retries. The first run caught a real contract leak: host retry diagnostics placed beside the assessment failed output validation, which is why host metadata now belongs in the outer reading or in a declared `data` property. |
| 2026-08-02 | Merged the extension probe into this folder. The original runner is retained as `hygiene.mjs` because its normalization, caching, and hygiene evidence is still current. Both halves now share one rubric and one architectural subject. |
