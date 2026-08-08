# Senawa CLI Reference

This file is generated from the registered Commander grammar. Run
`pnpm docs:cli` after changing CLI commands.

Beads is the default runtime. Use the global `--runtime file` option only for
development, tests, and the deterministic file-backed demo. Runtime selection
belongs to process composition and is not available through browser HTTP routes.

The current CLI intentionally omits `init`, `sensor run`, `task done`, and
`task abort`. Repository initialization does not yet have bundled scaffold
assets, individual sensor execution has no gate expectation contract, and task
completion has no authenticated subprocess command bridge. Per-task cancellation
also lacks coordination with a continuing driver; forced whole-run end does not
establish that narrower contract.

## Top-level grammar

```text
Usage: senawa [options] [command]

Drive bounded Senawa workflows

Options:
  --worker-host <host>          worker execution host (choices: "simulated",
                                "copilot-subprocess", "copilot-sdk", default:
                                "copilot-sdk")
  --caller <caller>             command caller attribution (choices:
                                "principal-agent")
  --runtime <runtime>           runtime backend (file is for development and
                                tests) (choices: "file", "beads", default:
                                "beads")
  -h, --help                    display help for command

Commands:
  doctor [options]
  model
  workflow
  sensor
  gate
  work
  phase
  task
  plan
  ask <question>
  questions [runId]
  answer <questionId> <answer>
  discover <title>
  note <note>
  browser [options] [runId]     Open the active run in the local Senawa browser
                                console
  approve [options] <phase>
  reject [options] <phase>
  steer <task> <instruction>
  help [command]                display help for command
```

## senawa doctor

```text
Usage: senawa doctor [options]

Options:
  --live      check selected live worker host, catalog, models, and capabilities
  -h, --help  display help for command
```

## senawa model

```text
Usage: senawa model [options] [command]

Options:
  -h, --help      display help for command

Commands:
  list
  help [command]  display help for command
```

## senawa model list

```text
Usage: senawa model list [options]

Options:
  -h, --help  display help for command
```

## senawa workflow

```text
Usage: senawa workflow [options] [command]

Options:
  -h, --help       display help for command

Commands:
  list
  info <name>
  render <name>
  validate [name]
  help [command]   display help for command
```

## senawa workflow list

```text
Usage: senawa workflow list [options]

Options:
  -h, --help  display help for command
```

## senawa workflow info

```text
Usage: senawa workflow info [options] <name>

Options:
  -h, --help  display help for command
```

## senawa workflow render

```text
Usage: senawa workflow render [options] <name>

Options:
  -h, --help  display help for command
```

## senawa workflow validate

```text
Usage: senawa workflow validate [options] [name]

Options:
  -h, --help  display help for command
```

## senawa sensor

```text
Usage: senawa sensor [options] [command]

Options:
  -h, --help      display help for command

Commands:
  list
  info <id>
  audit [runId]
  help [command]  display help for command
```

## senawa sensor list

```text
Usage: senawa sensor list [options]

Options:
  -h, --help  display help for command
```

## senawa sensor info

```text
Usage: senawa sensor info [options] <id>

Options:
  -h, --help  display help for command
```

## senawa sensor audit

```text
Usage: senawa sensor audit [options] [runId]

Options:
  -h, --help  display help for command
```

## senawa gate

```text
Usage: senawa gate [options] [command]

Options:
  -h, --help            display help for command

Commands:
  check [options] <id>
  help [command]        display help for command
```

## senawa gate check

```text
Usage: senawa gate check [options] <id>

Options:
  --phase <phase>
  --task <task>
  -h, --help       display help for command
```

## senawa work

```text
Usage: senawa work [options] [command]

Options:
  -h, --help              display help for command

Commands:
  start [options] <goal>
  resume
  pause
  finish
  show [runId]
  wait [options]
  end [options]
  report [runId]
  web [options] [runId]
  help [command]          display help for command
```

## senawa work start

```text
Usage: senawa work start [options] <goal>

Options:
  --workflow <name>
  -h, --help         display help for command
```

## senawa work resume

```text
Usage: senawa work resume [options]

Options:
  -h, --help  display help for command
```

## senawa work pause

```text
Usage: senawa work pause [options]

Options:
  -h, --help  display help for command
```

## senawa work finish

```text
Usage: senawa work finish [options]

Options:
  -h, --help  display help for command
```

## senawa work show

```text
Usage: senawa work show [options] [runId]

Options:
  -h, --help  display help for command
```

## senawa work wait

```text
Usage: senawa work wait [options]

Options:
  --timeout <seconds>  bounded wait in seconds (default: "30")
  -h, --help           display help for command
```

## senawa work end

```text
Usage: senawa work end [options]

Options:
  --reason <reason>
  --force                    cancel and reconcile an active worker before ending
  --grace-ms <milliseconds>  bounded cancellation grace period (default: "1000")
  -h, --help                 display help for command
```

## senawa work report

```text
Usage: senawa work report [options] [runId]

Options:
  -h, --help  display help for command
```

## senawa work web

```text
Usage: senawa work web [options] [runId]

Options:
  --port <port>  loopback port (default: "0")
  -h, --help     display help for command
```

## senawa phase

```text
Usage: senawa phase [options] [command]

Options:
  -h, --help               display help for command

Commands:
  show [options] <id>
  brief [options] <id>
  artifact [options] <id>
  help [command]           display help for command
```

## senawa phase show

```text
Usage: senawa phase show [options] <id>

Options:
  --run <runId>
  -h, --help     display help for command
```

## senawa phase brief

```text
Usage: senawa phase brief [options] <id>

Options:
  --run <runId>
  -h, --help     display help for command
```

## senawa phase artifact

```text
Usage: senawa phase artifact [options] <id>

Options:
  --run <runId>
  --version <version>
  -h, --help           display help for command
```

## senawa task

```text
Usage: senawa task [options] [command]

Options:
  -h, --help           display help for command

Commands:
  show [options] <id>
  help [command]       display help for command
```

## senawa task show

```text
Usage: senawa task show [options] <id>

Options:
  --run <runId>
  -h, --help     display help for command
```

## senawa plan

```text
Usage: senawa plan [options] [command]

Options:
  -h, --help        display help for command

Commands:
  revise [options]
  help [command]    display help for command
```

## senawa plan revise

```text
Usage: senawa plan revise [options]

Options:
  --add <file>
  -h, --help    display help for command
```

## senawa ask

```text
Usage: senawa ask [options] <question>

Options:
  -h, --help  display help for command
```

## senawa questions

```text
Usage: senawa questions [options] [runId]

Options:
  -h, --help  display help for command
```

## senawa answer

```text
Usage: senawa answer [options] <questionId> <answer>

Options:
  -h, --help  display help for command
```

## senawa discover

```text
Usage: senawa discover [options] <title>

Options:
  -h, --help  display help for command
```

## senawa note

```text
Usage: senawa note [options] <note>

Options:
  -h, --help  display help for command
```

## senawa browser

```text
Usage: senawa browser [options] [runId]

Open the active run in the local Senawa browser console

Options:
  --port <port>  loopback port (default: "0")
  --no-open      print a fresh bootstrap URL without opening it
  -h, --help     display help for command
```

## senawa approve

```text
Usage: senawa approve [options] <phase>

Options:
  --note <note>
  --expected-version <version>
  --expected-digest <digest>
  -h, --help                    display help for command
```

## senawa reject

```text
Usage: senawa reject [options] <phase>

Options:
  --reason <reason>
  --expected-version <version>
  --expected-digest <digest>
  -h, --help                    display help for command
```

## senawa steer

```text
Usage: senawa steer [options] <task> <instruction>

Options:
  -h, --help  display help for command
```
