---
name: factory-quality-testing
description: Use Harbor tasks, benchmarks, and graders for Factory quality evaluation.
---

# Factory Quality Testing

Use this when the user asks to quality-test Factory, run Harbor tasks, benchmark
orchestration, compare runs, or evaluate task quality.

Harbor is for repeated eval tasks with deterministic verifiers, not a replacement
for ordinary repo tests. The starter task is `harbor/tasks/factory-smoke`.

## Stress site: Bombsite

Bombsite is the approved Factory orchestration benchmark stress site. Two
representations exist:

- **Harbor task fixtures** — `harbor/tasks/bombsite-0{1..6}/` in this repo each
  carry a self-contained, token-filled doctor-portfolio fixture under
  `environment/` (Docker build context, explicit `COPY`). These are the
  deterministic, verifier-scored benchmark tasks.
- **Real repo** — `/Users/slammtechnologies/Documents/GitHub/bombsite` is the
  filled-in, real doctor-portfolio project (Dr. Kwame Boateng, Family Medicine,
  M.D. University of Ghana Medical School, Board Certified Family Medicine, 12
  years) with `index.html`, `script.js`, `.factory/config.yaml`
  (`lint`/`test`), `factory.yaml` (discover → interview → plan → build → verify
  → review → approval), and `tests/verify-page.mjs`. Use it when a live,
  human-driven Factory run against real content is wanted. Verify it with
  `node --check script.js && node tests/verify-page.mjs`.

## The approved orchestration benchmark

Use Harbor plus scripted interviews, Oracle-vs-agent separation, and the
six-pillar scorer. Benchmark runs preserve artifacts so discovery, planning,
implementation, repair, verification, approval, landing, and scoring can be
inspected.

Prerequisites: Harbor CLI, Docker daemon, Pi credentials on the host at
`~/.pi/agent/auth.json`, a reachable model, and a built Factory dist
(`npm run build`).

### Sanity-check a task (Oracle, no model spend)

```bash
harbor run -p harbor/tasks/bombsite-01-ui-shell -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

### Real agent trial (spends model tokens)

```bash
PYTHONPATH=harbor/agents harbor run -p harbor/tasks/bombsite-01-ui-shell \
  --agent factory_pi:FactoryPiAgent \
  -m openai-codex/gpt-5.4-mini \
  --ak interview_answers_path=harbor/tasks/bombsite-01-ui-shell/interview.json
```

Flow per trial: build container → install Pi + Factory → inject creds +
scripted interview answers (at `/task/interview.json`) → run the Gate 1 headless
harness → verifier scores the workspace → `.factory/runs/<id>/` is collected as
a Harbor artifact.

### Score a collected run

Run dirs land under `harbor/jobs/<timestamp>/<task>__<id>/artifacts/factory-runs/<run-id>/`.
Score one directly with `scoreFactoryRun(runDir, taskSpec)` from
`packages/core/dist/index.js`; repeat trials aggregate with
`summarizeBenchmarkResults()` (Oracle trials are excluded from statistics by
design).

## Verifier discrimination is required

A verifier that only ever returns 1.0 validates nothing. `tests/benchmark-pack.test.mjs`
pins this per task: reference solution → `task_success: 1`, untouched fixture →
`task_success: 0`, and a known shortcut (e.g. CSS on bombsite-01) → `task_success: 0`.

## Scoring model

`scoreFactoryRun(runDir, taskSpec)` is pure, read-only, deterministic given
inputs; never writes, never mutates git, never invents a metric it cannot
derive — it emits `warnings[]` instead. Weights live in the task spec, not
hard-coded. Six pillars:

| Pillar | Default weight | Derived from |
| --- | --- | --- |
| `interviewQuality` | 18 | `interview-decisions.json`, `decisions.jsonl`, `*-interview-execution.json`, workflow spec |
| `handoffQuality` | 20 | `guidance.context_selected`, `plan.json` (+`implementationContract`), `task.context_compiled`, event ordering |
| `executionQuality` | 15 | `summary.json`, `verification.json`, `repair-execution-*.json`, reviewer output |
| `mergeQuality` | 12 | `landing-plan.json` (`guardVerdict`), `landing-diagnosis-<n>.json`, `landing-attempts.jsonl`, `final-merge.json`, `completed-tasks.json` |
| `adaptationQuality` | 12 | `verification.json`: `cwd`, `cwdResolution`, `selectionSource`, `evidence.selectedCandidate`, `commandDecisions`, `failureClassification` |
| `scopeQuality` | 8 | `completed-tasks.json` changed files vs spec `expectedFiles`, contract `nonGoals` |
| `timeEfficiency` | 10 | `events.jsonl` timestamps, decision wait separated from agent time |

## Local verifier discrimination tests

```bash
node --test tests/benchmark-pack.test.mjs
```

## Decision

Use normal repo tests for implementation correctness, and Harbor/benchmark tasks
for repeated behavior evaluation.
