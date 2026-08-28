# Supervisory Pi Extension Implementation Plan

Build a supervisory Pi extension that augments normal Pi coding-agent sessions. Pi remains the agent. The extension supervises model routing, skill relevance, workflow guidance, verification expectations, and failure diagnosis.

This path does not use the Pi SDK as the main execution engine. The extension should not create hidden agent sessions for normal work. It should use Pi lifecycle hooks around the active interactive session, and Pi should keep ownership of prompting, tool execution, edits, and terminal interaction.

## Goal

```text
User prompts Pi normally.
The extension observes the prompt and session.
It injects useful context and policy.
Pi still performs the coding work with native tools.
```

## Phase 1: Define The Extension Boundary

Create one Pi extension package with this internal shape:

```text
src/
  extension.ts              # Pi hook registration only
  state/session-state.ts    # per-session supervisor state
  routing/model-router.ts   # model selection
  workflow/turn-contract.ts # phase guidance
  skills/skill-selector.ts  # contextual skill selection
  verification/planner.ts   # expected checks/evidence
  verification/evidence.ts  # observe tool results
  diagnostics/classifier.ts # failure diagnosis
  ui/status.ts              # small status widget/output
```

Rule:

```text
extension.ts talks to Pi hooks
all other modules are Pi-agnostic decision logic
no hidden SDK-run agent sessions for normal interactive work
```

## Phase 2: Add Session State

Track lightweight state per Pi session:

```ts
interface SupervisorState {
  prompt?: string;
  taskType?: "question" | "small_edit" | "feature" | "bugfix" | "review" | "unknown";
  phase: "idle" | "plan" | "implement" | "verify" | "repair" | "done";
  selectedModel?: string;
  selectedSkills: string[];
  verification?: VerificationPlan;
  evidence: VerificationEvidence[];
  diagnosis?: FailureDiagnosis;
  changedAfterVerification: boolean;
}
```

Store this in memory first. Add persistence later only if needed.

## Phase 3: Hook Into User Input

Use Pi's `input` hook.

Purpose:

```text
read user prompt
classify task
choose initial phase
select candidate model
select candidate skills
draft verification plan
```

Classifier v1 should be deterministic:

```text
contains "review" / "audit" -> review
contains "fix" / error text -> bugfix
contains "add" / "implement" -> feature/small_edit
contains "why" / "explain" -> question
otherwise -> unknown
```

Do not call an LLM for this at first.

Implemented first slice:

- `packages/adapters/pi/src/supervisor.ts` classifies input.
- `registerSupervisoryPiHooks` requires compatible lifecycle hooks.
- If those hooks are absent, registration fails loudly because this branch targets Pi supervision, not command-only compatibility.
- Hook registration now uses Pi's real event API: `pi.on("input")`, `pi.on("before_agent_start")`, `pi.on("tool_call")`, `pi.on("tool_result")`, and `pi.on("agent_end")`.

## Phase 4: Model Routing

Implement simple model roles:

```ts
interface ModelRoute {
  role: "fast" | "coding" | "reasoning" | "review";
  provider?: string;
  model: string;
  reason: string;
}
```

Initial policy:

```text
question/docs        -> fast model
small edit           -> coding/fast model
feature/refactor     -> reasoning or stronger coding model
review/security      -> reasoning/review model
repair after failure -> coding or reasoning depending on failure
```

Routing happens before the turn starts, not inside every tool loop.

If the selected model is unavailable:

```text
do not block Pi
show warning
continue with current Pi model
```

Implemented first slice:

- turn kind maps to existing model roles: discovery, planner, builder, reviewer, repair
- the supervisor asks the existing model routing config for that role, resolves the provider/model through `ctx.modelRegistry.find(...)`, then switches with `pi.setModel(...)`

## Phase 5: Turn Contract Injection

Use `before_agent_start`.

Inject a compact contract like:

```text
Supervisor context

Task type: small code edit
Suggested phase: implement

Instructions:
- Keep the change scoped.
- Inspect relevant files before editing.
- Do not modify unrelated files.

Verification expected:
- Run the narrowest relevant check.
- Inspect final diff.
- Do not claim success without evidence.
```

Keep it short. This should guide Pi, not drown it.

Implemented first slice:

- the input hook appends a compact "Pi supervisory guidance" contract to the active prompt
- the contract includes turn kind, model role, relevant skill hints, verification hints, recent touched files, and phase reminders

## Phase 6: Contextual Skill Selection

Do not dump full skill bodies.

Build a skill index:

```ts
interface SkillSummary {
  name: string;
  description: string;
  path?: string;
  tags?: string[];
}
```

Select top 0-3 skills from prompt and repo signals.

Inject:

```text
Relevant skills:
- react-component-testing
- nextjs-app-router

Read these only if needed.
```

Later, use Pi `resources_discover` or resource loader hooks to expose only relevant skills.

## Phase 7: Verification Planner

Before implementation begins, create a lightweight verification plan:

```ts
interface VerificationPlan {
  requiredEvidence: string[];
  suggestedCommands: Array<{
    command: string;
    reason: string;
    risk: "low" | "medium" | "high";
  }>;
  finalInspection: string[];
}
```

Evidence sources, in order:

```text
project instructions
package.json scripts
Makefile/task runner
nearby tests
CI config
language defaults
```

For simple tasks, keep it small:

```text
small UI copy/style change -> inspect diff + maybe build
single component logic     -> targeted test + typecheck
backend behavior change    -> targeted unit/integration test
```

## Phase 8: Observe Tool Calls

Use `tool_call`.

Only observe or optionally block unsafe actions.

Track:

```text
read files
edited files
bash commands
test commands
git commands
```

Implemented first slice:

- edit/write-like tool calls record touched files
- bash-like check commands record observed verification attempts

Do not execute tools yourself.

Optional first policy gate:

```text
block destructive commands:
rm -rf
git reset --hard
git clean -fd
sudo
deployment commands
```

Everything else can remain advisory at first.

## Phase 9: Observe Tool Results

Use `tool_result`.

Extract:

```text
command passed/failed
stderr/stdout snippets
test names
build errors
dependency errors
provider errors
files changed after tests
```

Update verification evidence:

```text
npm test passed -> evidence recorded
edit after test -> previous test evidence stale
typecheck failed -> diagnosis candidate
```

This is where the extension becomes useful without becoming the agent.

## Phase 10: Failure Diagnosis

Create a deterministic classifier first:

```ts
type FailureCategory =
  | "test_failure"
  | "compile_failure"
  | "missing_dependency"
  | "provider_error"
  | "permission_error"
  | "timeout"
  | "command_not_found"
  | "unknown";
```

Examples:

```text
"command not found: python" -> command_not_found
"Cannot find module"        -> missing_dependency
"TS2307"                    -> compile_failure
"Expected ... Received"     -> test_failure
"402 Insufficient Balance"  -> provider_error
```

On the next `context` hook, inject:

```text
Failure diagnosis:
The last command failed because Python is unavailable as `python`.
Try `python3 -m pytest` or inspect project setup before rerunning.
```

## Phase 11: Verification Reminders

Use Pi's `context` hook before later LLM calls.

Inject only if needed:

```text
Verification status:
- source changed: yes
- final diff inspected: no
- targeted tests run: no
- last failure: missing dependency

Do not conclude yet unless you either verify or explain why verification is blocked.
```

This prevents "done" claims without taking control away from Pi.

## Phase 12: Status UI

Add a small status panel or command:

```text
/supervisor status
```

Show:

```text
task type
selected model
selected skills
phase
changed files
verification evidence
latest diagnosis
```

Keep it operator-friendly.

## Phase 13: MVP Cut

Build only this first:

```text
1. input classification - implemented
2. model suggestion/switch - implemented through required setModel
3. turn contract injection - implemented
4. top-3 skill hints - implemented
5. verification plan - started as verification hints
6. observe bash/edit results - implemented
7. failure diagnosis - started as failed tool result tracking
8. verification reminder - implemented in contract
9. status command - implemented as `/supervisor status`
```

Do not build yet:

```text
hidden agents
full workflow runner
parallel DAG
worktrees
database
complex retry engine
automatic repair loops
```

## Success Test

Run the same task three ways:

```text
Pi alone
Pi + supervisor hints
Pi + supervisor hints + failure diagnosis
```

Measure:

```text
Did it choose the right model?
Did it use less irrelevant context?
Did it avoid unrelated edits?
Did it run appropriate checks?
Did it explain failures correctly?
Did it avoid retrying the same failed command blindly?
```

The guiding rule:

```text
Pi acts.
The extension supervises.
The user stays in control.
```
