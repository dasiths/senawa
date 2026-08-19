# Getting started with Senawa

This journey takes you from an empty directory to a running local supervisor, a
validated workflow tree, an open portal, a durable command receipt, and a clean
shutdown. Every step runs on your machine and spends no model credits.

## What you need

Senawa supports Linux x64 with glibc 2.34 or newer and Node.js 22.12.0 or
newer. The published `senawa` package declares that platform, and installation
never compiles native code.

Building from this repository additionally needs pnpm 10.34.5 and a C17 compiler
available as `cc`, because the build produces the `senawa-process-supervisor`
and `senawa-workspace-files` helpers. See
[Troubleshooting and limits](troubleshooting.md) for the full platform matrix.

## Install

Two installation paths exist. Both give you the same `senawa` executable.

Build from the repository when you want the sources and tests alongside the
executable:

```bash
pnpm install
pnpm build
node apps/senawa/dist/main.js --version
```

The repository does not link a `senawa` binary onto your `PATH`. Invoke
`node apps/senawa/dist/main.js` directly, or create your own alias.

Build and install the deterministic local bundle when you want an installed
package that resolves no workspace paths:

```bash
pnpm package:release
cp -r dist/release /tmp/senawa-install
cd /tmp/senawa-install
npm install --no-audit --no-fund
export PATH="$PWD/node_modules/.bin:$PATH"
senawa --version
```

`dist/release` contains the public `senawa` package plus exact local tarballs for
its internal workspace dependencies. It is a local verification bundle, not a
registry publication. The rest of this guide writes `senawa` for the executable.

## Create the workflow tree

Move to the project you want Senawa to work in and create the standard delivery
workflow tree:

```bash
senawa init
```

Success prints the created directory:

```text
.senawa: created
```

Init refuses to touch an existing `.senawa` filesystem object. Running it twice
prints `.senawa: already exists` and exits with code `1` while leaving every
existing byte unchanged.

### What init generates

Init publishes one `.senawa` directory with mode `0700` directories and mode
`0600` files:

```text
.senawa/
  workflow.yaml
  agents.yaml
  sensors.yaml
  prompts/planner.md
  prompts/implementor.md
  schemas/request.schema.json
  schemas/plan.schema.json
  schemas/implementation.schema.json
```

Three files describe the workflow. `workflow.yaml` names the phases and what
each produces, `agents.yaml` names who does the work, and `sensors.yaml` names
the commands that measure it. The prompts and schemas they reference are
ordinary files beside them. [Workflow authoring](workflow-authoring.md) explains
each one.

The generated workflow plans and then implements, with a gate on the implement
phase that refuses while the working tree is dirty. It is small on purpose: a
working example you change rather than a template you delete.

Init creates a private lock directory and a staging directory beneath the
project root, writes and syncs every file, renames the complete staged tree into
place, and syncs the project root. A concurrent second invocation loses the lock
rather than publishing a partial tree.

To target a different existing project directory, pass it as the only argument:

```bash
mkdir explicit
senawa init explicit
```

## Validate the configuration

```bash
senawa doctor
```

A valid tree prints the path it validated:

```text
./.senawa: valid
```

Doctor compiles the complete immutable snapshot. It reads every declared prompt
and schema through a confined reader that refuses symbolic links, checks the
mappings between phases, the gate rules, the roles, and the model routes, and
reports every problem at once. It never runs a sensor, calls a model, starts
work, or contacts a runner, so it is always free to run.

An invalid tree exits with code `1` and gives one diagnostic per line: a stable
code, the file, and where in it. Misspelling one schema path produces exactly
this:

```text
./.senawa: invalid (1 diagnostic)
- [resource-read-failed] .senawa/workflow.yaml#/schemas/1/path: schema resource could not be read (not-found)
```

Doctor reads `.senawa` relative to the current directory. Passing a directory
reads that directory's `.senawa` instead.

## Start a run

Write what you want done, then start the run.

```bash
echo '{"request": "Add a health endpoint"}' > request.json
senawa start request.json
```

`start` compiles the workflow, creates the run, dispatches the first phase, and
then drives the run until it needs something it cannot supply:

```text
run: run_9f2c1a...
repository: repository_myproject
phase: plan
dispatch: dispatch_5b4511...
waiting for the agent working on plan
```

That last line is the honest answer: the phase is dispatched and no agent has
finished it. Nothing is stuck, and nothing has been claimed that did not happen.

Pass `--detach` to return as soon as the first phase is dispatched rather than
driving the run.

To drive an existing run:

```bash
senawa advance repository_myproject run_9f2c1a
```

Both stop and say what they are waiting for. A gate refusal exits non-zero;
waiting for an agent or a person does not, because neither is a failure.

## Start the local supervisor

The supervisor owns the SQLite authority, the command queue, the fenced runner,
and every local listener. Start it as a detached process:

```bash
senawa service start
```

```text
Supervisor started (pid 622208)
```

Start writes no credential on the command line, redirects daemon output to a
private `service.log`, and waits for an authenticated status response before it
returns. Use `senawa service run` instead when you want to keep the service in
the foreground of your own shell.

Runtime files live under `$XDG_RUNTIME_DIR/senawa` and durable state under
`$XDG_STATE_HOME/senawa`. Platform-safe per-user defaults apply when either
variable is absent. [Operations](operations.md) lists every path.

Enable the browser portal by exporting a loopback port before you start the
service. Port `0` selects an ephemeral port:

```bash
export SENAWA_PORTAL_PORT=0
senawa service start
```

Without `SENAWA_PORTAL_PORT`, the service runs with local IPC only and
`senawa portal` reports that the loopback listener is not enabled.

## Read the service status

```bash
senawa service status
```

The response is canonical JSON:

```text
{"health":"degraded","leases":[],"lifecycle":"running","listeners":[{"address":"/run/user/1000/senawa/supervisor.sock","kind":"ipc"},{"address":"http://127.0.0.1:44775","kind":"loopback"}],"mode":"running","pending":{"amendmentProposalOutbox":0,"approvedAmendments":0,"claimedCommands":0,"completionOutbox":0,"queuedCommands":0,"runnerEffects":0,"wakes":0},"processId":622208,"remoteConnectors":[],"sdkSessionStore":{"expectedSessionCount":0,"message":"SENAWA_REPOSITORY_DIR is not configured; worker dispatch is disabled","missingSessionIds":[],"status":"degraded"},"startedAt":"2026-08-16T11:42:34.975Z"}
```

`"health":"degraded"` is expected on this journey. Health is degraded whenever
`SENAWA_REPOSITORY_DIR` is unset, because no agent worker can be dispatched.
Command admission, queries, projections, and the portal all remain available.
Configuring a repository worker is the point where model credits start to apply,
so this guide leaves it unset.

## Open the portal

```bash
senawa portal
```

```text
http://127.0.0.1:44775/portal/bootstrap?token=imdOYE6TxlrLo-V-zfbPD99yQPAk6sFgwfbY2km2fGQ
```

Open that URL in a browser on the same host. The bootstrap capability is
single-use, expires within 60 seconds, and redirects to `/portal/` while setting
a host-only session cookie. Reloading a consumed bootstrap URL returns HTTP 401
with `Portal bootstrap is invalid`, so navigate inside the console instead of
reloading it. Run `senawa portal` again whenever you need another session.

[Portal](portal.md) explains the run console, the workflow diagram, the agent
output view, and the human decision surfaces.

## Submit a command

Workflow authority moves through commands. A command file is one
attribution-free protocol submission. The service derives principal, transport,
request identity, current time, and allocation facts; a client cannot supply
them.

Command files must be canonical JSON: object members sorted, no insignificant
whitespace, no duplicate keys, and no trailing newline. The file is capped at
256 KiB before parsing.

Write this exact submission, which asks to pause a run that was never
instantiated:

```bash
printf '%s' '{"apiVersion":"senawa.dev/protocol/v1","commandId":"command_getting-started-pause","intent":{"type":"pause-run"},"payload":{},"payloadDigest":"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a","repositoryId":"repository_example","runId":"run_example"}' > pause.json
senawa command submit pause.json
```

`payloadDigest` is the SHA-256 digest of the canonical payload bytes. For the
empty object `{}` that digest is the value shown above.

Submission returns the durable location and the first receipt:

```text
{"location":{"commandId":"command_getting-started-pause","repositoryId":"repository_example","runId":"run_example"},"receipt":{"commandId":"command_getting-started-pause","recordedAt":"2026-08-16T11:44:18.258Z","repositoryId":"repository_example","runId":"run_example","sequence":1,"status":"queued"}}
```

Submitting the identical file again reuses the same durable command identity
instead of creating a second command. Use `-` in place of the path to read the
submission from standard input.

## Read receipts and events

```bash
senawa receipt get command_getting-started-pause
```

The receipt reaches a terminal status and carries the exact refusal:

```text
{"commandId":"command_getting-started-pause","recordedAt":"2026-08-16T11:44:18.258Z","repositoryId":"repository_example","runId":"run_example","sequence":3,"status":"terminal","terminalReceipt":{"apiVersion":"senawa.dev/protocol/v1","commandId":"command_getting-started-pause","cursor":3,"error":{"apiVersion":"senawa.dev/protocol/v1","code":"run-control-unavailable","commandId":"command_getting-started-pause","message":"Run control is not initialized","retryable":false},"repositoryId":"repository_example","runId":"run_example","status":"refused"}}
```

A refusal is a first-class durable outcome, not an error to retry blindly. The
run had no control state, so the kernel refused and said exactly why.

Every transition is also an immutable event on the run's monotonic cursor:

```bash
senawa event list repository_example run_example
```

The run now holds three events at cursors `1`, `2`, and `3`: `command-queued`,
`command-claimed`, and `command-refused`. Pass optional `after` and `limit`
arguments to page:

```bash
senawa event list repository_example run_example 1 10
senawa receipt list repository_example run_example
senawa projection get repository_example run_example
```

Projections are derived views rebuilt from durable records. They are never the
authority. See [Authority model](../design/authority-model.md) for why.

### Instantiating a real run

An `instantiate-run` command carries the compiled workflow graph, the
configuration snapshot digest, the execution policy, the first phase, the
approval policy, and the escalation and allowance policies. Senawa ships no
command that composes that payload for you, and no CLI flag registers a
configuration snapshot. Driving a complete delivery run therefore requires a
composition that compiles the configuration and submits the instantiation
through the same authenticated local API, which is how the acceptance suites
drive it.

## Shut down

Drain first so the service stops claiming new work and dispatching effects, then
stop it:

```bash
senawa service drain
senawa service stop
```

```text
Supervisor drain accepted
Supervisor stop accepted
```

Stop drains, closes listeners, and closes authorities. Durable state survives in
`$XDG_STATE_HOME/senawa`, so a later `senawa service start` finds the same
receipts, events, and projections.

## Where to go next

* [Workflow authoring](workflow-authoring.md) to change what the workflow does.
* [Portal](portal.md) to drive questions, approvals, allowances, and run control
  from the browser.
* [Operations](operations.md) for backup, restore, integrity, diagnostics, logs,
  and recovery.
* [Security](security.md) for the trust boundaries this journey relied on.
* [CLI reference](../reference/cli.md) for the complete command surface.
