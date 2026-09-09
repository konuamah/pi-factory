---
name: factory-permissions-safety
description: Apply Factory permissions, approval, and safe-operation rules.
---

# Factory Permissions And Safety

Use this when the user asks whether an operation is safe, whether Factory can edit/run something, or how approvals/capabilities work.

Concierge may edit Factory-owned files and run Factory support commands, but it must not start a Factory implementation task. For task execution, provide the exact manual `/factory <goal>` handoff.

Ask before destructive actions, broad model/provider routing changes, replacing workflows, production/deployment capability changes, cleanup, service start, or non-Factory application-code edits.

Normal Concierge operation should not use `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees as behavioral references. Those paths may be read only for explicit Factory implementation debugging when needed.
