# pi-factory

Pi-native Factory with project-authoritative configuration, deterministic runtime control, Pi-backed agents, and a fact-first constitution pipeline.

## Current capabilities

- project-authoritative config loading and precedence merge
- project discovery and setup scaffolding
- Pi `/factory` command surface
- deterministic run state, event, and artifact persistence
- plan-first runtime flow with human `plan-approval` before implementation
- final approval gate before merge
- planner / builder / repair / reviewer executor hooks
- fake and real Pi SDK executor harnesses
- worktree-aware execution and per-task isolation
- verification, repair, review, resume, cancel, cleanup
- constitution fact scan + AI interpretation pipeline
- no-change constitution reuse
- targeted vs full constitution refresh strategy
- latest run plan inspection via `/factory plan`
- runtime and constitution regression tests

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

A project-local Pi extension exists at:

- `.pi/extensions/factory/index.ts`

Current commands:

- `/factory`
- `/factory setup`
- `/factory setup --force`
- `/factory status [run-id]`
- `/factory doctor`
- `/factory logs [run-id]`
- `/factory list`
- `/factory show <run-id>`
- `/factory plan`
- `/factory resume`
- `/factory cancel`
- `/factory worktree <branch>`
- `/factory cleanup [retain-count]`
- `/factory constitution`
- `/factory <goal>`

## Runtime flow

Factory goal runs now follow a plan-first flow:

```text
Goal
→ planning
→ plan-approval
→ implementation
→ integration
→ verification
→ review
→ approval-ready
→ merge
→ complete
```

Key behavior:

- planner produces a bounded architecture/implementation plan
- human plan approval happens before implementation starts
- plan approval supports `approve`, `reject`, or `revise`
- final approval still happens later before merge
- verification commands run from project config when present
- repair/reviewer phases are optional and executor-backed
- worktrees are used when allowed; otherwise execution falls back safely

## Artifacts

Each run writes deterministic artifacts under `.factory/runs/<run-id>/`, including:

- `state.json`
- `events.jsonl`
- `effective-config.json`
- `plan.json`
- `tasks/*.json`
- `verification.json`
- `summary.json`
- `planner-execution.json`
- `builder-execution-*.json`
- `repair-execution-*.json`
- `reviewer-execution.json`
- `integration.json`
- `final-merge.json`

## Constitution pipeline

Constitution generation now uses a single public pipeline:

```text
repository facts → AI interpretation → CONSTITUTION.md
```

Behavior:

- facts are always scanned first
- finalized constitutions require AI interpretation
- no-change refresh reuses a prior finalized constitution
- small non-structural changes use targeted interpretation
- structural changes use full interpretation
- failed refresh preserves the last finalized constitution
- fact output is written to `.factory/constitution/facts.json`

## SDK / harness notes

- fake harness path: `npm run harness:pi-runtime`
- real SDK harness path: `FACTORY_PI_USE_REAL_SDK=1 npm run harness:pi-runtime`
- optional SDK package override: `FACTORY_PI_SDK_PACKAGE`

Planner-only real SDK smoke tests are currently healthy; full real-SDK end-to-end runtime validation is still an active area for further tuning.
