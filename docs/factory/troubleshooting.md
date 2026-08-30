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

## Discovery Returned No Output

Symptom:

```text
Discovery failed: Discovery returned no output
```

or:

```text
Discovery failed: Agent execution timed out after 60s (model-timeout)
```

Fix:

- inspect `/factory logs` and the latest `.factory/runs/<run-id>/discovery-execution.json`
- check `status`, `errorMessage`, and `outputText`
- if the executor timed out, use a faster discovery model or reduce discovery scope before retrying
- if `outputText` contains malformed JSON, Factory retries once with a strict JSON repair prompt and preserves the invalid payload as `discovery-execution-invalid.json`
- keep `runtime.limits` in `.factory/config.yaml` aligned with the repository size and model/provider behavior

## Discovery Finds No Implementation Surface

Symptom:

```text
Discovery result reports implementationSurface: missing
```

Fix:

- treat this as valid Discovery output when the repository is empty, greenfield, or has no existing app surface for the requested task
- let planning choose explicit new files for Builder to create
- do not use plain-text sentinel failures such as `DISCOVERY_FAILED: ...`; Discovery should always return structured JSON
- keep failing loudly when Discovery names existing files that are missing, unobserved, directory-only, or unsupported by confirmed evidence

## Agent Turn Appears Stuck

Symptom:

```text
Agent execution made no progress for 60s (model-timeout)
```

Fix:

- inspect `/factory logs` and the role execution artifact for `executor.timeout`
- treat `modelTimeoutMs` as the no-progress watchdog for Pi SDK agent turns
- increase `runtime.limits.modelTimeoutMs` only when the provider regularly pauses longer than the current value while still making useful progress
- prefer a faster model for the affected role when the watchdog repeatedly trips before any tool or text event

## Discovered Command Not Actually Discovered

Symptom:

```text
command typecheck marked DISCOVERED but value not discovered
```

Fix:

- reclassify as `AI_SUGGESTED`
- require confirmation before applying
- prefer package scripts when present

## Verification Uses Wrong Root Or Package Manager

Symptom:

```text
ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND
No package.json was found in "<repo or worktree root>"
```

or a configured command such as `pnpm lint` runs even though the changed app is a nested npm package.

Fix:

- use the verification planner to reason over candidate roots, package manifests, lockfiles, and scripts
- treat configured commands as user intent, not proof that the repo root or package manager is correct
- choose the cwd whose evidence owns the affected runnable package
- adapt package-script commands to the selected package manager when the script exists, for example `pnpm lint` -> `npm run lint`
- omit configured stages whose scripts do not exist in the selected package instead of inventing commands
- if no verification-planning executor is available, deterministic fallback may adapt only evidence-backed package-script commands

## Verification Has No Commands

Symptom:

```text
No automated verification commands were configured or discovered for this workspace.
```

Fix:

- treat this as incomplete verification, not a planner crash
- inspect `verification.json` and use the contract/manual review results to decide whether the task can continue
- add real commands to `.factory/config.yaml` or the project manifest once the repository has tests, lint, typecheck, or build scripts
- keep failing loudly if runnable commands exist and the verification planner omits all of them

## Run Blocks During Landing

Symptom:

```text
status: BLOCKED
phase: merge-blocked
```

Cause:

Factory planned final landing, but refused to claim completion because the
candidate was not safely landed. This is intentional: required landing must not
report `COMPLETED` unless `final-merge.json` is `landed` or explicitly
`policy-skipped`.

Inspect:

- `completed-tasks.json` for the normalized candidate commit, source branch, workspace mode, and changed files
- `landing-plan.json` for the AI-selected strategy, reasoning, expected files, verification, risk, and guard verdict
- `landing-diagnosis-<attempt>.json` for the failure class and recovery hint
- `landing-attempts.jsonl` for each attempted plan/execution/verification cycle
- `final-merge.json` for the stable landing status and outcome

Fix:

- if dirty files overlap the landing files, clean or stash those files before retrying
- if unrelated Pi/Factory runtime files are dirty and the current checkout is already the target branch, treat them as evidence rather than a blocker
- if verification is incomplete, add real verification commands or package scripts before expecting a required landing to complete
- if the candidate commit or branch is missing, inspect `completed-tasks.json` and rerun or resume from the preserved candidate workspace
- if the landing model returns invalid JSON, fix model routing or provider behavior; Factory should block rather than mutate Git with a guessed fallback

## Next Lint Fails On Next.js 16

Symptom:

```text
Invalid project directory provided, no such directory: <app>\lint
```

Cause:

- Next.js 16 removed `next lint`
- a package still has a stale script such as `"lint": "next lint"`

Fix:

- verification evidence includes package script bodies and dependency versions
- if `next` is version 16 or newer and `lint` runs `next lint`, Factory marks the script stale
- when `eslint` is installed, Factory should verify with the evidence-backed replacement command, for example `npm exec eslint src`
- do not run `eslint .` blindly when generated output such as `.next/` may be present

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

## Run Completes With Baseline Repository Debt

Factory can complete a run while pre-existing verification failures remain. This is expected:

- a failure is classified `baseline-unrelated` when the implicated files are real source, not generated output, and were not touched by the task
- the task-specific verification contract can still pass
- the final approval prompt shows `baselineDebt` (failed command, classification, reason, implicated files) and asks whether to approve despite it

Do not treat a `COMPLETED` run with baseline debt as a silent pass: inspect `verification.json` `failureClassification` and the approval `baselineDebt` to see what remains. If the same baseline failure keeps appearing, fix it once in the repo (for example missing type declarations or an SSR guard) rather than re-running.
