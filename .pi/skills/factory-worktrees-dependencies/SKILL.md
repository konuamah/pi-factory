---
name: factory-worktrees-dependencies
description: Configure Factory worktree isolation, dependency hydration, and shared caches.
---

# Factory Worktrees And Dependencies

Use this when the user asks about worktrees, repeated installs, dependency hydration, cache reuse, slow setup, or dependency state.

Factory runs agents in isolated workspaces. Source, git index, dependency manifests, `node_modules`, virtualenvs, and other writable workspace state must stay isolated per worktree.

Dependency hydration runs the configured `commands.setup` with shared cache environment variables for common ecosystems. This is language-neutral: Node, Python, Rust, Go, Java-style, and other projects are handled through the repository's own setup command.

Prefer `dependencies.enabled: true` and `dependencies.hydrate: auto`. The cache root should live outside the active repository/worktree.

Do not recommend sharing one writable `node_modules`, `.venv`, or framework-specific dependency folder across worktrees.
