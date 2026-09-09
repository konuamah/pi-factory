# Interview DAG Execution

## 1. Understanding & Scope

* **Core Goal:**
  Make Factory's runtime honor `dependsOn` for `interview` workflow stages. Currently every `type: "interview"` stage is collected and run before planning, even when it declares `dependsOn: [verify]`. After this change, interviews execute at the correct point in the workflow DAG: pre-planning interviews before planning, and post-verification interviews after `verify` completes and before `review`. Interview context wording is generalized so answers are routed to the correct downstream stage (planner vs reviewer/approval), and workflow dependency validation prevents silently-ignored DAG structure.

* **Current Behavior:**
  * `packages/core/src/runtime/discovery-phase.ts:80` computes `const interviewStages = workflowStages.filter((stage) => stage.type === "interview")` — this collects **all** interview stages regardless of `dependsOn`.
  * `packages/core/src/runtime/controller-interview.ts:31-160` — `runInterviewStages` loops over every stage in `input.stages`, executes the model, and (when not `INTERVIEW_COMPLETE`) asks the human via `requestHumanDecision` with a **hardcoded** `context` string at line 121: `"Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan."`. No phase/execution-point information is consulted.
  * `discovery-phase.ts:357-386` invokes `runInterviewStages({ stages: interviewStages, ... })` unconditionally within the discovery phase.
  * `packages/core/src/runtime/controller-run.ts:40, 119-121, 146-149, 181-195, 365-394` — the main pipeline: `runDiscoveryPhase` returns `interviewContext`/`interviewDecisions`; those flow to `runPlanningPhase` and forward. After verification, `runFinalPhases` runs at line 365 and does not run any additional interviews.
  * `packages/core/src/runtime/controller-final-phases.ts:52, 206` — review/approval already consume `interviewDecisions` via `buildReviewerPrompt(input.goal, verification, ..., interviewDecisions, reviewSurface)`.
  * `INTERVIEW_COMPLETE` no-pause behavior already exists at `controller-interview.ts:132` (`if (!output || /INTERVIEW_COMPLETE/i.test(output)) { continue; }`), but only works if the loop runs at the right time.
  * `packages/core/src/workflows/registry.ts:110, 185-186` parses `dependsOn` onto `WorkflowStage`, but no validation of `dependsOn` references, cycles, unreachable stages, or `acceptance`/`approval` gates without a `review` dependency exists.
  * An interview decision artifact only contains the stage `name` (see `controller-interview.ts:140` `stage: stage.name`); there is no "phase"/"execution point" field.

* **Target Behavior:**
  * Interviews are separated by their **execution point** in the workflow DAG:
    - **Pre-planning interviews**: `dependsOn` is empty or only references discovery/planning-adjacent stages. These run in the discovery phase as today.
    - **Post-verification interviews**: `dependsOn` references `verification` (or any stage that runs after build, such as a `verify` stage). These run **after** the verify phase completes and **before** the review phase.
  * `runInterviewStages` is replaced by two call sites, each passing only the subset of interview stages relevant to that point. The filter never uses `workflowStages.filter((stage) => stage.type === "interview")` as the complete list for one point.
  * The interview `context` becomes execution-point aware:
    - Pre-planning: `"Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan."` (unchanged for backward compatibility).
    - Post-verification: `"Answer the interview questions about the verified candidate. Factory will include your answer in the reviewer and approval prompts; it will NOT be fed back into planning or building."`
  * Post-verification interview answers are appended to `interview-decisions.json` and passed to the reviewer and approval phases only.
  * Workflow dependency validation (in `registry.ts`) rejects `factory.yaml` configurations that declare:
    - a `dependsOn` stage name that does not exist in the same workflow;
    - a dependency cycle (a stage transitively depends on itself);
    - an interview stage that can never be reached (i.e., not reachable from the DAG root via `dependsOn`);
    - an `acceptance`/`approval` stage whose `dependsOn` does not reference a review-producing stage (for the default workflow, `review`; for custom workflows, any stage whose `role === "reviewer"`).
  * All artifacts remain backward compatible: `InterviewDecisionRecord` gains an optional `executionPhase?: "pre-planning" | "post-verification"` field; existing decision records (which lack it) are treated as `"pre-planning"`.

* **Files Affected:**
  * `Modify: packages/core/src/runtime/discovery-phase.ts:78-80, 355-386`
  * `Modify: packages/core/src/runtime/controller-interview.ts:31-160, 118-136`
  * `Modify: packages/core/src/runtime/controller-run.ts:365-394` (insert post-verification interview between verification result and `runFinalPhases`)
  * `Modify: packages/core/src/runtime/controller-final-phases.ts:52, 206` (consume post-verification interview decisions in reviewer prompt; no new routing needed since `interviewDecisions` already flow here)
  * `Modify: packages/core/src/runtime/controller.ts` — `InterviewDecisionRecord` type gains `executionPhase?: "pre-planning" | "post-verification"`
  * `Modify: packages/core/src/workflows/registry.ts:90-120, 180-230` (add `validateWorkflowDependencies` + call it in `readWorkflowRegistry`/`normalizeWorkflowConfig`)
  * `Modify: packages/schemas/src/config.ts` — `WorkflowStage` gains optional `phase?: "pre-planning" | "post-verification"` (or derive from `dependsOn`; see Assumptions)
  * `Modify: packages/adapters/pi/src/interview-dialog.ts:9-10, 380-400` (persist executionPhase into decision artifact)
  * `Test: tests/runtime.test.mjs` (regression + edge cases)
  * `Test: tests/workflow-registry.test.mjs` (new, DAG validation)
  * `Modify: tests/pi-adapter.test.mjs` (interview context assertion)
  * `Modify: docs/factory/workflow-authoring.md:79-90`
  * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140`
  * `Modify: skills/factory-concierge/SKILL.md:120-140`
  * `Modify: learnings.md`

* **Out of Scope:**
  * Changing built-in default workflow stage semantics (it already has `verification` → `review` → `acceptance`). Default workflow is valid under the new validation.
  * Executing an interview more than once. A stage is either pre-planning or post-verification, never both.
  * Reordering non-interview stages (build/verify/review ordering logic is unchanged).
  * Adding UI for multi-interview DAG editing; only the runtime + validation change.
  * Fixing the unrelated landing problems noted in the run (`backend/tasks.db` committed, dirty overlapping files, no git remote for PR fallback).

## 2. Assumptions & Blockers

* **Assumptions:**
  * **Execution point is derivable from `dependsOn`** — an interview stage is:
    - `pre-planning` if its `dependsOn` is empty, or all dependency names resolve to stages that execute before the planner (`discover`/`discovery`/the discovery stage);
    - `post-verification` if any of its `dependsOn` names resolves to the `verification` stage or any stage whose name is in `["verify", "verification"]`.
  * The existing default workflow's `verification` stage is always the canonical post-build check. Custom workflows may name it `verify`.
  * The controller decides which interviews are eligible at each execution point by **topological order**: `dependsOn` forms a DAG; pre-planning interviews are those whose dependencies are satisfied before planning; post-verification interviews are those whose dependencies are satisfied only after verification. The implementation must confirm reachability from the workflow root using the validated DAG.
  * `InterviewDecisionRecord` currently records `stage: stage.name` (line 140). The plan adds `executionPhase` but does not remove/rename existing fields, so persisted artifacts remain readable.
  * Interview answers for post-verification stages must be **available to the reviewer/approval prompt but not to the planner**. Because `controller-final-phases.ts:206` already feeds `interviewDecisions` into the reviewer prompt, and `controller-run.ts` only passes discovery-time `interviewDecisions` to the planner, the code must append post-verification decisions only **after** planning finishes.

* **Questions / Blockers:**
  * **None blocking.** One decision the builder must confirm: whether to add an explicit `phase` field on `WorkflowStage` in `config.ts` (extra config surface) or derive execution point purely from `dependsOn` (zero config change). The plan defaults to **derive from `dependsOn`** to avoid a config migration; if the team prefers an explicit knob, the plan's Step 2 adds a `phase` field with a default derived from `dependsOn`.

## 3. Implementation Plan

* [ ] **Step 1: Add a regression test that fails today**

  * **Files:**
    * `Test: tests/runtime.test.mjs` (append; find an existing full-run builder test to model the fixture on, e.g. any test that constructs a `WorkflowDefinition` and runs the controller)
  * **Interfaces:**
    * Consumes: existing `createFactoryRun`, `runFactoryController`, `buildEffectiveConfig` fixtures in `tests/runtime.test.mjs`. `WorkflowStage`, `WorkflowDefinition` from `@factory/schemas`.
    * Produces: a failing test asserting the correct event order when a workflow declares a post-verification interview.
  * **Code:**
    ```js
    // tests/runtime.test.mjs (new test)
    test('post-verification interview runs after Verify and before Review, not before planning', async () => {
      const workflow: WorkflowDefinition = {
        id: 'post-verify-interview-flow',
        name: 'post-verify interview',
        stages: [
          { name: 'discover', type: 'agent', role: 'discovery' },
          { name: 'interview', type: 'interview', role: 'planner', dependsOn: ['discover'] },
          { name: 'plan', type: 'agent', role: 'planner', dependsOn: ['interview'] },
          { name: 'implementation', type: 'agent', role: 'builder', dependsOn: ['plan'] },
          { name: 'verification', type: 'command', commands: ['lint'], dependsOn: ['implementation'] },
          { name: 'post_verify_interview', type: 'interview', role: 'planner', dependsOn: ['verification'] },
          { name: 'review', type: 'agent', role: 'reviewer', dependsOn: ['post_verify_interview'] },
          { name: 'acceptance', type: 'acceptance', dependsOn: ['review'] },
        ],
      };
      const { events } = await runFactoryController({ workflow, ...fixtureInputs });
      const phases = events.filter((e) => e.type === 'phase.' + 'interview' || e.type.startsWith('phase.'))
        .map((e) => `${e.type}:${e.data?.message ?? ''}`);
      // Assert pre-planning interview comes before planning.
      const prePlanningIndex = phases.findIndex((p) => /interview/i.test(p) && !/post_verify/inter.test(p));
      const planningIndex = phases.findIndex((p) => /planning/i.test(p));
      assert.ok(prePlanningIndex !== -1 && prePlanningIndex < planningIndex, 'pre-planning interview must run before planning');
      // Assert post-verify interview comes after verification and before review.
      const verificationIndex = phases.findIndex((p) => /verification/i.test(p));
      const postVerifyIndex = phases.findIndex((p) => /post_verify_interview/i.test(p));
      const reviewIndex = phases.findIndex((p) => /review/i.test(p));
      assert.ok(postVerifyIndex !== -1, 'post-verify interview must run');
      assert.ok(postVerifyIndex > verificationIndex, 'post-verify interview must run after verification');
      assert.ok(postVerifyIndex < reviewIndex, 'post-verify interview must run before review');
      assert.ok(reviewIndex > verificationIndex, 'review must run after verification');
    });
    ```
  * **Negative Paths:**
    * This test FAILS before the fix: today `post_verify_interview` runs before planning (both `interview` and `post_verify_interview` run in the discovery-phase loop) so `postVerifyIndex < planningIndex` and the `postVerifyIndex > verificationIndex` assertion fails.
  * **Verification:**
    * `node --test --test-name-pattern 'post-verification interview' tests/runtime.test.mjs` — **FAILS** before the fix (this is the regression test proving the bug), then **PASSES** after Steps 2-5.

* [ ] **Step 2: Add workflow DAG validation**

  * **Files:**
    * `Modify: packages/core/src/workflows/registry.ts:90-120, 180-230`
    * `Test: tests/workflow-registry.test.mjs` (new)
  * **Interfaces:**
    * Consumes: `WorkflowDefinition`, `WorkflowStage` from `@factory/schemas`.
    * Produces:
      ```ts
      // packages/core/src/workflows/registry.ts (new exports)
      export type WorkflowValidationIssue = {
        code: "unknown-depends-on" | "cycle" | "unreachable-stage" | "approval-without-review";
        workflowId: string;
        stage: string;
        detail: string;
      };

      export function validateWorkflowDependencies(workflow: WorkflowDefinition): WorkflowValidationIssue[];
      ```
    Behavior:
    - `unknown-depends-on`: any `dependsOn` name not present in `workflow.stages` names.
    - `cycle`: any stage transitively depending on itself (DFS with visited stack).
    - `unreachable-stage`: any stage not reachable from the DAG roots — a stage is a root if it has no `dependsOn`; BFS/DFS from all roots must visit every stage. Practically, an interview stage with `dependsOn: ["post_verify_interview"]` that no other stage depends on and that is not reachable from a root.
    - `approval-without-review`: any stage with `type === "acceptance"` or `type === "approval"` whose `dependsOn` array does not include a stage with `role === "reviewer"` (either directly or transitively).
  * **Code:**
    ```ts
    // packages/core/src/workflows/registry.ts (additions)
    export function validateWorkflowDependencies(workflow: WorkflowDefinition): WorkflowValidationIssue[] {
      const issues: WorkflowValidationIssue[] = [];
      const names = new Set(workflow.stages.map((s) => s.name));
      for (const stage of workflow.stages) {
        for (const dep of stage.dependsOn ?? []) {
          if (!names.has(dep)) {
            issues.push({ code: "unknown-depends-on", workflowId: workflow.id, stage: stage.name, detail: `dependsOn references unknown stage '${dep}'` });
          }
        }
      }
      // Cycle detection via DFS.
      const visiting = new Set<string>();
      const done = new Set<string>();
      const visit = (name: string, stack: string[]): void => {
        if (done.has(name)) return;
        if (visiting.has(name)) {
          issues.push({ code: "cycle", workflowId: workflow.id, stage: name, detail: `dependency cycle: ${[...stack, name].join(" -> ")}` });
          return;
        }
        visiting.add(name);
        const stage = workflow.stages.find((s) => s.name === name);
        for (const dep of stage?.dependsOn ?? []) {
          visit(dep, [...stack, name]);
        }
        visiting.delete(name);
        done.add(name);
      };
      for (const stage of workflow.stages) { visit(stage.name, []); }

      // Unreachable: BFS from all roots (stages with no dependsOn).
      const reachable = new Set<string>();
      const queue: string[] = workflow.stages.filter((s) => (s.dependsOn?.length ?? 0) === 0).map((s) => s.name);
      for (const root of queue) reachable.add(root);
      while (queue.length) {
        const name = queue.shift()!;
        for (const stage of workflow.stages) {
          if ((stage.dependsOn ?? []).includes(name) && !reachable.has(stage.name)) {
            reachable.add(stage.name);
            queue.push(stage.name);
          }
        }
      }
      for (const stage of workflow.stages) {
        if (!reachable.has(stage.name)) {
          issues.push({ code: "unreachable-stage", workflowId: workflow.id, stage: stage.name, detail: "stage is not reachable from any workflow root" });
        }
      }

      // Approval without review: acceptance/approval must transitively depend on a reviewer.
      const reviewerNames = new Set(workflow.stages.filter((s) => s.role === "reviewer").map((s) => s.name));
      for (const stage of workflow.stages) {
        if (stage.type !== "acceptance" && stage.type !== "approval") continue;
        const deps = stage.dependsOn ?? [];
        const dependsOnReviewer = deps.some((d) => reviewerNames.has(d))
          || deps.some((d) => {
            const depStage = workflow.stages.find((s) => s.name === d);
            return (depStage?.dependsOn ?? []).some((dd) => reviewerNames.has(dd));
          });
        if (!dependsOnReviewer) {
          issues.push({ code: "approval-without-review", workflowId: workflow.id, stage: stage.name, detail: `${stage.type} must depend (directly or transitively) on a reviewer stage (role === 'reviewer')` });
        }
      }
      return issues;
    }
    ```
    Wire into config load: in `normalizeWorkflowConfig` (registry.ts) after the workflow list is built, call `validateWorkflowDependencies` on each workflow. Throw a descriptive error on any `issues.length > 0` so a malformed `factory.yaml` fails loudly at read time rather than silently running an interview at the wrong point.
  * **Negative Paths:**
    * DAG with an unknown dep → throw with code `unknown-depends-on`; the workflow is not run.
    * DAG with a cycle → throw with `cycle`; the workflow is not run.
    * A stage referenced only by a stage that is itself unreachable (dangling) → `unreachable-stage`; throw.
    * `acceptance` without a reviewer dependency → `approval-without-review`; throw. The built-in default workflow passes all four checks.
    * Auto-projection of an interview as reachable-but-nowhere-run is caught by `unreachable-stage`.
  * **Verification:**
    * `node --test tests/workflow-registry.test.mjs` — PASS with 5 new tests:
      1. `validates the built-in default workflow as valid` (expects issues.length === 0).
      2. `rejects an unknown dependsOn stage` (expects 1 unknown-depends-on).
      3. `rejects a dependency cycle` (expects 1 cycle).
      4. `rejects an unreachable stage` (expects 1 unreachable-stage).
      5. `rejects acceptance without a reviewer dependency` (expects 1 approval-without-review).

* [ ] **Step 3: Separate interview stages by execution point in the discovery phase**

  * **Files:**
    * `Modify: packages/core/src/runtime/discovery-phase.ts:78-80, 355-386`
    * `Modify: packages/core/src/runtime/controller-interview.ts:31-160` (accept an `executionPhase` and use the right context)
  * **Interfaces:**
    * Consumes: `WorkflowStage` with a `dependsOn` field (validated in Step 2). `runInterviewStages` from `controller-interview.ts`.
    * Produces:
      ```ts
      // controller-interview.ts (updated signature)
      export async function runInterviewStages(input: {
        stages: WorkflowStage[];
        run: { runId: string; runDir: string; statePath: string; eventsPath: string };
        input: RunFactoryControllerInput;
        executionCwd: string;
        goal: string;
        config: EffectiveFactoryConfig;
        plannerGuidanceText?: string;
        plannerSkills: SkillBundleSelection;
        runTaskType: TaskTypeSelection;
        discoveryOutputText?: string;
        executionPhase: "pre-planning" | "post-verification";  // NEW
        verificationContext?: {                            // NEW, post-verification only
          verificationStatus: string;
          changedFiles: string[];
          planSummary?: string;
        };
      }): Promise<{ text?: string; executionPath?: string; decisions?: InterviewDecisionRecord[]; executionPhase: "pre-planning" | "post-verification" }>;
      ```
    Derivation helper (add to `task-utils.ts` or a new `interview-scheduling.ts`):
    ```ts
    export function classifyInterviewExecutionPoint(stage: WorkflowStage, allStages: WorkflowStage[]): "pre-planning" | "post-verification" {
      const deps = stage.dependsOn ?? [];
      const verifyNames = new Set(allStages.filter((s) => s.name === "verification" || s.name === "verify").map((s) => s.name));
      if (deps.some((dep) => verifyNames.has(dep))) return "post-verification";
      return "pre-planning";
    }
    ```
    In `discovery-phase.ts`:
    ```ts
    const allInterviewStages = workflowStages.filter((stage) => stage.type === "interview");
    // Only pre-planning interviews belong in the discovery phase.
    const prePlanningInterviews = allInterviewStages.filter((stage) => classifyInterviewExecutionPoint(stage, workflowStages) === "pre-planning");
    // After the fix, the post-verification subset is NOT run here.
    ```
    `runInterviewStages` gains an `executionPhase` param; when `executionPhase === "post-verification"`, it:
    - passes a `verificationContext` into `buildInterviewPrompt` (adding the verify status + changed files into the prompt),
    - uses the post-verification `context` string in the `requestHumanDecision` call,
    - persists `executionPhase` into each `InterviewDecisionRecord`.
    `controller-interview.ts:118-136` is where the `request` `context` string is set; branch on `executionPhase`.
  * **Code:**
    ```ts
    // controller-interview.ts (inside runInterviewStages, before requestHumanDecision)
    const isPost = input.executionPhase === "post-verification";
    const interviewContext = isPost
      ? `Answer the interview questions about the verified candidate (${input.verificationContext?.verificationStatus}). Factory will include your answer in the reviewer and approval prompts; it will NOT be fed back into planning or building.`
      : "Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan.";
    // ...in the requestHumanDecision call:
    context: interviewContext,
    // ...when structuring decision:
    structuredDecisions.push({
      stage: stage.name,
      role,
      executionPhase: input.executionPhase,   // NEW
      question: output,
      optionId: decision.optionId,
      answer: decision.feedback,
      ...
    });
    ```
    `buildInterviewPrompt` (in `controller-interview.ts`) must accept the verification context as optional input and append it to the prompt text only for post-verification interviews. When present:
    ```ts
    ...(input.executionPhase === "post-verification" && input.verificationContext
      ? [
          "",
          "Verified candidate context:",
          `Verification status: ${input.verificationContext.verificationStatus}`,
          `Changed files:\n${input.verificationContext.changedFiles.join("\n")}`,
          input.verificationContext.planSummary ? `Plan summary:\n${input.verificationContext.planSummary}` : undefined,
        ] : [])
    ```
  * **Negative Paths:**
    * Workflow declares an interview with no `dependsOn` and an empty `dependsOn` → classified as `pre-planning` (default).
    * Workflow declares an interview with `dependsOn: ["verify"]` but no `verify` stage → Step 2 validation throws `unknown-depends-on` before this code runs.
    * `runInterviewStages` is called with `executionPhase: "post-verification"` but no `verificationContext` → it still runs (phases are valid) but the prompt omits the verified-candidate context; the reviewer gets the interview answers with no verify evidence attached (fail-soft, no crash).
  * **Verification:**
    * `node --test --test-name-pattern 'post-verification interview' tests/runtime.test.mjs` — PASS after this step (the regression test from Step 1 now sees `post_verify_interview` NOT run in the discovery phase; `postVerifyIndex > verificationIndex` holds because the discovery phase no longer includes it).

* [ ] **Step 4: Run post-verification interviews in the main runtime pipeline**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller-run.ts:365-394`
    * `Modify: packages/core/src/runtime/controller-interview.ts` (re-export `runInterviewStages` with the new `executionPhase` param)
  * **Interfaces:**
    * Consumes: `interviewDecisions` from the discovery phase, `verification` result (from `runVerificationPhase`), `verificationPlan`, `completedTasks` (built right after verification), `workflowStages`.
    * Produces: after `verificationPhase` returns and `completedTasks` is built, before `runFinalPhases`, the controller:
      - computes `postVerificationInterviews = workflowStages.filter(s => s.type === "interview" && classifyInterviewExecutionPoint(s, workflowStages) === "post-verification")`;
      - if any exist, calls `runInterviewStages({ stages: postVerificationInterviews, run, input, executionCwd, goal, config, plannerGuidanceText, plannerSkills, runTaskType, discoveryOutputText, executionPhase: "post-verification", verificationContext: { verificationStatus: verification.overallStatus, changedFiles: completedTasks.flatMap((t) => t.changedFiles ?? []), planSummary: plan?.summary } })`;
      - appends the returned post-verification `interviewDecisions` to the `interviewDecisions` array **before** calling `runFinalPhases` (so the reviewer sees them); and
      - persists the latest `interview-decisions.json` with the combined list.
  * **Code:**
    ```ts
    // controller-run.ts (after completedTasks built, before runFinalPhases)
    const postVerificationInterviews = workflowStages.filter(
      (stage) => stage.type === "interview"
        && classifyInterviewExecutionPoint(stage, workflowStages) === "post-verification",
    );
    let postVerificationInterviewDecisions: InterviewDecisionRecord[] = [];
    if (postVerificationInterviews.length > 0) {
      const interviewResult = await runInterviewStages({
        stages: postVerificationInterviews,
        run, input, executionCwd, goal: input.goal, config: loaded.effectiveConfig,
        plannerGuidanceText: plannerGuidance.text ?? "",
        plannerSkills, runTaskType, discoveryOutputText,
        executionPhase: "post-verification",
        verificationContext: {
          verificationStatus: verification.overallStatus,
          changedFiles: completedTasks.flatMap((t) => t.changedFiles ?? []),
          ...(plan?.summary ? { planSummary: plan.summary } : {}),
        },
      });
      postVerificationInterviewDecisions = interviewResult.decisions ?? [];
      // Merge into the decisions fed to review/approval.
      interviewDecisions = [...interviewDecisions, ...postVerificationInterviewDecisions];
    }
    // Then existing runFinalPhases call...
    const finalResult = await runFinalPhases({ run, input, ..., interviewDecisions, ... });
    ```
  * **Negative Paths:**
    * Verification failed/blocked (contract `canComplete === false`) → do NOT run post-verification interviews. Check `verification.overallStatus === "passed"` (and `contractResult.canComplete === true`) before the `if (postVerificationInterviews.length > 0)` block; on failure, skip interviews and proceed to review with only the pre-planning decisions (matching "verification failure does not trigger a post-verification interview unless recovery explicitly continues").
    * Any `runInterviewStages` throw for a post-verification stage → `controller-run.ts:395-405` catch converts to `buildPhaseFailureResult` (existing wrapper), failing loud with a phase of `run-failed` and the interview stage name in the reason. Recovery/retry is not attempted for post-verification interview failures (matches the request's guidance that interviews are best-effort evidence).
    * No post-verification interviews declared → no-op; `interviewDecisions` unchanged; behavior identical to today.
  * **Verification:**
    * `node --test --test-name-pattern 'post-verification interview' tests/runtime.test.mjs` — PASS.
    * `node --test tests/runtime.test.mjs` — PASS (no regression in existing full-run tests).

* [ ] **Step 5: Route post-verification decisions only to review/approval**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller-run.ts` (ensure planner input does NOT receive post-verification decisions)
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:52, 206` (already consumes `interviewDecisions`; verify no change strictly required, but confirm reviewer prompt path)
  * **Interfaces:**
    * Consumes: the merged `interviewDecisions` from Step 4. `buildReviewerPrompt` (controller-final-phases.ts:206) reads `interviewDecisions`. `buildPlannerPrompt` from `controller-interview.ts` reads `interviewContext` (text) not the structured decisions.
    * Produces: post-verification answers appear in the **reviewer** prompt (via `interviewDecisions`) but never in the **planner** prompt (which consumes `interviewContext` captured before planning).
  * **Code (verification of isolation only, no new logic in final-phases):**
    ```ts
    // controller-run.ts: keep `interviewContext` as the pre-planning text captured by discovery-phase.
    // The planner prompt is built from THIS text (controller-interview.ts buildPlannerPrompt(interviewContext, ...)).
    // The post-verification decisions are appended to `interviewDecisions` AFTER planning, so the planner
    // never sees them. No change to controller-final-phases.ts is required.
    ```
    Add one `run.recovery_skipped`-style event when `postVerificationInterviewDecisions.length > 0` is merged, so inspection (`show.ts`/logs) surfaces when post-verify answers were captured:
    ```ts
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "interview.post_verification_completed",
      data: { stageCount: postVerificationInterviews.length, decisionCount: postVerificationInterviewDecisions.length },
    });
    ```
  * **Negative Paths:**
    * A single `interviewDecisions` variable mutated after planning is fine because the planner already ran. Guard against double-execution: `postVerificationInterviews` are only run once (Step 4's `if` is a one-shot branch).
    * If a post-verification interview returns `INTERVIEW_COMPLETE` (empty question), `runInterviewStages` skips it (`continue`), runs no `requestHumanDecision`, and no decision is appended — the reviewer sees no extra evidence; that is correct.
  * **Verification:**
    * `node --test tests/runtime.test.mjs` — PASS (existing tests that assert `buildPlannerPrompt` contains `interviewContext` still pass because that text is unchanged).

* [ ] **Step 6: Persist executionPhase into interview decisions**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts` — `InterviewDecisionRecord` type
    * `Modify: packages/adapters/pi/src/interview-dialog.ts:9-10, 380-400`
    * `Modify: packages/core/src/decisions/types.ts` (add `executionPhase?` to `InterviewQuestionDecision` if needed for UI persistence)
  * **Interfaces:**
    * Consumes: `InterviewDecisionRecord` from `controller.ts`. `formatInterviewAnswers` from `interview-dialog.ts`.
    * Produces: `InterviewDecisionRecord` adds optional `executionPhase?: "pre-planning" | "post-verification"`. `formatInterviewAnswers` includes `Execution: <phase>` in the per-question summary. Existing records without the field default to `"pre-planning"` when read (a `readInterviewDecisions` in `show.ts` treats a missing field as `undefined` and the UI shows no phase label).
  * **Code:**
    ```ts
    // controller.ts
    export interface InterviewDecisionRecord {
      stage: string;
      role?: string;
      executionPhase?: "pre-planning" | "post-verification";
      question: string;
      optionId: string;
      answer?: string;
      skipped?: boolean;
      questions?: Array<{ skipped?: boolean; finalAnswer: string }>;
      decisionRequestId: string;
    }
    ```
    ```ts
    // interview-dialog.ts formatInterviewAnswers (add phase line)
    `Execution phase: ${question.executionPhase ?? 'pre-planning'}`,
    ```
  * **Negative Paths:**
    * Reading artifacts written before this change: the field is absent, `?? 'pre-planning'` keeps behavior stable.
    * An interview whose `executionPhase` is missing from the orchestrator call is rejected by the type system (the `runInterviewStages` call sites always pass it).
  * **Verification:**
    * `npm run typecheck` — PASS.
    * `node --test tests/pi-adapter.test.mjs` — PASS (existing interview dialog tests unaffected; one new assertion that `formatInterviewAnswers` includes `pre-planning` for legacy records).

* [ ] **Step 7: Update docs and skills**

  * **Files:**
    * `Modify: docs/factory/workflow-authoring.md:79-90`
    * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140`
    * `Modify: skills/factory-concierge/SKILL.md:120-140`
    * `Modify: learnings.md`
  * **Interfaces:** No code changes.
  * **Code (documentation text):**
    ```yaml
    # docs/factory/workflow-authoring.md (new section)
    ## Interviews at arbitrary DAG points

    An `interview` stage may execute at any point in the workflow DAG. Factory schedules each
    interview by its `dependsOn` edges:
    - A pre-planning interview (empty `dependsOn`, or one referencing only discovery/planning)
      runs before the planner sees the goal. Its answers are folded into the planner prompt.
    - A post-verification interview (`dependsOn: [verify, verification]`) runs after verification
      passes and before review. Its answers go to the reviewer and approval prompts only, never
      back into planning or building.

    ```yaml
    - name: post_verify_interview
      type: interview
      role: planner
      dependsOn: [verify]
      skills:
        require: [grilling]
    ```

    Note: `role: planner` on an interview selects the *model routing role* (which model runs the
    interview executor). It does NOT mean the interview must execute before planning. Execution
    ordering is governed by `dependsOn`, not by `role`.

    Factory validates the workflow DAG at load: unknown `dependsOn` names, dependency cycles,
    stages unreachable from any root, and an `acceptance`/`approval` stage that does not
    (transitively) depend on a `reviewer` stage are rejected with a clear error.
    ```
  * **Negative Paths:**
    * Documentation must state the `role` semantics clearly and honestly; it must not claim every interview is pre-planning.
  * **Verification:**
    * `grep -n "post_verify_interview\|arbitrary DAG\|Execution ordering is governed by dependsOn" docs/factory/workflow-authoring.md .pi/skills/factory-concierge/SKILL.md skills/factory-concierge/SKILL.md learnings.md` returns at least one hit in each.

* [ ] **Step 8: Full verification**

  * **Files:** none — runs existing suites.
  * **Interfaces/Code:** none.
  * **Negative Paths:** ensure the built-in default workflow passes the new validation (it does: `acceptance.dependsOn: ["review"]`, `review` is `role: "reviewer"`).
  * **Verification:**
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.
    * `npm run complexity` — PASS.
    * `node --test tests/workflow-registry.test.mjs` — PASS.
    * `node --test tests/runtime.test.mjs` — PASS.
    * `node --test tests/pi-adapter.test.mjs` — PASS.
    * `node --test tests/interview-dialog-phase-2.test.mjs` (if present) — PASS.
    * `npm test` — PASS (full suite).
    * From the `task-board` repo: rebuild/reload the `pi-factory` package and rerun the persistence task to confirm the post-verify interview now runs after Verify and before Review.

## 4. Testing

* **Regression first:** `tests/runtime.test.mjs` Step 1 test `post-verification interview runs after Verify and before Review, not before planning` — FAILS before the fix, PASSES after.
* **Workflow DAG validation:** `tests/workflow-registry.test.mjs` — 5 tests (valid default; unknown-depends-on; cycle; unreachable-stage; approval-without-review).
* **Runtime edge cases** (each a separate `test` in `tests/runtime.test.mjs`):
  1. `post-verification interview pauses correctly for a human decision` — the step returns `DECISION_REQUIRED` with `phase: decision-interview`; a mock `requestDecision` resolves it; the run then continues to review.
  2. `resume continues to review after a post-verification interview` — after a decision is resolved, `runFinalPhases` receives the merged `interviewDecisions` and the reviewer prompt has 2 entries (pre + post).
  3. `multiple post-verification interviews run in dependency order` — two interviews A then B where B `dependsOn: [A, verification]`; assert A executes before B.
  4. `an interview returning INTERVIEW_COMPLETE does not pause` — the post-verify interview emits `INTERVIEW_COMPLETE`; no `requestDecision` call happens; the run reaches review.
  5. `verification failure does not trigger a post-verification interview` — set verification `overallStatus: "failed"`, `contractResult.canComplete: false`; assert no `runInterviewStages` call for post-verify stages (assert events lack `interview.executor_completed` for the post-verify stage).
  6. `post-verification answers are available to review only, not planning` — assert `buildPlannerPrompt` output lacks the post-verify answer; assert the reviewer prompt (via `buildReviewerPrompt`) includes it.
- **Full-suite:** `npm test` — PASS (all packages: core build, complexity guard, runtime, pi-adapter, landing, headless, registry).

## 5. Definition of Done

* [ ] Required behavior works: pre-planning interviews run before planning; post-verification interviews run after Verify and before Review; each interview executes exactly once at its correct DAG point.
* [ ] Negative paths behave correctly:
  * unknown `dependsOn` → workflow load fails loud with `unknown-depends-on`;
  * cycle → `cycle`;
  * unreachable interview → `unreachable-stage`;
  * `acceptance`/`approval` without a reviewer dependency → `approval-without-review`;
  * verification failure → no post-verification interview;
  * `INTERVIEW_COMPLETE` → no pause;
  * legacy `interview-decisions.json` without `executionPhase` → default to `"pre-planning"`, no crash.
* [ ] Tests pass (`npm test`).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Lint passes (`npm run lint` — if the repo's lint script exists; otherwise the complexity guard is the static gate per `package.json` — verified `"complexity": "node scripts/complexity-guard.mjs"`).
* [ ] Build passes (`npm run build`).
* [ ] Migrations/config changes are validated: no DB migration. `WorkflowStage` config unchanged (execution point derived from `dependsOn`). `InterviewDecisionRecord` gains one optional field, backward-compatible. New `validateWorkflowDependencies` is additive but enforced at config load, so pre-existing malformed workflows will now fail loudly at load — verified the built-in default and all existing tests use valid DAGs.