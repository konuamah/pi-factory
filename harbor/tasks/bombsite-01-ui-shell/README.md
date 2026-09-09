# local/factory-bombsite-01-ui-shell

First task of the Factory orchestration benchmark
(`docs/factory/bombsite-benchmark-plan.md`). Stress site: Bombsite
(`D:\projects\bombsite`), reduced to a 4-file static doctor portfolio page.

## What the agent does

`instruction.md` asks for the page to become a tabbed, phone-usable page: the
navigation must read as a list of section names with the current one marked,
only one section shows at a time, and the contact form keeps working — under a
hard no-CSS constraint, with no dependencies and no build step. The page is
plain HTML plus `script.js`, opened straight from disk.

The workflow the agent trial runs (`environment/factory.yaml`) is
`discover → interview → plan → build → verify → review → approval`, with the
`interview` stage bound to the bundled `grilling` skill. The interview exists
because the request is genuinely ambiguous: "list of section names", "obvious"
and "usable on a phone" do not specify which links, which default section, or
how far the markup may change.

## Environment

`environment/` is the Docker build context, so everything the agent sees is
copied by explicit `COPY` lines in `environment/Dockerfile`.

- Base image: `node:22-bookworm-slim` (+ `git`, `ca-certificates`). No Pi, no
  Factory: the Oracle path needs neither, and the agent trial layers them on.
- Contents: `index.html`, `script.js`, `factory.yaml`, `.factory/config.yaml`,
  `.pi/skills/grilling/SKILL.md`, and `tests/verify-page.mjs`.
- The image ends with `git init` + one commit, then runs `node
  tests/verify-page.mjs`, so a broken fixture fails at build time.
- `cpus = 2`, `memory_mb = 2048`, `build_timeout_sec = 900`, network `public`.

Two deliberate features:

- **Real verification commands.** `.factory/config.yaml` configures `lint` and
  `test`, so a run gets evidence instead of the `automated-checks: missing`
  result an empty repo produces.
- **Skills resolve.** Factory loads project skills from `.pi/skills` and
  `.agents/skills` only (`packages/core/src/skills/index.ts:37`). That is why
  `grilling` sits under `.pi/skills/` here rather than the top-level `skills/`
  directory Bombsite uses — a top-level copy would make every interview stage
  fail its skill policy.

## Verifier

`tests/test.sh` runs `tests/grade.mjs` (plain node, so it is testable without
Docker). `tests/` is copied to `/tests` only when verification starts, after
the agent's turn ends, and is not in the build context — the rubric below is
invisible to the agent.

| Check | What it proves |
| --- | --- |
| `every-js-file-parses` | no syntax damage anywhere in the repo |
| `repo-smoke-check-passes` | the repo's own invariants still hold |
| `nav-is-a-list` | navigation became a list of section names |
| `one-section-visible` | sections reduced to one visible surface |
| `nav-links-resolve` | every nav link points at a real section |
| `active-section-distinguishable` | current section is marked |
| `no-css-introduced` | the stated constraint was respected |
| `contact-form-intact` | existing behavior not broken |
| `medical-content-preserved` | content not deleted to pass |
| `config-untouched` | `.factory/config.yaml` not edited to cheat verification |

Rewards: `task_success` is `1.0` **only if all ten checks pass**; partial
credit and the failed-check list go to `/logs/verifier/metrics.json` as a
diagnostic. Both `reward.json` (what Harbor 0.22 parses,
`verifier/verifier.py:81`) and `reward.txt` (what the adapter guide documents)
are written.

## Oracle vs agent — this task's two jobs

**Gate 4, validated.** The Oracle runs `solution/solve.sh` — a real reference
implementation of the request, not fabricated artifacts — and the verifier
returns 1.0:

```bash
harbor run -p harbor/tasks/bombsite-01-ui-shell -a oracle
# 1/1 trial, Mean: 1.000, 0 exceptions
```

Discrimination is pinned by `tests/benchmark-pack.test.mjs`, which runs the
grader against three local states: reference solution → 1.0; untouched fixture
→ 0.0 (fails `nav-is-a-list`, `active-section-distinguishable`); a `styles.css`
shortcut → 0.0 (fails `no-css-introduced`).

**Gate 5c/5d, validated.** Pi + Factory are not in the base image; the agent
install adds them, then runs the headless harness. The real trial landed and
was scored:

```bash
PYTHONPATH=harbor/agents harbor run -p harbor/tasks/bombsite-01-ui-shell \
  --agent factory_pi:FactoryPiAgent \
  -m openai-codex/gpt-5.4-mini \
  --ak interview_answers_path=harbor/tasks/bombsite-01-ui-shell/interview.json
# agent_info.name: factory-pi | reward task_success: 1
# collected run scores overall 0.965 via scoreFactoryRun
```

Prerequisites: Pi credentials on the host (`~/.pi/agent/auth.json` — the
agent reads it directly for the openai-codex OAuth token), Docker up, and a
provider/model reachable from the container. The command also works with any
`provider/model` Pi exposes (e.g. `commandcode/deepseek/deepseek-v4-flash`).
The agent injects `COMMANDCODE_API_KEY` when the provider is commandcode, and
points Pi at a trimmed config dir (`PI_CODING_AGENT_DIR=/tmp/harbor-factory-pi`)
so the host's own settings.json (which lists pi-goal-list-loop-audit) never
contaminates the measured run. Interview answers live at `/task/interview.json`
— outside `/app`, so the agent cannot read what it is scored on.

## Notes

- `solution/solve.sh` honors `BENCHMARK_APP_DIR` (default `/app`) purely so the
  regression test can execute it locally; behavior inside the container is
  identical.
- The task measures process quality, so the scripted interview answers in the
  pending `interview.json` should carry substance. Answering every question
  with "yes" makes interview-to-plan continuity unmeasurable: `scoreFactoryRun`
  reports that pillar as `null` with a warning rather than guessing.
- `interview-interview-execution.json` is named from the stage slug, so the
  stage must stay a single word.
