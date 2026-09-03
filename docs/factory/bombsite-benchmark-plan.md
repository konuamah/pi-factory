# Bombsite Benchmark Plan (Harbor + Factory)

> Status: approved design, not yet implemented. Gates 1–3 are buildable now; Gates 4–7 need Docker and provider credentials.
> Supersedes the earlier "LandOptima benchmark" framing — Bombsite is the v1 stress site.

## What we are building

Four layers, each independently provable:

```text
Golden fixtures        → validate the scorer          (Gate 2)
Harbor Oracle          → validate task + verifier      (Gate 4)
Real Pi + Factory run  → evaluate Factory behavior     (Gates 5–6)
summarizeBenchmarkResults → compare repeated trials    (Gate 7)
```

The benchmark measures Factory **orchestration**, not just whether code got written: interview rounds, stage handoffs, verification adaptation, landing, and scope control.

## Why Bombsite, and what it can't test

`D:\projects\bombsite` is 14 tracked files / ~61K, Factory-configured (`provider: commandcode`, `approval.finalMerge: required`, worktrees enabled), with 11 real run directories including the four failure modes fixed on 2026-08-30 and one successful landing. Fixtures copy into a container in seconds.

Its `factory.yaml` workflow (`safe-feature`: plan → build → review → approval) has **no interview stage**, no `package.json`, no configured commands, and no nested packages. So three consequences:

- Interview-driven tasks need a benchmark workflow variant that adds an `interview` stage (pattern exists: pi-factory's own `factory.yaml` `grilled-feature`, and LandOptima's `grilled-dev`).
- `adaptationQuality` would score an empty set and silently report 1.0. Each task that measures adaptation must **seed its own repo reality** (a `package.json` with stale scripts, broken lint debt, a nested app dir).
- Bombsite cannot produce interview data at all. The only real interview fixtures on this machine are LandOptima runs; keep 2–3 of those as interview fixtures.

## Verified starting state (2026-08-30)

Already exists — do not rebuild:

| Capability | Location |
| --- | --- |
| Structured interview artifact | `packages/core/src/runtime/controller-interview.ts:148` writes `interview-decisions.json` |
| Planner intent contract | `packages/core/src/runtime/artifacts.ts:41` (`implementationContract`: `targetFiles`, `implementationSteps`, `verificationChecks`, `nonGoals`, `risks`, `blockers`) |
| Read-only run aggregation | `packages/core/src/runs/show.ts`, `inspect.ts`, `logs-by-id.ts` parse state/summary/plan/verification/repair/reviewer/events/decisions/interview-decisions |
| Model routing ledger | `packages/core/src/runs/model-ledger.ts` (`ModelLedgerEntry`: role, taskType, taskTypeSource, taskTypeConfidence, requestedModel, resolvedModel, provider, modelSource) |
| Landing artifacts | `landing-plan.json` (incl. `guardVerdict`), `landing-diagnosis-<n>.json`, `landing-attempts.jsonl`, `final-merge.json`, `completed-tasks.json` |
| Headless run scaffold | `packages/executors/pi/src/runtime-harness.ts` runs the real flow (`FACTORY_PI_USE_REAL_SDK=1`) and auto-approves plan + final approval |

Missing — the actual work:

- No `requestDecision` handler in the harness, so any interview stage throws: `packages/core/src/runtime/phase-plumbing.ts:129` (`Decision required (...) but no requestDecision handler is configured`).
- `runs/show.ts` and `inspect.ts` read **neither** `final-merge.json` **nor** `landing-*.json` **nor** `*-interview-execution.json`. Scoring landing requires new readers.
- No scoring, weighting, or timing math anywhere. No Harbor task pack beyond the `factory-smoke` seed.
- `WorkflowNodeType` (`packages/schemas/src/config.ts:23`) is `"agent" | "command" | "approval" | "task-graph" | "interview"` — there is **no merge/landing node type**; landing is controller-native and runs unconditionally after approval.

## The interview-granularity constraint (drives metric naming)

Verified against `D:\projects\landoptima\.factory\runs\run_1788022310299_642886d5`:

- One `DecisionRequest` carried 4 questions (`Q1`–`Q4`) in a single `question` string.
- One `resolution` carried all 4 answers in one `feedback` blob.
- `interview-decisions.json` contains **1 record describing 4 questions**.
- The human's answer echoed the question text back (`Q1: <full question> A1: yes`), so naive answer→plan substring matching would match on the *question*, not the decision.

Decision: **v1 scores rounds, not questions.** Metric names must not claim precision the artifacts lack:

```text
interview_round_count      interview_round_quality
interview_round_efficiency interview_round_handoff
```

Never `question_count` / `question_quality`. Per-question scoring requires a core change to `controller-interview.ts` (one decision per question) — explicitly deferred.

## Architecture

```text
Harbor job (container per trial, lifecycle + timeouts + logs + -k attempts)
   ↓
factory-pi agent (installed pi + factory, runs headless)
   ↓
headless runner  --task ... --interview-answers interview.json --non-interactive
   ↓
real Factory workflow: discover → interview → plan → build → verify → review → approval → landing
   ↓
normal .factory/runs/<run-id>/ artifacts
   ↓
verifier: tests/test.sh → scoreFactoryRun() → /logs/verifier/reward.json
```

Harbor owns containers, repeated trials, timeouts, logs. We own the headless entry point and the scorer.

## Oracle vs agent: two separate data paths

Harbor's Oracle agent runs `solution/solve.sh` to prove the task is solvable and the verifier detects a correct solution. It is **not** the evaluation. Oracle must not fabricate Factory trajectory artifacts to satisfy the scorer — that would mix solution correctness with process quality and make a passing score meaningless.

```text
Oracle trial                    Agent trial
  solve.sh                        real Pi + Factory
  real reference impl             real interview / plan / build / review
  functional verifier             six-pillar scoreFactoryRun()
  reward.json: {task_success}     reward.json: {task_success, ...pillars}
  excluded from statistics        included in statistics
```

Diagnostics from Oracle go to `/logs/verifier/metrics.json`, never into `reward.json`. Rationale: Harbor reads numbers out of `reward.json`; putting `null` pillars there forces null-arithmetic in bash and lets missing data look like zero.

## Scoring model

`scoreFactoryRun(runDir, taskSpec)` → pure, read-only, deterministic given inputs. Never writes, never mutates git, never invents a metric it cannot derive — emits `warnings[]` instead.

Weights live in the **task spec**, not hard-coded, so they can be re-cut without a code change:

| Pillar | Weight (v1) | Derived from |
| --- | --- | --- |
| `interviewQuality` | 18 | `interview-decisions.json`, `decisions.jsonl`, `*-interview-execution.json`, workflow spec |
| `handoffQuality` | 20 | `guidance.context_selected`, `plan.json` (+`implementationContract`), `task.context_compiled`, event ordering |
| `executionQuality` | 15 | `summary.json`, `verification.json`, `repair-execution-*.json`, reviewer output |
| `mergeQuality` | 12 | `landing-plan.json` (`guardVerdict`), `landing-diagnosis-<n>.json`, `landing-attempts.jsonl`, `final-merge.json`, `completed-tasks.json` |
| `adaptationQuality` | 12 | `verification.json`: `cwd`, `cwdResolution`, `selectionSource`, `evidence.selectedCandidate`, `commandDecisions`, `failureClassification` |
| `scopeQuality` | 8 | `completed-tasks.json` changed files vs spec `expectedFiles`, contract `nonGoals` |
| `timeEfficiency` | 10 | `events.jsonl` timestamps, decision wait separated from agent time |

Report shape:

```json
{
  "runId": "run_x",
  "taskId": "bombsite-01",
  "trialKind": "agent",
  "schemaVersion": 1,
  "scores": {
    "overall": 0.84,
    "interviewQuality": 0.87,
    "handoffQuality": 0.85,
    "executionQuality": 0.79,
    "mergeQuality": 0.9,
    "adaptationQuality": 0.9,
    "scopeQuality": 0.82,
    "timeEfficiency": 0.72
  },
  "timing": { "totalMs": 0, "agentMs": 0, "humanWaitMs": 0, "phases": {}, "handoffs": {} },
  "signals": {},
  "warnings": []
}
```

Hard rules:

- **`contract.overallStatus` is not evidence.** Observed in the field: `verification.json` reported `contract: { requirements: [], results: [], overallStatus: "PASS", canComplete: true }` while its commands were `missing`. An empty requirement set must score as *no evidence*, and no pillar may read that field alone.
- **No cost/token metrics.** Nothing under `runs/` records usage (`model-ledger.jsonl` carries role/model/source only); `timeEfficiency` is wall-clock only.
- **Phase is a free-form string** (`merge-blocked`, `discovery-failed`, `cancelled-from-review`, `git-state-blocked`). The scorer needs a closed phase set; unknown phases produce warnings rather than falling through to zero.
- **Schema drift across eras.** Pre-`runLandingFlow` runs wrote `final-merge.json` as `{ status: "skipped", reason: "Command failed: git merge --no-ff ..." }` — a merge *failure* recorded as skipped, with no `outcome`/`recoveryHint`. Current `landing-types.ts` writes `status` + `outcome` + `recoveryHint`. The scorer must detect era, tolerate both, and warn.
- Interview execution artifacts are slug-named (`interview-interview-execution.json`) and multi-round produces several files with no index → glob `*-interview-execution.json`.

`summarizeBenchmarkResults(trials[])` lives in the same module dir and answers a different question ("how good is this configuration across repeated runs?"):

```json
{
  "attempts": 5,
  "successRate": 0.8,
  "meanScore": 0.81,
  "medianScore": 0.84,
  "bestScore": 0.92,
  "worstScore": 0.57,
  "meanRuntimeMs": 241000,
  "meanInterviewRounds": 2.4
}
```

Fail-loud rules (per repo norm "fail loud instead of silent fallbacks"):

```ts
type TrialKind = "oracle" | "agent";

if (trial.trialKind === "agent" && trial.factoryScore == null) {
  throw new Error("Agent trial is missing factory score");
}
```

- Only `trialKind === "agent"` enters any statistic; Oracle is excluded outright.
- Unknown / unmapped `trialKind` throws. Missing required metric throws. Nothing coerces to zero.
- `trialKind` is **derived by the caller** from the Harbor job's agent name (`-a oracle` → `"oracle"`, `-a factory-pi` → `"agent"`), because Harbor trial output does not record it. The mapping is explicit input to ingestion; an unrecognized agent name is an error, not a default.

## Harbor task layout

```text
harbor/tasks/bombsite-01/
├── task.toml              timeouts, verifier collect, metadata
├── instruction.md         the user request, phrased as a user would say it
├── interview.json         scripted answers (deterministic input)
├── environment/Dockerfile node + pi + factory prebuilt, repo fixture baked in
├── fixture/               per-task seeded repo reality
├── solution/solve.sh      real reference implementation (Oracle path only)
└── tests/test.sh          functional checks + scoreFactoryRun() → reward.json
```

Five families from the original brief:

1. `bombsite-01` UI shell change (sidebar/navbar) — interview must establish links, behavior, mobile treatment, visual intent.
2. `bombsite-02` status-surface extension — do interview answers survive into plan and implementation.
3. `bombsite-03` verification adaptation — seeded stale/misleading config; interview stays on product intent while verification adapts to reality.
4. `bombsite-04` baseline-debt triage — seeded unrelated lint/build debt; scope boundaries established and preserved.
5. `bombsite-05` repair after failed verification — recovery path; earlier interview constraints still shape repair.

Each task declares: prompt, expected interview round topics, acceptable scripted answers, expected plan scope, expected file surface, expected verification outcome class, pillar weights.

Harbor flags we rely on: `-k/--n-attempts` (≥3 once 5d works), `-n/--n-concurrent`, `--max-retries`, `--env-file` (provider creds), `--install-only` (fast image bring-up), `--print-config` (offline validation), `harbor task start-env -e docker -a -i` (interactive debugging), `harbor check` (rubric-lint tasks), `harbor analyze` (trajectories).

No Python adapter for v1 unless the installed-agent path demonstrably falls short. Oracle validates; it does not evaluate.

## Work list

| # | Change | Files | Gate |
| --- | --- | --- | --- |
| 1 | Scripted decisions handler for headless runs (JSON answers file → `requestDecision`), env/flag driven, explicit `landingExecutor` wiring | new `packages/executors/pi/src/headless.ts`, `packages/executors/pi/src/runtime-harness.ts`, `package.json` script | 1 |
| 2 | `scoreFactoryRun` + types | new `packages/core/src/benchmark/{score-factory-run,summarize-results,types}.ts` | 2 |
| 3 | Readers the scorer needs (landing artifacts, `*-interview-execution.json`, closed phase set, era detection) | `packages/core/src/runs/{show,inspect}.ts` | 3 |
| 4 | Golden fixtures + scorer tests | new `tests/fixtures/…`, `tests/benchmark.test.mjs` | 2 |
| 5a–e | Harbor pack: one task → Oracle passes → agent path → one real run scored → expand to five | `harbor/tasks/bombsite-*/…` | 4–7 |
| 6 | Docs + skills in the same change as the code | this file, `docs/factory/quality-testing.md`, `skills/factory-concierge/SKILL.md`, `.pi/skills/factory-concierge/SKILL.md`, `learnings.md` | — |

Decided: rounds-only interview scoring for v1; `scoreFactoryRun()` in core (Harbor consumes it, no second implementation); Oracle restricted to task validation; aggregator rejects ambiguous input.

## Test plan

Deterministic, no Docker, no credentials:

- scripted interview reaches terminal state; old "no requestDecision handler" throw is gone; `interview-decisions.json` holds the scripted answers.
- golden fixture → exact expected pillar scores (byte-stable; assert twice, `deepEqual`).
- interview required but absent → full `interview_presence` penalty.
- under-questioning and over-questioning efficiency cases.
- chosen answers reflected in plan text/tasks (round-level handoff), and negative case where echoed question text must **not** count as continuity.
- handoff latency math across discover → interview → plan → build → verify → approval → landing; human wait separated from agent time.
- reviewer/controller disagreement scoring.
- landing: guard verdict correctness, diagnosis kind matching the real cause, attempts vs `repair.maxAttempts`.
- adaptation against a seeded `package.json`: nested cwd, package-manager choice, stale command replaced, missing commands omitted not invented.
- scope drift beyond `expectedFiles`; interview-established non-goals respected.
- routing stability across retries from `model-ledger.jsonl`.
- `contract: PASS` with empty requirements must **not** raise any pillar score.
- aggregator: agent trial without score throws; unknown `trialKind` throws; Oracle excluded from stats.
- `harbor run --print-config -a oracle` resolves for every packaged task, exit 0.

## Environment blockers

- Docker daemon is **down** on this machine → `harbor run` cannot execute trials here. Only `--print-config` validation is provable locally.
- Real agent trials need provider credentials inside the container (`--env-file`), and Bombsite routes every role to `commandcode/deepseek/deepseek-v4-flash`.
- LandOptima is 199MB tracked / ~1.9GB worktree — usable as an interview fixture source, not as a container fixture.

## Non-goals for v1

- No core change to interview storage (one-decision-per-question deferred).
- No per-question or LLM-judge interview scoring.
- No release gating — this is comparative first.
- No custom Harbor adapter unless installed-agent + `solve.sh` + `test.sh` provably falls short.
- No token/cost accounting.
- Not five tasks before one real run works: Gate 5d is the milestone, `harbor config parses` and `oracle passes` are explicitly not it.
