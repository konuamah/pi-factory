# AGENTS.md

## Entry points
- Pi adapter: `packages/adapters/pi/src/gateway.ts`
- Core runtime: `packages/core/src/runtime/controller.ts`
- Verification logic: `packages/core/src/runtime/verification.ts`
- Config schema: `packages/schemas/src/config.ts`
- Runtime tests: `tests/runtime.test.mjs`

## Local norms
- Treat the harness as a universal software-engineering harness, not a framework-specific tool; all core abstractions, workflows, and validation should work across languages, frameworks, runtimes, and project structures, with ecosystem-specific behavior implemented only as optional adapters.
- Prioritize using the Pi SDK as the primary execution and integration layer for agent sessions, tools, and lifecycle events. Prefer native SDK primitives (session.abort, waitForIdle, lifecycle events, tool signal/timeout, SettingsManager) over custom replacements, while keeping Factory policy authoritative for hard limits.
- Timeout policy is deterministic harness code; what to do after a timeout is LLM decision. The LLM cannot extend or override resource limits. Tool timeouts, total runtime, and max turns are enforced by Factory, not by model output.
- Prefer project-adaptive behavior over repo-specific hard-coding.
- Verification, setup, and command execution must adapt to the target workspace structure: infer the package/app root, package manager, scripts, and generated-output ignores from evidence instead of assuming the repository root, pnpm, npm, or a single-package layout.
- Deterministic scanning should provide evidence; AI should decide ambiguous execution strategy.
- When designing or implementing features, think through the negative product path too: failure states, blocked states, recovery paths, misleading success states, and how the user will understand what happened.
- Keep files around 400 lines or under when practical. Split growing files along behavior seams before they become hard to reason about, unless there is a clear benefit to keeping a file larger.
- Ignore generated or transient workspace content when selecting repo guidance.
- Fail loud instead of using silent fallbacks, especially for model routing, skill execution, interview UI, workflow semantics, and verification commands. If the required capability is unavailable, surface the exact missing piece and stop.
- Never end a run because of an internal fallback, missing handler, exhausted retry, or ambiguous recovery result. A run may terminate only after an explicit user decision or an explicit, workflow-authorized terminal decision from the model; otherwise keep it active or blocked with the actionable reason and recovery path recorded.
- Persist generalized lessons in `learnings.md`.
- When Factory behavior, commands, setup, workflows, capabilities, runtime, or agent UX changes, update the relevant `docs/factory/` page and Factory skill instructions in the same change.
- When Factory behavior, commands, setup flows, workflows, capabilities, or agent-facing UX changes, update the relevant `docs/factory/` reference and the Factory Concierge skill instructions in the same change so docs, skills, and implementation stay aligned.
- Commit documentation, AGENTS.md, and any relevant docs/skills changes together with every implementation change. Do not leave documentation as a separate follow-up step.
