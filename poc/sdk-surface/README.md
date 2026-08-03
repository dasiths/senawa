# SDK Surface Probe

## Goal

Hosting worker sessions through `@github/copilot-sdk` turns process
orchestration into function calls, but only if the control points the design
depends on actually exist and behave predictably together. This probe reads the
shipped type declarations rather than the README, then exercises a live session.

## What it proves

The SDK hook surface is narrower than the CLI's. Present: `onPreToolUse`,
`onPreMcpToolCall`, `onPostToolUse`, `onPostToolUseFailure`,
`onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, and
`onErrorOccurred`. Absent: `onSubagentStart`, `onSubagentStop`, `onAgentStop`,
`onPreCompact`, and `onNotification`.

That absence is load bearing. The "block until green" pattern does not exist
when hosting through the SDK, so the orchestrator must drive the rework loop
explicitly with its own attempt budget rather than relying on a runtime cap.

Typed tools and resumption work exactly as designed. `defineTool` exposed a
completion tool that always refuses; the agent called it, received the structured
refusal, and reported it, which means workers never need shell access to reach
the harness. `resumeSession` restored the earlier conversation.

The composition trap is the important result. With a permission handler that
always rejects shell commands:

| `onPreToolUse` returns             | Permission handler calls | Command ran |
|------------------------------------|--------------------------|-------------|
| `{ permissionDecision: "allow" }`  | 0                        | yes         |
| `{}`                               | 1                        | no          |
| not registered                     | 1                        | no          |

A hook that returns `allow` short-circuits the permission service entirely, so
the strong control is silently disabled by the fast one. The rule that follows is
absolute: a senawa hook returns `{}` or a denial, never `allow`.

When the handler does run, its `feedback` string reaches the model intact, which
is the actionable backpressure the design wants.

## What it does not prove

* Behaviour at SDK versions above the one this container's mirror serves
* Whether an inferential reviewer reliably calls a schema-backed submission tool,
  which the sensors probe covers with a fake host only

## Layout

| Path             | Role                                                             |
|------------------|-------------------------------------------------------------------|
| `probe.mjs`      | Hook surface from the type declarations, then a live session with a typed tool, a rejecting permission handler, and a resume |
| `precedence.mjs` | The same shell request three ways, counting handler invocations   |

## Running

```bash
bash poc/sdk-surface/run.sh          # spends AI credits
node poc/sdk-surface/precedence.mjs  # spends AI credits
```

## Change log

| Date       | Change                                                                                                                          |
|------------|-----------------------------------------------------------------------------------------------------------------------------------|
| 2026-07-28 | First run. Confirmed the absent subagent and agent stop hooks, confirmed `defineTool` and `resumeSession`, and found that returning `allow` from `onPreToolUse` silences the permission handler. |
| 2026-08-02 | Renamed from `07-sdk-surface` during probe consolidation. No behavioural change.                                                |
