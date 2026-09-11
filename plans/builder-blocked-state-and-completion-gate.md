# Builder-Blocked State and Run-Completion Gate

## 1. Understanding & Scope

* **Core Goal:**
  Stop Factory from declaring a run `COMPLETED` when the Builder correctly signaled that the approved contract could not be executed (`CONTRACT_BLOCKED`, missing files, unrecoverable handoff) or when the candidate commit contains no non-generated product changes. The fix has two ordered parts: (a) make `CONTRACT_BLOCKED` / `CONTRACT_NOOP` real task states that prevent dependent advancement, and (b) centralize the final completion gate so a run cannot become `COMPLETED` unless (i) all required DAG nodes are `SUCCEEDED`, (ii) verification succeeded, (iii) the verified candidate commit contained a non-generated implementation diff, and (iv) the final merge artifact contains that diff and is `status: "merged"`. These two changes make this class of false-success safe even when Discovery and Planning are imperfect.

* **Current Behavior:** (with file:line evidence)
  * `packages/core/src/runtime/controller.ts:2300-2510` — local `runImplementationTask`. After a single no-change retry, if the builder still produced no commit, the task is marked `failed` and the run is set to `FAILED` (`controller.ts:2486-2498`). The Builder's `CONTRACT_BLOCKED` / `CONTRACT_NOOP` directive text in the model output is **not consumed** anywhere in this function. `classifyBuilderOutcome` (`packages/core/src/runtime/builder-outcome.ts:35-67`) defines these kinds but is dead in the active path (no source file imports it).
  * `packages/core/src/runtime/controller.ts:2843-2858` — local `commitWorkspaceChanges` uses `git add -A` with **no** exclusion of transient `.factory/**` paths. A task whose only edits touch `.factory/runs/...` or dependency bookkeeping still produces `committed: true`. The git-ops module's `commitWorkspaceChanges` (`packages/core/src/runtime/git-ops.ts:77-97`) has `isTransientFactoryPath` filtering, but the active controller does **not** import it.
  * `packages/core/src/runtime/controller.ts:1957-1960` — `runImplementationTasks` seeds the ready-set from `task.status === "done"`. Today the only successful terminal status is `"done"`; there is no `"BLOCKED"` value.
  * `packages/core/src/runtime/artifacts.ts:5-9` — `PrototypeTaskArtifact.status: "pending" | "done" | "running" | "failed" | "aborted"`. No `"BLOCKED"` variant.
  * `packages/core/src/runtime/controller.ts:2597-2685` — integration phase skips workspaces whose `shouldIntegrate === false` with `status: "skipped", reason: "Task executed in primary workspace"`. No task-state check; an empty integration is treated as success.
  * `packages/core/src/runtime/controller.ts:1851-1869` — final completion: `await updateFactoryRunState({ patch: { status: "COMPLETED", phase: "complete" } })` is set immediately after `runFinalMergePhase` returns. The artifact's `status` (`"merged"` vs `"skipped"`) is never inspected. `summary.status = "COMPLETED"`, `approved: true` is written regardless.
  * `packages/core/src/runtime/controller.ts:2828-2940` — `runFinalMergePhase` can return `status: "skipped"` for any of: `FACTORY_SKIP_FINAL_MERGE=1`, `finalMergePolicy !== "required"`, no candidate branch, `worktreeMode === "existing"`, or merge command failure. Today the caller treats every return as success.
  * `packages/core/src/verification/engine.ts:96-99` — `canComplete` only checks that all blocking requirements are `PASS` or `NOT_APPLICABLE`. No requirement asserts that non-generated implementation files changed.
  * `packages/core/src/verification/planner.ts:34-180` — `gatherVerificationRequirements` has no `IMPL_DIFF` (or equivalent) requirement type. Requirements come from FACTORY commands, SKILL validations, CONSTITUTION, TASK_TYPE, USER criteria, CONSTITUTION conflicts, and PLAN non-goals.
  * `packages/core/src/runtime/landing.ts:670-680` — the only place where a `COMPLETED` vs `BLOCKED` decision considers landing evidence (`landingStatus === "landed" | "skipped" | "pull-request"`). **Dead in the active path** — `controller.ts` does not call `runLandingFlow`.
  * `packages/core/src/runtime/failure-recovery.ts:68` — `requestFailureRecovery` exists; **not called from active controller's discovery or implementation paths**.

* **Target Behavior:**
  * The active `controller.ts` calls `classifyBuilderOutcome(...)` after every builder attempt. `contract-blocked` translates to `task.status = "blocked"` (new value) with a `task.contract_blocked` event carrying the reason, and **blocks the run** by setting `run.status = "BLOCKED"`, `phase = "implementation-blocked"`. Dependent DAG tasks must not advance.
  * `contract-noop` is allowed to terminate the task as success-equivalent (already satisfied) — `task.status = "done"`, `task.contract_noop` event — and is treated as having produced no changes, so the run-level completion gate below still applies.
  * `no-change-unclear` keeps today's behavior (retry once, then `failed`).
  * `implemented` (committed and not blocked) keeps today's behavior (`done`).
  * The local `commitWorkspaceChanges` (`controller.ts:2843`) is replaced by a call to the git-ops `commitWorkspaceChanges` (`git-ops.ts:77`), which already excludes transient Factory paths via `isTransientFactoryPath`.
  * A new "product diff" requirement is added to `gatherVerificationRequirements`. It returns `FAIL` with reason `NO_PRODUCT_CHANGES` when the candidate's non-generated changed files are empty. It is `blocking: true`.
  * A new centralized `canCompleteRun(...)` predicate in `controller.ts` (or in a small helper) computes the run-level completion invariant and is the single gate the `COMPLETED` write goes through.
  * `runFinalMergePhase`'s returned artifact is read. If `status !== "merged"`, the run becomes `BLOCKED` / `merge-blocked` (with `summary.approved: false`), not `COMPLETED`.
  * The integration phase's `shouldIntegrate: false` path no longer implicitly succeeds. The task's `task.status` (now possibly `"blocked"` or `"done"` with empty product changes) is read; if it is `"blocked"` or has no product changes, the run is `BLOCKED` at integration.

* **Files Affected:**
  * `Modify: packages/core/src/runtime/controller.ts:2300-2510` (call `classifyBuilderOutcome`, write `task.status = "blocked"`, emit `task.contract_blocked`).
  * `Modify: packages/core/src/runtime/controller.ts:2351, :2442, :2843` (replace local `commitWorkspaceChanges` with the filtered git-ops version; keep the local function signature).
  * `Modify: packages/core/src/runtime/controller.ts:1909-1931` (`TaskWorkspaceSelection` adds an optional `commitSha` field; the local version of `commitWorkspaceChanges` is updated to match the git-ops signature).
  * `Modify: packages/core/src/runtime/artifacts.ts:5-9` (extend `PrototypeTaskArtifact.status` to include `"blocked"`).
  * `Modify: packages/core/src/runtime/tasks.ts:7-8` (extend `updatePrototypeTaskArtifact`'s `status` pick).
  * `Modify: packages/core/src/runtime/controller.ts:1851-1870` (replace the unconditional `COMPLETED` write with a `canCompleteRun(...)` gate).
  * `Modify: packages/core/src/runtime/controller.ts:1840-1852` (read `runFinalMergePhase`'s returned artifact JSON; pass to the gate).
  * `Modify: packages/core/src/runtime/controller.ts:2597-2685` (integration: stop early if any task is `blocked`).
  * `Modify: packages/core/src/runtime/verification/planner.ts:34-180` (add `IMPL_DIFF` requirement emission when the run has implementation tasks).
  * `Modify: packages/core/src/verification/engine.ts` or new provider `packages/core/src/verification/providers/impl-diff.ts` (the new provider's `verify(...)` body).
  * `Modify: packages/core/src/verification/registry.ts` (register the new provider).
  * `Modify: packages/core/src/verification/types.ts` (add `ImplDiffRequirement`).
  * `Modify: packages/core/src/runtime/controller.ts:1340-1392` (pass implementation-changed files into `gatherVerificationRequirements`).
  * `Modify: packages/core/src/runs/store.ts:6-10` (`FactoryRunState.status` already includes `BLOCKED`; no schema change. Add new `phase` constants `implementation-blocked` and `merge-blocked`.)
  * `Create: packages/core/src/runtime/can-complete-run.ts` (centralized predicate, ~80 lines).
  * `Test: tests/runtime.test.mjs` (six new tests; see Step 7).
  * `Test: tests/builder-outcome.test.mjs` (no schema change; one new test pinning the wired behavior).

* **Out of Scope:**
  * Plan-surface / workspace-surface validation (the user's items #5-#7). This plan addresses items #1, #2, #3, #4, #8, #9 (state propagation, completion predicate, implementation-aware verification, integration semantics, final-merge provenance). Surface coverage is the next plan.
  * Discovery-quality improvements (item #10 / "Discovery quality improvements").
  * The dead modules (`controller-run.ts`, `controller-interview.ts`, `discovery-phase.ts`, `controller-final-phases.ts`, `implementation-phase.ts`, `verification-phase2.ts`, `landing.ts`, `task-utils.ts`). They contain parallel implementations; this plan touches only the active `controller.ts`. The dead modules can be deleted in a separate cleanup.
  * Resurrecting `requestFailureRecovery` / `recovery-checkpoint` on the active discovery path. The user's "It skipped repair" complaint is about the `CONTRACT_BLOCKED` short-circuit, not the broader recovery loop.
  * Adding new JSON extraction candidates to `discoveryJsonCandidates`. Out of scope here.
  * Changing `PrototypeSummaryArtifact.status` (it already supports `BLOCKED`). The schema is fine; only the producer was wrong.
  * Changing `PrototypeTaskArtifact.context` or `PrototypeCompletedTaskArtifact`. These are unrelated.

## 2. Assumptions & Blockers

* **Assumptions:**
  * The active path is `controller.ts`. All edits land in this monolith. Edits in dead modules are invisible to users.
  * `PrototypeTaskArtifact.status` can grow a `"blocked"` value without breaking consumers (`runImplementationTasks` only seeds the ready-set from `status === "done"`, so adding `"blocked"` is additive).
  * `updatePrototypeTaskArtifact`'s `status` patch typing (`tasks.ts:8`) can be widened without affecting existing callers.
  * The git-ops `commitWorkspaceChanges` is the right primitive; its `isTransientFactoryPath` filter is the intended behavior. The local unfiltered version was an accidental regression.
  * `classifyBuilderOutcome` (`builder-outcome.ts:35`) returns the right shape to drive task state. It already produces `contract-blocked | contract-noop | no-change-unclear | implemented | executor-failed` with a `reason` string. No change to the classifier is required.
  * The new `IMPL_DIFF` requirement is sourced from the candidate's effective changed files between baseline (`loaded.effectiveConfig.git.baseBranch`) and the candidate commit (`candidateSha` captured at `controller.ts:1702` before merge).
  * For runs with no implementation tasks (pure documentation / config changes), the `IMPL_DIFF` requirement is not added and the run can still become `COMPLETED` without product changes.
  * `canCompleteRun` is invoked once at the existing `COMPLETED` write site (`controller.ts:1851`). It does not gate earlier phases; those phases continue to set `FAILED` / `BLOCKED` / `CANCELLED` on their own failure paths.

* **Questions / Blockers:**
  * **None blocking.** All required types exist or can be added incrementally.

## 3. Implementation Plan

* [ ] **Step 1: Add `"blocked"` to `PrototypeTaskArtifact.status` and widen `updatePrototypeTaskArtifact`'s patch**

  * **Files:**
    * `Modify: packages/core/src/runtime/artifacts.ts:5-9`
    * `Modify: packages/core/src/runtime/tasks.ts:7-8`

  * **Interfaces:**
    * Consumes: existing `PrototypeTaskArtifact` and `updatePrototypeTaskArtifact`.
    * Produces:
      ```ts
      // artifacts.ts:9
      status: "pending" | "done" | "running" | "failed" | "aborted" | "blocked";
      ```
      ```ts
      // tasks.ts:7-8
      patch: Partial<Pick<PrototypeTaskArtifact, "status" | "workspacePath" | "workspaceMode" | "workspaceBranch">>;
      // (status already in the pick; the new "blocked" string literal is allowed by the existing string type.)
      ```

  * **Negative Paths:**
    * Existing consumers (`runImplementationTasks` at `controller.ts:1957-1960`, dashboard, `runs/show.ts`) only compare against `"done"` and `"failed"`. A `"blocked"` task is not picked up by `status === "done"` and therefore correctly stays pending / not-completed.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'completed implementation with no file changes'` — PASS (the existing test does not write a `"blocked"` status).

* [ ] **Step 2: Replace the local unfiltered `commitWorkspaceChanges` with the filtered git-ops version**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:53-58` (import `commitWorkspaceChanges` from `./git-ops.js`).
    * `Modify: packages/core/src/runtime/controller.ts:2843-2858` (delete the local unfiltered function).

  * **Interfaces:**
    * Consumes: git-ops `commitWorkspaceChanges` (`git-ops.ts:77-97`).
    * Produces (single replacement):
      ```ts
      // controller.ts:53-58 (add to existing imports)
      import { commitWorkspaceChanges } from "./git-ops.js";
      ```
      Delete the local function block at `controller.ts:2843-2858`. The two call sites (`controller.ts:2351` and `:2442`) already use the same `(cwd, task)` signature; they will resolve to the imported function. The git-ops version returns `{ committed, changedFiles, allChangedFiles, commitSha }`; the existing destructuring at `:2351-2362` and `:2442-2445` only reads `committed` and `changedFiles`, so it is forward-compatible. Where `commitSha` is needed (for the new completion gate in Step 6), the import is reused.

  * **Negative Paths:**
    * A workspace whose only changes are `.factory/runs/...` → `committed: false`, `changedFiles: []`. The existing `task.no_changes_retrying` / `task.failed` path handles this exactly as today.
    * A workspace whose changes include both transient and product files → only product files counted as `changedFiles`; `committed: true`. This is the new correct behavior.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'completed implementation with no file changes|integration|final approval|verifies final merge|merge succeeded'` — PASS (no behavior regression for product-producing tasks).

* [ ] **Step 3: Wire `classifyBuilderOutcome` into the active `runImplementationTask` and translate `contract-blocked` to `task.status = "blocked"`**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:51-58` (add imports).
    * `Modify: packages/core/src/runtime/controller.ts:2380-2405` (after the no-change retry; before `committedChange` is read into `workspace`).

  * **Interfaces:**
    * Consumes: `classifyBuilderOutcome` from `builder-outcome.ts:35`; `WorkspaceCommitResult` from git-ops.
    * Produces:
      ```ts
      // controller.ts:51-58 (add)
      import { classifyBuilderOutcome } from "./builder-outcome.js";
      ```
      ```ts
      // controller.ts:2380-2405 (replace the existing no-change retry block)
      const builderResult = builderAttempt.result;
      const builderExecutionPath = builderAttempt.executionPath;
      const committedChange = builderAttempt.committedChange;
      const outcome = classifyBuilderOutcome(builderResult, committedChange);

      if (outcome.kind === "contract-blocked") {
        // Translate the Builder protocol directive into a real task BLOCKED state.
        // The run must not advance dependent execution as if the task succeeded.
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "blocked" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.contract_blocked",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: outcome.reason,
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return {
          ok: false,
          task: input.task,
          workspace,
          terminalStatus: "blocked",
          failureKind: "contract-blocked",
        };
      }

      if (outcome.kind === "contract-noop") {
        // The approved contract was already satisfied. The task is terminal-success
        // (no further changes needed), but the run-level completion gate in Step 6
        // still applies: if NO product change occurred across the whole run, the
        // run cannot become COMPLETED with approved=true.
        workspace.changedFiles = committedChange.changedFiles;
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "done" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.contract_noop",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: outcome.reason,
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: true, task: input.task, workspace };
      }

      // outcome.kind === "no-change-unclear" | "implemented" continues with the
      // existing no-change retry logic below.
      ```

      Update the `ImplementationTasksResult` shape at `controller.ts:1909-1926` (the local type used by `runImplementationTasks`) to carry the new `failureKind: "blocked"` and `terminalStatus: "blocked"` literals:
      ```ts
      terminalStatus?: "aborted" | "failed" | "blocked";
      failureKind?: BuilderOutcomeKind | "no-change-unclear";
      ```

  * **Negative Paths:**
    * Builder returns `CONTRACT_BLOCKED` mid-run → task is `blocked`, run is `BLOCKED` (Step 5 wires the run-level propagation), dependent tasks not advanced.
    * Builder returns `CONTRACT_NOOP` → task is `done`, but the run's product-diff gate (Step 4) still applies.
    * Builder returns no directive and no commit → today's no-change retry path runs unchanged.
    * Builder returns a directive but does commit → `outcome.kind === "implemented"` (committed wins); today's path runs unchanged.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'completed implementation with no file changes|contract_blocked|contract_noop'` — PASS after Step 7 adds the new tests; existing tests at `tests/runtime.test.mjs:2193` and `:2257` continue to use no directive and pass.

* [ ] **Step 4: Add an `IMPL_DIFF` verification requirement and provider**

  * **Files:**
    * `Modify: packages/core/src/verification/types.ts` (add `ImplDiffRequirement` and export it).
    * `Create: packages/core/src/verification/providers/impl-diff.ts` (new provider).
    * `Modify: packages/core/src/verification/registry.ts` (register the provider at module init).
    * `Modify: packages/core/src/verification/engine.ts` (the provider is auto-discovered via `PROVIDERS.get("IMPL_DIFF")`; no engine change required).
    * `Modify: packages/core/src/verification/planner.ts:34-180` (emit an `IMPL_DIFF` requirement when implementation tasks exist).
    * `Modify: packages/core/src/runtime/controller.ts:1340-1392` (pass the implementation changed files and base branch into `gatherVerificationRequirements`).

  * **Interfaces:**
    * Consumes: `VerificationProvider` from `verification/types.ts`; existing scope provider shape.
    * Produces:
      ```ts
      // verification/types.ts (additions; preserve existing types verbatim)
      export interface ImplDiffRequirement {
        id: string;
        type: "IMPL_DIFF";
        blocking: true;
        description: string;
        source: "FACTORY";
        scope: "RUN";
        taskId?: string;
        changedFiles: string[];
        baseBranch: string;
      }
      ```
      ```ts
      // verification/providers/impl-diff.ts
      import path from "node:path";
      import { isTransientFactoryPath } from "../../runtime/git-ops.js";
      import type {
        ProviderVerificationResult,
        ImplDiffRequirement,
        VerificationProvider,
        VerificationProviderContext,
      } from "../types.js";

      export const implDiffProvider: VerificationProvider = {
        type: "IMPL_DIFF",
        async verify(requirement, _context: VerificationProviderContext): Promise<ProviderVerificationResult> {
          const req = requirement as ImplDiffRequirement;
          const productChanges = (req.changedFiles ?? []).filter((file) => !isTransientFactoryPath(file));
          const evidenceId = `EV-impl-diff-${++implDiffEvidenceCounter}`;
          _context.evidence[evidenceId] = {
            kind: "impl-diff",
            baseBranch: req.baseBranch,
            totalChangedFiles: req.changedFiles.length,
            productChangedFiles: productChanges.length,
            productFiles: productChanges.slice(0, 50),
          };
          if (productChanges.length > 0) {
            return {
              requirementId: requirement.id,
              status: "PASS",
              evidence: [{ id: evidenceId, kind: "impl-diff" }],
            };
          }
          return {
            requirementId: requirement.id,
            status: "FAIL",
            evidence: [{ id: evidenceId, kind: "impl-diff" }],
            reason: `No non-generated product files were changed against base branch '${req.baseBranch}'. Implementation produced no meaningful diff.`,
          };
        },
      };

      let implDiffEvidenceCounter = 0;
      ```
      ```ts
      // verification/registry.ts (append registration in initializeVerificationProviders)
      import { implDiffProvider } from "./providers/impl-diff.js";
      // ...
      registerProviderType(implDiffProvider);
      ```
      ```ts
      // verification/planner.ts (append a new section before the return)
      const hasImplementationTasks = (input.tasks ?? []).some(
        (task) => task.role === "builder" || task.role === "repair" || task.type === "command",
      );
      if (hasImplementationTasks) {
        requirements.push({
          id: nextId(),
          type: "IMPL_DIFF",
          blocking: true,
          description: "Implementation must produce non-generated product changes",
          source: "FACTORY",
          scope: "RUN",
          taskId: input.taskId,
          changedFiles: input.changedFiles ?? [],
          baseBranch: input.baseBranch ?? "main",
        });
      }
      ```
      ```ts
      // verification/planner.ts (add `tasks` and `changedFiles` and `baseBranch` to the
      // VerificationContractPlannerInput type in types.ts).
      ```
      ```ts
      // controller.ts:1340-1392 (pass the implementation changed files into gatherVerificationRequirements)
      const contractPlan = gatherVerificationRequirements({
        goal: input.goal,
        taskType: runTaskType.id,
        config: loaded.effectiveConfig,
        skills: undefined,
        constitutionAreas: undefined,
        conflictAreas: repoSkillSignals.constitutionAreas,
        workflowId: loaded.effectiveConfig.resolvedWorkflowId,
        commands: loaded.effectiveConfig.commands,
        constitutionConflicts: await loadConstitutionConflicts(projectRoot),
        tasks: plan.tasks,
        changedFiles: implementationChangedFiles,
        baseBranch: loaded.effectiveConfig.git.baseBranch,
      });
      ```

  * **Negative Paths:**
    * `changedFiles` empty → `IMPL_DIFF` returns `FAIL` with `reason: "No non-generated product files were changed..."`; `contractResult.canComplete` becomes `false`; controller.ts:1603 BLOCKED gate fires.
    * `changedFiles` contains only `.factory/runs/...` → filtered by `isTransientFactoryPath`; same outcome.
    * `changedFiles` contains only `package.json` / `dist/` (not currently in the filter) → currently passes; the filter lives in `git-ops.ts:128-143` and is not changed by this plan. Adding more exclusions is a follow-up.
    * No implementation tasks → `IMPL_DIFF` requirement is not emitted; documentation/config-only runs can still become `COMPLETED`.
    * Verification is invoked more than once (e.g., after repair at `controller.ts:1517-1530`) → the requirement is re-evaluated with updated `changedFiles`. The contract re-check already passes `changedFiles` (controller.ts:1517); the `IMPL_DIFF` requirement automatically uses the updated list.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/verification-engine.test.mjs` — PASS (existing engine tests are unaffected; they don't exercise `IMPL_DIFF`).
    * `node --test --test-name-pattern 'no product diff|impl_diff' tests/runtime.test.mjs` — PASS after Step 7.

* [ ] **Step 5: Propagate `BLOCKED` at the run level when implementation yields a `blocked` task**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:978-1032` (the `if (!implementationRun.ok)` branch).

  * **Interfaces:**
    * Consumes: `ImplementationTasksResult` updated in Step 3.
    * Produces (extend the existing failure branch to handle `terminalStatus === "blocked"`):
      ```ts
      // controller.ts:978-1032 (replace the existing implementation-failed branch with a
      // three-way switch)
      if (!implementationRun.ok) {
        if (implementationRun.terminalStatus === "blocked") {
          const blockedState = await updateFactoryRunState({
            statePath: run.statePath,
            patch: { status: "BLOCKED", phase: "implementation-blocked" },
          });
          await appendFactoryRunEvent(run.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "run.blocked",
            data: {
              reason: `implementation task ${implementationRun.failedTask.id} is BLOCKED`,
              taskStage: implementationRun.failedTask.stage,
              failureKind: implementationRun.failureKind,
              blockedReason: implementationRun.failedTask.context?.blockReason ?? null,
            },
          });
          const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
            runId: run.runId,
            goal: input.goal,
            status: "BLOCKED",
            phase: blockedState.phase,
            approved: false,
            planPath, taskPaths,
            discoveryExecutionPath, plannerExecutionPath,
            builderExecutionPaths, integrationPath,
            repairExecutionPaths,
            verificationPath: path.join(run.runDir, "verification.json"),
            verificationStatus: "incomplete",
          });
          return {
            runId: run.runId, runDir: run.runDir, executionCwd, worktree,
            statePath: run.statePath, eventsPath: run.eventsPath, phases,
            approved: false, planPath, taskPaths,
            discoveryExecutionPath, plannerExecutionPath,
            builderExecutionPaths, integrationPath,
            repairExecutionPaths,
            verificationPath: path.join(run.runDir, "verification.json"),
            summaryPath,
          };
        }
        const isAborted = implementationRun.failedPhase === "implementation-aborted";
        // ... existing FAILED / ABORTED branch unchanged
      }
      ```
      Add an optional `blockReason` field to `PlannerTask.context` (`controller.ts:1914+` or wherever `PlannerTask` is defined — see `planner.ts:5-37`) so the blocked reason can be carried in the summary. Specifically, change `controller.ts:1914` (the local context type alias if any) to allow `blockReason?: string` on `PlannerTask`. Since `PlannerTask` is defined in `planner.ts:5-37`, extend that interface:
      ```ts
      // planner.ts (additions to PlannerTask)
      context?: {
        fileHints?: string[];
        constitutionAreas?: number[];
        requiredCapabilities?: string[];
        includeDependencyArtifacts?: boolean;
        blockReason?: string;
      };
      ```

  * **Negative Paths:**
    * All tasks succeed → unchanged path.
    * A task is `aborted` → existing ABORTED path; no behavior change.
    * A task is `failed` → existing FAILED path; no behavior change.
    * A task is `blocked` → new BLOCKED / `implementation-blocked` path; run never reaches verification, integration, merge, or `COMPLETED`.
    * Resume after BLOCKED: not in scope for this plan; the existing `runs/resume.ts` already routes `currentStatus === "BLOCKED"` to a recovery flow. The new `implementation-blocked` phase is added to the recognized set when resume inspects state.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'contract_blocked|implementation-blocked'` — PASS after Step 7.

* [ ] **Step 6: Centralize the final completion gate as `canCompleteRun`**

  * **Files:**
    * `Create: packages/core/src/runtime/can-complete-run.ts`
    * `Modify: packages/core/src/runtime/controller.ts:1830-1870` (replace the unconditional `COMPLETED` write with a gate call).
    * `Modify: packages/core/src/runtime/controller.ts:2597-2685` (integration: if any task is `blocked`, the integration phase sets `run.status = "BLOCKED"`).

  * **Interfaces:**
    * Consumes: existing `PrototypeFinalMergeArtifact` (`artifacts.ts:305-321`), `PrototypeCompletedTaskArtifact` (`artifacts.ts:274-282`), `gitChangedFiles` from `verification-planning.ts:97`, `isTransientFactoryPath` from `git-ops.ts:120`.
    * Produces (new file):
      ```ts
      // packages/core/src/runtime/can-complete-run.ts
      import fs from "node:fs/promises";
      import path from "node:path";
      import { isTransientFactoryPath } from "./git-ops.js";
      import type { PrototypeFinalMergeArtifact, PrototypeCompletedTaskArtifact } from "./artifacts.js";

      export interface CanCompleteRunInput {
        runDir: string;
        executionCwd: string;
        baseBranch: string;
        candidateSha?: string;
        finalMergePath?: string;
        completedTasks: PrototypeCompletedTaskArtifact[];
        /** True if any implementation task was blocked (CONTRACT_BLOCKED, etc.). */
        anyTaskBlocked: boolean;
        /** True if all blocking verification requirements passed. */
        verificationCanComplete: boolean;
        /** Verification contract plan (used to confirm an IMPL_DIFF requirement ran). */
        hadImplDiffRequirement: boolean;
      }

      export type CanCompleteRunResult =
        | { canComplete: true; productChangedFiles: string[] }
        | { canComplete: false; reason: string; phase: string };

      export async function canCompleteRun(input: CanCompleteRunInput): Promise<CanCompleteRunResult> {
        if (input.anyTaskBlocked) {
          return { canComplete: false, reason: "implementation task BLOCKED", phase: "implementation-blocked" };
        }
        if (!input.verificationCanComplete) {
          return { canComplete: false, reason: "verification did not pass", phase: "verification-blocked" };
        }

        // Merge provenance: the final-merge artifact must exist and say status === "merged".
        let mergeStatus: string | undefined;
        if (input.finalMergePath) {
          try {
            const raw = await fs.readFile(input.finalMergePath, "utf8");
            const parsed = JSON.parse(raw) as PrototypeFinalMergeArtifact;
            mergeStatus = parsed.status;
          } catch {
            return { canComplete: false, reason: "final-merge artifact unreadable", phase: "merge-blocked" };
          }
        }
        if (mergeStatus !== "merged") {
          return {
            canComplete: false,
            reason: `final-merge artifact status is '${mergeStatus ?? "missing"}', not 'merged'`,
            phase: "merge-blocked",
          };
        }

        // Product diff: at least one non-generated file must have changed between
        // the candidate and the base branch (or, when the IMPL_DIFF requirement
        // already ran, the requirement's PASS is sufficient). We re-derive here
        // as a defense-in-depth check independent of the requirement emission.
        const completedFiles = input.completedTasks.flatMap((task) => task.changedFiles ?? []);
        let productChangedFiles = completedFiles.filter((file) => !isTransientFactoryPath(file));
        if (productChangedFiles.length === 0 && input.candidateSha) {
          // Fallback: re-derive from the candidate SHA via the git-ops helper.
          // Reuse the same shape the verification phase uses for changed files.
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFile);
          try {
            const { stdout } = await execFileAsync(
              "git",
              ["diff", "--name-only", input.baseBranch, input.candidateSha],
              { cwd: input.executionCwd, windowsHide: true },
            );
            const derived = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            productChangedFiles = derived.filter((file) => !isTransientFactoryPath(file));
          } catch {
            // Leave productChangedFiles empty; gate below catches it.
          }
        }
        if (productChangedFiles.length === 0) {
          return {
            canComplete: false,
            reason: "no non-generated product files changed between candidate and base",
            phase: "no-product-changes",
          };
        }
        return { canComplete: true, productChangedFiles };
      }
      ```
      ```ts
      // controller.ts:1830-1870 (replace the unconditional COMPLETED write)
      const finalMergeArtifact = finalMergePath
        ? await fs.readFile(finalMergePath, "utf8").then(JSON.parse).catch(() => undefined)
        : undefined;
      const completedTasks = buildCompletedTasks(implementationRun.taskWorkspaces, loaded.effectiveConfig.git.baseBranch);
      const completion = await canCompleteRun({
        runDir: run.runDir,
        executionCwd,
        baseBranch: loaded.effectiveConfig.git.baseBranch,
        candidateSha,
        finalMergePath,
        completedTasks,
        anyTaskBlocked: implementationRun.taskWorkspaces.some((w) => w.status === "blocked"),
        verificationCanComplete: contractResult.canComplete,
        hadImplDiffRequirement: contractPlan.requirements.some((r) => r.type === "IMPL_DIFF"),
      });
      if (!completion.canComplete) {
        const blockedState = await updateFactoryRunState({
          statePath: run.statePath,
          patch: { status: "BLOCKED", phase: completion.phase },
        });
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "run.blocked",
          data: { reason: completion.reason, phase: completion.phase },
        });
        const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
          runId: run.runId,
          goal: input.goal,
          status: "BLOCKED",
          phase: blockedState.phase,
          approved: false,
          planPath, taskPaths,
          discoveryExecutionPath, plannerExecutionPath,
          builderExecutionPaths, integrationPath,
          finalMergePath, repairExecutionPaths,
          reviewerExecutionPath, verificationPath,
          verificationStatus: verification.overallStatus,
        });
        return {
          runId: run.runId, runDir: run.runDir, executionCwd, worktree,
          statePath: run.statePath, eventsPath: run.eventsPath, phases,
          approved: false, planPath, taskPaths,
          discoveryExecutionPath, plannerExecutionPath,
          builderExecutionPaths, integrationPath, finalMergePath, candidateSha,
          repairExecutionPaths, reviewerExecutionPath,
          verificationPath, summaryPath,
        };
      }
      const completedState = await updateFactoryRunState({
        statePath: run.statePath,
        patch: { status: "COMPLETED", phase: "complete" },
      });
      // ... existing summaryPath write with status: "COMPLETED", approved: true
      ```

      Integration-phase update (`controller.ts:2597-2685`): before the loop, inspect `implementationRun.taskWorkspaces` for any workspace whose `taskId` resolved to a `blocked` task artifact. If found, abort the loop and surface a `BLOCKED / "implementation-blocked"` summary instead of attempting integration. Concrete patch (replace the `runIntegrationPhase` call site at `controller.ts:1027-1042`):
      ```ts
      const blockedWorkspaces = implementationRun.taskWorkspaces.filter((workspace) => {
        // Cheap synchronous read of the task artifact status.
        // Implementation: the integration phase already accepts the workspaces;
        // we gate here by checking the local status field on the workspace
        // (the workspace status mirrors the task artifact's status after
        // Step 3 wired updatePrototypeTaskArtifact).
        return workspace.status === "blocked";
      });
      if (blockedWorkspaces.length > 0) {
        const blockedState = await updateFactoryRunState({
          statePath: run.statePath,
          patch: { status: "BLOCKED", phase: "implementation-blocked" },
        });
        const summaryPath = await writePrototypeSummaryArtifact(run.runDir, { ... });
        return { runId: ..., status: "BLOCKED", approved: false, summaryPath, ... };
      }
      await movePhase(run.statePath, run.eventsPath, run.runId, input, "integration", ...);
      ```
      Add a `status: "blocked"` field to `TaskWorkspaceSelection` (`controller.ts:1909-1931`):
      ```ts
      export interface TaskWorkspaceSelection {
        taskId: string;
        path: string;
        mode: "existing" | "created" | "in-place";
        branch?: string;
        commitSha?: string;
        changedFiles?: string[];
        shouldIntegrate: boolean;
        status?: "pending" | "running" | "done" | "failed" | "aborted" | "blocked";
      }
      ```

  * **Negative Paths:**
    * `canComplete === true` → run becomes `COMPLETED` / `approved: true`; existing behavior preserved.
    * `verificationCanComplete === false` → caught earlier at `controller.ts:1603`; the gate is redundant for this case but still correct (defense-in-depth).
    * `anyTaskBlocked === true` → gate fails with `phase: "implementation-blocked"`.
    * `finalMergePath` unreadable or status not `"merged"` → gate fails with `phase: "merge-blocked"`.
    * No product changes (re-derived) → gate fails with `phase: "no-product-changes"`.
    * Documentation-only run (`tasks` array has no implementation tasks) → `IMPL_DIFF` requirement not emitted (Step 4); `hadImplDiffRequirement === false`; gate still requires product changes; this is intentional — a doc-only run must still produce doc changes. (If a config-only / test-only run is desired as a no-product change `COMPLETED`, it must be explicitly allowed by adding a "documentation-only" sentinel; out of scope.)
    * Integration blocked → run becomes `BLOCKED / "implementation-blocked"` before verification.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'final approval|merge succeeded|implementation produced no file changes|completed implementation with no file changes|contract_blocked|no_product_changes|merge_blocked'` — PASS after Step 7.

* [ ] **Step 7: Add regression tests for the new failure paths**

  * **Files:**
    * `Test: tests/runtime.test.mjs` (append six new tests).

  * **Interfaces:**
    * Consumes: `runRuntimeHarness`, `withTempProject`, `readJson`, `makeExecutor`, `path`, `fs`, `assert`, `execFile` (already imported at `tests/runtime.test.mjs:1-10`).
    * Produces (six new tests, full bodies):
      ```js
      test('builder returns CONTRACT_BLOCKED → task is blocked and run is not COMPLETED', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(path.join(root, '.factory/config.yaml'),
            ['project:', '  baseBranch: main', 'commands:', '  lint: node -e ""',
             '  typecheck: node -e ""', '  test: node -e ""', '  build: node -e ""',
             'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
             'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
          );
          await execFile('git', ['add', '.'], { cwd: root });
          await execFile('git', ['commit', '-m', 'init'], { cwd: root });
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = {
            async execute(input) {
              calls.push({ label: 'builder', executionId: input.executionId });
              return {
                executionId: input.executionId,
                status: 'completed',
                outputText: 'CONTRACT_BLOCKED backend/package.json is required by the contract but is missing.',
                events: [],
              };
            },
            async cancel() {},
          };
          await runRuntimeHarness({
            cwd: root, goal: 'Add demo',
            plannerExecutor, builderExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          }).catch(() => {});
          const summary = await readJson(path.join(root, '.factory/runs', (await fs.readdir(path.join(root, '.factory/runs'))).sort().at(-1), 'summary.json'));
          assert.notEqual(summary.status, 'COMPLETED', 'run must not become COMPLETED when a task is blocked');
          assert.equal(summary.phase, 'implementation-blocked');
          assert.equal(summary.approved, false);
        });
      });

      test('no product-file changes → IMPL_DIFF requirement fails → run is BLOCKED', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(path.join(root, '.factory/config.yaml'),
            ['project:', '  baseBranch: main', 'commands:',
             '  lint: node -e ""', '  typecheck: node -e ""',
             '  test: node -e ""', '  build: node -e ""',
             'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
             'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
          );
          await execFile('git', ['add', '.'], { cwd: root });
          await execFile('git', ['commit', '-m', 'init'], { cwd: root });
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          // Builder writes only to .factory/runs/... (a transient Factory path),
          // which the new filtered commitWorkspaceChanges rejects.
          const builderExecutor = {
            async execute(input) {
              calls.push({ label: 'builder' });
              await fs.mkdir(path.join(input.cwd, '.factory/runs/inner'), { recursive: true });
              await fs.writeFile(path.join(input.cwd, '.factory/runs/inner/notes.txt'), 'noop\n');
              return { executionId: input.executionId, status: 'completed', outputText: 'ok', events: [] };
            },
            async cancel() {},
          };
          await runRuntimeHarness({
            cwd: root, goal: 'Add demo',
            plannerExecutor, builderExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          }).catch(() => {});
          const runDir = path.join(root, '.factory/runs', (await fs.readdir(path.join(root, '.factory/runs'))).sort().at(-1));
          const summary = await readJson(path.join(runDir, 'summary.json'));
          assert.notEqual(summary.status, 'COMPLETED', 'run must not become COMPLETED when no product changes were produced');
          // Either implementation-failed (no-commit retry path) or verification-blocked (IMPL_DIFF fail) is acceptable.
          assert.ok(['implementation-failed', 'implementation-blocked', 'no-product-changes', 'verification-blocked'].includes(summary.phase),
            `unexpected phase: ${summary.phase}`);
        });
      });

      test('verification canComplete true but final merge artifact is skipped → run is BLOCKED merge-blocked', async () => {
        await withTempProject(async (root) => {
          // Force runFinalMergePhase into its `FACTORY_SKIP_FINAL_MERGE=1` branch.
          process.env.FACTORY_SKIP_FINAL_MERGE = '1';
          try {
            await fs.writeFile(path.join(root, '.factory/config.yaml'),
              ['project:', '  baseBranch: main', 'commands:',
               '  lint: node -e ""', '  typecheck: node -e ""',
               '  test: node -e ""', '  build: node -e ""',
               'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
               'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
            );
            await execFile('git', ['add', '.'], { cwd: root });
            await execFile('git', ['commit', '-m', 'init'], { cwd: root });
            const calls = [];
            const plannerExecutor = makeExecutor('planner', calls);
            const builderExecutor = {
              async execute(input) {
                await fs.writeFile(path.join(input.cwd, 'src/change.txt'), 'real product change\n');
                return { executionId: input.executionId, status: 'completed', outputText: 'ok', events: [] };
              },
              async cancel() {},
            };
            await runRuntimeHarness({
              cwd: root, goal: 'Add demo',
              plannerExecutor, builderExecutor,
              requestPlanApproval: async () => ({ decision: 'approve' }),
              requestApproval: async () => true,
            }).catch(() => {});
            const runDir = path.join(root, '.factory/runs', (await fs.readdir(path.join(root, '.factory/runs'))).sort().at(-1));
            const summary = await readJson(path.join(runDir, 'summary.json'));
            assert.notEqual(summary.status, 'COMPLETED', 'run must not become COMPLETED when the merge was skipped');
            assert.equal(summary.phase, 'merge-blocked');
            assert.equal(summary.approved, false);
          } finally {
            delete process.env.FACTORY_SKIP_FINAL_MERGE;
          }
        });
      });

      test('all tasks succeeded + product change + merge completed → run is COMPLETED (regression guard)', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(path.join(root, '.factory/config.yaml'),
            ['project:', '  baseBranch: main', 'commands:',
             '  lint: node -e ""', '  typecheck: node -e ""',
             '  test: node -e ""', '  build: node -e ""',
             'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
             'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
          );
          await execFile('git', ['add', '.'], { cwd: root });
          await execFile('git', ['commit', '-m', 'init'], { cwd: root });
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = {
            async execute(input) {
              await fs.writeFile(path.join(input.cwd, 'src/change.txt'), 'real product change\n');
              return { executionId: input.executionId, status: 'completed', outputText: 'ok', events: [] };
            },
            async cancel() {},
          };
          const result = await runRuntimeHarness({
            cwd: root, goal: 'Add demo',
            plannerExecutor, builderExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          });
          assert.equal(result.approved, true);
          const summary = await readJson(result.summaryPath);
          assert.equal(summary.status, 'COMPLETED');
          assert.equal(summary.approved, true);
        });
      });

      test('blocked task does not advance to verification or merge', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(path.join(root, '.factory/config.yaml'),
            ['project:', '  baseBranch: main', 'commands:',
             '  lint: node -e ""', '  typecheck: node -e ""',
             '  test: node -e ""', '  build: node -e ""',
             'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
             'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
          );
          await execFile('git', ['add', '.'], { cwd: root });
          await execFile('git', ['commit', '-m', 'init'], { cwd: root });
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = {
            async execute(input) {
              return {
                executionId: input.executionId, status: 'completed',
                outputText: 'CONTRACT_BLOCKED missing file', events: [],
              };
            },
            async cancel() {},
          };
          await runRuntimeHarness({
            cwd: root, goal: 'Add demo',
            plannerExecutor, builderExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          }).catch(() => {});
          const runDir = path.join(root, '.factory/runs', (await fs.readdir(path.join(root, '.factory/runs'))).sort().at(-1));
          const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
          assert.ok(events.some((l) => /task\.contract_blocked/.test(l)), 'task.contract_blocked must be emitted');
          assert.ok(!events.some((l) => /phase\.verification/.test(l)), 'verification must not run when a task is blocked');
          assert.ok(!events.some((l) => /phase\.merge/.test(l)), 'merge must not run when a task is blocked');
          assert.ok(!events.some((l) => /run\.completed/.test(l)), 'run.completed must not be emitted when a task is blocked');
        });
      });

      test('property-style invariant: run.status === COMPLETED implies a non-empty product diff', async () => {
        // Property test: walk all the summaries in .factory/runs and assert the invariant.
        await withTempProject(async (root) => {
          await fs.writeFile(path.join(root, '.factory/config.yaml'),
            ['project:', '  baseBranch: main', 'commands:',
             '  lint: node -e ""', '  typecheck: node -e ""',
             '  test: node -e ""', '  build: node -e ""',
             'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false',
             'repair:', '  enabled: false', 'approval:', '  finalMerge: required'].join('\n'),
          );
          await execFile('git', ['add', '.'], { cwd: root });
          await execFile('git', ['commit', '-m', 'init'], { cwd: root });
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = {
            async execute(input) {
              await fs.writeFile(path.join(input.cwd, 'src/change.txt'), 'real product change\n');
              return { executionId: input.executionId, status: 'completed', outputText: 'ok', events: [] };
            },
            async cancel() {},
          };
          await runRuntimeHarness({
            cwd: root, goal: 'Add demo',
            plannerExecutor, builderExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          });
          const runsDir = path.join(root, '.factory/runs');
          const runs = await fs.readdir(runsDir);
          const summaries = await Promise.all(runs.map((run) =>
            fs.readFile(path.join(runsDir, run, 'summary.json'), 'utf8').then(JSON.parse).catch(() => null),
          ));
          const completed = summaries.filter((s) => s && s.status === 'COMPLETED');
          assert.ok(completed.length > 0, 'at least one run must complete');
          for (const summary of completed) {
            // Read final-merge artifact to confirm merged status.
            const finalMerge = summary.finalMergePath
              ? await fs.readFile(summary.finalMergePath, 'utf8').then(JSON.parse).catch(() => null)
              : null;
            assert.equal(finalMerge?.status, 'merged', 'final-merge status must be "merged" for a COMPLETED run');
            // The product diff requirement must have passed; this is captured implicitly
            // by the run reaching COMPLETED through the gate.
          }
        });
      });
      ```

  * **Negative Paths:**
    * Each test uses its own temp dir (`withTempProject`) so state isolation is guaranteed.
    * `process.env.FACTORY_SKIP_FINAL_MERGE` is set only inside the third test and cleaned up in `finally` so other tests are unaffected.
    * The property-style test reads summary + final-merge artifacts; if either file is missing, the test fails fast.

  * **Verification:**
    * `node --test tests/runtime.test.mjs --test-name-pattern 'builder returns CONTRACT_BLOCKED|no product-file changes|verification canComplete true but final merge artifact is skipped|all tasks succeeded|blocked task does not advance to verification|property-style invariant'` — PASS for all six tests.

* [ ] **Step 8: Update learnings with the invariants**

  * **Files:**
    * `Modify: learnings.md` (append two bullets)

  * **Interfaces:**
    * Consumes: existing file.
    * Produces (append):
      ```markdown
      - `CONTRACT_BLOCKED` is a real task state, not a status string in the builder output. The active controller's `runImplementationTask` must classify the Builder's directive and translate it into `task.status = "blocked"` + `run.status = "BLOCKED"` so dependent tasks cannot advance.
      - `run.status === "COMPLETED"` requires all of: every required task is SUCCEEDED (none BLOCKED / FAILED), verification canComplete, the candidate commit has a non-generated product diff, and the final-merge artifact is `status: "merged"`. The gate lives in `packages/core/src/runtime/can-complete-run.ts`; the unconditional `COMPLETED` write in the controller is replaced by a call to it.
      ```

  * **Negative Paths:** none.

  * **Verification:**
    * `grep -n "CONTRACT_BLOCKED is a real task state\|run.status === \"COMPLETED\" requires" learnings.md` returns two matches.

* [ ] **Step 9: Full verification**

  * **Files:** none.
  * **Interfaces/Code:** none.
  * **Negative Paths:**
    * `PrototypeTaskArtifact.status` now has six literals; every consumer that compares to `"done"` or `"failed"` is unaffected. Any consumer that enumerates all values (none exists in the active controller) would need updating; none does.
    * Dead modules (`discovery-phase.ts`, `controller-run.ts`, etc.) still define their own `task.status` strings; not changed.
    * `git-ops.commitWorkspaceChanges` is now also imported by the active controller; the active controller's `WorkspaceCommitResult` shape (with `commitSha`) matches.

  * **Verification:**
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.
    * `npm run complexity` — PASS.
    * `node --test tests/builder-outcome.test.mjs` — PASS (no change to the classifier; existing six tests pass).
    * `node --test tests/verification-engine.test.mjs` — PASS (existing engine tests do not exercise `IMPL_DIFF`).
    * `node --test tests/runtime.test.mjs` — PASS for the entire file (existing + six new tests).
    * `node --test tests/factory-command-e2e.test.mjs` — PASS (the e2e test exercises the no-product-changes path with a real builder executor; with the new gate, it must end `BLOCKED`, not `COMPLETED`. If this test currently expects `COMPLETED`, update it to assert the new blocked phase.)
    * `npm test` — PASS (full suite).
    * Manual smoke: run a Factory session where the Builder emits `CONTRACT_BLOCKED`; observe `task.contract_blocked` → `run.blocked` → `summary.status: "BLOCKED"`, `phase: "implementation-blocked"`. No verification, no merge, no `run.completed`.

## 4. Testing

* **Regression first — existing tests must continue to pass:**
  * `tests/runtime.test.mjs:2193` — no-change → retry → fail; expected outcome unchanged because the builder emits no directive.
  * `tests/runtime.test.mjs:2257` — no-change → retry → success; expected outcome unchanged because the builder writes a real product file (`retry-output.txt`).
  * `tests/runtime.test.mjs:2367-2414` — contract completion gate; unaffected because `IMPL_DIFF` is additive and the fixture's product diff is non-empty.
  * `tests/runtime.test.mjs:2439-2510` — reviewer NEEDS_DECISION; unaffected.
  * `tests/runtime.test.mjs:2561` — final approval after plan approval and implementation; unaffected.
  * `tests/builder-outcome.test.mjs:30-83` — six unit tests for the classifier; unaffected.

* **New tests (Step 7) cover the six scenarios:**
  1. `builder returns CONTRACT_BLOCKED → task is blocked and run is not COMPLETED` — proves Step 3 + Step 5.
  2. `no product-file changes → IMPL_DIFF requirement fails → run is BLOCKED` — proves Step 4 + Step 6.
  3. `verification canComplete true but final merge artifact is skipped → run is BLOCKED merge-blocked` — proves Step 6 final-merge gate.
  4. `all tasks succeeded + product change + merge completed → run is COMPLETED (regression guard)` — proves no regression of the happy path.
  5. `blocked task does not advance to verification or merge` — proves Step 5 + Step 6 ordering.
  6. `property-style invariant: run.status === COMPLETED implies final-merge status === "merged"` — defense-in-depth property test across all runs in a temp directory.

* **Full-suite:** `npm test` — PASS.

## 5. Definition of Done

* [ ] Required behavior works:
  * `CONTRACT_BLOCKED` directive → `task.status = "blocked"` + `task.contract_blocked` event + run becomes `BLOCKED / "implementation-blocked"` without reaching verification, integration, merge, or `COMPLETED`.
  * `CONTRACT_NOOP` directive → task becomes `done`; the run's product-diff gate still applies.
  * No product-file changes (only `.factory/**`, dependency bookkeeping, or nothing) → `IMPL_DIFF` requirement fails → `verification.canComplete === false` → run becomes `BLOCKED / "verification-blocked"`; if the gate's defense-in-depth check still finds no product changes, run becomes `BLOCKED / "no-product-changes"`.
  * `runFinalMergePhase` returns a non-`"merged"` artifact → run becomes `BLOCKED / "merge-blocked"`, `approved: false`.
  * All required tasks SUCCEEDED + verification passed + product diff + final merge = `"merged"` → run becomes `COMPLETED`, `approved: true` (existing happy path).
* [ ] Negative paths behave correctly:
  * `CONTRACT_BLOCKED` → no verification, no integration, no merge, no `run.completed`.
  * `CONTRACT_NOOP` → task `done`, but run is `BLOCKED` if no other task produced product changes.
  * No-commit builder → existing retry-then-fail path; `FAILED / "implementation-failed"`.
  * `executor-failed` → existing `FAILED` path; no behavior change.
  * Final merge skipped by env var / policy / no branch / existing worktree → `BLOCKED / "merge-blocked"`.
  * Legacy summary artifacts without the new fields remain readable (no schema break for reads).
* [ ] Tests pass (`npm test`, including the six new tests in Step 7).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Lint passes (`npm run complexity`).
* [ ] Build passes (`npm run build`).
* [ ] No migrations required. `PrototypeTaskArtifact.status` and `FactoryRunState.status` accept the new `"blocked"` literal without breaking reads. `PrototypeFinalMergeArtifact.status` is already a `string`; no change.
* [ ] `canCompleteRun` is the single gate the `COMPLETED` write goes through. Any path that reaches `COMPLETED` must have traversed the gate.
* [ ] `learnings.md` updated with the two invariants.
