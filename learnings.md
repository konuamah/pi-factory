# learnings.md

- When repository topology is ambiguous, use deterministic discovery to gather candidate roots/scripts, then use a reasoning step to choose execution strategy.
- Verification failures should be separated into harness/config selection issues versus real project code issues.
- Do not treat transient worktree content as authoritative long-term project guidance.
- Persist verification reasoning artifacts so cwd, command selection, and failure classification can be inspected later in logs/show output.
- Resume policy should react to failure classification: re-plan verification for harness/config or repo-script issues, and resume repair/verification for real code failures.
- Builder sessions run in per-task sibling worktrees, but the compiled prompt never named the workspace path. Models (MiniMax-M2.7) resolved relative repo hints like `backend/src/...` against the main checkout, so edits landed in the main repo while the worktree diff stayed clean, producing `implementation-failed` (task produced no changes). Always inject the task workspace path into the builder prompt so tool calls target the worktree, and re-emphasize on no-change retry.
- Fast worktrees should share immutable package-manager/compiler caches while keeping source, git index, dependency manifests, `node_modules`, virtualenvs, and other writable workspace state isolated. Make this language-neutral and drive setup through the repo's configured setup command rather than a framework-specific installer.
- Doctor readiness should validate both model routing resolution and Pi-visible provider/model availability, not just the presence of config keys.
- Broad Factory Concierge setup should produce model-ready config by assigning Pi-visible models to all Factory roles, not only direct users to model inspection.
