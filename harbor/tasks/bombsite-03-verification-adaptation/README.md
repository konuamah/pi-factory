# local/factory-bombsite-03-verification-adaptation

Third task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`).

## What the agent does

`instruction.md` asks for a Credentials highlights block under the Experience
section. The exact three qualifications are decided in the interview
(`interview.json`): M.D. University of Ghana Medical School, Board Certified
Family Medicine, 12 years of clinical experience — in a `ul` under the
Experience heading.

The twist that makes this **verification-adaptation**: the fixture's
`.factory/config.yaml` configures `lint: node tools/lint.mjs`, but
`tools/lint.mjs` **does not exist**. A naive run fails verification with a
broken lint command; a correct run adapts — replaces the stale command with an
evidence-backed one (or omits it), keeping the repo green — without inventing
an ungrounded replacement, and without letting verification noise pull the
interview off the product intent.

## Environment

Same base as bombsite-01/02 (`node:22-bookworm-slim`, explicit `COPY`, build
gate `node tests/verify-page.mjs`). The seeded stale config lives in
`environment/.factory/config.yaml`.

## Verifier

`tests/grade.mjs` checks: all three interview-decided credentials present and
inside the Experience section as a `ul`; the shared invariants (JS parses,
smoke test green, no CSS, contact form intact, sections preserved); and that no
ghost `tools/lint.mjs` target was created. `task_success` is 1.0 only if all
pass; partial credit and failures go to `metrics.json`.

## Oracle vs agent

**Oracle (validated):** `solution/solve.sh` adds the three credentials and
checks syntax with `node --check` directly (it does not depend on the stale
lint).

```bash
harbor run -p harbor/tasks/bombsite-03-verification-adaptation -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

**Agent (real trial):** runs Pi + Factory headless via `factory_pi:FactoryPiAgent`
with the same command as bombsite-01 (see `docs/factory/benchmark-running.md`).
`adaptationQuality` in `scoreFactoryRun` measures whether verification chose the
right cwd/commands and omitted or replaced the stale one.
