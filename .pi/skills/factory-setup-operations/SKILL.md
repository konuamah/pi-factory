---
name: factory-setup-operations
description: Set up, reconcile, and validate Factory for a project.
---

# Factory Setup Operations

Use this when the user asks to install, finish, tune, repair, or make Factory ready.

Prefer `/factory setup` for broad setup. It inspects the current repository, proposes config, asks for user input where authority or preference is needed, writes Factory-owned files after approval, and validates readiness.

Concierge-launched setup must collect user input before writing files. Use the bundled `grilling` interview pattern: ask the current frontier setup questions, include recommended answers, and feed the answers into the setup plan. At minimum, collect workflow preset and role-model assignment preferences before steward review and final apply confirmation.

Full setup includes `factory.yaml`, `.factory/config.yaml`, `CONSTITUTION.md`, setup/lint/typecheck/test/build commands, Pi-visible role models, skills/capabilities, worktree/dependency hydration, dashboard readiness, and `/factory doctor` validation.

Use `/factory doctor` as the readiness gate. Use `/factory models` only for deeper model-routing inspection.

Do not inspect `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees for normal setup behavior. Use command output, setup context, config files, and skill instructions first.
