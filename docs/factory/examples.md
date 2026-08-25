# Examples

## Turn On Dashboard

User:

```text
turn on the dashboard
```

Agent action:

1. Edit `.factory/config.yaml`.
2. Add or update:

```yaml
dashboard:
  enabled: true
  port: 4199
  host: 127.0.0.1
  autoOpen: false
```

3. Run `/factory doctor`.
4. Tell the user to run `/factory dashboard start` or restart Pi.

## Make A Workflow

User:

```text
make a safe feature workflow
```

Agent action:

1. If enough detail exists, edit `factory.yaml`; otherwise run `/factory workflow create`.
2. Use steps with descriptions:
   `plan -> build -> verify -> review -> approval`.
3. Use command step checks: lint, typecheck, test, build.
4. Run `/factory doctor`.

## Fix Model Routing

User:

```text
Factory says planner model is unavailable
```

Agent action:

1. Run `/factory models`.
2. Inspect Pi configured default.
3. Edit `.factory/config.yaml` role models to use the Pi default.
4. Run `/factory doctor`.

## Add A Skill

User:

```text
add a release checklist skill
```

Agent action:

1. Create `.pi/skills/release-checklist/SKILL.md`.
2. Include frontmatter name and description.
3. Add concise release-check instructions.
4. Run `/factory setup` only if skill discovery needs a full reconciliation; otherwise report the new skill path.

## Set Everything Up

User:

```text
set everything up for this repo
```

Agent action:

1. Inspect current Factory files.
2. If missing or stale, run `/factory setup`.
3. If already ready, tune only requested pieces.
4. Run `/factory doctor`.
