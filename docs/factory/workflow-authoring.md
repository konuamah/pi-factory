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
- `type`: `agent`, `interview`, `command`, `approval`, `acceptance`, or `task-graph`
- `dependsOn` when not the first step
- `role` for agent steps when known
- `commands` for command steps
- `model` only when the step truly needs a role override
- `skills` when the workflow must explicitly bind skills to an agent step
- `allowedTools` and `denyTools` when the stage needs a tool policy; `denyTools` always wins

Tool policy is negotiated with selected skill requests, resolved safety policy,
and the provider inventory before the agent session is created. Unknown or
unavailable tools are reported with recovery guidance; they are never silently
granted or used as a reason to end the run.

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
- empty interview answers are recorded as skipped questions instead of failing the run: they appear in `interview-decisions.json` with `skipped: true` and in the planner context as `A<N>: [skipped]`
- if every interview question is skipped, the planner may proceed only when the task and Discovery evidence are sufficient. If the planner cannot safely infer the user's intent, it must return `INTERVIEW_SKIPPED_NEEDS_CLARIFICATION: <reason>`, which Factory reports as a planning failure with a clear clarification message rather than guessing
- that structured record reaches builder context, the reviewer prompt, and approval, not just the planner
- final review also receives a scoped review surface built from `completed-tasks.json`, the candidate diff, direct imports/dependencies, `plan.json` `implementationContract`, and `verification.json`; trivial low-risk changes may skip the LLM reviewer entirely via deterministic review
- the reviewer's prose verdict is classified from its conclusion into a `review.verdict` event (`block` | `pass` | `unknown`), and a blocking verdict is surfaced in the final approval gate — with no confirm UI, Factory refuses to silently auto-approve past a blocking review
- final acceptance is a **post-landing gate**: the lean flow is `plan approval → build → verify → review → landing → acceptance`.
- Factory bundles the interview skill as `skills/grilling`; bind `skills.require: [grilling]` directly

Interview stages can also run at arbitrary DAG points. An interview with `dependsOn: [verify]` or
`dependsOn: [verification]` runs after verification passes and before review; its answer is sent to
review and approval only, never back into planning or building. Execution order comes from
`dependsOn`, not the interview's `role`.

```yaml
- name: post_verify_interview
  type: interview
  role: planner
  dependsOn: [verify]
```

Factory rejects unknown dependencies, dependency cycles, unreachable stages, and approval/acceptance
stages that do not depend on a reviewer stage.

When the model returns several questions in one decision (separated by `---` in the interview prompt output), the Pi adapter presents them one at a time — a full editor when the host exposes it, otherwise an overlay — and folds every answer into a single structured interview record, so planning still receives one `interview-decisions.json` entry per interview stage.

Interview questions may also include an optional structured multiple-choice block inside the question text:

```text
Q1 - Search strategy: Which implementation should govern?
Options:
[A] MongoDB text search — Simpler and uses existing indexes
[B] Regex fallback — Broader but less precise
-> Prefer MongoDB text search unless ranking semantics require more.
```

When `Options:` is present, the Pi interview UI prefers Pi's built-in selection UI and includes the current question in the select title plus a built-in `Custom answer…` path; if that UI is unavailable, Factory falls back to its custom overlay selector. The selected choice is recorded both in the human-readable interview answer text and in structured per-question fields inside `interview-decisions.json`; open-ended questions without `Options:` keep the existing free-text flow.

Runtime recovery uses the same decision ledger idea for problems that appear after planning. A recoverable discovery, planning, implementation, integration, verification-planning, review, approval, landing, or post-landing verification problem can pause as a `RUNTIME` / `FAILURE_RECOVERY` decision with multiple-choice actions and optional notes. These recovery gates are controller-owned, not workflow stages, so workflow authors do not need to add them manually.

Stage dependencies are resolved by stage name into task ids. A task with `dependsOn: [plan]` includes the planner task as dependency context for the builder, and direct task ids also work.

Runtime recovery wording can be configured with `failureRecovery.narratorModel: { provider, model }`. Set `failureRecovery.disableNarrator: true` when deterministic wording is preferred; recovery actions and state-machine behavior are unchanged either way.

Planner output is also extracted into `plan.json` `implementationContract` fields: `targetFiles`, `implementationSteps`, `verificationChecks`, `nonGoals`, `risks`, and `blockers`. Builder context treats that contract as authoritative and should not broadly rediscover target files when the planner named concrete files and ordered steps. The planner should also state a `CHANGE REQUIREMENT` section (`Status: required | not-required | uncertain` with `Baseline gap:` and `Required change:` bullets) so a plan that finds the behavior already implemented records that fact explicitly instead of forcing builder edits.

Builder role rules and the compiled builder prompt are "edit from contract": the workspace is presented as already prepared, the builder reads only handoff-named target files (plus their direct imports when required), then edits, then runs the specified verification. README inspection, repository history/git archaeology, broad search, and dependency reinstall are explicitly out unless a concrete tool failure demands them. A missing named file or un-executable contract yields `CONTRACT_BLOCKED <reason>` instead of silent rediscovery. If the requested behavior is already satisfied by the target files, the builder stops and returns `CONTRACT_NOOP <reason>` rather than creating cosmetic, unrelated, verification-only, or formatting-only edits, and must not modify source temporarily to work around a port, dependency, process, or environment problem. Broad lint, build, and test checks belong to the verification stage, not the builder, which runs only verification commands named in the implementation contract.

The controller classifies the builder result into `implemented`, `contract-noop`, `contract-blocked`, `no-change-unclear`, or `executor-failed`. `contract-noop` and `contract-blocked` do not retry and end the run `BLOCKED` with phase `implementation-blocked`, keeping the builder execution artifact and reason; an unexplained completed result with no changes still retries once before failing with a specific reason.

Planner implementation steps should name exact read targets and include an explicit stop condition ("Stop discovery after N check(s):") so the builder does not treat inspection as open-ended. The context budget keeps human decisions and the planner handoff whole at any budget, truncating only general project guidance, so an authoritative interview answer is never silently cut out of a builder prompt.

Factory preserves the raw user goal in run artifacts for audit, but model-facing task prompts use a cleaned task objective when the raw goal contains a pasted Pi prompt template such as Planner Mode or Builder Mode. This prevents role-wrapper text like "do not write production code" from leaking into Builder prompts while keeping the original request inspectable.

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

Agent and interview stages may specify model-routing roles: `discovery`, `planner`, `builder`, `reviewer`, `repair`, or `landing`. There is no `interviewer` role; interview stages normally use `role: planner`.

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
      - name: verify
        type: command
        commands: ["lint", "typecheck", "test", "build"]
        dependsOn: [build]
      - name: review
        type: agent
        role: reviewer
        dependsOn: [verify]
      - name: approval
        type: approval
        dependsOn: [review]
```

Use `prefer: [grilling]` when the planner should see the skill instructions but does not need to interrupt the run. Use `type: interview` plus `require: [grilling]` when Factory must stop and collect answers before planning.

After editing, run `/factory doctor`.

## Composed landing plans

Landing is an LLM-owned ordered plan of typed Git actions (or a GitHub pull-request action). Factory parses and validates every Git argv, classifies destructive and remote effects, and then executes the exact validated argv without replacing the model's choice. Plans that can discard dirty work, invoke external processes, or push to an unauthorized remote are rejected. Recovery must produce a new plan that is validated again.
Runtime policy is a controller boundary, not a workflow-stage concern. Models
may select the next policy action, but workflows cannot bypass Factory's hard
limits, evidence checks, repair capability checks, or Git safety invariants.
