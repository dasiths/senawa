# Limits

Senawa bounds nearly everything that crosses one of its boundaries. This records
what those bounds are, who feels them, and why each one exists, because the
values look arbitrary until you know which question each was answering.

The short version: the byte limits are not tight, and they are not what makes
agents fail. Measured against a real run they sit between one and thirteen per
cent of their ceiling. What costs an agent a turn is a handful of *shape* rules
and two caps that are not about size at all.

## Why there are limits

One reason, and it is narrow.

Everything an agent or a remote peer sends is canonicalised, digested, and
stored durably. Canonicalising is recursive and hashing is linear, so unbounded
input is unbounded work in a process that other runs depend on, and unbounded
rows in a store that holds every run in the project. `maxJsonDepth` in particular
is not about size at all: it stops a deeply nested document exhausting the stack
in the canonicaliser.

So the limits that matter are the ones on a trust boundary — the worker, the CLI,
the HTTP surface, a remote peer. Everything else in this document is either
paging, an authoring-time check, or a value that has drifted out of proportion
with the thing it guards.

## What a real run actually used

From `run_fb73180e`, the example run that produced a working game:

| Thing | Largest actual | Limit | Used |
| --- | --- | --- | --- |
| Phase output | 3 627 B | 262 144 B | 1.4% |
| Command envelope | 33 731 B | 262 144 B | 12.9% |
| Workspace file written | 4 964 B | 1 048 576 B | 0.5% |
| Transcript line | 124 B | 4 096 B | 3.0% |
| Worker submission | 1 617 B | — | — |

Twelve of that run's forty-nine tool calls were refused. None of them was a size
limit. Six were a workspace path rule, five were argument or schema shape, and
one was a file that genuinely did not exist.

## What an agent feels

These are the bounds on what a working agent may send, read and write.

| Limit | Value | What it bounds |
| --- | --- | --- |
| `maxWireBytes` | 256 KiB | one whole command envelope |
| `maxStringLength` | 64 KiB | any single string in a command |
| `maxJsonNodes` | 10 000 | nodes in one document |
| `maxJsonDepth` | 32 | nesting depth |
| `maxOutputBytes` | 256 KiB | a published phase output |
| `maxOutputNodes` | 10 000 | nodes in a phase output |
| `maxOutputDepth` | 64 | nesting in a phase output |
| `maxSubmissionSummaryLength` | 8 KiB | a completion summary |
| `maxQuestionLength` | 16 KiB | a question to a person |
| `maxCompletionItems` | 256 | criteria or evidence entries |
| `maxAssetReadBytes` | 64 KiB | one read of an upstream asset |
| `maxFileBytes` | 1 MiB | one workspace file |
| `maxListEntries` | 1 000 | entries from one directory listing |
| `maxPatchChanges` | 1 | changes in one patch call |
| `maxAttempts` | 3 | tries at publishing an output |
| `maxReportedFindings` | 8 | findings handed back on a refusal |
| `MAX_PRIOR_REFUSALS` | 32 | refusals carried into a retry's context |
| `MAX_ANSWERED_QUESTIONS` | 32 | answers carried into a resumed dispatch |

Defined in [codec.ts](../../../../packages/protocol/src/codec.ts),
[worker-codec.ts](../../../../packages/protocol/src/worker-codec.ts),
[context-broker.ts](../../../../packages/runtime/src/context-broker.ts),
[workspace-files.ts](../../../../packages/execution-host/src/workspace-files.ts)
and [context.ts](../../../../packages/kernel/src/context.ts).

### The three that cost something

**`maxPatchChanges: 1`** is not a tuning knob. `applyPatch` accepts an array and
only ever reads `changes[0]`; the limit encodes what the implementation does.
Raising it means building all-or-nothing application across several changes,
which the native helper does per file and not across files. Today it costs an
agent one round trip per edit, which is the difference between one turn and five
when it is refactoring.

**`maxReportedFindings: 8`** truncates the feedback an agent needs to correct
itself. It compounds with a separate defect: the schema validator computes a
readable message for each finding and the worker drops it, keeping only pointers
and a keyword. So an agent can be told that eight of its twenty problems exist,
without being told what any of them are.

**`maxAssetReadBytes: 64 KiB`** caps one read of the agent's own upstream data.
The data was already bounded when it was written, so this is paging rather than
protection. It is defensible as a bound on a single response and indefensible as
a bound on what an agent can see.

## What a person feels

These are the bounds on what somebody types into the portal.

| Limit | Value | What it bounds |
| --- | --- | --- |
| `MAX_ANSWER_LENGTH` | 4 096 characters | an answer to an agent's question |
| `MAX_ANSWER_DRAFT_LENGTH` | 8 192 characters | an unsent draft held in the browser |
| `MAX_ANSWER_DRAFTS` | 8 | drafts kept at once |
| `MAX_REFUSAL_LENGTH` | 1 024 | a refusal shown back to a person |
| steering instruction | non-empty, otherwise uncapped | redirecting a working agent |
| override reason | non-empty, otherwise uncapped | accepting work an agent could not finish |

Two things are worth noticing here.

The answer field is the tightest thing a person touches, and it is the field they
use most. Four thousand characters is roughly two pages, which is enough for an
answer and not enough for a specification. The draft buffer is twice the size of
what can be submitted, so a restored draft can exceed what the authority will
take.

Steering an agent and overriding its work have no length bound of their own. They
are checked for being non-empty and then bounded only by the envelope, at 256
KiB. So the three things a person can say to a run are bounded sixty-four times
apart from each other, and the tightest is the ordinary one.

## What a workflow author feels

Checked once when a workflow compiles, never in the loop.

| Limit | Value | What it bounds |
| --- | --- | --- |
| `maxPromptBytes` | 32 KiB | one prompt file |
| `maxSchemaBytes` | 256 KiB | one schema file |
| `maxAggregateBytes` | 8 MiB | the whole configuration tree |
| `maxPromptResources` | 64 | prompt files in a tree |
| `maxSchemaResources` | 256 | schema files in a tree |
| `maxPromptPackBytes` | 64 KiB | the rendered prompt an agent receives |
| `maxSubstitutionBytes` | 16 KiB | one value substituted into a prompt |
| `maxAllSubstitutionsBytes` | 32 KiB | every substitution together |
| `MAX_PHASE_ATTEMPTS` | 20 | authored attempt ceiling for a phase |
| `MAX_SCHEMA_DEPTH` | 128 | nesting inside a schema |
| `MAX_SCHEMA_NODES` | 10 000 | nodes inside a schema |

Defined in [resources.ts](../../../../packages/configuration/src/resources.ts),
[prompt-template.ts](../../../../packages/configuration/src/prompt-template.ts),
[authoring.ts](../../../../packages/configuration/src/authoring.ts) and
[schema.ts](../../../../packages/configuration/src/schema.ts).

`maxPromptPackBytes` is the one that bites an author, because it bounds the
finished prompt rather than the file: a modest template with a large substituted
input can exceed it when neither part looks large.

## What the portal shows

Paging rather than protection. A page that returns everything is a page that
takes an unbounded time to render.

| Limit | Value |
| --- | --- |
| `maxGraphItems` | 200 |
| `maxDeliveryItems` | 256 |
| discovery, activity, artifacts, agents, workspaces, integrations, needs | 100 each |
| `maxArtifactPreviewBytes` | 64 KiB |
| `jsonViewerNodeBudget` | 500 |
| `maxRecordsPerPage` (transcript) | 200 |
| `maxRetainedLinesPerOwner` | 5 000 |
| `maxLineBytes` (transcript) | 4 KiB |

## What an operator feels

| Limit | Value | What it bounds |
| --- | --- | --- |
| `maxActiveProcesses` | 32 | sensor processes at once |
| `MAX_ACTIVE_WORKSPACES` | 32 | isolated workspaces at once |
| `maxObjectBytes` | 256 MiB | one stored asset |
| `defaultMaxObjects` | 10 000 | assets in a store |
| `defaultMaxTotalBytes` | 1 GiB | total asset bytes |
| `MAX_PORTAL_SESSION_LIFETIME_MS` | 8 hours | a portal session |
| `MAX_ACTIVE_PORTAL_SESSIONS` | 1 024 | sessions at once |
| `MAX_DURABLE_LOG_ENTRIES` | 10 000 | retained supervisor log entries |
| `maxResponseTimeoutMs` | 5 minutes | a remote call |

## What to change and what not to

**Leave the byte limits.** They sit at one to thirteen per cent of their ceiling
on a real run, and they are the only thing between a misbehaving agent and the
canonicaliser. Raising them buys nothing that is currently being asked for.

**Raise `maxReportedFindings`, and stop dropping the message.** This is the one
limit that actively prevents an agent from correcting itself, and it is cheap.

**Decide about `maxPatchChanges`.** It is real work rather than a constant, and
the cost it imposes is round trips rather than refusals.

**Make the person-facing bounds consistent.** An answer at 4 096 and a steering
instruction at 256 KiB is not a considered pair. Either the answer bound is too
tight or the steering one is missing.

**Do not treat the limits as the reason agents fail.** They are not. Six of the
twelve refusals in the measured run were a path convention stated nowhere the
model reads, and five were fields whose rules live in validators rather than in
the schemas the model is given.
