# local/factory-bombsite-05-repair-verification

Fifth task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`).

## What the agent does

`instruction.md` asks for the contact-form success message to be personalized
with the visitor's name. The interview (`interview.json`) pins the behavior: the
message must start with the trimmed name from the name field, followed by the
existing wording; invalid input is blocked exactly as now; only `index.html`
and `script.js` may change.

The fixture's `test` command runs `tests/verify-personalization.mjs` **on top
of** the normal smoke check. That seeded check FAILS until the success message
is actually personalized (it rejects the generic hardcoded message). So a run
that implements the change correctly turns verification green; a run that does
not fails verification — which is what exercises Factory's repair path: the
controller must recover (fix the failing check and retry) instead of stopping,
while still honoring the interview constraints.

## Verifier

`tests/grade.mjs` checks: the success message is built from the name field
value, the existing wording is kept, the generic message is gone from the
success branch, the seeded `verify-personalization` check passes (repair
succeeded), invalid input is still blocked, JS parses, smoke test green, no CSS,
contact form intact.

## Oracle vs agent

**Oracle (validated):** `solution/solve.sh` personalizes the message and turns
the seeded check green.

```bash
harbor run -p harbor/tasks/bombsite-05-repair-verification -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

**Agent (real trial):** runs Pi + Factory headless via `factory_pi:FactoryPiAgent`.
`executionQuality` in `scoreFactoryRun` reflects whether verification passed and
whether repair attempts were needed.
