---
name: factory-skills-library
description: Import, author, and reason about Factory and agent skills.
---

# Factory Skills Library

Use this when the user asks to add, import, create, review, or tune skills.

A skill is a directory containing `SKILL.md` with frontmatter `name` and `description`. Optional scripts, references, and assets live beside it.

Factory discovers project skills from `.pi/skills`, `.agents/skills`, `.codex/skills`, `.claude/skills`, `.factory/skills`, and `skills/`. Global agent skill roots are also inventoried.

For Pi-facing Factory operations, prefer focused `.pi/skills/factory-*` skills and keep `factory-concierge` as the orchestrator. Use `skills/grilling` for interview workflows; no external install is needed.

Keep skill bodies focused and operational. State when the skill applies, what files it may change, what commands it may recommend, and what approval is required.
