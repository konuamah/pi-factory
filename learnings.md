# learnings.md

- Dashboard run details should expose normalized acceptance evidence, especially reviewer blocking verdict summaries and the user's final decision, without making the read-only surface appear actionable.

- When repository topology is ambiguous, use deterministic discovery to gather candidate roots/scripts, then use a reasoning step to choose execution strategy.
- Verification failures should be separated into harness/config selection issues versus real project code issues.
- Do not treat transient worktree content as authoritative long-term project guidance.
- Persist verification reasoning artifacts so cwd, command selection, and failure classification can be inspected later in logs/show output.
- Resume policy should react to failure classification: re-plan verification for harness/config or repo-script issues, and resume repair/verification for real code failures.
- Builder sessions run in per-task sibling worktrees, but the compiled prompt never named the workspace path. Models (MiniMax-M2.7) resolved relative repo hints like `backend/src/...` against the main checkout, so edits landed in the main repo while the worktree diff stayed clean, producing `implementation-failed` (task produced no changes). Always inject the task workspace path into the builder prompt so tool calls target the worktree, and re-emphasize on no-change retry.
- Fast worktrees should share immutable package-manager/compiler caches while keeping source, git index, dependency manifests, `node_modules`, virtualenvs, and other writable workspace state isolated. Make this language-neutral and drive setup through the repo's configured setup command rather than a framework-specific installer.
- Doctor readiness should validate both model routing resolution and Pi-visible provider/model availability, not just the presence of config keys.
- Broad Factory Concierge setup should produce model-ready config by assigning Pi-visible models to all Factory roles, not only direct users to model inspection.
- Discovery should keep `files[]` strict but treat `evidence[]` as repairable supporting citations: auto-correct a uniquely matching basename from validated discovered files, otherwise drop the bad evidence item and log a warning instead of failing the whole run.
- Builder must stay implementation-only: authoritative lint/build/test/smoke checks belong to verification command stages with bounded timeouts, and repair should only run after verification classifies a failure.
- Workflow verify commands are an allowlist, not always the exact run set: when a verification planner executor exists, give it the goal, changed files, and allowed checks so it can choose the smallest useful subset; use deterministic changed-path filtering only as fallback.
- Interview stages are DAG nodes: classify them from validated dependency edges, run post-verification interviews only after a passed verification contract, and keep their decisions out of planning while forwarding them to review and approval.
- Landing should be an LLM-owned composed action list: parse and classify exact Git argv, enforce hard safety invariants deterministically, and revalidate any recovery plan instead of rewriting a rejected strategy.
- Malformed LLM verification-planner output is a recoverable model failure: preserve the initial and repair responses, select the evidence-backed deterministic plan, and do not terminate the Factory run.
- Stage tool policy must be negotiated from an explicit provider inventory before session creation; never treat missing or unknown tools as available, and preserve denied skills so the model receives the recovery path.
- Dependency strategy should be LLM-owned but Factory-enforced: the model may choose workspace, package manager, and setup from evidence, while Factory applies hard setup limits, preflights blocking commands, and keeps `verification.json` authoritative over summary status.
- Dependency caches and generated worktrees can dominate run storage; cleanup must prune both retained run state and aged cache entries.
- Interview completion markers must be exact whole-response sentinels. Never let `INTERVIEW_COMPLETE` embedded in questions or model recommendations bypass the human decision gate.
- Dirty-working-tree landing guards must be deterministic: block before any Git mutation, assert the candidate remains available, and never let acceptance convert `merge-blocked` into `COMPLETED`; only the recovery choice is model/user-owned.
- Interview output must be bounded before it reaches the user: Markdown rules are not automatically question separators, and a model-echoed instruction document must be rejected rather than rendered as many fake questions.
- Interview models may emit multiple grilling rounds in one response; normalize to the first monotonically numbered round so the same questions are not presented repeatedly.
