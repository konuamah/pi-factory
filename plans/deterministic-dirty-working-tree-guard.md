# Deterministic Dirty-Working-Tree Guard

## 1. Understanding & Scope

* **Core Goal:** Make the dirty-working-tree guard during landing **deterministic** in outcome: Factory refuses to overwrite or merge when the target checkout contains dirty files that overlap with the candidate changes, preserves the candidate commit and branch untouched, and marks the run `BLOCKED` (never `COMPLETED`). The LLM still owns the recovery decision afterward — retry after the user cleans the workspace, revise the landing plan, create a patch / alternate approach, or ask the user.
* **Current Behavior:** (with file:line evidence)
  * The dirty-tree validator already exists and is deterministic *per call* in `packages/core/src/runtime/landing-git.ts:74-83`:
    ```ts
    if (input.dirtyRelevantFiles.length > 0) {
      reasons.push(`Dirty target checkout overlaps landing files: ${input.dirtyRelevantFiles.join(", ")}`);
    }
    if (currentBranch && currentBranch !== input.plan.targetBranch && input.dirtyUnrelatedFiles.length > 0) {
      reasons.push(`Cannot switch from ${currentBranch} to ${input.plan.targetBranch} while unrelated files are dirty: ${input.dirtyUnrelatedFiles.join(", ")}`);
    }
    ...
    if (effects.mayDiscardChanges && (input.dirtyRelevantFiles.length > 0 || input.dirtyUnrelatedFiles.length > 0)) reasons.push("WOULD_DESTROY_DIRTY_WORK");
    ```
  * But the controller flow lets the LLM retry around the guard: `packages/core/src/runtime/landing.ts:112-146` runs an unbounded `for (;;)` loop that calls `landingRecovery(input, "landing-guard", ...)` on every guard failure and re-runs `buildLandingPlanWithRecovery` + `validateLandingPlan` until the LLM picks `stop`. A dirty-overlap state can therefore re-enter the landing planner repeatedly, with the LLM able to drive the run toward a `landed` outcome if it picks `retry` / `revise`.
  * `readDirtyFiles` and `classifyDirtyFiles` are already deterministic (`packages/core/src/runtime/landing-git.ts:17-58`). `isTransientFactoryPath` (`.factory/`, `.worktrees/`, `dist/`, `node_modules/`, etc.) is the only dirty-file filter; transient files are excluded from "relevant" overlap by design.
  * `finishBlockedLanding` (`packages/core/src/runtime/landing.ts:535-562`) already produces `LandingResult { status: "BLOCKED", phase: "merge-blocked", approved: false }`; the controller wires that into `run.state.status: "BLOCKED"` (`packages/core/src/runtime/controller-final-phases.ts:668-674`). So `BLOCKED` is the existing terminal shape; the gap is that the guard-failure path doesn't always reach it.
  * `executeLandingStrategy` (`packages/core/src/runtime/landing-git.ts:154-175`) does `git checkout <targetBranch>` then `merge`/`cherry-pick`/`rebase`. If invoked with dirty overlap (today possible if the guard is bypassed), the result is silent destruction of uncommitted user work. The guard is the only line of defense.
  * The PR fallback `publishBlockedCandidate` (`packages/core/src/runtime/landing.ts:585-628`) is the existing safe-preserve path; it does not touch the user's working copy or the candidate branch.
  * No test currently asserts that a dirty-overlap state produces `BLOCKED` without executing the landing strategy. `tests/landing.test.mjs:567` constructs a fixture with `dirtyRelevantFiles: []` only.
* **Target Behavior:**
  * When the dirty-tree guard fails, `runLandingFlow` immediately routes to `finishBlockedLanding` without calling `landingRecovery` or re-planning. The candidate commit/branch are not touched. The run state is `BLOCKED` with `phase: "merge-blocked"`.
  * The recovery decision is offered to the LLM (or human via policy executor) only *after* `BLOCKED` is recorded — through `requestFailureRecovery` from `controller-final-phases.ts` or, when invoked from the dashboard / `/factory resume`, through the policy/restore surface. The factory rule:
    ```
    Safety invariant = deterministic  (the guard)
    Recovery choice  = LLM-owned      (requestFailureRecovery)
    Terminal status  = Factory-enforced (BLOCKED, never COMPLETED)
    ```
  * `WOULD_DESTROY_DIRTY_WORK` (the effects-based reason) joins the unrecoverable set; `effects.mayDiscardChanges` against any dirty file means the merge is refused even if the file classification would otherwise consider it safe.
  * The `dry-run` / `merge-no-ff` / `cherry-pick` strategy does not change the rule: any strategy that would discard dirty work is blocked.
  * The block must preserve the candidate: tests assert that `git rev-parse <candidateBranch>` and `git cat-file -e <candidateSha>` still resolve after the block, and that the working copy is byte-identical (no `git checkout` ran).
* **Files Affected:**
  * `packages/core/src/runtime/landing.ts` — replace the guard-failure `for (;;)` retry loop with a single-shot `finishBlockedLanding` for dirty-tree reasons; add a typed `DirtyGuardReason` predicate; route the recovery request through a new `landingDirtyTreeRecovery(input, ...)` that calls `requestFailureRecovery` *after* the run state is `BLOCKED`.
  * `packages/core/src/runtime/landing-git.ts` — export `isDirtyGuardReason(reason: string): boolean`; add `assertCandidatePreserved({ mergeCwd, candidateBranch, candidateSha })` that fails loud if the candidate is missing after a block.
  * `packages/core/src/runtime/controller-final-phases.ts` — after `runLandingFlow` returns `BLOCKED` due to dirty-tree guard, emit a `run.recovery_requested` event and let `requestFailureRecovery` choose the recovery action; the controller returns the blocked result, never `COMPLETED`.
  * `packages/core/src/runtime/git-ops.ts` — extend `isTransientFactoryPath` (no change to list, but document the invariant in a comment so the dirty-tree recovery reason is stable).
  * `packages/core/src/runs/resume.ts` — recognize `merge-blocked` (already resumable) and add an explicit `suggestedPhase: "landing"` with `nextStatus: "RUNNING"` plus a `recoveryHint` instructing the user to clean the workspace.
  * `packages/core/src/runs/inspect.ts` — surface the `recoveryHint` in `AcceptanceEvidence` (already exposed via `landing.recoveryHint`; verify).
  * `packages/core/src/constitution/evaluators/reliability.ts` — add a deterministic check that no landing artifact path can be in `status: "landed"` when `dirtyRelevantFiles.length > 0`.
  * `tests/landing.test.mjs` — add: `dirty-overlap blocks deterministically`, `dirty-overlap preserves candidate branch`, `dirty-overlap preserves candidate commit`, `dirty-overlap preserves working copy`, `WOULD_DESTROY_DIRTY_WORK blocks deterministically`, `unrelated dirty files block branch switch`, `recovery request is offered after BLOCKED`.
  * `tests/runtime.test.mjs` — add end-to-end: a controller run whose landing hits a dirty-overlap state produces `state.status === "BLOCKED"` and emits `run.recovery_requested` with `category: "dirty-working-tree"`.
  * `docs/factory/pull-request-recovery.md` — document the deterministic guard; reference the rule.
  * `.pi/skills/factory-concierge/SKILL.md` and `skills/factory-concierge/SKILL.md` — mirror the rule.
  * `learnings.md` — record the safety/recovery split as a new entry.
* **Out of Scope:**
  * Changing the LLM-owned landing-planner interface (the planner is still called once; the loop is the only thing that goes away).
  * Touching `attemptEnvironmentPreparation` / verification / dependency strategy (separate plan).
  * Changing the policy-executor contract; `requestFailureRecovery` is the canonical primitive and stays as-is.
  * Removing `publishBlockedCandidate` (PR fallback). It remains the user-visible recovery affordance; the deterministic guard just guarantees we reach it.
  * Editing `landing-ai.ts`'s diagnosis prompts (the LLM can still choose the recovery action after `BLOCKED`).
  * Editing `cleanup.ts` (run/worktree cleanup is independent).

## 2. Assumptions & Blockers

* **Assumptions:**
  1. The dirty-tree guard set is the union of `Dirty target checkout overlaps landing files: ...`, `Cannot switch from <branch> to <branch> while unrelated files are dirty: ...`, and `WOULD_DESTROY_DIRTY_WORK`. Any other guard reason (e.g. `EMPTY_PLAN`, `Strategy ... requires ...`, `PARSE_FAILED`) keeps the existing retry loop — only the dirty-tree reasons become terminal.
  2. The candidate commit / branch / working-copy are not mutated by `validateLandingPlan` or by `readDirtyFiles` / `classifyDirtyFiles`; only `executeLandingStrategy` mutates. The guard runs *before* execution, so blocking at the guard already preserves the candidate. The plan adds an explicit assertion + test rather than relying on the call order.
  3. Recovery is offered via `requestFailureRecovery` with `canRepair: false, canRevise: true, canRetry: true`. The LLM's choice is persisted to the decision ledger; resume uses `findPendingDecision`. (Existing pattern; same primitive as `verification-blocked`.)
  4. `BLOCKED` is the *terminal* state for the guard case; resume returns to `landing` only after the user cleans the workspace. This matches the project's `AGENTS.md` rule: *"Never end a run because of an internal fallback, missing handler, exhausted retry, or ambiguous recovery result."* — a dirty target is a recoverable condition gated on user action.
  5. The `recoveryAttempts["landing-dirty-guard"]` counter is preserved across the controller's outer recovery loop so repeated `/factory resume` calls don't loop the same guard forever.
* **Questions / Blockers:**
  1. **Single-shot vs bounded retry.** The current code is an unbounded retry loop. My plan replaces it with a single-shot terminal `BLOCKED` + post-block recovery. If you want one bounded retry (e.g. allow the user to fix the dirty state and re-invoke without a full resume), say so and the plan will adjust `recoveryAttempts`.
  2. **Per-strategy override.** Today all dirty-overlap situations block. Some strategies (`pull-request`, `skip`) don't touch the local working copy. Should `pull-request` and `skip` be exempt from the dirty-tree guard? My plan says no (deterministic + simple; the user can still request the LLM to revise the landing plan to one of those strategies). Override if you want strategy-specific exemption.
  3. **PR fallback ordering.** `finishBlockedLanding` currently invokes `publishBlockedCandidate` *after* the run is already `BLOCKED`. My plan keeps this ordering — the deterministic guard never decides to open a PR; that's still an LLM-owned choice via recovery. Confirm.

## 3. Implementation Plan

### Pre-step: confirm worktree state and revert dead-file diffs

* [ ] **Pre-step 0: Confirm a clean starting point**

  * **Files:** No code changes. Verify `git status --short` matches the expected in-progress diff (only the 5 files from the dependency-strategy plan) before continuing.
  * **Interfaces:** None.
  * **Code:**
    ```bash
    git status --short
    # Expected: 5 modified files from the dependency-strategy plan
    ```
  * **Negative Paths:** If other files are dirty, list them and ask the user to stash / revert before proceeding.
  * **Verification:** `git status --short` shows only the 5 known files; `npm run typecheck` PASS.

### Step 1: Expose a typed guard-reason predicate and a candidate-preserved assertion

* [ ] **Step 1: `landing-git.ts` exports + `isDirtyGuardReason`**

  * **Files:**
    * Modify `packages/core/src/runtime/landing-git.ts:73-104` (the `validateLandingPlan` body) — annotate each dirty-tree reason push with a stable marker comment.
    * Modify `packages/core/src/runtime/landing-git.ts` (append new exports at end of file).
  * **Interfaces:**
    ```ts
    /**
     * Returns true when the reason was produced by the deterministic dirty-tree guard.
     * Used by the controller to short-circuit the LLM retry loop.
     */
    export function isDirtyGuardReason(reason: string): boolean;

    /**
     * Fails loud (throws) when the candidate branch or commit is missing from the merge cwd.
     * Call this after a dirty-tree BLOCKED outcome to prove the candidate was preserved.
     */
    export async function assertCandidatePreserved(input: {
      mergeCwd: string;
      candidateBranch?: string;
      candidateSha?: string;
    }): Promise<void>;

    /** Returns a stable list of the dirty-tree reason markers. */
    export const DIRTY_GUARD_REASON_PATTERNS: readonly RegExp[];

    /** Sets the run-state phase after a dirty-tree block. */
    export const DIRTY_GUARD_PHASE = "merge-blocked";
    ```
  * **Code:**
    ```ts
    // packages/core/src/runtime/landing-git.ts — at end of file
    export const DIRTY_GUARD_REASON_PATTERNS: readonly RegExp[] = [
      /^Dirty target checkout overlaps landing files:/,
      /^Cannot switch from .+ to .+ while unrelated files are dirty:/,
      /^WOULD_DESTROY_DIRTY_WORK$/,
    ];

    export function isDirtyGuardReason(reason: string): boolean {
      return DIRTY_GUARD_REASON_PATTERNS.some((pattern) => pattern.test(reason));
    }

    export function guardVerdictHasDirtyTreeReason(reasons: string[]): boolean {
      return reasons.some(isDirtyGuardReason);
    }

    export async function assertCandidatePreserved(input: {
      mergeCwd: string;
      candidateBranch?: string;
      candidateSha?: string;
    }): Promise<void> {
      if (input.candidateBranch) {
        await execFileAsync("git", ["rev-parse", "--verify", input.candidateBranch], {
          cwd: input.mergeCwd, windowsHide: true,
        });
      }
      if (input.candidateSha) {
        await execFileAsync("git", ["cat-file", "-e", `${input.candidateSha}^{commit}`], {
          cwd: input.mergeCwd, windowsHide: true,
        });
      }
    }
    ```
    Replace the `if (effects.mayDiscardChanges && ...) reasons.push("WOULD_DESTROY_DIRTY_WORK")` push (line 97) with an explicit `// DIRTY_GUARD_REASON_MARKER` comment so future edits preserve the literal string. Same for the two `reasons.push(...)` calls at lines 79 and 82.
  * **Negative Paths:**
    * `execFileAsync` throwing inside `assertCandidatePreserved` is the success path — it means the candidate is gone. Let it propagate.
    * `guardVerdictHasDirtyTreeReason([])` returns `false`.
    * `reason` matching one of the regex patterns but with extra whitespace: regexes are anchored at start so trailing spaces matter; tests will lock the exact strings.
  * **Verification:** `npm run typecheck` PASS. New test `tests/landing.test.mjs`:
    ```js
    test('isDirtyGuardReason matches all three markers', () => {
      assert.equal(isDirtyGuardReason("Dirty target checkout overlaps landing files: a.ts"), true);
      assert.equal(isDirtyGuardReason("Cannot switch from main to feature while unrelated files are dirty: b.ts"), true);
      assert.equal(isDirtyGuardReason("WOULD_DESTROY_DIRTY_WORK"), true);
      assert.equal(isDirtyGuardReason("EMPTY_PLAN"), false);
      assert.equal(isDirtyGuardReason("Strategy merge requires a source branch."), false);
      assert.equal(guardVerdictHasDirtyTreeReason(["EMPTY_PLAN", "WOULD_DESTROY_DIRTY_WORK"]), true);
    });
    ```

### Step 2: Deterministic guard outcome in `runLandingFlow`

* [ ] **Step 2: Replace the guard-failure retry loop with single-shot BLOCKED**

  * **Files:** Modify `packages/core/src/runtime/landing.ts:112-146`.
  * **Interfaces:** Reuse existing `finishBlockedLanding(input, plan, diagnosis, reason, pullRequest)` and `landingRecovery(input, key, title, reason, canRevise)`. New typed wrapper:
    ```ts
    async function resolveDirtyTreeBlock(input: Parameters<typeof runLandingFlow>[0], plan: LandingPlan, guardVerdict: LandingGuardVerdict, dirtyContext: ReturnType<typeof classifyDirtyFiles>): Promise<LandingResult>;
    ```
  * **Code:**
    ```ts
    // packages/core/src/runtime/landing.ts — replace the for (;;) loop at lines 112-146
    if (guardVerdict.ok) {
      // happy path; continue to execution
    } else if (guardVerdictHasDirtyTreeReason(guardVerdict.reasons)) {
      return resolveDirtyTreeBlock(input, plan, guardVerdict, dirtyContext);
    } else {
      // Existing retry loop for non-dirty reasons (parses, missing refs, etc.) stays as-is.
      for (;;) {
        const recoveryReason = guardVerdict.reasons.join("; ");
        const recovery = await landingRecovery(input, "landing-guard", "landing guard blocked the candidate", recoveryReason, true);
        if (recovery.action !== "retry" && recovery.action !== "revise") {
          await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.guard_blocked_recorded", data: { reason: recoveryReason, dirtyFiles: dirtyContext.relevant, unrelatedFiles: dirtyContext.unrelated } });
          const diagnosis = await diagnoseOrFallback({ executor, model: modelSelection?.model, plan, reason: recoveryReason, dirtyFiles: dirtyContext.relevant, verification: input.verification, limits: input.config.runtime.limits });
          const pullRequest = await publishBlockedCandidate(input, recoveryReason);
          return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? recoveryReason, pullRequest);
        }
        const replanned = await buildLandingPlanWithRecovery(input, executor, modelSelection, dirtyContext, recovery.feedback);
        plan = replanned.plan;
        guardVerdict = await validateLandingPlan({ ... });
        landingPlanArtifact = { ...plan, guardVerdict };
        await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
        await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.plan_selected", data: landingPlanArtifact as unknown as Record<string, unknown> });
        if (guardVerdictHasDirtyTreeReason(guardVerdict.reasons)) {
          return resolveDirtyTreeBlock(input, plan, guardVerdict, dirtyContext);
        }
      }
    }
    ```
    New helper:
    ```ts
    async function resolveDirtyTreeBlock(
      input: Parameters<typeof runLandingFlow>[0],
      plan: LandingPlan,
      guardVerdict: LandingGuardVerdict,
      dirtyContext: ReturnType<typeof classifyDirtyFiles>,
    ): Promise<LandingResult> {
      const reason = guardVerdict.reasons.filter(isDirtyGuardReason).join("; ");
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "landing.dirty_guard_blocked",
        data: { reason, relevant: dirtyContext.relevant, unrelated: dirtyContext.unrelated },
      });
      await assertCandidatePreserved({
        mergeCwd: input.mergeCwd,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
      });
      const diagnosis = await diagnoseOrFallback({
        executor, model: modelSelection?.model, plan,
        reason, dirtyFiles: dirtyContext.relevant,
        verification: input.verification, limits: input.config.runtime.limits,
      });
      // mark the kind as dirty-target deterministically; the LLM diagnosis still runs for evidence but does not influence the block.
      diagnosis.kind = dirtyContext.relevant.length > 0 ? "dirty-target" : "unsafe-risk";
      diagnosis.recoveryHint = reason;
      const pullRequest = await publishBlockedCandidate(input, reason);
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "run.recovery_requested",
        data: {
          decisionRequestId: `${input.runId}-dirty-guard-${Date.now()}`,
          phase: "landing",
          category: "dirty-working-tree",
          attempt: 1,
          evidenceRefs: [path.join(input.runDir, "landing-plan.json")],
        },
      });
      return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? reason, pullRequest);
    }
    ```
  * **Negative Paths:**
    * The retry loop runs only for non-dirty reasons. If the LLM responds with `retry` and the re-planned plan still triggers a dirty reason, the loop exits to `resolveDirtyTreeBlock` (inner check at the bottom of the loop).
    * `assertCandidatePreserved` throws if the candidate branch or commit is missing — the run terminates loudly with the underlying `git` error. This is intentional; the block must preserve the candidate.
    * `publishBlockedCandidate` returns `undefined` when there is no candidate branch — `finishBlockedLanding` handles that.
  * **Verification:** `npm run typecheck` PASS. New tests `tests/landing.test.mjs`:
    ```js
    test('dirty-overlap blocks deterministically without retry', async () => {
      const { root, plan, completedTasks } = await landingDirtyRepo({ overlap: ["index.html"] });
      const landingExecutor = { async execute() { throw new Error("landing planner must NOT be called for dirty overlap"); } };
      const result = await runLandingFlow({ ..., dirtyRelevantFiles: ["index.html"], dirtyUnrelatedFiles: [] });
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.phase, "merge-blocked");
      assert.equal(result.approved, false);
      // candidate preserved
      const head = await git(root, ["rev-parse", "factory/task-1"]);
      assert.ok(head.trim());
      // working copy untouched
      const workingCopy = await fs.readFile(path.join(root, "index.html"), "utf8");
      assert.match(workingCopy, /<h1>User edit<\/h1>/);
    });

    test('WOULD_DESTROY_DIRTY_WORK blocks deterministically', async () => {
      // Same fixture but with effects.mayDiscardChanges triggered by a `git checkout --` action in the plan.
      const result = await runLandingFlow({ ..., plan: { ...plan, actions: [{ kind: "command", step: { args: ["checkout", "--", "."] } }] } });
      assert.equal(result.status, "BLOCKED");
    });

    test('unrelated dirty files block branch switch', async () => {
      const result = await runLandingFlow({ ..., plan: { ...plan, targetBranch: "feature" }, dirtyRelevantFiles: [], dirtyUnrelatedFiles: ["scratch.ts"] });
      assert.equal(result.status, "BLOCKED");
      assert.match(result.recoveryHint ?? "", /unrelated files are dirty/);
    });

    test('recovery request is offered after dirty BLOCKED', async () => {
      const eventsRaw = await fs.readFile(eventsPath, "utf8");
      assert.match(eventsRaw, /landing\.dirty_guard_blocked/);
      assert.match(eventsRaw, /run\.recovery_requested/);
    });
    ```

### Step 3: Wire the controller and post-block recovery

* [ ] **Step 3: Controller emits `run.recovery_requested` and never returns `COMPLETED`**

  * **Files:** Modify `packages/core/src/runtime/controller-final-phases.ts:624-700` (`runFinalPhases` after `runLandingFlow`).
  * **Interfaces:** None new. Use existing `requestFailureRecovery` (`packages/core/src/runtime/failure-recovery.ts:68`).
  * **Code:**
    ```ts
    // controller-final-phases.ts — replace the block at lines 651-690
    finalMergePath = landingResult.finalMergePath;
    const isDirtyBlock = landingResult.phase === "merge-blocked"
      && (landingResult.recoveryHint ?? "").match(/Dirty target checkout overlaps landing files:|Cannot switch from .+ to .+ while unrelated files are dirty:|WOULD_DESTROY_DIRTY_WORK/);
    if (landingResult.status === "COMPLETED") {
      // existing happy path
    } else if (isDirtyBlock) {
      const recovery = await requestFailureRecovery({
        controllerInput: input,
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: {
          phase: "merge-blocked",
          title: "dirty working tree at the landing target",
          reason: landingResult.recoveryHint ?? "Dirty working tree.",
          category: "dirty-working-tree",
          retryable: true,
          canRepair: false,
          canRevise: true,
          attempt: 1,
          maxAttempts: loaded.effectiveConfig.git.cleanup?.maxDirtyGuardRecoveryAttempts ?? 3,
          evidenceRefs: [finalMergePath, landingResult.finalMergePath].filter((value): value is string => Boolean(value)),
        },
      });
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "run.dirty_guard_blocked_recorded",
        data: { reason: landingResult.recoveryHint, action: recovery.action, feedback: recovery.feedback },
      });
      // The terminal status is BLOCKED regardless of the LLM's recovery choice.
      // Recovery is offered for the next run; this run never completes.
    }
    // existing run.completed / run.blocked branching below (status === "COMPLETED" branch already returns the success result; the BLOCKED branch builds the failure result).
    ```
    Add `maxDirtyGuardRecoveryAttempts?: number` to `git.cleanup` in `packages/schemas/src/config.ts:159-166` and `packages/core/src/config/defaults.ts:47-50` (default 3).
  * **Negative Paths:**
    * The recovery primitive returns `stop` → controller proceeds to the existing `BLOCKED` `finalMergePath` write and terminal summary; status remains `BLOCKED`.
    * `recovery.action === "revise"` → logged as evidence; status remains `BLOCKED`. (Revising the landing plan requires a new run with a clean workspace; we do not loop the current run.)
    * The recovery primitive throws → caught by the existing `requestFailureRecovery` error path (`failure-recovery.ts:124-127`); run remains `BLOCKED`.
  * **Verification:** `npm run typecheck` PASS. New test `tests/runtime.test.mjs`:
    ```js
    test('dirty-overlap produces BLOCKED and offers recovery', async () => {
      // Build a repo where the run completes verification successfully but
      // the mergeCwd has a dirty overlap with the candidate.
      await withTempProject(async (root) => {
        // ... commit a candidate on factory/task-1
        // ... dirty `index.html` in the mergeCwd to overlap with candidate's changed files
        const recoveryCalls = [];
        const result = await runRuntimeHarness({
          cwd: root,
          goal: 'Add candidate',
          landingExecutor,
          requestFailureRecovery: async (req) => { recoveryCalls.push(req); return { action: 'revise', feedback: 'clean workspace' }; },
        });
        const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
        assert.equal(state.status, 'BLOCKED');
        assert.equal(state.phase, 'merge-blocked');
        assert.ok(recoveryCalls.length >= 1);
        assert.equal(recoveryCalls[0].context.category, 'dirty-working-tree');
        // Summary derived from verification.json — verification passed but the run is BLOCKED.
        const summary = JSON.parse(await fs.readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
        assert.equal(summary.status, 'BLOCKED');
      });
    });
    ```

### Step 4: Resume routing

* [ ] **Step 4: `resume.ts` recognizes `merge-blocked`**

  * **Files:** Modify `packages/core/src/runs/resume.ts:312-355` (`suggestResumePolicy`).
  * **Interfaces:** None — pure function.
  * **Code:**
    ```ts
    if (currentPhase === "merge-blocked") {
      const verification = currentVerification ?? {};
      const dirtyHint = typeof verification.recoveryHint === "string" && /Dirty target checkout overlaps landing files:|Cannot switch from .+ to .+ while unrelated files are dirty:|WOULD_DESTROY_DIRTY_WORK/.test(verification.recoveryHint)
        ? "Dirty working tree in the merge target. Commit or stash the dirty files (and verify with `git status --porcelain`) before resuming."
        : "Inspect the dirty files in the merge target before resuming.";
      return {
        resumable: true,
        suggestedPhase: "landing",
        nextStatus: "RUNNING",
        reason: dirtyHint,
      };
    }
    ```
    The existing `if (currentPhase.includes("verification") ...)` branch handles `merge-blocked` only as `verification/repair` resume, which is wrong. Move the new branch above the verification branch.
  * **Negative Paths:**
    * `currentPhase === "merge-blocked"` and `verification` is missing → reason falls back to the generic hint; still resumable.
    * `currentPhase === "merge-blocked"` but the underlying reason is *not* dirty (e.g. an LLM-chosen non-dirty block) → still routes to `landing`, the controller re-runs `validateLandingPlan` which is idempotent.
  * **Verification:** New test `tests/runtime.test.mjs` or `tests/cleanup.test.mjs`:
    ```js
    test('merge-blocked resumes to landing with dirty-hint', async () => {
      const policy = await suggestResumePolicy({ currentPhase: "merge-blocked", finalMerge: undefined, verification: { recoveryHint: "Dirty target checkout overlaps landing files: index.html" } });
      assert.equal(policy.resumable, true);
      assert.equal(policy.suggestedPhase, "landing");
      assert.match(policy.reason, /commit or stash/i);
    });
    ```

### Step 5: Constitution evaluator for invariant checking

* [ ] **Step 5: Reliability evaluator asserts the invariant**

  * **Files:** Modify `packages/core/src/constitution/evaluators/reliability.ts` (append a check).
  * **Interfaces:** None — existing evaluator signature.
  * **Code:**
    ```ts
    // Inside the evaluator's run() function, after the existing checks:
    const landingArtifacts = runArtifacts.filter((artifact) => artifact.kind === "final-merge");
    for (const artifact of landingArtifacts) {
      if (artifact.status === "landed" && Array.isArray(artifact.dirtyRelevantFiles) && artifact.dirtyRelevantFiles.length > 0) {
        findings.push({
          area: "reliability",
          severity: "high",
          summary: "Landing artifact marked 'landed' while dirty overlap was reported — guard invariant violated.",
          evidence: artifact.path,
          recommendation: "Re-check the landing guard; deterministic dirty-tree guard must short-circuit to BLOCKED.",
        });
      }
    }
    ```
  * **Negative Paths:**
    * No landing artifact → no finding.
    * Landing artifact is `blocked` / `pull-request` → no finding.
  * **Verification:** New test in `tests/constitution.test.mjs` (existing suite): fixture with a landing artifact whose `status: "landed"` and `dirtyRelevantFiles: ["index.html"]`; expect a `high` severity finding mentioning the guard invariant.

### Step 6: Tests — full coverage matrix

* [ ] **Step 6: Tests for the guard and the recovery surface**

  * **Files:**
    * Modify `tests/landing.test.mjs` (add 7 tests listed in Steps 1–2).
    * Modify `tests/runtime.test.mjs` (add the end-to-end test from Step 3).
    * Modify `tests/constitution.test.mjs` (add the invariant test from Step 5).
    * Create `tests/dirty-guard.test.mjs` (or extend `tests/landing.test.mjs`) with a fixture helper:
    * **Interfaces:** None — pure test additions.
    * **Code (representative fixture helper):**
      ```js
      async function landingDirtyRepo({ overlap = [], unrelated = [] } = {}) {
        const root = await initRepo();
        await git(root, ["switch", "-c", "factory/task-1"]);
        await fs.writeFile(path.join(root, "index.html"), "<h1>Candidate</h1>\n", "utf8");
        await git(root, ["add", "index.html"]);
        await git(root, ["commit", "-m", "candidate"]);
        const candidateSha = await git(root, ["rev-parse", "HEAD"]);
        await git(root, ["switch", "main"]);
        // User's dirty edit in the merge target (overlap with candidate)
        if (overlap.length > 0) {
          await fs.writeFile(path.join(root, overlap[0]), "<h1>User edit</h1>\n", "utf8");
        }
        for (const file of unrelated) {
          await fs.writeFile(path.join(root, file), "// scratch\n", "utf8");
        }
        const plan = {
          actions: [],
          strategy: "merge",
          targetBranch: "main",
          sourceBranch: "factory/task-1",
          candidateSha,
          rationale: "Cherry-pick into main.",
          verification: ["lint"],
          risk: "low",
          expectedFiles: ["index.html"],
          recoveryPlan: "Open a PR if direct landing fails.",
        };
        const completedTasks = [{
          taskId: "task-1",
          targetBranch: "main",
          sourceBranch: "factory/task-1",
          commitSha: candidateSha,
          changedFiles: ["index.html"],
          workspaceMode: "created",
          worktreePath: root,
        }];
        return { root, plan, completedTasks, candidateSha };
      }
      ```
  * **Negative Paths:** Each test asserts the absence of the action that the guard is supposed to prevent (no `git checkout`, no merge, no commit), and asserts the presence of `landing.dirty_guard_blocked` and `run.recovery_requested` events.
  * **Verification:** `node --test tests/landing.test.mjs tests/runtime.test.mjs tests/constitution.test.mjs tests/dirty-guard.test.mjs` — PASS.

### Step 7: Docs and skills

* [ ] **Step 7: Documentation updates**

  * **Files:**
    * Modify `docs/factory/pull-request-recovery.md` — add a "Deterministic dirty-tree guard" section with the rule:
      ```
      Safety invariant = deterministic (Factory refuses dirty overlap before any merge / checkout)
      Recovery choice  = LLM-owned     (requestFailureRecovery offers retry, revise, patch, ask)
      Terminal status  = Factory-enforced (BLOCKED, never COMPLETED)
      ```
    * Modify `.pi/skills/factory-concierge/SKILL.md` and `skills/factory-concierge/SKILL.md` — mirror the rule in the operator narrative.
    * Modify `learnings.md` — append:
      ```
      - Landing's dirty-working-tree guard is a deterministic Factory safety invariant: Factory must refuse to overwrite or merge when the target checkout contains dirty files that overlap with the candidate, and must mark the run BLOCKED. The LLM owns only the recovery decision (retry / revise / patch / ask), never the block decision. Re-entered this rule on the dirty-guard plan.
      ```
  * **Interfaces:** None.
  * **Code:** Pure doc edits.
  * **Negative Paths:** N/A.
  * **Verification:** `grep -rn "WOULD_DESTROY_DIRTY_WORK\|dirty tree guard\|dirty-working-tree" docs/factory .pi/skills skills` shows the new sections; `grep -rn "BLOCKED.*landing.*retry" packages/core/src --include=*.ts | grep -v dist` returns zero (no auto-retry around dirty block remains).

## 4. Testing

* **Run the full test suite:** `npm test` — PASS (includes `npm run build` + `node scripts/complexity-guard.mjs` + `node --test tests/**/*.test.mjs`).
* **Targeted runs:**
  * `node --test tests/landing.test.mjs` — all existing tests + the 7 new ones (`isDirtyGuardReason matches all three markers`, `dirty-overlap blocks deterministically without retry`, `WOULD_DESTROY_DIRTY_WORK blocks deterministically`, `unrelated dirty files block branch switch`, `recovery request is offered after dirty BLOCKED`, plus candidate-preservation and working-copy-preservation assertions).
  * `node --test tests/runtime.test.mjs` — `dirty-overlap produces BLOCKED and offers recovery`.
  * `node --test tests/constitution.test.mjs` — invariant check.
  * `node --test tests/cleanup.test.mjs` — resume routing for `merge-blocked`.
* **Negative-path coverage:**
  * Empty `dirtyRelevantFiles` / `dirtyUnrelatedFiles` → happy path; landing proceeds.
  * `recoveryAttempts["landing-dirty-guard"] > maxDirtyGuardRecoveryAttempts` → recovery primitive returns `stop` early; status remains `BLOCKED`.
  * Candidate branch deleted between commit and landing → `assertCandidatePreserved` throws; run aborts with the underlying `git` error. Loud, not silent.
  * Strategy `pull-request` or `skip` with dirty target → still blocked (deterministic guard does not exempt strategies).
  * User's dirty edit only touches files unrelated to candidate (`dirtyUnrelatedFiles`) AND current branch is already the target branch → guard passes (the branch-switch reason requires `currentBranch !== targetBranch`).
* **Regression coverage:**
  * Existing landing tests (no dirty files) still produce `COMPLETED`.
  * Existing landing-guard retry tests for `EMPTY_PLAN`, parse failures, missing refs still retry around the LLM; the new branch only fires on dirty-tree reasons.
  * Existing PR fallback tests still pass: `publishBlockedCandidate` is still called by `finishBlockedLanding`.

## 5. Definition of Done

* [ ] `isDirtyGuardReason` matches exactly the three deterministic markers; tests lock the strings.
* [ ] `guardVerdictHasDirtyTreeReason` is used in `runLandingFlow` to short-circuit the retry loop for the dirty case.
* [ ] `runLandingFlow` reaches `finishBlockedLanding` (status `BLOCKED`, phase `merge-blocked`, approved `false`) for every dirty-tree guard failure.
* [ ] `assertCandidatePreserved` is called before `finishBlockedLanding` in the dirty case; the candidate branch and commit are byte-identical after the block.
* [ ] `controller-final-phases.ts` calls `requestFailureRecovery` with `category: "dirty-working-tree"` after a dirty-block landing; recovery primitive decides the action but the run's terminal status stays `BLOCKED`.
* [ ] `resume.ts::suggestResumePolicy("merge-blocked")` returns `{ resumable: true, suggestedPhase: "landing", nextStatus: "RUNNING", reason: <dirty-hint> }`.
* [ ] Constitution reliability evaluator flags any landing artifact whose `status === "landed"` but `dirtyRelevantFiles.length > 0` as a `high` severity invariant violation.
* [ ] All tests pass (`npm test`); type check passes (`npm run typecheck`); build passes (`npm run build`).
* [ ] Docs and skills updated; `docs/factory/pull-request-recovery.md` contains the rule; `learnings.md` records the deterministic/invariant vs LLM/recovery split.
