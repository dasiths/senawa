# Worker Role Profile Ownership Research

## Research question

Should Senawa embed worker role prompts and profiles, or should consumer repositories define them under `.senawa` with a Senawa-specific extension?

## Status

Complete. Repository-owned worker profiles are the recommended design.

## Scope

The analysis covers repository agents, prompt-only files, split policy and prompt files, embedded defaults, package extensions, models, tools, permissions, hook enforcement, schema validation, snapshots, fingerprints, SDK mapping, deterministic execution, versioning, security, frozen files, portability, and demo impact.

## Key discoveries

* Current design text assigns model, tool surface, persona, instructions, and hook policy to embedded runtime assets and excludes them from the repository fingerprint. See docs/design/02-workflows-and-lifecycle.md, docs/design/03-agents-and-interaction.md, docs/design/04-sensors-gates-and-enforcement.md, and docs/design/06-provenance-and-observability.md.
* The production-demo plan made embedding a requirement, but its planning log records this as a user ownership correction rather than an evidence-backed, accepted architecture decision. docs/design/wip/decision-log.md has no corresponding entry.
* packages/core/src/definitions.ts already provides a strict repository-definition boundary for workflows, schemas, sensor policy, and the principal-agent skill. Workflow and plan task roles are symbolic identifiers but are not validated against repository profiles.
* packages/orchestrator/src/runtime-assets.ts is a five-entry in-memory registry. packages/orchestrator/src/worker-host.ts performs a direct lookup in deterministic and subprocess hosts. No deeper dependency requires compiled-in profiles.
* packages/orchestrator/src/run-services.ts fingerprints repository definitions, and packages/graph/src/runtime-store.ts makes the snapshot immutable. Embedded profiles are resolved after snapshotting, so a runtime upgrade can silently change prompt, model, or tools on resume without changing the fingerprint.
* packages/hook/src/policy.ts is a Senawa-owned enforcement engine. It denies dangerous Git operations and frozen writes and returns denial or no decision, never `allow`. Enforcement code is distinct from repository-authored role behavior and should stay embedded.
* The measured SDK 1.0.7 surface accepts `model`, `reasoningEffort`, `systemMessage`, `availableTools`, `excludedTools`, typed `tools`, and `onPermissionRequest` on create and resume. System-message append mode retains SDK guardrails; replace mode removes them.
* scripts/demo.mjs already copies `.senawa` recursively into the isolated demo repository. Profiles under `.senawa` need no new demo transport mechanism.

## Option evaluation

### Repository-owned `.senawa/agents/*.senawa.md`

This is the strongest option. A worker profile is more than prose, so YAML frontmatter can carry strict execution metadata while the Markdown body carries durable role instructions. The Senawa-specific extension avoids confusion with Copilot custom agents. One atomic file binds prompt, model hints, requested tools, permissions, schema version, and snapshot hash.

The location matches workflow role references already owned by `.senawa`. It permits unknown-role validation before dispatch and makes profile drift visible in the run fingerprint.

### Repository-owned `.senawa/prompts/*.senawa.md`

This is too narrow. Prompt terminology hides model, effort, tools, and permission metadata. Putting that metadata elsewhere recreates a split and allows policy and prose to drift. Use `agents` as the repository namespace and `WorkerProfile` as the schema kind.

### Split role policy and prompt

Separate YAML and Markdown files improve independent reuse but turn each role into a multi-file transaction. Doctor, snapshotting, review, and imports must prove that references and versions remain paired. Current evidence does not show enough reuse to justify this cost. Keep metadata and body together in version 1.

The ownership split should remain: repositories own requested behavior and capabilities; Senawa owns harness scaffolding and enforcement.

### Embedded built-in defaults

Embedded defaults preserve the current demo with little code but make Senawa opinionated about role names and behavior, hide changes from repository fingerprints, and couple workflow evolution to runtime releases. Do not retain implicit defaults. Senawa may ship templates copied by `init`; after installation they are repository definitions. Missing profiles fail closed.

### Package or plugin extensions

Executable role plugins add unnecessary supply-chain and startup code-execution risk. A future data-only profile bundle may use explicit package declarations, exact versions, schema validation, and full snapshot materialization. Defer that feature until repository duplication is measured. Local profiles are the version 1 authority.

## Recommended design

Adopt repository-owned `.senawa/agents/*.senawa.md` profiles. Senawa has no built-in personas or role names. It owns the `WorkerProfile` contract, brief composition, typed worker operations, session isolation, host capability mapping, permission enforcement, mandatory frozen definitions, gate loops, and audit records.

Each profile is data only. YAML frontmatter carries policy; the Markdown body carries instructions. Version 1 performs no body template expansion.

```markdown
---
apiVersion: senawa.dev/worker-profile/v1
kind: WorkerProfile
metadata: { name: implementor }
spec: { model: { id: claude-sonnet-4.6, effort: high }, tools: [repository.read, repository.search, repository.edit, process.run, senawa.task.done, senawa.ask, senawa.discover, senawa.note], permissions: { writes: task-paths, shell: constrained } }
---

# Implementor

Implement only the claimed task and stay within the paths in its brief. Use the provided evidence and acceptance criteria, then request completion through the bounded Senawa worker operation.
```

The version 1 grammar is closed:

* `metadata.name` uses the existing identifier grammar and equals the filename stem
* `spec.model.id` is a requested default; optional effort is `low`, `medium`, `high`, or `xhigh`
* `spec.tools` contains Senawa capability names, not host wire names
* `permissions.writes` is `none` or `task-paths`
* `permissions.shell` is `none` or `constrained`
* `task-paths` is valid only for task-owned turns and is intersected with declared task paths
* Constrained shell always passes through Senawa command policy and an OS sandbox when configured
* Profiles cannot declare hooks, frozen-path exemptions, callbacks, raw commands, provider credentials, package code, or an allow-all mode
* Cross-validation rejects incompatible combinations, such as edit without task-path writes or process execution without constrained shell

A profile requests capability. Effective capability is the intersection of the request, owner scope, host support, and Senawa's mandatory security ceiling. Profiles can reduce authority but cannot expand that ceiling.

### Validation and role resolution

packages/core/src/definitions.ts should parse structured YAML frontmatter, validate strict metadata and a non-empty size-bounded body, reject symlinks and duplicate names, and add profiles to `RepositoryDefinitions`.

`senawa doctor` and `work start` validate static workflow roles. Plan import validates dynamic task roles before creating tasks. Missing roles, unsupported required capabilities, owner-permission mismatches, and filename-name mismatches fail before dispatch.

Task `execution.model` and `execution.effort` remain portable per-task hints and take precedence over profile defaults. They never alter tools or permissions. Requested and effective host values are both recorded.

### Snapshot and fingerprint

Snapshot version 2 should contain a parsed profile map and exact raw profile files. The fingerprint remains a hash of sorted `path:sha256` entries, so prompt, model, tool, and permission changes all cause drift. Every turn resolves its profile from the immutable snapshot, never the live repository or a global registry.

Add `.senawa/agents/**` to the visible frozen list and Senawa's mandatory frozen-definition floor. Repository frozen entries are additive and cannot remove workflows, schemas, sensors, or profiles from that floor.

Record Senawa runtime version, host kind and version, SDK or CLI version, and host-policy version as provenance. These values are not repository fingerprint inputs. Runtime upgrades may tighten enforcement for old runs but cannot change snapshotted prompt or requested capability. Incompatible runtime or profile versions fail closed.

### SDK `createSession` mapping

| Profile or harness value | SDK 1.0.7 field |
|--------------------------|-----------------|
| Resolved model | `model` |
| Supported effort | `reasoningEffort` |
| Profile body plus stable Senawa guidelines | `systemMessage: { mode: "append", content }` |
| Built-in capability allowlist | `availableTools` with source-qualified `ToolSet` entries |
| Defense-in-depth denylist | `excludedTools` |
| Owner-pinned Senawa operations and submission schemas | Typed `tools` |
| Frozen paths, task scope, and command decisions | `onPermissionRequest` |
| Fast observation or denial only | `hooks.onPreToolUse` |
| Stable run identity | `sessionId` and isolated client `baseDirectory` |

Never use system-message replace mode because the SDK states that it removes guardrails. Disable config discovery and ambient custom agents for worker sessions. Reapply snapshot-derived configuration and the current Senawa permission handler on `resumeSession`. Hooks return denial or no decision, never `allow`, because measured behavior shows that `allow` bypasses `onPermissionRequest`.

### Subprocess and deterministic hosts

The subprocess adapter maps abstract capabilities to exact allow and deny flags. It combines profile instructions and stable guidelines on the first turn; resume sends only the turn brief. Unsupported required capabilities fail before launch.

The deterministic host validates and consumes the same snapshot profile but does not interpret prose. Seeded artifacts and refusals remain keyed to phase and attempt. Output includes profile name and digest, proving that tests used snapshot input without spending credits.

### Security and portability

Profile content is trusted repository configuration at startup but untrusted for grants. Strict parsing, size limits, no executable imports, no environment interpolation, exact capability enums, source-qualified host tools, path intersection, mandatory frozen paths, capability removal, permission callbacks, and optional OS sandboxing form the boundary.

Abstract capabilities keep profiles portable across SDK, subprocess, and future hosts. Model and effort are separately resolved through host capability tables. Future package bundles must remain data only and materialize exact contents into the snapshot.

## Migration plan

1. Add `WorkerProfileSchema`, frontmatter loading, role cross-validation, and focused core tests while retaining the embedded registry as legacy input.
2. Move the five current model, tool, and instruction definitions into `.senawa/agents` without changing behavior. Add the path to visible and mandatory frozen definitions.
3. Introduce snapshot v2 with parsed profiles, raw profile files, profile-inclusive fingerprints, and runtime-host provenance. Never rewrite v1 snapshots.
4. Resolve `WorkerTurn` profiles from the snapshot and pass the resolved profile into each host. Remove direct global-registry imports from new-run execution.
5. Add the SDK adapter with append-mode instructions, exact tool allowlists, typed owner-pinned operations, and Senawa-owned permission callbacks. Test create and resume parity.
6. Keep a temporary v1 reader that labels the current embedded set `legacyEmbeddedProfiles`. Remove it after a declared compatibility window. New runs require repository profiles.
7. Test unknown workflow and plan roles, fingerprint drift, frozen writes, snapshot-based resume, capability intersections, and host parity.
8. Keep the offline demo transport unchanged because it already copies `.senawa`. Update expected snapshot paths and deterministic output. Run the live demo only with explicit credit approval.
9. Follow AGENTS.md before implementation: create a decision-log entry, extend the orchestration probe with a falsifiable profile-resolution case, record evidence, then promote accepted guidance.

## References and evidence

* AGENTS.md
* docs/design/README.md
* docs/design/01-system-model.md
* docs/design/02-workflows-and-lifecycle.md
* docs/design/03-agents-and-interaction.md
* docs/design/04-sensors-gates-and-enforcement.md
* docs/design/05-runtime-and-state.md
* docs/design/06-provenance-and-observability.md
* docs/design/07-implementation-and-operations.md
* docs/design/wip/decision-log.md
* .senawa/workflows/standard-delivery.yaml
* .senawa/schemas/work-request.schema.json
* .senawa/schemas/definition.schema.json
* .senawa/schemas/research.schema.json
* .senawa/schemas/plan.schema.json
* .senawa/schemas/verification.schema.json
* sensors.yaml
* packages/core/src/definitions.ts
* packages/core/src/contracts/workflow.ts
* packages/core/src/contracts/artifacts.ts
* packages/core/src/contracts/run-snapshot.ts
* packages/orchestrator/src/runtime-assets.ts
* packages/orchestrator/src/worker-host.ts
* packages/orchestrator/src/run-services.ts
* packages/orchestrator/src/service-factory.ts
* packages/hook/src/policy.ts
* packages/graph/src/runtime-store.ts
* scripts/demo.mjs
* scripts/demo-live.mjs
* poc/sdk-surface/README.md
* poc/sdk-surface/probe.mjs
* poc/sdk-surface/precedence.mjs
* poc/sdk-surface/node_modules/@github/copilot-sdk/dist/types.d.ts
* .copilot-tracking/plans/2026-08-04/production-demo-plan.instructions.md
* .copilot-tracking/plans/logs/2026-08-04/production-demo-log.md
* .copilot-tracking/details/2026-08-04/production-demo-details.md
* .copilot-tracking/changes/2026-08-04/production-demo-changes.md

## Recommended next research

* Probe exact SDK built-in tool names needed for each abstract capability
* Exercise one live SDK create and resume using a snapshotted profile
* Test a hostile profile against mandatory frozen paths and capability ceilings
* Choose the v1 snapshot compatibility window
* Revisit data-only package bundles only after cross-repository duplication appears

## Clarifying questions

None. The remaining questions affect implementation sequencing, not ownership.
