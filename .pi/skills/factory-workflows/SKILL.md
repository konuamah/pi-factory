---
name: factory-workflows
description: Design, inspect, create, and set Factory workflows.
---

# Factory Workflows

Use this when the user asks about Factory workflows, stages, approvals, interviews, verification, or default workflow selection.

Workflow files use a registry shape: top-level `defaultWorkflowId` plus `workflows`. Each workflow has `id`, `name`, optional `description`, and `stages`. Do not create a top-level `stages:` block.

Stage types are `agent`, `interview`, `command`, `approval`, and `task-graph`. Agent and interview stages may specify model-routing roles: `discovery`, `planner`, `builder`, `reviewer`, `repair`, or `landing`. There is no `interviewer` role; interview stages normally use `role: planner`. Dependencies use `dependsOn` stage names and must form a DAG.

When adding an interview stage, use the bundled `grilling` skill. Bind it with `skills.require: [grilling]`.

For multiple-choice grilling questions with an `Options:` block, Factory should keep Pi's native select UI when available, but the select title must include the current question so users can see what they are answering.

Agent and interview stages may bind skills explicitly:

```yaml
skills:
  require: [grilling]
  prefer: [some-skill]
  exclude: [other-skill]
```

`require` fails loudly if missing, `prefer` includes a skill only when available, and `exclude` removes a skill from automatic selection. Command and approval stages ignore skills.

Final approval is a post-review gate. When creating or editing workflows, place a reviewer stage immediately before any `approval` stage and set `approval.dependsOn` to that review stage so acceptance never runs without completed review evidence. The default workflow and the setup presets (`fast`, `safe`, `balanced`) already follow this order; preserve it when you customize them. A run that ends in `review-unavailable` means Factory refused to open final approval because neither deterministic review nor a reviewer executor produced review evidence.

Use `/factory workflow list`, `/factory workflow show <workflow-id>`, `/factory workflow create`, and `/factory workflow set-default <workflow-id>` for interactive workflow operations. Ask before changing the default workflow or replacing existing workflows.
