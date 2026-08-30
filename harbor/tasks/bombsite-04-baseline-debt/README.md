# local/factory-bombsite-04-baseline-debt

Fourth task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`).

## What the agent does

`instruction.md` asks for clearer contact-form feedback (prominent + announced
success message, invalid-input blocking unchanged, wording unchanged). The
interview (`interview.json`) pins the scope hard: modify only `index.html` and
`script.js`, and **leave every other file exactly as found, even if something
looks wrong**.

The repo deliberately contains unrelated debt: `legacy/old-script.js` is broken
JavaScript (fails `node --check`), and the configured lint checks every JS file
including it. So a run that correctly scopes to the changed files passes; a run
that "fixes" the debt, or lets verification fail on it and drags the change
off-scope, loses the scope pillar.

## Verifier

`tests/grade.mjs` enforces both halves:

- the form-result element gained `role="status"` + `aria-live="polite"`, the
  success wording is unchanged, invalid-input blocking still works;
- **the debt is preserved**: `legacy/old-script.js` still exists and still does
  not parse; removing the added attributes from `index.html` restores the
  original shape; no new files.

`task_success` is 1.0 only if all pass; partial credit and failures go to
`metrics.json`.

## Oracle vs agent

**Oracle (validated):** `solution/solve.sh` adds the two attributes to
`#form-result` and scopes its own checks to the changed files.

```bash
harbor run -p harbor/tasks/bombsite-04-baseline-debt -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

**Agent (real trial):** runs Pi + Factory headless via `factory_pi:FactoryPiAgent`.
`scopeQuality` in `scoreFactoryRun` measures whether the run stayed in the
interview-established scope.
