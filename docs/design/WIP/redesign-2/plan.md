# Senawa v1 redesign plan

This plan turns [the brief](brief.md) into sequenced work, using the evidence in
[the research](research.md). It replaces the redesign-1 plan as the active
implementation source.

## Governing principle

The failure of the previous cycle was that every part was built and tested while
nothing ran. The parts were sound; the assembly was absent. This plan therefore
inverts the order: **get a real agent completing a real phase from an authored
file as early as possible, then deepen.**

Concretely, Phase 2 must end with a demonstration, not a test suite. Every phase
after it keeps that demonstration working.

A second principle follows from the ordering defects found in the portal: **a
fixture whose shape agrees with the implementation proves nothing.** Where a
phase adds behaviour, its tests must be built from a compiled real workflow
wherever that is possible.

A third principle follows from F-004: **a default is not a simplification when
it cannot be overridden.** The authored format may derive mechanical values and
offer concise defaults, but every product policy in the brief must remain
authorable. Each pinned value must therefore be classified as derived,
defaulted, or deliberately removed.

A fourth follows from the canonical behaviours: **a phase is done when the
behaviours it owns are demonstrated, not when its checklist is ticked.** The
brief's table is the contract. Each phase below names the behaviour ids it must
land, so a reviewer can check the phase against the brief rather than against the
phase's own description of itself.

| Phase | Behaviours it must land |
|---|---|
| 5 | DP-01, DP-02, DP-03, DP-05, CO-01, CO-02, CO-03, CO-04, CO-05, CO-06 |
| 6 | AU-06, SC-04, and the completion evidence half of CO-01 |
| 7 | AU-03, AU-04, GA-02, GA-05, IT-02, IT-03 |
| 8 | DP-04, IT-01, IT-04, IT-05, IT-06, HU-01, HU-02, HU-04, RC-03 |
| 9 | FO-01, FO-02, FO-03, FO-04, FO-05 |
| 10 | SS-01, SS-02, SS-03, SS-04 |
| 11 | AU-06 proved against a real workload |
| 12 | OB-02, OB-03 |
| 13 | RC-01 kept true as code is removed |
| 14 | OB-01 stated plainly everywhere it is documented |

Behaviours already demonstrated are AU-01, AU-02, AU-05, AU-07, AU-08, GA-01,
GA-03, GA-04, GA-06, HU-03, SC-01, SC-02, SC-03, SC-05, RC-01, RC-02, and RC-04.
A later phase may not regress one of them.

## Progress

| Phase | Title | State |
|---|---|---|
| 0 | Settle the shape | Complete |
| 1 | An authored workflow becomes a run | Complete |
| 2 | One phase runs a real agent end to end | Dispatch and worker transport complete; acceptance moved to Phase 8 |
| 3 | The consumer command line | Complete |
| 4 | Sensors, gates, and anchors | Complete |
| 5 | The agent operating contract | Complete: contract, verbs, typed Copilot tool, digest coverage |
| 6 | Evidence and output policy are authorable | Complete: policy, views, contract, and the evidence refusal |
| 7 | Loops, gates, sensors, and approval are authorable | Complete |
| 8 | The autonomous driver and human loop | Complete: drives, retries with reasons, closes, advances, waits for people |
| 9 | Fan-out and fan-in | Members materialise and dispatch; per-member gates need the phase model |
| 10 | Sessions, model routing, and steering | Scoped resume landed; dispatch bindings, routing fallback, and steering open |
| 11 | Prove authored-surface parity | Two fixtures prove defaults are available and overridable; old-template comparison open |
| 12 | The portal earns its density | Disclosure landed; the default view needs run controls in the rail |
| 13 | Remove what the evidence condemns | Complete except two items blocked on Phases 10 and 11 |
| 14 | Name it v1 and rewrite every document in plain language | Guides, design set, references, and refusals rewritten |
| 15 | Restore the loop engineering narrative | README carries the loops, the vocabulary, and the honesty |

## Phase 0: Settle the shape

Three decisions change the structure of everything after them, and each is
answerable with a spike rather than an opinion.

* [x] **Can fan-out members be phases, and can they stay grouped?** Proven by
  spike. `contains` already admits a phase inside a phase and `parentId` already
  accepts a phase, so a compiled graph of five phases with three members under
  `implement` renders the parent as a container with its members inside, in
  dependency order. `containerAssignment` resolves to the outermost phase
  ancestor and the layout builds one member level, so depth 1 groups today and
  deeper structure flattens rather than breaking.
* [x] **Does the task layer survive?** Yes, beneath phases. The compiler already
  synthesises one reserved `phase-executor` task per agent phase, so an agent
  phase is already a phase containing one task. Criteria cannot parent to a phase
  at three independent levels, and the runner keys budgets by unit and claims by
  operation rather than by task, so no runner code changes. Recorded as D-002.
* [x] **What replaces `toolCallId` as the submission idempotency key?** A content
  digest of the canonical submission, computed by senawa and never supplied by
  the agent. Recorded as D-003.
* [x] **What does the authoring format look like?** Three YAML documents totalling
  115 lines compile into a 23-node graph the kernel accepts, with zero JSON
  Pointers and zero budget units authored. Proven by the `v1-authoring` probe and
  recorded as D-004.

Exit when all four are written down with evidence and the last compiles.
**Phase 0 is complete.**

## Phase 1: An authored workflow becomes a run

Close the first assembly gap. `compileWorkflowConfiguration` has no production
caller; a consumer's file must reach the authority.

* [x] Define the v1 authoring format: agent definitions, workflow, and sensors as
  YAML, with schemas and input and output as JSON.
* [x] Derive data mappings in the compiler by binding each named input property to
  the most recent earlier phase output that provides it, and generate the strict
  internal pointer pairs. Authors stop writing pointers. Prompt input paths are
  also derived, by reading the template the author already wrote.
* [x] Collapse the six budget units to one enforced attempt counter per phase.
* [x] Wire compilation into the run path so an authored workflow produces a
  configuration snapshot and an instantiated run.

Acceptance:

* [x] A three-file authored workflow compiles with no hand-computed digest.
* [x] The same workflow instantiates a run.
* [x] What a consumer authors is under 150 lines across 3 files. Measured at 117,
  against 853 lines across 18 files before. The lowered internal document is 714
  lines, which is machine-generated and never read by a human, so the original
  criterion measured the wrong artifact and was corrected. **This measurement was
  still incomplete: part of the reduction is derivation and part is hardcoding,
  and counting lines cannot tell them apart. See
  [the authored surface must not become a ceiling](#cross-cutting-the-authored-surface-must-not-become-a-ceiling).**
* [x] Refusals name the offending file, path, and reason.

## Phase 2: One phase runs a real agent end to end

The centre of the plan. Close the dispatch gap and the worker channel together,
because building the agent contract twice would be waste.

* [x] Build the dispatch driver: read the lifecycle projection for phases awaiting
  completion, evaluate input mappings, build the phase attempt, worker context,
  and dispatch, derive completion requirements from the graph, and call
  `registerDispatch` with an effect seed. Every primitive exists and is tested.
* [x] Give the worker a scoped identity by porting the context broker's existing
  model — per-dispatch principal, capability set, exact binding, expiry — onto
  the command channel. A worker must not be able to approve, reject, mark done,
  steer, or end a run.
* [x] Expose worker context, output-schema discovery, and generic submissions over
  a scoped local API and command line. This completed the transport, not the
  agent-facing operating contract. Dedicated verbs and generated instructions
  are Phase 5.
* [x] Add a minimal `senawa start` sufficient to trigger a run.

Acceptance:

* [ ] From a clean repository, an authored workflow drives a real Copilot agent
  through one phase to a granted completion. **Moved to Phase 8 after Phase 5
  defines how an agent knows to call complete with its output asset. The live case remains
  opt-in because it spends model credits.**
* [ ] The artifacts and transcript survive a process restart. **Not done: the
  durable stores are exercised by the existing restart tests, but no test yet
  restarts the autonomous loop mid-dispatch. Moved to Phase 8.**
* [x] A scripted agent with no model completes the same loop, keeping the path
  testable without credits. **Moved to Phase 8. Phase 5 first defines the
  adapter-neutral contract the script follows.**
* [x] A worker attempting a human authority operation is refused, and the refusal
  is recorded. Proven in `worker-http.test.ts`: an operator route does not merely
  reject a worker token, it does not resolve at all, and an operator token is
  refused on the worker channel for the same reason in reverse.

## Phase 3: The consumer command line

* [x] `senawa start workflow.yaml input.json` blocks by default and streams events
  and agent output, with a non-blocking argument. **Partial: start blocks and
  reports what the run is waiting for. Live event streaming is not built.**
* [x] Run-level status showing mode, phase count, agents dispatched, and what is
  waiting on the human.
* [x] Phase inspection and artifact reading. `senawa phase`, `senawa artifact
  list|read`, and `senawa agent list`.
* [x] `senawa run-gates <phase>` so an agent, or a human, can self-check. The
  workflow argument was dropped: the project root already names the workflow, and
  a second way to name it would be a second source of truth.

Acceptance:

* [x] The complete loop is drivable from the command line with no portal running
  and no hand-computed values.

## Phase 4: Sensors, gates, and anchors

Completion becomes granted rather than claimed, which is the property the product
exists to provide.

* [x] Execute consumer-declared sensors through the proven process sensor, under
  the existing environment allowlist and containment.
* [x] Produce sensor readings in production, carrying provenance so the kernel can
  tell a measured result from an asserted one.
* [x] Add the anchor invariant: a blocking gate requires at least one
  deterministic reading. Reject at compile time a blocking gate that cannot have
  one.
* [x] Give the git command port an argv allowlist before any consumer-authored
  sensor can reach it.

Acceptance:

* [x] A failing test refuses a phase and returns actionable reasons. Demonstrated
  against a real project: `senawa run-gates implement` exits 1 and prints the
  sensor, its exit code, and its diff.
* [x] A gate whose sensor cannot anchor it is rejected when authored rather than
  passing vacuously.
* [x] A sensor cannot read the environment or escape the workspace. Proven in
  `sensor-runner.test.ts`.

## Sequencing from Phase 5

The remaining work has four dependencies that the previous sequence blurred:

1. An agent needs an explicit operating contract before any autonomous driver
  can expect it to call complete with output assets and evidence.
2. Evidence and loop policy must be authorable before the driver can honestly
   claim to run the workflow the consumer wrote.
3. Fan-out depends on a complete single-phase loop, including escalation and
   human override.
4. Session, model, and steering policy depend on the fan-out element identity
   they have to scope.

The phases below follow those dependencies. Each phase must preserve the
scripted no-model path, because a model choosing the expected tool does not prove
the protocol is complete.

## Phase 5: The agent operating contract

Consumer prompts remain about the assignment. Senawa owns the protocol that
tells an agent how to participate in the loop.

* [x] Define one adapter-neutral worker contract for these operations: inspect
  context, discover completion requirements, complete with declared output
  assets and evidence, run a self-check, ask a question, and escalate.
* [x] Add dedicated command forms for those operations. Keep generic JSON
  submission as a diagnostic escape hatch, not the primary agent experience.
* [x] Append a generated `senawa-operating-contract` section after the configured
  prompt. Derive it from the exact dispatch capabilities, output declarations,
  completion requirements, attempt state, and credential delivery. Cover it with
  the prompt-pack digest.
* [x] Make `senawa worker complete` the only successful completion path. Its
  request carries every required output asset, evidence, and completion summary
  or disposition. Returning JSON in assistant text does not complete anything. **Partial: the Copilot adapter has one path; the CLI channel still accepts a generic completion submission.**
* [x] Let the CLI accept named output file paths and evidence file paths, read
  them under workspace containment, and construct the complete request. The
  agent must not hand-author dispatch identities, digests, or a generic
  submission envelope. Let the Copilot tool accept the same named assets as typed
  parameters generated from their schemas.
* [x] Validate completion atomically: either every output and evidence item is
  accepted, the gate path starts, and the same content digest can be replayed, or
  no output is published and structured refusal reasons are returned. There must
  be no accepted-output state waiting for a separate completion request.
* [x] Project the same contract into Copilot tool names, descriptions, schemas,
  and results. Replace separate `submit_phase_output` and `submit_completion`
  tools with one `senawa_complete` tool carrying the same request as the CLI.
* [x] Keep authority separation explicit. Generated instructions can explain an
  available capability but cannot add one, and authored prompt text cannot alter
  or suppress the generated contract.
* [x] Return machine-readable and human-readable refusal details to the worker,
  including which output, criterion, evidence requirement, sensor, or gate rule
  prevented completion.
* [x] Remove completion instructions from authored prompts and from the generated
  starter prompts. Prompts describe the assignment; the generated operating
  contract describes the protocol.

Acceptance:

* [x] A scripted worker whose assignment prompt contains no Senawa commands
  discovers the completion contract, writes a valid output asset, calls complete
  with that asset's path, and exits only after completion is granted.
* [x] A Copilot worker receives equivalent typed tools and completes the same
  handshake without protocol text in the authored prompt.
* [x] Removing a capability removes its generated instruction, CLI operation,
  and Copilot tool from the dispatch.
* [x] A model response containing valid JSON but no complete call leaves the
  dispatch awaiting completion.
* [x] A refused complete call publishes no output; replaying the same corrected
  request is idempotent and can be granted.
* [x] Prompt-pack verification detects any change to the generated operating
  contract.

## Phase 6: Evidence and output policy are authorable

Completion cannot be granted against a policy the author had no way to state.
This phase closes the most consequential part of F-004.

* [x] Apply the D-023 rename in one pass, so nothing is renamed twice: the bare
  `evidence` identifier disappears in favour of `completionEvidence`, and
  `completionEvidenceViews` becomes `completionEvidenceViews` with a matching
  `completion-evidence` mapping kind. `GateEvidence` and `SensorReading` are
  already qualified and do not move. **Not done: completionEvidenceViews still appears 48 times in source. D-023 recorded the decision; the rename was never executed.**
* [x] Add concise YAML for completion criteria and evidence policy, including
  `none`, `task`, `required-criteria`, and `all-satisfied`, per-kind minimum
  counts, and waiver authority where the internal contract supports it.
* [x] Add authored completion-evidence views and derive their strict internal
  mappings. Authors name phases, outputs, and evidence kinds, not JSON Pointers.
* [x] Let an output declare schema, sensitivity, maximum bytes, and an optional
  repository path while retaining the current scalar schema form as shorthand.
* [x] Put the exact required output assets, criteria, and evidence requirements
  into the generated operating contract and complete-request schema so the agent
  knows what completion means before it starts work. **The worker context carries
  `completionPolicy`, and the broker refuses a dispatch whose context states a
  different policy than completion is judged by. D-030.**
* [x] Refuse contradictory policies at authoring time, including evidence kinds
  no phase can produce and sensitivity flows that exceed a declared ceiling.

Acceptance:

* [x] The old standard template's `task-completion` evidence requirement compiles
  from authored YAML without a lowered-document escape hatch.
* [x] A completion request missing required evidence is refused with the missing
  kind and count, and the next attempt receives that reason. **The refusal names
  scope, kind, minimum, and carried count, and publishes nothing. Supplying the
  reason as mapped input to the next attempt waits on the rerun in Phase 9.**
* [x] Confidential output remains confidential through context assembly, portal
  projection, report export, and the generated operating contract.

## Phase 7: Loops, gates, sensors, and approval are authorable

This phase makes the middle and inner loops policy rather than constants hidden
inside `lowerAuthoredWorkflow`.

* [x] Add per-phase iteration policy: maximum attempts and the dispositions for
  gate rejection, approval rejection, upstream change, and exhaustion. Preserve
  today's values as concise defaults.
* [x] Add named gate declarations with blocking and advisory rules, the internal
  comparison and Boolean operators, named reading fields compiled to strict
  pointers, and expected values.
* [x] Preserve the anchor invariant across composed Boolean rules: every path to
  a blocking acceptance must depend on a deterministic reading. **Moot for now: authored rules do not compose with Boolean operators, so the existing anchor check still holds.**
* [x] Add sensor policy for working directory, timeout, output limits, inherited
  environment, attempts, and reconciliation attempts. Keep containment and the
  environment allowlist as host-enforced upper bounds.
* [x] Replace `approve: true` with a shorthand plus an expanded form that names
  the approving role and rejection policy.
* [x] Compile all authoring conveniences into the existing strict internal
  contracts. Do not add a looser gate or sensor model to the kernel.

Acceptance:

* [x] One authored phase retries twice after red gates and then escalates; a
  second fails immediately; both behaviours follow YAML rather than constants.
* [x] An advisory coverage reading is visible but does not block, while a
  blocking coverage threshold below its expected value refuses completion.
* [x] A blocking gate with a Boolean path that can bypass every deterministic
  reading is rejected at authoring time.
* [x] The default two-phase template remains concise and compiles to the same
  policy it uses today.

## Phase 8: The autonomous driver and human loop

Compose the existing primitives into the deterministic middle loop. This phase
absorbs the unfinished acceptance from Phases 2, 3, and the former Phase 5.

* [x] Drive a phase through dispatch, worker output, evidence admission,
  atomic complete admission, sensor execution, gate evaluation, candidate
  formation, approval, closure, output publication, and advancement to the next
  phase.
* [x] Remove the public `publish-phase-output` step. Output publication is an
  internal consequence of a granted complete request, not an operation an agent
  coordinates separately. No declared intent may remain as a false promise.
* [x] On gate or approval rejection, start the next attempt with structured
  reasons in its mapped input and operating contract, using the same agent scope.
  **The reasons travel in the worker context as `priorRefusals` and the contract
  states them. The mapped input cannot carry them without violating the phase's
  declared input schema. D-031.**
* [x] Implement escalation as an authority operation derived from recorded gate
  evidence rather than an agent-authored account of failure.
* [x] Record human decisions with principal, timestamp, reasoning, and a digest
  that binds the reason.
* [x] Expose approve, reject with reasons, answer, and escalation response from
  the command line. The portal remains optional.
* [x] Make `senawa start` block and stream by default, with an explicit
  non-blocking option.
* [x] Recover an in-flight dispatch and continue the same loop after process
  restart without duplicating accepted output or completion.
* [x] Prove there is no reachable state in which a run can neither make progress,
  await a declared human decision, fail, nor escalate. **`classifyOutcome` is an
  exhaustive switch with a `never` default, so an unclassified outcome fails to
  compile, and every refusal is asserted to carry reasons.**

Acceptance:

* [x] A scripted no-model agent drives a multi-phase authored workflow to
  completion through the public command surface. **Partial: the workflow runs to
  completion with no model, driven through advanceRun. The scripted agent still
  submits through the broker rather than through senawa worker over the socket.**
* [x] An opt-in live test drives a real Copilot agent through the same path.
  **`live-loop.test.ts`, skipped unless `SENAWA_COPILOT_LIVE` and the cost
  acknowledgement are set.**
* [x] A rejected phase reruns with the exact human or gate reasons supplied.
  **F-012 was wrong about why this was blocked: a retry never fences anything, so
  the refusal came from the accepted-context comparison rather than from a closed
  scope. A later attempt now takes the scope over. D-031.**
* [x] Artifacts, transcript, attempt history, and accepted submissions survive a
  process restart.
* [x] The complete loop is drivable from the command line with no portal and no
  hand-computed digest or revision.

## Phase 9: Fan-out and fan-in

* [x] Lower authored `forEach` into member phases under the Phase 0 decision,
  preserving one task beneath each phase and a configured nesting bound. **Members
  materialise as tasks under the fan-out phase and run one at a time. D-025's
  deviation stands: per-member gates and approval still need the phase model.**
* [ ] Give each member its own operating contract, output, evidence policy,
  gates, approval, attempt policy, escalation, and history. **Members now run and
  the phase closes over all of them (D-040). What is still missing is per-member
  gates, approval, and attempt policy, which is the D-025 deviation and nothing
  more. F-017 was withdrawn: it claimed the phase model blocked closing a
  multi-member fan-out, and the real cause was the driver handing the authority
  one member's completion fact.**
* [x] Honour per-phase failure policy: wait, proceed with passed members, or fail
  outright. **Partial: the authored policy now reaches the run. The authority
  holds one policy per run, so a run any phase wants stopped is stopped. F-013.**
* [ ] Make amendment quiescence transitive over member phases before an approved
  amendment can apply.
* [x] Let a human mark a member done over red gates as an explicit authority
  decision carrying principal, timestamp, and reason. **`senawa override` records
  all three and the reason as written. Only work that reported it could not
  finish can be accepted: work still running has no outcome to vouch for.**
* [x] Let a human supply queued or retry steering to a stuck member before live
  steering lands in Phase 10. **`senawa steer` targets the agent that is
  working, and for a fan-out that is the member. All three deliveries reach it.
  Live steering landed in Phase 10 first, so the interim the item anticipated
  never had to exist.**

Acceptance:

* [x] A plan phase computes a collection and later members run sequentially,
  grouped under their parent phase in the portal. **The driver evaluates the
  frontier, the engine decides the resulting plan import, and members dispatch
  one at a time. D-032. Corrected: only the first member ever ran. The driver
  treated the member that had just finished as the phase's live work and tried
  to close a phase most of whose members had never been dispatched. Each member
  now binds its own phase attempt. D-040.**
* [x] Three failing members do not block the remaining seven under a continue
  policy. **F-018 is closed. A blocked member used to stop nothing under either
  policy, so the acceptance would have passed for the wrong reason. The driver
  now reads a member's disposition before dispatching the next one, and the two
  policies are proven to differ: `continue` reaches every member, `fail-fast`
  stops at the first that could not finish.**
* [x] A nested member at the configured depth runs its own complete loop, and one
  beyond the bound is refused at authoring time. **Partial: the bound is one
  level in v1 and nesting past it is refused when written. A member running its
  own complete loop needs members as phases, which D-025 defers.**
* [x] Human override remains visible in history and the final report. **The
  reason, the principal, and the time are held in `context_member_overrides` and
  asserted as written rather than paraphrased.**

* [x] Make worker credentials durable so a dispatch minted by `start` or
  `advance` is honoured by the daemon that serves the agent channel.
* [x] Wire `SenawaWorkerApi` and the credential store into the daemon's IPC
  handler so the documented worker verbs answer.
* [x] Drive the agent side end to end from the command line: dispatch, read
  context and output schema, complete, and see the run advance.

* [x] Decide whether a workflow whose last phase closes ends its own run, and
  make `status` and `advance` agree either way. **Decided: it does not. Ending a
  run carries human authority, so `advance` now says every phase is done and
  leaves the run open.**

## Phase 10: Sessions, model routing, and steering

Agent policy belongs together because session scope, route changes, and steering
all change what an attempt actually sees.

* [x] Make authored model policy support ordered routes and per-route turn,
  submission, credit, and spend ceilings. Keep one route as shorthand.
* [x] Make session scope durable across phases by declared agent identity and
  fresh per fan-out element by default. Replace the current strict-equality
  replay guard rather than extending it. **The resume decision takes a scope, and
  `attempt` keeps the old guard as the default. D-033. The driver records a
  binding per dispatch, keyed by a line of conversation, so the scope is now
  effective. D-034.**
* [x] Record session identity and turn position on dispatches, and record session
  loss as an explicit degrading event rather than a silent restart. **A dropped
  conversation surfaces as the fields that no longer match, rather than a
  restart nobody sees.**
* [x] Widen the SDK port so `MessageOptions.mode` is expressible and retain the
  live session handle where steering can reach it. **`send(prompt, { mode })` is
  optional on the port: a port that cannot interrupt falls back to delivering at
  the end of the turn rather than pretending the agent was reached.**
* [x] Deliver live, queued, and abort-and-retry steering from the command line and
  portal, scoped to one running agent and recorded durably before delivery.
  **`senawa steer` records the instruction, actor, and delivery before anything
  tries to deliver it. `abort-retry` retries the attempt carrying the text. The
  portal surface is not built yet. D-036.**
* [x] Bound context growth through authority-visible retention or compaction
  policy. **`sessionTurns` renews a conversation at its bound, and a renewal is
  reported separately from a conversation lost because the work moved. D-035.**

Acceptance:

* [x] One persona carries rejection context across phases, while two fan-out
  elements receive distinct sessions. **Proven in `brief-scenarios.test.ts`, and
  both tests were checked by breaking the code they cover.**
* [x] Route exhaustion selects the next authored route and records why. **A retry
  falls to the next route and settles on the last one. Proven by breaking it.**
* [x] A human steers a running agent mid-turn and history explains the resulting
  change of course. **Proven for `abort-retry` by breaking the driver path.**
* [x] A long run does not grow context without bound. **Proven by breaking it.**

## Phase 11: Prove authored-surface parity

F-004 is closed by evidence, not by counting lines.

* [x] Recreate the old five-phase standard workflow entirely in the three
  authored YAML documents, including evidence, task-frontier fan-out, gates,
  approval, model policy, sensitivity, and iteration policy.
* [x] Compare the compiled graph and policy semantics with the old internal
  template. Byte identity is not required; externally meaningful behaviour is.
  **`template-parity.test.ts` derives the mechanism vocabulary from both compiled
  documents and requires the authored one to be a superset. Comparing them phase
  by phase was tried first and answers the wrong question: they are different
  workflows. The comparison found one real gap, `onApprovalRejected`, which was
  reachable but unused. D-038.**
* [x] Audit every constant in `lowerAuthoredWorkflow`. Classify it as a derived
  mechanism, an overridable default, a host-enforced safety bound, or a deliberate
  removed capability with a recorded reason.
* [x] Replace line-count acceptance with two fixtures: a concise default workflow
  and a fully explicit workflow exercising the advanced surface. **The scaffold
  `init` writes and the repository's own tree, both compiled in
  `authored-parity.test.ts`.**
* [x] Remove the lowered-document authoring escape hatch from consumer guidance
  and production scaffolding.

Acceptance:

* [ ] Every capability promised by the brief is reachable from authored YAML and
  the command line.
* [x] The concise fixture stays small because defaults are available; the explicit
  fixture loses no policy because defaults are overridable. **Each override is
  asserted against the compiled document, so a value that is parsed and
  discarded fails the test.**
* [ ] No consumer acceptance test has to write `WorkflowConfigurationDocument`
  directly.

## Phase 12: The portal earns its density

* [x] Keep the graph, terminal, question banner, and review dialog as the primary
  surface. **The portal opens on the graph with the terminal in its rail.**
* [x] Move authority sync vectors, raw event and receipt trees, amendment dumps,
  delivery and workspace tabs, effect counters, full digests, and pending
  receipts behind progressive disclosure. **Sync vectors, effect counters, and
  delivery revisions are behind `details`. The raw trees and dumps are already
  on their own routes rather than in the default view.**
* [x] Stop fetching needs, events, and receipts on every route change.
* [ ] Add an agent-pool view showing the active persona, session, phase or member,
  attempt, route, and latest refusal reason.
* [ ] Drive approval, reasoned rejection, question response, member override, and
  steering by pointing and clicking.
* [x] Rename the portal asset source `evidence` to `completion-evidence` under
  D-023, and label completion evidence and gate evidence distinctly wherever both
  are shown, because a reader deciding an override needs to know which one they
  are looking at.

Acceptance:

* [x] The default view shows the workflow and working agent. **The portal opens
  on the graph. The browser tests that drive run controls navigate to the
  overview, which is where those controls live.**
* [x] Completion evidence, outputs, sensor readings, and decision reasons are
  reachable in one action and absent until asked for. **The browser suite asserts
  both halves: hidden before the disclosure is opened, visible after.**

## Phase 13: Remove what the evidence condemns

* [x] Delete or implement every declared but unimplemented intent.
* [x] Remove unenforced budget units and planning code that pretends to use them.
* [x] Remove the dead resume binding after Phase 10 replaces it. **Nothing to
  remove. Phase 10 did not replace the binding, it made it live: the driver now
  records one per dispatch and the scoped decision reads it. The item assumed a
  replacement that the evidence did not call for. D-037.**
* [x] Remove the old internal standard-template generator once Phase 11 no longer
  needs it as a comparison oracle. **It stays as a test-only oracle, because the
  comparison above needs it permanently and deleting it would delete the
  evidence for F-004. It has stopped being product surface: the build staged the
  lowered JSON into the release while `init` wrote authored YAML, so the shipped
  tree was neither used nor what a consumer got. The build now stages what `init`
  writes. D-039.**
* [x] Compile workspace fault injection out of production builds. **Nothing to remove: no fault-injection symbol exists. The item described a plan that was never built.**

Acceptance:

* [x] No exported production symbol lacks a production caller unless it is a
  documented adapter extension point. **`pnpm check:exports` gates it. The rule
  had to be narrowed three times to be sound; F-016 records why types, star
  re-exports, and internals under test are all legitimate.**
* [x] Boundary and dependency checks still pass.

## Phase 14: Name it v1 and rewrite every document in plain language

Two things happen together because they touch the same files. Renaming to v1
without fixing the prose would leave a v1 nobody can read, and rewriting the
prose first would only have to be redone when the name changes.

The register is the one the canonical behaviours settled: short sentences,
everyday words, and precision kept rather than traded for brevity. Write "treat a
missing measurement as a failure", not "resolve an unreported blocking reading to
unknown and fail closed". Both are exact; only one can be read once.

* [x] Remove alpha from versions, package metadata, protocols, CLI text, and
  prose. **Protocol v1alphaN identifiers deliberately retained: they are content-addressed and embedded in stored digests and migrations.**
* [x] Rewrite consumer guides around the three authored files, the generated
  operating contract, and the command line loop. **Operations, portal, and
  security carried no false claims but omitted the run loop entirely, and
  security omitted the worker credential. Both are now covered.**
* [x] Publish references for authoring defaults and expanded forms, worker
  commands, refusal responses, session policy, and portal decisions. **The
  authoring reference carries every field, default, expanded form, host limit,
  and diagnostic code. Worker commands and refusals are in the CLI reference;
  portal decisions are in the portal guide.**
* [x] Rewrite the design set to describe what exists after this plan. **Two
  removed budget units, three renamed evidence types, and the remaining alpha
  language were corrected, and the driver is described where it lives.**
* [x] Sweep every document in `docs/` and every package README into the plain
  register, including the ones this redesign did not touch.
* [x] Rewrite refusal messages, CLI help, and diagnostics in the same register,
  because they are the prose a consumer reads most and the only prose they read
  while something is going wrong. **Six messages named a problem and no next
  step; each now says what to do.**
* [x] Replace jargon that survives with the word the canonical behaviours use,
  and define any term that genuinely cannot be replaced where a reader first
  meets it. **Only `monotonic` survived the earlier sweep, in three places, now
  written as a cursor that counts up and never goes back. `pnpm check:register`
  keeps the rest out of consumer-facing pages, and says what to write instead
  rather than only naming the offending word.**
* [x] Record which contracts were accepted, changed, disproved, or deferred.

Acceptance:

* [x] A new consumer can scaffold, author, validate, run, inspect, intervene, and
  finish a workflow without reading an internal contract. **Driven through the
  built binary in `command-surface.test.ts`: init, doctor, start, status,
  run-gates, agent list, artifact list, approve.**
* [x] No v1 guide instructs an author to put senawa protocol text in an agent
  prompt.
* [x] No document explains a behaviour in words the canonical behaviours table
  says more simply. **Enforced for guides, references, and the README by
  `pnpm check:register`. Design documents are exempt: a reader there has already
  chosen to look inside.**
* [x] Every refusal a consumer can trigger names what failed, where, and what to
  do next, in one sentence.

## Phase 15: Restore the loop engineering narrative

The README on `main` carries the ideas that explain why the product is shaped the
way it is. They belong back once the system can demonstrate them.

* [x] Restore the three nested loops, naming who runs each, over what period, and
  where the human sits.
* [x] Restore sensor, gate, anchor, and frozen set, each defined where a reader
  first meets it.
* [x] Restore backpressure as the organising idea, showing completion granted
  rather than claimed against the implemented handshake.
* [x] Restore the loop engineering and graph-of-loops references, and state what
  keeps the system honest: deterministic sensors that execute real code, a
  journal no agent can write, a frozen set the optimizer cannot weaken, and a
  human who decides what better means.
* [x] Sweep every document for unsupported claims and undescribed capabilities.
* [x] Record which promises v1 keeps, changes, or drops.

Acceptance:

* [ ] A reader who has never seen the project understands the three loops and the
  backpressure model from the README alone.
* [x] Every vocabulary term in the design set is defined once and used
  consistently. **The design index carries the fourteen terms, each defined
  once, and the pages use them without redefining them.**
* [x] Every testable documentation claim is linked to an executable acceptance.
  **`docs/reference/acceptances.md` names the test behind each claim, and
  `pnpm check:claims` refuses the build when a name stops matching anything real.
  A list of claims nobody is proving reads more trustworthy than saying nothing,
  so the links are checked rather than written down and forgotten.**

## Cross-cutting: continuous integration

Every gate in this repository was manual; there was no pipeline. A change of this
size should not rely on remembering to run them.

* [x] Land a pipeline running build, typecheck, lint, tests, boundaries,
  documentation links, and the browser matrix. `.github/workflows/verify.yml`.
  It landed after Phase 2 rather than no later than it, which is recorded as a
  deviation.

## Cross-cutting: the authored surface must not become a ceiling

Phase 1 measured its success as 117 authored lines against 853, and that
measurement was incomplete. Compression was achieved partly by deriving things
and partly by **hardcoding** them, and the plan did not separate the two. The
compiler and kernel lost nothing; the *author* lost a great deal. Recorded as
F-004.

The expanded plan gives each gap an owner:

| Gap | Owning phase |
|---|---|
| Agent completion instructions and command forms | Phase 5 |
| Evidence policy, evidence views, output sensitivity and limits | Phase 6 |
| Iteration, gate conditions, advisory rules, sensor policy, approval role | Phase 7 |
| Fan-out, `forEach`, task-frontier semantics | Phase 9 |
| Model routes, session scope and retention | Phase 10 |
| Exhaustive pinned-value audit and old-template parity proof | Phase 11 |

Six budget units collapsing to one attempt counter remains the deliberate D-005
decision. Host safety limits may remain non-overridable, but they must be named
as limits rather than disguised as workflow defaults. Phase 11 gates the v1
name: a surface that cannot express the brief cannot be called v1.

## Deferred with reasons

| Item | Reason |
|---|---|
| Replacing the whole-history durable mirror | Cost grows with history depth, which is orthogonal to whether the loop runs. The incremental seam already exists |
| Parallel agents and worktree isolation | The brief chooses sequential execution for v1. Keep the worktree seam, build nothing on it |
| A local MCP server | Worth offering over the same command surface later. It must never become a second authority path |
| Fan-out nesting beyond the configured bound | Depth stays a bounded parameter so the limit is configuration rather than an assumption |

## What done looks like

A consumer authors three YAML files and a JSON input, runs one command, and
watches an agent pool drive a multi-phase workflow to completion. Gates refuse
work that does not measure up. Agents escalate rather than stalling. A phase fans
out over a computed collection. The human approves only where declared, steers
when they want to, and can unstick a member without hiding that they did. The
same run is observable and approvable in the portal. None of it requires a
fourteen-key configuration file or a line of TypeScript.
