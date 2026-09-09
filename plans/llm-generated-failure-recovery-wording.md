# LLM-Generated Failure Recovery Wording

## 1. Understanding & Scope

* **Core Goal:**
  Replace the hardcoded English strings used for Factory's `RUNTIME / FAILURE_RECOVERY` decision prompts (the title, problem description, "what to do next" guidance, and option labels) with model-generated wording, while keeping the **option ids and the controller's recovery state machine deterministic and code-controlled**. The model only writes prose; the safety boundary (which actions are offered, when stop is terminal, when no recovery is allowed) stays in TypeScript.

* **Current Behavior:**
  * Recovery text is fully hardcoded in `packages/core/src/runtime/failure-recovery.ts:32-54`:
    - Option labels: `"I fixed it; retry this phase"` (line 34), `"Let Factory repair and retry"` (line 35), `"Revise with my guidance"` (line 36), `"Stop and preserve the failure"` (line 37).
    - Title: `` `Factory needs help: ${context.title}` `` (line 41).
    - Question body: `"Phase: …\nProblem: …\nCategory: …\nFix the issue if needed, then choose how Factory should continue."` (lines 42-46).
    - Context: `` `Recovery attempt ${attempt} of ${maxAttempts ?? 3}. Factory will not claim success without rerunning the affected phase.` `` (line 48).
  * All callers pass raw, deterministic `title` / `reason` strings (e.g. `landing.ts:125-142` builds the title from `guardVerdict.reasons`). No `AgentExecutor` is invoked for recovery wording.
  * `RunFactoryControllerInput.failureClassifierExecutor` exists at `packages/core/src/runtime/controller.ts:118` and is wired through the harness (`packages/core/src/runtime/harness.ts:31, 48`), but is only used for verification failure classification.
  * Existing recovery tests assert the exact hardcoded labels at `tests/pi-adapter.test.mjs:196-198, 209-210, 237-238` and `tests/failure-recovery.test.mjs:45-47` (question/option id shape).
  * `packages/adapters/pi/src/decision-dialog.ts:118-139` (`requestRuntimeRecoveryDecision`) renders the dialog purely from the decision request — no LLM involvement.

* **Target Behavior:**
  * For each `requestFailureRecovery` call, Factory invokes an LLM once (cached per `(runId, phase)`) to produce:
    - `title` (≤ 80 chars) — concise failure headline,
    - `problem` (≤ 600 chars) — plain-language explanation,
    - `howToRecover` (≤ 240 chars) — what the user should do,
    - Per-option `label` (≤ 60 chars) and optional `description` (≤ 200 chars) for each *enabled* option id.
  * The model output is sanitized: the model may only fill in prose for an option whose **id** is in the deterministic allowlist (`retry`, `repair`, `revise`, `stop`) and only when the corresponding `retryable`/`canRepair`/`canRevise` flag is `true`. It may never add, remove, or rename an option id. Sanitizer falls back to today's hardcoded strings on any parse / validation failure.
  * `RunFactoryControllerInput.failureClassifierExecutor` is reused as the executor (it is the only executor already designed to "look at a failure and explain it"). A new optional `failureRecoveryNarratorModel` is added to override the model used for recovery wording. If no executor is configured, the hardcoded fallback runs (no behavioral change for SDK/headless users).
  * The existing `shouldUseInteractiveRecovery` gate is preserved. Headless / no-handler runs continue to fail loud / stop silently without an LLM call.
  * No new action ids, no change to "Stop = terminal" semantics. The model cannot invent a "skip" or "auto" action.
  * **Custom user input is always available alongside the listed options.** When the user picks a custom input, the dialog returns `optionId: "custom"` and the typed text is carried in `feedback`. The controller routes the custom text to the same recovery handler as the standard options: it is treated as a guided `revise` (with the typed text becoming the guidance), the phase re-runs, and a fresh recovery dialog appears if the re-run still fails. The custom path never silently auto-approves, never bypasses the recovery state machine, and never reaches a terminal state in one step.
  * **Options surfaced to the user are LLM-generated** (not just the prose around them). The narrator emits 2–6 plain-English choices as `[A] ...`, `[B] ...`, etc., and the controller parses them via the same `parseInterviewQuestion` machinery used for the planning interview (`packages/core/src/decisions/question-options.ts:18-90`). Each parsed option carries (a) a short label and (b) an optional description. The controller **maps each generated option id back to a deterministic action** using a strict allowlist (`recovery` → `retry | repair | revise | stop`; `plan approval` → `approve | revise | reject`; `final approval` → `approve | revise | reject`; `dependency remediation` → `approve | reject`). Unmappable generated options are dropped (never executed). The "Custom answer…" entry remains code-controlled and is always appended at the end of the model-generated list so the user can always type free text. The user-facing options therefore look like the planning interview today, but every generated option is guaranteed to map to a code-controlled action before it can do anything.

* **Files Affected:**
  * `Create: packages/core/src/runtime/recovery-narrator.ts`
  * `Modify: packages/core/src/runtime/failure-recovery.ts:1-130`
  * `Modify: packages/core/src/runtime/index.ts:1-25`
  * `Modify: packages/core/src/runtime/controller.ts:93-126` (optional model config + custom-input routing)
  * `Modify: packages/adapters/pi/src/decision-dialog.ts:118-139` (recovery: renders "Custom answer…" entry, switches to a text input mode when chosen, returns `optionId: "custom"`)
  * `Modify: packages/adapters/pi/src/approval.ts:58-217` (plan approval: append "Custom answer…" to the dialog, capture free-text as `feedback`; final approval already accepts `FinalApprovalDecision` — extend the dialog to also surface "Custom answer…")
  * `Modify: packages/core/src/runtime/dependencies.ts` (`requestDependencyRemediation` returns `Promise<boolean | RemediationDecision>`; normalize helper)
  * `Modify: packages/adapters/pi/src/gateway-prototype.ts:259` (dependency remediation already passes through `ui.confirm`; route the custom-answer through a typed text path)
  * `Modify: packages/core/src/runtime/failure-recovery.ts:60-114` (`requestFailureRecovery` recognizes `optionId === "custom"` and reroutes to a guided retry)
  * `Modify: tests/failure-recovery.test.mjs:28-49, 189-202` (update assertions + add narrator tests)
  * `Modify: tests/pi-adapter.test.mjs:189-246` (Pi adapter dialog assertions for all surfaces)
  * `Modify: tests/pi-adapter.test.mjs` (append plan-approval, final-approval, and dependency-remediation custom-answer tests)
  * `Modify: docs/factory/troubleshooting.md:57-90`
  * `Modify: docs/factory/workflow-authoring.md:79-90`
  * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140`
  * `Modify: skills/factory-concierge/SKILL.md:120-140`
  * `Modify: learnings.md`

* **Out of Scope:**
  * Changing option ids or option-set composition logic (still deterministic per `FailureRecoveryContext` flags).
  * Changing "Stop" semantics. Stop remains terminal unless the existing per-phase loop chooses to retry.
  * Caching across runs (cache is per `(runId, phase)` only).
  * Streaming tokens into the dialog. The dialog only consumes the final decision request; partial output is discarded.
  * Switching the recovery executor away from `failureClassifierExecutor`. A future PR may introduce a dedicated `recoveryNarrator` slot, but this plan reuses what already exists.
  * Adding the LLM call inside the existing `ai-failure-classifier.ts` module. Recovery narrator is its own module so failure classification and recovery narration stay separately testable.
  * Free-form execution of the typed text as a shell command or arbitrary code. The custom input is plain guidance text, never executed. It is folded into the `revise` retry's `recoveryContext.feedback` exactly as today's `revise` flow handles feedback.
  * Offering a separate `cancel` or `abort` id. Esc / dismiss still maps to `stop` (terminal). The custom input is *only* a non-terminal "tell Factory what to do and rerun this phase" path.

### 1b. Decision-surfaces parity audit

The Factory controller surfaces four distinct decision points. The plan must bring every surface to the same custom-input contract so the user can always say "neither of those — do this instead."

| Surface | Decision function | Current option set | Custom input today? | Plan action |
|---|---|---|---|---|
| Recovery (`RUNTIME / FAILURE_RECOVERY`) | `RunFactoryControllerInput.requestDecision` | `retry` / `repair` / `revise` / `stop` (model-driven copy) | **No.** Hardcoded `requestRuntimeRecoveryDecision` only takes the listed options and an optional notes field. | Add "Custom answer…" → `optionId: "custom"` mapped to `revise` with feedback. (Steps 6b + 6c.) |
| Plan approval | `RunFactoryControllerInput.requestPlanApproval` | `approve` / `revise` / `reject` | **Partial.** `PlanApprovalResult.feedback` already exists, but the dialog does not surface a free-text input when the user selects `approve` or when the user picks "Custom answer…" before the choice. | Extend `PlanApprovalDialog` to append a "Custom answer…" choice that captures free-text guidance as `feedback` for any decision. The controller already routes `revise` with feedback correctly (no controller change). |
| Final approval | `RunFactoryControllerInput.requestApproval` | `approve` / `reject` (with `FinalApprovalDecision.decision` optional) | **Partial.** A reviewer-blocking verdict prompt already shows reviewer text, but there is no explicit "Custom answer…" path. The dialog can already receive `{ decision: "revise", feedback }` if the caller returns it. | Add a "Custom answer…" path that always returns `{ decision: "revise", feedback }`. The controller already accepts this (verified at `controller-final-phases.ts:572-595`). |
| Dependency remediation | `RunFactoryControllerInput.requestDependencyRemediation` | `boolean` (true → remediate, false → abort) | **No.** Today's implementation is a `confirm` prompt in `gateway-prototype.ts:259` with no notes. | Expand return type to `boolean \| RemediationDecision`, add `ui.input` capture for notes, and route to the remediation executor with the feedback. |

**Parity contract (applied uniformly):** every decision surface renders the listed options first, then a `Custom answer…` choice at the bottom. Selecting it opens a free-text prompt. Empty submission is treated as dismissal (no-op → current default). Non-empty submission is treated as a guided retry (`revise`-style): the typed text becomes `feedback`, the phase re-runs, and a fresh dialog appears if the retry still fails. None of the surfaces may silently auto-approve, none may bypass their existing state machine, and none may reach a terminal state in one step from the custom path.

## 2. Assumptions & Blockers

* **Assumptions:**
  * `RunFactoryControllerInput.failureClassifierExecutor` is populated by every interactive adapter (Pi and web) that today supplies `reviewerExecutor`. Verified at `packages/adapters/pi/src/gateway-prototype.ts:154-188` and `packages/core/src/runtime/harness.ts:31-48`. If a consumer sets only `requestDecision` and not the executor, the narrator falls back to hardcoded wording with no error.
  * The `AgentExecutor` interface already supports a strict "call once, get text back" pattern, modeled after `ai-failure-classifier.ts:97-110`. The narrator will reuse the same pattern.
  * `failureRecovery.enabled` continues to gate all recovery. New `failureRecovery.disabledNarrator?: boolean` lets consumers (e.g. tests, benchmarks) keep deterministic wording without disabling recovery itself.
  * Strict JSON parsing + sanitization is safe to be synchronous and inline; the executor's `outputText` is the only output we consume (same as `ai-failure-classifier.ts:111-115`).
  * Cache is per-process, per `(runId, phase)`. No disk caching. This is sufficient because each recovery request is created once per `(runId, phase)` pair inside a single controller run; the cache key uses the `runId` from `DecisionRequest.id` (`runId-recovery-<phase>-<attempt>`) and is keyed by `(runId, phase)` only.

* **Questions / Blockers:**
  * None blocking. Two design choices that need a confirm before code:
    1. Should the narrator be allowed to write per-option `label` strings, or should option labels remain deterministic (only title/problem/howToRecover are LLM-generated)? Plan currently allows both.
    2. Should the narrator use `failureClassifierExecutor` (recommanded, reuses existing wiring) or a new dedicated `recoveryNarratorExecutor` slot on `RunFactoryControllerInput`? Plan uses `failureClassifierExecutor` to avoid new wiring.

## 3. Implementation Plan

* [ ] **Step 1: Define the narrator contract and cache**

  * **Files:**
    * `Create: packages/core/src/runtime/recovery-narrator.ts`
    * `Modify: packages/core/src/runtime/index.ts:1-25`
  * **Interfaces:**
    * Consumes: `AgentExecutor`, `AgentExecutionInput`, `AgentExecutionResult` from `packages/core/src/runtime/interfaces.ts:1-52`. `RunFactoryControllerInput.failureClassifierExecutor` from `packages/core/src/runtime/controller.ts:118`. `FailureRecoveryContext` from `packages/core/src/runtime/failure-recovery.ts:9-20`. `parseInterviewQuestions`, `ParsedInterviewQuestion`, `DecisionOption` from `packages/core/src/decisions/question-options.ts:1-90` and `packages/core/src/decisions/types.ts:20-24`.
    * Produces:
      ```ts
      // packages/core/src/runtime/recovery-narrator.ts
      export type RecoveryOptionId = "retry" | "repair" | "revise" | "stop";
      export interface RecoveryOptionView { id: RecoveryOptionId; label: string; description?: string; }

      export interface RecoveryNarration {
        title: string;          // ≤ 80 chars
        problem: string;        // ≤ 600 chars
        howToRecover: string;   // ≤ 240 chars
        options: RecoveryOptionView[];   // 2–6 entries, all ids in the allowlist
      }

      export interface RecoveryNarratorInput {
        runId: string;
        phase: string;
        context: FailureRecoveryContext;
        enabledOptions: ReadonlyArray<RecoveryOptionId>;
        executor?: AgentExecutor;
        model?: { provider?: string; model: string };
        limits?: AgentExecutionInput["limits"];
      }

      export function buildRecoveryNarrationPrompt(input: RecoveryNarratorInput): string;
      export async function narrateRecovery(input: RecoveryNarratorInput): Promise<RecoveryNarration>;
      export function fallbackRecoveryNarration(context: FailureRecoveryContext): RecoveryNarration;
      ```
  * **Code:**
    ```ts
    // packages/core/src/runtime/recovery-narrator.ts (skeleton)
    import type { AgentExecutor, AgentExecutionInput } from "./interfaces.js";
    import type { FailureRecoveryContext } from "./failure-recovery.js";
    import { parseInterviewQuestion } from "../decisions/question-options.js";
    import type { DecisionOption } from "../decisions/index.js";

    export type RecoveryOptionId = "retry" | "repair" | "revise" | "stop";
    export interface RecoveryOptionView { id: RecoveryOptionId; label: string; description?: string; }

    const ALLOWED_OPTION_IDS: RecoveryOptionId[] = ["retry", "repair", "revise", "stop"];
    const LABEL_LIMITS = { title: 80, problem: 600, howToRecover: 240, label: 60, description: 200 };
    const MIN_OPTIONS = 2;
    const MAX_OPTIONS = 6;

    const cache = new Map<string, RecoveryNarration>();
    const cacheKey = (runId: string, phase: string) => `${runId}::${phase}`;

    export function buildRecoveryNarrationPrompt(input: RecoveryNarratorInput): string {
      const evidenceRefs = (input.context.evidenceRefs ?? []).slice(0, 8).join("\n  - ");
      return [
        "You are the Factory recovery narrator. Your ONLY job is to write concise English copy for a runtime recovery dialog.",
        "You never invent option ids, never change the enabled option set, never add or remove choices, never promise a fix.",
        "Each option you write MUST map to one of the allowed ids below. Options that don't map will be silently dropped.",
        "",
        "Return STRICT JSON only, no markdown, matching exactly this shape:",
        JSON.stringify({
          title: "≤ 80 chars",
          problem: "≤ 600 chars, plain-language explanation of the failure",
          howToRecover: "≤ 240 chars, what the user can do",
          questionBody: "≤ 1200 chars, the full text shown above the option list. Include 'Options:' followed by a list of '[id] Label — description' lines.",
          options: [
            { id: "retry", label: "≤ 60 chars", description: "≤ 200 chars optional" },
            { id: "stop",  label: "≤ 60 chars", description: "≤ 200 chars optional" },
          ],
        }),
        "",
        "Allowed option ids (you may write labels for any subset, but every id you emit MUST be in this list):",
        JSON.stringify(ALLOWED_OPTION_IDS),
        "Enabled options for this prompt (these are the only actions the controller can execute; others are dropped):",
        JSON.stringify(input.enabledOptions),
        "",
        "Format the questionBody using the same shape Factory uses for planning interviews:",
        "  <one short paragraph explaining the failure>",
        "  Options:",
        "  [retry] I fixed it; retry this phase — re-run this phase after your fix",
        "  [stop]  Stop and preserve the failure — pause the run, keep the artifacts",
        "",
        "Constraints:",
        "- Emit between " + MIN_OPTIONS + " and " + MAX_OPTIONS + " options (inclusive).",
        "- The id field of every option must be in the allowed list; anything else is dropped.",
        "- Order the options so the safest, least-disruptive choice appears first.",
        "- Always include an option whose id is 'stop' (the controller guarantees it regardless, but including it makes the dialog clearer).",
        "",
        "Inputs:",
        JSON.stringify({
          phase: input.phase,
          category: input.context.category,
          attempt: input.context.attempt,
          maxAttempts: input.context.maxAttempts ?? 3,
          reason: input.context.reason,
          evidenceRefs,
        }, null, 2),
      ].join("\n");
    }

    export async function narrateRecovery(input: RecoveryNarratorInput): Promise<RecoveryNarration> {
      const key = cacheKey(input.runId, input.phase);
      const cached = cache.get(key);
      if (cached) return cached;
      const fallback = fallbackRecoveryNarration(input.context, input.enabledOptions);
      if (!input.executor || input.enabledOptions.length === 0) {
        cache.set(key, fallback);
        return fallback;
      }
      const prompt = buildRecoveryNarrationPrompt(input);
      let outputText = "";
      try {
        const result = await input.executor.execute({
          executionId: `recovery-narrator-${Date.now()}`,
          cwd: process.cwd(),
          prompt,
          model: input.model,
          tools: [], // narrator is read-only; do not let it shell out
          limits: input.limits,
          metadata: { role: "reviewer", stage: "recovery-narration" },
        });
        outputText = result.outputText;
      } catch {
        cache.set(key, fallback);
        return fallback;
      }
      const narration = sanitizeNarration(parseStrictJson(outputText), input, fallback);
      cache.set(key, narration);
      return narration;
    }

    export function fallbackRecoveryNarration(
      context: FailureRecoveryContext,
      enabled: ReadonlyArray<RecoveryOptionId> = ALLOWED_OPTION_IDS,
    ): RecoveryNarration {
      const labels: Record<RecoveryOptionId, { label: string; description?: string }> = {
        retry:  { label: "I fixed it; retry this phase", description: "Re-run this phase after your fix." },
        repair: { label: "Let Factory repair and retry", description: "Let Factory diagnose and fix the failure automatically." },
        revise: { label: "Revise with my guidance",     description: "Re-run with your free-text guidance." },
        stop:   { label: "Stop and preserve the failure", description: "Pause the run and keep the artifacts." },
      };
      const seen = new Set<RecoveryOptionId>();
      const options: RecoveryOptionView[] = [];
      for (const id of enabled) {
        if (seen.has(id)) continue;
        seen.add(id);
        options.push(labels[id]);
      }
      if (!seen.has("stop")) options.push(labels.stop);
      return {
        title: `Factory needs help: ${context.title}`,
        problem: context.reason,
        howToRecover: "Fix the issue if needed, then choose how Factory should continue.",
        options,
      };
    }

    function parseStrictJson(outputText: string): Record<string, unknown> | undefined {
      const fenced = outputText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
      const raw = (fenced ?? outputText).trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end <= start) return undefined;
      try { return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>; } catch { return undefined; }
    }

    function sanitizeNarration(
      parsed: Record<string, unknown> | undefined,
      input: RecoveryNarratorInput,
      fallback: RecoveryNarration,
    ): RecoveryNarration {
      if (!parsed || typeof parsed !== "object") return fallback;
      const title = truncate(typeof parsed.title === "string" ? parsed.title : fallback.title, LABEL_LIMITS.title);
      const problem = truncate(typeof parsed.problem === "string" ? parsed.problem : fallback.problem, LABEL_LIMITS.problem);
      const howToRecover = truncate(typeof parsed.howToRecover === "string" ? parsed.howToRecover : fallback.howToRecover, LABEL_LIMITS.howToRecover);
      const rawOptions = Array.isArray(parsed.options) ? parsed.options.slice(0, MAX_OPTIONS) : [];
      const seen = new Set<RecoveryOptionId>();
      const options: RecoveryOptionView[] = [];
      for (const item of rawOptions) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const idRaw = typeof r.id === "string" ? r.id.toLowerCase() : "";
        const id = (ALLOWED_OPTION_IDS as string[]).includes(idRaw) ? (idRaw as RecoveryOptionId) : null;
        if (!id) continue; // unmapped ids are dropped silently
        if (!input.enabledOptions.includes(id)) continue; // disabled options are dropped
        if (seen.has(id)) continue;
        const labelRaw = typeof r.label === "string" ? r.label.trim() : "";
        const label = truncate(labelRaw || fallback.options.find((o) => o.id === id)?.label || id, LABEL_LIMITS.label);
        const description = typeof r.description === "string" && r.description.trim()
          ? truncate(r.description, LABEL_LIMITS.description)
          : undefined;
        options.push(description ? { id, label, description } : { id, label });
        seen.add(id);
      }
      // Guarantee the safe Stop option is present.
      if (!seen.has("stop")) {
        const stopFallback = fallback.options.find((o) => o.id === "stop") ?? { id: "stop", label: "Stop and preserve the failure" };
        options.push(stopFallback);
      }
      // Guarantee we always show at least MIN_OPTIONS options.
      if (options.length < MIN_OPTIONS) {
        for (const fallbackOption of fallback.options) {
          if (options.length >= MIN_OPTIONS) break;
          if (!seen.has(fallbackOption.id)) {
            options.push(fallbackOption);
            seen.add(fallbackOption.id);
          }
        }
      }
      return { title, problem, howToRecover, options };
    }

    function truncate(value: string, max: number): string {
      return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
    }

    export function __resetRecoveryNarratorCacheForTests(): void { cache.clear(); }
    ```
  * **Negative Paths:**
    * Executor throws, returns empty `outputText`, returns non-JSON, returns malformed JSON, returns an `options[].id` outside the allowlist, or returns fewer than `MIN_OPTIONS` usable options → return the deterministic `fallbackRecoveryNarration(context, enabledOptions)`. No exception is propagated.
    * Model omits the `stop` option → sanitizer re-inserts it so the controller never asks the user without a terminal escape hatch.
    * Model returns an option with an unmappable id (e.g. `id: "auto"`) → that entry is silently dropped; the sanitizer enforces the allowlist.
    * Model returns a label for a disabled option (e.g. `repair` when `canRepair === false`) → that entry is silently dropped; the deterministic option-set logic in `buildFailureRecoveryRequest` still controls which option *ids* appear.
    * `evidenceRefs` longer than 8 entries → truncate to the first 8 to keep the prompt bounded.
    * `enabledOptions` empty → skip the LLM call entirely and return fallback (which still contains `stop`).
    * Cache key collision across runs → impossible because keys are scoped by `runId` (every run gets a fresh id via `createFactoryRun`).
  * **Verification:**
    * `npm run build` — PASS. The new module is exported from `packages/core/src/runtime/index.ts` and the existing `node --test tests/failure-recovery.test.mjs` continues to pass (no callsite change yet).

* [ ] **Step 1b: Shared LLM-generated options helper**

  * **Files:**
    * `Modify: packages/core/src/runtime/recovery-narrator.ts` (add `narrateOptions` for non-recovery surfaces)
  * **Interfaces:**
    * Consumes: `AgentExecutor`, `AgentExecutionInput`, `DecisionOption` from `packages/core/src/runtime/interfaces.ts:1-52` and `packages/core/src/decisions/types.ts:20-24`. `parseInterviewQuestion` from `packages/core/src/decisions/question-options.ts:35-90`.
    * Produces:
      ```ts
      export type SurfaceOptionId = RecoveryOptionId | "approve" | "reject"; // union for all surfaces
      export interface SurfaceOptionsNarration<TSurface extends SurfaceOptionId> {
        title: string;
        body: string;        // ≤ 1200 chars, the "question" text above the option list
        options: DecisionOption[]; // 2–6 entries; ids are guaranteed to be in the supplied allowlist
      }
      export async function narrateOptions<TSurface extends SurfaceOptionId>(input: {
        surface: "plan-approval" | "final-approval" | "dependency-remediation";
        runId: string;
        title: string;
        context: Record<string, unknown>;        // surface-specific structured context
        allowedIds: ReadonlyArray<TSurface>;
        executor?: AgentExecutor;
        model?: { provider?: string; model: string };
        limits?: AgentExecutionInput["limits"];
        fallback: SurfaceOptionsNarration<TSurface>;
      }): Promise<SurfaceOptionsNarration<TSurface>>;
      ```
      The function builds the prompt using the same `Options:` / `[id] Label` shape that `parseInterviewQuestion` understands, calls the executor once, sanitizes the response (allowlist enforcement + `MIN_OPTIONS`/`MAX_OPTIONS` + per-field truncation), and falls back to the supplied `fallback` on any failure. The same shape is used by plan approval, final approval, and dependency remediation so all four surfaces share one LLM-options machinery.
  * **Code:**
    ```ts
    // packages/core/src/runtime/recovery-narrator.ts (additions)
    const SURFACE_LABEL_LIMITS = { title: 80, body: 1200, label: 60, description: 200 };
    const SURFACE_OPTION_BOUNDS = { min: 2, max: 6 };

    export async function narrateOptions<TSurface extends string>(input: {
      surface: string;
      runId: string;
      allowedIds: ReadonlyArray<TSurface>;
      context: Record<string, unknown>;
      executor?: AgentExecutor;
      model?: { provider?: string; model: string };
      limits?: AgentExecutionInput["limits"];
      fallback: SurfaceOptionsNarration<string>;
    }): Promise<SurfaceOptionsNarration<string>> {
      if (!input.executor || input.allowedIds.length === 0) return input.fallback;
      const prompt = [
        `You are the Factory ${input.surface} narrator.`,
        "Your ONLY job is to write 2–6 concise English choices for the user.",
        "Each option MUST have an id in this allowlist; anything else is dropped:",
        JSON.stringify(input.allowedIds),
        "",
        "Return STRICT JSON only, no markdown:",
        JSON.stringify({
          title: "≤ 80 chars",
          body: "≤ 1200 chars, full text shown above the option list. Include 'Options:' and '[id] Label — description' lines.",
          options: [{ id: "<allowlist>", label: "≤ 60 chars", description: "≤ 200 chars optional" }],
        }),
        "",
        "Inputs:",
        JSON.stringify(input.context, null, 2),
      ].join("\n");
      let outputText = "";
      try {
        const result = await input.executor.execute({
          executionId: `${input.surface}-narrator-${Date.now()}`,
          cwd: process.cwd(), prompt, model: input.model, tools: [],
          limits: input.limits,
          metadata: { role: "reviewer", stage: `${input.surface}-narration` },
        });
        outputText = result.outputText;
      } catch { return input.fallback; }
      const parsed = parseStrictJson(outputText);
      if (!parsed) return input.fallback;
      const title = truncate(typeof parsed.title === "string" ? parsed.title : input.fallback.title, SURFACE_LABEL_LIMITS.title);
      const body = truncate(typeof parsed.body === "string" ? parsed.body : input.fallback.body, SURFACE_LABEL_LIMITS.body);
      const rawOptions = Array.isArray(parsed.options) ? parsed.options.slice(0, SURFACE_OPTION_BOUNDS.max) : [];
      const seen = new Set<string>();
      const options: DecisionOption[] = [];
      for (const item of rawOptions) {
        if (!item || typeof item !== "object") continue;
        const r = item as Record<string, unknown>;
        const id = typeof r.id === "string" ? r.id.toLowerCase() : "";
        if (!(input.allowedIds as string[]).includes(id)) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const labelRaw = typeof r.label === "string" ? r.label.trim() : "";
        const label = truncate(labelRaw || id, SURFACE_LABEL_LIMITS.label);
        const description = typeof r.description === "string" && r.description.trim()
          ? truncate(r.description, SURFACE_LABEL_LIMITS.description) : undefined;
        options.push(description ? { id, label, description } : { id, label });
      }
      if (options.length < SURFACE_OPTION_BOUNDS.min) {
        for (const fallbackOption of input.fallback.options) {
          if (options.length >= SURFACE_OPTION_BOUNDS.min) break;
          if (!seen.has(fallbackOption.id)) {
            options.push(fallbackOption);
            seen.add(fallbackOption.id);
          }
        }
      }
      return { title, body, options };
    }
    ```
  * **Negative Paths:**
    * Executor throws, returns empty / non-JSON / malformed output → return `input.fallback`. No exception escapes.
    * Model returns an id outside the allowlist → silently dropped.
    * Model returns fewer than `MIN_OPTIONS` usable options → filled from the fallback list.
    * Truncation is applied to every text field so a runaway model output cannot bloat the dialog.
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/failure-recovery-narrator.test.mjs` — PASS (existing tests still pass; new tests for `narrateOptions` are added in Steps 6d/6e/6f).

* [ ] **Step 2: Wire narrator into `buildFailureRecoveryRequest`**

  * **Files:**
    * `Modify: packages/core/src/runtime/failure-recovery.ts:1-130`
  * **Interfaces:**
    * Consumes: `RecoveryNarratorInput`, `RecoveryNarration`, `fallbackRecoveryNarration`, `narrateRecovery`, all from Step 1.
    * Produces: same `buildFailureRecoveryRequest(runId, context)` signature, but the function becomes `async` and its return type becomes `Promise<DecisionRequest>`. `requestFailureRecovery` is updated to `await` the call.
    * Adds a small `FailureRecoveryConfig` extension at `packages/core/src/runtime/controller.ts:93-96`:
      ```ts
      export interface FailureRecoveryConfig {
        enabled?: boolean;
        maxAttempts?: number;
        /** When true, skip the LLM narrator and always use the deterministic fallback. Default: false. */
        disableNarrator?: boolean;
        /** Optional model override for the recovery narrator. Falls back to failureClassifierExecutor's default model. */
        narratorModel?: { provider?: string; model: string };
      }
      ```
  * **Code:**
    ```ts
    // packages/core/src/runtime/failure-recovery.ts (relevant edits)
    import { narrateRecovery, fallbackRecoveryNarration, type RecoveryNarration } from "./recovery-narrator.js";
    import type { AgentExecutor } from "./interfaces.js";

    const ENABLED_OPTION_IDS = (context: FailureRecoveryContext) => {
      const ids: Array<"retry" | "repair" | "revise" | "stop"> = [];
      if (context.retryable) ids.push("retry");
      if (context.canRepair) ids.push("repair");
      if (context.canRevise) ids.push("revise");
      ids.push("stop");
      return ids;
    };

    export async function buildFailureRecoveryRequest(
      runId: string,
      context: FailureRecoveryContext,
      narrator?: {
        executor?: AgentExecutor;
        model?: { provider?: string; model: string };
        limits?: import("./interfaces.js").AgentExecutionInput["limits"];
        disableNarrator?: boolean;
      },
    ): Promise<DecisionRequest> {
      const enabledOptions = ENABLED_OPTION_IDS(context);
      const narration: RecoveryNarration = narrator?.disableNarrator
        ? fallbackRecoveryNarration(context, enabledOptions)
        : await narrateRecovery({
            runId,
            phase: context.phase,
            context,
            enabledOptions,
            executor: narrator?.executor,
            model: narrator?.model,
            limits: narrator?.limits,
          });
      const options: DecisionOption[] = narration.options.map((entry) => ({
        id: entry.id,
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
      }));
      const question = [
        `Phase: ${context.phase}`,
        `Problem: ${truncate(narration.problem || context.reason, 1200)}`,
        `Category: ${context.category}`,
        narration.howToRecover,
      ].join("\n");
      return {
        id: `${runId}-recovery-${slug(context.phase)}-${context.attempt}`,
        title: truncate(narration.title || `Factory needs help: ${context.title}`, 120),
        question,
        context: `Recovery attempt ${context.attempt} of ${context.maxAttempts ?? 3}. Factory will not claim success without rerunning the affected phase.`,
        options,
        evidenceRefs: context.evidenceRefs ?? [],
        source: "RUNTIME",
        reason: "FAILURE_RECOVERY",
      };
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
      const maxAttempts = input.context.maxAttempts ?? input.controllerInput.failureRecovery?.maxAttempts ?? 3;
      if (!shouldUseInteractiveRecovery(input.controllerInput) || input.context.attempt > maxAttempts) {
        return { action: "stop", requestId: "" };
      }
      const context = { ...input.context, maxAttempts };
      const request = await buildFailureRecoveryRequest(input.runId, context, {
        executor: input.controllerInput.failureClassifierExecutor ?? input.controllerInput.reviewerExecutor,
        model: input.controllerInput.failureRecovery?.narratorModel,
        limits: input.controllerInput.failureRecovery?.narratorModel ? undefined : undefined,
        disableNarrator: input.controllerInput.failureRecovery?.disableNarrator === true,
      });
      // …rest unchanged, awaiting request via requestHumanDecision…
    }

    function truncate(value: string, max: number): string {
      return value.length <= max ? value : `${value.slice(0, max)}…`;
    }
    ```
  * **Negative Paths:**
    * `failureClassifierExecutor` is absent (e.g. headless test runner) → `narrateRecovery` is called with `executor: undefined`, the executor branch is skipped, and the deterministic `fallbackRecoveryNarration(context)` is used. No call to the model is made.
    * `failureRecovery.disableNarrator === true` → skip the narrator entirely; option labels and question text are the current hardcoded strings (no regression for benchmark/SDK users).
    * Model returns an option label that exceeds the per-field limits → truncator enforces the bound before the value reaches the user. No buffer overflow, no Unicode slicing (truncation is character-count on UTF-16 code units, which matches existing behavior at `failure-recovery.ts:120-122`).
    * Model returns empty `problem` → fall back to `context.reason` so the question never reads blank.
  * **Verification:**
    * `npm run typecheck` — PASS (signature change from sync to async is a breaking change handled in Step 3).
    * `npm run build` — PASS.
    * `node --test tests/failure-recovery.test.mjs` — PASS for the existing tests once they are updated to `await buildFailureRecoveryRequest(...)` in Step 4.

* [ ] **Step 3: Propagate `await` to all callsites**

  * **Files:**
    * `Modify: packages/core/src/runtime/landing.ts:125, 278, 370` (three `requestFailureRecovery` callsites)
    * `Modify: packages/core/src/runtime/controller-final-phases.ts:77, 225, 364, 478, 573` (five callsites)
    * `Modify: packages/core/src/runtime/controller-integration.ts` (callsites discovered via `rg "requestFailureRecovery"` — same `await` pattern)
    * `Modify: packages/core/src/runtime/discovery-phase.ts` (callsites discovered via `rg`)
    * `Modify: packages/core/src/runtime/planning-phase2.ts` (callsites discovered via `rg`)
    * `Modify: packages/core/src/runtime/verification-phase2.ts` (callsites discovered via `rg`)
  * **Interfaces:**
    * Consumes: same `requestFailureRecovery` signature; no new types.
    * Produces: no new types; every existing callsite changes `const recovery = await requestFailureRecovery({ ... })` (already awaited) so the *internal* `await buildFailureRecoveryRequest(...)` works transparently. **No code change required at callsites that already `await requestFailureRecovery`** — the await cascades internally. The only required change is to remove any direct sync call to `buildFailureRecoveryRequest` (only the test file uses it synchronously today).
  * **Code:**
    * No new snippets required. Each callsite already uses `await requestFailureRecovery(...)` (verified at `landing.ts:125, 278, 370` and `controller-final-phases.ts:77, 225, 364, 478, 573`). The internal `await` of `buildFailureRecoveryRequest` is invisible to them.
    * In any file that imports `buildFailureRecoveryRequest` outside `failure-recovery.ts` (none expected; grep target `rg -n "buildFailureRecoveryRequest" packages`), add `await` and make the enclosing function `async`. Search confirms there are no other consumers; the only one is `tests/failure-recovery.test.mjs:29, 132`.
  * **Negative Paths:**
    * If a hidden sync callsite exists, the TypeScript compiler errors with "Expected a Promise" — fail loud at build time. No runtime risk.
    * If `failureRecovery.disableNarrator === true`, the awaited function still resolves promptly with deterministic strings; no latency regression.
  * **Verification:**
    * `rg -n "buildFailureRecoveryRequest\\(" packages` returns zero hits outside `failure-recovery.ts` and the two test files.
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.

* [ ] **Step 4: Update existing tests for the narrator + add narrator-specific tests**

  * **Files:**
    * `Modify: tests/failure-recovery.test.mjs:28-49, 189-202` (existing shape tests)
    * `Modify: tests/pi-adapter.test.mjs:189-246` (Pi adapter dialog assertions)
    * `Test (add): tests/failure-recovery-narrator.test.mjs`
  * **Interfaces:**
    * Consumes: `RecoveryNarration`, `narrateRecovery`, `fallbackRecoveryNarration`, `__resetRecoveryNarratorCacheForTests`, `buildFailureRecoveryRequest` from Steps 1 and 2. Existing `AgentExecutor` shape from `packages/core/src/runtime/interfaces.ts:49-52`.
    * Produces: new tests asserting fallback equivalence, model-driven override, sanitizer rejection, option-id allowlist, cache behavior, and Stop-label preservation.
  * **Code (key additions; full file content is required at implementation time):**
    ```js
    // tests/failure-recovery.test.mjs (replace the sync assertion block)
    test('buildFailureRecoveryRequest produces a runtime recovery decision with bounded actions (narrator disabled)', async () => {
      __resetRecoveryNarratorCacheForTests();
      const request = await buildFailureRecoveryRequest(
        'run_1',
        {
          phase: 'verification-planning',
          title: 'verification planning failed',
          reason: 'Planner omitted all runnable commands',
          category: 'verification-planning',
          retryable: true,
          canRevise: true,
          canRepair: false,
          evidenceRefs: ['/tmp/run/verification-planner-execution.json'],
          attempt: 2,
          maxAttempts: 3,
        },
        { disableNarrator: true },
      );
      assert.equal(request.source, 'RUNTIME');
      assert.equal(request.reason, 'FAILURE_RECOVERY');
      assert.equal(request.id, 'run_1-recovery-verification-planning-2');
      assert.deepEqual(request.options.map((o) => o.id), ['retry', 'revise', 'stop']);
      assert.match(request.question, /Phase: verification-planning/);
      assert.match(request.context ?? '', /2 of 3/);
      assert.deepEqual(request.evidenceRefs, ['/tmp/run/verification-planner-execution.json']);
    });
    ```
    ```js
    // tests/failure-recovery-narrator.test.mjs (new file)
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import {
      __resetRecoveryNarratorCacheForTests,
      fallbackRecoveryNarration,
      narrateRecovery,
    } from '../packages/core/dist/index.js';

    const sampleContext = {
      phase: 'landing-planning',
      title: 'landing guard blocked the candidate',
      reason: 'Dirty target checkout overlaps landing files: package-lock.json, package.json',
      category: 'landing-guard',
      retryable: true,
      canRepair: false,
      canRevise: false,
      attempt: 1,
      maxAttempts: 3,
    };

    function makeExecutor(outputText) {
      return {
        async execute() {
          return { executionId: 'n', status: 'completed', outputText, events: [] };
        },
        async cancel() {},
      };
    }

    test('narrateRecovery falls back when executor is missing', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r1', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'], executor: undefined,
      });
      assert.equal(out.title, 'Factory needs help: landing guard blocked the candidate');
      const ids = out.options.map((o) => o.id).sort();
      assert.deepEqual(ids, ['retry', 'stop']);
    });

    test('narrateRecovery uses model output when executor returns valid JSON', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r2', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: makeExecutor(JSON.stringify({
          title: 'Landing blocked by local changes',
          problem: 'Two package files are dirty in your main checkout.',
          howToRecover: 'Stash or commit them, then ask Factory to retry.',
          options: [
            { id: 'retry', label: 'Re-run landing', description: 'Re-read dirty state' },
            { id: 'stop',  label: 'Pause here',     description: 'Save candidate and stop' },
          ],
        })),
      });
      assert.equal(out.title, 'Landing blocked by local changes');
      assert.match(out.problem, /dirty/);
      assert.equal(out.options.find((o) => o.id === 'retry')?.label, 'Re-run landing');
      assert.equal(out.options.find((o) => o.id === 'stop')?.label, 'Pause here');
    });

    test('narrateRecovery drops options whose ids are outside the allowlist', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r3', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: makeExecutor(JSON.stringify({
          title: 'x', problem: 'y', howToRecover: 'z',
          options: [
            { id: 'auto',    label: 'should be dropped' },
            { id: 'retry',   label: 're-run' },
            { id: 'stop',    label: 'stop now' },
          ],
        })),
      });
      const ids = out.options.map((o) => o.id);
      assert.deepEqual(ids, ['retry', 'stop']);
    });

    test('narrateRecovery preserves the deterministic Stop option when model omits it', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r4', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: makeExecutor(JSON.stringify({
          title: 't', problem: 'p', howToRecover: 'h',
          options: [{ id: 'retry', label: 'r' }],
        })),
      });
      const ids = out.options.map((o) => o.id);
      assert.ok(ids.includes('stop'));
      const stop = out.options.find((o) => o.id === 'stop');
      assert.match(stop?.label ?? '', /Stop/);
    });

    test('narrateRecovery falls back when executor throws', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r5', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: { async execute() { throw new Error('boom'); }, async cancel() {} },
      });
      const ids = out.options.map((o) => o.id).sort();
      assert.deepEqual(ids, ['retry', 'stop']);
    });

    test('narrateRecovery falls back when executor returns non-JSON', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r6', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: makeExecutor('sorry, I cannot help with that'),
      });
      const ids = out.options.map((o) => o.id).sort();
      assert.deepEqual(ids, ['retry', 'stop']);
    });

    test('narrateRecovery truncates over-length fields', async () => {
      __resetRecoveryNarratorCacheForTests();
      const long = 'x'.repeat(2000);
      const out = await narrateRecovery({
        runId: 'r7', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'stop'],
        executor: makeExecutor(JSON.stringify({
          title: long, problem: long, howToRecover: long,
          options: [{ id: 'retry', label: long, description: long }],
        })),
      });
      assert.ok(out.title.length <= 80);
      assert.ok(out.problem.length <= 600);
      assert.ok(out.howToRecover.length <= 240);
      for (const option of out.options) {
        assert.ok(option.label.length <= 60);
        if (option.description) assert.ok(option.description.length <= 200);
      }
    });

    test('narrateRecovery enforces MIN_OPTIONS=2 and MAX_OPTIONS=6', async () => {
      __resetRecoveryNarratorCacheForTests();
      const out = await narrateRecovery({
        runId: 'r8', phase: 'landing-planning', context: sampleContext,
        enabledOptions: ['retry', 'revise', 'stop'],
        executor: makeExecutor(JSON.stringify({
          title: 't', problem: 'p', howToRecover: 'h',
          options: [{ id: 'retry', label: 'only one' }],
        })),
      });
      assert.ok(out.options.length >= 2);
      assert.ok(out.options.length <= 6);
    });

    test('narrateRecovery caches by (runId, phase)', async () => {
      __resetRecoveryNarratorCacheForTests();
      let calls = 0;
      const executor = {
        async execute() {
          calls += 1;
          return { executionId: 'n', status: 'completed', outputText: JSON.stringify({
            title: 'cached', problem: 'p', howToRecover: 'h',
            options: [{ id: 'retry', label: 'r' }, { id: 'stop', label: 's' }],
          }), events: [] };
        },
        async cancel() {},
      };
      const base = { runId: 'r9', phase: 'p', context: sampleContext, enabledOptions: ['retry', 'stop'], executor };
      const a = await narrateRecovery(base);
      const b = await narrateRecovery({ ...base, runId: 'r9', phase: 'p' });
      const c = await narrateRecovery({ ...base, runId: 'r9', phase: 'different-phase' });
      assert.equal(a.title, 'cached');
      assert.equal(b.title, 'cached');
      assert.equal(calls, 2); // second call for the different phase
    });
    ```
    Update `tests/pi-adapter.test.mjs:189-246` to pass `disableNarrator: true` (or to construct a fake executor returning deterministic JSON) so the existing assertions about "I fixed it; retry this phase" remain valid when narrator is off, and add one new test that confirms LLM-generated labels flow through to the dialog:
    ```js
    // tests/pi-adapter.test.mjs (new test appended)
    test('runtime recovery decision uses model-generated labels when provided', async () => {
      const result = await requestDecisionInput(
        {
          notify() {}, setWidget() {},
          select: async (_t, options) => {
            assert.deepEqual(options, ['Re-run landing', 'Stop here']);
            return 'Re-run landing';
          },
          input: async () => '',
        },
        {
          id: 'run_1-recovery-landing-planning-1',
          title: 'Landing blocked by local changes',
          question: 'Phase: landing-planning\nProblem: Two package files are dirty\nCategory: landing-guard\nStash and retry.',
          options: [
            { id: 'retry', label: 'Re-run landing' },
            { id: 'stop', label: 'Stop here' },
          ],
          source: 'RUNTIME', reason: 'FAILURE_RECOVERY',
        },
      );
      assert.equal(result.optionId, 'retry');
    });
    ```
  * **Negative Paths:**
    * The existing tests must continue to pass with narrator disabled; `disableNarrator: true` is added to the synchronous shape assertions. The `runtime recovery decision captures selected action` test at `tests/pi-adapter.test.mjs:189` already constructs a `DecisionRequest` directly, so it does not call the narrator and needs no change. The two assertions on hardcoded labels at `tests/pi-adapter.test.mjs:196-198, 237-238` still pass because they construct the request explicitly.
    * New narrator tests assert fallback, sanitizer, truncation, cache behavior, and Stop-label preservation so any regression of the safety contract is caught.
  * **Verification:**
    * `npm run build` — PASS.
    * `node --test tests/failure-recovery-narrator.test.mjs` — PASS (8 new tests).
    * `node --test tests/failure-recovery.test.mjs` — PASS.
    * `node --test tests/pi-adapter.test.mjs` — PASS.

* [ ] **Step 5: Export and integration wiring**

  * **Files:**
    * `Modify: packages/core/src/runtime/index.ts:1-25`
  * **Interfaces:**
    * Consumes: `RecoveryNarration`, `RecoveryNarratorInput`, `buildRecoveryNarrationPrompt`, `narrateRecovery`, `fallbackRecoveryNarration`, `__resetRecoveryNarratorCacheForTests` from Step 1.
    * Produces: re-exports the narrator symbols so `import { narrateRecovery } from "../runtime/index.js"` (or the package root `index.js`) works for tests and adapters.
  * **Code:**
    ```ts
    // packages/core/src/runtime/index.ts (add to existing barrel)
    export {
      type RecoveryNarration,
      type RecoveryNarratorInput,
      buildRecoveryNarrationPrompt,
      narrateRecovery,
      fallbackRecoveryNarration,
      __resetRecoveryNarratorCacheForTests,
    } from "./recovery-narrator.js";
    ```
  * **Negative Paths:**
    * Existing consumers (`packages/core/dist/index.js`) compile before tests run (`npm run build`). Re-export is additive; no removal or rename.
  * **Verification:**
    * `npm run build` — PASS.
    * `grep -n "narrateRecovery" packages/core/dist/index.js` — non-empty.
    * `node --test tests/failure-recovery-narrator.test.mjs` — PASS.

* [ ] **Step 6b: Add a custom-answer option to the recovery dialog**

  * **Files:**
    * `Modify: packages/adapters/pi/src/decision-dialog.ts:118-139` (replace `requestRuntimeRecoveryDecision` with the new variant)
    * `Modify: tests/pi-adapter.test.mjs:189-246` (replace two existing tests + add two new ones)
  * **Interfaces:**
    * Consumes: `DecisionRequest`, `DecisionResult`, `FactoryPiUi`, `truncateStyledLine`, `wrapStyledLine`, `fixedHeightLines`, `overlayConfig`, `isPrintableInput`, `INTERVIEW_OVERLAY_HEIGHT` from `packages/adapters/pi/src/interview-dialog.ts:1-160, 180-330`. `DecisionOption` from `packages/core/src/decisions/types.ts:20-24`.
    * Produces: a new exported `requestRuntimeRecoveryDecision` that returns `{ requestId, optionId: "custom", feedback: "<text>", decidedAt }` when the user picks the custom entry and types a non-empty answer, or `{ requestId, optionId: "stop" }` when the user dismisses.
  * **Code:**
    ```ts
    // packages/adapters/pi/src/decision-dialog.ts (replacement for requestRuntimeRecoveryDecision)
    async function requestRuntimeRecoveryDecision(
      ui: FactoryPiUi,
      request: DecisionRequest,
    ): Promise<DecisionResult> {
      if (ui.custom) {
        return askRecoveryWithCustomOverlay(ui.custom, request);
      }
      // select + editor/input fallback
      if (ui.select) {
        const labels = [
          ...request.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label),
          "Custom answer…",
        ];
        const choice = await ui.select(request.question, labels);
        if (!choice) {
          return { requestId: request.id, optionId: "stop", decidedAt: new Date().toISOString() };
        }
        if (choice === "Custom answer…") {
          const typed = ui.editor
            ? await ui.editor(`${request.title}\n\n${request.question}\n\nTell Factory what to do:`, "")
            : (await ui.input?.("Recovery notes (free text)", "Tell Factory what to do")) ?? "";
          const trimmed = typed.trim();
          if (!trimmed) {
            return { requestId: request.id, optionId: "stop", decidedAt: new Date().toISOString() };
          }
          return { requestId: request.id, optionId: "custom", feedback: trimmed, decidedAt: new Date().toISOString() };
        }
        const option = request.options.find((candidate) =>
          choice === candidate.label || choice.startsWith(`${candidate.label} — `)
        );
        if (!option) {
          throw new Error(`Recovery decision '${request.id}' returned an unknown option.`);
        }
        const typed = (await ui.input?.("Recovery notes (optional)", "Tell Factory what you fixed or want changed")) ?? "";
        return {
          requestId: request.id,
          optionId: option.id,
          ...(typed.trim() ? { feedback: typed.trim() } : {}),
          decidedAt: new Date().toISOString(),
        };
      }
      // confirm-only fallback (preserved verbatim)
      if (ui.confirm) {
        const ok = await ui.confirm(
          "Factory decision required",
          `${request.question}\nOptions: ${request.options.map((o) => o.label).join(" | ")}`,
        );
        const option = request.options[0];
        if (!option) throw new Error(`Recovery decision '${request.id}' has no options.`);
        return ok ? { requestId: request.id, optionId: option.id, decidedAt: new Date().toISOString() } : { requestId: request.id, optionId: "stop", decidedAt: new Date().toISOString() };
      }
      throw new Error(`No decision UI available for decision '${request.id}'.`);
    }

    async function askRecoveryWithCustomOverlay(
      custom: NonNullable<FactoryPiUi["custom"]>,
      request: DecisionRequest,
    ): Promise<DecisionResult> {
      const customIndex = request.options.length;
      const result = await custom<DecisionResult | undefined>((tui, _theme, _keybindings, done) => {
        let selected = 0;
        let mode: "select" | "custom" = "select";
        let customAnswer = "";
        let scrollOffset = 0;
        const component = {
          render(width: number): string[] {
            const contentWidth = Math.max(24, width - 4);
            const questionLines = request.question.split(/\r?\n/).flatMap((line) => wrapStyledLine(line, contentWidth));
            const optionLines = [
              ...request.options.map((option, index) => {
                const marker = index === selected && mode === "select" ? "›" : " ";
                return `  ${marker} [${option.id.toUpperCase()}] ${option.label}`;
              }),
              `  ${selected === customIndex && mode === "select" ? "›" : " "} Custom answer…`,
            ];
            const customLines = mode === "custom"
              ? ["", "Custom answer", ...wrapStyledLine(`> ${customAnswer || ""}`, contentWidth)]
              : [];
            const footer = [
              "",
              mode === "custom"
                ? (customAnswer.trim()
                  ? "enter submit · ↑/↓ move · backspace edit · escape stop"
                  : "enter stop · type to answer · ↑/↓ move · backspace edit · escape stop")
                : "↑/↓ select · enter choose · escape stop",
            ];
            const allBody = [...questionLines, "", "Options", ...optionLines, ...customLines];
            const header = [request.title, ""];
            const availableRows = Math.max(3, INTERVIEW_OVERLAY_HEIGHT - header.length - footer.length - 2);
            const maxOffset = Math.max(0, allBody.length - availableRows);
            scrollOffset = Math.min(scrollOffset, maxOffset);
            const visible = allBody.slice(scrollOffset, scrollOffset + availableRows);
            const position = allBody.length > availableRows
              ? [`Showing ${scrollOffset + 1}-${Math.min(allBody.length, scrollOffset + availableRows)} of ${allBody.length}`, ""]
              : [];
            return fixedHeightLines([...header, ...position, ...visible, ...footer], contentWidth, INTERVIEW_OVERLAY_HEIGHT);
          },
          invalidate(): void {},
          handleInput(data: string): void {
            if (data === "\u001b") { done(undefined); return; }
            if (data === "\u001b[A") {
              if (mode === "select") selected = Math.max(0, selected - 1);
              tui.requestRender(); return;
            }
            if (data === "\u001b[B") {
              if (mode === "select") selected = Math.min(customIndex, selected + 1);
              tui.requestRender(); return;
            }
            if (data === "\r" || data === "\n") {
              if (mode === "custom") {
                const trimmed = customAnswer.trim();
                done(trimmed
                  ? { requestId: request.id, optionId: "custom", feedback: trimmed, decidedAt: new Date().toISOString() }
                  : undefined);
                return;
              }
              if (selected === customIndex) { mode = "custom"; tui.requestRender(); return; }
              const option = request.options[selected];
              if (option) {
                const feedback = (request.context ?? "") ? "" : ""; // typed feedback collected via ui.input after selection if host exposes it
                done({ requestId: request.id, optionId: option.id, decidedAt: new Date().toISOString(), ...(feedback ? { feedback } : {}) });
              }
              return;
            }
            if (mode === "custom") {
              if (data === "\u007f" || data === "\b") { customAnswer = customAnswer.slice(0, -1); tui.requestRender(); return; }
              if (isPrintableInput(data)) { customAnswer = `${customAnswer}${data}`; tui.requestRender(); }
            }
          },
        };
        tui.requestRender();
        return component;
      }, overlayConfig());
      if (!result) return { requestId: request.id, optionId: "stop", decidedAt: new Date().toISOString() };
      return result;
    }
    ```
    Helper imports reused from `interview-dialog.ts`: `INTERVIEW_OVERLAY_HEIGHT`, `isPrintableInput`, `fixedHeightLines`, `wrapStyledLine`, `overlayConfig`. Add them to the imports block at the top of `decision-dialog.ts`.
  * **Negative Paths:**
    * User picks Custom answer and submits empty text → treat as dismissal, return `optionId: "stop"` (terminal). This matches today's "esc → stop" behavior so users can always back out.
    * User picks a standard option, types notes, then submits → behavior unchanged (`optionId` from the selected option, `feedback` from the typed notes).
    * `ui.custom` not available but `ui.select` is → fallback path appends "Custom answer…" to the choices; if picked, prompts with `ui.editor` (preferred) or `ui.input`.
    * Only `ui.confirm` is available (last-resort path) → confirm maps to the first option; cancel maps to `stop`. No custom input in this last-resort path, matching today's behavior.
    * The typed text exceeds a sane length (e.g. 8000 chars) → truncate to 4000 chars before returning so a runaway paste cannot balloon the decision ledger. Implement via a `truncate` helper local to the file.
  * **Verification:**
    * `node --test tests/pi-adapter.test.mjs` — PASS.
    * The two updated tests assert: (a) standard option + typed notes yields `optionId: "retry"`, `feedback: "<trimmed text>"`; (b) dismissed custom (empty submit) yields `optionId: "stop"`.
    * The two new tests assert: (a) selecting "Custom answer…" in the `ui.custom` overlay and typing `rerun after I clean package files` yields `optionId: "custom"`, `feedback: "rerun after I clean package files"`; (b) picking a standard option and pressing Esc yields `optionId: "stop"` (matches today's terminal-stop behavior).

* [ ] **Step 6c: Route `optionId: "custom"` through the recovery state machine**

  * **Files:**
    * `Modify: packages/core/src/runtime/failure-recovery.ts:60-114` (recognize `optionId === "custom"` in `requestFailureRecovery`)
  * **Interfaces:**
    * Consumes: `DecisionResult` (`packages/core/src/decisions/types.ts:49-54`), `FailureRecoveryAction` (`packages/core/src/runtime/failure-recovery.ts:7`), `FailureRecoveryResolution` (`packages/core/src/runtime/failure-recovery.ts:22-26`).
    * Produces: a new exported `FailureRecoveryAction` member `"custom"`. The `requestFailureRecovery` resolver maps `optionId === "custom"` to `action: "revise"` (with `feedback: result.feedback`) so the existing per-phase recovery loops pick it up without code changes. This is the only place `custom` is normalized; downstream callers (landing, controller-final-phases, etc.) continue to handle `retry | repair | revise | stop` exactly as today.
  * **Code:**
    ```ts
    // packages/core/src/runtime/failure-recovery.ts
    export type FailureRecoveryAction = "retry" | "repair" | "revise" | "stop" | "custom";

    // Inside requestFailureRecovery, after result is obtained and `allowed` Set is built:
    const allowed = new Set([
      ...request.options.map((option) => option.id),
      // The recovery dialog always offers a "Custom answer…" entry; the resolver
      // maps it to a guided revise so existing recovery loops pick it up.
      "custom",
      // Esc / dismissed UI still maps to stop.
      "stop",
    ]);
    if (!allowed.has(result.optionId)) {
      // ... existing invalid-option branch
    }
    let action: FailureRecoveryAction;
    let feedback = result.feedback?.trim() || undefined;
    if (result.optionId === "custom") {
      action = "revise";
      // Empty feedback is treated as a no-op revise: fall back to stop so users
      // can never silently produce an empty revise (which would re-enter the same
      // failure). This matches the empty-custom-submit behavior in decision-dialog.ts.
      if (!feedback) action = "stop";
    } else if (result.optionId === "stop") {
      action = "stop";
    } else {
      action = result.optionId as FailureRecoveryAction;
    }
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.recovery_resolved",
      data: { decisionRequestId: result.requestId, phase: input.context.phase, action, attempt: input.context.attempt },
    });
    return { action, feedback, requestId: result.requestId };
    ```
  * **Negative Paths:**
    * Empty custom text → mapped to `stop` (terminal). No silent no-op revise.
    * Non-empty custom text → mapped to `revise`. Existing per-phase `if (recovery.action === "retry" || recovery.action === "revise") return runFinalPhases(state)` style loops already handle this, so the custom text becomes the guidance fed into the next phase attempt.
    * Custom path cannot promote to "approve" or any other behavior outside `retry | repair | revise | stop`. Sanitizer at the dialog layer enforces this.
    * Custom path is opt-out only via `failureRecovery.disableNarrator === true` → "Custom answer…" still renders; the option-set logic is independent of the narrator.
  * **Verification:**
    * `node --test tests/failure-recovery.test.mjs` — PASS with one new test "requestFailureRecovery maps a custom option to a revise with feedback".
    * `node --test tests/pi-adapter.test.mjs` — PASS with the four tests from Step 6b.

* [ ] **Step 6d: Plan approval dialog supports custom-answer input and LLM-generated options**

  * **Files:**
    * `Modify: packages/adapters/pi/src/approval.ts:58-217` (extend `PlanApprovalDialog` and `requestPlanApprovalDecision` to render a "Custom answer…" entry)
    * `Modify: tests/pi-adapter.test.mjs` (append three plan-approval tests)
  * **Interfaces:**
    * Consumes: `PlanApprovalResult`, `PlanApprovalDecision`, `PlanApprovalPreviewInput` from `packages/adapters/pi/src/approval.ts:1-21`. `FactoryPiUi` from `packages/adapters/pi/src/types.ts`. `narrateOptions`, `SurfaceOptionsNarration` from Step 1b.
    * Produces: `requestPlanApprovalDecision` accepts a `narrator?: { executor, model, disableNarrator }` parameter. When provided, it calls `narrateOptions({ surface: "plan-approval", allowedIds: ["approve","revise","reject"], ... })` to generate 2–6 user-facing choices mapped to those deterministic ids. The generated options are appended to the dialog; the controller still sees only `approve | revise | reject` ids. A "Custom answer…" entry is always appended after the model-generated list. Submitting non-empty custom text returns `{ decision: "revise", feedback: <text> }` (never `approve` or `reject`); empty text returns the existing dismiss path.
  * **Code:**
    ```ts
    // packages/adapters/pi/src/approval.ts (relevant edits)
    class PlanApprovalDialog {
      // Existing options plus a Custom answer entry:
      private readonly options: Array<{ label: string; decision: PlanApprovalDecision | "custom" }> = [
        { label: "Approve — Continue to implementation", decision: "approve" },
        { label: "Request revisions — Pause before implementation", decision: "revise" },
        { label: "Reject — Cancel the run", decision: "reject" },
        { label: "Custom answer…", decision: "custom" },
      ];
      // Existing handleInput: add a 'c' shortcut for "custom" and route the
      // selection index 3 (custom) to a feedback prompt. Esc still maps to dismiss.
    }

    async function requestPlanApprovalDecision(ui: FactoryPiUi, input: PlanApprovalPreviewInput): Promise<PlanApprovalResult> {
      // ... existing ui.custom branch: when dialog returns "custom", call
      //   ui.editor || ui.input and return { decision: "revise", feedback: <text> }
      // ... existing ui.select branch: append "Custom answer…" to the labels;
      //   if chosen, capture feedback and return { decision: "revise", feedback: <text> }
      // ... existing ui.confirm branch: unchanged (no custom-input escape hatch
      //   when only confirm is available, matching the recovery fallback).
    }
    ```
  * **Negative Paths:**
    * Custom-answer submission must never return `decision: "approve"`. The dialog normalizes the custom path to `decision: "revise"` regardless of what the user typed.
    * Empty submission returns the dismiss default (`decision: "revise"`, `feedback: "Plan decision dismissed; leaving run paused for human follow-up."`). No silent auto-approve.
    * Custom text is plain guidance, never executed. The controller feeds it into the planner revision path the same way today's `revise` feedback works.
    * When only `ui.confirm` is available (last-resort path), no custom input is offered; the behavior matches today.
  * **Verification:**
    * `node --test tests/pi-adapter.test.mjs` — PASS with three new tests:
      1. `plan approval custom answer returns revise with feedback` — `ui.custom` dialog picks "Custom answer…", types "use only Express middleware, no extra deps", submits, and the result is `{ decision: "revise", feedback: "use only Express middleware, no extra deps" }`.
      2. `plan approval select fallback routes custom answer to revise` — `ui.select` returns "Custom answer…"; `ui.input` returns typed text; result is `{ decision: "revise", feedback: <typed> }`.
      3. `plan approval dismissed custom yields paused-for-followup` — selecting "Custom answer…" then submitting empty text returns `{ decision: "revise", feedback: /dismissed/ }`.

* [ ] **Step 6e: Final approval dialog supports custom-answer input and LLM-generated options**

  * **Files:**
    * `Modify: packages/adapters/pi/src/approval.ts:300-440` (extend `requestFinalApprovalDecision` and any inline approval UI)
    * `Modify: tests/pi-adapter.test.mjs` (append two final-approval tests)
  * **Interfaces:**
    * Consumes: `FinalApprovalDecision`, `FinalApprovalReviewerVerdict`, `resolveFinalApprovalConfirm` from `packages/adapters/pi/src/approval.ts:299-340`. `FactoryPiUi`. `narrateOptions`, `SurfaceOptionsNarration` from Step 1b.
    * Produces: `requestFinalApprovalDecision` accepts a `narrator` parameter. When provided, it calls `narrateOptions({ surface: "final-approval", allowedIds: ["approve","revise","reject"], ... })` to generate 2–6 user-facing choices. The generated options are rendered above the "Custom answer…" entry. The controller only ever sees `approve | revise | reject` ids. The reviewer-blocking verdict is always rendered above the model-generated list. Submitting non-empty custom text returns `{ approved: false, decision: "revise", feedback: <text> }` (custom is never auto-approve).
  * **Code:**
    ```ts
    // packages/adapters/pi/src/approval.ts (extension)
    async function requestFinalApprovalDecision(ui: FactoryPiUi, input: FinalApprovalPreviewInput): Promise<FinalApprovalDecision> {
      if (ui.custom) {
        const result = await ui.custom<FinalApprovalDecision | undefined>((tui, theme, _kb, done) => {
          // Render: reviewer finding block + [Approve] [Reject] [Custom answer…]
          // Up/down navigation, enter to select. Esc maps to { approved: false, decision: "reject", feedback: "Approval dismissed." }.
          // "c" shortcut for custom.
        });
        // When result.decision === "custom", call ui.editor || ui.input and return
        // { approved: false, decision: "revise", feedback: <text> }.
      }
      if (ui.select) {
        const choice = await ui.select(/* title */, [
          "Approve — Approve the candidate",
          "Reject — Reject the candidate",
          "Custom answer…",
        ]);
        // If "Custom answer…", capture feedback and return { approved: false, decision: "revise", feedback }.
      }
      if (ui.confirm) {
        // Unchanged: confirm maps to { approved: true|false, decision: "approve"|"reject" }.
      }
    }
    ```
  * **Negative Paths:**
    * Custom-answer submission is always normalized to `decision: "revise"`. It cannot silently approve or reject.
    * Empty custom submission returns `{ approved: false, decision: "reject", feedback: "Approval dismissed." }` (same dismiss behavior as today).
    * Reviewer-blocking verdict is still surfaced above the option list; the user must acknowledge it before choosing. The dialog title reflects the block when `reviewerVerdict?.verdict === "block"`.
  * **Verification:**
    * `node --test tests/pi-adapter.test.mjs` — PASS with two new tests:
      1. `final approval custom answer routes to revise with feedback` — `ui.custom` picks "Custom answer…", types feedback, returns `{ approved: false, decision: "revise", feedback: <text> }`.
      2. `final approval select fallback routes custom answer to revise` — `ui.select` returns "Custom answer…"; typed feedback returned via `ui.input`.

* [ ] **Step 6f: Dependency remediation accepts custom-answer input and LLM-generated options**

  * **Files:**
    * `Modify: packages/core/src/runtime/dependencies.ts` (define `RemediationDecision`, expand `requestDependencyRemediation` return type, add `normalizeRemediationDecision`)
    * `Modify: packages/adapters/pi/src/gateway-prototype.ts:259` (route the call through `ui.input` and the shared `narrateOptions` helper)
    * `Modify: tests/pi-adapter.test.mjs` (append dependency-remediation tests)
  * **Interfaces:**
    * Consumes: `DependencyHydrationRemediationCandidate` from `packages/core/src/runtime/dependencies.ts`. `RunFactoryControllerInput.requestDependencyRemediation` from `packages/core/src/runtime/controller.ts:122`. `narrateOptions`, `SurfaceOptionsNarration` from Step 1b.
    * Produces:
      ```ts
      export interface RemediationDecision {
        approved: boolean;       // true = remediate, false = skip
        feedback?: string;
        decision?: "approve" | "reject" | "revise";
      }
      export function normalizeRemediationDecision(value: boolean | RemediationDecision): RemediationDecision;
      export type RemediationDecisionFn = (candidate: DependencyHydrationRemediationCandidate) => Promise<boolean | RemediationDecision>;
      ```
      `RunFactoryControllerInput.requestDependencyRemediation?: RemediationDecisionFn` (backward compatible — existing `Promise<boolean>` callers continue to work because `normalizeRemediationDecision` accepts both). The Pi adapter passes the same `narrator` config used by the recovery flow; `narrateOptions({ surface: "dependency-remediation", allowedIds: ["approve","reject"], ... })` produces 2–6 user-facing choices mapped to those ids. A "Custom answer…" entry is always appended. The remediation **never** auto-approves from custom text — `approved` is gated on the user's selection of an `approve` option, and custom input is treated as guidance, not approval.
  * **Code:**
    ```ts
    // packages/core/src/runtime/dependencies.ts
    export interface RemediationDecision {
      approved: boolean;
      feedback?: string;
      decision?: "approve" | "reject" | "revise";
    }

    export function normalizeRemediationDecision(value: boolean | RemediationDecision): RemediationDecision {
      if (typeof value === "boolean") {
        return { approved: value, decision: value ? "approve" : "reject" };
      }
      return {
        approved: value.approved,
        decision: value.decision ?? (value.approved ? "approve" : "reject"),
        feedback: value.feedback?.trim() || undefined,
      };
    }
    ```
    Pi adapter (`packages/adapters/pi/src/gateway-prototype.ts:259`):
    ```ts
    requestDependencyRemediation: async (candidate) => {
      const approved = await ui.confirm(
        `Remediate missing dependencies for ${candidate.kind}?`,
        /* body listing candidate actions */,
      );
      const feedback = await ui.input?.("Remediation notes (optional)", "Any guidance for the executor");
      return approved
        ? { approved: true, decision: "approve", ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) }
        : { approved: false, decision: "reject", ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) };
    },
    ```
  * **Negative Paths:**
    * Boolean-returning consumers continue to work because `normalizeRemediationDecision` accepts both.
    * Empty `feedback` is dropped; remediation proceeds with no notes.
    * Dismissed `ui.confirm` (false) returns `{ approved: false, decision: "reject" }` — same semantics as today's `false` return.
    * Remediation never auto-approves from custom text. `approved` is always tied to the boolean confirm result.
  * **Verification:**
    * `npm run build` — PASS (TypeScript type widening is backward compatible).
    * `node --test tests/pi-adapter.test.mjs` — PASS with one new test:
      1. `dependency remediation custom answer forwards feedback` — `ui.confirm` returns true, `ui.input` returns "use the system node", result is `{ approved: true, decision: "approve", feedback: "use the system node" }`.

* [ ] **Step 7: Documentation, skills, and learnings update**

  * **Files:**
    * `Modify: docs/factory/troubleshooting.md:57-90` (add a paragraph after the existing "recovery" line explaining that recovery wording is now LLM-generated with a deterministic fallback).
    * `Modify: docs/factory/workflow-authoring.md:79-90` (note that `failureRecovery.narratorModel` and `failureRecovery.disableNarrator` are available).
    * `Modify: .pi/skills/factory-concierge/SKILL.md:120-140` (one new sentence).
    * `Modify: skills/factory-concierge/SKILL.md:120-140` (mirror).
    * `Modify: learnings.md` (append a single-line entry under existing lessons).
  * **Interfaces:** No code changes.
  * **Code (documentation text, exact strings):**
    ```
    ### Failure Recovery Wording

    Factory's runtime recovery dialog is written by a small LLM narrator by default. The narrator owns prose only: title, problem description, how-to-recover guidance, and per-option labels. The option ids, the option set, and the controller state machine are deterministic code. If `failureRecovery.disableNarrator: true` is set or no `failureClassifierExecutor` is configured, Factory uses the deterministic fallback wording — no model call is made.

    The narrator is allowed to write labels only for option ids that the controller has already enabled. It cannot invent new option ids, change which actions are available, or skip the recovery loop. Any malformed, over-length, or out-of-bounds output is silently replaced with the deterministic fallback.
    ```
  * **Negative Paths:**
    * Documentation must not promise "no failures ever." It must state that hard safety limits and missing interactive handlers still fail loud, mirroring the existing wording in `plans/complete-interactive-failure-recovery-coverage.md`.
  * **Verification:**
    * `grep -n "narrator\|narratorModel\|disableNarrator" docs/factory/troubleshooting.md docs/factory/workflow-authoring.md .pi/skills/factory-concierge/SKILL.md skills/factory-concierge/SKILL.md learnings.md` returns at least one hit in each file.

## 4. Testing

* **Build, type-check, and complexity:**
  * `npm run build` — PASS.
  * `npm run typecheck` — PASS.
  * `npm run complexity` — PASS. The narrator module's two top-level functions stay under the complexity guard threshold; the sanitizer is broken into two helpers (`parseStrictJson`, `sanitizeNarration`) so neither `narrateRecovery` nor `sanitizeNarration` crosses the limit.
* **Targeted recovery tests:**
  * `node --test tests/failure-recovery-narrator.test.mjs` — PASS (8 tests: fallback, executor-present, option-id allowlist, Stop-label preservation, executor-throws, non-JSON, truncation, cache).
  * `node --test tests/failure-recovery.test.mjs` — PASS (existing tests updated to `await buildFailureRecoveryRequest(...)` with `disableNarrator: true`; option-set shape unchanged).
  * `node --test tests/pi-adapter.test.mjs` — PASS (existing tests construct `DecisionRequest` directly and bypass the narrator; one new test exercises model-generated labels end-to-end).
* **Regression:**
  * `node --test tests/runtime.test.mjs --test-name-pattern 'recovery|implementation|review|approval|landing'` — PASS.
  * `node --test tests/landing.test.mjs` — PASS.
  * `node --test tests/headless.test.mjs` — PASS (proves that without a decision handler or executor the deterministic fallback path is taken and headless behavior remains fail-loud).
* **Full suite:** `npm test` — PASS.

## 5. Definition of Done

* [ ] **Recovery narrator + LLM-generated options**: recovery dialog title, problem, how-to-recover guidance, **and the 2–6 user-facing choice labels** are produced by `narrateRecovery` when an executor is available. Every generated choice carries an id from the deterministic allowlist (`retry | repair | revise | stop`); unmappable ids are silently dropped. The deterministic fallback runs identically to today's wording when no executor is available, when `disableNarrator: true` is set, or when the model output fails to sanitize.
* [ ] **Recovery custom input**: selecting "Custom answer…" in the recovery dialog returns `optionId: "custom"`; the controller maps it to `action: "revise"` with the typed text as `feedback`. Empty custom text maps to `stop`. The custom path never auto-approves and never bypasses the recovery state machine.
* [ ] **Plan approval custom input + LLM-generated options**: `PlanApprovalDialog` renders 2–6 model-generated choices followed by "Custom answer…". Every generated id is in `{ approve, revise, reject }`; unmappable ids are dropped. Submitting non-empty custom text returns `{ decision: "revise", feedback: <text> }`; empty text returns the dismiss default. The custom path never returns `decision: "approve"` or `decision: "reject"`.
* [ ] **Final approval custom input + LLM-generated options**: `requestFinalApprovalDecision` renders 2–6 model-generated choices followed by "Custom answer…". Every generated id is in `{ approve, revise, reject }`; unmappable ids are dropped. Submitting non-empty custom text returns `{ approved: false, decision: "revise", feedback: <text> }`. Reviewer-blocking verdict is still surfaced above the option list. Empty custom text maps to dismiss.
* [ ] **Dependency remediation custom input + LLM-generated options**: `requestDependencyRemediation` accepts `Promise<boolean | RemediationDecision>` (backward compatible). The Pi adapter renders 2–6 model-generated choices followed by "Custom answer…" and forwards typed feedback to the remediation executor. Remediation never auto-approves from custom text.
* [ ] Negative paths behave correctly: model returns invalid JSON, throws, returns a label outside the allowlist, returns over-length text, returns an empty Stop label, or returns a label for a disabled option — all cases fall back to deterministic wording without throwing. Custom-answer empty submissions across all surfaces map to dismiss (no silent auto-approve).
* [ ] Tests pass (`npm test`).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Build passes (`npm run build`).
* [ ] Complexity guard passes (`npm run complexity`).
* [ ] Migrations / config changes are validated: `FailureRecoveryConfig` gains two new optional fields (`disableNarrator`, `narratorModel`); `requestDependencyRemediation` widens to `Promise<boolean | RemediationDecision>`; `requestPlanApproval` and `requestApproval` signatures unchanged (custom input is purely a dialog-level addition that maps to existing `revise` paths). No DB migration.
* [ ] Documentation updated: `docs/factory/troubleshooting.md`, `docs/factory/workflow-authoring.md`, `.pi/skills/factory-concierge/SKILL.md`, `skills/factory-concierge/SKILL.md`, `learnings.md` all reflect the LLM-generated wording and the four-surface custom-input contract.
