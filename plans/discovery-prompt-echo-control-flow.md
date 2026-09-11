# Discovery Prompt-Echo Control-Flow Fix

## 1. Understanding & Scope

* **Core Goal:**
  Factory's Discovery phase currently lets `looksLikePromptEcho` short-circuit the normal `parse → repair → fallback → fail` chain. When the model emits a prompt preamble followed by valid Discovery JSON, Factory (a) detects the echoed prompt, (b) skips the JSON-repair round-trip, (c) enters a deterministic fallback whose `evidence[]` is empty if the evidence packet has no snippets, and (d) fails the run with `Discovery failed: ...` before planning or implementation. The fix demotes echo detection to telemetry / repair-prompt strengthening so the normal recovery chain runs to completion. The validator's confirmed-evidence rule is preserved for genuinely successful Discovery results.

* **Current Behavior:** (with file:line evidence)
  * `packages/core/src/runtime/controller.ts:585-595` — `discoveryExecutor.execute(...)` returns the model's output.
  * `packages/core/src/runtime/controller.ts:599` — first `validateDiscoveryOutput(...)` attempt.
  * `packages/core/src/runtime/controller.ts:602-607` — `repairEligible` is true only when the reason is `"Discovery returned no output"` or `"Discovery returned invalid structured JSON"`. Semantic reasons (missing files, unobserved files, no confirmed evidence, `DISCOVERY_FAILED`) are deliberately not repair-eligible.
  * `packages/core/src/runtime/controller.ts:617-633` — inside `repairEligible`, `looksLikePromptEcho` is called. When it returns `true`, the `discoveryExecutor.execute({...repairPrompt...})` call is **skipped** and `discoveryValidation.reason` is rewritten to `"Discovery returned invalid structured JSON (prompt echo detected)"`.
  * `packages/core/src/runtime/controller.ts:636-660` — deterministic fallback runs `buildDeterministicDiscoveryContract(discoveryEvidence)` and re-validates. Its `evidence[]` is derived only from `packet.snippets` (controller.ts:3460-3474). Empty snippets → empty evidence → validator rejects with `"Discovery did not provide confirmed evidence tied to a concrete file"`.
  * `packages/core/src/runtime/controller.ts:662-677` — final fail: `state.status = FAILED`, `phase = discovery-failed`, throws `Discovery failed: ${discoveryValidation.reason}`.
  * `packages/core/src/runtime/controller.ts:3485-3492` — `looksLikePromptEcho` definition: split prompt on `\n{2,}`, keep paragraphs ≥ 40 chars, take first 3, and for any paragraph return true if `output.includes(chunk.trim().slice(0, 120))`. The probe is OR'd across paragraphs.
  * `packages/core/src/runtime/controller.ts:3797-3830` — `parseDiscoveryJson` and `discoveryJsonCandidates` already recover JSON from fences and from the slice between the first `{` and the last `}`. They cannot recover unfenced JSON that follows a prose preamble containing `{` (e.g. the prompt's JSON shape example).
  * `packages/core/src/runtime/controller.ts:3735-3777` — `sanitizeDiscoveryEvidence` already auto-corrects evidence paths by basename and warns-and-drops invalid files. The validator's permissiveness is intentionally already in place; the regression is control flow preventing useful model output from reaching that path.

* **Target Behavior:**
  * The Discovery flow is exactly `parse → validate → repair → fallback → fail` in that order, with **no** branch that exits the chain earlier.
  * `looksLikePromptEcho` is preserved for **telemetry** (`discovery.prompt_echo_detected` event) and optionally for **repair-prompt strengthening** (an extra instruction telling the model that its previous response started by echoing the prompt). It never short-circuits repair.
  * The reason string rewritten by echo detection today (`"Discovery returned invalid structured JSON (prompt echo detected)"`) is removed. Echoes fall through to `validateDiscoveryOutput`'s normal `"Discovery returned invalid structured JSON"` reason, which keeps repair eligible.
  * Confirmed-evidence validation stays strict for the success case: a Discovery contract that survives the chain must still satisfy `sanitizedEvidence.evidence.some(item.status === "confirmed" && isConcreteFile(item.file) && item.finding.trim())` (controller.ts:3533-3535).
  * The deterministic fallback stays as today: if its built contract passes validation, it is used (`usedDiscoveryFallback = true`). If it does not pass, the run fails loud with the original failure reason preserved verbatim.
  * Existing tests continue to pass: `tests/runtime.test.mjs:266` (prose-only), `:706` (unobserved files), `:754` (sanitized evidence), `:818` (no confirmed evidence), `:859` (`status: "failed"`).
  * Four new regression tests cover the user's scenarios.

* **Files Affected:**
  * `Modify: packages/core/src/runtime/controller.ts:617-633` (remove the short-circuit branch).
  * `Modify: packages/core/src/runtime/controller.ts:617-660` (reorder so repair always runs; emit a telemetry event when echo is detected; optionally strengthen the repair prompt).
  * `Modify: packages/core/src/runtime/controller.ts:610-616` (the repair prompt assembly — keep, with optional echo-aware note).
  * `Test: tests/runtime.test.mjs` (four new regression tests, see Step 5).
  * `Modify: learnings.md` (one new line documenting the control-flow invariant).

* **Out of Scope:**
  * Loosening `validateDiscoveryOutput` (controller.ts:3494) to accept evidence-free Discovery globally. The validator's strictness is intentional and is preserved.
  * Changing `looksLikePromptEcho`'s heuristic (the substring length, paragraph count, or threshold). The detector stays where it is; only its call sites change. Tightening the heuristic is a follow-up.
  * Reintroducing the `requestFailureRecovery` recovery loop on the active Discovery path. The bug does not require it; `failure-recovery.ts` and `recovery-narrator.ts` remain imported only by `implementation-phase.ts` and `verification-phase2.ts` (both active) and the dead `discovery-phase.ts` / `controller-run.ts`.
  * Modifying dead modules (`packages/core/src/runtime/controller-run.ts`, `controller-interview.ts`, `controller-helpers.ts`, `controller-setup.ts`, `controller-final-phases.ts`, `controller-integration.ts`, `plan-approval-phase.ts`, `implementation-phase.ts`, `verification-phase2.ts`, `planning-phase2.ts`, `discovery-phase.ts`, `task-utils.ts`, `discovery-validate.ts`). They contain a parallel implementation that no live code imports; editing them would be invisible to users.
  * Adding new JSON extraction candidates to `discoveryJsonCandidates` (controller.ts:3809) to handle unfenced JSON after a `{`-bearing preamble. The plan does not require this; the control-flow fix alone resolves the regression's reported symptom. (See Assumptions.)

## 2. Assumptions & Blockers

* **Assumptions:**
  * The four scenarios the user lists are exactly the cases the plan must cover: (a) echo + valid JSON tail → success, (b) echo + malformed JSON → repair attempted, (c) repair fails → deterministic fallback, (d) snippet-less fallback → explicit, non-misleading outcome.
  * The active runtime is the `controller.ts` monolith. The plan does not touch dead modules.
  * `looksLikePromptEcho` can be retained for telemetry without changing its body. The two new call sites (event emission, optional repair-prompt note) consume the same boolean return value.
  * `parseDiscoveryJson` recovers JSON after prose when (i) the model's real JSON is in a fenced code block, or (ii) the preceding prose contains no `{`. For the reported scenario where the prose contains a `{` (e.g. the prompt's inline JSON shape example), the control-flow patch alone may still not recover the tail — see Questions / Blockers.
  * `tests/runtime.test.mjs:266` continues to pass because its fixture prose (`"I will inspect the repository now."`) does not trip echo detection and does not parse as JSON; the existing `repairEligible` path runs once and fails; no behavior change applies.
  * `buildDeterministicDiscoveryContract`'s evidence construction (`controller.ts:3458-3483`) stays exactly as today. The plan only changes the surrounding control flow; the fallback's strictness is preserved.
  * The snippet-less fallback path produces a contract with `unknowns: [...]` and an empty `evidence[]`. The validator rejects that contract because no confirmed evidence is present; the run fails loud. This is "handled explicitly" — the failure is observable via `discovery.used_fallback: false`, the existing `discovery.invalid_output` event, and `state.status === "FAILED"` / `phase === "discovery-failed"`. The user accepts this as non-misleading because the contract is never adopted.

* **Questions / Blockers:**
  * **None blocking.** The plan is implementable with current schemas and APIs.
  * **Open issue for follow-up (not a blocker):** the discovery prompt at `controller.ts:4062-4071` contains a `{...}` JSON shape example, and the repair prompt at `controller.ts:610` contains an inline `Shape: {...}` example. When a model echoes the prompt and then writes its real JSON inline after the echoed preamble, `discoveryJsonCandidates` produces candidate 4 spanning the prompt example's `{` to the model's final `}`, which is invalid JSON, and no other candidate isolates the real object. A small additional extraction step (e.g. a "last `{`-to-last `}` slice" or a regex-based "answer JSON after the last `---`") would address this. Out of scope for this plan; the control-flow fix alone restores the regression for any case where `parseDiscoveryJson` succeeds.

## 3. Implementation Plan

* [ ] **Step 1: Reorder the active Discovery flow so echo detection never short-circuits repair**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:602-660`

  * **Interfaces:**
    * Consumes: existing local `looksLikePromptEcho` (`controller.ts:3485`), `validateDiscoveryOutput` (`controller.ts:3494`), `buildDeterministicDiscoveryContract` (`controller.ts:3458`), `parseDiscoveryJson` (`controller.ts:3797`), `discoveryJsonCandidates` (`controller.ts:3809`), `appendFactoryRunEvent` (`controller.ts:51`), `appendModelLedgerEntry` (`../runs/model-ledger.js`).
    * Produces: an updated Discovery block in `runFactoryControllerInner` with the chain `parse → validate → repair (always when repair-eligible) → fallback → fail`. Echo detection emits a telemetry event but does not skip repair.

  * **Code (replacement for the existing block at controller.ts:599-660):**
    ```ts
    discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
    let discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
    // LLM repair pass: only for model-compliance failures (no output / invalid
    // JSON). Semantic failures (missing files, unobserved files, no evidence,
    // explicit DISCOVERY_FAILED) fail loud — re-prompting cannot fix those.
    const repairEligible = !discoveryValidation.ok
      && (discoveryValidation.reason === "Discovery returned no output"
        || discoveryValidation.reason === "Discovery returned invalid structured JSON");
    let repairArtifactPath: string | undefined;
    let promptEchoDetected = false;
    if (repairEligible) {
      // Echo detection is telemetry only. It must NEVER skip repair: a model
      // that paraphrases the prompt preamble and then emits valid JSON must
      // reach the repair pass so the JSON can be parsed (and, if needed,
      // repaired). Echo detection may also append a note to the repair prompt
      // so the model knows not to repeat itself.
      promptEchoDetected = looksLikePromptEcho(
        discoveryResult.outputText,
        buildDiscoveryPrompt(input.goal, discoveryGuidance.text, renderSkillBundleForPrompt(discoverySkills), discoveryEvidence),
      );
      if (promptEchoDetected) {
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "discovery.prompt_echo_detected",
          data: {
            stage: "discovery-initial",
            outputPreview: discoveryResult.outputText.slice(0, 400),
          },
        });
      }
      const repairPrompt = [
        "Your previous response was not valid structured JSON, so it was rejected.",
        ...(promptEchoDetected
          ? [
              "",
              "Your previous response began by echoing the Discovery instructions. Do not re-state them.",
              "Respond with the DiscoveryContract JSON only — no prose, no markdown fences, no preamble.",
            ]
          : []),
        "",
        "Convert it into the required DiscoveryContract JSON and respond with JSON only — no prose, no markdown fences.",
        'Shape: {"status":"complete","files":["path/to/file"],"evidence":[{"status":"confirmed","file":"path","finding":"..."}],"unknowns":[],"summary":"..."}',
        "Every file must exist in the evidence packet. Status must be complete or failed.",
        "",
        "Your previous response:",
        discoveryResult.outputText.slice(0, 6000),
      ].join("\n\n");
      const repair = await discoveryExecutor.execute({
        executionId: `${run.runId}-discovery-repair`,
        cwd: executionCwd,
        prompt: repairPrompt,
        model: discoveryModel.model,
        tools: [],
        limits: loaded.effectiveConfig.runtime.limits,
        metadata: { role: "discovery", stage: "discovery-json-repair", runId: run.runId },
      });
      repairArtifactPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, { ...repair, executionId: `${run.runId}-discovery-repair` }, "repair");
      discoveryValidation = await validateDiscoveryOutput(repair.outputText, executionCwd, discoveryEvidence);
    }
    // Deterministic fallback: after attempt + repair fail, build a safe contract
    // from the already-collected evidence packet instead of failing the run.
    // The fallback is only adopted if its contract passes the same strict
    // validator; otherwise the run fails loud with the original reason.
    let usedDiscoveryFallback = false;
    if (!discoveryValidation.ok) {
      const fallbackReason = discoveryValidation.reason;
      const fallbackContract = buildDeterministicDiscoveryContract(discoveryEvidence);
      const fallbackValidation = await validateDiscoveryOutput(JSON.stringify(fallbackContract), executionCwd, discoveryEvidence);
      if (fallbackValidation.ok) {
        usedDiscoveryFallback = true;
        discoveryValidation = fallbackValidation;
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "discovery.used_fallback",
          data: {
            reason: fallbackReason,
            fallbackFiles: fallbackContract.files?.length ?? 0,
            fallbackEvidence: fallbackContract.evidence?.length ?? 0,
          },
        });
      } else {
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "discovery.fallback_rejected",
          data: {
            reason: fallbackReason,
            fallbackRejectReason: fallbackValidation.reason,
            fallbackFiles: fallbackContract.files?.length ?? 0,
            fallbackEvidence: fallbackContract.evidence?.length ?? 0,
          },
        });
      }
    }
    ```

    Notes on what changed vs. the prior code:
    * The `else { discoveryValidation = { ok: false, reason: "...prompt echo detected" }; }` branch is **removed**. Echo detection now only emits the `discovery.prompt_echo_detected` event and conditionally appends a note to the repair prompt; the repair `execute(...)` call always runs when `repairEligible` is true.
    * `discoveryValidation.reason` is **never rewritten** by echo detection. The throw at `:677` keeps the original validator reason (`"Discovery returned invalid structured JSON"` or `"Discovery returned no output"`).
    * A new `discovery.fallback_rejected` event is emitted when the fallback's contract is itself rejected by the validator (e.g. snippet-less packet). This makes the "snippet-less fallback handled explicitly" requirement observable in logs without weakening validation.

  * **Negative Paths:**
    * Echo detected, JSON tail parses cleanly on first attempt → `repairEligible` is `false` (validation already succeeded) → no repair round-trip; no behavior change vs. today.
    * Echo detected, JSON tail parses after repair → `repairEligible` is `true` → telemetry event emitted → repair runs → validation succeeds → no further action.
    * Echo detected, repair returns malformed JSON → `discoveryValidation` remains `ok: false` with the validator's reason → fallback runs → fallback either adopts (used_fallback) or fails loud (fallback_rejected event).
    * Echo detected, snippet-less packet → same as above; fallback's evidence is empty → fallback fails validation → `discovery.fallback_rejected` event → run fails loud at `:677`.
    * No echo detected, no JSON → existing behavior: `repairEligible` true, repair runs once, fails, fallback runs, run fails loud. Matches `tests/runtime.test.mjs:266`.
    * `DISCOVERY_FAILED:` reason → `repairEligible` is `false` (semantic reason) → no repair, no fallback, run fails loud. Matches `tests/runtime.test.mjs:859+`.
    * Semantic failure (missing files / unobserved files / no confirmed evidence) → `repairEligible` is `false` → no repair, no fallback, run fails loud. Matches `tests/runtime.test.mjs:706`, `:818`.

  * **Verification:**
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.
    * `node --test --test-name-pattern 'invalid discovery output|unobserved files|sanitizes invalid evidence|no confirmed evidence|explicit discovery failure' tests/runtime.test.mjs` — PASS for the existing five tests; their reasons and counts are unchanged because their fixtures do not exercise the echo short-circuit.

* [ ] **Step 2: Add `discovery.prompt_echo_detected` and `discovery.fallback_rejected` to the recognized event vocabulary**

  * **Files:**
    * `Modify: packages/core/src/runs/store.ts` (event types are untyped today; the change is purely behavioral — no source change. The two event names appear for the first time in `controller.ts` and must be observable in the test harness's `events.jsonl`.)
    * No source change required; verification checks that the events are written.

  * **Interfaces:**
    * Consumes: `appendFactoryRunEvent` (already used at `controller.ts:51`).
    * Produces: two new event types whose presence is verified in Step 5.
      * `discovery.prompt_echo_detected` — emitted from Step 1 when `looksLikePromptEcho(...)` returns `true`.
      * `discovery.fallback_rejected` — emitted from Step 1 when the deterministic fallback's contract is itself rejected by `validateDiscoveryOutput`.

  * **Negative Paths:** none; events are append-only.

  * **Verification:**
    * `grep -rn "discovery\\.prompt_echo_detected\|discovery\\.fallback_rejected" packages/core/src/runtime/controller.ts` returns the two `appendFactoryRunEvent` call sites added in Step 1.

* [ ] **Step 3: No-op safety check on `usedDiscoveryFallback`**

  * **Files:**
    * `Modify: packages/core/src/runtime/controller.ts:638` (existing declaration).

  * **Interfaces:**
    * Consumes: existing `usedDiscoveryFallback` flag.
    * Produces: the variable continues to be set only when the fallback is adopted. No semantic change; this step exists to make the verification grep explicit.

  * **Negative Paths:** none.

  * **Verification:**
    * `grep -n "usedDiscoveryFallback" packages/core/src/runtime/controller.ts` — three matches (declaration, assignment, event emission), unchanged.

* [ ] **Step 4: Add `discovery.prompt_echo_detected` regression tests**

  * **Files:**
    * `Test: tests/runtime.test.mjs` (append four tests in the existing free-form `test(...)` block).

  * **Interfaces:**
    * Consumes: `runRuntimeHarness`, `withTempProject`, `readJson`, `makeExecutor`, `path`, `fs`, `assert` (already imported at `tests/runtime.test.mjs:1-10`).
    * Produces four tests, each with full body:

    ```js
    test('discovery prompt echo followed by valid JSON succeeds without falling back', async () => {
      await withTempProject(async (root) => {
        // buildDiscoveryPrompt's first ≥40-char paragraph begins with "Your job is to identify..."
        // — long enough to satisfy looksLikePromptEcho's substring probe. The model then
        // emits fenced JSON that parseDiscoveryJson recovers.
        const echoedPromptText = [
          "Your job is to identify the concrete repository files/components/data/config surfaces needed for a separate Planning phase.",
          "You are in Discovery only. Use the repository evidence packet as authoritative filesystem truth.",
          "",
          "```json",
          JSON.stringify({
            status: "complete",
            files: ["src/index.ts"],
            evidence: [{ status: "confirmed", file: "src/index.ts", finding: "entry point" }],
            unknowns: [],
          }, null, 2),
          "```",
        ].join("\n");

        const calls = [];
        const discoveryExecutor = {
          async execute(input) {
            calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
            return {
              executionId: input.executionId,
              status: 'completed',
              outputText: echoedPromptText,
              events: [],
            };
          },
          async cancel() {},
        };
        const plannerExecutor = makeExecutor('planner', calls);

        await runRuntimeHarness({
          cwd: root,
          goal: 'Add a demo feature',
          discoveryExecutor,
          plannerExecutor,
          requestPlanApproval: async () => ({ decision: 'approve' }),
          requestApproval: async () => true,
        });

        // Discovery should succeed on the first attempt (parseDiscoveryJson recovers
        // the fenced JSON). Repair must NOT run because repairEligible is false.
        assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
        assert.ok(calls.some((call) => call.label === 'planner'), 'planner must run after successful discovery');

        const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
        const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
        const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
        assert.ok(events.some((l) => /discovery\.prompt_echo_detected/.test(l)), 'echo telemetry must be emitted');
      });
    });

    test('discovery prompt echo followed by malformed JSON still attempts repair', async () => {
      await withTempProject(async (root) => {
        // Echo + JSON without a closing brace → parseDiscoveryJson returns undefined.
        // Echo short-circuit MUST NOT skip the repair round-trip.
        const echoedMalformed = [
          "Your job is to identify the concrete repository files/components/data/config surfaces needed for a separate Planning phase.",
          "You are in Discovery only.",
          "",
          "{ this is not valid json",
        ].join("\n");

        let repairCalled = false;
        const discoveryExecutor = {
          async execute(input) {
            const label = /-repair/.test(input.executionId) ? 'repair' : 'discovery';
            if (label === 'repair') repairCalled = true;
            return {
              executionId: input.executionId,
              status: 'completed',
              // Repair still returns prose (still no JSON). The chain must end at fallback.
              outputText: label === 'repair' ? 'Still no JSON.' : echoedMalformed,
              events: [],
            };
          },
          async cancel() {},
        };
        const plannerExecutor = makeExecutor('planner', () => {});

        await assert.rejects(
          () => runRuntimeHarness({
            cwd: root,
            goal: 'Add a demo feature',
            discoveryExecutor,
            plannerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          }),
          /Discovery failed: Discovery returned invalid structured JSON/,
        );

        assert.ok(repairCalled, 'repair must run even when the first response looked like an echo');
      });
    });

    test('discovery repair failure falls through to the deterministic fallback', async () => {
      await withTempProject(async (root) => {
        // Seed the repo with a file that matches the goal's terms, so the
        // evidence packet contains a snippet and the deterministic fallback
        // produces a contract with confirmed evidence.
        await fs.writeFile(path.join(root, 'src/index.ts'), 'export const demo = "demo-feature entry";\n');

        const discoveryExecutor = {
          async execute(input) {
            return {
              executionId: input.executionId,
              status: 'completed',
              outputText: 'no json anywhere',
              events: [],
            };
          },
          async cancel() {},
        };
        const plannerExecutor = makeExecutor('planner', () => {});

        await runRuntimeHarness({
          cwd: root,
          goal: 'Add demo feature',
          discoveryExecutor,
          plannerExecutor,
          requestPlanApproval: async () => ({ decision: 'approve' }),
          requestApproval: async () => true,
        });

        const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
        const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
        const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
        assert.ok(events.some((l) => /discovery\.used_fallback/.test(l)), 'fallback must be adopted');
        assert.ok(!events.some((l) => /discovery\.invalid_output/.test(l)), 'run must not fail loud');
      });
    });

    test('discovery snippet-less fallback is rejected explicitly instead of silently passing', async () => {
      await withTempProject(async (root) => {
        // Goal's terms ("xyzzy") match no repo path → packet.snippets is empty
        // and packet.candidateFiles is empty → fallback's evidence[] is empty.
        // The validator rejects the fallback contract. The run must fail loud
        // and emit discovery.fallback_rejected.
        const discoveryExecutor = {
          async execute(input) {
            return {
              executionId: input.executionId,
              status: 'completed',
              outputText: 'no json anywhere',
              events: [],
            };
          },
          async cancel() {},
        };
        const plannerExecutor = makeExecutor('planner', () => {});

        await assert.rejects(
          () => runRuntimeHarness({
            cwd: root,
            goal: 'xyzzy plugh',
            discoveryExecutor,
            plannerExecutor,
            requestPlanApproval: async () => ({ decision: 'approve' }),
            requestApproval: async () => true,
          }),
          /Discovery failed: Discovery returned invalid structured JSON/,
        );

        const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
        const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
        const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).split(/\r?\n/);
        assert.ok(
          events.some((l) => /discovery\.fallback_rejected/.test(l)),
          'snippet-less fallback must surface as discovery.fallback_rejected, not be silently adopted',
        );
        assert.ok(!events.some((l) => /discovery\.used_fallback/.test(l)), 'fallback must NOT be adopted');
        assert.ok(events.some((l) => /discovery\.invalid_output/.test(l)), 'final discovery failure must still be emitted');
      });
    });
    ```

  * **Negative Paths:**
    * Each test is independent. If `npm test` runs them in parallel across separate temp dirs (`withTempProject` creates its own dir), state isolation is guaranteed. No ordering dependency.
    * If a future change adds new `discovery.*` events, the regexes above match a stable substring and remain valid.

  * **Verification:**
    * `node --test tests/runtime.test.mjs --test-name-pattern 'discovery prompt echo followed by valid JSON|discovery prompt echo followed by malformed JSON|discovery repair failure falls through|discovery snippet-less fallback is rejected'` — PASS for all four new tests.

* [ ] **Step 5: Update learnings with the control-flow invariant**

  * **Files:**
    * `Modify: learnings.md` (append one bullet)

  * **Interfaces:**
    * Consumes: existing file content (`learnings.md`).
    * Produces (append a new bullet at the end of the file):
      ```markdown
      - Discovery's `looksLikePromptEcho` heuristic must never skip the parse → repair → fallback chain. Echo detection is telemetry only; the validator's confirmed-evidence rule is intentionally strict for successful Discovery contracts.
      ```

  * **Negative Paths:** none.

  * **Verification:**
    * `grep -n "looksLikePromptEcho heuristic must never skip" learnings.md` returns one match.

* [ ] **Step 6: Full verification**

  * **Files:** none.
  * **Interfaces/Code:** none.
  * **Negative Paths:**
    * `looksLikePromptEcho` continues to be the only heuristic for prompt-echo detection; the chain tolerates false positives by still attempting repair.
    * The `DISCOVERY_FAILED:` early-return at `controller.ts:3502` is unchanged. Semantic failures are still not repair-eligible.
    * The dead modules (`discovery-phase.ts`, `controller-run.ts`, `discovery-validate.ts`, `task-utils.ts`, `controller-interview.ts`, `controller-helpers.ts`, etc.) are unchanged; nothing imports them.

  * **Verification:**
    * `npm run build` — PASS.
    * `npm run typecheck` — PASS.
    * `npm run complexity` — PASS.
    * `node --test --test-name-pattern 'invalid discovery output|unobserved files|sanitizes invalid evidence|no confirmed evidence|explicit discovery failure|discovery prompt echo|discovery repair failure|discovery snippet-less fallback' tests/runtime.test.mjs` — PASS for all nine tests (five existing, four new).
    * `node --test tests/runtime.test.mjs` — PASS (full suite).
    * `node --test tests/decision.test.mjs` — PASS (no change).
    * `node --test tests/pi-adapter.test.mjs` — PASS (no change).
    * `npm test` — PASS.
    * Manual smoke: run a Factory session whose Discovery model echoes the prompt preamble and then emits a fenced JSON contract; observe `discovery.prompt_echo_detected` followed by `discovery.executor_completed` (no repair call), and the planner runs.

## 4. Testing

* **Regression first — existing five tests must continue to pass:**
  * `tests/runtime.test.mjs:266` `invalid discovery output fails loudly before planning` — prose-only response; expects `Discovery failed: Discovery returned invalid structured JSON`, 2 discovery calls (initial + repair), 0 planner calls, `FAILED`/`discovery-failed`. The fixture prose is short and does not trip echo detection, so the existing `repairEligible → repair → fail` chain runs unchanged.
  * `tests/runtime.test.mjs:706` `discovery with existing but unobserved files fails loudly before planning` — semantic reason; not repair-eligible; fails loud.
  * `tests/runtime.test.mjs:754` `discovery sanitizes invalid evidence paths without failing planning` — JSON parses, `sanitizeDiscoveryEvidence` corrects basename; validation succeeds. Confirms the permissive path still works.
  * `tests/runtime.test.mjs:818` `discovery with no confirmed evidence fails loudly before planning` — only inferred evidence; semantic reason; not repair-eligible; fails loud.
  * `tests/runtime.test.mjs:859` `explicit discovery failure stops before planning` — `status: "failed"`; semantic reason; fails loud.

* **New tests (Step 4) cover the four required scenarios:**
  1. `discovery prompt echo followed by valid JSON succeeds without falling back` — fences the JSON inside the echoed preamble so `parseDiscoveryJson` recovers it; asserts `repair` does **not** run, `planner` does run, and `discovery.prompt_echo_detected` is emitted.
  2. `discovery prompt echo followed by malformed JSON still attempts repair` — proves the short-circuit is gone; asserts `repair` is called and the chain ends at the validator's reason.
  3. `discovery repair failure falls through to the deterministic fallback` — seeds `src/index.ts` so the packet has a snippet; asserts `discovery.used_fallback` and that `discovery.invalid_output` is **not** emitted.
  4. `discovery snippet-less fallback is rejected explicitly instead of silently passing` — uses a goal whose terms match no repo path; asserts `discovery.fallback_rejected` is emitted, `discovery.used_fallback` is not, and `discovery.invalid_output` is still emitted.

* **Full-suite:** `npm test` — PASS.

## 5. Definition of Done

* [ ] Required behavior works: when `looksLikePromptEcho` returns true, the Discovery chain still attempts repair; the reason thrown on final failure is the validator's reason, not a synthesized "prompt echo detected" string; telemetry (`discovery.prompt_echo_detected`) is emitted.
* [ ] Negative paths behave correctly:
  * Echo + valid fenced JSON → success without repair.
  * Echo + malformed JSON → repair attempted; if repair fails, fallback runs; if fallback also fails, run fails loud.
  * Snippet-less packet → `discovery.fallback_rejected` event emitted; `discovery.used_fallback` is not emitted; `discovery.invalid_output` is emitted; `state.status === "FAILED"`, `phase === "discovery-failed"`.
  * No echo, prose-only response → repair runs once and fails; behavior matches the existing `invalid discovery output` test.
  * Semantic failures (missing files, unobserved files, no confirmed evidence, `DISCOVERY_FAILED`) → not repair-eligible; fail loud without repair or fallback.
  * Existing `tests/runtime.test.mjs:266` reason string (`"Discovery returned invalid structured JSON"`) preserved exactly.
* [ ] Tests pass (`npm test`, including the four new tests in Step 4).
* [ ] Type checks pass (`npm run typecheck`).
* [ ] Lint passes (`npm run complexity`).
* [ ] Build passes (`npm run build`).
* [ ] No migrations required. No schema changes; no DB migrations; no config migrations. The validator's strictness for successful Discovery contracts is preserved.
* [ ] `looksLikePromptEcho`'s body and signature unchanged. Two call sites remain (event emission, optional repair-prompt note).
* [ ] `learnings.md` updated with the control-flow invariant.
