# LLM-Owned Policy Decisions with Hard-Constraint Enforcement

## 1. Understanding & Scope

* **Core Goal:** Unify every policy decision in the run controller behind a single LLM-facing interface (`RuntimePolicyExecutor`) so the LLM picks *what should happen* and Factory only validates and executes. Today each phase has its own ad-hoc enum (`FailureRecoveryAction = retry | repair | revise | stop`, `AcceptanceDecision = accept | revise | reject`, `PlanApprovalDecision = approve | reject | revise`) and the controller hard-codes the resulting state transition (`if (recovery.action === "retry" || recovery.action === "revise") continue` in nine call sites). The new contract hands the LLM a normalized decision — `continue | retry | revise | repair | rerunImplementation | abort` plus `nextPhase`, `feedback`, `evidenceRefs`, `attempt` — and the controller validates against hard constraints before applying it.
* **Current Behavior:** (with file:line evidence)
  * `FailureRecoveryAction` enum: `packages/core/src/runtime/failure-recovery.ts:9` (`export type FailureRecoveryAction = "retry" | "repair" | "revise" | "stop";`).
  * `AcceptanceDecision` enum: `packages/core/src/runtime/controller.ts:125-128` (`export type AcceptanceDecision = { decision: "accept" | "revise" | "reject"; … }`).
  * `PlanApprovalDecision` enum: `packages/core/src/runtime/controller.ts:93` (`export type PlanApprovalDecision = "approve" | "reject" | "revise";`).
  * Hard-coded state-transition branches that interpret the enum are spread across nine sites:
    * `packages/core/src/runtime/planning-phase2.ts:165` — `if (recovery.action === "retry" || recovery.action === "revise")`.
    * `packages/core/src/runtime/discovery-phase.ts:330` — same shape.
    * `packages/core/src/runtime/implementation-phase.ts:140` — `retry || repair || revise` → `continue`.
    * `packages/core/src/runtime/controller-integration.ts:91` — `retry || repair` → `continue`.
    * `packages/core/src/runtime/verification-phase2.ts:200` — `retry || revise` → `continue`.
    * `packages/core/src/runtime/controller-final-phases.ts:97, 245, 384, 488, 575` — five sites for `verification-blocked`, `review-unavailable`, `review-failed`, `acceptance-blocked`, `rejected` (plus the `if (false)` acceptance-blocked dead block).
    * `packages/core/src/runtime/landing.ts:112, 169, 303` — three landing sub-phases.
  * Each call constructs a separate `DecisionRequest` (`failure-recovery.ts:43-65` builds a request with bespoke options per call). The LLM has no shared model of "what phase am I in, what evidence is on the table, what hard constraints are binding".
  * `landing-ai.ts:36-58, 94-150` already picks the landing strategy via LLM, but the controller still decides when to *re-enter* the planner (`landing.ts:127-137`).
  * Acceptance already routes through `requestAcceptance` (`packages/core/src/runtime/acceptance-phase.ts:42-65`), but the decision schema (`accept | revise | reject`) is bespoke and not LLM-extensible.
  * `verification-outcome.ts:42-100` hard-codes `if (verification.overallStatus === "failed") return FAILED` after `isIgnorableBaselineFailure` — the *what-should-happen* decision (continue or stop) is currently controller-owned.
  * `controller-run.ts:158` hard-codes `const MAX_REPLANS = 2` — that is a hard constraint and stays controller-owned.
  * `requestHumanDecision` (`phase-plumbing.ts:96-148`) is the single human/decision-routing primitive that already pauses the run, persists the decision to the ledger, and resumes on the next call. The new `RuntimePolicyExecutor` reuses this plumbing.
* **Target Behavior:**
  * Single LLM-facing interface `RuntimePolicyDecision` replaces every per-phase enum. The LLM returns `{ action: "continue" | "retry" | "revise" | "repair" | "rerunImplementation" | "abort"; nextPhase?: string; feedback?: string; attempt: number; }`.
  * Every phase call site passes through one helper `requestRuntimePolicy(input)` that:
    1. Asks the LLM (via `policyExecutor.execute`) for the next decision given the current phase, evidence, constraints, and attempt counter.
    2. Validates the decision against hard constraints (decision schema, `attempt <= failureRecovery.maxAttempts`, `nextPhase` is an allowed phase, retry budgets not exhausted).
    3. On invalid, re-prompts with the constraint violation; on three constraint violations, fails loud with a specific reason.
    4. Persists the validated decision to the decision ledger (so `/factory resume` works unchanged).
    5. Updates state to `RUNNING / phase: nextPhase ?? currentPhase` after validation.
  * `RuntimePolicyExecutor` is the new optional input on `RunFactoryControllerInput`. The harness (`packages/core/src/runtime/harness.ts`) wires it from the configured `policyModel` role plus a `failureClassifierExecutor` (which already provides prompt-based narration). When the executor is absent, `requestRuntimePolicy` falls back to the existing per-phase path (preserving current behavior; no regressions in tests).
  * `verifyDecisionConstraints(decision, context)` is the new deterministic validator in `packages/core/src/runtime/policy-constraints.ts` that enforces:
    * `attempt <= maxAttempts` (config: `failureRecovery.maxAttempts`).
    * `nextPhase` ∈ allowed phases per current phase (config-driven; see Step 1).
    * `repair` requires `repairExecutor` and `repair.enabled = true` in effective config.
    * `rerunImplementation` requires completed task commits to be re-runnable (in-memory `task.status === "done"`); if not, validator rejects and re-prompts.
    * `abort` is always allowed.
  * `verification-outcome.ts` no longer branches on `verification.overallStatus === "failed"` to set terminal state. It calls `requestRuntimePolicy` with `evidence: { overallStatus, failureClassification, contractResult }` and applies the LLM's decision (subject to constraints).
  * The landing sub-phases (`landing-guard`, `landing-execution`, `post-landing-verification`) collapse into a single `requestRuntimePolicy` call inside `runLandingFlow`, replacing the three `landingRecovery(...)` invocations.
  * Plan-approval and acceptance funnel through `requestRuntimePolicy` too; the LLM returns `abort` (reject), `continue` (accept), or `revise` with feedback.
  * Resource limits, dirty-worktree safety, evidence requirements, and persistence remain controller-enforced exactly as today.
* **Files Affected:**
  * `packages/core/src/runtime/policy.ts` (create)
  * `packages/core/src/runtime/policy-constraints.ts` (create)
  * `packages/core/src/runtime/failure-recovery.ts` (modify — keep public surface, route through `requestRuntimePolicy`)
  * `packages/core/src/runtime/controller.ts` (modify — add `RuntimePolicyDecision`, `RuntimePolicyExecutor`, `policyExecutor` input field)
  * `packages/core/src/runtime/controller-run.ts` (modify — call `requestRuntimePolicy` at the replan bound instead of `MAX_REPLANS` constant)
  * `packages/core/src/runtime/controller-final-phases.ts` (modify — replace five call sites)
  * `packages/core/src/runtime/controller-integration.ts` (modify — replace one call site)
  * `packages/core/src/runtime/planning-phase2.ts` (modify — replace one call site)
  * `packages/core/src/runtime/discovery-phase.ts` (modify — replace one call site)
  * `packages/core/src/runtime/implementation-phase.ts` (modify — replace one call site)
  * `packages/core/src/runtime/verification-phase2.ts` (modify — replace one call site)
  * `packages/core/src/runtime/verification-outcome.ts` (modify — remove hard-coded terminal-state branch)
  * `packages/core/src/runtime/landing.ts` (modify — collapse three `landingRecovery` calls into one `requestRuntimePolicy` site)
  * `packages/core/src/runtime/acceptance-phase.ts` (modify — route through `requestRuntimePolicy`)
  * `packages/core/src/runtime/plan-approval-phase.ts` (modify — route through `requestRuntimePolicy`)
  * `packages/core/src/runtime/phase-plumbing.ts` (modify — extract `persistDecisionResolution` helper used by both `requestHumanDecision` and `requestRuntimePolicy`)
  * `packages/core/src/runtime/harness.ts` (modify — propagate optional `policyExecutor`)
  * `packages/core/src/decisions/types.ts` (modify — add `POLICY` source)
  * `packages/core/src/decisions/ledger.ts` (modify — no schema change; same envelope)
  * `packages/schemas/src/config.ts` (modify — add `runtime.policyModel`, `runtime.allowedPhasesByPhase?`, `runtime.maxPolicyAttempts`)
  * `tests/policy.test.mjs` (create)
  * `tests/runtime.test.mjs` (modify — replace existing `runtime-policy` mocks if any; add new tests)
  * `tests/landing.test.mjs` (modify — three landing sub-phases now go through one policy site)
  * `docs/factory/concepts.md` (modify — new "policy / constraint" section)
  * `docs/factory/workflow-authoring.md` (modify — replace "controller-owned recovery" sentence at line 81)
  * `.pi/skills/factory-concierge/SKILL.md` (modify)
  * `skills/factory-concierge/SKILL.md` (modify)
  * `learnings.md` (modify — capture the LLM-owns-policy / controller-enforces-constraints split)
* **Out of Scope:**
  * Changing `failureRecovery.enabled` default or `requestDecision` semantics. The policy executor reuses the same ledger + state pause.
  * Removing the per-phase enums (`FailureRecoveryAction`, `AcceptanceDecision`, `PlanApprovalDecision`) from public types. They become thin type aliases of `RuntimePolicyDecision["action"]` subsets for back-compat with existing adapters (`packages/adapters/pi/src/approval.ts`, `dashboard-api.test.mjs`).
  * Replacing the deterministic landing-guard invariants (`landing-git.ts:42-77`). Git-safety checks (`gitRefExists`, `gitCommitExists`) stay controller-owned.
  * Replacing `verifyDecisionConstraints` with an LLM. Constraints stay deterministic.
  * Re-entering implementation from acceptance. The `onAcceptanceRevise` loop in `controller-run.ts:367-374` stays (it's a typed re-entry, not a state-transition policy).
  * Resource-limit policy. `toolTimeoutMs`, `runTimeoutMs`, `maxTurns`, `runDeadlineAt` stay deterministic hard ceilings (per AGENTS.md).
  * Workflow-authoring DSL changes. Workflows still emit `WorkflowStage`s; policy decides what to do at terminal-of-workflow.
  * Cross-process resume semantics. `findPendingDecision` already handles ledger-based resume; this plan preserves it.

## 2. Assumptions & Blockers

* **Assumptions:**
  * `policyExecutor` is optional. If absent, the run uses existing behavior (no regressions). This matches the existing pattern for `failureClassifierExecutor` (`controller.ts:138`).
  * The LLM is reachable in production. If not, the policy executor throws and the run surfaces a `decision-runtime` pause (already handled by `phase-plumbing.ts:96-148`).
  * `runtime.allowedPhasesByPhase` defaults to an empty allow-list that the validator treats as "no transition allowed except continue/retry/revise/repair/rerunImplementation that the current phase already permits". The mapping is per-phase (defined in Step 1).
  * Existing `requestDecision` adapters (`packages/adapters/pi/src/decision-dialog.ts`) keep working unchanged because `requestRuntimePolicy` persists via the same ledger and pauses with the same `DECISION_REQUIRED / decision-runtime` state.
  * The Pi adapter `requestPlanApprovalDecision` / `requestAcceptanceDecision` (`packages/adapters/pi/src/approval.ts:58, 299`) continue to expose typed per-phase UIs; the `policyExecutor` is the lower-level primitive that routes to them when available.
* **Questions / Blockers:**
  * **Blocker for full LLM-driven mode:** the builder must implement at least one `RuntimePolicyExecutor` (or a fallback wrapper) for tests. The plan provides a `MockPolicyExecutor` in `tests/policy.test.mjs` that records every call and returns scripted decisions. Without it, the new path is exercised only via integration tests.
  * **Question (answerable in code, no blocker):** Should `requestRuntimePolicy` re-prompt on a constraint violation, or fail loud immediately? Plan re-prompts once (the LLM gets one chance to honor the constraint), then fails loud with the violation reason; this matches the existing `decision.invalid` pattern in `phase-plumbing.ts:120-127`.
  * **Question (answerable in code, no blocker):** How does the policy executor model "what phase am I in" without leaking controller internals? Plan answers: the executor input is a typed `RuntimePolicyContext` with explicit fields (`currentPhase`, `evidence`, `attempt`, `maxAttempts`, `allowedNextPhases`, `constraintsSatisfied`). No phase-name string interpolation beyond what already exists.

## 3. Implementation Plan

* [ ] **Step 1: Define `RuntimePolicyDecision`, `RuntimePolicyContext`, and `RuntimePolicyExecutor` types**

  * **Files:**
    * `Create: packages/core/src/runtime/policy.ts:1-180`
    * `Modify: packages/core/src/decisions/types.ts:1-44` (add `DecisionSource: "POLICY"`)
    * `Modify: packages/core/src/runtime/controller.ts:90-160` (add new types + `policyExecutor?` field)
  * **Interfaces:** Consumes nothing new. Produces:
    * `RuntimePolicyAction = "continue" | "retry" | "revise" | "repair" | "rerunImplementation" | "abort"`.
    * `RuntimePolicyDecision = { action: RuntimePolicyAction; nextPhase?: string; feedback?: string; attempt: number; decidedAt: string; }`.
    * `RuntimePolicyContext = { runId: string; goal: string; currentPhase: string; evidence: Record<string, unknown>; attempt: number; maxAttempts: number; allowedNextPhases: string[]; constraints: Record<string, unknown>; }`.
    * `RuntimePolicyExecutor = { execute(input: { context: RuntimePolicyContext; controllerInput: RunFactoryControllerInput; }): Promise<RuntimePolicyDecision> }`.
    * `export async function requestRuntimePolicy(input: { controllerInput: RunFactoryControllerInput; runDir: string; statePath: string; eventsPath: string; runId: string; context: RuntimePolicyContext; }): Promise<RuntimePolicyDecision>` — calls `controllerInput.policyExecutor?.execute` if set, otherwise `controllerInput.requestDecision` (after building a `DecisionRequest`), then validates via `verifyDecisionConstraints`, persists to the decision ledger, and resumes state.
    * `RuntimePolicyConfig = { enabled?: boolean; maxAttempts?: number; allowedPhasesByPhase?: Record<string, string[]>; }` added to `RunFactoryControllerInput["failureRecovery"]` as a sibling field (or a new optional `policy` input field — pick the latter to avoid coupling).
  * **Code:**
    ```ts
    // packages/core/src/runtime/policy.ts
    import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
    import { appendDecisionLedgerEntry } from "../decisions/index.js";
    import { verifyDecisionConstraints } from "./policy-constraints.js";
    import { emitProgress, requestHumanDecision } from "./phase-plumbing.js";
    import type { RunFactoryControllerInput } from "./controller.js";

    export type RuntimePolicyAction =
      | "continue"
      | "retry"
      | "revise"
      | "repair"
      | "rerunImplementation"
      | "abort";

    export interface RuntimePolicyDecision {
      action: RuntimePolicyAction;
      nextPhase?: string;
      feedback?: string;
      attempt: number;
      decidedAt: string;
    }

    export interface RuntimePolicyContext {
      runId: string;
      goal: string;
      currentPhase: string;
      evidence: Record<string, unknown>;
      attempt: number;
      maxAttempts: number;
      allowedNextPhases: string[];
      constraints: Record<string, unknown>;
    }

    export interface RuntimePolicyExecutor {
      execute(input: {
        context: RuntimePolicyContext;
        controllerInput: RunFactoryControllerInput;
      }): Promise<RuntimePolicyDecision>;
    }

    const MAX_CONSTRAINT_VIOLATIONS = 2;

    export async function requestRuntimePolicy(input: {
      controllerInput: RunFactoryControllerInput;
      runDir: string;
      statePath: string;
      eventsPath: string;
      runId: string;
      context: RuntimePolicyContext;
    }): Promise<RuntimePolicyDecision> {
      const maxAttempts = input.context.maxAttempts;
      if (input.context.attempt > maxAttempts) {
        return { action: "abort", attempt: input.context.attempt, decidedAt: new Date().toISOString(), feedback: `Retry budget exhausted (attempt ${input.context.attempt} > ${maxAttempts})` };
      }
      const executor = input.controllerInput.policyExecutor;
      const policyConfig = input.controllerInput.policy;
      if (policyConfig?.enabled === false) {
        return { action: "abort", attempt: input.context.attempt, decidedAt: new Date().toISOString(), feedback: "Runtime policy disabled" };
      }

      for (let violationAttempt = 0; violationAttempt <= MAX_CONSTRAINT_VIOLATIONS; violationAttempt += 1) {
        let decision: RuntimePolicyDecision;
        try {
          decision = executor
            ? await executor.execute({ context: input.context, controllerInput: input.controllerInput })
            : await fallbackDecisionViaRequestDecision(input);
        } catch (error) {
          await appendFactoryRunEvent(input.eventsPath, {
            timestamp: new Date().toISOString(),
            type: "policy.executor_failed",
            data: { phase: input.context.currentPhase, reason: error instanceof Error ? error.message : String(error) },
          });
          return { action: "abort", attempt: input.context.attempt, decidedAt: new Date().toISOString(), feedback: error instanceof Error ? error.message : String(error) };
        }
        const validation = verifyDecisionConstraints(decision, input.context, policyConfig);
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: validation.ok ? "policy.decision_resolved" : "policy.constraint_violation",
          data: { phase: input.context.currentPhase, action: decision.action, nextPhase: decision.nextPhase, feedback: decision.feedback, violation: validation.ok ? undefined : validation.reason, attempt: input.context.attempt },
        });
        if (validation.ok) {
          await appendDecisionLedgerEntry(input.runDir, { type: "resolution", result: { requestId: `policy-${input.runId}-${input.context.currentPhase}-${input.context.attempt}`, optionId: decision.action, feedback: decision.feedback } });
          await updateFactoryRunState({ statePath: input.statePath, patch: { status: "RUNNING", phase: decision.nextPhase ?? input.context.currentPhase } });
          await emitProgress(input.controllerInput, {
            runId: input.runId,
            phase: decision.nextPhase ?? input.context.currentPhase,
            status: "RUNNING",
            message: `Policy decision: ${decision.action}` + (decision.feedback ? ` (${decision.feedback})` : ""),
          });
          return decision;
        }
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "policy.re_prompted",
          data: { phase: input.context.currentPhase, violation: validation.reason, attempt: violationAttempt + 1 },
        });
      }
      throw new Error(`Policy for phase '${input.context.currentPhase}' returned decisions that violated constraints ${MAX_CONSTRAINT_VIOLATIONS + 1} times; refusing to continue.`);
    }

    async function fallbackDecisionViaRequestDecision(input: {
      controllerInput: RunFactoryControllerInput;
      runDir: string;
      statePath: string;
      eventsPath: string;
      runId: string;
      context: RuntimePolicyContext;
    }): Promise<RuntimePolicyDecision> {
      const decide = input.controllerInput.requestDecision;
      if (!decide) {
        return { action: "abort", attempt: input.context.attempt, decidedAt: new Date().toISOString(), feedback: "No policy executor or requestDecision handler configured" };
      }
      const result = await requestHumanDecision({
        controllerInput: input.controllerInput,
        runDir: input.runDir,
        statePath: input.statePath,
        eventsPath: input.eventsPath,
        runId: input.runId,
        request: {
          id: `policy-${input.runId}-${input.context.currentPhase}-${input.context.attempt}`,
          title: `Policy for ${input.context.currentPhase}`,
          question: JSON.stringify(input.context, null, 2),
          options: [
            { id: "continue", label: "Continue the run" },
            { id: "retry", label: "Retry the current step" },
            { id: "revise", label: "Revise with guidance" },
            { id: "abort", label: "Stop the run" },
            ...(input.context.allowedNextPhases.includes("implementation") ? [{ id: "rerunImplementation", label: "Re-enter implementation" }] : []),
            ...(input.context.allowedNextPhases.includes("repair") ? [{ id: "repair", label: "Launch a repair executor" }] : []),
          ],
          evidenceRefs: [],
          source: "POLICY",
          reason: "FAILURE_RECOVERY",
        },
      });
      return {
        action: mapOptionToAction(result.optionId),
        feedback: result.feedback,
        attempt: input.context.attempt,
        decidedAt: result.decidedAt,
      };
    }

    function mapOptionToAction(optionId: string): RuntimePolicyAction {
      switch (optionId) {
        case "continue":
        case "retry":
        case "revise":
        case "repair":
        case "rerunImplementation":
        case "abort":
          return optionId;
        default:
          if (optionId === "custom") return "abort";
          throw new Error(`Unknown policy option id: ${optionId}`);
      }
    }
    ```
  * **Negative Paths:**
    * `policyExecutor` and `requestDecision` both undefined → `requestRuntimePolicy` returns `abort` with a clear `feedback` string. Caller decides whether to terminate the run or continue.
    * `policyExecutor.execute` throws → caught, event `policy.executor_failed` written, decision `abort` returned (never silently defaults).
    * Decision violates constraints → re-prompt up to `MAX_CONSTRAINT_VIOLATIONS + 1` times, then throw. No silent accept.
    * `attempt > maxAttempts` on entry → return `abort` immediately (the bound is a hard constraint, the LLM cannot override).
  * **Verification:** `npm run build` — PASS. `node --test tests/policy.test.mjs` — PASS for the new tests in Step 6.

* [ ] **Step 2: Implement `verifyDecisionConstraints`**

  * **Files:**
    * `Create: packages/core/src/runtime/policy-constraints.ts:1-130`
    * `Modify: packages/core/src/schemas/src/config.ts:200-209` (add `RuntimePolicyConfig` to `RunOverrides` and `EffectiveFactoryConfig`)
  * **Interfaces:** Consumes `RuntimePolicyDecision`, `RuntimePolicyContext`, optional `RuntimePolicyConfig`. Produces `{ ok: true } | { ok: false; reason: string }`.
  * **Code:**
    ```ts
    // packages/core/src/runtime/policy-constraints.ts
    import type { RuntimePolicyConfig } from "@factory/schemas";
    import type { RuntimePolicyContext, RuntimePolicyDecision } from "./policy.js";

    const PERMITTED_ACTIONS_BY_PHASE: Record<string, ReadonlyArray<string>> = {
      discovery: ["continue", "retry", "revise", "abort"],
      planning: ["continue", "retry", "revise", "abort"],
      plan_approval: ["continue", "revise", "abort"],
      implementation: ["continue", "retry", "repair", "revise", "rerunImplementation", "abort"],
      integration: ["continue", "retry", "repair", "abort"],
      verification_planning: ["continue", "retry", "revise", "abort"],
      verification: ["continue", "retry", "repair", "revise", "abort"],
      review: ["continue", "retry", "revise", "abort"],
      landing_planning: ["continue", "retry", "revise", "abort"],
      landing_execution: ["continue", "retry", "revise", "abort"],
      landing: ["continue", "retry", "revise", "abort"],
      post_landing_verification: ["continue", "retry", "repair", "revise", "abort"],
      acceptance: ["continue", "revise", "abort"],
    };

    export function verifyDecisionConstraints(
      decision: RuntimePolicyDecision,
      context: RuntimePolicyContext,
      config: RuntimePolicyConfig | undefined,
    ): { ok: true } | { ok: false; reason: string } {
      if (decision.attempt < 1) return { ok: false, reason: "decision.attempt must be >= 1" };
      if (decision.attempt > context.maxAttempts) {
        return { ok: false, reason: `decision.attempt ${decision.attempt} exceeds maxAttempts ${context.maxAttempts}` };
      }
      const permitted = PERMITTED_ACTIONS_BY_PHASE[context.currentPhase] ?? ["abort"];
      if (!permitted.includes(decision.action)) {
        return { ok: false, reason: `action '${decision.action}' is not permitted in phase '${context.currentPhase}' (allowed: ${permitted.join(", ")})` };
      }
      if (decision.nextPhase !== undefined) {
        const allowedFromConfig = config?.allowedPhasesByPhase?.[context.currentPhase];
        const allowed = allowedFromConfig ?? context.allowedNextPhases ?? [];
        if (!allowed.includes(decision.nextPhase)) {
          return { ok: false, reason: `nextPhase '${decision.nextPhase}' is not in allowedNextPhases for '${context.currentPhase}' (${allowed.join(", ") || "none"})` };
        }
      }
      if (decision.action === "revise" && (!decision.feedback || !decision.feedback.trim())) {
        return { ok: false, reason: "action 'revise' requires non-empty feedback" };
      }
      if (decision.action === "abort" && decision.nextPhase !== undefined) {
        return { ok: false, reason: "action 'abort' must not include nextPhase" };
      }
      if (decision.action === "continue" && decision.nextPhase !== undefined && decision.nextPhase !== context.currentPhase) {
        return { ok: false, reason: "action 'continue' may only stay in currentPhase or omit nextPhase" };
      }
      return { ok: true };
    }
    ```
  * **Negative Paths:**
    * Unknown phase key in `PERMITTED_ACTIONS_BY_PHASE`: defaults to `["abort"]`. Validator logs the missing phase via `appendFactoryRunEvent` before returning the failure (the caller `requestRuntimePolicy` re-prompts).
    * Config `allowedPhasesByPhase` overrides the default per-phase list. If the override is an empty array, no `nextPhase` is permitted for that phase.
    * `decision.feedback` exceeds 8000 chars: validator rejects with a clear reason; the re-prompt narrows the LLM's output.
  * **Verification:** `npm run build` — PASS. `node --test tests/policy.test.mjs` — PASS for the validator unit tests in Step 6.

* [ ] **Step 3: Replace `requestFailureRecovery`'s enum with a thin shim over `requestRuntimePolicy`**

  * **Files:**
    * `Modify: packages/core/src/runtime/failure-recovery.ts:1-150`
  * **Interfaces:** Consumes `requestRuntimePolicy`. Keeps `FailureRecoveryAction` as `RuntimePolicyAction` alias for back-compat (`export type FailureRecoveryAction = "retry" | "repair" | "revise" | "stop"` continues to compile because `RuntimePolicyAction` is a superset). Re-exports `requestRuntimePolicy`, `RuntimePolicyContext`, `RuntimePolicyDecision`, `RuntimePolicyExecutor` so existing imports keep working.
  * **Code:**
    ```ts
    // packages/core/src/runtime/failure-recovery.ts (top of file, replaces lines 1-30)
    import { appendFactoryRunEvent } from "../runs/store.js";
    import { requestRuntimePolicy, type RuntimePolicyDecision, type RuntimePolicyAction, type RuntimePolicyContext } from "./policy.js";
    import { writeRecoveryCheckpoint, type RecoveryCheckpointInput } from "./recovery-checkpoint.js";
    import type { RunFactoryControllerInput } from "./controller.js";
    import { fallbackRecoveryNarration, narrateRecovery, type RecoveryOptionId } from "./recovery-narrator.js";
    import type { AgentExecutionInput, AgentExecutor } from "./interfaces.js";

    export type FailureRecoveryAction = "retry" | "repair" | "revise" | "stop";
    export interface FailureRecoveryContext { /* unchanged */ }
    export interface FailureRecoveryResolution extends RuntimePolicyDecision {}

    export function shouldUseInteractiveRecovery(input: RunFactoryControllerInput): boolean {
      return input.policy?.enabled !== false && (Boolean(input.policyExecutor) || Boolean(input.requestDecision));
    }

    export async function buildFailureRecoveryRequest(runId: string, context: FailureRecoveryContext, narrator?: { /* unchanged */ }): Promise<DecisionRequest> {
      // Existing implementation kept verbatim; this is the request shape used
      // by legacy adapters. New code calls requestRuntimePolicy directly.
    }

    export async function requestFailureRecovery(input: {
      controllerInput: RunFactoryControllerInput;
      runDir: string;
      statePath: string;
      eventsPath: string;
      runId: string;
      context: FailureRecoveryContext;
      checkpoint?: RecoveryCheckpointInput;
    }): Promise<FailureRecoveryResolution> {
      const policyContext: RuntimePolicyContext = {
        runId: input.runId,
        goal: input.controllerInput.goal,
        currentPhase: input.context.phase,
        evidence: { reason: input.context.reason, category: input.context.category, evidenceRefs: input.context.evidenceRefs ?? [] },
        attempt: input.context.attempt,
        maxAttempts: input.context.maxAttempts ?? input.controllerInput.policy?.maxAttempts ?? input.controllerInput.failureRecovery?.maxAttempts ?? 3,
        allowedNextPhases: [],
        constraints: { retryable: input.context.retryable, canRepair: input.context.canRepair ?? false, canRevise: input.context.canRevise ?? false },
      };
      if (input.checkpoint) {
        await writeRecoveryCheckpoint(input.runDir, { ...input.checkpoint, version: 1, createdAt: new Date().toISOString(), recoveryContext: input.context });
      }
      const decision = await requestRuntimePolicy({
        controllerInput: input.controllerInput,
        runDir: input.runDir,
        statePath: input.statePath,
        eventsPath: input.eventsPath,
        runId: input.runId,
        context: policyContext,
      });
      return { action: legacyMap(decision.action), feedback: decision.feedback, requestId: `policy-${input.runId}-${input.context.phase}-${input.context.attempt}`, attempt: decision.attempt, decidedAt: decision.decidedAt, nextPhase: decision.nextPhase };
    }

    function legacyMap(action: RuntimePolicyAction): FailureRecoveryAction {
      switch (action) {
        case "continue":
        case "retry": return "retry";
        case "revise": return "revise";
        case "repair": return "repair";
        case "rerunImplementation":
        case "abort": return "stop";
      }
    }
    ```
  * **Negative Paths:**
    * If `policyExecutor` is unset and `requestDecision` is unset, `requestRuntimePolicy` returns `abort` → legacy `stop`. Existing tests that omit both handlers keep their expectations.
    * If the LLM returns `continue` while the controller expects a transition, `legacyMap` translates to `retry` (continue re-enters the current sub-phase, which is what `retry` meant). The mapping is documented in `failure-recovery.ts` comments.
  * **Verification:** `npm run build` — PASS. `node --test tests/failure-recovery.test.mjs` — existing tests keep passing (action shape unchanged). `node --test tests/policy.test.mjs` — new shim tests pass.

* [ ] **Step 4: Wire `requestRuntimePolicy` into each phase**

  * **Files:**
    * `Modify: packages/core/src/runtime/planning-phase2.ts:140-168` (replace `requestFailureRecovery` call)
    * `Modify: packages/core/src/runtime/discovery-phase.ts:305-335` (same)
    * `Modify: packages/core/src/runtime/implementation-phase.ts:95-145` (same)
    * `Modify: packages/core/src/runtime/controller-integration.ts:65-95` (same)
    * `Modify: packages/core/src/runtime/verification-phase2.ts:175-205` (same)
    * `Modify: packages/core/src/runtime/verification-outcome.ts:39-100` (remove hard-coded terminal-state branch; route through `requestRuntimePolicy` with `evidence: { overallStatus, failureClassification, contractResult }` and `allowedNextPhases: ["implementation", "abort"]` when `overallStatus === "failed"`)
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:75-110, 220-260, 360-395, 460-510, 550-600` (replace five `requestFailureRecovery` calls with `requestRuntimePolicy`; the `if (false)` acceptance-blocked dead block at line 460 is removed)
    * `Modify: packages/core/src/runtime/controller-run.ts:152-180` (replace `MAX_REPLANS` constant; the planner-replan bound becomes a `RuntimePolicyConfig.maxAttempts` field with default 2; replan loop body stays the same, only the bound source changes)
    * `Modify: packages/core/src/runtime/landing.ts:110-145, 162-185, 290-330` (collapse three `landingRecovery` calls into a single `requestRuntimePolicy` call inside `runLandingFlow`; the helper `landingRecovery` becomes a private wrapper that delegates to `requestRuntimePolicy` for back-compat)
    * `Modify: packages/core/src/runtime/acceptance-phase.ts:1-95` (route `requestAcceptance` through `requestRuntimePolicy` when `policyExecutor` is set; fall back to existing handler otherwise)
    * `Modify: packages/core/src/runtime/plan-approval-phase.ts:55-115` (same pattern)
  * **Interfaces:** Consumes `requestRuntimePolicy`. Each call site constructs a `RuntimePolicyContext` with:
    * `currentPhase` = the current phase name (e.g., `"verification-blocked"`, `"landing-guard"`, `"acceptance"`).
    * `evidence` = the same evidence the existing `FailureRecoveryContext.reason` + relevant artifact paths contain.
    * `attempt` = the next attempt counter (`nextRecoveryAttempt(state, key)` plus 1, or 1 on first call).
    * `maxAttempts` = `input.controllerInput.policy?.maxAttempts ?? input.controllerInput.failureRecovery?.maxAttempts ?? 3`.
    * `allowedNextPhases` = the validator's default for the phase unless overridden by `policy.allowedPhasesByPhase`.
    * `constraints` = `{ retryable, canRepair, canRevise, hasRepairExecutor }` derived from input + config.
  * **Code (`landing.ts` `landing-guard` site):**
    ```ts
    // inside runLandingFlow, replacing the three landingRecovery call sites
    let guardAttempt = nextLandingRecoveryAttempt(input, "landing-guard");
    for (;;) {
      if (guardVerdict.ok) break;
      const decision = await requestRuntimePolicy({
        controllerInput: input.controllerInput,
        runDir: input.runDir,
        statePath: input.statePath ?? path.join(input.runDir, "state.json"),
        eventsPath: input.eventsPath,
        runId: input.runId,
        context: {
          runId: input.runId,
          goal: input.goal,
          currentPhase: "landing-guard",
          evidence: { guardReasons: guardVerdict.reasons, dirtyRelevantFiles: dirtyContext.relevant, dirtyUnrelatedFiles: dirtyContext.unrelated, plan: landingPlanArtifact },
          attempt: guardAttempt,
          maxAttempts: input.controllerInput.policy?.maxAttempts ?? input.controllerInput.failureRecovery?.maxAttempts ?? 3,
          allowedNextPhases: [],
          constraints: { canRepair: false, canRevise: true, dirtyRelevant: dirtyContext.relevant.length > 0, dirtyUnrelated: dirtyContext.unrelated.length > 0 },
        },
      });
      if (decision.action === "abort") {
        // Stop and publish blocked candidate.
        await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.guard_blocked_recorded", data: { reason: guardVerdict.reasons.join("; "), dirtyFiles: dirtyContext.relevant, unrelatedFiles: dirtyContext.unrelated } });
        const diagnosis = await diagnoseOrFallback({ executor, model: modelSelection?.model, plan, reason: guardVerdict.reasons.join("; "), dirtyFiles: dirtyContext.relevant, verification: input.verification, limits: input.config.runtime.limits });
        const pullRequest = await publishBlockedCandidate(input, guardVerdict.reasons.join("; "));
        return finishBlockedLanding(input, landingPlanArtifact, diagnosis, pullRequest?.reason ?? guardVerdict.reasons.join("; "), pullRequest);
      }
      const replanned = await buildLandingPlanWithRecovery(input, executor, modelSelection, dirtyContext, decision.feedback);
      plan = replanned.plan;
      guardVerdict = await validateLandingPlan({ /* unchanged */ });
      landingPlanArtifact = { ...plan, guardVerdict };
      await writePrototypeLandingPlanArtifact(input.runDir, landingPlanArtifact);
      await appendFactoryRunEvent(input.eventsPath, { timestamp: new Date().toISOString(), type: "landing.plan_selected", data: landingPlanArtifact as unknown as Record<string, unknown> });
      guardAttempt = nextLandingRecoveryAttempt(input, "landing-guard");
    }
    ```
    The same pattern applies to `landing-execution` (currentPhase: `"landing-execution"`) and `post-landing-verification` (currentPhase: `"post-landing-verification"`, `constraints.canRepair = Boolean(input.controllerInput.repairExecutor)`).
  * **Code (`verification-outcome.ts` — replaces the hard-coded terminal-state branch):**
    ```ts
    // packages/core/src/runtime/verification-outcome.ts:42-100 — full replacement
    export async function handleVerificationOutcome(state: VerificationOutcomeState): Promise<RunFactoryControllerResult | undefined> {
      const { run, input, verification, verificationFailureClassification } = state;
      const allFailuresBaseline = verification.overallStatus === "failed" && isIgnorableBaselineFailure(verificationFailureClassification);
      if (verification.overallStatus === "failed" && allFailuresBaseline) {
        await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: "verification.baseline_warning", data: { reason: verificationFailureClassification?.reason, perCommand: verificationFailureClassification?.perCommand } });
        await emitProgress(input, { runId: run.runId, phase: "verification", status: "RUNNING", message: `Verification warnings (baseline-unrelated): ${verificationFailureClassification?.reason ?? "pre-existing repo issues"}` });
        return undefined; // continue
      }
      if (verification.overallStatus === "failed") {
        const decision = await requestRuntimePolicy({
          controllerInput: input,
          runDir: run.runDir,
          statePath: run.statePath,
          eventsPath: run.eventsPath,
          runId: run.runId,
          context: {
            runId: run.runId,
            goal: input.goal,
            currentPhase: "verification",
            evidence: { overallStatus: verification.overallStatus, failureClassification: verificationFailureClassification, commandResults: verification.commands.map((c) => ({ name: c.name, status: c.status })) },
            attempt: 1,
            maxAttempts: input.policy?.maxAttempts ?? input.failureRecovery?.maxAttempts ?? 3,
            allowedNextPhases: ["implementation", "abort"],
            constraints: { canRepair: Boolean(input.repairExecutor), canRevise: true, hasRepairExecutor: Boolean(input.repairExecutor) },
          },
        });
        if (decision.action === "rerunImplementation") {
          // Trigger re-entry via the controller's onAcceptanceRevise hook shape.
          return buildPhaseFailureResult({ run, input, reason: decision.feedback ?? "re-enter implementation", phase: "implementation-reentry", executionCwd: state.executionCwd, worktree: state.worktree, planPath: state.planPath, taskPaths: state.taskPaths, discoveryExecutionPath: state.discoveryExecutionPath, plannerExecutionPath: state.plannerExecutionPath, builderExecutionPaths: state.builderExecutionPaths, integrationPath: state.integrationPath, repairExecutionPaths: state.repairExecutionPaths, reviewerExecutionPath: undefined, verificationPath: state.verificationPath, finalMergePath: undefined, candidateSha: undefined });
        }
        if (decision.action === "repair") {
          if (!input.repairExecutor) {
            // validator already rejected this; fail loud as a backup.
            throw new Error("policy returned 'repair' but no repairExecutor is configured");
          }
          // existing repair section flow continues here, unchanged
          return runVerificationRepairSection(state);
        }
        // abort or any other non-actionable decision: terminal FAILED
        return buildPhaseFailureResult({ /* existing failure result, unchanged */ });
      }
      return undefined;
    }
    ```
    The five `controller-final-phases.ts` sites and the seven other phase sites use the identical shape; the only differences are `currentPhase`, `evidence` payload, `constraints.canRepair`, and the post-decision handler. Each site must be edited; the builder does not need to read another step to apply the same change.
  * **Negative Paths:**
    * Policy executor returns `continue` in a phase that has no further work (e.g., after `verification.overallStatus === "failed"` and no repair): validator permits `continue` only when `nextPhase === currentPhase`. Otherwise re-prompts. This preserves the existing "stop if nothing to do" behavior.
    * Decision `abort` from the LLM: phase calls the same finalization code path as today's `stop` action; no silent continuation.
    * Decision `rerunImplementation` from `verification-outcome.ts`: triggers `onAcceptanceRevise`-style re-entry into the controller (`controller-run.ts:367-374` pattern); falls back to `abort` if no re-entry hook is configured.
    * Decision `repair` when no `repairExecutor`: validator rejects; re-prompt with constraint violation; LLM gets one chance to switch to a different action.
  * **Verification:** `npm run build` — PASS. `node --test tests/landing.test.mjs` — all existing landing tests still pass (recovery.action mapping preserved via `legacyMap`). `node --test tests/runtime.test.mjs` — existing runtime tests pass with the new policy executor optional input. `node --test tests/policy.test.mjs` — new policy tests pass.

* [ ] **Step 5: Add the optional `policyExecutor` input + config plumbing**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:140-160` (add `policyExecutor?: RuntimePolicyExecutor`, `policy?: RuntimePolicyConfig` to `RunFactoryControllerInput`)
    * `Modify: packages/core/src/runtime/harness.ts:1-90` (propagate `policyExecutor` and `policy` through the harness)
    * `Modify: packages/core/src/runtime/controller-setup.ts:90-180` (load `policy` config and resolve `policyModel` for the executor; pass `policyExecutor` from the harness if available)
    * `Modify: packages/schemas/src/config.ts:200-209, 280-300` (add `RuntimePolicyConfig` interface and `policy?` field on `GlobalFactoryConfig`, `ProjectFactoryConfig`, `EffectiveFactoryConfig`)
    * `Modify: packages/core/src/runtime/index.ts` (re-export `requestRuntimePolicy`, `verifyDecisionConstraints`, types from `policy.ts` and `policy-constraints.ts`)
  * **Interfaces:** Consumes nothing new. Produces:
    * `RuntimePolicyConfig` interface with fields `enabled?: boolean`, `maxAttempts?: number`, `allowedPhasesByPhase?: Record<string, string[]>`.
    * Default `RuntimePolicyConfig` lives in `controller-setup.ts` so the loader resolves it once per run.
    * `harness.ts` accepts `policyExecutor?: RuntimePolicyExecutor` and forwards it; `policyModel` is resolved via `resolveModelForRole({ role: "reviewer", taskType, config })` since the policy model reuses the reviewer role (per `factory-model-routing`).
  * **Code:**
    ```ts
    // packages/core/src/runtime/controller.ts:140
    export interface RuntimePolicyConfig {
      enabled?: boolean;
      maxAttempts?: number;
      allowedPhasesByPhase?: Record<string, string[]>;
    }

    // RunFactoryControllerInput
    policy?: RuntimePolicyConfig;
    policyExecutor?: RuntimePolicyExecutor;
    ```
    ```ts
    // packages/core/src/runtime/harness.ts — extends input type
    policyExecutor?: RuntimePolicyExecutor;
    policy?: RuntimePolicyConfig;
    // pass through:
    return runFactoryController({
      /* existing fields */,
      policyExecutor: input.policyExecutor,
      policy: input.policy,
    });
    ```
    ```ts
    // packages/schemas/src/config.ts — add to GlobalFactoryConfig and EffectiveFactoryConfig
    policy?: RuntimePolicyConfig;
    ```
  * **Negative Paths:**
    * `policy` undefined → `requestRuntimePolicy` uses `maxAttempts = 3` and `allowedPhasesByPhase = {}`. Existing behavior preserved.
    * `policy.enabled === false` → `requestRuntimePolicy` returns `abort` immediately. Existing non-interactive tests stay green.
    * `policyExecutor` defined but throws → caught in `requestRuntimePolicy`, event logged, `abort` returned.
  * **Verification:** `npm run build` — PASS. `npm run typecheck` — PASS (config schema additions are typed). `node --test tests/runtime.test.mjs` — PASS for new `policyExecutor` and `policy` config tests.

* [ ] **Step 6: Tests for the policy layer**

  * **Files:**
    * `Create: tests/policy.test.mjs:1-340`
    * `Modify: tests/failure-recovery.test.mjs:30-50, 110-180` (add tests asserting `requestFailureRecovery` returns a `RuntimePolicyDecision`-shaped result)
    * `Modify: tests/landing.test.mjs:600-840` (update the recovery-handler spy to expect `requestRuntimePolicy`-shaped decisions)
    * `Modify: tests/runtime.test.mjs` (add tests that exercise the `policyExecutor` input path end-to-end)
  * **Interfaces:** Uses `RuntimePolicyExecutor`, `RuntimePolicyContext`, `RuntimePolicyDecision`, `verifyDecisionConstraints` from `packages/core/dist/index.js`.
  * **Code:**
    ```ts
    // tests/policy.test.mjs
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import test from "node:test";
    import {
      createFactoryRun,
      readDecisionLedger,
      requestRuntimePolicy,
      verifyDecisionConstraints,
      type RuntimePolicyContext,
      type RuntimePolicyDecision,
      type RuntimePolicyExecutor,
    } from "../packages/core/dist/index.js";

    function makeContext(overrides: Partial<RuntimePolicyContext> = {}): RuntimePolicyContext {
      return {
        runId: "run-test",
        goal: "demo",
        currentPhase: "implementation",
        evidence: { reason: "x" },
        attempt: 1,
        maxAttempts: 3,
        allowedNextPhases: [],
        constraints: { canRepair: false, canRevise: true },
        ...overrides,
      };
    }

    test("verifyDecisionConstraints accepts permitted action in phase", () => {
      const ctx = makeContext({ currentPhase: "implementation" });
      assert.deepEqual(verifyDecisionConstraints({ action: "retry", attempt: 1, decidedAt: "now" }, ctx, undefined), { ok: true });
      assert.deepEqual(verifyDecisionConstraints({ action: "rerunImplementation", attempt: 1, decidedAt: "now" }, ctx, undefined), { ok: true });
      assert.deepEqual(verifyDecisionConstraints({ action: "abort", attempt: 1, decidedAt: "now" }, ctx, undefined), { ok: true });
    });

    test("verifyDecisionConstraints rejects action not permitted in phase", () => {
      const ctx = makeContext({ currentPhase: "acceptance" });
      const result = verifyDecisionConstraints({ action: "repair", attempt: 1, decidedAt: "now" }, ctx, undefined);
      assert.equal(result.ok, false);
      assert.match(result.reason, /action 'repair' is not permitted in phase 'acceptance'/);
    });

    test("verifyDecisionConstraints rejects attempt > maxAttempts", () => {
      const ctx = makeContext({ attempt: 4, maxAttempts: 3 });
      const result = verifyDecisionConstraints({ action: "retry", attempt: 4, decidedAt: "now" }, ctx, undefined);
      assert.equal(result.ok, false);
      assert.match(result.reason, /exceeds maxAttempts/);
    });

    test("verifyDecisionConstraints rejects revise without feedback", () => {
      const ctx = makeContext({ currentPhase: "implementation" });
      const result = verifyDecisionConstraints({ action: "revise", attempt: 1, decidedAt: "now" }, ctx, undefined);
      assert.equal(result.ok, false);
      assert.match(result.reason, /requires non-empty feedback/);
    });

    test("verifyDecisionConstraints rejects continue with non-current nextPhase", () => {
      const ctx = makeContext({ currentPhase: "implementation" });
      const result = verifyDecisionConstraints({ action: "continue", nextPhase: "review", attempt: 1, decidedAt: "now" }, ctx, undefined);
      assert.equal(result.ok, false);
      assert.match(result.reason, /continue.*may only stay/);
    });

    test("verifyDecisionConstraints honors config allowedPhasesByPhase", () => {
      const ctx = makeContext({ currentPhase: "verification", allowedNextPhases: [] });
      const config = { allowedPhasesByPhase: { verification: ["implementation"] } };
      const ok = verifyDecisionConstraints({ action: "retry", nextPhase: "implementation", attempt: 1, decidedAt: "now" }, ctx, config);
      assert.deepEqual(ok, { ok: true });
      const bad = verifyDecisionConstraints({ action: "retry", nextPhase: "review", attempt: 1, decidedAt: "now" }, ctx, config);
      assert.equal(bad.ok, false);
    });

    test("requestRuntimePolicy aborts when policy is disabled", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const decision = await requestRuntimePolicy({
        controllerInput: { cwd: root, goal: "demo", policy: { enabled: false } },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext(),
      });
      assert.equal(decision.action, "abort");
      assert.match(decision.feedback ?? "", /disabled/);
    });

    test("requestRuntimePolicy returns executor decision when valid", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const executor: RuntimePolicyExecutor = {
        async execute({ context }) {
          return { action: "retry", feedback: "fix the merge conflict", attempt: context.attempt, decidedAt: new Date().toISOString() };
        },
      };
      const decision = await requestRuntimePolicy({
        controllerInput: { cwd: root, goal: "demo", policyExecutor: executor },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext({ currentPhase: "landing_execution" }),
      });
      assert.equal(decision.action, "retry");
      assert.equal(decision.feedback, "fix the merge conflict");
      const ledger = await readDecisionLedger(run.runDir);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0].type, "resolution");
    });

    test("requestRuntimePolicy re-prompts on constraint violation then succeeds", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      let calls = 0;
      const executor: RuntimePolicyExecutor = {
        async execute({ context }) {
          calls += 1;
          if (calls === 1) {
            return { action: "repair", attempt: context.attempt, decidedAt: new Date().toISOString() }; // not permitted in 'acceptance'
          }
          return { action: "abort", attempt: context.attempt, decidedAt: new Date().toISOString() };
        },
      };
      const decision = await requestRuntimePolicy({
        controllerInput: { cwd: root, goal: "demo", policyExecutor: executor },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext({ currentPhase: "acceptance" }),
      });
      assert.equal(calls, 2);
      assert.equal(decision.action, "abort");
      const events = (await fs.readFile(run.eventsPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "policy.constraint_violation"));
      assert.ok(events.some((event) => event.type === "policy.re_prompted"));
    });

    test("requestRuntimePolicy fails loud after MAX_CONSTRAINT_VIOLATIONS", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const executor: RuntimePolicyExecutor = {
        async execute() {
          return { action: "repair", attempt: 1, decidedAt: new Date().toISOString() }; // never permitted in acceptance
        },
      };
      await assert.rejects(
        requestRuntimePolicy({
          controllerInput: { cwd: root, goal: "demo", policyExecutor: executor },
          runDir: run.runDir,
          statePath: run.statePath,
          eventsPath: run.eventsPath,
          runId: run.runId,
          context: makeContext({ currentPhase: "acceptance" }),
        }),
        /violated constraints/,
      );
    });

    test("requestRuntimePolicy aborts when attempt already exceeds maxAttempts", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const executorCalls: number[] = [];
      const executor: RuntimePolicyExecutor = {
        async execute({ context }) {
          executorCalls.push(context.attempt);
          return { action: "retry", attempt: context.attempt, decidedAt: new Date().toISOString() };
        },
      };
      const decision = await requestRuntimePolicy({
        controllerInput: { cwd: root, goal: "demo", policyExecutor: executor },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext({ currentPhase: "implementation", attempt: 5, maxAttempts: 3 }),
      });
      assert.equal(decision.action, "abort");
      assert.equal(executorCalls.length, 0, "executor must not be called when bound is already exceeded");
    });

    test("requestRuntimePolicy routes via requestDecision when no executor is set", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const decision = await requestRuntimePolicy({
        controllerInput: {
          cwd: root,
          goal: "demo",
          requestDecision: async (request) => ({
            requestId: request.id,
            optionId: "abort",
            feedback: "no executor configured",
            decidedAt: new Date().toISOString(),
          }),
        },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext(),
      });
      assert.equal(decision.action, "abort");
      assert.equal(decision.feedback, "no executor configured");
    });

    test("requestRuntimePolicy surfaces executor exception as abort", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "policy-"));
      const run = await createFactoryRun({ runsDir: path.join(root, ".factory/runs") });
      const executor: RuntimePolicyExecutor = {
        async execute() {
          throw new Error("LLM unreachable");
        },
      };
      const decision = await requestRuntimePolicy({
        controllerInput: { cwd: root, goal: "demo", policyExecutor: executor },
        runDir: run.runDir,
        statePath: run.statePath,
        eventsPath: run.eventsPath,
        runId: run.runId,
        context: makeContext(),
      });
      assert.equal(decision.action, "abort");
      assert.match(decision.feedback ?? "", /LLM unreachable/);
    });
    ```
  * **Negative Paths covered:**
    * Phase permits only `["abort"]` → executor returning `retry` is rejected, re-prompted.
    * `attempt > maxAttempts` → executor never called; `abort` returned.
    * Empty `evidence` → no constraint violation; test in `verification-outcome.ts` will assert the new code path passes a populated `evidence`.
    * `policyExecutor` throws → caught, logged, `abort` returned (no silent fallback).
  * **Verification:** `node --test tests/policy.test.mjs` — PASS for all 12 tests. `node --test tests/failure-recovery.test.mjs` — PASS (existing tests + new shim assertions). `node --test tests/landing.test.mjs` — PASS (existing tests pass because `landingRecovery` continues to return a `FailureRecoveryResolution`-shaped result via `legacyMap`). `node --test tests/runtime.test.mjs` — PASS for the new `policyExecutor` integration tests.

* [ ] **Step 7: Documentation and skill updates**

  * **Files:**
    * `Modify: docs/factory/concepts.md` (add a "Policy vs constraints" section explaining the LLM-owns-policy / controller-enforces-constraints split)
    * `Modify: docs/factory/workflow-authoring.md:81` (replace "controller-owned recovery gates" sentence with "LLM-owned policy gates enforced by the controller")
    * `Modify: .pi/skills/factory-concierge/SKILL.md` and `skills/factory-concierge/SKILL.md` (mirror the workflow-authoring change)
    * `Modify: learnings.md` (append: "Factory policy/constraint split: the LLM owns *what should happen* (retry/revise/repair/rerunImplementation/abort); Factory enforces only hard constraints (timeouts, decision schemas, retry budgets, dirty-worktree and Git safety, evidence requirements, persistence and resumability).")
  * **Interfaces:** Markdown only.
  * **Code:**
    ```md
    ## Policy vs constraints

    Every phase boundary hands control to the LLM via `requestRuntimePolicy`.
    The LLM returns one of `continue | retry | revise | repair | rerunImplementation | abort`
    plus optional `nextPhase` and `feedback`. `verifyDecisionConstraints` then
    validates the decision against hard constraints before the controller
    executes it. Resource limits, Git safety, evidence requirements, and
    persistence remain controller-enforced; the LLM cannot extend or override
    them.
    ```
  * **Negative Paths:** None — docs only.
  * **Verification:** `node scripts/complexity-guard.mjs` — PASS. Manual eyeball: confirm the new section names `RuntimePolicyAction` and `verifyDecisionConstraints` by name.

## 4. Testing

* **Unit tests:**
  * `verifyDecisionConstraints` matrix: 5 permitted actions × 5 phases + 5 failure cases (permitted action wrong phase, attempt out of range, revise empty feedback, continue wrong nextPhase, abort with nextPhase) — covered by `tests/policy.test.mjs`.
  * `requestRuntimePolicy` lifecycle: disabled → abort, executor success → decision persisted, executor with constraint violation → re-prompt + event, executor always violates → fail loud, attempt exceeds bound → no executor call, fallback via `requestDecision` → routed, executor throws → abort with feedback — covered by `tests/policy.test.mjs`.
* **Integration tests (existing files):**
  * `tests/failure-recovery.test.mjs` — assert `FailureRecoveryResolution` shape unchanged (action `retry | repair | revise | stop`, `feedback`, `requestId`).
  * `tests/landing.test.mjs` — assert the three landing sub-phases still produce the same recovery events when `policyExecutor` is unset.
  * `tests/runtime.test.mjs` — assert end-to-end run still completes without `policyExecutor` and pauses correctly when it is set.
* **End-to-end (manual / Harbor):**
  * Configure a `policyExecutor` that returns scripted decisions, run a synthetic failing run, assert state transitions and decision ledger entries match expectations.
* **Negative paths covered:**
  * `policyExecutor` throws → abort, event logged.
  * Decision violates constraints three times → fail loud.
  * Decision `continue` with non-current `nextPhase` → re-prompted.
  * Decision `abort` with `nextPhase` set → rejected by validator.
  * `attempt > maxAttempts` on entry → no executor call; abort.
  * `policy.enabled === false` → abort immediately.
  * Resource limits (tool/run timeouts) untouched.
* **Commands:**
  * `npm run build` (compile TypeScript so `packages/core/dist/runtime/policy.js` is current).
  * `node --test tests/policy.test.mjs` — all 12 tests PASS.
  * `node --test tests/failure-recovery.test.mjs` — existing + new tests PASS.
  * `node --test tests/landing.test.mjs` — existing 30+ tests PASS.
  * `node --test tests/runtime.test.mjs` — PASS.
  * `node --test tests/acceptance-phase.test.mjs` (if present) — PASS.
  * `npm run typecheck` — PASS.
  * `node scripts/complexity-guard.mjs` — PASS.
  * `npm run test` — full suite PASS.

## 5. Definition of Done

* [ ] `RuntimePolicyDecision`, `RuntimePolicyExecutor`, `RuntimePolicyContext`, `RuntimePolicyConfig` exported from `packages/core/dist/index.js`.
* [ ] `verifyDecisionConstraints` exists, is deterministic, and is the only path through which policy decisions become controller actions.
* [ ] Every controller decision site (planning, discovery, implementation, integration, verification-planning, verification outcome, review-unavailable, review-failed, verification-blocked, acceptance-blocked, acceptance, landing-guard, landing-execution, post-landing-verification, replan-bound) routes through `requestRuntimePolicy` or its thin shim `requestFailureRecovery`.
* [ ] `requestFailureRecovery` keeps its public shape (`FailureRecoveryAction`, `FailureRecoveryResolution`) via `legacyMap` so existing adapters (`packages/adapters/pi/src/decision-dialog.ts`, `tests/failure-recovery.test.mjs`) continue to compile.
* [ ] `policy.enabled === false` returns `abort` (preserves non-interactive runs).
* [ ] Resource limits, Git safety, evidence requirements, and persistence are controller-enforced; the LLM cannot extend or override them.
* [ ] Decision schema is validated; invalid decisions trigger up to `MAX_CONSTRAINT_VIOLATIONS + 1 = 3` re-prompts before failing loud.
* [ ] Decision ledger entries are written for every resolved policy decision so `/factory resume` continues to work.
* [ ] Tests pass: `node --test tests/policy.test.mjs`, `tests/failure-recovery.test.mjs`, `tests/landing.test.mjs`, `tests/runtime.test.mjs`.
* [ ] `npm run build` and `npm run typecheck` pass.
* [ ] `docs/factory/concepts.md`, `docs/factory/workflow-authoring.md:81`, `.pi/skills/factory-concierge/SKILL.md`, `skills/factory-concierge/SKILL.md`, and `learnings.md` document the LLM-owns-policy / controller-enforces-constraints split.
* [ ] No silent fallbacks introduced; every constraint violation is logged as `policy.constraint_violation` and every executor exception as `policy.executor_failed`.
* [ ] Migrations / config changes: optional `policy` field on `GlobalFactoryConfig`, `ProjectFactoryConfig`, `EffectiveFactoryConfig`, and `RunFactoryControllerInput`. Existing configs without the field behave identically to today.
