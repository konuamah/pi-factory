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

- bind an interview skill with `skills.require`, such as `grilling`
- Factory pauses in a decision gate when the interview asks questions
- the user's answer is passed into the planner prompt

Use `command` for verification:

- lint
- typecheck
- test
- build
- project-specific scripts

Builder agents may run short, bounded local commands when needed to understand their own edits, but all run-blocking checks belong in `command` verification stages. Do not put smoke/e2e ownership in the builder contract. If a verification command can hang, configure it as a named check with `timeout` in seconds.

When a `verify` or `verification` stage lists `commands`, those names must match configured standard commands (`lint`, `typecheck`, `test`, `build`) or entries under `.factory/config.yaml` `commands.checks`. This list is the preferred policy set for that stage. When an LLM verification planner is available, Factory gives it the goal, the implementation files the builder actually changed, the configured checks, and safe repo-discovered commands so it can choose the smallest useful subset. It may select a safe discovered script that was not configured, but if it selects a configured command it must keep the configured check name. If no verification planner is available, Factory falls back to deterministic changed-path filtering over configured checks. If the command list is omitted, Factory allows all configured verification commands.

Use `approval` before irreversible or user-owned decisions.

Use `task-graph` only when a step should expand into subtasks.

## Pi Supervisory Mode

The packaged Pi extension supervises a normal interactive Pi coding-agent session through lifecycle hooks. In that mode Pi remains the executor: it owns the prompt loop, tool calls, file edits, and terminal commands. Factory does not start hidden Pi SDK agent sessions for normal interactive work.

The supervisor layer is advisory and session-local:

- user input is classified as inspect, plan, implement, verify, repair, review, or general
- the turn is mapped to an existing model role
- the configured provider/model is resolved through Pi's `ctx.modelRegistry`
- `setModel` is used to switch to the configured role model
- a compact turn contract is appended to the active prompt
- relevant skill and verification hints are limited to the current turn
- edit/write tool calls record touched files
- check-like shell commands and failed tool results are tracked as evidence
- `/supervisor status` shows the current session classification, model role, touched files, observed checks, and failures

If a Pi host does not expose these hooks, extension registration fails loudly. This mode intentionally targets supervisor-capable Pi hosts rather than command-only compatibility.

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
