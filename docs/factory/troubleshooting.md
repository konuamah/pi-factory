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
