# Factory Internal Docs

This folder is the internal engineering reference for the Factory codebase. Use it when changing Factory itself, debugging implementation behavior, or preserving source-level design history.

Factory is a Pi-native project automation layer. It keeps project-local configuration, routes work through workflows, uses Pi models and skills, tracks run state, and maintains a repository constitution for agent context.

## Local Factory Install

During development, install the local Factory checkout into Pi:

```bash
pi install /path/to/pi-factory
```

For project-local testing:

```bash
cd /path/to/your-project
pi install -l /path/to/pi-factory
```

If `pi` is not on `PATH`:

```bash
/path/to/pi install -l /path/to/pi-factory
```

Local path installs are references, so Pi sees changes from the checkout without npm publishing. After TypeScript source changes, run `npm run build` and restart Pi; reinstall only when the package path changes or the `package.json` `pi` manifest changes.

## Runtime Concierge Guidance

User-facing Factory Concierge guidance lives in focused `.pi/skills/factory-*` operational skills. Concierge is the orchestrator: it selects the relevant operational skill, then uses Factory setup context, command output, config, and tool/API contracts to choose an allowed support action.

Do not treat this docs folder as the primary runtime reference for Concierge. Use it as fallback only when developing Factory itself, debugging implementation behavior, or answering an explicit source-level question.

## How Factory Maintainers Should Use This Library

Read [AGENT.md](AGENT.md) first when changing Factory code or internal docs.

1. Start with the user's request.
2. Read only the relevant doc below.
3. Inspect the current project state before editing.
4. Prefer existing `/factory` commands for interactive or broad flows when validating behavior.
5. Edit Factory-owned files directly when the requested change is clear.
6. Verify with `/factory doctor`, `/factory status`, or the relevant command.

Operational skills are the primary Concierge runtime reference layer. Docs are the internal Factory engineering reference. Inspect `src/` only for missing docs, implementation debugging, or explicit code questions. Never use `dist/`, `node_modules/`, build output, coverage output, generated files, or transient worktrees as behavioral references.

## Start Here

| User asks | Read | Usual action |
| --- | --- | --- |
| "Set everything up" | [setup-operations.md](setup-operations.md) | Run `/factory setup` or reconcile config |
| "Make a workflow" | [workflow-authoring.md](workflow-authoring.md) | Use `/factory workflow create` or edit `factory.yaml` |
| "Do runs need worktrees?" | [worktrees-and-dependencies.md](worktrees-and-dependencies.md) | Explain `git.allowWorktrees` and dependency hydration |
| "Dependency setup is slow" | [worktrees-and-dependencies.md](worktrees-and-dependencies.md) | Configure shared cache hydration |
| "Fix my model" | [model-routing.md](model-routing.md) | Inspect `/factory models` and Pi defaults |
| "Turn on dashboard" | [dashboard.md](dashboard.md) | Edit `.factory/config.yaml`, then `/factory dashboard start` |
| "Add skills" | [skills-library.md](skills-library.md) | Create/update project skill files |
| "Refresh repo memory" | [constitution.md](constitution.md) | Use `/factory constitution` when needed |
| "Can you do this safely?" | [permissions-and-safety.md](permissions-and-safety.md) | Apply approval and verification rules |
| "Something broke" | [troubleshooting.md](troubleshooting.md) | Diagnose by symptom |
| "Show examples" | [examples.md](examples.md) | Follow a worked pattern |
| "Set up quality testing" | [quality-testing.md](quality-testing.md) | Use Harbor tasks and verifiers |
| "Benchmark Factory orchestration" | [bombsite-benchmark-plan.md](bombsite-benchmark-plan.md) | Approved plan: Harbor + scripted interviews + six-pillar scorer |
| "Run the benchmark" | [benchmark-running.md](benchmark-running.md) | Operations: prerequisites, the 3 commands, troubleshooting |
| "How did Factory perform?" | [case-study-landoptima-status-bar.md](case-study-landoptima-status-bar.md) | Inspect a real completed run |
| "Fix stage handoffs" | [stage-handoff-remediation-plan.md](stage-handoff-remediation-plan.md) | Follow the remediation rollout |
| "How do the complexity refactors run?" | [complexity-refactoring-wave-1.md](complexity-refactoring-wave-1.md) | Follow the wave protocol |
| "What's the complexity refactoring protocol?" | [complexity-refactoring-protocol.md](complexity-refactoring-protocol.md) | Read before any wave |

## Core References

- [AGENT.md](AGENT.md) - reference order, ignored paths, and operational doc pattern.

- [concepts.md](concepts.md) — Factory mental model and terms.
- [setup-operations.md](setup-operations.md) — full setup, tuning, and readiness.
- [worktrees-and-dependencies.md](worktrees-and-dependencies.md) — worktree isolation, dependency hydration, and shared caches.
- [workflow-authoring.md](workflow-authoring.md) — workflow design and YAML shape.
- [model-routing.md](model-routing.md) — Pi providers, defaults, and role models.
- [skills-library.md](skills-library.md) — skill locations and authoring.
- [dashboard.md](dashboard.md) — dashboard config and runtime.
- [constitution.md](constitution.md) — repository memory and refresh policy.
- [permissions-and-safety.md](permissions-and-safety.md) — edit authority and approvals.
- [troubleshooting.md](troubleshooting.md) — common failures.
- [examples.md](examples.md) — complete user request examples.
