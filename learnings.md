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
- Stage handoffs should preserve both human-readable summaries and structured artifacts. If a controller-native phase, planner decision, interview answer, or baseline-unrelated verification result affects later behavior, downstream stages and approval UI need the structured fact, not only a text blob.
- Stage-name dependencies (e.g. `dependsOn: [plan]`) must resolve to task ids when passing dependency context to the builder; comparing stage names to task ids silently empties dependency context.
- Controller-native stages (plan, discover, interview) should appear in task artifacts as `done` with `controllerHandled` and artifact path refs, so run inspection matches the runtime story.
- Interview answers are authoritative human facts: persist them as a structured `interview-decisions.json` and thread them into planner, builder context, reviewer, and approval — a text blob alone is brittle.
- Planner intent should be captured as a structured `implementationContract` (target files, non-goals, risks, checks) so downstream stages can inspect it, with best-effort extraction from prose as the backward-compatible baseline.
- Baseline-unrelated failures: warn and proceed, but make the debt explicit at final approval. The task-specific contract can pass while repository debt remains; the UI must say so rather than pretending full-green.
- Discovery should report implementation-surface status as structured JSON, including `implementationSurface: "missing"` for empty or greenfield repos. Do not rely on plain-text sentinel failures when the planner can use the structured status to choose new files.
- Verification planning should allow an empty command selection only when no configured or discovered runnable commands exist, then record incomplete verification with a missing automated-checks result instead of crashing before `verification.json` is written.
