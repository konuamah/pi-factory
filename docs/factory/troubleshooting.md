# Troubleshooting

Use this by symptom.

### Agents cannot see sibling packages

Factory keeps the Git worktree as the Discovery, Planner, and Builder visibility root. Dependency strategy may select a nested package as the setup/install cwd, but that package must not become the agent workspace. If an execution event reports different `executionRoot` and `dependencyRoot`, the distinction is intentional.

Implementation runs use an evidence gate: a Builder contract block is a real blocked task, and completion requires verification success, a merged final-merge artifact, and at least one non-generated product-file change. A successful lint/build or dependency-only commit is not sufficient.

## Cannot Find `@factory/core`

The vendored Factory copy likely lacks workspace links or dependencies. Preserve `vendor/pi-factory/node_modules` during source sync, or run install inside the vendored Factory when necessary.

## Factory Looks At The Wrong Project

Symptom: Pi was opened in one repository, but Factory Concierge inspects a different sibling repository.

Fix:

- treat the current Pi working directory as the project root
- ignore example paths in docs
- inspect `.pi/settings.json` in the current project for package installs
- use `pi list` to confirm the active project package
- do not inspect another repo unless the user explicitly names it as the target

## `.pi/extensions/factory/index.ts` Is Missing

If `.pi/settings.json` lists a Factory package, this is normal. Pi loads the packaged extension from the installed package. Do not recreate the project-local extension unless the project is intentionally using legacy project-local extension mode.

## Model Not Available

Symptom:

```text
model for planner not in availableModels
```

Fix:

- inspect `/factory models`
- replace stale role models with the detected Pi default
- do not invent provider/model IDs

## Discovered Command Not Actually Discovered

Symptom:

```text
command typecheck marked DISCOVERED but value not discovered
```

Fix:

- reclassify as `AI_SUGGESTED`
- require confirmation before applying
- prefer package scripts when present

## Discovery Evidence Path Typo

If a Discovery run reports invalid structured JSON after a prompt echo, inspect
`discovery-repair-execution.json`. Pi SDK transcripts can include the prompt and
repair instructions alongside the model's final JSON. Factory extracts the
final complete Discovery contract, then applies the normal strict file and
confirmed-evidence validation.

Symptom:

```text
Discovery failed: Discovery evidence references files that do not exist: ...
```

Current behavior:

- `files[]` remains strict. If Discovery claims an implementation file that does not exist, Factory still fails the run.
- `evidence[]` is softer. Factory now tries one safe correction using a unique basename match from Discovery's validated `files[]`.
- If no unique discovered-file match exists, Factory drops that bad evidence item and records a `discovery.evidence_sanitized` warning in the run events instead of failing Discovery immediately.

Example:

```text
bad evidence: frontend/landoptima/globals.css
validated files[]: frontend/landoptima/src/app/globals.css
result: evidence path is corrected to frontend/landoptima/src/app/globals.css
```

## Interview Prompt Rendered As a Question

If an interview displays `Role: Interview`, selected skills, or formatting
instructions, the model output crossed the user-facing decision boundary. The
Pi executor now excludes non-assistant messages, and the live DAG interview
runner normalizes output before creating a decision. One bounded repair attempt
is made for echoed or malformed output; if it still cannot produce concrete
questions, the interview node becomes `BLOCKED` instead of being marked
complete.

## Builder Stuck During Smoke Testing

Symptom:

```text
phase: implementation
builder output mentions smoke testing or a dev server
verify never starts
repair never becomes eligible
```

Fix:

- Keep Builder implementation-only. It may run short, bounded local commands to understand or compile-check its own edits, but it must not own the authoritative verification suite.
- Put lint, build, unit/integration tests, smoke/e2e, and project-specific checks in the `verify`/`verification` command stage.
- Add `commands.checks.<name>.timeout` for smoke/e2e or any command that could hang. Timeout values are seconds in `.factory/config.yaml`.
- Treat verify-stage commands as an allowlist. With an LLM verification planner, Factory should choose the smallest useful subset from the goal and changed files; without one, deterministic changed-path filtering is the fallback.
- If the verification planner or its JSON-repair response is malformed, Factory preserves both raw responses and continues with the evidence-backed deterministic verification plan. This is a planner recovery path, not a task failure; inspect `verification-plan.json` for `plannerUsedFallback: true`.
- Repair runs only after verification classifies a failure. It should not compensate for a builder that never returned.

## Widget Truncated

Keep TUI widgets short during select prompts. Use compact summaries and separate details views for long content.

## Dashboard Not Running

Check:

- `dashboard.enabled`
- `/factory dashboard status`
- port conflicts
- whether dashboard static files are built

Manual start:

```text
/factory dashboard start
```

## Setup Skill Dumps JSON To User

Pi-facing skills should be conversational. Internal runner skills may use JSON contracts, but project `.pi/skills` should not tell the model to return JSON unless the user expects machine-readable output.

### Dashboard Acceptance Evidence

The dashboard run-detail page exposes the acceptance evidence recorded at the acceptance dialog, including reviewer verdict and summary (with blocking verdicts highlighted), the user's decision and feedback, landing and pull-request metadata, post-landing verification, baseline debt, and scope warnings. This surface is read-only; legacy runs without acceptance artifacts omit `acceptanceEvidence` and show an explanatory empty state.
