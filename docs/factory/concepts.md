# Factory Concepts

Factory is a project-local automation system for Pi. It helps agents plan work, run checks, repair failures, review changes, and keep repository knowledge current.

## Configuration

Factory reads configuration in this order:

```text
built-ins < global defaults < project config < workflow/run overrides
```

Project files:

- `factory.yaml` — workflows and default workflow selection.
- `.factory/config.yaml` — project config: commands, models, git, repair, approvals, dashboard.
- `CONSTITUTION.md` — evidence-backed repository memory for agents.
- `.factory/runs/` — run state and artifacts.

## Workflows

A workflow is a sequence or DAG of steps. Steps may be:

- `agent` — ask a model to plan, build, review, or repair.
- `command` — run configured checks or shell commands.
- `approval` — pause for human approval.
- `task-graph` — split larger work into smaller tasks.

Every custom step should have a purpose/description so agents are not guessing from names alone.

## Models

Factory role models are planner, builder, reviewer, and repair. It should prefer the user's configured Pi default/provider models before built-in fallback names.

## Skills

Skills are reusable agent playbooks. Factory scans project and user skill directories so agents can bring existing workflows into Factory behavior.

## Dashboard

The dashboard is a local read-only web server for Factory status, runs, logs, constitution, models, skills, and checks. It starts manually with `/factory dashboard start` or automatically when `dashboard.enabled: true`.

## Constitution

The constitution is Factory's repository memory. It records facts and conventions from evidence. Agents should use it as context, not as a replacement for inspecting relevant code.
## Runtime policy decisions

Policy decisions are LLM-owned, but execution safety is Factory-owned. A
`RuntimePolicyExecutor` returns `continue`, `retry`, `revise`, `repair`,
`rerunImplementation`, or `abort`, with evidence, feedback, and an attempt.
Factory validates the decision against retry budgets, allowed phase transitions,
available repair capability, rerunnable task state, dirty-worktree safety, and
resource ceilings before applying it. Invalid decisions are re-prompted and
eventually fail loud with the violated constraint recorded.

The validated decision is written to the normal decision ledger and run event
stream, so resume and audit behavior remain unchanged. Without a policy
executor, existing human decision handlers remain available.
