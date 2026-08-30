# Running the Factory Benchmark

Operations guide for the Harbor-based Factory orchestration benchmark
(design: [bombsite-benchmark-plan.md](bombsite-benchmark-plan.md)). This is the
"how do I actually run it" sheet — prerequisites, the three commands that
matter, and what the artifacts should look like.

## What it measures

Whether Factory orchestrates well, not just whether it finishes: interview
rounds, handoff of answers into plan/build, verification adaptation, scope
discipline, and landing. One run's artifacts are scored by
`scoreFactoryRun()` into a weighted 7-pillar report, and repeated agent trials
aggregate via `summarizeBenchmarkResults()` (Oracle trials are excluded from
statistics by design).

## Prerequisites

- **Harbor CLI** (`harbor --version` ≈ 0.22) — the eval harness.
- **Docker daemon up** (`docker info`) — Harbor runs each trial in a container.
- **Pi credentials on the host** at `~/.pi/agent/auth.json`. The agent reads
  this file directly. `openai-codex` needs a valid OAuth token; `commandcode`
  needs an API key. The container's Pi config is trimmed to exactly what the
  run needs — the host's own settings.json (which lists pi-goal-list-loop-audit)
  is never copied in, so the orchestrator cannot contaminate a measured run.
- **A reachable model** the provider exposes (`pi --list-models` shows them).
- **Built Factory dist**: `npm run build` before any agent trial.

## The three commands

### 1. Sanity-check the task (Oracle, no model spend)

```bash
harbor run -p harbor/tasks/bombsite-01-ui-shell -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

The Oracle runs `solution/solve.sh` (a real reference implementation) and the
verifier must return `task_success: 1`. This proves the task is solvable and
the verifier recognizes a correct solution. It never enters benchmark
statistics.

### 2. Real agent trial (spends model tokens)

```bash
PYTHONPATH=harbor/agents harbor run -p harbor/tasks/bombsite-01-ui-shell \
  --agent factory_pi:FactoryPiAgent \
  -m openai-codex/gpt-5.4-mini \
  --ak interview_answers_path=harbor/tasks/bombsite-01-ui-shell/interview.json
```

Any `provider/model` Pi exposes works; `commandcode/deepseek/deepseek-v4-flash`
is a cheap alternative. Flow per trial: build container → install Pi + Factory
→ inject creds + scripted interview answers (at `/task/interview.json`, outside
`/app`) → run the Gate 1 headless harness → verifier scores the workspace →
`.factory/runs/<id>/` is collected as a Harbor artifact.

Expect 4–8 minutes per trial on 2 CPUs. Repeat with `-k N` for an attempt
distribution.

### 3. Score a collected run

The run dir lands under
`harbor/jobs/<timestamp>/bombsite-01-ui-shell__<id>/artifacts/factory-runs/<run-id>/`.
Score it directly:

```bash
node -e "const m=require('./packages/core/dist/index.js');
  m.scoreFactoryRun('<run-dir>', {id:'bombsite-01-ui-shell',goal:'...',interviewRequired:true,expectedFiles:['index.html','script.js']})
  .then(r=>console.log(JSON.stringify(r.scores,null,1)))"
```

`task_success` comes from the verifier's `reward.json`; the pillar report comes
from `scoreFactoryRun`.

## Sanity thresholds (from the passing run)

A correct agent trial produces:

- `reward.json` → `{"task_success":1}`
- run dir with all of `state.json summary.json plan.json verification.json
  interview-decisions.json final-merge.json completed-tasks.json`
- `final-merge.json` → `status: "landed"`
- `verification.json` → `overallStatus: "passed"`
- `scoreFactoryRun` overall ≈ 0.9+ (the reference trial scored 0.965)

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `ModelProviderResolutionError: "opus" has no provider` | fixture `.factory/config.yaml` has no `models:` block; verification reads `config.models.planner` directly | re-run — the harness now injects `models:` via `writeRoleModelsConfig` when `FACTORY_PI_MODEL` is set |
| `Configured model ... could not be resolved by the Pi SDK` | SDK path used a bare `ModelRuntime.create()` (built-in providers only) | use the built dist after `da477c2` (session-services fix) |
| `Version '22' not found` during install | transient nvm/network failure | re-run; Harbor's Pi install is idempotent |
| trial exits nonzero at setup | `super().install()` bootstrap hiccup | re-run; check `agent/setup/` logs |
| `task_success: 0` but checks mostly pass | agent broke a specific check | read `/logs/verifier/metrics.json` for the failed-check list |

## What is NOT set up yet

- All five task families exist and are oracle-validated: `bombsite-01-ui-shell`
  (tabbed phone page), `bombsite-02-status-surface` (interview decides an
  Availability surface), `bombsite-03-verification-adaptation` (stale lint
  command), `bombsite-04-baseline-debt` (unrelated broken JS, scope
  preservation), `bombsite-05-repair-verification` (seeded failing check,
  repair path).
- No `-k N` attempt distributions or `summarizeBenchmarkResults` runs yet.
- `harbor check` (LLM-judge rubric lint) needs model credentials and is not
  part of the gate.
- Real spend is required for agent trials; there is no offline fake-agent mode
  that produces scoreable artifacts (the fake session factory cannot run a real
  workflow).
