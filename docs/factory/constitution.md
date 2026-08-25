# Constitution

The constitution is Factory's repository memory. It helps agents understand project structure, commands, services, tests, deployment, and conventions.

## When To Refresh

Refresh when:

- major structure changes
- new services or packages appear
- commands/test/deploy setup changes
- the user asks Factory to relearn the repo
- current constitution is missing or stale

Do not refresh for every small code change.

## Command

```text
/factory constitution
```

Normal Factory runs can also do a preflight judgment to decide whether to skip, target, or fully refresh constitution context.

## Agent Use

Use `CONSTITUTION.md` as context, not absolute law. Current user instruction and actual code/config win when evidence conflicts.

When relying on a constitution detail for a change, inspect the relevant files too.

## Editing

Prefer Factory constitution flows over manual edits. Manually edit `CONSTITUTION.md` only when the user explicitly asks to correct or add written guidance.
