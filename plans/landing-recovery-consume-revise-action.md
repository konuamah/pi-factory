# Landing Recovery: Consume the `revise` Action

## 1. Understanding & Scope

* **Core Goal:** Make landing consume the `revise` failure-recovery action the same way planning, implementation, verification-planning, review, and approval already do. When a user types free-text guidance in the runtime recovery dialog for a landing failure, Factory must re-run the affected landing sub-phase with that guidance appended to the model prompt, instead of silently falling through to the pull-request fallback.
* **Current Behavior:**
  * `runLandingFlow` requests failure recovery in three places — `landing-guard`, `landing-execution`, and `post-landing-verification` — at `packages/core/src/runtime/landing.ts:121-150`, `:295-325`, and `:367-400`. Every request sets `canRevise: false` in the `FailureRecoveryContext`.
  * After each `requestFailureRecovery` call, `runLandingFlow` only branches on `recovery.action === "retry"` (`packages/core/src/runtime/landing.ts:151-152`, `:326-327`, `:401-402`). Any other action — including the `revise` action emitted by `requestFailureRecovery` in `packages/core/src/runtime/failure-recovery.ts:94-99` when the user selects `custom` with feedback — falls through to `publishBlockedCandidate`, which requires a working Git remote (`packages/core/src/runtime/landing.ts:670-708`).
  * `requestFailureRecovery` in `packages/core/src/runtime/failure-recovery.ts:79-100` maps `custom` + feedback to `action: "revise"`, so the user feedback the dialog captures is already on `recovery.feedback` — landing just discards it.
  * The companion `buildLandingPlan` in `packages/core/src/runtime/landing-ai.ts:36-58` builds the planner prompt with no `recoveryFeedback` slot, so revise guidance cannot be appended without a signature change.
  * `decision.jsonl` / `events.jsonl` from the failing run prove the user picked `custom` with feedback, Factory normalized it to `revise`, and the run then jumped straight to `landing.pull_request` (which failed because the repo had no remote) before going `BLOCKED`. This matches the report; the gap is consumption, not capture.
* **Target Behavior:**
  * All three landing recovery requests offer `revise` whenever the underlying cause is something the planner or repair executor can be told about (guard violations, dirty-target, merge/cherry-pick/rebase conflicts, missing-candidate, candidate-empty, verification-failed, unsafe-risk). The dialog already has `revise` rendered in `recovery-narrator.ts:67-71`; landing just needs to enable it and handle the result.
  * `revise` re-enters the failing sub-phase with `recovery.feedback` appended to the model prompt (`buildLandingPlannerPrompt` for planning/execution; the existing `buildRepairPrompt` for post-landing). The loop honors `failureRecovery.maxAttempts` (default 3) the same way `planning-phase2.ts:91-168` already does.
  * `revise` does NOT cause a PR to be published, and it does NOT bypass the landing guard. If the guard is still unhappy after `maxAttempts`, the run finalizes as today (with the user's feedback recorded in `landing-plan.json` reasoning so post-mortem reads it).
  * `stop` (and the no-feedback `custom` case in `failure-recovery.ts:95`) keeps current behavior: PR fallback when a remote exists, blocked finalization when it does not.
* **Files Affected:**
  * `packages/core/src/runtime/landing.ts` (modify — three recovery sites + the `landing-attempt` bookkeeping so revise loops are bounded and observable).
  * `packages/core/src/runtime/landing-ai.ts` (modify — accept optional `recoveryFeedback` and `attempt` and append them to the prompt; surface them in the landing-plan artifact's reasoning).
  * `tests/landing.test.mjs` (modify — add three tests: landing-guard revise reruns with feedback, landing-execution revise reruns with feedback, post-landing-verification revise reruns the repair with feedback).
  * `docs/factory/troubleshooting.md` (modify — note that landing offers revise with feedback and that PR fallback is no longer the only path).
  * `.pi/skills/factory-concierge/SKILL.md` and `skills/factory-concierge/SKILL.md` (modify — same note).
  * `learnings.md` (modify — capture that landing recovery now consumes `revise`).
* **Out of Scope:**
  * Resource limit extension. `toolTimeoutMs`, `runTimeoutMs`, etc. remain deterministic ceilings.
  * Changing `failureRecovery` config defaults (`maxAttempts`, `enabled`); we honor existing settings.
  * Letting `revise` skip the landing guard. The guard stays the authority; revise only re-prompts the planner with the user's hint.
  * Cross-process resume of an in-flight landing revise loop. Process restart already lands on `decision-runtime`; that path is covered by `plans/complete-interactive-failure-recovery-coverage.md`.
  * Editing `requestFailureRecovery` itself — it already maps `custom + feedback` to `revise` correctly.

## 2. Assumptions & Blockers

* **Assumptions:**
  * `failureRecovery.enabled` defaults to `true` and `requestDecision` is wired (Pi adapter), matching the assumption in `packages/core/src/runtime/failure-recovery.ts:79-87`.
  * `failureRecovery.maxAttempts` (default 3, per `packages/core/src/runtime/failure-recovery.ts:75`) is the bound for revise loops in landing.
  * `runLandingFlow` callers always pass the same `input` reference on retry. `runLandingFlow` already mutates `input.recoveryAttempts` via `nextLandingRecoveryAttempt` (`:736-742`), so we use the same pattern.
  * `buildLandingPlan` consumers outside `runLandingFlow` (none exist today per `grep -rn "buildLandingPlan" packages/`) do not need to be threaded with feedback.
* **Questions / Blockers:** None. Discovery evidence is in the conversation: `recovery.action === "revise"` is emitted by `failure-recovery.ts:95-99`, landing just does not read it. No further information is required to implement.

## 3. Implementation Plan

* [ ] **Step 1: Thread `recoveryFeedback` and `attempt` through `buildLandingPlan`**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing-ai.ts:36-58` (`buildLandingPlan` signature + body)
    * `Modify: packages/core/src/runtime/landing-ai.ts:94-135` (`buildLandingPlannerPrompt` signature + body)
  * **Interfaces:** Consumes nothing new. Produces an extended `buildLandingPlan` signature and a `buildLandingPlannerPrompt` that accept the optional feedback slot.
  * **Code:**
    ```ts
    export async function buildLandingPlan(input: {
      executor?: AgentExecutor;
      model: ModelSelection;
      goal: string;
      mergeCwd: string;
      baseBranch: string;
      finalMergePolicy: "required" | "not-required";
      dirtyFiles: string[];
      dirtyRelevantFiles?: string[];
      dirtyUnrelatedFiles?: string[];
      completedTasks: PrototypeCompletedTaskArtifact[];
      candidateSha?: string;
      candidateBranch?: string;
      verification: VerificationRunResult;
      verificationFailureClassification?: unknown;
      limits?: AgentExecutionInput["limits"];
      /** Free-text guidance from a runtime `revise` recovery decision. */
      recoveryFeedback?: string;
      /** 1-based attempt counter for the current landing-plan recovery loop. */
      recoveryAttempt?: number;
    }): Promise<LandingPlan> {
      if (!input.executor) {
        throw new Error("Landing planning requires a landing or reviewer executor.");
      }
      const result = await input.executor.execute({
        executionId: `landing-plan-${input.recoveryAttempt && input.recoveryAttempt > 1 ? `retry-${input.recoveryAttempt}` : Date.now()}`,
        cwd: input.mergeCwd,
        prompt: buildLandingPlannerPrompt(input),
        model: input.model,
        tools: ["read", "grep", "find", "ls"],
        limits: input.limits,
        metadata: {
          role: "landing",
          stage: "landing-planning",
          attempt: input.recoveryAttempt,
        },
      });
      const parsed = parseJsonObject(result.outputText);
      if (!parsed) {
        throw new Error("Landing planner returned invalid JSON.");
      }
      return sanitizeLandingPlan(parsed, input);
    }
    ```
    ```ts
    function buildLandingPlannerPrompt(input: {
      goal: string;
      baseBranch: string;
      finalMergePolicy: string;
      dirtyFiles: string[];
      dirtyRelevantFiles?: string[];
      dirtyUnrelatedFiles?: string[];
      completedTasks: PrototypeCompletedTaskArtifact[];
      candidateSha?: string;
      candidateBranch?: string;
      verification: VerificationRunResult;
      verificationFailureClassification?: unknown;
      recoveryFeedback?: string;
      recoveryAttempt?: number;
    }): string {
      return [
        "You are the Factory landing planner.",
        "Return STRICT JSON only. No markdown.",
        "Choose what Factory should do to land the candidate safely.",
        "This is a model decision, not a deterministic verification gate. Baseline-unrelated verification debt is not a reason to abandon a valid candidate. If direct landing is unsafe or cannot complete, choose pull-request so the candidate is published for human review; use block only when no safe delivery path exists.",
        'Allowed strategy: "cherry-pick" | "merge" | "merge-no-ff" | "rebase" | "pull-request" | "skip" | "block".',
        'Allowed risk: "low" | "medium" | "high".',
        JSON.stringify({
          strategy: "cherry-pick",
          targetBranch: input.baseBranch,
          candidateSha: input.candidateSha,
          sourceBranch: input.candidateBranch,
          reasoning: ["short reason"],
          verification: ["test"],
          risk: "low",
          expectedFiles: ["src/file.ts"],
          recoveryPlan: "If direct landing is unsafe or cannot complete, use pull-request to publish the candidate; never abandon a valid candidate.",
        }, null, 2),
        "Evidence:",
        JSON.stringify({
          goal: input.goal,
          baseBranch: input.baseBranch,
          finalMergePolicy: input.finalMergePolicy,
          dirtyFiles: input.dirtyFiles,
          dirtyRelevantFiles: input.dirtyRelevantFiles ?? [],
          dirtyUnrelatedFiles: input.dirtyUnrelatedFiles ?? [],
          candidateSha: input.candidateSha,
          candidateBranch: input.candidateBranch,
          completedTasks: input.completedTasks,
          verificationStatus: input.verification.overallStatus,
          verificationFailureClassification: input.verificationFailureClassification,
          verificationCommands: input.verification.commands.map((command) => ({
            name: command.name,
            status: command.status,
          })),
        }, null, 2),
        input.recoveryAttempt && input.recoveryAttempt > 1
          ? `Recovery attempt ${input.recoveryAttempt}: a previous plan was rejected. The previous guard reasons or execution outcome are included in the "recovery reason" below; honor them.`
          : undefined,
        input.recoveryFeedback
          ? `Runtime recovery guidance from the user (revise):\n${input.recoveryFeedback}`
          : undefined,
      ].filter(Boolean).join("\n");
    }
    ```
  * **Negative Paths:**
    * `recoveryFeedback` undefined / empty: prompt is unchanged — back-compat for any non-landing caller and the first attempt.
    * `recoveryAttempt` undefined: prompt omits the recovery-attempt preamble; behavior is identical to today.
    * `recoveryFeedback` containing `null` bytes or extremely large strings (> 8 KiB): truncate at 8000 chars with a trailing ellipsis before appending (same approach `failure-recovery.ts:107-109` already uses). Document the cap inline.
  * **Verification:** `npm run build` — PASS. `node --test tests/landing-ai.test.mjs` (created in Step 4) — PASS with the new tests for prompt inclusion and truncation.

* [ ] **Step 2: Add a landing-plan recovery loop helper**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing.ts:71-110` (replace the single-shot `try { buildLandingPlan(...) } catch` with a bounded `buildLandingPlanWithRecovery` call)
    * `Modify: packages/core/src/runtime/landing.ts:730-750` (add `buildLandingPlanWithRecovery` helper next to `nextLandingRecoveryAttempt`)
  * **Interfaces:** Consumes `input.config`, `input.controllerInput`, `input.runDir`, `input.eventsPath`, `input.runId`, `input.statePath`, `modelSelection`, and the prompt inputs that `runLandingFlow` already gathers (dirty files, completedTasks, verification, etc.). Produces:
    * `async function buildLandingPlanWithRecovery(input: Parameters<typeof runLandingFlow>[0], modelSelection: { model: ModelSelection; source: string } | undefined, modelForRetry: (attempt: number) => ModelSelection): Promise<{ plan: LandingPlan; lastRecovery: FailureRecoveryResolution | undefined }>`.
    * Calls `requestFailureRecovery` with `phase: "landing-planning"`, `category: "landing-plan"`, `retryable: true`, `canRevise: true`, `attempt` from `nextLandingRecoveryAttempt(input, "landing-plan")`. The `reason` for the prompt is the previous failure (guard verdict reasons OR planner-throw error OR execution reason).
    * On `recovery.action === "retry"` OR `recovery.action === "revise"`, re-invokes `buildLandingPlan` with `recoveryFeedback: recovery.feedback` and `recoveryAttempt: next attempt`. On any other action (including `stop`), returns the last successful plan (if any) plus `lastRecovery` so the caller can decide between PR fallback and blocked finalization.
  * **Code:**
    ```ts
    async function buildLandingPlanWithRecovery(
      input: Parameters<typeof runLandingFlow>[0],
      executor: RunFactoryControllerInput["reviewerExecutor"],
      modelSelection: { model: ModelSelection; source: string } | undefined,
    ): Promise<{ plan: LandingPlan; lastRecovery: FailureRecoveryResolution | undefined }> {
      const maxAttempts = input.controllerInput.failureRecovery?.maxAttempts ?? 3;
      let lastRecovery: FailureRecoveryResolution | undefined;
      for (let attempt = 1; ; attempt += 1) {
        try {
          if (!modelSelection) {
            return { plan: buildBlockingLandingPlan(input, "Landing model was not resolved."), lastRecovery };
          }
          const feedback = lastRecovery?.action === "revise" ? lastRecovery.feedback : undefined;
          const plan = await buildLandingPlan({
            executor,
            model: modelSelection.model,
            goal: input.goal,
            mergeCwd: input.mergeCwd,
            baseBranch: input.config.git.baseBranch,
            finalMergePolicy: input.config.approval.finalMerge,
            dirtyFiles: dirtyContext.all,
            dirtyRelevantFiles: dirtyContext.relevant,
            dirtyUnrelatedFiles: dirtyContext.unrelated,
            completedTasks: input.completedTasks,
            candidateSha: input.candidateSha,
            candidateBranch: input.candidateBranch,
            verification: input.verification,
            verificationFailureClassification: input.verificationFailureClassification,
            limits: input.config.runtime.limits,
            recoveryFeedback: feedback,
            recoveryAttempt: attempt,
          });
          return { plan, lastRecovery };
        } catch (error) {
          if (attempt >= maxAttempts || !shouldUseInteractiveRecovery(input.controllerInput)) {
            return { plan: buildBlockingLandingPlan(input, `Landing planner failed: ${formatError(error)}`), lastRecovery };
          }
          lastRecovery = await requestFailureRecovery({
            controllerInput: input.controllerInput,
            runDir: input.runDir,
            statePath: input.statePath ?? path.join(input.runDir, "state.json"),
            eventsPath: input.eventsPath,
            runId: input.runId,
            checkpoint: buildLandingCheckpoint(input, "landing-planning", input.candidateSha),
            context: {
              phase: "landing-planning",
              title: "landing planner failed",
              reason: formatError(error),
              category: "landing-planner",
              retryable: true,
              canRepair: false,
              canRevise: true,
              evidenceRefs: [path.join(input.runDir, "landing-plan.json")],
              attempt: nextLandingRecoveryAttempt(input, "landing-planner"),
            },
          });
          if (lastRecovery.action !== "retry" && lastRecovery.action !== "revise") {
            return { plan: buildBlockingLandingPlan(input, `Landing planner failed: ${formatError(error)}`), lastRecovery };
          }
        }
      }
    }
    ```
    The helper references `dirtyContext`, which currently lives inside `runLandingFlow`. Move `dirtyFiles`/`dirtyContext` computation into the helper's caller (or pass them in) — see Step 3.
  * **Negative Paths:**
    * `executor` undefined and `modelSelection` undefined: returns the blocking plan immediately without asking recovery (matches current fail-loud contract).
    * `recovery.action === "stop"`: returns the blocking plan; the caller finalizes via `publishBlockedCandidate` or blocked finalization as today.
    * `recovery.action === "repair"`: not offered for landing-planner (`canRepair: false`); the narrator will not render it. If somehow selected, the helper treats it like stop.
    * `maxAttempts` exhausted: returns the blocking plan without further dialog (matches `failure-recovery.ts:81-82`).
    * `feedback` exceeding 8000 chars: truncated before being passed to `buildLandingPlan` (Step 1 truncates).
  * **Verification:** `npm run build` — PASS. `node --test tests/landing.test.mjs` — PASS with the new "landing planner revise reruns with feedback" test from Step 4.

* [ ] **Step 3: Wire revise into the three landing recovery sites**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing.ts:71-110` (replace try/catch with `buildLandingPlanWithRecovery`; pass `dirtyContext` in)
    * `Modify: packages/core/src/runtime/landing.ts:121-150` (landing-guard block: change `canRevise: false` → `canRevise: true`, branch on `recovery.action` for `retry` and `revise` instead of only `retry`)
    * `Modify: packages/core/src/runtime/landing.ts:367-405` (landing-execution blocked block: same change)
    * `Modify: packages/core/src/runtime/landing.ts:295-325` (post-landing-verification block: same change; revise re-runs repair executor with feedback)
  * **Interfaces:** No new exports. Internal flow changes only. The `recoveryAttempts` map on `input` already exists at `:736-742`; reuse it via separate keys: `landing-guard`, `landing-execution`, `post-landing-verification` (existing).
  * **Code:** for the landing-guard site (the user-visible bug):
    ```ts
    if (!guardVerdict.ok) {
      const recoveryReason = guardVerdict.reasons.join("; ");
      const guardAttempt = nextLandingRecoveryAttempt(input, "landing-guard");
      const guardMaxAttempts = input.controllerInput.failureRecovery?.maxAttempts ?? 3;
      let recovery: FailureRecoveryResolution;
      if (guardAttempt > guardMaxAttempts || !shouldUseInteractiveRecovery(input.controllerInput)) {
        recovery = { action: "stop", requestId: "" };
      } else {
        recovery = await requestFailureRecovery({
          controllerInput: input.controllerInput,
          runDir: input.runDir,
          statePath: input.statePath ?? path.join(input.runDir, "state.json"),
          eventsPath: input.eventsPath,
          runId: input.runId,
          checkpoint: buildLandingCheckpoint(input, "landing-planning", input.candidateSha),
          context: {
            phase: "landing-planning",
            title: "landing guard blocked the candidate",
            reason: recoveryReason,
            category: "landing-guard",
            retryable: true,
            canRepair: false,
            canRevise: true,
            evidenceRefs: [path.join(input.runDir, "landing-plan.json")],
            attempt: guardAttempt,
          },
        });
      }
      if (recovery.action === "retry" || recovery.action === "revise") {
        // Re-run the landing planner with the user's feedback so the new plan
        // can target the guard's reasons instead of falling through to PR.
        const replan = await buildLandingPlanWithFeedback(input, executor, modelSelection, dirtyContext, recovery.feedback);
        plan = replan.plan;
        guardVerdict = await validateLandingPlan({
          mergeCwd: input.mergeCwd,
          plan,
          dirtyRelevantFiles: dirtyContext.relevant,
          dirtyUnrelatedFiles: dirtyContext.unrelated,
          finalMergePolicy: input.config.approval.finalMerge,
          completedTasks: input.completedTasks,
          verificationStatus: input.verification.overallStatus,
          nonGoals: input.planContract?.nonGoals,
          scopeGuardBlocking: input.config.scope?.landing === "block",
        });
        if (guardVerdict.ok) {
          // Continue execution with the revised plan.
          break;
        }
        // Still blocked: treat as blocked landing path below.
      } else {
        // stop or repair (not offered) → publish blocked candidate as today.
        const diagnosis = await diagnoseOrFallback({
          executor,
          model: modelSelection?.model,
          plan,
          reason: guardVerdict.reasons.join("; "),
          dirtyFiles: dirtyContext.relevant,
          verification: input.verification,
          limits: input.config.runtime.limits,
        });
        const pullRequest = await publishBlockedCandidate(input, recoveryReason);
        return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? recoveryReason, pullRequest);
      }
    }
    ```
    The two other sites (landing-execution and post-landing-verification) get the same `retry || revise` branch and a single re-entry of the affected sub-phase. For post-landing-verification, `revise` re-calls `attemptLandingRepair(input.controllerInput, input.goal, input.mergeCwd, verificationResult, [input.repairGuidanceText, recovery.feedback].filter(Boolean).join("\n\n"), ...)` — `buildRepairPrompt` already accepts the joined guidance. For landing-execution, revise re-enters `executeLandingStrategy` with the same `plan` but logs the feedback in a new `landing.execution_retry_with_feedback` event so post-mortem reads it.
    Refactor `runLandingFlow` so that `dirtyFiles` and `dirtyContext` are computed once at the top and passed down to the helpers (avoid double-reading git state on every retry).
  * **Negative Paths:**
    * Guard still unhappy after `maxAttempts` revise loops: fall through to `finishBlockedLanding` with the latest `plan` and `recoveryReason` (today's path).
    * Planner throws inside `buildLandingPlanWithFeedback` after revise: treated as a planner failure — `buildLandingPlanWithRecovery` (Step 2) asks for one more recovery and eventually returns the blocking plan.
    * `feedback` is empty string: `recovery.action` still resolves to `revise` (because `feedback?.trim() || undefined` in `failure-recovery.ts:90` is undefined for whitespace-only, which would have routed to `stop`); treat that case as `retry` instead so the user is never stuck. Concretely: `if (recovery.action === "retry" || (recovery.action === "revise" && (!recovery.feedback || !recovery.feedback.trim())))`.
    * `recoveryAttempts` exceeds the bound: the helper returns the blocking plan without re-asking.
  * **Verification:** `npm run build` — PASS. `node --test tests/landing.test.mjs` — PASS with three new tests added in Step 4.

* [ ] **Step 4: Tests for revise consumption**

  * **Files:**
    * `Modify: tests/landing.test.mjs:1-839` (add three new tests and one helper near the existing `landingFixture`)
    * `Create: tests/landing-ai.test.mjs:1-120` (cover `buildLandingPlannerPrompt` prompt composition)
  * **Interfaces:** Uses the same `runLandingFlow` signature as existing tests; introduces a `recoveryRequestSpy` that records every `requestDecision` invocation and lets the test simulate `custom` with feedback.
  * **Code:**
    ```ts
    // tests/landing.test.mjs — appended near the end of the file

    /**
     * Build a runLandingFlow input where the landing planner fails twice (or
     * guard blocks), then resolves the recovery dialog with `custom` + feedback.
     * Verifies that:
     *   - the feedback reaches the next planner prompt;
     *   - the run does NOT call `publishBlockedCandidate` (no `landing.pull_request` event);
     *   - the run finalizes as `COMPLETED` with `landingStatus: "landed"`.
     */
    async function reviseLandingFixture({
      blockMode,
      feedback,
      plannerOutputFor,
    }) {
      const root = await initRepo();
      await git(root, ["switch", "-c", "factory/task-revise"]);
      await fs.writeFile(path.join(root, "index.html"), "<h1>Revise candidate</h1>\n", "utf8");
      await git(root, ["add", "index.html"]);
      await git(root, ["commit", "-m", "revise candidate"]);
      const candidateSha = await git(root, ["rev-parse", "HEAD"]);
      await git(root, ["switch", "main"]);

      const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-run-revise-"));
      const eventsPath = path.join(runDir, "events.jsonl");
      await fs.writeFile(eventsPath, "", "utf8");

      const plannerCalls = [];
      const landingExecutor = {
        async execute(input) {
          plannerCalls.push({ prompt: input.prompt, attempt: input.metadata?.attempt });
          const attempt = (plannerCalls.length);
          return {
            status: "completed",
            outputText: JSON.stringify(plannerOutputFor(attempt)),
            events: [],
          };
        },
      };

      const decisionCalls = [];
      const controllerInput = {
        cwd: root,
        goal: "Add candidate with revise",
        landingExecutor,
        async requestDecision(request) {
          decisionCalls.push({ id: request.id, options: request.options.map((o) => o.id) });
          return { optionId: "custom", feedback, requestId: request.id };
        },
        failureRecovery: { enabled: true, maxAttempts: 3 },
      };

      const result = await runLandingFlow({
        runDir,
        runId: "run-revise",
        eventsPath,
        goal: "Add candidate with revise",
        mergeCwd: root,
        taskType: "general",
        config: {
          git: { baseBranch: "main", pullRequest: { enabled: true, provider: "github", cli: "gh", draft: false } },
          approval: { finalMerge: "required" },
          runtime: { limits: {} },
          models: {
            landing: { provider: "openai-codex", model: "gpt-test" },
            reviewer: { provider: "openai-codex", model: "gpt-test" },
          },
          scope: { landing: blockMode === "guard" ? "block" : "warn" },
        },
        completedTasks: [{
          taskId: "task-revise",
          targetBranch: "main",
          sourceBranch: "factory/task-revise",
          commitSha: candidateSha,
          changedFiles: ["index.html"],
          workspaceMode: "created",
          worktreePath: root,
        }],
        candidateSha,
        candidateBranch: "factory/task-revise",
        verificationPlan: {
          cwd: root,
          cwdResolution: "default-root",
          commands: { lint: `node -e "process.exit(0)"` },
          selectionSource: "deterministic",
          skill: { id: "test", version: "1.0.0", mode: "verification", selectionReasons: [] },
          evidence: { rootCwd: root, configuredCommands: {}, allowedCommands: [], rootScripts: [], candidateCwds: [], commandDecisions: [] },
        },
        verification: { cwd: root, cwdResolution: "default-root", commands: [], overallStatus: "passed" },
        contractCanComplete: true,
        controllerInput,
        planContract: blockMode === "guard"
          ? { nonGoals: ["contact-form.html"] } // planner will propose contact-form.html first, guard blocks, revise re-prompts
          : undefined,
      });
      return { root, runDir, eventsPath, candidateSha, result, plannerCalls, decisionCalls };
    }

    test("landing guard revise reruns the planner with feedback and does not publish a PR", async () => {
      const { result, plannerCalls, decisionCalls, eventsPath, runDir } = await reviseLandingFixture({
        blockMode: "guard",
        feedback: "Drop contact-form.html from expectedFiles; the candidate does not touch it.",
        plannerOutputFor: (attempt) => attempt === 1
          ? { strategy: "cherry-pick", targetBranch: "main", candidateSha: undefined,
              sourceBranch: "factory/task-revise", reasoning: ["initial"],
              verification: ["lint"], risk: "low",
              expectedFiles: ["contact-form.html"], recoveryPlan: "none" }
          : { strategy: "cherry-pick", targetBranch: "main", candidateSha: undefined,
              sourceBranch: "factory/task-revise", reasoning: ["after feedback"],
              verification: ["lint"], risk: "low",
              expectedFiles: ["index.html"], recoveryPlan: "none" },
      });
      assert.equal(decisionCalls.length, 1);
      assert.ok(decisionCalls[0].options.includes("revise"), "revise option must be offered");
      assert.equal(result.status, "COMPLETED");
      assert.equal(result.landingStatus, "landed");
      assert.equal(plannerCalls.length, 2, "planner must be called once for the guard block and once after revise");
      assert.match(plannerCalls[1].prompt, /Runtime recovery guidance from the user \(revise\):/);
      assert.match(plannerCalls[1].prompt, /Drop contact-form\.html/);
      const events = await fs.readFile(eventsPath, "utf8");
      assert.doesNotMatch(events, /landing\.pull_request/, "revise path must not publish a recovery PR");
      const finalMerge = JSON.parse(await fs.readFile(path.join(runDir, "final-merge.json"), "utf8"));
      assert.equal(finalMerge.status, "landed");
    });

    test("landing execution revise reruns with feedback and does not publish a PR", async () => {
      // blockMode undefined → guard happy; planner returns a plan that fails
      // executeLandingStrategy (we force that by pointing mergeCwd at a path
      // where the candidate branch does not exist after first attempt).
      // See git-ops test below for the actual mechanism.
    });

    test("post-landing verification revise reruns the repair with feedback", async () => {
      // Build on landingFixture; landingExecutor returns the standard plan;
      // post-landing lint fails; controllerInput.requestDecision returns
      // custom + "Use the existing legacy hook in src/legacy.ts instead".
      // Assert repairExecutor.execute received a prompt that contains the
      // feedback, and that landing.post_verification_repair_skipped is NOT
      // emitted.
    });
    ```
    ```ts
    // tests/landing-ai.test.mjs — created
    import assert from "node:assert/strict";
    import test from "node:test";
    import { buildLandingPlannerPrompt } from "../packages/core/dist/runtime/landing-ai.js";

    test("buildLandingPlannerPrompt omits recovery block on first attempt", () => {
      const prompt = buildLandingPlannerPrompt({
        goal: "g", baseBranch: "main", finalMergePolicy: "required",
        dirtyFiles: [], completedTasks: [], verification: { overallStatus: "passed" },
      });
      assert.doesNotMatch(prompt, /Runtime recovery guidance/);
      assert.doesNotMatch(prompt, /Recovery attempt 2/);
    });

    test("buildLandingPlannerPrompt includes feedback on attempt > 1", () => {
      const prompt = buildLandingPlannerPrompt({
        goal: "g", baseBranch: "main", finalMergePolicy: "required",
        dirtyFiles: [], completedTasks: [], verification: { overallStatus: "passed" },
        recoveryFeedback: "Drop unrelated dirties; candidate is feature/index.html only.",
        recoveryAttempt: 2,
      });
      assert.match(prompt, /Recovery attempt 2/);
      assert.match(prompt, /Runtime recovery guidance from the user \(revise\):/);
      assert.match(prompt, /Drop unrelated dirties/);
    });

    test("buildLandingPlannerPrompt truncates feedback over 8000 chars", () => {
      const huge = "x".repeat(9000);
      const prompt = buildLandingPlannerPrompt({
        goal: "g", baseBranch: "main", finalMergePolicy: "required",
        dirtyFiles: [], completedTasks: [], verification: { overallStatus: "passed" },
        recoveryFeedback: huge,
        recoveryAttempt: 2,
      });
      assert.ok(prompt.length < 12000, `prompt should be bounded; got ${prompt.length}`);
      assert.match(prompt, /…$/);
    });
    ```
  * **Negative Paths covered:**
    * Revise with empty feedback: existing test at `tests/landing.test.mjs:403-495` (PR recovery) plus the new landing-guard test asserting `decisionCalls[0].options` includes `revise`.
    * No remote present (the original bug): the new landing-guard test exercises this implicitly because `mergeCwd` has no remote, and it asserts `landing.pull_request` is NOT emitted.
    * `maxAttempts` exhaustion: extend the new fixture to set `failureRecovery.maxAttempts: 1` and assert the run finalizes `BLOCKED` with `landing.pull_request` emitted.
  * **Verification:** `npm run build` — PASS. `node --test tests/landing.test.mjs` — PASS, including the new tests `landing guard revise reruns the planner with feedback and does not publish a PR`, `landing execution revise reruns with feedback and does not publish a PR`, `post-landing verification revise reruns the repair with feedback`, and `maxAttempts exhaustion publishes PR as fallback`. `node --test tests/landing-ai.test.mjs` — PASS for all three prompt-composition tests.

* [ ] **Step 5: Document the new behavior**

  * **Files:**
    * `Modify: docs/factory/troubleshooting.md:53-55` (extend the existing "human revise decision pauses" section to mention landing phases).
    * `Modify: .pi/skills/factory-concierge/SKILL.md:43-49` and `skills/factory-concierge/SKILL.md` (mirror the change).
    * `Modify: learnings.md` (append: "Landing recovery now consumes the `revise` action — guard, execution, and post-landing all rerun with the user's free-text feedback instead of falling through to the PR fallback.").
  * **Interfaces:** Markdown only; no code interfaces.
  * **Code:**
    ```md
    ## Landing Recovery Now Consumes `revise`

    Symptom: a runtime recovery dialog for a landing guard, execution, or
    post-landing verification failure used to ignore `custom`+feedback and fall
    straight to the GitHub PR fallback, which then blocked the run when no
    remote existed.

    Fix: landing now offers `revise` whenever the failure is something the
    planner or repair executor can react to (guard violations, dirty target,
    conflicts, verification failures). The user's free-text feedback is
    appended to the next planner or repair prompt and the affected sub-phase
    re-runs. `stop` keeps the old PR fallback behavior. The loop honors
    `failureRecovery.maxAttempts` (default 3); after exhaustion, the run
    finalizes with the standard blocked/PR-delivery semantics.
    ```
  * **Negative Paths:**
    * Existing readers expect the old behavior (PR fallback always): the docs explicitly call out that `stop` still uses PR fallback, so old assumptions about the blocked-without-remote path remain valid for explicit stops.
  * **Verification:** `node scripts/complexity-guard.mjs` (existing doc length check) — PASS. Manual eyeball: confirm the SKILL.md and troubleshooting.md sections reference `landing-guard`, `landing-execution`, and `post-landing-verification` by name.

## 4. Testing

* **Happy paths (regression + new):**
  * Existing `tests/landing.test.mjs` cases continue to pass with no remote present, no decision handler, and `failureRecovery.enabled: false`.
  * New: landing guard revise with `custom`+feedback → planner is called a second time → feedback is in prompt → run completes as `landed` with no `landing.pull_request` event.
  * New: post-landing verification revise → repair executor receives prompt containing the feedback.
  * New: `tests/landing-ai.test.mjs` covers prompt composition for the first attempt vs. attempts > 1 and the 8000-char feedback truncation.
* **Negative paths:**
  * Revise with whitespace-only feedback (resolved to `stop` upstream in `failure-recovery.ts:90`) — landing should treat it as `retry` if it occurs (Step 3 handles the edge).
  * `maxAttempts` exhaustion (set `failureRecovery.maxAttempts: 1`) — landing must publish the PR fallback as today.
  * No remote + revise that exhausts attempts — run finalizes `BLOCKED` with `landing.pull_request` event emitted (status `failed`).
  * Feedback > 8000 chars — truncated to 8000 + ellipsis before being appended.
  * Landing executor missing — same fail-loud behavior as today (no recovery dialog at all).
* **Commands:**
  * `npm run build` (compile TypeScript so `packages/core/dist/runtime/landing.js` is current — tests import the compiled output).
  * `node --test tests/landing.test.mjs` — all existing + new landing tests PASS.
  * `node --test tests/landing-ai.test.mjs` — prompt composition tests PASS.
  * `node --test tests/failure-recovery.test.mjs` — confirms `requestFailureRecovery` mapping of `custom`+feedback to `revise` is unchanged.
  * `node scripts/complexity-guard.mjs` — doc length and complexity guardrail PASS.
  * `npm run typecheck` — TypeScript PASS (the new optional fields on `buildLandingPlan` and `buildLandingPlannerPrompt` must not break existing callers).
  * `npm run test` — full suite PASS.

## 5. Definition of Done

* [ ] Landing guard, landing execution, and post-landing verification all offer `revise` in the runtime recovery dialog (`canRevise: true`).
* [ ] Selecting `revise` (i.e. `custom` + feedback) re-runs the affected sub-phase with the feedback appended to the model prompt.
* [ ] Revise loops honor `failureRecovery.maxAttempts` and finalize via the existing blocked/PR path on exhaustion or stop.
* [ ] `revise` does NOT cause `publishBlockedCandidate` to run.
* [ ] `recoveryFeedback` is truncated to 8000 chars before being appended to prompts.
* [ ] Tests pass: `node --test tests/landing.test.mjs` and `node --test tests/landing-ai.test.mjs`.
* [ ] `npm run build` and `npm run typecheck` pass.
* [ ] `docs/factory/troubleshooting.md`, `.pi/skills/factory-concierge/SKILL.md`, `skills/factory-concierge/SKILL.md`, and `learnings.md` document the new behavior in the same change.
* [ ] No silent fallbacks introduced; revise-with-empty-feedback explicitly routes to `retry` so the user is never silently dropped to PR fallback after typing whitespace.
* [ ] Migrations / config changes: none. `failureRecovery` config schema is unchanged; existing settings continue to apply.
