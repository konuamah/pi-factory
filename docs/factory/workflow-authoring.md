# Workflow Authoring

Use this when creating or editing `factory.yaml`.

## Choose Interactive vs Direct Editing

Use `/factory workflow create` when the user wants a guided TUI.

Edit `factory.yaml` directly when the user clearly describes:

- workflow purpose
- steps
- checks
- approval points
- default workflow preference

## Workflow Shape

Each workflow needs:

- `id`
- `name`
- optional `description`
- `stages`

Each stage should include:

- `name`
- `description`
- `type`: `agent`, `command`, `approval`, or `task-graph`
- `dependsOn` when not the first step
- `role` for agent steps when known
- `commands` for command steps
- `model` only when the step truly needs a role override

## Step Types

Use `agent` for model work:

- planner: planning and repo reasoning
- builder: implementation
- reviewer: risk review
- repair: fix failed checks

Use `command` for verification:

- lint
- typecheck
- test
- build
- project-specific scripts

Use `approval` before irreversible or user-owned decisions.

Use `task-graph` only when a step should expand into subtasks.

## Example

```yaml
defaultWorkflowId: safe-feature
workflows:
  - id: safe-feature
    name: "Safe Feature Work"
    description: "Plan, build, verify, review, then ask before merge."
    stages:
      - name: plan
        description: "Understand the user request and produce a scoped plan."
        type: agent
        role: planner
      - name: build
        description: "Implement the approved change."
        type: agent
        role: builder
        dependsOn: [plan]
      - name: verify
        description: "Run configured project checks."
        type: command
        commands: ["lint", "typecheck", "test", "build"]
        dependsOn: [build]
      - name: review
        description: "Review risk and acceptance."
        type: agent
        role: reviewer
        dependsOn: [verify]
      - name: approval
        description: "Ask before final merge or completion."
        type: approval
        dependsOn: [review]
```

After editing, run `/factory doctor`.
