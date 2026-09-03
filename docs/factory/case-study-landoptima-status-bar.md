# Case Study: LandOptima Status Bar Run

Use this case study when evaluating Factory stage handoff quality from real run artifacts.

## Source Runs

Repository: `D:\projects\landoptima`

Completed implementation runs found:

- `run_1787447644274_85a8c51a`: `create agents.md`, completed on 2026-08-23.
- `run_1787983270495_2faefe65`: `add a status bar`, completed on 2026-08-29.

The status bar run is the stronger product-facing case study because it exercised discovery, planning, implementation, verification classification, review, approval, and merge handling.

## Outcome

Run `run_1787983270495_2faefe65` completed in about 138 seconds.

Factory correctly:

- reused an existing isolated worktree for `factory-add-a-status-bar`
- discovered the relevant frontend package and concrete files
- passed discovery evidence into planning
- converted the plan into a single builder task
- scoped the builder to the intended frontend files
- adapted stale Next.js lint verification from `next lint` to `npm exec eslint src`
- classified a build failure in `src/app/components/Map.tsx` as baseline-unrelated
- reached final approval and completion after the task-specific contract passed

The implementation changed the existing status surface in `frontend/landoptima/src/app/LandAnalysis.tsx`, added `aria-live="polite"`, updated app metadata in `layout.tsx`, and made small global CSS reset changes.

## Stage Handoff Timeline

- Goal received: `2026-08-29T06:01:10.498Z`
- Discovery completed: `2026-08-29T06:01:26.618Z`
- Planning artifact written: `2026-08-29T06:01:41.445Z`
- Plan approved: `2026-08-29T06:02:15.808Z`
- Builder completed and committed changes: `2026-08-29T06:02:41.495Z`
- Verification completed: `2026-08-29T06:03:05.599Z`
- Contract verification passed: `2026-08-29T06:03:11.138Z`
- Reviewer completed: `2026-08-29T06:03:25.011Z`
- Human approval recorded: `2026-08-29T06:03:28.047Z`
- Run completed: `2026-08-29T06:03:28.380Z`

## What Worked

Discovery produced concrete, useful evidence. It identified `LandAnalysis.tsx`, `layout.tsx`, `globals.css`, `page.tsx`, and the frontend `package.json`, and explained why each mattered.

Planning stayed grounded in discovery. The planner did not ask the builder to search broadly; it converted the discovery packet into a focused implementation sequence and verification contract.

Builder context was narrow enough to keep the change scoped. The compiled context included the discovered file hints and selected implementation skills. The builder touched the requested frontend surface and did not wander into backend work.

Verification showed good project adaptation. The configured project commands referenced `pnpm`, but the selected package used npm. Factory selected the nested frontend package, replaced the stale Next.js lint script with `npm exec eslint src`, and skipped missing typecheck/test scripts instead of inventing commands.

Failure classification was useful. `npm run build` failed on a missing Leaflet declaration in `src/app/components/Map.tsx`, outside the changed files. Factory classified this as baseline-unrelated and allowed the task-specific lint contract to complete.

## Handoff Weaknesses Observed

The workflow DAG and runtime DAG are not identical. The plan contains `discover` as `task-1`, but discovery already ran as controller-native code before the task list was executed. That can confuse diagnostics because the visible task artifact says discovery is pending even though discovery already completed.

The planner-to-builder handoff is partly lossy. The builder receives selected files, skills, capabilities, and role guidance, but the planner's reasoning remains plain text rather than a structured contract that the builder and verifier can query field by field.

Dependency-task context can be thinner than intended. Workflow dependencies are authored as stage names, and scheduling resolves them correctly by stage name, but builder context currently filters dependency tasks by task id. For a task with `dependsOn: [plan]`, this means the compiler does not treat the planner task artifact as a dependency task unless its id is literally `plan`.

Review and completion policy can disagree. The reviewer said the candidate was "Not ready for approval" because build failed. The controller still proceeded because verification classification and contract verification allowed a baseline-unrelated build failure. That may be correct policy, but the approval prompt should make the disagreement explicit so the user knows the candidate is task-complete with known baseline repo debt.

## Recommendations (implemented)

These are now implemented across the stage-handoff remediation:

- **Keep interview output structured.** Interview answers are stored in `interview-decisions.json` (question, answer, option, decision request id) and passed to planning, builder context, review, and run inspection.
- **Represent controller-native stages clearly in plan artifacts.** `plan`, `discover`, and `interview` tasks are marked `done` with `controllerHandled: true` and artifact path refs.
- **Preserve planner intent as structured fields.** `plan.json` carries an `implementationContract` (target files, implementation steps, verification checks, non-goals, risks, blockers).
- **Fix dependency task handoff.** Builder context resolves `dependsOn` by the same stage-name mapping as the scheduler, with direct task-id fallback.
- **Make baseline-unrelated completion more visible.** Final approval receives `baselineDebt` (failed command, classification, reason, implicated files) and asks explicitly whether to approve despite it.

## Performance Read

Factory performed well as an orchestrator for a narrow UI change: about 16 seconds for discovery, 15 seconds for planning, 26 seconds for implementation, 24 seconds for verification and classification, and 14 seconds for review.

The biggest performance drag was not agent execution. It was human approval wait time and verification cost. The main quality risk was not speed; it was whether the final approval surface clearly explained that the run completed with an unrelated build failure still present in the repository.
