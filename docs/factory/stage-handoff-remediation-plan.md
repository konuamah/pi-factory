# Stage Handoff Remediation Plan

> Status: implemented (all 5 passes landed). Keep this as the reference for how stage handoffs work today.

Use this plan when improving how Factory passes context, decisions, artifacts, and verification state between workflow stages.

## Background

The LandOptima status bar case study showed that Factory can complete useful work quickly, but several stage handoffs are still too text-heavy or diagnostically unclear.

Observed weak points:

- Interview answers are persisted as readable text and decision-ledger entries, but not as a structured stage artifact that downstream stages can query directly.
- Planner intent is passed mostly as prose, so builder, verifier, reviewer, and approval UI cannot reliably distinguish target files, non-goals, risks, and acceptance checks.
- Discovery and interview are controller-native phases, but corresponding workflow task artifacts can still look pending or disconnected from the actual phase artifact.
- Scheduler dependency resolution uses workflow stage names, while builder context currently filters dependency tasks by task id, which can make dependency context thinner than intended.
- Baseline-unrelated verification failures can allow completion, while reviewer output may still say "not ready"; approval needs to surface that disagreement clearly.

## Goals

- Preserve human-readable summaries and structured machine-readable artifacts.
- Make the visible workflow DAG match the runtime handoff story.
- Keep stage dependencies consistent across scheduling, context compilation, logs, and artifacts.
- Make approval decisions clear when task-specific checks pass but baseline repository debt remains.
- Keep Factory language- and framework-agnostic.

## Non-Goals

- Do not replace the current workflow registry.
- Do not make Factory run tasks outside the configured workflow.
- Do not add a new external storage service or searchable registry.
- Do not make baseline-unrelated failures silently disappear.

## Pass 1: Fix Dependency Task Context

Problem:

Scheduling resolves `dependsOn` using workflow stage names, but `compileAgentContext` filters dependency tasks by task id. A task with `dependsOn: [plan]` can schedule correctly while losing the planner task as dependency context.

Implementation:

- Add a helper that resolves dependency task ids from stage-name dependencies using the same mapping as `resolveTaskDependencies`.
- Use the resolved dependency ids when passing `dependencyTasks` into `compileAgentContext`.
- Keep support for direct task ids if a future planner emits them.
- Emit `task.context_compiled.dependencies` with the resolved dependency task ids.

Primary files:

- `packages/core/src/runtime/controller.ts`
- `packages/core/src/context/compiler.ts`
- `tests/runtime.test.mjs`

Tests:

- A workflow with `implementation.dependsOn: [plan]` includes the planner task as dependency context.
- A workflow with direct task-id-style dependencies still works if present.
- Existing implementation scheduling behavior remains unchanged.

## Pass 2: Make Controller-Native Stages Honest

Problem:

Discovery and interview can run before `plan.tasks`, but task artifacts may still show those stages as pending. That makes run inspection harder to trust.

Implementation:

- Mark controller-handled `discover`, `discovery`, `plan`, `planning`, and `interview` task artifacts as `done` when those phases have already completed.
- Add optional artifact references for controller-native phases:
  - `discoveryExecutionPath`
  - `interviewExecutionPath`
  - `plannerExecutionPath`
- Add `controllerHandled: true` to task artifacts when the task is represented for workflow visibility but executed by dedicated controller code.

Primary files:

- `packages/core/src/runtime/planner.ts`
- `packages/core/src/runtime/artifacts.ts`
- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runs/show.ts`
- `packages/core/src/runs/logs-by-id.ts`

Tests:

- Discovery task does not remain pending after discovery completed.
- Interview task records that it was controller-handled.
- Run show/logs display controller-handled artifacts clearly.

## Pass 3: Preserve Structured Interview Decisions

Problem:

Interview questions and answers are collapsed into a formatted text blob for the planner. That works for simple use, but it is brittle for downstream builder, review, and approval behavior.

Implementation:

- Add an `interview-decisions.json` artifact with records shaped like:

```json
[
  {
    "stage": "interview",
    "role": "planner",
    "question": "What should the sidebar contain?",
    "optionId": "answered",
    "answer": "Add navigation links and keep it collapsible.",
    "decisionRequestId": "run_id-interview"
  }
]
```

- Continue rendering a readable `interviewContext` string for prompts.
- Pass structured interview decisions into:
  - planner prompt
  - builder compiled context
  - reviewer prompt
  - approval preview
  - run show/logs output

Primary files:

- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runtime/artifacts.ts`
- `packages/core/src/context/compiler.ts`
- `packages/adapters/pi/src/approval.ts`

Tests:

- Interview answers are written to a structured artifact.
- Planner receives interview answers.
- Builder compiled context includes human interview decisions.
- Missing required interview skill still fails loudly.

## Pass 4: Preserve Structured Planner Intent

Problem:

Planner output is prose. Builder and verifier get enough text to act, but Factory cannot reliably inspect target files, non-goals, checks, risks, or blockers.

Implementation:

- Extend `plan.json` with an optional `implementationContract`:

```json
{
  "targetFiles": ["frontend/landoptima/src/app/LandAnalysis.tsx"],
  "nonGoals": ["Do not change backend APIs."],
  "verificationChecks": [
    {
      "name": "lint",
      "command": "npm exec eslint src",
      "reason": "Catch JSX and TypeScript regressions."
    }
  ],
  "risks": [
    {
      "risk": "Status bar overlaps content.",
      "mitigation": "Verify at common viewport sizes."
    }
  ],
  "blockers": []
}
```

- Start with best-effort extraction from existing planner prose.
- Later, make planner emit both prose and JSON contract.
- Feed `implementationContract` into builder context, verification planning, review, and approval preview.

Primary files:

- `packages/core/src/runtime/planner.ts`
- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runtime/artifacts.ts`
- `packages/core/src/context/compiler.ts`

Tests:

- Plan artifacts preserve target files and non-goals.
- Builder prompt includes structured target files.
- Reviewer can see verification checks and risks.
- Existing prose-only planner output remains backward-compatible.

## Pass 5: Make Baseline-Debt Approval Explicit

Problem:

Factory can correctly classify a verification failure as baseline-unrelated and still complete the task-specific contract. The approval UI must make that distinction impossible to miss.

Implementation:

- When `verification.overallStatus === "failed"` but contract verification can complete, include a baseline debt section in approval preview.
- Show:
  - failed command
  - implicated file
  - classification reason
  - suggested remediation
  - statement that task-specific contract passed
- Preserve reviewer output even when the controller allows approval.

Primary files:

- `packages/adapters/pi/src/approval.ts`
- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runs/show.ts`
- `packages/core/src/runs/logs-by-id.ts`

Tests:

- Approval preview shows baseline-unrelated failures.
- Approval preview distinguishes task-specific completion from full green verification.
- Reviewer "not ready" output is visible when the controller still permits approval.

## Docs And Skills

Update these in the same change as implementation:

- `docs/factory/stage-handoff-remediation-plan.md`
- `docs/factory/case-study-landoptima-status-bar.md`
- `docs/factory/workflow-authoring.md`
- `docs/factory/troubleshooting.md`
- `skills/factory-concierge/SKILL.md`
- `.pi/skills/factory-concierge/SKILL.md`
- `learnings.md`

Concierge should explain:

- Discovery, interview, planning, implementation, verification, review, and approval handoffs.
- Why interview stages must be inside the selected workflow's `stages` array.
- How to inspect handoff artifacts with `/factory show`, `/factory logs`, and `/factory plan`.
- Why a run can complete with baseline repository debt still present.

## Rollout Order

1. Fix dependency task context.
2. Mark controller-native task artifacts honestly.
3. Add structured interview decision artifacts.
4. Add structured planner intent.
5. Improve approval UI for baseline-unrelated failures.

This order gives quick correctness wins first, then improves observability, then upgrades the deeper contract model.

## Verification

Run after each implementation pass:

```bash
npm run build
node --test tests/runtime.test.mjs
node --test tests/factory-concierge.test.mjs
```

For interview-specific changes, also run or add focused tests that assert:

- `type: interview` stages execute before planning.
- interview answers are passed to the planner.
- bundled `grilling` skill requirements fail loudly if missing.
- workflow registry shape uses `defaultWorkflowId` plus `workflows`, not top-level `stages:`.
