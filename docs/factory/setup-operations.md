# Setup Operations

Use this when a user asks to install, finish, tune, or repair Factory setup.

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

Keep setup transcripts concise. Do not narrate every file read or search. Report the current state, the action taken, and the verification result.

For normal project setup, do not inspect Factory package source, TypeScript schemas, `dist`, binaries, or guessed CLI entrypoints. Use Factory commands, project manifests, and this docs library. Inspect Factory internals only when debugging Factory itself or a confirmed package/build/module-resolution failure.

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
- config loads
- commands configured
- worktree settings valid

`READY` is ideal. `READY_WITH_WARNINGS` can be acceptable if the warning is understood.
