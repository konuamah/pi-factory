# Harbor Quality Testing

Factory can use Harbor as a quality-testing harness for real agent work.

Use Harbor when you want to evaluate behavior across repeated tasks, not just run one-off repo checks. A Harbor task can model a real request like `add a navbar`, `fix the verification failure`, or `repair the broken build`, then score the result with an explicit verifier.

## What is set up in this repo

- Harbor CLI is expected to be available on the developer machine.
- Repo-local Harbor files live under `harbor/`.
- `harbor/tasks/factory-smoke` is the seed task for validating the Harbor plumbing.

Useful commands:

```bash
npm run harbor:version
npm run harbor:task:smoke:config
npm run harbor:task:init -- local/my-new-task --task --output-dir harbor/tasks
```

## What the smoke task does

The starter task is intentionally tiny:

- the instruction asks the agent to create one JSON artifact
- the verifier checks that the file exists and exactly matches the expected payload
- the environment image installs only `python3` and certificates

This is not meant to measure Factory quality by itself. It confirms that Harbor can scaffold, resolve, and verify a local task in this repository before we add stronger task families.

## How to grow this into real Factory evals

Good next tasks look like real user requests:

- `add a navbar`
- `add a sidebar`
- `fix the status bar regression`
- `repair a stale verification command`
- `classify a verification failure and choose the next phase`

For each task:

- include a realistic starter project or fixture
- write the request the way a user would actually say it
- verify with concrete outcomes such as DOM output, build success, lint success, screenshots, structured artifacts, or run-state artifacts
- keep the verifier deterministic even when the task prompt is natural language

## Running Factory headless (no human)

`packages/executors/pi/dist/runtime-harness.js` runs a real Factory workflow end to end without a TUI. It needs three environment variables and one answers file:

```bash
FACTORY_PI_USE_REAL_SDK=1        # real Pi SDK session (unset = fake session, plumbing only)
FACTORY_PI_RUNTIME_GOAL="add a navbar"
FACTORY_PI_DECISIONS_FILE=/path/interview.json
node packages/executors/pi/dist/runtime-harness.js
```

The answers file is a JSON object mapping a decision to its scripted answer. Keys are matched case-insensitively against, in order: `title:<decision title>`, `<decision title>`, `source:<decision source>` (for example `interview`), and the `"*"` wildcard:

```json
{ "interview": "Use MongoDB text search only; do not add a new platform." }
```

Plan approval and final approval are auto-approved and logged. If a decision arrives with no matching entry, the run **fails loud** rather than inventing an answer:

```text
Scripted interview answers have no entry for decision "Interview: grill" (source INTERVIEW).
```

## Factory orchestration benchmark

The approved design for scoring Factory behavior (interview rounds, stage handoffs, verification adaptation, landing, scope) with Harbor driving real Pi + Factory runs lives in [bombsite-benchmark-plan.md](bombsite-benchmark-plan.md). Key rules there: Harbor Oracle validates that a task is solvable and that the verifier detects it, while real agent trials populate benchmark statistics, and the scorer is a read-only core export consumed by both paths.

## Windows note

On this machine, `harbor init` created the task files successfully but then crashed while printing a Unicode checkmark under a `cp1252` console. Use the wrapped command:

```bash
npm run harbor:task:init -- local/my-new-task --task --output-dir harbor/tasks
```

That sets `PYTHONIOENCODING=utf-8` before invoking Harbor.
