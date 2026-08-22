# pi-factory

Initial scaffold for a Pi-native Factory with project-authoritative configuration.

## Current focus

- config schemas
- config precedence merge
- project discovery
- effective config loading
- project setup scaffolding
- Pi `/factory` command skeleton
- doctor and latest-run status inspection
- minimal run state and event persistence
- prototype `/factory <goal>` run flow
- incremental run controller progress updates
- prototype approval checkpoint
- plan and verification artifact generation
- `/factory logs` latest run inspection
- `/factory resume` latest run recovery marker
- `/factory cancel` latest run cancellation
- real verification command execution
- structured planner artifact generation
- per-task artifact generation
- task artifact state transitions during implementation
- run summary artifact generation
- summary-aware `/factory status`
- `/factory status <run-id>` historical inspection
- `/factory list` run enumeration
- `/factory logs <run-id>` historical event inspection
- `/factory show <run-id>` merged run view
- run-id autocomplete for historical commands
- PiAgentExecutor skeleton with injectable and optional Pi SDK session factory
- fake Pi session factory and local executor harness
- optional AgentExecutor-wired planning path
- end-to-end fake Pi runtime harness
- opt-in real Pi SDK runtime harness mode
- repair loop using executor abstraction
- repair-aware logs/show output

## Precedence

```text
built-ins < global defaults < project config < run overrides
```

## Config files

Project files are intended to be YAML:

- `factory.yaml`
- `.factory/config.yaml`
- `CONSTITUTION.md`

The loader accepts JSON or YAML content.

## Pi adapter

A project-local Pi extension now exists at:

- `.pi/extensions/factory/index.ts`

Current commands:

- `/factory`
- `/factory setup`
- `/factory setup --force`
- `/factory status`
- `/factory doctor`
- `/factory logs`
- `/factory resume`
- `/factory cancel`
- `/factory <goal>`

## Setup scaffolding

Core now includes an initializer that can create:

- `CONSTITUTION.md`
- `factory.yaml`
- `.factory/config.yaml`
- `.factory/runs/`

Setup now also writes an initial run record with:

- `state.json`
- `events.jsonl`
- `effective-config.json`

Prototype goal runs now create a minimal end-to-end run record and phase transitions.
The Pi widget is updated incrementally as fake phases advance.
Prototype runs now pause for a human approval decision before completion.
They also write `plan.json` and `verification.json` artifacts into the run directory.
`plan.json` is now generated from workflow/config structure instead of a fixed fake task list.
Per-task JSON artifacts are now written under `.factory/runs/<run-id>/tasks/`.
Implementation now updates task artifacts from `pending` to `running` to `done` as the prototype advances.
Each run now also writes `summary.json` with final outcome and key artifact paths.
`/factory status` now surfaces summary-derived task count, verification result, goal, and approval state.
`/factory status <run-id>` can inspect a historical run directly.
`/factory list` enumerates known run ids with status, phase, goal, and updated time.
`/factory logs <run-id>` can inspect the event tail and artifact paths for a historical run.
`/factory show <run-id>` presents a compact merged summary of state, summary, plan, and verification.
Run-id autocomplete is now provided for `status`, `logs`, and `show`.
A PiAgentExecutor skeleton now exists, with an injected session-factory boundary ready for Pi SDK wiring.
An optional `createPiSdkSessionFactory()` adapter now loads the Pi SDK dynamically at runtime and wraps `createAgentSession()` when the package is installed.
A fake session factory and `harness:pi-executor` script now make it easy to validate executor event capture, output accumulation, and failure/cancel semantics locally.
The runtime controller now also supports optional `plannerExecutor` and `repairExecutor` hooks, writing `planner-execution.json` and `repair-execution-<n>.json` artifacts when supplied.
An end-to-end `harness:pi-runtime` demo now drives the Factory runtime through fake Pi-backed planner/repair executors.
`/factory logs` and `/factory show <run-id>` now surface repair execution counts/details.
Set `FACTORY_PI_USE_REAL_SDK=1` to make that harness try the real Pi SDK session factory instead, with `FACTORY_PI_SDK_PACKAGE` optionally overriding the package name.
`verification.json` now captures real configured command execution results for lint/typecheck/test/build when present.
`/factory logs` shows the latest run state, event tail, and artifact paths.
`/factory resume` marks the latest interrupted run as resumed and records a resume event.
`/factory cancel` marks the latest run cancelled and records a cancellation event.
