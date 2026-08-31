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

## Performance (where the time goes)

Every trial is reduced to four buckets — **HARNESS / AGENT / EVAL** (plus MODEL
and TOOLS inside AGENT) — via `computePerformanceReport()`
(`packages/core/src/benchmark/performance.ts`), fed from Harbor's
`result.json` phases plus the collected run's SDK event stream:

```text
TOTAL
├── HARNESS          environment_setup + agent_setup (container + Pi/Factory start)
├── AGENT            Harbor agent_execution
│   ├── MODEL        assistant message_start→end windows (LLM time, its own bucket)
│   ├── TOOLS        union of tool_execution_start→end intervals (parallel-aware)
│   ├── FACTORY VERIFY  the run's own verification phase
│   └── AGENT_OTHER  remainder (orchestration, thinking gaps)
└── HARBOR VERIFIER  scoring
```

Two rules make the numbers meaningful:

- **MODEL measures assistant messages only** — tool-result messages have their
  own lifecycle and would inflate the model bucket.
- **TOOLS is the union of tool intervals, not the sum** — Pi runs tools in
  parallel by default, so summing would double-count overlapping work.
  `toolExecutionSumMs` is still reported separately as the tool *workload*.

`modelCallCount` / `toolCallCount` distinguish slow calls from churn: MODEL 60s
over 4 calls means a slow provider; over 24 calls means the agent is churning.

Across runs, `summarizeBenchmarkResults()` returns timing medians
(`medianModelMs`, `medianToolsMs`, `medianHarnessMs`, `medianTotalMs`, p90,
harness fraction). Oracle trials are excluded. Missing data is `null` + a
warning, never zero, and an accounting check warns if `AGENT_OTHER` would go
negative (overlapping intervals).

The event timestamps (`at`) that power MODEL/TOOLS are stamped by the executor
collector (`captureEvent`), so artifacts from runs before that change carry no
`at` and report `null` with a warning — a fresh agent trial is needed for the
full split.

### Real measured numbers (2026-08-31 trial, gpt-5.4-mini)

```text
TOTAL                  353.9s
  HARNESS               88.7s   25.1%   <- container + Pi/Factory install
  AGENT                257.8s
    MODEL               97.2s   27.5%   8 calls
    FACTORY VERIFY       6.2s    1.8%
    TOOLS OBSERVED       0.0s    0.0%   11 calls (22 events: 20 read, 2 ls)
    UNATTRIBUTED       154.4s   43.6%   <- includes unmeasured tool wall-time
  HARBOR VERIFIER        1.9s    0.5%
```

Reading the numbers honestly — do not over-claim:

- **HARNESS is the easiest major bottleneck to fix.** Prebuilding the
  environment image (Harbor `--install-only` / prebuilt env image) could
  remove most of that ~89s without touching agent behavior — roughly a 22%
  end-to-end improvement (354s → ~275s) from infrastructure alone.
- **MODEL is the largest clearly measured runtime bucket** (97.2s, 27.5%, 8
  calls — slow provider responses, not churn).
- **UNATTRIBUTED (154.4s, 43.6%) is the biggest bucket overall but cannot be
  explained precisely.** It includes real tool execution time plus Pi/Factory
  orchestration. Pi's current tool events are boundary markers, not duration
  brackets (verified: end-start ≈ 0, 22 events, 0 DSML bridge), so tool
  wall-time lands here. Labeled `unattributedAgentMs` in the report, with the
  note that it includes unmeasured tool wall-time — never presented as normal
  orchestration overhead.

Conclusion: **we proved harness startup and model latency are major costs, and
another ~154s inside agent execution remains unbroken-down because Pi does not
expose useful tool wall-clock duration.** That is a stronger claim than naming
harness+model as the whole story.

### Next optimization experiment

Prebuild the Harbor image, then compare the same task ≥3 runs before/after:

```text
            median HARNESS   median TOTAL
before      ~89s             ~354s
after       ~10s             ~275s   (hypothetical)
```

Never compare single runs — network/provider variation makes one run noisy.
After that, investigate what `UNATTRIBUTED` really is.

## LLM judge (optional quality judgment)

The deterministic 7-pillar scorer measures mechanical signals — topic coverage,
round counts, scope. It cannot judge quality ("was that a good question?"). The
LLM judge (`packages/core/src/benchmark/judge.ts`) is an optional additive
signal: `scoreFactoryRun(runDir, spec, { judge: { executor, model, rubric } })`
runs a strict-JSON prompt over the run's artifacts and returns per-pillar
judge scores + one-line reasoning in `report.judge`.

Rules:

- **Never merges into the deterministic pillars** — the judge score is a
  separate, reported field. Deterministic stays primary.
- **Silent fallback**: if no executor is supplied, or the executor fails, or
  the output is not parseable JSON, the judge returns `undefined` and the
  deterministic score stands alone. No fabricated scores.
- **Judge scores vary run to run** (LLM), so treat them as a distribution
  across `-k N` runs, like the quality score.
- **Enable it in the headless run**: set `FACTORY_PI_JUDGE=1` (plus
  `FACTORY_PI_JUDGE_RUBRIC` for a custom rubric) on the harness invocation.
  After the run completes it scores the collected artifacts with the same
  executor + model and writes `judge.json` next to the run dir. Runs inside
  the harness where the SDK config is injected — a bare standalone session
  returns empty output without that config.
- The judge reads run artifacts + a generic rubric, never the hidden expected
  answers, so it cannot leak the benchmark's ground truth.

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
