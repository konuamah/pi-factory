# local/factory-bombsite-07-full-stack-consult

Seventh task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`) — and the most advanced so far: a
**multi-file, multi-concern** change that stresses interview fidelity, handoff,
execution, verification adaptation, and scope at once.

## What the agent does

`instruction.md` asks for two coupled behaviors on the doctor-portfolio page:

1. **The contact form remembers successful submissions** on the device and shows
   a running count ("You have sent N messages") that survives reload.
2. **The About section shows visit availability**, sourced from a **new
   `data/schedule.js`** the agent must create and load with a plain `<script
   src>` tag.

The twist that makes it genuinely hard: the page must keep working when opened
**straight from disk (`file://`)** — so `fetch()`/`XMLHttpRequest` are forbidden
for loading data, which rules out the obvious "load a JSON file" approach. The
correct implementation ships schedule data as a plain JS global loaded by a
script tag, and persists the counter with `localStorage`.

The fixture's `.factory/config.yaml` also configures a **stale lint**
(`node tools/lint.mjs`, which does not exist), so verification must adapt around
it, and the seeded `tests/verify-local-form.mjs` check **fails until the work is
done** — exercising Factory's repair path.

## Why it is advanced

- **3 touched files across 2 layers** (`index.html`, `script.js`, new
  `data/schedule.js`) — exceeds the 1-file deterministic-review threshold, so a
  real LLM review is required.
- **A new file to create**, not just edit — tests whether the handoff names it
  and the builder honors it.
- **A genuine engineering constraint** (`file://` safety) that punishes
  pattern-matching a `fetch` solution.
- **Behavioral persistence** (localStorage counter) plus **data rendering**
  (visit slots), plus **full preservation** of section toggle, form
  validation/mailto, and footer year.
- **Adaptation + repair**: stale lint + a seeded failing check.

## Environment

Same base as bombsite-01 (`node:22-bookworm-slim`, baked Pi SDK for a fast
agent install, explicit `COPY`, build gate `node tests/verify-page.mjs`). The
seeded stale lint lives in `environment/.factory/config.yaml`; the seeded
failing behavioral check lives in `environment/tests/verify-local-form.mjs`.

## Verifier

`tests/grade.mjs` checks (21 checks): the seeded behavioral checks are green;
localStorage persistence (write, read-back, increment, render count); the new
`data/schedule.js` exists, is plain data, is loaded via a `<script src>` tag,
and is rendered in About; no `fetch`/`XMLHttpRequest` anywhere; all shared
invariants (JS parses, smoke green, contact form fields/validation/mailto,
section toggle, all sections, no CSS, config untouched, tests unmodified via
git diff). `task_success` is 1.0 only if all pass.

## Oracle vs agent

**Oracle (validated):** `solution/solve.sh` creates `data/schedule.js`, adds the
script tag + About placeholder, and rewrites the success branch to persist and
render the count. It validates with `node --check` + both seeded checks.

```bash
harbor run -p harbor/tasks/bombsite-07-full-stack-consult -a oracle
# expect: 1/1 trial, Mean: 1.000, 0 exceptions
```

**Agent (real trial):** runs Pi + Factory headless via `factory_pi:FactoryPiAgent`:

```bash
PYTHONPATH=harbor/agents harbor run -p harbor/tasks/bombsite-07-full-stack-consult \
  --agent factory_pi:FactoryPiAgent \
  -m commandcode/deepseek/deepseek-v4-flash \
  --ak interview_answers_path=harbor/tasks/bombsite-07-full-stack-consult/interview.json
```

`adaptationQuality` measures whether verification adapted around the stale lint;
`executionQuality` measures whether the run recovered from the seeded failing
check; `scopeQuality` measures whether only the allowed files changed.
