# Workflow Acceptance Phase

## 1. Understanding & Scope

* **Core Goal:**
  Replace the current two-gate tail (`approval-ready` → `landing-planning`) with a single terminal human decision called **`acceptance`**. The new sequence is:

  ```
  plan approval → build → verify → review → landing → acceptance
  ```

  Acceptance is the final user decision and the final workflow state. The landing deterministic guard and post-landing verification remain internal — their results are surfaced as **evidence** inside the acceptance step, not as separate user-facing phases. The separate `landing-authorization` and `post-landing-verification` user surfaces are removed.

* **Current Behavior:**
  * `packages/core/src/runtime/controller-final-phases.ts` orchestrates the current tail:
    - Phase `approval-ready` (move at line ~434): asks the user via `requestApproval`; rejection routes to `requestFailureRecovery(revise | stop)`; missing handler → `FAILED / approval-unavailable`.
    - Phase `landing-planning` (move at line ~644): calls `runLandingFlow`. Inside landing, the **deterministic guard** (`validateLandingPlan` at `landing.ts:109-115`) plus **dirty-file classification** and **`finalMergePolicy`** (`landing-git.ts:71`) already enforce safety internally.
    - Inside landing, `landing.ts:250-350` runs **post-landing verification**. If that fails (non-baseline), it calls `requestFailureRecovery` (`retry | repair | stop`) at lines 285-298 with phase `post-landing-verification` — this is the second user-facing surface to remove.
    - Terminal: `landingResult.status === "COMPLETED"` → `run.completed`; else `run.blocked` with phase `complete | merge-blocked | pull-request-opened` (per `landing-types.ts:50`).
  * `packages/core/src/runs/resume.ts:299-302` resume policy treats `currentPhase === "approval"` or `"merge"` as resumable near final approval.
  * `packages/core/src/runtime/planner.ts:405` builds the default workflow with a final `approval` stage (`type: "approval"`). There is **no** `landing` workflow stage — landing is controller-internal.
  * `packages/core/src/runtime/failure-recovery.ts` checkpoints use phase names like `"landing-planning"` and `"post-landing-verification"` (`recovery-checkpoint.ts` `RecoveryCheckpointPhase` union includes these at `controller-final-phases.ts:778`).
  * `packages/adapters/pi/src/approval.ts` renders plan approval (`requestPlanApprovalDecision`) and final approval (`resolveFinalApprovalConfirm` / `defaultFinalApproval`); Pi's `gateway-prototype.ts:210-260` wires both.
  * `packages/core/src/runtime/landing-types.ts:50` defines terminal phases: `"complete" | "merge-blocked" | "pull-request-opened"`.
  * Tests asserting current strings: `tests/runtime.test.mjs` (approval-ready / landing-planning / post-landing-verification assertions), `tests/failure-recovery.test.mjs`, `tests/pi-adapter.test.mjs`, `tests/landing.test.mjs`, `tests/headless.test.mjs`.

* **Target Behavior:**
  * The tail collapses to one user decision: **acceptance**. The controller sequence becomes:
    ```
    verified → review → landing → acceptance
    ```
    Plan approval still happens between planning and implementation (unchanged — it is the **first** gate, not a final-phase gate).
  * **Landing runs before acceptance.** `runLandingFlow` is invoked with the review verdict + verification results already in hand. The deterministic guard remains internal (no recovery dialog on guard failure for the happy path; landing either lands or `finishBlockedLanding` records the failure for evidence).
  * **Post-landing verification becomes evidence only.** Its result (passed/failed/skipped, command statuses, repair-attempted flag, baseline-debt skip reason) is collected and passed into the acceptance step. No `requestFailureRecovery` is called for post-landing failures.
  * **Acceptance is the single human decision.** The acceptance dialog presents: review verdict, baseline debt (if any), scope warnings (if any), verification status, post-landing verification status, landing outcome (landed/PR-published/blocked with reason), and the reviewer-blocking override semantics. The user picks one of:
    - `accept` (terminal: `COMPLETED / accepted`)
    - `revise` (returns to planning with feedback)
    - `reject` (terminal: `CANCELLED / rejected`)
  * **Landing guard failure (block) does not block acceptance.** When landing blocks (dirty files, no remote, guard verdict `ok === false`), `runLandingFlow` still returns the blocked result; acceptance is still asked, but the evidence block shows the landing blocker reason. The user can `accept` (preserving the candidate commit as the artifact) or `revise` / `reject`. Acceptance **never re-attempts** landing.
  * **Workflow schema** gains an optional `acceptance` stage type (`"acceptance"`) to mirror the new terminal user decision in workflow YAML, but the controller's `acceptance` runs even when no stage is declared (matching how `approval` works today — see `planner.ts:405`).
  * **Terminal states** are renamed for clarity but kept backward-compatible where evidence consumers exist:
    - `COMPLETED / accepted` (new canonical terminal)
    - `CANCELLED / rejected` (replaces `approval-rejected` for the new terminal)
    - `COMPLETED / accepted-with-pr` (when landing published a PR instead of merging; user accepted the candidate as-is)
    - `BLOCKED / acceptance-blocked` (acceptance handler missing; equivalent to today's `approval-unavailable` but in acceptance terms)
  * **Resume** routes `phase === "acceptance"` to the acceptance decision; `phase` strings `approval-ready`, `landing-planning`, `post-landing-verification` are migrated in resume/show/logs and treated as legacy aliases.

* **Files Affected:**
  * `Modify: packages/core/src/runtime/controller-final-phases.ts:1-780` (replace approval-ready + landing-planning tail with acceptance)
  * `Modify: packages/core/src/runtime/landing.ts:1-700` (drop post-landing recovery; return evidence instead)
  * `Modify: packages/core/src/runtime/recovery-checkpoint.ts` (`RecoveryCheckpointPhase` union: drop `post-landing-verification`, add `acceptance`)
  * `Modify: packages/core/src/runtime/failure-recovery.ts:1-130` (no signature change; keep recovery used by acceptance for `revise`/`reject` paths)
  * `Modify: packages/core/src/runs/resume.ts:1-300` (resume policy treats `acceptance` as terminal; legacy phase aliases)
  * `Modify: packages/core/src/runs/show.ts` (terminal-state copy)
  * `Modify: packages/core/src/runs/logs-by-id.ts` (phase-aware line rendering)
  * `Modify: packages/schemas/src/config.ts` (`WorkflowNodeType` adds `"acceptance"`; `approval` config kept)
  * `Modify: packages/core/src/runtime/planner.ts:405` (default workflow appends `acceptance` stage)
  * `Modify: packages/core/src/runtime/landing-types.ts:50` (add `"accepted" | "acceptance-blocked"` to terminal phases)
  * `Create: packages/core/src/runtime/acceptance-phase.ts` (new orchestration extracted from `controller-final-phases.ts`)
  * `Modify: packages/core/src/runtime/controller-run.ts:365` (call `runAcceptancePhase` instead of `runFinalPhases`; verify review contract)
  * `Modify: packages/adapters/pi/src/approval.ts` (add `requestAcceptanceDecision`; keep `requestPlanApprovalDecision`)
  * `Modify: packages/adapters/pi/src/gateway-prototype.ts:210-260` (wire `requestAcceptance` callback)
  * `Modify: packages/core/src/runtime/controller.ts:121` (`requestAcceptance?: AcceptanceFn` new optional callback; existing `requestApproval` becomes legacy)
  * `Modify: tests/runtime.test.mjs` (rewrite final-phase assertions to acceptance-phase strings)
  * `Modify: tests/failure-recovery.test.mjs` (legacy phase aliases; acceptance checkpoint)
  * `Modify: tests/pi-adapter.test.mjs` (acceptance dialog)
  * `Modify: tests/landing.test.mjs` (post-landing evidence shape)
  * `Modify: tests/headless.test.mjs` (no-handler behavior for acceptance)
  * `Modify: docs/factory/workflow-authoring.md:79-90` (acceptance stage type, lean flow diagram)
  * `Modify: docs/factory/troubleshooting.md:57-90` (terminal state copy)
  * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140` (one new sentence)
  * `Modify: skills/factory-concierge/SKILL.md:120-140` (mirror)
  * `Modify: learnings.md` (append a single line entry)

* **Out of Scope:**
  * Changing plan approval behavior (it remains the first gate; untouched).
  * Changing the deterministic landing guard semantics. The guard still blocks on dirty files / scope / missing remote.
  * Changing `approval.finalMerge: "required"` semantics in `landing-git.ts:71`. Acceptance never auto-merges; the guard still enforces required-merge.
  * Changing `scope.landing` config semantics.
  * Removing `requestApproval` outright. It remains as a backward-compatible alias mapping to `requestAcceptance` for one minor release.
  * Cross-machine distributed resume.

## 2. Assumptions & Blockers

* **Assumptions:**
  * **Acceptance reuses the existing `requestApproval` callback** (no new required input). Plan documents this as the default; a new optional `requestAcceptance` callback is added for adapters that want a distinct surface (e.g., a richer dialog). `requestApproval` continues to work for one minor release and is mapped to `requestAcceptance` internally so SDK consumers do not break.
  * **Acceptance runs *after* landing**, not before. This is the explicit user intent ("landing → acceptance"). The deterministic guard still runs inside landing; the user is only asked once, with landing outcome already in evidence.
  * **Acceptance is the terminal user decision** in the workflow. `revise` returns to planning with feedback; `reject` ends the run. No third "re-try landing" path is added — landing is one shot, by design.
  * **Workflow schema change is additive**: `WorkflowNodeType` gains `"acceptance"` and remains backward compatible because old workflows that declare an `approval` stage still run through the controller's new acceptance path (verified at `planner.ts:405`).
  * **Phase strings used in artifacts** (`recovery-checkpoint.json`, `events.jsonl`, `state.json`) keep backward-compatibility: legacy `approval-ready`, `landing-planning`, `post-landing-verification` are still readable but new runs emit `acceptance` / `landing` (no longer user-facing phases for the latter two).
  * **Headless / SDK mode** without `requestApproval` and without `requestAcceptance` continues to fail loud at the acceptance phase (`FAILED / acceptance-blocked`) with a clear `recoveryHint`. Deterministic.

* **Questions / Blockers:**
  * **None blocking.** Two design choices that need a confirm before coding (captured in §3 where they affect the steps):
    1. Whether to introduce a new `requestAcceptance` callback or reuse `requestApproval`. Default in this plan: add both, with `requestApproval` deprecated as a back-compat alias.
    2. Whether the existing `COMPLETED / complete` and `pull-request-opened` terminal phases remain literal strings or are renamed to `accepted-with-merge` / `accepted-with-pr`. Default: keep `accepted` as the canonical terminal and add `accepted-with-pr` as an alias for the PR-published variant; `complete` continues to be readable for one release.

## 3. Implementation Plan

* [ ] **Step 1: Define the acceptance contracts and evidence shape**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing-types.ts:50`
    * `Modify: packages/core/src/runtime/recovery-checkpoint.ts`
    * `Modify: packages/core/src/runtime/controller.ts:121`
  * **Interfaces:**
    * Consumes: existing `LandingResult`, `VerificationRunResult`, `VerificationFailureClassification`, `FinalApprovalDecision`, `RecoveryCheckpointPhase` from `packages/core/src/runtime/recovery-checkpoint.ts`.
    * Produces:
      ```ts
      // packages/core/src/runtime/landing-types.ts
      export type LandingTerminalPhase =
        | "complete"            // legacy alias for accepted-with-merge
        | "merge-blocked"
        | "pull-request-opened" // legacy alias for accepted-with-pr
        | "accepted"            // NEW canonical
        | "accepted-with-pr"    // NEW alias
        | "acceptance-blocked"; // NEW terminal for missing handler
      ```

      ```ts
      // packages/core/src/runtime/controller.ts (additions)
      export interface AcceptanceEvidence {
        reviewVerdict?: { verdict: "block" | "pass" | "unknown"; summary: string };
        baselineDebt?: Array<{ commandName: string; category: string; reason: string; suggestedAction: string; implicatedFiles?: string[] }>;
        scopeWarnings?: Array<{ file: string; nonGoal: string }>;
        verificationStatus: "passed" | "failed" | "incomplete";
        contractComplete: boolean;
        landingOutcome: {
          status: "landed" | "pull-request" | "skipped" | "blocked";
          phase: LandingTerminalPhase;
          reason?: string;
          targetHeadBefore?: string;
          targetHeadAfter?: string;
          pullRequest?: { status: "created" | "existing" | "failed"; url?: string; sourceBranch: string; targetBranch: string; reason?: string };
        };
        postLandingVerification?: {
          overallStatus: "passed" | "failed" | "incomplete" | "error" | "pending";
          commands: string[];
          reason?: string;
          repairAttempted?: boolean;
        };
      }

      export type AcceptanceDecision =
        | { decision: "accept"; feedback?: string }
        | { decision: "revise"; feedback: string }
        | { decision: "reject"; feedback?: string };

      export type AcceptanceFn = (input: {
        runId: string;
        goal: string;
        candidateSha?: string;
        evidence: AcceptanceEvidence;
      }) => Promise<AcceptanceDecision>;

      // Backward-compatible alias. If only requestApproval is set, map it to
      // requestAcceptance internally during Step 2.
      ```

      ```ts
      // packages/core/src/runtime/recovery-checkpoint.ts
      export type RecoveryCheckpointPhase =
        | "implementation"
        | "verification-blocked"
        | "review"
        | "approval-ready"     // legacy alias
        | "landing-planning"   // legacy alias
        | "post-landing-verification" // legacy alias
        | "acceptance"         // NEW canonical for the final gate
        | "landing";           // NEW: landing's internal phase for checkpointing
      ```
  * **Negative Paths:**
    * `requestAcceptance` missing AND `requestApproval` missing → controller returns `FAILED / acceptance-blocked` with `recoveryHint: "No acceptance handler configured; refusing to auto-accept."`. No exception escapes.
    * `requestAcceptance` provided but throws → controller records `decision.invalid` event and returns `FAILED / acceptance-blocked` (fail loud).
    * `AcceptanceDecision.decision` not in `accept | revise | reject` → controller treats it as `reject` and records `decision.invalid` event.
    * `evidence.postLandingVerification === undefined` is permitted (landing never ran post-landing checks). Acceptance still proceeds.
  * **Verification:**
    * `npm run typecheck` — PASS.
    * `npm run build` — PASS.

* [ ] **Step 2: Wire `requestAcceptance` into the controller input and back-compat with `requestApproval`**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:104-126`
    * `Modify: packages/core/src/runtime/index.ts` (export `AcceptanceEvidence`, `AcceptanceDecision`, `AcceptanceFn`)
  * **Interfaces:**
    * Consumes: `RunFactoryControllerInput` from `packages/core/src/runtime/controller.ts:104`. `FinalApprovalDecision` (legacy).
    * Produces:
      ```ts
      export interface RunFactoryControllerInput {
        cwd: string;
        goal: string;
        branchName?: string;
        workflowId?: string;
        taskType?: string;
        modelOverrides?: Partial<Record<ModelRole, ModelSelection>>;
        discoveryExecutor?: AgentExecutor;
        plannerExecutor?: AgentExecutor;
        builderExecutor?: AgentExecutor;
        repairExecutor?: AgentExecutor;
        reviewerExecutor?: AgentExecutor;
        landingExecutor?: AgentExecutor;
        verificationPlannerExecutor?: AgentExecutor;
        failureClassifierExecutor?: AgentExecutor;
        onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
        requestPlanApproval?: (input: { runId: string; goal: string; planPath: string; taskCount: number; workflowStages: string[]; summary: string; discoveryText?: string; planText?: string; tasks: PlannerTask[] }) => Promise<PlanApprovalResult>;
        requestApproval?: (input: { runId: string; goal: string; candidateSha?: string; baselineDebt?: Array<{ commandName: string; category: string; reason: string; suggestedAction: string; implicatedFiles?: string[] }>; contractComplete: boolean; verificationStatus?: string; scopeWarnings?: Array<{ file: string; nonGoal: string }>; reviewerVerdict?: { verdict: "block" | "pass" | "unknown"; summary: string } }) => Promise<boolean | FinalApprovalDecision>;
        requestAcceptance?: AcceptanceFn; // NEW canonical; takes precedence over requestApproval
        requestDependencyRemediation?: (candidate: import("./dependencies.js").DependencyHydrationRemediationCandidate) => Promise<boolean>;
        requestDecision?: (request: DecisionRequest) => Promise<DecisionResult>;
        failureRecovery?: FailureRecoveryConfig;
        delayMs?: number;
      }
      ```
  * **Code (helper):**
    ```ts
    // packages/core/src/runtime/controller.ts (new helper)
    export function resolveAcceptanceHandler(input: RunFactoryControllerInput): AcceptanceFn | undefined {
      if (input.requestAcceptance) return input.requestAcceptance;
      if (input.requestApproval) {
        return async ({ runId, goal, candidateSha, evidence }) => {
          const result = await input.requestApproval!({
            runId, goal, candidateSha,
            baselineDebt: evidence.baselineDebt,
            contractComplete: evidence.contractComplete,
            verificationStatus: evidence.verificationStatus,
            scopeWarnings: evidence.scopeWarnings,
            reviewerVerdict: evidence.reviewVerdict,
          });
          const normalized = normalizeFinalApprovalDecision(result);
          if (normalized.approved) return { decision: "accept", feedback: normalized.feedback };
          return { decision: normalized.decision === "revise" ? "revise" : "reject", feedback: normalized.feedback ?? "" };
        };
      }
      return undefined;
    }

    function normalizeFinalApprovalDecision(value: boolean | FinalApprovalDecision): FinalApprovalDecision {
      if (typeof value === "boolean") return { approved: value, decision: value ? "approve" : "reject" };
      return {
        approved: value.approved,
        decision: value.decision ?? (value.approved ? "approve" : "reject"),
        feedback: value.feedback?.trim() || undefined,
      };
    }
    ```
  * **Negative Paths:**
    * Both `requestAcceptance` and `requestApproval` unset → `resolveAcceptanceHandler` returns `undefined`. The controller records `FAILED / acceptance-blocked` and emits `acceptance.blocked`.
    * `requestApproval` (legacy) returns `boolean true` → mapped to `{ decision: "accept" }`. `boolean false` → mapped to `{ decision: "reject" }`.
    * `requestApproval` (legacy) returns `FinalApprovalDecision` with `decision: "revise"` → mapped to `{ decision: "revise", feedback: <text> }`.
  * **Verification:**
    * `npm run typecheck` — PASS.
    * `npm run build` — PASS.

* [ ] **Step 3: Stop asking the user inside landing; return evidence only**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing.ts:250-360` (drop `requestFailureRecovery` for post-landing failures; record evidence)
    * `Modify: packages/core/src/runtime/landing.ts:121-160` (guard failure no longer asks the user; landing still records blocked outcome for acceptance evidence)
  * **Interfaces:**
    * Consumes: `runLandingFlow` from `packages/core/src/runtime/landing.ts:69`. `requestFailureRecovery` (still imported but only used for the *landing-guard* path in headless mode — see Negative Paths).
    * Produces: `LandingResult.postLandingVerification` shape unchanged, but the `reason` field reflects honest state (no `user stopped recovery` strings). New field `LandingResult.evidence` mirrors `AcceptanceEvidence.landingOutcome` and `postLandingVerification`.
  * **Code:**
    ```ts
    // packages/core/src/runtime/landing.ts (relevant edits inside runLandingFlow)
    if (execution.status === "landed") {
      // existing landing.applied / final-merge.json writes remain unchanged
      try {
        verificationResult = await rerunLandingVerification(...);
        postLandingVerification = { overallStatus: verificationResult.overallStatus, commands: verificationCommands, repairAttempted: false };
        if (verificationResult.overallStatus === "failed") {
          const failedCommandNames = verificationResult.commands.filter((c) => c.status === "failed").map((c) => c.name);
          if (isIgnorableBaselineFailure(input.verificationFailureClassification, failedCommandNames)) {
            postLandingVerification = {
              ...postLandingVerification,
              reason: "Post-landing verification failed on baseline-unrelated non-retryable debt; recorded as evidence for acceptance.",
            };
            await appendFactoryRunEvent(input.eventsPath, {
              type: "landing.post_verification_repair_skipped",
              data: { reason: postLandingVerification.reason, commands: verificationCommands, failureKind: input.verificationFailureClassification?.kind, targetBranch: plan.targetBranch, targetHeadAfter },
            });
          } else {
            // NEW: do NOT ask the user. Record evidence and let acceptance decide.
            postLandingVerification = {
              ...postLandingVerification,
              reason: "Post-landing verification failed; recorded as evidence for acceptance (no automatic repair).",
            };
            await appendFactoryRunEvent(input.eventsPath, {
              type: "landing.post_verification_failed_recorded",
              data: { reason: postLandingVerification.reason, commands: verificationCommands, failureCommands: failedCommandNames, targetBranch: plan.targetBranch, targetHeadAfter },
            });
          }
        }
      } catch (error) {
        postLandingVerification = {
          overallStatus: "error",
          commands: verificationCommands,
          reason: `Post-landing verification failed to complete: ${formatError(error)}`,
          repairAttempted: false,
        };
        await appendFactoryRunEvent(input.eventsPath, {
          type: "landing.post_verification_failed",
          data: { reason: postLandingVerification.reason, commands: verificationCommands, targetBranch: plan.targetBranch, targetHeadAfter },
        });
      }
    }

    // landing guard failure: still record evidence, do not ask the user.
    if (!guardVerdict.ok) {
      const recoveryReason = guardVerdict.reasons.join("; ");
      await appendFactoryRunEvent(input.eventsPath, {
        type: "landing.guard_blocked_recorded",
        data: { reason: recoveryReason, dirtyFiles: dirtyContext.relevant, unrelatedFiles: dirtyContext.unrelated },
      });
      const diagnosis = await diagnoseOrFallback({ executor, model: modelSelection?.model, plan, reason: recoveryReason, dirtyFiles: dirtyContext.relevant, verification: input.verification, limits: input.config.runtime.limits });
      const pullRequest = await publishBlockedCandidate(input, recoveryReason);
      return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? recoveryReason, pullRequest);
    }
    ```
  * **Negative Paths:**
    * **Headless / no decision handler**: `shouldUseInteractiveRecovery` returns false → `requestFailureRecovery` is never called. Existing terminal behavior preserved (landing blocked + acceptance phase decides).
    * **Interactive handler available but user already past landing guard**: landing's guard failure now records evidence and returns blocked; acceptance phase decides. No silent auto-accept.
    * **Landing execution fails** (`executeLandingStrategy` returns `blocked`): existing `finishBlockedLanding` path is unchanged; the result is fed into acceptance evidence.
    * **PR fallback fails** (no remote): unchanged; acceptance sees the failure as evidence.
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/landing.test.mjs` — PASS with updated assertions:
      - The "post-landing repair asked the user" test (`recovery.action === "repair"` paths) is rewritten to assert that the run proceeds to `acceptance` with `postLandingVerification.reason` populated and no recovery dialog recorded.
      - The "landing guard retry" test asserts guard-blocked produces a `landing.guard_blocked_recorded` event and the result flows into acceptance evidence.

* [ ] **Step 4: Create `acceptance-phase.ts` and route controller through it**

  * **Files:**
    * `Create: packages/core/src/runtime/acceptance-phase.ts`
    * `Modify: packages/core/src/runtime/controller-run.ts:365`
    * `Modify: packages/core/src/runtime/controller-final-phases.ts` (trim: keep review + landing-invocation, extract acceptance)
  * **Interfaces:**
    * Consumes: `RunFactoryControllerInput`, `RunFactoryControllerResult`, `FactoryRunProgressEvent`, `FinalPhasesState` from `packages/core/src/runtime/controller-final-phases.ts:42-60`. `LandingResult` from `packages/core/src/runtime/landing-types.ts`. `AcceptanceEvidence`, `AcceptanceDecision`, `AcceptanceFn`, `resolveAcceptanceHandler` from Steps 1 and 2.
    * Produces:
      ```ts
      // packages/core/src/runtime/acceptance-phase.ts
      export interface AcceptancePhaseInput {
        run: Awaited<ReturnType<typeof createFactoryRun>>;
        input: RunFactoryControllerInput;
        loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
        executionCwd: string;
        worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
        phases: string[];
        delayMs: number;
        planPath: string;
        taskPaths: string[];
        discoveryExecutionPath: string | undefined;
        plannerExecutionPath: string | undefined;
        builderExecutionPaths: string[];
        integrationPath: string | undefined;
        repairExecutionPaths: string[];
        reviewerExecutionPath: string | undefined;
        verificationPath: string;
        verification: VerificationRunResult;
        verificationPlan: VerificationPlan;
        taskType: string;
        verificationFailureClassification: VerificationFailureClassification | undefined;
        contractResult: VerificationEngineResult;
        reviewerGuidanceText: string;
        reviewerSkills: SkillBundleSelection;
        interviewDecisions: InterviewDecisionRecord[];
        completedTasks: PrototypeCompletedTaskArtifact[];
        landingResult: LandingResult;
        candidateSha: string | undefined;
      }

      export async function runAcceptancePhase(state: AcceptancePhaseInput): Promise<RunFactoryControllerResult | { decision: "revise"; feedback?: string }>;
      ```
  * **Code:**
    ```ts
    // packages/core/src/runtime/acceptance-phase.ts (skeleton)
    export async function runAcceptancePhase(state: AcceptancePhaseInput): Promise<RunFactoryControllerResult | { decision: "revise"; feedback?: string }> {
      const { run, input, loaded, executionCwd, worktree, phases, delayMs, planPath, taskPaths,
              discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, integrationPath,
              repairExecutionPaths, reviewerExecutionPath, verificationPath, verification, verificationPlan,
              taskType, verificationFailureClassification, contractResult, reviewerGuidanceText, reviewerSkills,
              interviewDecisions, completedTasks, landingResult, candidateSha } = state;

      await movePhase(run.statePath, run.eventsPath, run.runId, input, "acceptance", "Reviewer evidence collected; awaiting acceptance");

      const evidence = buildAcceptanceEvidence({ verification, verificationFailureClassification, contractResult, reviewerVerdict, scopeWarnings, baselineDebt, landingResult });

      const handler = resolveAcceptanceHandler(input);
      if (!handler) {
        // No acceptance handler: fail loud.
        const blockedState = await updateFactoryRunState({
          statePath: run.statePath,
          patch: { status: "FAILED", phase: "acceptance-blocked" },
        });
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "run.failed",
          data: { reason: "No acceptance handler configured; refusing to auto-accept", phase: "acceptance-blocked" },
        });
        await emitProgress(input, { runId: run.runId, phase: "acceptance-blocked", status: "FAILED", message: "No acceptance handler configured; refusing to auto-accept" });
        const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
          runId: run.runId, goal: input.goal, status: "FAILED", phase: "acceptance-blocked",
          approved: false, candidateSha, planPath, taskPaths, discoveryExecutionPath, plannerExecutionPath,
          builderExecutionPaths, integrationPath, finalMergePath: landingResult.finalMergePath,
          repairExecutionPaths, reviewerExecutionPath, verificationPath,
          verificationStatus: verification.overallStatus,
          landingStatus: landingResult.landingStatus, landingAttempts: landingResult.landingAttempts,
          recoveryHint: landingResult.recoveryHint ?? "No acceptance handler configured; refusing to auto-accept",
          pullRequest: landingResult.pullRequest,
        });
        return buildRunFailureResult({ run, executionCwd, worktree, phases, planPath, taskPaths, plannerExecutionPath, builderExecutionPaths, integrationPath, finalMergePath: landingResult.finalMergePath, candidateSha, repairExecutionPaths, reviewerExecutionPath, verificationPath, summaryPath });
      }

      const decision = await handler({ runId: run.runId, goal: input.goal, candidateSha, evidence });
      const allowed = new Set(["accept", "revise", "reject"]);
      if (!decision || !allowed.has(decision.decision)) {
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "decision.invalid",
          data: { decisionRequestId: run.runId, payload: decision },
        });
        // Fail loud instead of guessing.
        return finalizeAcceptanceFailure(state, "Invalid acceptance decision; refusing to guess.");
      }

      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: decision.decision === "accept" ? "acceptance.accepted" : decision.decision === "revise" ? "acceptance.revise_requested" : "acceptance.rejected",
        data: { goal: input.goal, candidateSha, feedback: decision.feedback, landingStatus: landingResult.landingStatus, landingPhase: landingResult.phase },
      });

      if (decision.decision === "revise") {
        // Revise returns control to planning with the feedback.
        return { decision: "revise", feedback: decision.feedback };
      }

      if (decision.decision === "reject") {
        const cancelled = await updateFactoryRunState({ statePath: run.statePath, patch: { status: "CANCELLED", phase: "rejected" } });
        await emitProgress(input, { runId: run.runId, phase: "rejected", status: "CANCELLED", message: "Run stopped: rejected at acceptance" });
        const summaryPath = await writePrototypeSummaryArtifact(run.runDir, { /* ... */ });
        return buildRunFailureResult({ /* ... */ });
      }

      // Accept: terminal. The terminal phase reflects what landing actually did.
      const terminalPhase = landingResult.phase === "pull-request-opened" ? "accepted-with-pr" : "accepted";
      const accepted = await updateFactoryRunState({ statePath: run.statePath, patch: { status: "COMPLETED", phase: terminalPhase } });
      await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: "run.completed", data: { goal: input.goal, terminalPhase, landingStatus: landingResult.landingStatus } });
      await emitProgress(input, { runId: run.runId, phase: terminalPhase, status: "COMPLETED", message: "Factory run accepted" });
      const summaryPath = await writePrototypeSummaryArtifact(run.runDir, { runId: run.runId, goal: input.goal, status: "COMPLETED", phase: terminalPhase, approved: true, candidateSha, /* ... */ });
      return { /* canonical completed result */ };
    }

    function buildAcceptanceEvidence(input: { verification, verificationFailureClassification, contractResult, reviewerVerdict, scopeWarnings, baselineDebt, landingResult }): AcceptanceEvidence {
      return {
        ...(input.reviewerVerdict ? { reviewVerdict: input.reviewerVerdict } : {}),
        ...(input.baselineDebt?.length ? { baselineDebt: input.baselineDebt } : {}),
        ...(input.scopeWarnings?.length ? { scopeWarnings: input.scopeWarnings } : {}),
        verificationStatus: input.verification.overallStatus,
        contractComplete: input.contractResult.canComplete,
        landingOutcome: {
          status: input.landingResult.landingStatus,
          phase: input.landingResult.phase,
          ...(input.landingResult.recoveryHint ? { reason: input.landingResult.recoveryHint } : {}),
          ...(input.landingResult.pullRequest ? { pullRequest: input.landingResult.pullRequest } : {}),
        },
        ...(input.landingResult.postLandingVerification ? {
          postLandingVerification: {
            overallStatus: input.landingResult.postLandingVerification.status,
            commands: input.landingResult.postLandingVerification.commands,
            ...(input.landingResult.postLandingVerification.reason ? { reason: input.landingResult.postLandingVerification.reason } : {}),
            ...(input.landingResult.postLandingVerification.repairAttempted !== undefined ? { repairAttempted: input.landingResult.postLandingVerification.repairAttempted } : {}),
          },
        } : {}),
      };
    }
    ```
    `controller-final-phases.ts` is trimmed to:
    - `verified → review → landing` (calls `runLandingFlow`).
    - Returns `LandingResult` plus review verdict/scope/baseline data.
    - The controller-run loop in `controller-run.ts:365` then calls `runAcceptancePhase`.
  * **Negative Paths:**
    * **Missing acceptance handler** → `FAILED / acceptance-blocked` with `recoveryHint`; no silent auto-accept.
    * **Handler throws** → controller records `decision.invalid` and fails loud.
    * **`decision.decision` invalid** (`"foo"` or empty) → fail loud.
    * **Revise after landing** → returns `{ decision: "revise", feedback }` to controller-run, which re-enters the planning phase (replan loop already exists at `controller-run.ts:156-200`).
    * **Reject** → `CANCELLED / rejected`; preserves artifacts (final-merge.json, landing-plan.json, etc.) for inspection.
    * **Accept with landing blocked** (PR fallback failed, etc.) → `COMPLETED / accepted-with-pr` or `accepted-with-blocked`. The user explicitly chose `accept` knowing landing couldn't deliver; candidate commit and recovery hint are preserved as artifacts.
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/runtime.test.mjs` — PASS (existing assertions updated in Step 7).

* [ ] **Step 5: Resume policy and inspection handle the new acceptance phase**

  * **Files:**
    * `Modify: packages/core/src/runs/resume.ts:260-310` (`suggestResumePolicy` branches for new phases)
    * `Modify: packages/core/src/runs/show.ts:6-90, 90-148`
    * `Modify: packages/core/src/runs/logs-by-id.ts:15-105, 196-275`
  * **Interfaces:**
    * Consumes: `readLatestFactoryRunStatus`, `inspectRecoveryState`, `suggestResumePolicy` from `packages/core/src/runs/resume.ts:200-310`. `FactoryRunShowResult`, `formatEventLine` from `packages/core/src/runs/show.ts` and `packages/core/src/runs/logs-by-id.ts`.
    * Produces:
      - `suggestResumePolicy` returns:
        ```ts
        if (currentPhase === "acceptance") {
          return { resumable: true, suggestedPhase: "acceptance", nextStatus: "RUNNING", reason: "Resume from acceptance gate." };
        }
        if (currentPhase === "approval-ready" || currentPhase === "landing-planning" || currentPhase === "post-landing-verification") {
          return { resumable: true, suggestedPhase: "acceptance", nextStatus: "RUNNING", reason: `Legacy phase ${currentPhase}; resume at acceptance gate.` };
        }
        ```
      - `formatEventLine` entries for `acceptance.accepted`, `acceptance.rejected`, `acceptance.revise_requested`, `landing.guard_blocked_recorded`, `landing.post_verification_failed_recorded`.
      - `FactoryRunShowResult.evidence` mirrors `AcceptanceEvidence` for `/factory show`.
  * **Negative Paths:**
    * Legacy `currentPhase` strings (`approval-ready`, `landing-planning`, `post-landing-verification`) on a half-written run are still resumeable via the acceptance gate.
    * Unknown phase → existing fallback (not resumable).
  * **Verification:**
    * `node --test tests/runtime.test.mjs` — PASS with three new resume tests:
      1. `resume routes legacy approval-ready to acceptance`.
      2. `resume routes legacy post-landing-verification to acceptance`.
      3. `resume routes new acceptance phase to acceptance`.

* [ ] **Step 6: Pi adapter accepts the new acceptance callback and renders the lean flow**

  * **Files:**
    * `Modify: packages/adapters/pi/src/approval.ts:300-440` (add `requestAcceptanceDecision`; keep `resolveFinalApprovalConfirm`)
    * `Modify: packages/adapters/pi/src/gateway-prototype.ts:210-260` (wire `requestAcceptance` from the Pi UI; fall back to `requestApproval` when only the legacy callback exists)
  * **Interfaces:**
    * Consumes: `FactoryPiUi` from `packages/adapters/pi/src/types.ts:1-40`. `FinalApprovalReviewerVerdict`, `buildReviewerFindingLines`, `resolveFinalApprovalConfirm`, `defaultFinalApproval` from `packages/adapters/pi/src/approval.ts`.
    * Produces:
      ```ts
      // packages/adapters/pi/src/approval.ts
      export async function requestAcceptanceDecision(
        ui: FactoryPiUi,
        input: { runId: string; goal: string; candidateSha?: string; evidence: AcceptanceEvidence },
      ): Promise<AcceptanceDecision>;
      ```
      Implementation:
      - When `ui.custom` is available: render evidence block (review verdict, baseline debt, scope warnings, verification status, post-landing verification status, landing outcome) followed by three choices: `[A] Accept — finalize the run`, `[B] Revise — return to planning with my feedback`, `[C] Reject — cancel the run`. Up/down navigation, Enter to select, Esc → `{ decision: "reject", feedback: "Acceptance dismissed." }`.
      - Fallback `ui.select` path: same three choices; reject chosen → capture optional `ui.input` feedback.
      - Fallback `ui.confirm` path: confirms accept (true → `{ decision: "accept" }`); false → `{ decision: "reject" }`. No revise path in last-resort mode (matches recovery contract).
  * **Negative Paths:**
    * `evidence.landingOutcome.status === "blocked"` is shown prominently above the option list (so the user accepts knowing landing couldn't deliver).
    * `evidence.reviewVerdict?.verdict === "block"` shows the reviewer override warning above the option list.
    * Esc / dismiss → `{ decision: "reject" }` (terminal) — matches the "never silently auto-approve" contract.
    * No `ui.custom`, no `ui.select`, no `ui.confirm` → throw `Error("Acceptance decision requires Pi custom, select, or confirm UI.")`. The controller catches this and fails loud.
  * **Verification:**
    * `node --test tests/pi-adapter.test.mjs` — PASS with three new tests:
      1. `acceptance dialog returns accept decision on Accept choice`.
      2. `acceptance dialog returns revise decision with feedback on Revise choice`.
      3. `acceptance dialog returns reject decision on Esc`.

* [ ] **Step 7: Tests updated for the lean acceptance flow**

  * **Files:**
    * `Modify: tests/runtime.test.mjs` (replace final-phase assertions: `approval-ready` → `acceptance`; `landing-planning` → `landing`; `post-landing-verification` → `landing`; `complete` → `accepted`; `merge-blocked` → `accepted-with-pr` or `accepted-with-blocked`; `approval-rejected` → `rejected`)
    * `Modify: tests/failure-recovery.test.mjs` (legacy phase aliases still readable; new `acceptance` phase checkpoint)
    * `Modify: tests/pi-adapter.test.mjs` (acceptance dialog tests)
    * `Modify: tests/landing.test.mjs` (post-landing evidence shape; no recovery dialog)
    * `Modify: tests/headless.test.mjs` (`acceptance-blocked` failure when handler missing)
  * **Interfaces:** Same as Steps 1-6.
  * **Code (new tests appended):**
    ```js
    // tests/runtime.test.mjs (new tests appended)
    test('lean flow: review → landing → acceptance produces COMPLETED / accepted terminal', async () => {
      // setup mocks for review (deterministic), landing (landed), acceptance (accept)
      // assert: state ends with { status: "COMPLETED", phase: "accepted" }
      // assert: events include acceptance.accepted, no approval.approved
    });

    test('lean flow: landing blocked does not block acceptance; accept returns COMPLETED with evidence', async () => {
      // setup mocks: review pass, landing blocked (no remote), acceptance accept
      // assert: status "COMPLETED", phase "accepted-with-blocked" (or accepted with landingOutcome.reason)
      // assert: evidence.landingOutcome.reason mentions "no remote"
    });

    test('lean flow: post-landing verification failure surfaces as evidence, no recovery dialog', async () => {
      // setup mocks: review pass, landed, post-landing failed, no recovery
      // assert: state has acceptance pending, evidence.postLandingVerification.overallStatus === "failed"
      // assert: events include landing.post_verification_failed_recorded, no run.recovery_requested with phase post-landing-verification
    });

    test('lean flow: revise at acceptance returns to planning', async () => {
      // setup mocks: review pass, landed, acceptance returns revise with feedback
      // assert: controller-run re-enters planning with the feedback appended to context
    });

    test('lean flow: reject at acceptance terminates run as CANCELLED / rejected', async () => {
      // setup mocks: acceptance reject
      // assert: state { status: "CANCELLED", phase: "rejected" }
    });

    test('legacy approval-ready phase on disk resumes at acceptance', async () => {
      // write a half-completed run with currentPhase "approval-ready"
      // assert: resumeLatestFactoryRun returns resumable, suggestedPhase "acceptance"
    });
    ```
  * **Negative Paths:**
    * Tests assert no `approval.approved` / `approval.rejected` events appear in the lean flow.
    * Tests assert `run.recovery_requested` events for `phase: "post-landing-verification"` no longer appear.
    * Headless test asserts missing handler → `FAILED / acceptance-blocked` with a clear hint.
  * **Verification:**
    * `node --test tests/runtime.test.mjs` — PASS.
    * `node --test tests/failure-recovery.test.mjs` — PASS.
    * `node --test tests/pi-adapter.test.mjs` — PASS.
    * `node --test tests/landing.test.mjs` — PASS.
    * `node --test tests/headless.test.mjs` — PASS.

* [ ] **Step 8: Workflow schema, planner defaults, and docs**

  * **Files:**
    * `Modify: packages/schemas/src/config.ts:90-110` (`WorkflowNodeType` adds `"acceptance"`)
    * `Modify: packages/core/src/runtime/planner.ts:395-415` (default workflow appends `acceptance` stage; legacy `approval` still allowed)
    * `Modify: packages/core/src/workflows/registry.ts:115-120` (recognize `acceptance` stage type, allow it in serialization)
    * `Modify: docs/factory/workflow-authoring.md:79-90` (lean flow diagram; new `acceptance` stage type)
    * `Modify: docs/factory/troubleshooting.md:57-90` (terminal state copy; legacy aliases)
    * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140` (one sentence about acceptance)
    * `Modify: skills/factory-concierge/SKILL.md:120-140` (mirror)
    * `Modify: learnings.md` (append one-line entry)
  * **Interfaces:**
    * Consumes: `WorkflowNodeType`, `WorkflowStage`, `WorkflowDefinition` from `packages/schemas/src/config.ts:90-120`.
    * Produces: `WorkflowNodeType = "agent" | "command" | "approval" | "task-graph" | "interview" | "acceptance"`. Default workflow stages include `acceptance` as the final stage (after `review` or `approval`). Registry accepts the new type.
  * **Negative Paths:**
    * Old `factory.yaml` files that declare a final `approval` stage continue to work; the controller's acceptance step runs in that case (one canonical decision instead of two).
    * Workflows that declare a final `acceptance` stage but provide no `requestAcceptance` handler fail loud at acceptance (matches the no-handler fail-loud contract).
    * Documentation must not promise "no failures ever" — the four failure categories (hard limits, missing handler, exhausted attempts, invalid decision) remain fail-loud.
  * **Verification:**
    * `npm run build` — PASS.
    * `grep -n "acceptance" docs/factory/workflow-authoring.md docs/factory/troubleshooting.md .pi/skills/factory-concierge/SKILL.md skills/factory-concierge/SKILL.md learnings.md` returns at least one hit in each.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'workflow.*acceptance|default workflow'` — PASS (one new test asserting the default workflow contains an `acceptance` stage).

## 4. Testing

* **Build, type-check, complexity:**
  * `npm run build` — PASS.
  * `npm run typecheck` — PASS.
  * `npm run complexity` — PASS.

* **Targeted unit + integration:**
  * `node --test tests/runtime.test.mjs` — PASS (acceptance flow + legacy resume).
  * `node --test tests/failure-recovery.test.mjs` — PASS (legacy phase aliases; new acceptance checkpoint).
  * `node --test tests/pi-adapter.test.mjs` — PASS (acceptance dialog).
  * `node --test tests/landing.test.mjs` — PASS (no recovery dialog; evidence shape).
  * `node --test tests/headless.test.mjs` — PASS (no-handler fail-loud).
  * `node --test tests/setup-operations.test.mjs tests/setup-validate.test.mjs tests/setup-tui.test.mjs` — PASS (workflow schema accepts `acceptance` stage).

* **Regression:**
  * `npm test` — PASS.

## 5. Definition of Done

* [ ] Required behavior works: the tail of every Factory run shows one terminal user decision (`acceptance`). Landing runs before acceptance and contributes evidence (review verdict, baseline debt, scope warnings, verification status, post-landing verification status, landing outcome). The deterministic landing guard and post-landing checks remain internal; no separate user-facing `landing-authorization` or `post-landing-verification` surface exists.
* [ ] Backward compatibility: `requestApproval` continues to work for one minor release; `approval-ready`, `landing-planning`, `post-landing-verification` phase strings on old runs are still readable and resumable to the new acceptance gate. Terminal phases `complete`, `merge-blocked`, `pull-request-opened` still appear in old artifacts.
* [ ] Negative paths behave correctly: missing acceptance handler → `FAILED / acceptance-blocked`; invalid decision payload → fail loud with `decision.invalid` event; revise returns to planning; reject preserves artifacts as `CANCELLED / rejected`; accept with landing blocked preserves candidate + recovery hint.
* [ ] Tests pass (`npm test`).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Build passes (`npm run build`).
* [ ] Complexity guard passes (`npm run complexity`).
* [ ] Migrations / config changes are validated: `WorkflowNodeType` adds `acceptance`; existing `approval` stages continue to work; no DB migration.
* [ ] Documentation updated: `docs/factory/workflow-authoring.md`, `docs/factory/troubleshooting.md`, `.pi/skills/factory-concierge/SKILL.md`, `skills/factory-concierge/SKILL.md`, `learnings.md` describe the lean flow and the acceptance phase.
