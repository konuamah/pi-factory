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
`/factory logs` shows the latest run state, event tail, and artifact paths.
`/factory resume` marks the latest interrupted run as resumed and records a resume event.
`/factory cancel` marks the latest run cancelled and records a cancellation event.
