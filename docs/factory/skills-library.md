# Skills Library

Use this when the user wants Factory to import, create, or tune skills.

## Skill Format

A skill is a folder with a `SKILL.md` file. The file needs frontmatter:

```yaml
---
name: skill-name
description: What this skill helps with.
---
```

Then add concise instructions and examples.

## Locations

Project-visible locations:

- `.pi/skills/`
- `.agents/skills/`
- `.codex/skills/`
- `.claude/skills/`
- `.factory/skills/`
- `skills/`

Global user locations:

- `~/.pi/agent/skills/`
- `~/.agents/skills/`
- `~/.codex/skills/`
- `~/.claude/skills/`
- `~/.factory/skills/`

## Choosing A Location

Use `.pi/skills` for Pi-facing skills that should be visible when running Pi in the project.

Use `.agents/skills` for shared agent skills across harnesses.

Use `skills/` for Factory-bundled or internal source skills.

Use `.codex/skills` or `.claude/skills` only when targeting that harness specifically.

## Bundled Skills

Factory bundles the interview skill in `skills/grilling` with a thin `skills/grill-me` alias for compatibility. Use the bundled skill directly when authoring workflows; no external install is needed.

## Authoring Rules

- Keep skill bodies focused.
- Link to docs for large reference material.
- Include trigger examples.
- Say what files the skill may edit.
- Say when to ask for approval.
- Avoid forcing JSON output unless a tool/runner requires structured output.
