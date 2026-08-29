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
