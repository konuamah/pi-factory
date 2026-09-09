# local/factory-bombsite-02-status-surface

Second task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`). Stress site: Bombsite, reduced to
the same 4-file static doctor portfolio page as bombsite-01.

## What the agent does

`instruction.md` asks for a small, always-visible status surface on the doctor's
page, but **deliberately does not say what it shows, where it goes, or what it
says** — those details are decided in the interview. `interview.json` (the
scripted answers) commits to: an "Availability" section (`id="availability"`)
right below the nav, with an `<h2>Availability</h2>` heading and one line
"Currently accepting new patients", plain semantic HTML, no CSS, no extra
files.

The task measures **interview-to-plan and interview-to-build continuity**: did
the surface the interview decided actually appear in the plan and in the
implementation, with the exact content? `tests/grade.mjs` checks the decided
details verbatim (`id="availability"`, the h2, the status text, position above
`<main>`) plus the shared invariants (no CSS, contact form intact, existing
sections preserved, repo smoke check green).

## Environment

Same as bombsite-01: `node:22-bookworm-slim`, the fixture copied by explicit
`COPY` lines, `git init` + commit at build, `node tests/verify-page.mjs` as a
build gate. `environment/factory.yaml` runs the interviewed workflow
(discover → interview → plan → build → verify → review → approval).

## Verifier

`tests/test.sh` runs `tests/grade.mjs`. Rewards: `task_success` is `1.0` only
if all checks pass; partial credit and the failed-check list go to
`/logs/verifier/metrics.json`. Both `reward.json` and `reward.txt` are written.

## Oracle vs agent

**Oracle (validated):** `solution/solve.sh` adds the Availability surface exactly
as the interview decided; the verifier returns 1.0.

```bash
harbor run -p harbor/tasks/bombsite-02-status-surface -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

**Agent (real trial):** runs Pi + Factory headless via the same
`factory_pi:FactoryPiAgent` as bombsite-01; the run's `.factory/runs/` is
collected and scored with `scoreFactoryRun()`. See
`docs/factory/benchmark-running.md` for the exact command.

## Notes

- The base fixture is identical to bombsite-01; only the instruction,
  interview answers, reference solution, grader, and task name differ.
- `tests/benchmark-pack.test.mjs` should grow a discrimination case for this
  task (reference → 1.0, untouched → 0.0, wrong-status-text → 0.0) just like
  bombsite-01.
