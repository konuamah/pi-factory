# Troubleshooting

Use this by symptom.

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
