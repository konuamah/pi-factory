# Active-Path Interview DAG Scheduling

## 1. Understanding & Scope

* **Core Goal:**
  Make `type: interview` obey `dependsOn` in the active Factory runtime. The active controller currently treats every interview stage as a pre-planning bucket, ignoring `dependsOn`. After this change, interview stages are first-class workflow nodes placed entirely by `dependsOn`: a kickoff interview (`dependsOn: []`) runs before discovery; a pre-plan interview runs between discovery and planning; a post-verify interview runs between verification and review. No code path branches on "pre-planning" or "post-verification" interview placement.

* **Current Behavior:** (with file:line evidence)
  * `packages/core/src/runtime/controller.ts:393` computes `const interviewStages = workflowStages.filter((stage) => stage.type === "interview");` — collects **all** interview stages, ignoring `dependsOn`.
  * `packages/core/src/runtime/controller.ts:669` invokes `runInterviewStages({ stages: interviewStages, ... })` unconditionally before planning.
  * `packages/core/src/runtime/controller.ts:3881` hardcodes the phase label `Interviewing before planning: ${stage.name}` inside the active `runInterviewStages`.
  * `packages/core/src/runtime/controller.ts:3943` hardcodes the decision request `context` to `"Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan."`
  * `packages/core/src/runtime/controller.ts:704` is the only consumer of the resulting `interviewContext` (passed into `buildPlannerPrompt`); the review/approval phases at `controller.ts:1618` and `controller.ts:1702` do not consume it.
  * `packages/core/src/runtime/controller.ts` movePhase calls at 379/682/798/890/984/1063/1553/1618/1702/1783 are the hardcoded phase sequence; no per-stage completion is recorded.
  * `packages/core/src/runtime/controller.ts:3851` local `runInterviewStages` does not persist a per-stage completion record and does not consult one on resume.
  * `docs/factory/workflow-authoring.md:73-82`, `skills/factory-concierge/SKILL.md`, `.pi/skills/factory-concierge/SKILL.md`, and `learnings.md:17` already describe post-verify interview behavior that the active code does not implement.

* **Target Behavior:**
  * Interview placement is governed only by `dependsOn`. Validators (`validateWorkflowDependencies` in `packages/core/src/workflows/registry.ts:22`) already reject unknown deps, cycles, unreachable stages, and approval-without-review; the runtime finally respects them.
  * A readiness helper, `runReadyInterviewStages(completed)`, runs any `type: interview` stage whose `dependsOn` references only stage names that are in the `completed` set. Called at the boundaries: before discovery (kickoff), and after discovery/planning/implementation/verification/review.
  * The hardcoded "before planning" phase label and decision context string are removed. The phase label uses `stage.name`; the decision context says "Factory will include your answer in the prompts for stages that depend on this interview".
  * Context flow remains a single accumulated `interviewContext` for this slice. Each prompt that consumes it (planner at `controller.ts:704`; reviewer at `controller.ts:1618`) snapshots it at construction time so a later interview does not retroactively alter an earlier prompt. Tests pin this snapshot property.
  * `InterviewDecisionRecord` records gain an optional `dependsOn: string[]` field for audit; existing records remain readable. The existing `executionPhase` field remains optional for legacy artifacts, but the active path stops using it for scheduling.

* **Files Affected:**
  * `Modify: packages/core/src/runtime/controller.ts:393` (interview filter)
  * `Modify: packages/core/src/runtime/controller.ts:669` (first interview call site)
  * `Modify: packages/core/src/runtime/controller.ts:3851-3985` (active `runInterviewStages` signature + body)
  * `Modify: packages/core/src/runtime/controller.ts:3985-4015` (active `buildInterviewPrompt` tail line)
  * `Modify: packages/core/src/runtime/controller.ts:704` (planner prompt snapshot)
  * `Modify: packages/core/src/runtime/controller.ts:1618-1700` (review prompt snapshot)
  * `Modify: packages/core/src/runtime/controller.ts:81` (InterviewDecisionRecord gains `dependsOn`)
    * `Modify: packages/core/src/runtime/controller.ts:379` (kickoff boundary before discovery movePhase, after workflow/skill/task-type setup)
    * `Modify: packages/core/src/runtime/controller.ts:682, 798, 890, 984, 1063, 1553, 1618, 1702` (boundary insertions between completed phases and the next phase start)
  * `Modify: packages/core/src/runtime/controller.ts` (new `runReadyInterviewStages` helper added near the local `runInterviewStages`)
  * `Test: tests/runtime.test.mjs` (six new tests + one updated existing test)
  * `Modify: docs/factory/workflow-authoring.md:60-90`
  * `Modify: skills/factory-concierge/SKILL.md` and `.pi/skills/factory-concierge/SKILL.md`
  * `Modify: learnings.md:17`

* **Out of Scope:**
  * Dead modules: `packages/core/src/runtime/controller-run.ts`, `controller-interview.ts`, `task-utils.ts`, `discovery-phase.ts`, `controller-helpers.ts`, `controller-final-phases.ts`, `controller-setup.ts`, `controller-integration.ts`, `plan-approval-phase.ts`, `implementation-phase.ts`, `verification-phase2.ts`, `planning-phase2.ts`, `controller-helpers.ts` retain their existing `classifyInterviewExecutionPoint` and related logic. Nothing imports these modules; they are kept untouched. A future cleanup plan will delete them; that plan is not this plan.
  * The existing `InterviewDecisionRecord.executionPhase` field is not used for new scheduling behavior. Removing the field is out of scope (would risk breaking legacy artifacts); just stop deriving placement from it or from pre/post bucket concepts.
  * Building a generalized DAG scheduler (node state map, executor registry, `NodeStatus`/`ArtifactRef`/`NodeResult` types) — that is the next plan. This plan only repairs the live runtime.
  * Persisting a per-stage completion set in `FactoryRunState`. This plan uses the existing `interview-decisions.json` artifact as the per-interview completion source; if resume is required mid-interview, the existing decision-ledger resume continues to work (the run is `DECISION_REQUIRED`, not RUNNING).
  * Changing the Pi adapter UI (`packages/adapters/pi/src/interview-dialog.ts`, `decision-dialog.ts`). The interview rendering already reads structured interview decisions from the ledger; no UI change is needed.
  * The "interview depends on a verification-stage-named task" subtlety. Today `verify`/`verification` are controller-handled stages; they appear in `resolvedWorkflow.stages` with names matching the user-facing DAG nodes. The readiness helper relies on `dependsOn` strings matching `stage.name`, exactly as users write them, and on the validator already enforcing reachability.

## 2. Assumptions & Blockers

* **Assumptions:**
  * The active runtime is `controller.ts`. No source file imports `controller-run.ts` (verified by `rg -n "controller-run" packages tests` returning only self-references). Any patch in dead modules is invisible to users; this plan does not touch them.
  * `validateWorkflowDependencies` already rejects every malformed DAG shape this plan assumes (unknown deps, cycles, unreachable stages, approval-without-review). No additional DAG validation is added.
  * `runRuntimeHarness` (used by `tests/runtime.test.mjs`) calls `runFactoryController`, which calls the active `runFactoryControllerInner` in `controller.ts`. All new tests can rely on the existing fixture pattern at `tests/runtime.test.mjs:371`.
  * Stage names match across `dependsOn` and `stage.name`. `validateWorkflowDependencies` does not enforce this; the active reviewer prompt and `buildReviewerPrompt` use `verification` and `review` interchangeably. To stay consistent with user-facing workflows, the readiness helper normalizes `dependsOn` strings to lower-case only when matching against a fixed allowlist (`verify`, `verification`, `build`, `implementation`, `discover`, `discovery`, `plan`, `planning`, `review`, `approval`, `acceptance`, `landing`, `interview`) and otherwise matches `stage.name` exactly.
  * Interview decisions are recorded in the existing `interview-decisions.json` artifact. The active `runInterviewStages` does not write that artifact today; this plan makes the active path append to it and uses it as the single completion source. Legacy readers (`runs/show.ts`, `runs/inspect.ts`) tolerate its absence (no schema migration needed).
  * Persisted run state does not need a new field for completed-stages. Per-interview completion is derived from `interview-decisions.json`; per-built-in-stage completion is implicit because the active phase machine is linear. Resume re-enters `runFactoryControllerInner` from the top and re-runs phases; the readiness helper skips interview stages already present in `interview-decisions.json`, so no answered interview re-asks the user. This matches the user's instruction "completed nodes are not rerun after resume" for the interview slice.

* **Questions / Blockers:**
  * **None blocking.** The plan is implementable with current schemas and APIs.

## 3. Implementation Plan

* [ ] **Step 1: Add active-path interview decision artifact helpers**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts` (add local helpers near the existing `runInterviewStages`)

  * **Interfaces:**
    * Consumes: existing `InterviewDecisionRecord`.
    * Produces:
      ```ts
      async function readInterviewDecisionRecords(runDir: string): Promise<InterviewDecisionRecord[]> {
        try {
          const raw = await fs.readFile(path.join(runDir, "interview-decisions.json"), "utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((entry): entry is InterviewDecisionRecord =>
            typeof entry === "object" && entry !== null && typeof (entry as InterviewDecisionRecord).stage === "string",
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          return [];
        }
      }

      async function appendInterviewDecisionRecord(runDir: string, record: InterviewDecisionRecord): Promise<string> {
        const records = await readInterviewDecisionRecords(runDir);
        records.push(record);
        const artifactPath = path.join(runDir, "interview-decisions.json");
        await fs.writeFile(artifactPath, JSON.stringify(records, null, 2), "utf8");
        return artifactPath;
      }
      ```

  * **Negative Paths:**
    * Missing file → empty list, no throw.
    * Malformed JSON → empty list, no throw (resume-safe; legacy or truncated artifacts do not poison the run). The current run can still write a fresh valid array after the first answered interview.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'interview'` — PASS after Step 6 adds the corresponding tests; the helper is exercised transitively from Step 3 onward.

* [ ] **Step 2: Update `InterviewDecisionRecord` to record `dependsOn`**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:81-95`

  * **Interfaces:**
    * Consumes: existing `InterviewDecisionRecord`.
    * Produces (replace the existing interface in-place):
      ```ts
      export interface InterviewDecisionRecord {
        stage: string;
        role?: string;
        executionPhase?: "pre-planning" | "post-verification";
        dependsOn?: string[];
        question: string;
        optionId: string;
        answer?: string;
        skipped?: boolean;
        questions?: InterviewQuestionDecision[];
        decisionRequestId: string;
      }
      ```
      The `executionPhase?: "pre-planning" | "post-verification"` field stays optional for legacy records. The `dependsOn?: string[]` field is **added** for audit and future DAG-state inspection.

  * **Negative Paths:**
    * Reading legacy `interview-decisions.json` files without `dependsOn` is allowed because the field is optional.
    * Existing records with `executionPhase` remain readable, but no live code path uses it for placement.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/decision.test.mjs` — PASS (existing decision tests do not touch this field).

* [ ] **Step 3: Replace the broken interview filter with `runReadyInterviewStages`**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:393` (current `const interviewStages = workflowStages.filter(...)`)
    * `Modify: packages/core/src/runtime/controller.ts:3851-3985` (active `runInterviewStages` body)
    * `Modify: packages/core/src/runtime/controller.ts:3881` (phase label) and `:3943` (decision request context)
    * `Modify: packages/core/src/runtime/controller.ts:3985-4015` (active `buildInterviewPrompt` tail line)
    * `Modify: packages/core/src/runtime/controller.ts` (add new local helper `runReadyInterviewStages` above the existing `runInterviewStages`)

  * **Interfaces:**
    * Consumes:
      * `WorkflowStage` from `@factory/schemas`.
      * `appendInterviewDecisionRecord`, `readInterviewDecisionRecords` from Step 1.
      * `runOneInterviewStage` (extracted from the current `runInterviewStages` loop) for single-stage execution.
      * `applyWorkflowSkillPolicy`, `executorForRole`, `appendFactoryRunEvent`, `appendModelLedgerEntry`, `resolveModelForRole`, `slugifyGoal`, `movePhase`, `requestHumanDecision`, `renderSkillBundleForPrompt`, `buildInterviewPrompt` — all already imported in `controller.ts`.
    * Produces (new helper, added to `controller.ts` immediately above the existing local `runInterviewStages` at line 3851):
      ```ts
      type CompletedBoundary = "discover" | "plan" | "plan_approval" | "build" | "verify" | "review" | "approval" | "landing" | "acceptance";

      async function runReadyInterviewStages(input: {
        stages: WorkflowStage[];
        completed: ReadonlySet<string>;
        run: { runId: string; runDir: string; statePath: string; eventsPath: string };
        controllerInput: RunFactoryControllerInput;
        executionCwd: string;
        goal: string;
        config: EffectiveFactoryConfig;
        plannerGuidanceText?: string;
        plannerSkills: SkillBundleSelection;
        runTaskType: TaskTypeSelection;
        discoveryOutputText?: string;
        interviewContext: string;
      }): Promise<{ updatedContext: string; ranStageNames: string[] }> {
        const completed = input.completed;
        const alreadyAnswered = await readInterviewDecisionRecords(input.run.runDir);
        const answered = new Set(alreadyAnswered.map((record) => record.stage));
        const answers: string[] = [];
        const ranStageNames: string[] = [];
        for (const stage of input.stages) {
          if (stage.type !== "interview") continue;
          if (answered.has(stage.name)) continue;
          const deps = stage.dependsOn ?? [];
          const depsMet = deps.every((dep) => completed.has(dep) || answered.has(dep));
          if (!depsMet) continue;
          const result = await runOneInterviewStage({
            stage,
            run: input.run,
            input: input.controllerInput,
            executionCwd: input.executionCwd,
            goal: input.goal,
            config: input.config,
            plannerGuidanceText: input.plannerGuidanceText,
            plannerSkills: input.plannerSkills,
            runTaskType: input.runTaskType,
            discoveryOutputText: input.discoveryOutputText,
          });
          await appendInterviewDecisionRecord(input.run.runDir, result.record);
          if (result.record.skipped) {
            answers.push(`Stage: ${stage.name}\nInterview output: [INTERVIEW_COMPLETE]\nUser answer: [skipped]`);
          } else {
            answers.push(`Stage: ${stage.name}\nInterview output:\n${result.record.question}\nUser answer:\n${result.record.answer ?? "[skipped]"}`);
          }
          ranStageNames.push(stage.name);
        }
        const newAnswers = answers.join("\n\n");
        const updatedContext = !newAnswers
          ? input.interviewContext
          : input.interviewContext
            ? input.interviewContext + "\n\n" + newAnswers
            : newAnswers;
        return { updatedContext, ranStageNames };
      }
      ```
      Replace the broken line at `controller.ts:393`:
      ```ts
      // REMOVE: const interviewStages = workflowStages.filter((stage) => stage.type === "interview");
      // REPLACE WITH: nothing — the readiness helper drives interview execution from this point on.
      ```
      Replace the existing local `runInterviewStages` loop (currently lines 3851-3965) with a single-stage helper:
      ```ts
      async function runOneInterviewStage(input: {
        stage: WorkflowStage;
        run: { runId: string; runDir: string; statePath: string; eventsPath: string };
        input: RunFactoryControllerInput;
        executionCwd: string;
        goal: string;
        config: EffectiveFactoryConfig;
        plannerGuidanceText?: string;
        plannerSkills: SkillBundleSelection;
        runTaskType: TaskTypeSelection;
        discoveryOutputText?: string;
      }): Promise<{ record: InterviewDecisionRecord }> {
          const stage = input.stage;
          const role = input.stage.role ?? "planner";
          const executor = executorForRole(input.input, role);
          if (!executor) {
            throw new Error(`Interview stage '${stage.name}' requires a ${role} executor, but none is configured.`);
          }
          const skillPolicy = applyWorkflowSkillPolicy(input.plannerSkills, stage.skills);
          if (!skillPolicy.ok) {
            await failBuiltInSkillPolicy({
              run: input.run,
              input: input.input,
              phase: "interview-failed",
              stage: stage.name,
              missingRequired: skillPolicy.missingRequired,
            });
            throw new Error(`Interview failed: Missing required workflow skill(s): ${skillPolicy.missingRequired.join(", ")}`);
          }
          await movePhase(input.run.statePath, input.run.eventsPath, input.run.runId, input.input, "interview", `Interviewing: ${stage.name}`);
          const model = resolveModelForRole({
            role,
            taskType: input.runTaskType.id,
            config: input.config,
            nodeModel: stage.model,
            runModelOverride: input.input.modelOverrides?.[role],
          });
          await appendModelLedgerEntry(input.run.runDir, {
            operationId: `${input.run.runId}-${role}-${stage.name}`,
            nodeId: stage.name,
            role,
            taskType: input.runTaskType.id,
            taskTypeSource: input.runTaskType.source,
            taskTypeConfidence: input.runTaskType.confidence,
            requestedModel: model.model.model,
            resolvedModel: model.model.model,
            provider: model.model.provider,
            modelSource: model.source,
          });
          const result = await executor.execute({
            executionId: `${input.run.runId}-${role}-${slugifyGoal(stage.name)}`,
            cwd: input.executionCwd,
            prompt: buildInterviewPrompt({
              goal: input.goal,
              stage,
              guidanceText: input.plannerGuidanceText,
              skillBundleText: renderSkillBundleForPrompt(skillPolicy.bundle),
              discoveryReport: input.discoveryOutputText,
            }),
            model: model.model,
            tools: ["read", "grep", "find", "ls"],
            metadata: {
              role,
              runId: input.run.runId,
              taskType: input.runTaskType.id,
              stage: stage.name,
            },
          });
          const artifactPath = path.join(input.run.runDir, `${slugifyGoal(stage.name)}-interview-execution.json`);
          await fs.writeFile(artifactPath, JSON.stringify(result, null, 2), "utf8");
          await appendFactoryRunEvent(input.run.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "interview.executor_completed",
            data: {
              stage: stage.name,
              role,
              interviewExecutionPath: artifactPath,
              interviewStatus: result.status,
            },
          });
          const output = result.outputText.trim();
          if (!output || output === "INTERVIEW_COMPLETE") {
            return {
              record: {
                stage: stage.name,
                role,
                dependsOn: stage.dependsOn ?? [],
                question: "INTERVIEW_COMPLETE",
                optionId: "answered",
                skipped: true,
                decisionRequestId: `${input.run.runId}-${slugifyGoal(stage.name)}-interview`,
              },
            };
          }
          const decision = await requestHumanDecision({
            controllerInput: input.input,
            runDir: input.run.runDir,
            statePath: input.run.statePath,
            eventsPath: input.run.eventsPath,
            runId: input.run.runId,
            request: {
              id: `${input.run.runId}-${slugifyGoal(stage.name)}-interview`,
              title: `Interview: ${stage.name}`,
              question: output,
              context: `Interview stage '${stage.name}' completed. Factory will include your answer in the prompts for stages that depend on this interview.`,
              options: [{ id: "answered", label: "Use my answer", description: "Continue with the feedback/answer provided." }],
              source: "INTERVIEW",
              reason: "USER_PREFERENCE",
            },
          });
          answers.push([
            `Stage: ${stage.name}`,
            `Interview output:\n${output}`,
            `Selected option: ${decision.optionId}`,
            decision.feedback ? `User answer:\n${decision.feedback}` : "User answer:\n[skipped]",
          ].filter(Boolean).join("\n"));
          return {
            record: {
              stage: stage.name,
              role,
              dependsOn: stage.dependsOn ?? [],
              question: output,
              optionId: decision.optionId,
              answer: decision.feedback,
              skipped: !decision.feedback?.trim(),
              ...(decision.interviewQuestions?.length ? { questions: decision.interviewQuestions } : {}),
              decisionRequestId: decision.requestId,
            },
          };
      }
      ```
      Update `buildInterviewPrompt` (currently lines 3985-4015) tail line:
      ```ts
      // REPLACE: "The user answer will be recorded and passed into the planner."
      // WITH:    `The user answer will be recorded and passed into the prompts for stages that depend on stage '${input.stage.name}'.`,
      ```
      No string-or-object return union is needed. The old `controller.ts:669` call is removed in Step 4, and the readiness helper owns context accumulation.

  * **Negative Paths:**
    * Missing executor for the interview's role → throw (existing behavior).
    * Missing required workflow skill → `Interview failed: Missing required workflow skill(s): ...` thrown, run aborts (existing behavior).
    * `INTERVIEW_COMPLETE` from the model → no decision gate, marked completed, run continues.
    * Decision handler not configured → `requestHumanDecision` throws `Decision required ... but no requestDecision handler is configured` (existing behavior).
    * Resume after `DECISION_REQUIRED` → `findPendingDecision` finds the persisted request, run continues; `runReadyInterviewStages` later skips the stage once its `InterviewDecisionRecord` has been written.
    * `interviewContext` snapshot property: each call site that uses `interviewContext` to build a prompt must copy it into a local before any further interview runs. Step 5 enforces this at the planner prompt and the reviewer prompt.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'interview' --test-name-pattern 'planner prompt' --test-name-pattern 'dependsOn' --test-name-pattern 'rename'` — PASS after Steps 5–6 add the relevant tests; existing tests at `runtime.test.mjs:371` and `:442` continue to pass against the new code path.

* [ ] **Step 4: Insert boundary readiness calls and remove the broken filter**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:379-511` (move workflow/skill/task-type setup before discovery, then insert kickoff call before the discovery movePhase)
    * `Modify: packages/core/src/runtime/controller.ts:665-705` (replace existing `interviewContext = await runInterviewStages(...)` and its surrounding context)
    * `Modify: packages/core/src/runtime/controller.ts:683, 798, 890, 984, 1063, 1553, 1618, 1702` (insert readiness calls after each named movePhase)
    * `Modify: packages/core/src/runtime/controller.ts:3881` (the phase label was changed in Step 3)

  * **Interfaces:**
    * Consumes: `runReadyInterviewStages` from Step 3; `workflowStages` (already defined at `controller.ts:390`); `interviewContext` accumulator (currently a `let` at `controller.ts:60`).
    * Produces (concrete patches, each with the exact line range):

      Patch A — pre-discovery kickoff (run after `workflowStages`, `plannerSkills`, and `runTaskType` are initialized, but before `await movePhase(..., "discovery", ...)`):
      ```ts
      // Kickoff interviews: dependsOn [].
      {
        const boundary = await runReadyInterviewStages({
          stages: workflowStages,
          completed: new Set<string>(),
          run,
          controllerInput: input,
          executionCwd,
          goal: input.goal,
          config: loaded.effectiveConfig,
          plannerGuidanceText: undefined,
          plannerSkills,
          runTaskType,
          discoveryOutputText: undefined,
          interviewContext: interviewContext ?? "",
        });
        interviewContext = boundary.updatedContext;
        if (boundary.ranStageNames.length > 0) {
          await appendFactoryRunEvent(run.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "interview.boundary_completed",
            data: { boundary: "kickoff", stageNames: boundary.ranStageNames },
          });
        }
      }

      await movePhase(run.statePath, run.eventsPath, run.runId, input, "discovery", "Discovering relevant system context");
      ```

      Patch B — replace the broken interview call at `controller.ts:669`:
      ```ts
      // REMOVE (controller.ts:669-682):
      //   const interviewContext = await runInterviewStages({
      //     stages: interviewStages,
      //     ...
      //     discoveryOutputText,
      //   });
      //   const interviewExecutionPath = interviewResult.executionPath;
      //   const interviewDecisions = interviewResult.decisions ?? [];
      //
      // REPLACE WITH (no separate pre-planning call here; the post-discovery boundary below
      //   will run any interview whose deps are now satisfied).
      ```

      Patch C — post-discovery boundary (insert after discovery validation/artifact events complete, but before `await movePhase(..., "planning", ...)`):
      ```ts
      {
        const completed = new Set(["discover"]);
        const boundary = await runReadyInterviewStages({
          stages: workflowStages,
          completed,
          run,
          controllerInput: input,
          executionCwd,
          goal: input.goal,
          config: loaded.effectiveConfig,
          plannerGuidanceText: plannerGuidance.text,
          plannerSkills,
          runTaskType,
          discoveryOutputText,
          interviewContext: interviewContext ?? "",
        });
        interviewContext = boundary.updatedContext;
        if (boundary.ranStageNames.length > 0) {
          await appendFactoryRunEvent(run.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "interview.boundary_completed",
            data: { boundary: "post-discovery", stageNames: boundary.ranStageNames },
          });
        }
      }
      ```
      Then start planning and construct the planner prompt, so it sees the post-discovery `interviewContext`.

      Patch D — post-planning boundary (insert after the planner output is validated and `plan.json` is written, but before `await movePhase(..., "plan-approval", ...)`):
      ```ts
      {
        const completed = new Set(["discover", "discovery", "plan", "planning"]);
        const boundary = await runReadyInterviewStages({
          stages: workflowStages, completed, run, controllerInput: input, executionCwd,
          goal: input.goal, config: loaded.effectiveConfig,
          plannerGuidanceText: plannerGuidance.text, plannerSkills, runTaskType,
          discoveryOutputText, interviewContext: interviewContext ?? "",
        });
        interviewContext = boundary.updatedContext;
        if (boundary.ranStageNames.length > 0) {
          await appendFactoryRunEvent(run.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "interview.boundary_completed",
            data: { boundary: "post-planning", stageNames: boundary.ranStageNames },
          });
        }
      }
      ```

      Patch E — post-implementation boundary (insert after implementation/integration complete, before verification begins):
      ```ts
      {
        const completed = new Set(["discover", "discovery", "plan", "planning", "plan_approval", "build", "implementation", "integration"]);
        const boundary = await runReadyInterviewStages({ /* ... */ });
        interviewContext = boundary.updatedContext;
      }
      ```

      Patch F — post-verification boundary (insert after `controller.ts:1553` `await movePhase(..., "verified", ...);`, before review begins):
      ```ts
      {
        const completed = new Set(["discover", "discovery", "plan", "planning", "plan_approval", "build", "implementation", "integration", "verify", "verification", "verified"]);
        const boundary = await runReadyInterviewStages({ /* ... */ });
        interviewContext = boundary.updatedContext;
      }
      ```

      Patch G — post-review boundary (insert after reviewer completion, before `await movePhase(..., "approval-ready", ...)`):
      ```ts
      {
        const completed = new Set(["discover", "discovery", "plan", "planning", "plan_approval", "build", "implementation", "integration", "verify", "verification", "verified", "review"]);
        const boundary = await runReadyInterviewStages({ /* ... */ });
        interviewContext = boundary.updatedContext;
      }
      ```

      The concrete `{ /* ... */ }` blocks in Patches E/F/G are identical to Patch D's body except for the `completed` set and the event `boundary` label.

  * **Negative Paths:**
    * No interview stages match → `ranStageNames` is empty, `interviewContext` unchanged, no event emitted.
    * A boundary pauses mid-loop (decision required) → `requestHumanDecision` throws after recording the decision request and run state. Resume re-enters at the top; stages already written to `interview-decisions.json` are skipped, and the pending stage completes when its recorded decision is resolved.
    * An interview's `dependsOn` includes an unknown name → `validateWorkflowDependencies` already rejected the workflow at config load. The readiness helper does not need to defend again.
    * Boundary insertion fails (e.g. `movePhase` throws) → the existing `try/catch` at `controller.ts:455` (the outer catch) converts to `buildPhaseFailureResult`. No new error path.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'interview' --test-name-pattern 'planner prompt' --test-name-pattern 'dependsOn' --test-name-pattern 'rename'` — PASS after Steps 5–6 add the relevant tests.

* [ ] **Step 5: Snapshot `interviewContext` at planner and reviewer prompt construction**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:704` (planner prompt)
    * `Modify: packages/core/src/runtime/controller.ts:1618-1700` (reviewer prompt)

  * **Interfaces:**
    * Consumes: `interviewContext` accumulator.
    * Produces:
      ```ts
      // controller.ts:704 — capture before building the prompt
      const plannerInterviewSnapshot = interviewContext ?? "";
      const plannerResult = await input.plannerExecutor.execute({
        executionId: `${run.runId}-planner`,
        cwd: executionCwd,
        prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig, plannerGuidance.text, renderSkillBundleForPrompt(plannerSkills), discoveryOutputText, plannerInterviewSnapshot),
        ...
      });
      ```
      ```ts
      // controller.ts:1618 — capture before building the reviewer prompt
      const reviewerInterviewSnapshot = interviewContext ?? "";
      const reviewHandoff = buildPhaseHandoff({
        goal: input.goal,
        changedFiles: implementationChangedFiles,
        builderNotes: await readBuilderNotes(builderExecutionPaths),
      });
      const reviewerResult = await input.reviewerExecutor.execute({
        executionId: `${run.runId}-reviewer`,
        cwd: executionCwd,
        prompt: buildReviewerPrompt(
          input.goal,
          verification,
          reviewerGuidance.text,
          renderSkillBundleForPrompt(reviewerSkills),
          [reviewHandoff, reviewerInterviewSnapshot ? `Human interview decisions:\n${reviewerInterviewSnapshot}` : undefined].filter(Boolean).join("\n\n"),
        ),
        ...
      });
      ```
      The active monolith uses its local `buildReviewerPrompt` in `controller.ts`, where the fifth parameter is the phase handoff text. Keep the change in that active path by appending interview context to the handoff string; do not rely on the extracted `prompts.ts` helper for this slice.

  * **Negative Paths:**
    * Empty `interviewContext` → snapshot is `""`, prompts render identically to today. Existing tests continue to pass.
    * Late interview modifies `interviewContext` after planner/reviewer snapshot → the prompt is unchanged. Test `late interview does not retroactively change planner prompt` (Step 6) pins this.

  * **Verification:**
    * `npx tsc -b packages/core` — PASS.
    * `node --test tests/runtime.test.mjs --test-name-pattern 'late interview'` — PASS after Step 6.

* [ ] **Step 6: Add tests against the live runtime**

  * **Files:**
    * `Test: tests/runtime.test.mjs` (append six new tests in the existing `describe`-free `test(...)` block, following the fixture pattern at `:371`)

  * **Interfaces:**
    * Consumes: `runRuntimeHarness`, `runLatestFactoryRun`, `withTempProject`, `readJson`, `makeExecutor`, `writeProjectSkill` (all already imported at `tests/runtime.test.mjs:1-10` and defined as helpers in the file).
    * Produces (six new tests, each with its full body):
      ```js
      // tests/runtime.test.mjs (append)

      test('interview dependsOn [] runs before discovery and pauses the run', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: kickoff',
              'workflows:',
              '  - id: kickoff',
              '    name: Kickoff',
              '    stages:',
              '      - name: kickoff',
              '        type: interview',
              '        role: planner',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '        dependsOn: [kickoff]',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: build',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          await runRuntimeHarness({
            cwd: root,
            goal: 'Add feature',
            plannerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
            requestDecision: async () => ({
              requestId: 'r1', optionId: 'answered', feedback: 'ship it', decidedAt: new Date().toISOString(),
            }),
          });
          const runDir = path.join(root, '.factory', 'runs', (await fs.readdir(path.join(root, '.factory', 'runs'))).sort().at(-1));
          const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
          // Discovery executor must NOT be invoked until the kickoff interview is answered.
          const kickoffDecisionIndex = events.findIndex((l) => /decision.required/.test(l) && /kickoff/.test(l));
          const discoveryStartIndex = events.findIndex((l) => /phase\.discovery/.test(l));
          assert.ok(kickoffDecisionIndex >= 0, 'kickoff interview must trigger a decision gate');
          assert.ok(discoveryStartIndex > kickoffDecisionIndex, 'discovery must start after kickoff decision');
        });
      });

      test('interview dependsOn [discover] runs before plan and not before discovery', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: preplan',
              'workflows:',
              '  - id: preplan',
              '    name: Preplan',
              '    stages:',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '      - name: grill',
              '        type: interview',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [grill]',
              '      - name: build',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          await runRuntimeHarness({
            cwd: root,
            goal: 'Add feature',
            plannerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
            requestDecision: async () => ({
              requestId: 'r1', optionId: 'answered', feedback: 'answer', decidedAt: new Date().toISOString(),
            }),
          });
          const runDir = path.join(root, '.factory', 'runs', (await fs.readdir(path.join(root, '.factory', 'runs'))).sort().at(-1));
          const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
          const discoveryIdx = events.findIndex((l) => /phase\.discovery/.test(l));
          const interviewIdx = events.findIndex((l) => /phase\.interview/.test(l) && /grill/.test(l));
          const planningIdx = events.findIndex((l) => /phase\.planning/.test(l));
          assert.ok(discoveryIdx >= 0 && interviewIdx > discoveryIdx, 'interview must follow discovery');
          assert.ok(planningIdx > interviewIdx, 'planning must follow the grill interview');
        });
      });

      test('interview dependsOn [verify] runs after verification and before review', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: postverify',
              'workflows:',
              '  - id: postverify',
              '    name: Postverify',
              '    stages:',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: implementation',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
              '      - name: verification',
              '        type: command',
              '        commands: [node -e ""]',
              '        dependsOn: [implementation]',
              '      - name: ask_after_checks',
              '        type: interview',
              '        role: planner',
              '        dependsOn: [verify, verification]',
              '      - name: review',
              '        type: agent',
              '        role: reviewer',
              '        dependsOn: [ask_after_checks]',
              '      - name: acceptance',
              '        type: acceptance',
              '        dependsOn: [review]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = makeExecutor('builder', calls);
          const reviewerExecutor = makeExecutor('reviewer', calls);
          await runRuntimeHarness({
            cwd: root,
            goal: 'Add feature',
            plannerExecutor,
            builderExecutor,
            reviewerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
            requestDecision: async () => ({
              requestId: 'r1', optionId: 'answered', feedback: 'ship', decidedAt: new Date().toISOString(),
            }),
          });
          const runDir = path.join(root, '.factory', 'runs', (await fs.readdir(path.join(root, '.factory', 'runs'))).sort().at(-1));
          const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
          const verifyIdx = events.findIndex((l) => /phase\.verification/.test(l) || /phase\.verified/.test(l));
          const interviewIdx = events.findIndex((l) => /ask_after_checks/.test(l));
          const reviewIdx = events.findIndex((l) => /phase\.review/.test(l));
          assert.ok(verifyIdx >= 0 && interviewIdx > verifyIdx, 'interview must run after verification');
          assert.ok(reviewIdx > interviewIdx, 'review must run after the post-verify interview');
        });
      });

      test('renaming the post-verify interview does not change scheduling behavior', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: postverify',
              'workflows:',
              '  - id: postverify',
              '    name: Postverify',
              '    stages:',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: implementation',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
              '      - name: verification',
              '        type: command',
              '        commands: [node -e ""]',
              '        dependsOn: [implementation]',
              '      - name: post_verify_interview',
              '        type: interview',
              '        role: planner',
              '        dependsOn: [verify, verification]',
              '      - name: review',
              '        type: agent',
              '        role: reviewer',
              '        dependsOn: [post_verify_interview]',
              '      - name: acceptance',
              '        type: acceptance',
              '        dependsOn: [review]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = makeExecutor('builder', calls);
          const reviewerExecutor = makeExecutor('reviewer', calls);
          await runRuntimeHarness({
            cwd: root,
            goal: 'Add feature',
            plannerExecutor, builderExecutor, reviewerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
            requestDecision: async () => ({
              requestId: 'r1', optionId: 'answered', feedback: 'ship', decidedAt: new Date().toISOString(),
            }),
          });
          const runDir = path.join(root, '.factory', 'runs', (await fs.readdir(path.join(root, '.factory', 'runs'))).sort().at(-1));
          const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
          // Assert same ordering as the previous test, with the renamed stage.
          const verifyIdx = events.findIndex((l) => /phase\.verification/.test(l) || /phase\.verified/.test(l));
          const interviewIdx = events.findIndex((l) => /post_verify_interview/.test(l));
          const reviewIdx = events.findIndex((l) => /phase\.review/.test(l));
          assert.ok(verifyIdx >= 0 && interviewIdx > verifyIdx);
          assert.ok(reviewIdx > interviewIdx);
        });
      });

      test('all interview stages do not run before planning when none depends on discover or earlier', async () => {
        // A workflow with only the default flow and no interview should never invoke an interview.
        await withTempProject(async (root) => {
          // Default workflow has no interview stage. Add one with dependsOn: [plan] and assert
          // it does NOT run before planning.
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: default',
              'workflows:',
              '  - id: default',
              '    name: Default',
              '    stages:',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: build',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
              '      - name: verification',
              '        type: command',
              '        commands: [node -e ""]',
              '        dependsOn: [build]',
              '      - name: late_interview',
              '        type: interview',
              '        role: planner',
              '        dependsOn: [plan]',
              '      - name: review',
              '        type: agent',
              '        role: reviewer',
              '        dependsOn: [late_interview]',
              '      - name: acceptance',
              '        type: acceptance',
              '        dependsOn: [review]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          const builderExecutor = makeExecutor('builder', calls);
          const reviewerExecutor = makeExecutor('reviewer', calls);
          await runRuntimeHarness({
            cwd: root,
            goal: 'Add feature',
            plannerExecutor, builderExecutor, reviewerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
            requestDecision: async () => ({
              requestId: 'r1', optionId: 'answered', feedback: 'late answer', decidedAt: new Date().toISOString(),
            }),
          });
          const runDir = path.join(root, '.factory', 'runs', (await fs.readdir(path.join(root, '.factory', 'runs'))).sort().at(-1));
          const plannerPrompt = calls.find((c) => c.label === 'planner' && /planner/i.test(c.prompt))?.prompt ?? '';
          assert.ok(!/late_interview/.test(plannerPrompt), 'planner prompt must not contain late-interview answer');
          // Builder prompt also must not contain it.
          const builderPrompts = calls.filter((c) => c.label === 'builder').map((c) => c.prompt).join('\n');
          assert.ok(!/late_interview/.test(builderPrompts), 'builder prompt must not contain late-interview answer');
        });
      });

      test('waiting interview blocks dependent stages', async () => {
        await withTempProject(async (root) => {
          await fs.writeFile(
            path.join(root, 'factory.yaml'),
            [
              'defaultWorkflowId: blocking',
              'workflows:',
              '  - id: blocking',
              '    name: Blocking',
              '    stages:',
              '      - name: discover',
              '        type: agent',
              '        role: discovery',
              '      - name: grill',
              '        type: interview',
              '        role: planner',
              '        dependsOn: [discover]',
              '      - name: plan',
              '        type: agent',
              '        role: planner',
              '        dependsOn: [grill]',
              '      - name: build',
              '        type: agent',
              '        role: builder',
              '        dependsOn: [plan]',
            ].join('\n'),
            'utf8',
          );
          const calls = [];
          const plannerExecutor = makeExecutor('planner', calls);
          await assert.rejects(
            () => runRuntimeHarness({
              cwd: root,
              goal: 'Add feature',
              plannerExecutor,
              requestPlanApproval: async () => ({ decision: 'approve' }),
              requestApproval: async () => true,
            }),
            /Decision required/,
          );
          assert.ok(!calls.some((c) => c.label === 'planner'), 'planner must NOT run before the interview decision resolves');
        });
      });
      ```

  * **Negative Paths:**
    * `requestDecision` not provided → `requestHumanDecision` throws `Decision required ... but no requestDecision handler is configured`. The waiting-interview test covers this for the DAG-ready path.
    * Workflow rejected by `validateWorkflowDependencies` → config load fails loud with `[unknown-depends-on]`/`[cycle]`/`[unreachable-stage]`/`[approval-without-review]`. None of the new tests trigger this (all use valid DAGs).
    * Resume after pause: not in scope of these unit tests; `interview-decisions.json` is the completion source once a pending decision resolves.

  * **Verification:**
    * `node --test tests/runtime.test.mjs --test-name-pattern 'interview dependsOn \[\] runs before discovery' --test-name-pattern 'interview dependsOn \[discover\] runs before plan' --test-name-pattern 'interview dependsOn \[verify\] runs after verification' --test-name-pattern 'renaming the post-verify interview' --test-name-pattern 'all interview stages do not run before planning' --test-name-pattern 'waiting interview blocks dependent stages'` — PASS.

* [ ] **Step 7: Update docs and learnings**

  * **Files:**
    * `Modify: docs/factory/workflow-authoring.md:60-90`
    * `Modify: skills/factory-concierge/SKILL.md` (interview section)
    * `Modify: .pi/skills/factory-concierge/SKILL.md` (interview section)
    * `Modify: learnings.md:17`

  * **Interfaces:**
    * Consumes: existing doc text.
    * Produces (replace `docs/factory/workflow-authoring.md:60-88`):
      ```markdown
      ## Interview stages are workflow DAG nodes

      An `type: interview` stage is a normal workflow node. Placement is governed entirely
      by `dependsOn`. There is no "pre-planning bucket" or "post-verification bucket" — only
      stage names and dependency edges.

      - A kickoff interview (`dependsOn: []`) runs before discovery.
      - A pre-plan interview (`dependsOn: [discover]`) runs between discovery and planning.
      - A post-verify interview (`dependsOn: [verify]` or `dependsOn: [verification]`) runs after
        verification and before review.
      - Renaming a stage (e.g. `post_verify_interview`) does not change its placement. The
        placement comes from `dependsOn`, not from the stage name.

      Example:
      ```yaml
      - name: kickoff
        type: interview
        role: planner
      - name: discover
        type: agent
        role: discovery
        dependsOn: [kickoff]
      - name: plan
        type: agent
        role: planner
        dependsOn: [discover]
      - name: build
        type: agent
        role: builder
        dependsOn: [plan]
      - name: verification
        type: command
        commands: [lint, typecheck, test, build]
        dependsOn: [build]
      - name: post_verify_interview
        type: interview
        role: planner
        dependsOn: [verify, verification]
      - name: review
        type: agent
        role: reviewer
        dependsOn: [post_verify_interview]
      - name: acceptance
        type: acceptance
        dependsOn: [review]
      ```

      Factory validates the workflow DAG at load and rejects unknown `dependsOn` references,
      dependency cycles, unreachable stages, and `acceptance`/`approval` stages that do not
      depend on a reviewer.

      A waiting interview pauses the run with `state.status === "DECISION_REQUIRED"` and
      `state.phase === "decision-interview"`. On resume, the interview does not re-ask
      because its completion is recorded in `interview-decisions.json`. Late interviews
      (post-plan) do not retroactively alter earlier prompts; the planner and reviewer
      snapshot `interviewContext` when they build their prompts.
      ```

      Replace `learnings.md:17`:
      ```markdown
      - Interview stages are DAG nodes: placement is governed entirely by `dependsOn` and
        the active `controller.ts` readiness helper; there is no pre-planning or
        post-verification bucket. `interview-decisions.json` records per-stage
        completion so resume does not re-ask answered interviews.
      ```

      Mirror the same wording in `skills/factory-concierge/SKILL.md` and `.pi/skills/factory-concierge/SKILL.md` (the "interview" sections that currently echo the pre/post-verification framing).

  * **Negative Paths:**
    * Doc text becomes inconsistent if only one of the two SKILL.md copies is updated. Both must change in the same step.

  * **Verification:**
    * `grep -n "post-verification bucket\|post-verification interview\|post-planning bucket\|classifyInterviewExecutionPoint" docs/factory/workflow-authoring.md skills/factory-concierge/SKILL.md .pi/skills/factory-concierge/SKILL.md learnings.md` — returns zero matches.
    * `grep -n "interview dependsOn\|interview is a normal workflow node\|placement is controlled only by dependsOn" docs/factory/workflow-authoring.md skills/factory-concierge/SKILL.md .pi/skills/factory-concierge/SKILL.md learnings.md` — returns at least one match in each file.

* [ ] **Step 8: Full verification**

  * **Files:** none.
  * **Interfaces/Code:** none.
  * **Negative Paths:**
    * The dead modules (`controller-run.ts`, `controller-interview.ts`, etc.) still contain `classifyInterviewExecutionPoint`. They are not in scope of this plan; they remain inert because nothing imports them. Confirm with `rg -n "classifyInterviewExecutionPoint" packages tests --glob '!**/dist/**'` — only dead-module hits expected.

  * **Verification:**
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.
    * `npm run complexity` — PASS.
    * `node --test tests/workflow-registry-dag.test.mjs` — PASS (existing DAG validator still passes for the new workflow shapes).
    * `node --test tests/runtime.test.mjs` — PASS (existing interview tests at `:371` and `:442` continue to work; the six new tests from Step 6 pass).
    * `node --test tests/decision.test.mjs` — PASS.
    * `node --test tests/pi-adapter.test.mjs` — PASS.
    * `npm test` — PASS (full suite).
    * Manual smoke: load `factory.yaml` from Step 6's "post-verify" fixture into a real Factory run; observe `decision.required` followed by `interview.boundary_completed` followed by `phase.review`.

## 4. Testing

* **Regression first:** `tests/runtime.test.mjs:371` "interview workflow stage pauses before planning" — already passes against the pre-existing broken filter; after Step 4 it must still pass (the readiness helper runs an interview with `dependsOn: [discover]` at the post-discovery boundary, identical observable behavior).
* **New tests** (Step 6, six total):
  1. `interview dependsOn [] runs before discovery and pauses the run` — kickoff gate before discovery executor.
  2. `interview dependsOn [discover] runs before plan and not before discovery` — pre-plan ordering.
  3. `interview dependsOn [verify] runs after verification and before review` — post-verify ordering.
  4. `renaming the post-verify interview does not change scheduling behavior` — invariant against naming.
  5. `all interview stages do not run before planning when none depends on discover or earlier` — proves no implicit pre-planning bucket exists; planner and builder prompts must not contain a `late_interview` answer.
  6. `waiting interview blocks dependent stages` — paused run, planner never invoked.
* **Full-suite:** `npm test` — PASS.

## 5. Definition of Done

* [ ] Required behavior works: kickoff interviews (`dependsOn: []`) run before discovery; pre-plan interviews run after discovery and before planning; post-verify interviews run after verification and before review; placement is governed entirely by `dependsOn`.
* [ ] Negative paths behave correctly:
  * `INTERVIEW_COMPLETE` from the model → no decision gate, completion recorded, run continues.
  * Decision handler not configured → run pauses with `state.status === "DECISION_REQUIRED"`, `state.phase === "decision-interview"`; resume reuses the persisted resolution.
  * Renaming an interview stage (e.g. `post_verify_interview`) does not change its placement.
  * Resume after pause does not re-ask an answered interview (`interview-decisions.json` records completion).
  * Late interviews do not retroactively alter earlier prompts (snapshot at planner/reviewer prompt construction).
  * No code path branches on "pre-planning" or "post-verification" interview placement. `grep -n "pre-planning\|post-verification\|classifyInterviewExecutionPoint\|preplanning\|postverification" packages/core/src/runtime/controller.ts` returns zero matches.
* [ ] Tests pass (`npm test`, including the six new tests in Step 6).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Lint passes (`npm run complexity`; no lint script exists in `package.json`).
* [ ] Build passes (`npm run build`).
* [ ] No migrations required. `InterviewDecisionRecord` gains one optional `dependsOn` field; legacy records without it remain valid. No schema changes; no DB migrations; no config migrations.
* [ ] Docs and learnings updated in the same change (Step 7). Future readers do not encounter the misleading pre/post-verification framing in `docs/factory/workflow-authoring.md`, the two `SKILL.md` copies, or `learnings.md`.
