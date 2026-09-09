# Factory Agent Reference Rules

Use this file before changing Factory code or internal Factory docs. It defines what context is authoritative for maintainers, what to ignore, and how to keep future changes from rediscovering the same behavior.

## Reference Order

1. For user-facing Concierge behavior, start with the focused `.pi/skills/factory-*` operational skill.
2. For Factory codebase changes, start with `docs/factory/README.md`, then read only the relevant `docs/factory/*.md` internal reference.
3. Use Factory command output, setup context, config files, and tool/API contracts next.
4. Inspect `src/` only when skill/docs guidance is missing, implementation debugging is required, or the user explicitly asks about code.
5. Never use `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees as behavioral reference sources.

## Operational Registry Pattern

Factory operational skills should answer the questions Concierge otherwise rediscover from source. Internal docs may keep deeper architecture, history, and source-level notes. Prefer operational skill entries with this shape:

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

If source inspection reveals reusable Factory operations behavior, add or update the relevant `.pi/skills/factory-*` skill. Future Concierge runs should learn that behavior from skills instead of rereading source.

Every Factory behavior, command, setup, workflow, capability, runtime, or agent UX change must update the matching `.pi/skills/factory-*` operational skill and any relevant `docs/factory/` internal page in the same change. Keep `skills/factory-concierge/SKILL.md`, `.pi/skills/factory-concierge/SKILL.md`, and `skills/factory-setup/SKILL.md` aligned when the change affects setup or operation.

Generated output is not a source of truth. If docs and generated output disagree, trust docs plus source, and refresh the generated output through the normal build.
