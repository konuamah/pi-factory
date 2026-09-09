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

`factory.yaml` must use the workflow registry shape:

- top-level `defaultWorkflowId`
- top-level `workflows`
- each workflow defines its own `stages`

Do not create a top-level `stages:` list. Factory resolves runs from the workflow registry, so a top-level `stages:` block can be ignored and cause intended steps, including interviews, to be skipped.

Each workflow needs:

- `id`
- `name`
- optional `description`
- `stages`

Each stage should include:

- `name`
- `description`
- `type`: `agent`, `interview`, `command`, `approval`, or `task-graph`
- `dependsOn` when not the first step
- `role` for agent steps when known
- `commands` for command steps
- `model` only when the step truly needs a role override
- `skills` when the workflow must explicitly bind skills to an agent step

## Step Types

Use `agent` for model work:

- planner: planning and repo reasoning
- builder: implementation only
- reviewer: risk review
- repair: fix verification failures after command/contract checks run

Use `interview` before planning when Factory must ask the user questions first.

- bind the bundled interview skill with `skills.require`, such as `grilling`
- Factory pauses in a decision gate when the interview asks questions
- the user's answer is passed into the planner prompt and persisted as a structured record in `interview-decisions.json`
- that structured record reaches builder context, the reviewer prompt, and approval, not just the planner
- Factory bundles the interview skill as `skills/grilling`; bind `skills.require: [grilling]` directly

Stage dependencies are resolved by stage name into task ids. A task with `dependsOn: [plan]` includes the planner task as dependency context for the builder, and direct task ids also work.

Use `command` for verification:

- lint
- typecheck
- test
- build
- project-specific scripts

Builder agents may run short, bounded local commands when needed to understand their own edits, but all run-blocking checks belong in `command` verification stages. Do not put smoke/e2e ownership in the builder contract. If a verification command can hang, configure it as a named check with `timeout` in seconds.

When a `verify` or `verification` stage lists `commands`, those names must match configured standard commands (`lint`, `typecheck`, `test`, `build`) or entries under `.factory/config.yaml` `commands.checks`. This list is the allowed verification set for that stage. When an LLM verification planner is available, Factory gives it the goal, changed files, and allowed checks so it can choose the smallest useful subset. If no verification planner is available, Factory falls back to deterministic changed-path filtering. If the command list is omitted, Factory allows all configured verification commands.

Use `approval` before irreversible or user-owned decisions.

Use `task-graph` only when a step should expand into subtasks.

## Explicit Skills

Agent and interview stages may bind skills explicitly:

```yaml
skills:
  require: [implementation-task]
  prefer: [repo-interpretation]
  exclude: [slamm-copy-humanizer]
```

- `require`: the skill must exist or the stage fails loudly before execution.
- `prefer`: include the skill if it exists; continue if it does not.
- `exclude`: remove matching automatically selected skills from this stage.

Explicit skills merge with Factory's automatic skill selection for that node. `plan` and `discover` stage skills also apply to Factory's built-in planning/discovery prompts. Command and approval stages ignore skills.

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
        skills:
          prefer: [repo-interpretation]
      - name: build
        description: "Implement the approved change."
        type: agent
        role: builder
        dependsOn: [plan]
        skills:
          require: [implementation-task]
          prefer: [repo-interpretation]
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
        skills:
          require: [acceptance-review]
      - name: approval
        description: "Ask before final merge or completion."
        type: approval
        dependsOn: [review]
```

## Interview Example

```yaml
defaultWorkflowId: grilled-feature
workflows:
  - id: grilled-feature
    name: "Grilled Feature Work"
    stages:
      - name: discover
        type: agent
        role: discovery
      - name: interview
        type: interview
        role: planner
        dependsOn: [discover]
        skills:
          require: [grilling]
      - name: plan
        type: agent
        role: planner
        dependsOn: [interview]
      - name: build
        type: agent
        role: builder
        dependsOn: [plan]
      - name: approval
        type: approval
        dependsOn: [build]
```

Use `prefer: [grilling]` when the planner should see the skill instructions but does not need to interrupt the run. Use `type: interview` plus `require: [grilling]` when Factory must stop and collect answers before planning.

After editing, run `/factory doctor`.
