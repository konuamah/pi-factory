# Pi Supervisory Extension Overview

## What We Are Building

We are building a supervisory extension for Pi's interactive coding agent.

Pi remains the coding agent. The user still opens Pi, writes normal prompts, watches Pi reason, lets Pi call tools, and lets Pi edit files. The extension sits around that live session and helps Pi make better operational decisions before and during the turn.

The extension is not the main executor. It does not replace Pi's tool loop. It does not spin up hidden SDK sessions for normal work. It adds routing, context, verification discipline, and failure awareness to the Pi session the user is already using.

## The Core Idea

```text
User prompt
  -> supervisor reads the intent
  -> supervisor selects a model role
  -> supervisor injects compact guidance
  -> Pi performs the work
  -> supervisor observes edits, checks, and failures
  -> Pi gets better next-turn guidance
```

This keeps the experience natural: the user still talks to Pi directly, but Pi gets a session-level control plane that remembers what is happening and nudges the work toward safer execution.

## Why This Exists

Plain coding agents are powerful, but they often struggle with operational discipline:

- using a model that is too weak or too expensive for the current turn
- loading too much irrelevant context
- running checks that are too broad for a small change
- skipping verification after editing
- retrying the same failed command without understanding the failure
- starting smoke tests or dev servers without cleanup
- mixing implementation, verification, and repair responsibilities

The supervisor exists to make those decisions explicit without taking the coding work away from Pi.

## What Pi Owns

Pi owns the actual agent loop:

- user conversation
- model responses
- tool calls
- file reads
- file edits
- terminal commands
- interactive coding behavior
- final explanation to the user

The extension should not fight Pi for control of these things.

## What The Supervisor Owns

The supervisor owns lightweight session guidance:

- classify the user prompt
- choose the model role for the turn
- select relevant skill hints
- inject a short turn contract
- recommend appropriate verification
- track files edited during the session
- track check commands that ran
- track failed tool results
- warn when evidence is missing or stale
- diagnose obvious failure categories

It is a control plane, not a second coding agent.

## Main Execution Rule

```text
Do not use the Pi SDK to run hidden agent sessions for normal interactive work.
Use Pi lifecycle hooks around the active Pi session.
```

The SDK can still be useful for experiments, tests, or separate automation modes. It should not be the default path for this Pi-native interactive supervisor.

## Lifecycle Hooks Needed

The extension expects Pi to expose supervisor-capable lifecycle hooks:

- `pi.on("input", ...)`
- `pi.on("before_agent_start", ...)`
- `setModel`
- `pi.on("tool_call", ...)`
- `pi.on("tool_result", ...)`
- `pi.on("agent_end", ...)`

If these hooks are unavailable, the extension should fail loudly. The project is intentionally targeting Pi supervision, not command-only backward compatibility.

## Turn Classification

The first version uses deterministic classification:

```text
review/audit/risk          -> review
test/verify/lint/build     -> verify
failed/failure/broken/fix  -> repair
add/build/create/update    -> implement
plan/design/strategy       -> plan
why/check/inspect/logs     -> inspect
otherwise                  -> general
```

This is intentionally simple. LLM-based classification can come later if real sessions prove the deterministic classifier is too blunt.

## Model Routing

The supervisor maps each turn to an existing model role:

```text
inspect   -> discovery
plan      -> planner
implement -> builder
verify    -> planner
repair    -> repair
review    -> reviewer
general   -> planner
```

The model router should use the user's configured Pi-visible models for those roles. It should not invent provider or model IDs.

## Skill Guidance

The supervisor should not dump every skill body into the prompt. Instead, it should select a small number of relevant hints for the current turn.

Examples:

```text
frontend/navbar task -> frontend guidance
test failure         -> test and failure-classification guidance
auth/token task      -> security guidance
```

Later versions can expose relevant skills through Pi resource discovery instead of prompt text.

## Verification Guidance

The supervisor should help Pi choose checks that match the risk of the change.

For a tiny UI change, it might suggest:

```text
inspect diff
run typecheck or build if the touched files affect compilation
avoid long smoke tests unless behavior truly needs browser proof
```

For a backend behavior change, it might suggest:

```text
run the targeted test file first
run broader tests only if the change touches shared behavior
```

The point is not to skip verification. The point is to make verification proportional, fast, and useful.

## Failure Awareness

When commands or tools fail, the supervisor records the failure and uses it to guide the next turn.

Examples:

```text
402 Insufficient Balance -> provider/account problem
Cannot find module       -> missing dependency
TS2307                   -> compile or type resolution problem
command not found        -> environment problem
test assertion mismatch  -> real behavior/test failure
timeout                  -> command or environment hang
```

This helps Pi avoid blindly retrying the same failed command.

## MVP

The first useful version should include:

- input classification
- model role selection
- compact prompt guidance
- top skill hints
- verification hints
- edit/check observation
- failed tool result tracking
- session notifications
- `/supervisor status`

It should not include:

- hidden coding agents
- automatic repair loops
- workflow DAG execution
- parallel task scheduling
- persistent databases
- worktree orchestration
- broad backward compatibility for non-supervisor Pi hosts

## Success Criteria

The supervisor is working when Pi:

- picks a more appropriate model for the turn
- uses less irrelevant context
- keeps edits scoped
- runs checks that fit the change
- treats timeouts and environment failures differently from code failures
- does not claim completion without evidence
- recovers from failures with a better next action

The guiding rule:

```text
Pi acts.
The extension supervises.
The user stays in control.
```
