# AGENTS.md

## Entry points
- Pi adapter: `packages/adapters/pi/src/gateway.ts`
- Core runtime: `packages/core/src/runtime/controller.ts`
- Verification logic: `packages/core/src/runtime/verification.ts`
- Config schema: `packages/schemas/src/config.ts`
- Runtime tests: `tests/runtime.test.mjs`

## Local norms
- Prefer project-adaptive behavior over repo-specific hard-coding.
- Deterministic scanning should provide evidence; AI should decide ambiguous execution strategy.
- Ignore generated or transient workspace content when selecting repo guidance.
- Persist generalized lessons in `learnings.md`.
