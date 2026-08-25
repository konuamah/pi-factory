# Setup Operations

Use this when a user asks to install, finish, tune, or repair Factory setup.

## Default Path

1. Inspect current state:
   - `factory.yaml`
   - `.factory/config.yaml`
   - `CONSTITUTION.md`
   - `.pi/extensions/factory/index.ts`
   - `.pi/skills/factory-concierge/SKILL.md`
2. Run `/factory doctor` or validate setup if available.
3. If broad setup is needed, use `/factory setup`.
4. If the user requested a specific setting, edit the specific Factory-owned file.
5. Verify readiness.

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
