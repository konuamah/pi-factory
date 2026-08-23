# learnings.md

- When repository topology is ambiguous, use deterministic discovery to gather candidate roots/scripts, then use a reasoning step to choose execution strategy.
- Verification failures should be separated into harness/config selection issues versus real project code issues.
- Do not treat transient worktree content as authoritative long-term project guidance.
- Persist verification reasoning artifacts so cwd, command selection, and failure classification can be inspected later in logs/show output.
- Resume policy should react to failure classification: re-plan verification for harness/config or repo-script issues, and resume repair/verification for real code failures.
