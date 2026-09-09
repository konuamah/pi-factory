# Complete Interactive Failure Recovery Coverage

## 1. Understanding & Scope

* **Core Goal:** Finish the remaining adaptive recovery coverage so live Pi runs communicate recoverable problems to the user before terminal states for implementation failures, review failures, final approval unavailable/rejected paths, landing/post-landing failures, and process restart from a pending `decision-runtime` recovery request.
* **Current Behavior:**
  * The prior recovery slice in branch/worktree `feature/interactive-failure-recovery` adds `requestFailureRecovery`, `FailureRecoveryAction`, `FailureRecoveryContext`, `FailureRecoveryResolution`, `buildFailureRecoveryRequest`, and `shouldUseInteractiveRecovery` in `packages/core/src/runtime/failure-recovery.ts:1-111`.
  * The controller input already has optional `failureRecovery?: FailureRecoveryConfig` in `packages/core/src/runtime/controller.ts:93-119`.
  * Pi recovery decisions route through `requestDecisionInput` when `source === "RUNTIME" && reason === "FAILURE_RECOVERY"` in `packages/adapters/pi/src/decision-dialog.ts:20-139`.
  * Implementation still ends immediately when `runImplementationTasks` returns `ok: false`; it writes `run.failed` or `run.blocked`, updates state to `FAILED` or `BLOCKED`, writes summary, and returns in `packages/core/src/runtime/implementation-phase.ts:102-158`.
  * `runImplementationTasks` skips tasks with `task.status === "done"`, but it does not currently update the in-memory task status after successful task execution; see `packages/core/src/runtime/implementation-tasks.ts:60-68` and `143-159`. This matters for safe in-process retries.
  * Final phases still hard-stop on contract verification blocked (`packages/core/src/runtime/controller-final-phases.ts:68-123`), review unavailable (`185-247`), reviewer executor failed (`300-337`), final approval unavailable (`387-441`), and final approval rejected (`459-506`).
  * Landing still immediately uses blocked/PR fallback when guard checks fail (`packages/core/src/runtime/landing.ts:121-135`), and it finalizes blocked after failed landing execution (`298-342`, `462-559`). Post-landing verification failure can try repair once, but does not ask the user and does not commit a post-landing repair in the shown flow (`221-297`).
  * `/factory resume` currently calls `resumeLatestFactoryRun`, which updates status/phase metadata only; it does not request the pending runtime decision or continue the controller pipeline (`packages/adapters/pi/src/gateway-runs.ts:1-10`, `packages/core/src/runs/resume.ts:39-162`, `233-275`).
* **Target Behavior:**
  * Implementation failure/no-op/blocked states ask a runtime recovery decision when an interactive handler exists. Retry reruns only unfinished/failed tasks, not tasks already completed and committed. No-op remains truthful and cannot be forced into cosmetic edits.
  * Review unavailable/failed states ask a runtime recovery decision where retry can rerun review after the user fixes model/UI/executor conditions; unavailable executor without a possible new executor remains stop-only and fails loud.
  * Final approval unavailable can fall back to a runtime decision as a real human approval surface when `requestDecision` exists. Final approval rejection can collect optional rejection feedback and offer repair/revise/stop once, without nagging after an intentional stop.
  * Landing guard/execution/post-landing failures ask before PR fallback or blocked finalization. Post-landing repair is explicit because it edits the target checkout after the original landing.
  * A pending `DECISION_REQUIRED / decision-runtime` run can be resumed from a fresh Pi process: `/factory resume` reads a checkpoint, asks/resolves the pending decision, reconstructs needed phase state from artifacts, and continues at the checkpointed phase when safe.
* **Files Affected:**
  * `packages/core/src/runtime/failure-recovery.ts`
  * `packages/core/src/runtime/recovery-checkpoint.ts` (create)
  * `packages/core/src/runtime/controller.ts`
  * `packages/core/src/runtime/controller-run.ts`
  * `packages/core/src/runtime/implementation-phase.ts`
  * `packages/core/src/runtime/implementation-tasks.ts`
  * `packages/core/src/runtime/controller-final-phases.ts`
  * `packages/core/src/runtime/landing.ts`
  * `packages/core/src/runs/resume.ts`
  * `packages/core/src/runs/show.ts`
  * `packages/core/src/runs/logs-by-id.ts`
  * `packages/adapters/pi/src/gateway-runs.ts`
  * `packages/adapters/pi/src/gateway-prototype.ts`
  * `packages/adapters/pi/src/decision-dialog.ts`
  * `tests/failure-recovery.test.mjs`
  * `tests/runtime.test.mjs`
  * `tests/pi-adapter.test.mjs`
  * `tests/headless.test.mjs`
  * `docs/factory/troubleshooting.md`
  * `docs/factory/workflow-authoring.md`
  * `.pi/skills/factory-concierge/SKILL.md`
  * `skills/factory-concierge/SKILL.md`
  * `learnings.md`
* **Out of Scope:**
  * Resource limit extension or override. `runTimeoutMs`, `turnTimeoutMs`, `toolTimeoutMs`, `maxTurns`, and `runDeadlineAt` remain deterministic hard ceilings.
  * Bypassing verification, review, approval, capability policy, permissions, or landing safety.
  * Automatic repair without an explicit existing repair executor and allowed tool/capability policy.
  * Cross-machine distributed resume. Resume is local to the same repository and saved run artifacts.

## 2. Assumptions & Blockers

* **Assumptions:**
  * This plan starts from the already implemented `feature/interactive-failure-recovery` slice. If the builder starts from `refactor/verification-command-discovery`, first merge/apply that slice because `failure-recovery.ts`, `FAILURE_RECOVERY`, and Pi runtime recovery routing are not present there.
  * Pi is the interactive consumer. Headless/API runs without `requestDecision` keep deterministic failure results.
  * A retry is safe only when the phase callback can produce a new artifact or verification signal; otherwise the recovery option set must omit retry/repair and provide stop with clear artifact references.
  * Approval rejection is a user decision, not a bug. Factory may offer one recovery follow-up only when the UI can collect feedback; if the user selects stop or dismisses, preserve `CANCELLED / approval-rejected`.
* **Questions / Blockers:**
  * Blocker if previous recovery slice is not available in the builder checkout: apply `feature/interactive-failure-recovery` first or include its equivalent commits in the same branch.

## 3. Implementation Plan

* [ ] **Step 1: Recovery checkpoint and resume contract**

  * **Files:**
    * `Modify: packages/core/src/runtime/failure-recovery.ts:1-111`
    * `Create: packages/core/src/runtime/recovery-checkpoint.ts:1-240`
    * `Modify: packages/core/src/runtime/index.ts:1-25`
    * `Modify: packages/core/src/runs/resume.ts:10-37, 39-162, 164-230, 233-275`
    * `Test: tests/failure-recovery.test.mjs:1-190`
  * **Interfaces:** Consume existing `FailureRecoveryContext`, `FailureRecoveryResolution`, `requestFailureRecovery`, `DecisionRequest`, `DecisionResult`, `readDecisionLedger`, `findPendingDecision`, `FactoryRunState`, and artifact paths. Produce these exact symbols:
    * `export interface RecoveryCheckpoint` from `recovery-checkpoint.ts` with fields shown in the code snippet.
    * `export async function writeRecoveryCheckpoint(runDir: string, checkpoint: RecoveryCheckpoint): Promise<string>`.
    * `export async function readRecoveryCheckpoint(runDir: string): Promise<RecoveryCheckpoint | undefined>`.
    * `export async function clearRecoveryCheckpoint(runDir: string): Promise<void>`.
    * `export interface PendingRecoveryDecisionSummary { requestId: string; title: string; phase: string; question: string; options: string[]; checkpointPath?: string; }`.
    * Add `pendingDecision?: PendingRecoveryDecisionSummary` to `ResumeFactoryRunResult["recovery"]` in `packages/core/src/runs/resume.ts`.
  * **Code:**
    ```ts
    export type RecoveryCheckpointPhase =
      | "implementation"
      | "verification-blocked"
      | "review"
      | "approval-ready"
      | "landing-planning"
      | "post-landing-verification";

    export interface RecoveryCheckpoint {
      version: 1;
      runId: string;
      goal: string;
      phase: RecoveryCheckpointPhase;
      createdAt: string;
      executionCwd: string;
      projectRoot: string;
      worktree?: RunFactoryControllerResult["worktree"];
      planPath?: string;
      taskPaths?: string[];
      discoveryExecutionPath?: string;
      plannerExecutionPath?: string;
      builderExecutionPaths?: string[];
      integrationPath?: string;
      repairExecutionPaths?: string[];
      verificationPath?: string;
      finalMergePath?: string;
      candidateSha?: string;
      recoveryContext: FailureRecoveryContext;
    }

    export async function writeRecoveryCheckpoint(
      runDir: string,
      checkpoint: RecoveryCheckpoint,
    ): Promise<string> {
      const checkpointPath = path.join(runDir, "recovery-checkpoint.json");
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");
      return checkpointPath;
    }
    ```
    Update `requestFailureRecovery` to accept `checkpoint?: Omit<RecoveryCheckpoint, "recoveryContext" | "createdAt" | "version">` and write the checkpoint before calling `requestHumanDecision`. `resumeLatestFactoryRun` must read `findPendingDecision(runDir)` when `currentPhase === "decision-runtime"`, include `pendingDecision`, and leave the run in `PENDING` rather than pretending the controller has continued.
  * **Negative Paths:**
    * Missing or malformed `recovery-checkpoint.json`: `resumeLatestFactoryRun` returns `resumed: false`, `recovery.resumable: false`, and reason `Pending runtime recovery is missing its checkpoint artifact`.
    * Pending decision source is not `RUNTIME`: existing interview/reviewer decision resume behavior remains unchanged.
    * Resolved decision exists: `pendingDecision` is omitted and normal resume policy applies.
    * Checkpoint paths must be inside the run directory or known execution workspace; reject absolute unrelated paths from malformed artifacts.
  * **Verification:** `npm run build` — PASS. `node --test tests/failure-recovery.test.mjs` — PASS with tests for checkpoint write/read/clear, pending runtime decision summary, malformed checkpoint rejection, and non-runtime decision preservation.

* [ ] **Step 2: Implementation terminal recovery without duplicate completed tasks**

  * **Files:**
    * `Modify: packages/core/src/runtime/implementation-tasks.ts:16-54, 60-68, 143-163`
    * `Modify: packages/core/src/runtime/implementation-phase.ts:43-165`
    * `Modify: packages/core/src/runtime/implementation-task.ts:253-470`
    * `Test: tests/runtime.test.mjs:2535-2659`
    * `Test: tests/failure-recovery.test.mjs:190-340`
  * **Interfaces:** Consume `runImplementationTasks`, `ImplementationPhaseState`, `TaskWorkspaceSelection`, `BuilderOutcomeKind`, `requestFailureRecovery`, `writeRecoveryCheckpoint`, and `loadRunDecisions`. Produce:
    * `ImplementationFailureResult` type exported from `implementation-tasks.ts` so implementation-phase can inspect `failureKind`, `failureReason`, `failedTask`, and `taskWorkspaces` consistently.
    * In-memory mutation `task.status = "done"` only after `runImplementationTask` succeeds; this lets a second `runImplementationTasks` call skip completed tasks in the same controller process.
    * `runImplementationPhase` loop that asks recovery before terminal `FAILED/BLOCKED` state.
  * **Code:**
    ```ts
    export type ImplementationTasksResult =
      | { ok: true; taskWorkspaces: TaskWorkspaceSelection[] }
      | {
          ok: false;
          failedTask: PlannerTask;
          failedPhase: string;
          failureKind: BuilderOutcomeKind;
          failureReason: string;
          taskWorkspaces: TaskWorkspaceSelection[];
        };

    // Inside runImplementationTasks result loop after a successful task:
    if (result.ok) {
      result.task.status = "done";
      completed.add(result.task.id);
      continue;
    }

    // Inside runImplementationPhase:
    let implementationRun: Awaited<ReturnType<typeof runImplementationTasks>>;
    for (let recoveryAttempt = 1; ; recoveryAttempt += 1) {
      implementationRun = await runImplementationTasks(buildImplementationTasksInput(state));
      if (implementationRun.ok) break;
      const blocked = implementationRun.failureKind === "contract-noop"
        || implementationRun.failureKind === "contract-blocked"
        || implementationRun.failedPhase === "implementation-blocked";
      const recovery = await requestFailureRecovery({
        controllerInput: input,
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        checkpoint: buildImplementationCheckpoint(state, implementationRun),
        context: {
          phase: "implementation",
          title: blocked ? "implementation is blocked" : "implementation failed",
          reason: implementationRun.failureReason,
          category: implementationRun.failureKind,
          retryable: implementationRun.failureKind !== "contract-noop",
          canRepair: Boolean(input.repairExecutor && loaded.effectiveConfig.repair.enabled && implementationRun.failureKind !== "contract-noop"),
          canRevise: true,
          evidenceRefs: builderExecutionPaths,
          attempt: recoveryAttempt,
        },
      });
      if (recovery.action === "retry" || recovery.action === "repair" || recovery.action === "revise") {
        implementationRun.failedTask.context = {
          ...implementationRun.failedTask.context,
          runtimeRecoveryFeedback: recovery.feedback,
        };
        continue;
      }
      return finalizeImplementationFailure(state, implementationRun, blocked);
    }
    ```
    Extract the existing terminal summary block from `implementation-phase.ts:102-158` into `finalizeImplementationFailure(...)` so stop/exhausted paths reuse the old artifact contract.
  * **Negative Paths:**
    * `contract-noop`: offer `revise` and `stop`, omit retry/repair because forcing a diff would violate the existing Builder contract.
    * `contract-blocked`: offer retry after user fixes the named condition; offer repair only when a repair executor exists and repair is enabled.
    * `executor-failed` or `no-change-unclear`: offer retry; preserve the existing one automatic no-change retry inside `implementation-task.ts` before asking the user.
    * Completed tasks must not run a second time; assert only failed/pending task ids are present in `implementation.batch_started` after recovery.
    * If recovery is disabled or no decision handler exists, exact current `FAILED`/`BLOCKED` states remain.
  * **Verification:** `npm run build` — PASS. `node --test --test-name-pattern 'completed implementation with no file changes|CONTRACT_NOOP|CONTRACT_BLOCKED|implementation terminal recovery' tests/runtime.test.mjs tests/failure-recovery.test.mjs` — PASS.

* [ ] **Step 3: Review and contract-blocked recovery in final phases**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:68-123, 125-184, 185-260, 300-337`
    * `Test: tests/runtime.test.mjs:360-520, 3800-3895`
    * `Test: tests/failure-recovery.test.mjs:340-500`
  * **Interfaces:** Consume `requestFailureRecovery`, `writeRecoveryCheckpoint`, `buildReviewSurface`, `evaluateDeterministicReview`, `buildReviewerPrompt`, `classifyReviewerVerdict`, `writePrototypeReviewerExecutionArtifact`, `buildRunFailureResult`. Produce helper functions local to `controller-final-phases.ts`:
    * `async function buildOrRecoverReviewSurface(state: FinalPhasesState): Promise<Awaited<ReturnType<typeof buildReviewSurface>> | undefined>`.
    * `async function runReviewAttempt(state: FinalPhasesState, reviewSurface: Awaited<ReturnType<typeof buildReviewSurface>> | undefined): Promise<{ reviewerExecutionPath?: string; reviewerVerdict?: { verdict: ReviewerVerdict; summary: string }; reviewerResult: AgentExecutionResult } | RunFactoryControllerResult>`.
    * `async function finalizeVerificationBlocked(state: FinalPhasesState, reason: string): Promise<RunFactoryControllerResult>` extracted from lines `68-123`.
  * **Code:**
    ```ts
    if (!contractResult.canComplete) {
      const failingRequirements = contractResult.results
        .filter((result) => result.blocking && result.status !== "PASS" && result.status !== "NOT_APPLICABLE")
        .map((result) => `${result.requirementId}: ${result.reason ?? result.status}`);
      const recovery = await requestFailureRecovery({
        controllerInput: input,
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        checkpoint: buildFinalPhaseCheckpoint(state, "verification-blocked"),
        context: {
          phase: "verification-blocked",
          title: "contract verification is blocked",
          reason: failingRequirements.join("; ") || "Contract verification cannot complete.",
          category: "contract-verification",
          retryable: true,
          canRepair: Boolean(input.repairExecutor && loaded.effectiveConfig.repair.enabled),
          canRevise: true,
          evidenceRefs: [verificationPath],
          attempt: recoveryAttempt,
        },
      });
      if (recovery.action === "retry" || recovery.action === "repair" || recovery.action === "revise") {
        return { retryFinalPhases: true, feedback: recovery.feedback } as never;
      }
      return finalizeVerificationBlocked(state, recovery.feedback ?? "Contract verification cannot complete; run blocked");
    }
    ```
    Replace review unavailable and reviewer failure terminal blocks with a bounded review retry loop. For `review-unavailable`, `retryable` is true only when `input.reviewerExecutor` exists or deterministic review could become eligible after the user fixes artifacts; otherwise request a stop-only recovery decision for user communication and artifact preservation.
  * **Negative Paths:**
    * Contract verification cannot be bypassed by user input; retry must rerun contract verification from verification artifacts or return blocked.
    * Missing reviewer executor with deterministic review ineligible cannot offer repair and cannot proceed to approval.
    * Reviewer result `status === "failed"` can retry review, but after attempt limit it returns the current `review-failed` summary path.
    * Review surface failure must not leak full diff into the recovery question; evidence refs point to plan/verification/reviewer artifacts.
  * **Verification:** `npm run build` — PASS. `node --test --test-name-pattern 'missing reviewer blocks|reviewer executor throw|contract completion gate blocks|review recovery' tests/runtime.test.mjs tests/failure-recovery.test.mjs` — PASS.

* [ ] **Step 4: Final approval unavailable/rejected adaptive path**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:86-120`
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:344-506`
    * `Modify: packages/adapters/pi/src/gateway-prototype.ts:210-268`
    * `Modify: packages/adapters/pi/src/decision-dialog.ts:118-139`
    * `Test: tests/pi-adapter.test.mjs:189-320`
    * `Test: tests/runtime.test.mjs:2760-2915, 3895-3980`
  * **Interfaces:** Preserve current `requestApproval?: (...) => Promise<boolean>` compatibility while accepting a structured return:
    * `export interface FinalApprovalDecision { approved: boolean; feedback?: string; decision?: "approve" | "reject" | "revise"; }` in `controller.ts`.
    * Change `requestApproval` return type to `Promise<boolean | FinalApprovalDecision>`.
    * Add `normalizeFinalApprovalDecision(value: boolean | FinalApprovalDecision): FinalApprovalDecision` local to `controller-final-phases.ts`.
  * **Code:**
    ```ts
    export interface FinalApprovalDecision {
      approved: boolean;
      feedback?: string;
      decision?: "approve" | "reject" | "revise";
    }

    function normalizeFinalApprovalDecision(value: boolean | FinalApprovalDecision): FinalApprovalDecision {
      return typeof value === "boolean"
        ? { approved: value, decision: value ? "approve" : "reject" }
        : { approved: value.approved, decision: value.decision ?? (value.approved ? "approve" : "reject"), feedback: value.feedback?.trim() || undefined };
    }

    if (!input.requestApproval && input.requestDecision) {
      const fallbackApproval = await requestFailureRecovery({
        controllerInput: input,
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        checkpoint: buildFinalPhaseCheckpoint(state, "approval-ready"),
        context: {
          phase: "approval-ready",
          title: "final approval handler is unavailable",
          reason: "No final approval handler configured; use this runtime decision only if you approve the reviewed candidate.",
          category: "approval-unavailable",
          retryable: false,
          canRevise: true,
          evidenceRefs: [planPath, verificationPath, reviewerExecutionPath].filter(Boolean),
          attempt: 1,
        },
      });
      if (fallbackApproval.action === "revise") return rerunRepairOrReviewWithApprovalFeedback(fallbackApproval.feedback);
      return finalizeApprovalUnavailable(state);
    }
    ```
    Pi `requestApproval` should return `{ approved, decision, feedback }` when the UI can collect feedback on rejection/revision. Existing callers returning boolean remain valid. On approval rejection, ask one runtime recovery decision with `revise` and `stop`: `revise` routes to repair/review when repair executor exists; `stop` preserves current `CANCELLED / approval-rejected` behavior.
  * **Negative Paths:**
    * No `requestApproval` and no `requestDecision`: keep `FAILED / approval-unavailable`.
    * User rejection followed by stop or dismissal: keep `CANCELLED / approval-rejected`; do not ask again.
    * Runtime fallback approval cannot auto-approve; it must require explicit user choice and preserve reviewer verdict/scope/baseline evidence in context.
    * Feedback is plain text only; it is not executed as a command.
  * **Verification:** `npm run build` — PASS. `node --test --test-name-pattern 'final approval|approval rejection|approval unavailable|runtime recovery decision' tests/runtime.test.mjs tests/pi-adapter.test.mjs` — PASS.

* [ ] **Step 5: Landing and post-landing recovery**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing.ts:121-156, 167-297, 298-342, 462-559`
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:511-560`
    * `Test: tests/landing.test.mjs:1-260`
    * `Test: tests/runtime.test.mjs:3980-4120`
  * **Interfaces:** Consume `requestFailureRecovery`, `writeRecoveryCheckpoint`, `runLandingFlow`, `LandingResult`, `VerificationRunResult`, `isIgnorableBaselineFailure`, `attemptLandingRepair`, and `rerunLandingVerification`. Produce:
    * `async function requestLandingRecovery(input: Parameters<typeof runLandingFlow>[0], context: FailureRecoveryContext): Promise<FailureRecoveryResolution>`.
    * `async function commitPostLandingRepair(cwd: string, runId: string): Promise<{ committed: boolean; commitSha?: string; changedFiles: string[] }>`.
    * `landingAttempts` increments per retry instead of remaining hard-coded at `1` in `finishLanding`.
  * **Code:**
    ```ts
    if (!guardVerdict.ok) {
      const recovery = await requestLandingRecovery(input, {
        phase: "landing-planning",
        title: "landing guard blocked the candidate",
        reason: guardVerdict.reasons.join("; "),
        category: "landing-guard",
        retryable: true,
        canRepair: false,
        canRevise: false,
        evidenceRefs: [path.join(input.runDir, "landing-plan.json")],
        attempt: landingAttempt,
      });
      if (recovery.action === "retry") {
        dirtyContext = await readLandingDirtyContext(input.mergeCwd, input.completedTasks);
        continue;
      }
      const pullRequest = await publishBlockedCandidate(input, guardVerdict.reasons.join("; "));
      return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? recovery.feedback ?? guardVerdict.reasons.join("; "), pullRequest);
    }

    async function commitPostLandingRepair(cwd: string, runId: string): Promise<{ committed: boolean; commitSha?: string; changedFiles: string[] }> {
      const changedFiles = await readChangedFiles(cwd);
      if (changedFiles.length === 0) return { committed: false, changedFiles };
      await execFileAsync("git", ["add", "--all", "--", ...changedFiles], { cwd, windowsHide: true });
      await execFileAsync("git", ["commit", "-m", `Factory post-landing repair ${runId}`], { cwd, windowsHide: true });
      return { committed: true, changedFiles, commitSha: await readGitHeadSha(cwd) };
    }
    ```
    Wrap guard blocked, `executeLandingStrategy` blocked/failed, and post-landing verification failed/error with recovery decisions. For post-landing repair, the recovery prompt must state that the candidate is already on the target branch and selecting repair may create a follow-up commit only if verification passes.
  * **Negative Paths:**
    * Baseline-unrelated post-landing failures still skip repair and record `landing.post_verification_repair_skipped`.
    * Dirty target guard retry rereads dirty files before a second landing attempt; it must not reuse stale guard evidence.
    * PR fallback remains available when the user stops or landing attempts are exhausted.
    * Post-landing repair that changes files but verification still fails must leave the changes visible and return `BLOCKED / merge-blocked`; it must not commit failing repair changes.
    * Candidate SHA/branch missing cannot be recovered by retry; ask stop and preserve artifacts.
  * **Verification:** `npm run build` — PASS. `node --test tests/landing.test.mjs` — PASS. `node --test --test-name-pattern 'landing recovery|post-landing|pull request recovery|baseline-unrelated' tests/runtime.test.mjs` — PASS.

* [ ] **Step 6: Fresh-process continuation from pending runtime recovery**

  * **Files:**
    * `Create: packages/core/src/runs/continue-recovery.ts:1-320`
    * `Modify: packages/core/src/runs/index.ts:1-40`
    * `Modify: packages/core/src/runtime/controller-run.ts:105-390`
    * `Modify: packages/adapters/pi/src/gateway-runs.ts:1-10, 160-250`
    * `Modify: packages/adapters/pi/src/gateway-prototype.ts:177-230`
    * `Test: tests/runtime.test.mjs:4120-4300`
    * `Test: tests/headless.test.mjs:1-140`
  * **Interfaces:** Consume `readRecoveryCheckpoint`, `findPendingDecision`, `appendDecisionLedgerEntry`, `runFactoryController`, Pi executor bundle creation from `gateway-prototype.ts`, and current resume status. Produce:
    * `export interface ContinueRecoveryInput { cwd: string; runsDir: string; requestDecision: RunFactoryControllerInput["requestDecision"]; executors: Pick<RunFactoryControllerInput, "discoveryExecutor" | "plannerExecutor" | "builderExecutor" | "repairExecutor" | "reviewerExecutor" | "verificationPlannerExecutor" | "failureClassifierExecutor" | "landingExecutor">; requestPlanApproval?: RunFactoryControllerInput["requestPlanApproval"]; requestApproval?: RunFactoryControllerInput["requestApproval"]; requestDependencyRemediation?: RunFactoryControllerInput["requestDependencyRemediation"]; }`.
    * `export async function continueLatestRecovery(input: ContinueRecoveryInput): Promise<RunFactoryControllerResult | ResumeFactoryRunResult>`.
    * `export async function continueFactoryControllerFromCheckpoint(input: RunFactoryControllerInput & { runDir: string; checkpoint: RecoveryCheckpoint; decision: FailureRecoveryResolution }): Promise<RunFactoryControllerResult>`.
  * **Code:**
    ```ts
    export async function continueLatestRecovery(input: ContinueRecoveryInput): Promise<RunFactoryControllerResult | ResumeFactoryRunResult> {
      const latest = await readLatestFactoryRunStatus(input.runsDir);
      if (!latest.runDir || latest.state?.phase !== "decision-runtime") {
        return resumeLatestFactoryRun(input.runsDir);
      }
      const checkpoint = await readRecoveryCheckpoint(latest.runDir);
      const pending = await findPendingDecision(latest.runDir);
      if (!checkpoint || !pending || pending.source !== "RUNTIME") {
        return resumeLatestFactoryRun(input.runsDir);
      }
      const result = await input.requestDecision(pending);
      await appendDecisionLedgerEntry(latest.runDir, { type: "resolution", result });
      const decision = { action: result.optionId as FailureRecoveryAction, feedback: result.feedback, requestId: result.requestId };
      return continueFactoryControllerFromCheckpoint({
        cwd: input.cwd,
        goal: checkpoint.goal,
        ...input.executors,
        requestPlanApproval: input.requestPlanApproval,
        requestApproval: input.requestApproval,
        requestDependencyRemediation: input.requestDependencyRemediation,
        requestDecision: input.requestDecision,
        runDir: latest.runDir,
        checkpoint,
        decision,
      });
    }
    ```
    `continueFactoryControllerFromCheckpoint` must reconstruct the smallest safe continuation: `implementation` rereads `plan.json` and task artifacts; `review` rereads completed task artifacts, plan, verification, and integration paths; `approval-ready` rereads candidate SHA and reviewer verdict; `landing-planning` rereads completed tasks, verification plan/result, and final merge artifacts. If reconstruction fails, it returns the existing resume diagnostic rather than starting an unrelated new run.
  * **Negative Paths:**
    * No pending runtime decision: `/factory resume` keeps existing metadata resume behavior.
    * Pending runtime decision with missing checkpoint: show a non-resumable diagnostic with artifact paths.
    * User selects stop after restart: write resolution, finalize using the phase's existing terminal status, and clear checkpoint.
    * User selects retry for a phase whose artifacts cannot be reconstructed: reject retry, record `run.recovery_resume_failed`, and keep the run `BLOCKED / recovery-resume-failed` with recovery hint.
    * Do not start a brand-new run silently; if continuation must create a replacement run, that must be shown as `recoveredFromRunId` and require explicit user selection.
  * **Verification:** `npm run build` — PASS. `node --test --test-name-pattern 'resume.*runtime recovery|continue recovery|pending runtime decision' tests/runtime.test.mjs tests/headless.test.mjs` — PASS.

* [ ] **Step 7: Inspection, docs, and known baseline test cleanup**

  * **Files:**
    * `Modify: packages/core/src/runs/show.ts:6-88, 90-148`
    * `Modify: packages/core/src/runs/logs-by-id.ts:15-105, 196-275`
    * `Modify: packages/adapters/pi/src/gateway-runs.ts:25-73`
    * `Modify: docs/factory/troubleshooting.md:57-90`
    * `Modify: docs/factory/workflow-authoring.md:79-90`
    * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140`
    * `Modify: skills/factory-concierge/SKILL.md:120-140`
    * `Modify: learnings.md:1-10`
    * `Modify: tests/runtime.test.mjs:2915-2945`
  * **Interfaces:** Consume `RecoveryCheckpoint`, `PendingRecoveryDecisionSummary`, recovery events, and decision ledger entries. Produce run inspection fields:
    * `recoveryCheckpoint?: RecoveryCheckpoint` in `FactoryRunShowResult`.
    * `pendingRecovery?: PendingRecoveryDecisionSummary` in show/log results.
    * `formatEventLine` entries for `run.recovery_requested`, `run.recovery_resolved`, `run.recovery_resume_failed`, and `run.recovery_exhausted`.
  * **Code:**
    ```ts
    if (event.type === "run.recovery_requested") {
      return `${timestamp} recovery requested | phase: ${String(event.data?.phase ?? "unknown")} | category: ${String(event.data?.category ?? "unknown")} | attempt: ${String(event.data?.attempt ?? "?")}`;
    }
    if (event.type === "run.recovery_resolved") {
      return `${timestamp} recovery resolved | phase: ${String(event.data?.phase ?? "unknown")} | action: ${String(event.data?.action ?? "unknown")}`;
    }
    ```
    Fix the existing brittle log-tail assertion by either increasing the default log event limit for `readLatestFactoryRunLogs` in the test or asserting the structured `logs.guidance` object instead of requiring the old `guidance selected` formatted line in a 12-event tail. This is an existing failure observed during the prior slice verification, and cleaning it here removes noise from full-suite validation.
  * **Negative Paths:**
    * Logs/show must not embed full stdout/stderr, environment variables, provider tokens, or raw command bodies beyond existing artifact references.
    * If checkpoint reading fails, show/log returns `pendingRecovery` with the request id and a warning, not a thrown UI error.
    * Documentation must not promise “no failures ever”; it must state that hard safety limits and missing interactive handlers still fail loud.
  * **Verification:** `npm run build` — PASS. `node --test --test-name-pattern 'logs and show surface plan feedback clearly|recovery logs|show recovery' tests/runtime.test.mjs` — PASS. `grep -n -i 'decision-runtime\|FAILURE_RECOVERY\|post-landing\|resume' docs/factory/troubleshooting.md docs/factory/workflow-authoring.md .pi/skills/factory-concierge/SKILL.md skills/factory-concierge/SKILL.md` — PASS.

## 4. Testing

* `npm run build` — PASS for all TypeScript workspaces.
* `npm run typecheck` — PASS with the new approval return type, checkpoint types, and continuation exports.
* `npm run complexity` — PASS; split helpers if any function crosses the complexity guard threshold.
* `node --test tests/failure-recovery.test.mjs` — PASS for request construction, checkpoint persistence, pending decision summary, invalid decision rejection, stop/exhaustion, and resume diagnostics.
* `node --test tests/pi-adapter.test.mjs` — PASS for runtime recovery option display, feedback capture, dismissal-to-stop, final approval structured rejection feedback, and legacy boolean approval behavior.
* `node --test --test-name-pattern 'completed implementation with no file changes|CONTRACT_NOOP|CONTRACT_BLOCKED|implementation terminal recovery|missing reviewer blocks|reviewer executor throw|contract completion gate blocks|final approval|approval rejection|approval unavailable|landing recovery|post-landing|resume.*runtime recovery|logs and show surface plan feedback clearly' tests/runtime.test.mjs` — PASS.
* `node --test tests/landing.test.mjs` — PASS for landing guard retry, PR fallback preservation, post-landing repair, and baseline-unrelated skip.
* `node --test tests/headless.test.mjs` — PASS to prove no-handler/headless behavior remains fail-loud and scripted decisions still work.
* `npm test` — PASS for full build, complexity guard, and all repository tests.

## 5. Definition of Done

* [ ] Required behavior works: implementation, review, approval, landing, post-landing, and restarted pending runtime decisions communicate through a persisted user recovery gate when interactive UI exists.
* [ ] Negative paths behave correctly: no handler, invalid decision, missing checkpoint, exhausted attempts, hard limits, permission/capability denials, and unsafe landing states never become false success.
* [ ] Tests pass.
* [ ] Type checks pass.
* [ ] Lint/static gate passes: this repository has no dedicated lint script; `npm run complexity` is the static guard.
* [ ] Build passes.
* [ ] Migrations/config changes are validated: no database migration is needed; any runtime input type change is backward-compatible with existing boolean approval handlers and absent recovery config.
