# Factory Agent Reference Rules

Use this file before operating Factory from an agent or skill. It defines what context is authoritative, what to ignore, and how to keep future runs from rediscovering the same behavior.

## Reference Order

1. Start with `docs/factory/README.md`.
2. Read only the relevant `docs/factory/*.md` reference for the user's request.
3. Use Factory command output, setup context, config files, and tool/API contracts next.
4. Inspect `src/` only when documentation is missing, implementation debugging is required, or the user explicitly asks about code.
5. Never use `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees as behavioral reference sources.

## Operational Registry Pattern

Factory docs should answer the questions agents otherwise rediscover from source. Prefer operational entries with this shape:

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

## Feedback Loop

If source inspection reveals reusable Factory behavior, add or update the relevant file in `docs/factory/`. Future Concierge runs should learn that behavior from docs instead of rereading source.

Every Factory behavior, command, setup, workflow, capability, runtime, or agent UX change must update the matching `docs/factory/` page and relevant Factory skill instructions in the same change. Keep `skills/factory-concierge/SKILL.md`, `.pi/skills/factory-concierge/SKILL.md`, and `skills/factory-setup/SKILL.md` aligned when the change affects setup or operation.

Generated output is not a source of truth. If docs and generated output disagree, trust docs plus source, and refresh the generated output through the normal build.
