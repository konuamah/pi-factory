# Factory Agent Docs

This folder is the knowledge library for agents operating Factory. Use it when a user wants Factory customized, repaired, explained, or made ready for a project.

Factory is a Pi-native project automation layer. It keeps project-local configuration, routes work through workflows, uses Pi models and skills, tracks run state, and maintains a repository constitution for agent context.

## How Agents Should Use This Library

1. Start with the user's request.
2. Read only the relevant doc below.
3. Inspect the current project state before editing.
4. Prefer existing `/factory` commands for interactive or broad flows.
5. Edit Factory-owned files directly when the requested change is clear.
6. Verify with `/factory doctor`, `/factory status`, or the relevant command.

## Start Here

| User asks | Read | Usual action |
| --- | --- | --- |
| "Set everything up" | [setup-operations.md](setup-operations.md) | Run `/factory setup` or reconcile config |
| "Make a workflow" | [workflow-authoring.md](workflow-authoring.md) | Use `/factory workflow create` or edit `factory.yaml` |
| "Fix my model" | [model-routing.md](model-routing.md) | Inspect `/factory models` and Pi defaults |
| "Turn on dashboard" | [dashboard.md](dashboard.md) | Edit `.factory/config.yaml`, then `/factory dashboard start` |
| "Add skills" | [skills-library.md](skills-library.md) | Create/update project skill files |
| "Refresh repo memory" | [constitution.md](constitution.md) | Use `/factory constitution` when needed |
| "Can you do this safely?" | [permissions-and-safety.md](permissions-and-safety.md) | Apply approval and verification rules |
| "Something broke" | [troubleshooting.md](troubleshooting.md) | Diagnose by symptom |
| "Show examples" | [examples.md](examples.md) | Follow a worked pattern |

## Core References

- [concepts.md](concepts.md) — Factory mental model and terms.
- [setup-operations.md](setup-operations.md) — full setup, tuning, and readiness.
- [workflow-authoring.md](workflow-authoring.md) — workflow design and YAML shape.
- [model-routing.md](model-routing.md) — Pi providers, defaults, and role models.
- [skills-library.md](skills-library.md) — skill locations and authoring.
- [dashboard.md](dashboard.md) — dashboard config and runtime.
- [constitution.md](constitution.md) — repository memory and refresh policy.
- [permissions-and-safety.md](permissions-and-safety.md) — edit authority and approvals.
- [troubleshooting.md](troubleshooting.md) — common failures.
- [examples.md](examples.md) — complete user request examples.
