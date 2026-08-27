# Setup Operations

Use this when a user asks to install, finish, tune, or repair Factory setup.

Factory docs are the operational registry for Factory Concierge. Start with `docs/factory/AGENT.md`, then this file, then command output/setup context/config/tool contracts. Inspect `src/` only when docs are missing, implementation debugging is required, or the user explicitly asks about code. Do not use `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees as behavioral reference sources.

## Default Path

1. Inspect current state:
   - `factory.yaml`
   - `.factory/config.yaml`
   - `CONSTITUTION.md`
   - `.pi/settings.json` for project-local Pi package installs
   - `.pi/extensions/factory/index.ts` only for legacy project-local extension installs
   - `.pi/skills/factory-concierge/SKILL.md` only when the project intentionally owns a local concierge skill
2. Run `/factory doctor` or validate setup if available.
3. If broad setup is needed, use `/factory setup`.
4. If the user requested a specific setting, edit the specific Factory-owned file.
5. Verify readiness.

`/factory doctor` is the readiness gate for model routing and Pi model availability. Use `/factory models` when the user needs the deeper per-role and per-task routing view before editing `.factory/config.yaml`.
`CONSTITUTION.md` is also part of readiness. If it is missing, doctor should fail until the constitution is generated or refreshed.
When Factory Concierge is asked to set up Factory or make the project ready, setup includes assigning Pi-visible models to every Factory role. Do not leave model assignment as a separate manual follow-up when Pi exposes a usable model.

Keep setup transcripts concise. Do not narrate every file read or search. Report the current state, the action taken, and the verification result.

For normal project setup, do not inspect Factory package source, TypeScript schemas, `dist`, binaries, or guessed CLI entrypoints. Use Factory commands, project manifests, and this docs library. Inspect Factory internals only when debugging Factory itself or a confirmed package/build/module-resolution failure.

## Operational Doc Shape

When Factory behavior must be documented for future Concierge runs, use this compact shape:

```markdown
# Action Or Capability Name

Purpose:
What the action does for the user.

Inputs:
- Required and optional inputs.

Permissions:
- Capabilities or approval rules involved.

Confirmation:
Whether approval is required before writes, cleanup, service start, or task execution.

Command route:
- The `/factory ...` command or Factory-owned file path.

Related source:
- `src/...` fallback pointer for debugging only.
```

## Install Modes

- Pi package mode: `.pi/settings.json` lists a local path or npm package. This is the preferred install mode. A missing `.pi/extensions/factory/index.ts` is normal because Pi loads the packaged extension.
- Legacy project-local mode: `.pi/extensions/factory/index.ts` exists and imports Factory directly from project dependencies.
- Vendored mode: `vendor/pi-factory` is present and the project extension imports from the vendored copy.

Always stay in the current project root. Do not copy paths from examples or inspect sibling projects while setting up a different repo.

## When To Run `/factory setup`

Use setup when:

- Factory files are missing.
- The repo shape changed meaningfully.
- Many settings need reconciliation.
- The user asks for "set everything up" without specific details.

Do not run setup just to toggle one setting. Edit that setting directly.

## Direct Edits

Safe direct edits include:

- commands in `.factory/config.yaml`
- dashboard settings
- dependency hydration and shared cache settings
- role model assignments
- repair attempts
- approval behavior
- skill files under `.pi/skills`, `.agents/skills`, or `skills`
- workflows in `factory.yaml`

Ask first before deleting or replacing existing user-authored setup.

## Readiness

A healthy setup should have:

- git root detected
- `factory.yaml`
- `.factory/config.yaml`
- `CONSTITUTION.md`
- config loads
- commands configured
- every Factory role resolves for `general` and configured task types
- every resolved provider/model pair is visible in Pi
- worktree settings valid
- dependency hydration uses a cache root outside the active repository/worktree

`READY` is ideal. `READY_WITH_WARNINGS` can be acceptable if the warning is understood.
