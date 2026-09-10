# LLM-Owned Dependency Strategy With Factory Safeguards

## 1. Understanding & Scope

* **Core Goal:** Stop delegating dependency preparation to the model in a way that can be silently skipped. Let the LLM pick the workspace, package manager, and setup command, but make Factory: (a) execute the chosen setup under hard timeouts, (b) preflight every required executable before running blocking `lint`/`build`/`test`, (c) raise a recoverable `BLOCKED` state when dependencies are missing, (d) derive `summary.json.verificationStatus` from the authoritative `verification.json.overallStatus`, and (e) keep dependency caches and worktrees from accumulating.
* **Current Behavior:** (with file:line evidence)
  * `hydrateWorkspaceDependencies` (`packages/core/src/runtime/dependencies.ts:82-220`) has an explicit `mode === "agent"` short-circuit that emits `dependencies.agent_delegated` and does nothing (`packages/core/src/runtime/dependencies.ts:92-101`). Every live call site passes `mode: "agent"` (`packages/core/src/runtime/controller.ts:306, 1058, 2052`; `packages/core/src/runtime/implementation-task.ts:121`; the `verification-phase2.ts:78` path is unreachable).
  * Setup runs with `execFile(command, { shell: true, windowsHide: true, maxBuffer })` and **no timeout** (`packages/core/src/runtime/dependencies.ts:230-250`). `ExecutionLimits` (`packages/schemas/src/config.ts:12-54`) has no setup-specific ceiling.
  * `preflightSetupCommands` only inspects `commands.setup` (`packages/core/src/runtime/dependencies.ts:349-388`); the LLM/deterministic verification `setup`, `lint`, `typecheck`, `test`, `build` commands are never preflighted (`packages/core/src/runtime/verification.ts:219-298`, `packages/core/src/runtime/verification-evidence.ts:182-218`).
  * On hydration failure the run is marked `FAILED` with `phase: "dependency-hydration-failed"` (`packages/core/src/runtime/controller.ts:309-356`) or the task is marked `failed` (`packages/core/src/runtime/implementation-task.ts:160-185`). `requestFailureRecovery` is never invoked for dependency problems.
  * Status divergence: `writePrototypeVerificationArtifact` writes the *initial* failed `verification.json` at `packages/core/src/runtime/controller.ts:1219-1296`. `attemptEnvironmentPreparation` (extracted copy at `packages/core/src/runtime/controller-helpers.ts:224-275`; live inline copy at `packages/core/src/runtime/controller.ts:1338-1367`) re-runs verification **in memory only** and never rewrites `verification.json`. The repair path does rewrite it (`packages/core/src/runtime/controller.ts:1459-1482`). The terminal summary at `packages/core/src/runtime/controller.ts:1497-1813` writes `verificationStatus: verification.overallStatus` (the in-memory value), producing `summary.verificationStatus === "passed"` while `verification.overallStatus === "failed"`.
  * `writePrototypeSummaryArtifact` (`packages/core/src/runtime/artifacts.ts:476-483`) writes `artifact.verificationStatus` verbatim. The in-progress edit in `packages/core/src/runtime/artifact-writers.ts:143-157` reads `verification.json` and overrides it, but nothing in the runtime imports `writePrototypeSummaryArtifact` from `artifact-writers.ts` (only `landing.ts:19` imports a subset).
  * `cleanupFactoryRuns` (`packages/core/src/runs/cleanup.ts:105-150`) removes worktrees, branches, and run dirs but never prunes `dependencies.cacheRoot` or `.factory/dependencies/*.json` markers. `removeRunGitIsolation` (lines 31-103) only touches git. The `git.cleanup` config (`packages/core/src/config/defaults.ts:47-50`) has `pruneWorktrees: true, pruneBranches: true, preserveFailedRuns: false`.
  * The Pi adapter wires `requestDependencyRemediation` (`packages/adapters/pi/src/gateway.ts:2238`, `packages/adapters/pi/src/gateway-prototype.ts:211`) and `/factory cleanup` calls `cleanupFactoryRuns` (`packages/adapters/pi/src/gateway.ts:1380-1413`).
  * `requestFailureRecovery` (`packages/core/src/runtime/failure-recovery.ts:68-150`) plus `recovery-checkpoint.ts` and `requestRuntimePolicy` are the existing recovery primitives; `resume.ts:342` already routes `missing-executable`/`missing-dependency` back to `verification-planning`.
* **Target Behavior:**
  * `hydrateWorkspaceDependencies` runs unconditionally in harness mode (no `mode === "agent"` skip). The LLM selects the workspace, package manager, and setup command via an extended verification planner.
  * Setup runs under `runtime.limits.dependencySetupTimeoutMs` (new) and `runtime.limits.dependencySetupMaxBufferBytes` (new). Each setup step has its own deadline derived from `maxBuffer`.
  * Before any blocking verification command, Factory executes a synchronous `preflightBlockingCommands` step that resolves each command's leading executable (skipping shell builtins and relative paths) and resolves the package manager once. Missing executables are surfaced as `dependencies.preflight_blocked`.
  * Missing dependencies raise `status: "BLOCKED", phase: "dependency-hydration-blocked"`, emit `run.recovery_requested` via `requestFailureRecovery` (`canRepair: true`, `canRevise: true`), and update `resume.ts` so `BLOCKED` runs are resumable after the user re-runs `/factory setup` or installs the missing tool.
  * `writePrototypeSummaryArtifact` (the one in `artifacts.ts`) re-derives `verificationStatus` from `verification.json.overallStatus` after every write, and only the value from `verification.json` is trusted for terminal status. `verification.json` is rewritten whenever the in-memory verification result changes (including after env prep).
  * `cleanupFactoryRuns` also prunes `.factory/dependencies/*.json` markers older than the keep window inside the run's workspace (only when the run dir is being removed) and exposes `dependencies.cacheRoot.maxAgeDays` so the adapter can call a new `pruneDependencyCache(root, options)` from `/factory cleanup`.
  * The in-progress `mode: "agent" → "harness"` diff in the worktree is reverted first; it is dead code (live monolith never reaches `controller-setup.ts` / `verification-phase2.ts`).
* **Files Affected:**
  * `packages/core/src/runtime/dependencies.ts` — drop the `mode: "agent"` branch; add setup timeout/buffer; export new helpers.
  * `packages/core/src/runtime/dependency-cache.ts` — expose `pruneDependencyCache(root, { maxAgeDays, dryRun })`.
  * `packages/core/src/runtime/dependency-evidence.ts` (new) — workspace/package-manager selection evidence, parallel to `verification-evidence.ts`.
  * `packages/core/src/runtime/dependency-strategy.ts` (new) — `planDependencyStrategy(input): DependencyStrategy` extending `planVerificationExecution`; deterministic fallback `buildDeterministicDependencyStrategy`.
  * `packages/core/src/runtime/verification.ts` — `runVerificationCommands` returns the post-classification status; `runBlockingVerificationCommands` runs preflight first.
  * `packages/core/src/runtime/failure-classification.ts` — add `dependencies.missing` category; map `dependencies.preflight_blocked` failures to `prepare-environment` so the existing recovery path applies.
  * `packages/core/src/runtime/controller.ts` — switch every `hydrateWorkspaceDependencies({ mode: "agent" })` to `mode: "harness"` (no change needed once the agent branch is removed); wire `runBlockingVerificationCommands`; on missing-dep failure route through `requestFailureRecovery` and emit `dependency-hydration-blocked`; rewrite `verification.json` after env prep; rely on the new `writePrototypeSummaryArtifact` for status derivation.
  * `packages/core/src/runtime/implementation-task.ts` — drop `mode: "agent"`; on per-task hydration failure return `ok: false` with `failureKind: "dependency-blocked"` and let the controller raise the recoverable BLOCKED.
  * `packages/core/src/runtime/artifacts.ts` — `writePrototypeSummaryArtifact` re-derives `verificationStatus` from `verification.json` after every write and refuses to write if `verification.json` is missing unless `options.allowWithoutVerification === true`.
  * `packages/core/src/runs/cleanup.ts` — `cleanupFactoryRuns` removes `.factory/dependencies/*.json` markers when removing a run dir, and calls `pruneDependencyCache` if `dependencies.cacheRoot` is configured.
  * `packages/core/src/runs/resume.ts` — recognize `dependency-hydration-blocked` as resumable to `verification-planning` after a re-plan.
  * `packages/schemas/src/config.ts` — add `RuntimeLimits.dependencySetupTimeoutMs`, `RuntimeLimits.dependencySetupMaxBufferBytes`, `DependenciesConfig.cacheMaxAgeDays`.
  * `packages/adapters/pi/src/gateway.ts` — `/factory cleanup` reports cache prune results.
  * `packages/adapters/pi/src/gateway-runs.ts` — surface `dependency-hydration-blocked` status in run listings.
  * `tests/runtime.test.mjs` — replace the `delegated to the builder agent` test with `harness runs setup unconditionally`; add `preflight blocks missing executables`, `dependency failure raises recoverable BLOCKED`, `summary.verificationStatus matches verification.overallStatus`, `cleanup prunes dependency cache`.
  * `tests/dependencies.test.mjs` — add timeout, preflight-blocking-commands, missing-executable → recoverable blocked, cache prune tests.
  * `tests/cleanup.test.mjs` — extend with cache prune and marker removal.
  * `docs/factory/worktrees-and-dependencies.md` — rewrite the "delegated to the agent" paragraph; add a "Blocked by missing dependencies" section.
  * `.pi/skills/factory-worktrees-dependencies/SKILL.md` and `skills/factory-concierge/SKILL.md` — mirror doc updates.
  * `learnings.md` — record the "LLM-owned, Factory-enforced" pattern, the summary-status-derivation fix, and the cache/worktree accumulation risk.
* **Out of Scope:**
  * Changing `commands.setup`'s YAML shape or supporting alternative setup discovery mechanisms (lockfile inference already exists in `verification-discovery.ts` and is reused).
  * Removing `attemptEnvironmentPreparation` as a recovery path for *code-side* environment breakage (it stays; only the "missing dependency" code path moves to BLOCKED).
  * Changing `requestDecision`, `requestRuntimePolicy`, or `failureRecovery.enabled` defaults.
  * Editing `controller-run.ts` / `controller-setup.ts` / `verification-phase2.ts` / `implementation-phase.ts` — these are dead modules in the live build and stay untouched (the worktree `mode` flips in them are reverted).
  * Cross-process resume protocol changes beyond `resume.ts` routing.
  * Removing `dependency-remediation.ts`; it stays as the safe-replacement store.

## 2. Assumptions & Blockers

* **Assumptions:**
  1. The live runtime control plane is `controller.ts` (monolith) + `implementation-task.ts` + `artifacts.ts`. The extracted phase modules (`controller-run.ts` etc.) are unreachable in `npm test` and in production; nothing imports them.
  2. The verifier selection LLM that already exists in `planVerificationExecution` is the right surface for choosing workspace/package manager/setup. We add an *adjacent* `planDependencyStrategy` that is consulted before verification planning; if both are configured, the dependency planner output narrows the verification planner's `cwd`/`setup` selection.
  3. "Recoverable blocked" reuses `requestFailureRecovery` with `canRepair: true, canRevise: true`, emitting `status: "BLOCKED", phase: "dependency-hydration-blocked"`. `resume.ts` already routes verification failures back to `verification-planning`; we extend it for this phase.
  4. `verification.json` is the single source of truth for terminal status. Any path that mutates the in-memory `verification` result (`attemptEnvironmentPreparation`, repair loop, env prep recovery) must rewrite `verification.json` before the next status decision.
  5. `git.cleanup.preserveFailedRuns: false` (default) makes it safe to remove `.factory/dependencies/*.json` from a run's workspace when removing the run dir.
* **Questions / Blockers:**
  1. **Authoritative hydration path.** This plan targets the live monolith. The in-progress worktree changes flip `mode` in *both* live and dead files (`controller.ts:306, 1058, 2052` are live; `controller-setup.ts:179`, `verification-phase2.ts:79`, `implementation-task.ts:121` are reachable only through `implementation-task.ts:121` from the live path). The plan calls for reverting the dead-file flips before doing anything else. Confirm or override.
  2. **Dependency cache pruning cadence.** `/factory cleanup` is the documented user-triggered path. There is no scheduled prune today. If you want automatic prune-on-every-N-runs, say so; otherwise prune remains user-invoked.
  3. **Resume policy.** Confirm `dependency-hydration-blocked` should resume from `verification-planning` (re-run verification after re-plan) rather than from the blocked phase itself.

## 3. Implementation Plan

### Pre-step: revert the worktree mode flips and dead artifact patch

* [ ] **Pre-step 0: Revert uncommitted partial edits**

  * **Files:** `packages/core/src/runtime/controller-setup.ts:179`, `packages/core/src/runtime/verification-phase2.ts:79`, `packages/core/src/runtime/implementation-task.ts:121`, `packages/core/src/runtime/artifact-writers.ts:143-157`, `packages/core/src/runtime/controller.ts:306,1058,2052` — restore from `HEAD`.
  * **Interfaces:** None.
  * **Code:** `git checkout HEAD -- packages/core/src/runtime/controller-setup.ts packages/core/src/runtime/verification-phase2.ts packages/core/src/runtime/implementation-task.ts packages/core/src/runtime/artifact-writers.ts packages/core/src/runtime/controller.ts`.
  * **Negative Paths:** If `git checkout` fails because the working tree is dirty in those files (the diff is the dirty state), abort and ask the user to resolve. Do not auto-stash.
  * **Verification:** `git diff --stat HEAD` shows zero changes. `npm run typecheck` still passes (we're at `HEAD`).

### Step 1: Config — add limits and cache age

* [ ] **Step 1: Config schema + defaults**

  * **Files:**
    * Modify `packages/schemas/src/config.ts:12-54` (extend `ExecutionLimits`).
    * Modify `packages/schemas/src/config.ts:182-185,224-227,312-315,402-405` (extend `DependenciesConfig`).
    * Modify `packages/core/src/config/defaults.ts:14-22` (add default limits).
    * Modify `packages/core/src/config/defaults.ts:67-70` (add `cacheMaxAgeDays: 30`).
    * Modify `packages/core/src/config/merge.ts:18-40` (pass new fields through).
  * **Interfaces:**
    ```ts
    interface ExecutionLimits {
      // ... existing
      /** Hard ceiling for one dependency setup step (default 15 min). */
      dependencySetupTimeoutMs?: number;
      /** Hard ceiling for captured stdout+stderr of one setup step (default 50 MB). */
      dependencySetupMaxBufferBytes?: number;
    }
    interface DependenciesConfig {
      // ... existing
      /** Days; entries in dependencies.cacheRoot older than this are pruned by /factory cleanup. */
      cacheMaxAgeDays?: number;
    }
    ```
  * **Code:**
    ```ts
    // packages/schemas/src/config.ts — add inside ExecutionLimits
    dependencySetupTimeoutMs?: number;
    dependencySetupMaxBufferBytes?: number;
    // inside DependenciesConfig (3 shape positions)
    cacheMaxAgeDays?: number;
    ```
    ```ts
    // packages/core/src/config/defaults.ts
    runtime: { ..., limits: {
      ...,
      dependencySetupTimeoutMs: 900_000,
      dependencySetupMaxBufferBytes: 50 * 1024 * 1024,
    } },
    dependencies: { ..., cacheMaxAgeDays: 30 },
    ```
  * **Negative Paths:** If `merge.ts` drops unknown keys (it does for limits today), assert the new keys are forwarded. Add explicit destructure if needed.
  * **Verification:** `npm run typecheck` — PASS. `node -e "import('./packages/core/dist/index.js').then(m => console.log(m.loadEffectiveConfig.toString()))"` — function exported. `node --test tests/runtime.test.mjs` still PASS (no behavior change yet).

### Step 2: Dependencies — drop the `mode: "agent"` branch and enforce timeouts

* [ ] **Step 2: Remove agent-mode delegation, add timeouts**

  * **Files:** Modify `packages/core/src/runtime/dependencies.ts:82-220` (`hydrateWorkspaceDependencies`), `:230-250` (setup exec).
  * **Interfaces:**
    ```ts
    interface HydrateInput {
      workspacePath: string;
      projectRoot: string;
      config: EffectiveFactoryConfig;
      runId: string;
      phase: string;
      taskId?: string;
      onEvent?: (event: { type: string; data: Record<string, unknown> }) => Promise<void>;
      onRemediation?: (candidate: DependencyHydrationRemediationCandidate) => Promise<boolean | RemediationDecision>;
      // mode removed
    }
    ```
    Function signature change: drop `mode`. `executeStep` now takes `timeoutMs` and `maxBufferBytes` from `config.runtime.limits`.
  * **Code:**
    ```ts
    // packages/core/src/runtime/dependencies.ts
    export async function hydrateWorkspaceDependencies(input: HydrateInput): Promise<DependencyHydrationResult> {
      // delete the if (input.mode === "agent") branch entirely
      // pass config.runtime.limits?.dependencySetupTimeoutMs into the inner exec call
    }

    // inside the setup loop, replace:
    //   await execFileAsync(command, { cwd, shell: true, windowsHide: true, env, maxBuffer: 10 * 1024 * 1024 })
    // with:
    const timeoutMs = input.config.runtime.limits?.dependencySetupTimeoutMs ?? 900_000;
    const maxBufferBytes = input.config.runtime.limits?.dependencySetupMaxBufferBytes ?? 50 * 1024 * 1024;
    await execFileAsync(command, {
      cwd: commandCwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...cacheEnv },
      maxBuffer: maxBufferBytes,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    });
    ```
    On `error.killed === true && error.signal === "SIGTERM" && timeoutMs > 0`, throw `DependencyHydrationError` with `code: "DEPENDENCY_SETUP_TIMEOUT"` and the step name/command/cwd.
  * **Negative Paths:**
    * `signal === "SIGKILL"` (parent killed): treat as `DEPENDENCY_SETUP_TIMEOUT`.
    * Setup exits non-zero: existing `applyRemediation` / onRemediation path; unchanged.
    * `dependencies.enabled === false`: still skip (existing branch at line 169-176).
    * `dependencies.hydrate === "never"`: still skip.
    * No `commands.setup` configured: still skip with `reason: "no commands.setup configured"`.
    * Cache root equals workspace: `assertCacheRootOutsideWorkspace` already throws.
  * **Verification:** `npm run typecheck` PASS. `node --test tests/dependencies.test.mjs` PASS (existing marker/mode/preflight tests still pass because `mode` removal does not change behavior when callers pass `mode: "harness"`; update callers in Step 6). New test `tests/dependencies.test.mjs`: `dependencySetupTimeoutMs aborts hung setup` — runs `setup: node -e "setTimeout(()=>{}, 1e9)"`, asserts `DependencyHydrationError.code === "DEPENDENCY_SETUP_TIMEOUT"` and event `dependencies.hydration_failed` carries `exitCode: undefined, signal: "SIGTERM"`.

### Step 3: New — dependency evidence + strategy

* [ ] **Step 3: `dependency-evidence.ts`**

  * **Files:** Create `packages/core/src/runtime/dependency-evidence.ts`.
  * **Interfaces:**
    ```ts
    export interface DependencyEvidence {
      rootCwd: string;
      candidateCwds: Array<{
        path: string;
        relativePath: string;
        packageManager: "npm" | "pnpm" | "yarn" | "bun" | "uv" | "pip" | "cargo" | "go" | "gradle" | "maven" | "make" | undefined;
        scripts: string[];
        ecosystemMarkers: string[];
        dependencyMarkers: string[];
        missingDependencyMarkers: string[];
      }>;
      allowedCommands: string[];
    }
    export async function discoverDependencyEvidence(executionCwd: string, commands: { setup?: string }): Promise<DependencyEvidence>;
    ```
  * **Code:** Mirror `verification-evidence.ts::discoverVerificationEvidence` but only consider `commands.setup` and dependency markers. Detect package manager from lockfiles (existing logic in `verification-discovery.ts::detectPackageManager` is reused via import). Return one `candidateCwds` entry per nested package root (depth 3).
  * **Negative Paths:** No `package.json` / `pyproject.toml` / `Cargo.toml` → `packageManager: undefined`, `scripts: []`. Unknown file → ignored.
  * **Verification:** New test `tests/dependencies.test.mjs`: `discoverDependencyEvidence returns candidate with npm + missing node_modules` — fixture with `package.json` and no `node_modules`; assert `missingDependencyMarkers` includes `node_modules` and `packageManager === "npm"`.

* [ ] **Step 4: `dependency-strategy.ts` (LLM-owned)**

  * **Files:** Create `packages/core/src/runtime/dependency-strategy.ts`.
  * **Interfaces:**
    ```ts
    export interface DependencyStrategy {
      cwd: string;                 // selected workspace
      packageManager?: string;     // LLM-chosen package manager (e.g. "pnpm")
      setup?: string;              // LLM-chosen setup command (overrides commands.setup)
      rationale: string;
      selectionSource: "ai" | "deterministic";
    }
    export interface PlanDependencyStrategyInput {
      cwd: string;
      goal: string;
      evidence: DependencyEvidence;
      configuredSetup?: string;
      executor?: AgentExecutor;
      model?: ModelSelection;
      limits?: ExecutionLimits;
      allowDeterministicFallback: boolean;
    }
    export async function planDependencyStrategy(input: PlanDependencyStrategyInput): Promise<DependencyStrategy>;
    export function buildDeterministicDependencyStrategy(evidence: DependencyEvidence, configuredSetup?: string): DependencyStrategy;
    ```
  * **Code:**
    ```ts
    export async function planDependencyStrategy(input: PlanDependencyStrategyInput): Promise<DependencyStrategy> {
      if (!input.executor) {
        if (!input.allowDeterministicFallback) {
          throw new DependencyStrategyError("DEPENDENCY_STRATEGY_NO_EXECUTOR");
        }
        return buildDeterministicDependencyStrategy(input.evidence, input.configuredSetup);
      }
      const prompt = buildDependencyStrategyPrompt(input.goal, input.evidence, input.configuredSetup);
      const result = await input.executor.execute({ executionId: `${input.cwd}-dep-strategy`, cwd: input.cwd, prompt, model: input.model, tools: ["read"], limits: input.limits, metadata: { role: "planner", purpose: "dependency-strategy" } });
      if (result.status !== "completed") {
        return buildDeterministicDependencyStrategy(input.evidence, input.configuredSetup);
      }
      const parsed = parseDependencyStrategy(result.outputText);
      return sanitizeDependencyStrategy(parsed, input.evidence, input.configuredSetup);
    }
    ```
    `sanitizeDependencyStrategy` validates: `cwd` ∈ candidate paths; `setup` (if any) starts with a known package manager binary OR is the configured setup; `packageManager` ∈ detected set.
  * **Negative Paths:**
    * Executor returns malformed JSON → fall back to deterministic with event `dependency_strategy.ai_invalid`.
    * LLM picks `setup` for a different package manager than `packageManager` → reject, fall back to deterministic.
    * No candidates → fall back to `cwd === rootCwd`.
  * **Verification:** New test `tests/dependencies.test.mjs`: `planDependencyStrategy returns deterministic when no executor`. With `evidence = single npm candidate, missing node_modules`, no executor, `allowDeterministicFallback: true`, expect `cwd === candidate.path, packageManager === "npm", setup === "npm install"`.

### Step 4: Verification — preflight blocking commands

* [ ] **Step 5: Pre-flight every blocking command's executable**

  * **Files:** Modify `packages/core/src/runtime/verification.ts:219-298` (`runVerificationCommands`). Add a new exported `runBlockingVerificationCommands(input)`.
  * **Interfaces:**
    ```ts
    interface RunBlockingVerificationInput {
      cwd: string;
      commands: VerificationCommandConfig;
      timeouts?: Record<string, number>;
      env?: Record<string, string>;
    }
    interface RunBlockingVerificationResult {
      preflight: PreflightReport;
      verification: VerificationRunResult;
    }
    interface PreflightReport {
      ok: boolean;
      missing: Array<{ commandName: string; executable: string; cwd: string; command: string }>;
    }
    export async function runBlockingVerificationCommands(input: RunBlockingVerificationInput): Promise<RunBlockingVerificationResult>;
    ```
  * **Code:**
    ```ts
    export async function runBlockingVerificationCommands(input: RunBlockingVerificationInput): Promise<RunBlockingVerificationResult> {
      const preflight = await preflightVerificationCommands(input.commands);
      if (!preflight.ok) {
        return {
          preflight,
          verification: {
            cwd: input.cwd,
            cwdResolution: "default-root",
            commands: preflight.missing.map((m) => ({
              name: m.commandName, command: m.command, status: "missing", stderr: `Executable '${m.executable}' not found in PATH`,
            })),
            overallStatus: "failed",
          },
        };
      }
      const verification = await runVerificationCommands({ cwd: input.cwd, commands: input.commands, timeouts: input.timeouts, env: input.env });
      return { preflight, verification };
    }

    async function preflightVerificationCommands(commands: VerificationCommandConfig): Promise<PreflightReport> {
      const missing: PreflightReport["missing"] = [];
      for (const [name, command] of Object.entries(commands)) {
        if (name === "cwd" || !command) continue;
        const executable = extractExecutable(command);
        if (!executable || SHELL_BUILTINS.has(executable)) continue;
        if (executable.startsWith("./") || executable.startsWith("../") || executable.includes("/")) continue;
        const found = await commandExists(executable);
        if (!found) missing.push({ commandName: name, executable, cwd: "(verification cwd)", command });
      }
      return { ok: missing.length === 0, missing };
    }
    ```
    `extractExecutable` and `commandExists` already exist in `dependencies.ts` and `dependency-cache.ts`; re-export `extractExecutable` from `dependencies.ts` (already exported at `packages/core/src/runtime/dependencies.ts:333-348`).
  * **Negative Paths:**
    * `cwd` key in `commands` ignored (existing behavior).
    * Multi-segment command (`cd app && npm run lint`) — first non-builtin executable wins (matches `extractExecutable` semantics).
    * All commands pass preflight → result equals the current `runVerificationCommands` output.
  * **Verification:** New test `tests/dependencies.test.mjs` (or new `tests/blocking-verification.test.mjs`): `preflight blocks missing executable before running command` — fixture config with `commands.lint: fakecli-lint`; run `runBlockingVerificationCommands`; assert `preflight.ok === false` and `verification.overallStatus === "failed"` without invoking `fakecli-lint`.

### Step 5: Failure classification — `dependencies.missing`

* [ ] **Step 6: New failure category**

  * **Files:** Modify `packages/core/src/runtime/failure-classification.ts:3-12` (extend `FailureCategory`), `:188-220` (`classifySingleCommand`), `:301-321` (`looksLikeMissingCommand`).
  * **Interfaces:**
    ```ts
    type FailureCategory = "missing-executable" | "missing-dependency" | "dependencies.missing" | /* ... existing */ ;
    ```
  * **Code:**
    ```ts
    function classifySingleCommand(command: VerificationCommandResult, cwd, changedFiles, repoRoot, baseResult): CommandFailureClassification {
      // existing checks above
      // after "looksLikeMissingCommand" branch:
      if (command.status === "missing" && /Executable '(.+)' not found in PATH/.test(command.stderr ?? "")) {
        return {
          commandName: command.name,
          category: "dependencies.missing",
          reason: extractFirstLine(command.stderr ?? ""),
          retryable: true,
          suggestedAction: "prepare-environment",
        };
      }
    }
    ```
    Add `"dependencies.missing"` to the `priority` array at line 110 between `"missing-executable"` and `"missing-dependency"`.
  * **Negative Paths:** Old behavior preserved when command actually executes (`status === "failed"`) and only the new synthetic `status: "missing"` rows are routed to the new category.
  * **Verification:** New test `tests/dependencies.test.mjs` (or existing failure-classification test): `dependencies.missing maps to prepare-environment`. Construct a fake `VerificationCommandResult` with `status: "missing", stderr: "Executable 'fakecli' not found in PATH"`; assert `classifySingleCommand(...)` returns `{ category: "dependencies.missing", suggestedAction: "prepare-environment" }`.

### Step 6: Controller wiring — recoverable BLOCKED + status re-derivation

* [ ] **Step 7: Switch live hydration calls to `mode: "harness"` (now the only mode)**

  * **Files:** Modify `packages/core/src/runtime/controller.ts:294-306, 1047-1059, 2052-2054` (remove the `mode: "agent"` lines); modify `packages/core/src/runtime/implementation-task.ts:108-122` (same).
  * **Interfaces:** None — the `mode` field is removed.
  * **Code:** Just delete the `mode: "agent"` / `mode: "harness"` lines in all four call sites. The `mode` field is dropped from `HydrateInput` in Step 2.
  * **Negative Paths:** None — these are unconditional deletions.
  * **Verification:** `npm run typecheck` PASS. `node --test tests/dependencies.test.mjs` PASS (existing tests don't pass `mode`).

* [ ] **Step 8: Use `planDependencyStrategy` before hydration**

  * **Files:** Modify `packages/core/src/runtime/controller.ts:248-306` (the initial hydration block).
  * **Interfaces:**
    ```ts
    interface RunFactoryControllerInput {
      // ... existing
      dependencyStrategyExecutor?: AgentExecutor;
      dependencyStrategyModel?: ModelSelection;
    }
    ```
  * **Code:**
    ```ts
    // Before hydrateWorkspaceDependencies at line 294:
    if (loaded.effectiveConfig.dependencies.enabled) {
      const evidence = await discoverDependencyEvidence(executionCwd, { setup: loaded.effectiveConfig.commands.setup as string | undefined });
      const strategy = await planDependencyStrategy({
        cwd: executionCwd,
        goal: input.goal,
        evidence,
        configuredSetup: typeof loaded.effectiveConfig.commands.setup === "string" ? loaded.effectiveConfig.commands.setup : undefined,
        executor: input.dependencyStrategyExecutor,
        model: input.dependencyStrategyModel ?? loaded.effectiveConfig.models.planner,
        limits: loaded.effectiveConfig.runtime.limits,
        allowDeterministicFallback: true,
      });
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "dependency_strategy.selected",
        data: { cwd: strategy.cwd, packageManager: strategy.packageManager, setup: strategy.setup, selectionSource: strategy.selectionSource, rationale: strategy.rationale },
      });
      executionCwd = strategy.cwd;
      // commands.setup override: stash strategy.setup in a run-scoped override applied below
      setupOverride = strategy.setup;
    }
    ```
    Then pass `setupOverride` (when present) into `hydrateWorkspaceDependencies` via a new optional `setupOverride?: string` field on `HydrateInput`. Inside `dependencies.ts`, when `setupOverride` is set, replace `input.config.commands.setup` before normalization.
  * **Negative Paths:**
    * `dependencyStrategyExecutor` not provided and `allowDeterministicFallback === true` → deterministic strategy, event `dependency_strategy.deterministic`.
    * LLM returns invalid strategy → deterministic fallback, event `dependency_strategy.ai_invalid`, **do not** fail the run.
    * Strategy changes `cwd` to a path outside the worktree → reject in `sanitizeDependencyStrategy`, fall back to deterministic, log warning event.
  * **Verification:** New test `tests/runtime.test.mjs`: `dependency strategy deterministically selects npm when no executor` — fixture with `package.json` + `package-lock.json`, no `node_modules`; run controller; assert event `dependency_strategy.selected` with `selectionSource: "deterministic", packageManager: "npm"` and `dependencies.hydration_completed` after marker run.

* [ ] **Step 9: Recoverable BLOCKED on missing dependencies**

  * **Files:** Modify `packages/core/src/runtime/controller.ts:294-356` (initial hydration error handler), `packages/core/src/runtime/controller.ts:1338-1487` (verification env-prep + repair loop), `packages/core/src/runtime/implementation-task.ts:158-185` (per-task hydration error).
  * **Interfaces:** None new — reuse existing `requestFailureRecovery` and `RecoveryCheckpointInput` (`packages/core/src/runtime/recovery-checkpoint.ts`).
  * **Code:**
    ```ts
    // controller.ts initial hydration error handler — replace lines 309-356 with:
    } catch (error) {
      const isDependencyBlocked = error instanceof DependencyHydrationError
        && (error.code === "DEPENDENCY_SETUP_TIMEOUT" || error.code === "DEPENDENCY_MISSING_EXECUTABLE" || error.code === "DEPENDENCY_HYDRATION_FAILED");
      if (isDependencyBlocked) {
        const recovery = await requestFailureRecovery({
          controllerInput: input,
          runDir: run.runDir,
          statePath: run.statePath,
          eventsPath: run.eventsPath,
          runId: run.runId,
          context: {
            phase: "dependency-hydration-blocked",
            title: "dependency preparation is blocked",
            reason: error.message,
            category: "missing-dependency",
            retryable: true,
            canRepair: Boolean(input.repairExecutor && loaded.effectiveConfig.repair.enabled),
            canRevise: true,
            attempt: 1,
          },
          checkpoint: {
            runId: run.runId,
            goal: input.goal,
            phase: "dependency-hydration-blocked",
            executionCwd,
            projectRoot,
            worktree,
            planPath: path.join(run.runDir, "plan.json"),
            taskPaths: [],
            verificationPath: path.join(run.runDir, "verification.json"),
          },
        });
        if (recovery.action === "revise" || recovery.action === "repair") {
          // continue: re-plan verification after the user installs deps or revises config
          // fall through to verification phase; the planner will re-select setup
          // (no early return)
        } else {
          const blockedState = await updateFactoryRunState({ statePath: run.statePath, patch: { status: "BLOCKED", phase: "dependency-hydration-blocked" } });
          await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: "run.failed", data: { reason: error.message, phase: "dependency-hydration-blocked" } });
          await emitProgress(input, { runId: run.runId, phase: blockedState.phase, status: "BLOCKED", message: error.message });
          const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
            runId: run.runId, goal: input.goal, status: "BLOCKED", phase: blockedState.phase, approved: false,
            planPath: path.join(run.runDir, "plan.json"), taskPaths: [],
            verificationPath: path.join(run.runDir, "verification.json"), verificationStatus: "incomplete",
            recoveryHint: error.message,
          });
          return { runId: run.runId, runDir: run.runDir, executionCwd, worktree, statePath: run.statePath, eventsPath: run.eventsPath,
            phases, approved: false, planPath: path.join(run.runDir, "plan.json"), taskPaths: [],
            verificationPath: path.join(run.runDir, "verification.json"), summaryPath };
        }
      } else {
        // existing FAILED handling unchanged
      }
    }
    ```
    Add `code?: string` to `DependencyHydrationError` in `packages/core/src/runtime/dependencies.ts:54-72` and set `code` at every throw site:
    * Pre-flight missing executable → `DEPENDENCY_MISSING_EXECUTABLE`.
    * Setup exec error → `DEPENDENCY_HYDRATION_FAILED`.
    * Timeout → `DEPENDENCY_SETUP_TIMEOUT` (Step 2).

    In `controller.ts:1338-1487` (env-prep path), wrap `attemptEnvironmentPreparation` in `runBlockingVerificationCommands` and on `verification.overallStatus === "failed"` with `category === "dependencies.missing"`, take the same `requestFailureRecovery` → `dependency-hydration-blocked` route instead of attempting model-delegated env prep.

    In `implementation-task.ts:158-185`, when the per-task hydration error has code `DEPENDENCY_MISSING_EXECUTABLE` or `DEPENDENCY_SETUP_TIMEOUT`, return `ok: false, failureKind: "dependency-blocked"` and let the controller's `runImplementationPhase` aggregate these into a recoverable BLOCKED rather than `task.failed`.
  * **Negative Paths:**
    * `requestFailureRecovery` returns `stop` (user declined) → state `BLOCKED`, summary written with `verificationStatus: "incomplete"`.
    * `repairExecutor` not configured → `canRepair: false`; user gets only `retry`/`revise`/`stop`.
    * User picks `revise` → run continues to verification; planner runs again with new evidence.
    * Per-task hydration fails *after* the run-level hydration succeeded → still aggregated to BLOCKED with `recoveryHint` naming the task id.
  * **Verification:** New test `tests/runtime.test.mjs`: `missing executable raises recoverable BLOCKED` — fixture with `commands.lint: fakecli-lint` (executable absent), `repair.enabled: false`. Run controller; assert `state.status === "BLOCKED"`, `state.phase === "dependency-hydration-blocked"`, event `run.recovery_requested` with `category: "missing-dependency"`. Then a paired test `missing executable recovers after retry` — same fixture; `requestFailureRecovery` mock returns `{ action: "revise" }`; assert run reaches verification, planner selects `setup: "npm install"` (deterministic fallback), and final summary `verificationStatus: "passed"`.

* [ ] **Step 10: Rewrite `verification.json` after env-prep + status re-derivation**

  * **Files:** Modify `packages/core/src/runtime/controller.ts:1338-1459` (env-prep path); modify `packages/core/src/runtime/artifacts.ts:476-483` (`writePrototypeSummaryArtifact`).
  * **Interfaces:**
    ```ts
    interface WritePrototypeSummaryOptions {
      allowWithoutVerification?: boolean; // default false
    }
    // writePrototypeSummaryArtifact gains a third optional argument
    export async function writePrototypeSummaryArtifact(
      runDir: string,
      artifact: PrototypeSummaryArtifact,
      options?: WritePrototypeSummaryOptions,
    ): Promise<string>;
    ```
  * **Code:**
    ```ts
    // controller.ts after attemptEnvironmentPreparation at line 1364:
    if (envResult.status === "completed") {
      const recheck = await runBlockingVerificationCommands({
        cwd: verificationPlan.cwd,
        commands: verificationPlan.commands,
        timeouts: verificationPlan.timeouts,
        env: loaded.effectiveConfig.dependencies.enabled && loaded.effectiveConfig.dependencies.hydrate !== "never"
          ? await buildDependencyCacheEnv(loaded.effectiveConfig.dependencies.cacheRoot)
          : undefined,
      });
      verification = recheck.verification;
      verification.cwdResolution = verificationPlan.cwdResolution;
      verificationFailureClassification = classifyVerificationFailure({ plan: verificationPlan, result: verification, changedFiles: implementationChangedFiles });
      verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
        ...verification, selectionSource: verificationPlan.selectionSource, rationale: verificationPlan.rationale,
        skill: verificationPlan.skill, evidence: verificationPlan.evidence, failureClassification: verificationFailureClassification,
      });
    }
    ```
    ```ts
    // artifacts.ts — replace writePrototypeSummaryArtifact body:
    export async function writePrototypeSummaryArtifact(runDir: string, artifact: PrototypeSummaryArtifact, options?: WritePrototypeSummaryOptions): Promise<string> {
      const filePath = path.join(runDir, "summary.json");
      let status: PrototypeSummaryArtifact["verificationStatus"] = artifact.verificationStatus;
      try {
        const raw = await fs.readFile(path.join(runDir, "verification.json"), "utf8");
        const parsed = JSON.parse(raw) as { overallStatus?: unknown };
        if (parsed.overallStatus === "passed" || parsed.overallStatus === "failed" || parsed.overallStatus === "incomplete") {
          status = parsed.overallStatus;
        } else if (!options?.allowWithoutVerification) {
          throw new Error("writePrototypeSummaryArtifact: verification.json missing or has invalid overallStatus; pass { allowWithoutVerification: true } for early-failure summaries");
        }
      } catch (error) {
        if (!options?.allowWithoutVerification) throw error;
      }
      await fs.writeFile(filePath, JSON.stringify({ title: smartRunTitle(artifact.goal), ...artifact, verificationStatus: status }, null, 2), "utf8");
      return filePath;
    }
    ```
    Update the seven early-failure `writePrototypeSummaryArtifact` call sites in `controller.ts` (lines 327, 834, 926, 1005, 1080, 1561, 1796) and the matching sites in `controller-setup.ts:212`, `controller-integration.ts:125`, `plan-approval-phase.ts:106,182`, `controller-final-phases.ts:121`, `acceptance-phase.ts:103` to pass `{ allowWithoutVerification: true }`. Late call sites (terminal summaries after `verification.json` exists) keep the default.
  * **Negative Paths:**
    * `verification.json` legitimately absent (very early failure) → explicit option flag prevents the throw.
    * `verification.overallStatus` is an unexpected string → keep the caller's `artifact.verificationStatus` (don't silently coerce).
    * `verification.json` exists but is corrupt JSON → throw only when `allowWithoutVerification === false`.
  * **Verification:**
    * `npm run typecheck` PASS.
    * New test `tests/runtime.test.mjs`: `summary.verificationStatus matches verification.overallStatus after env prep` — fixture triggers `attemptEnvironmentPreparation` path; assert `summary.verificationStatus === verification.overallStatus === "passed"`.
    * New test `tests/runtime.test.mjs`: `early failure summary writes verificationStatus: incomplete when verification.json absent` — kill run during planning; assert `summary.verificationStatus === "incomplete"` and no throw.

* [ ] **Step 11: Resume routing for `dependency-hydration-blocked`**

  * **Files:** Modify `packages/core/src/runs/resume.ts:312-355` (`suggestResumePolicy`).
  * **Interfaces:** None — pure function.
  * **Code:**
    ```ts
    if (currentPhase === "dependency-hydration-blocked") {
      return {
        resumable: true,
        suggestedPhase: "verification-planning",
        nextStatus: "RUNNING",
        reason: "Resume from verification planning after the user re-runs /factory setup or installs the missing dependency.",
      };
    }
    ```
  * **Negative Paths:** None — pure routing.
  * **Verification:** New test `tests/cleanup.test.mjs` or new `tests/resume.test.mjs`: `dependency-hydration-blocked resumes to verification-planning`.

### Step 7: Cache and worktree accumulation

* [ ] **Step 12: Prune dependency cache**

  * **Files:** Modify `packages/core/src/runtime/dependency-cache.ts` (add `pruneDependencyCache`). Modify `packages/core/src/runs/cleanup.ts` (call it).
  * **Interfaces:**
    ```ts
    interface PruneDependencyCacheInput {
      cacheRoot: string;
      maxAgeDays: number;
      dryRun?: boolean;
    }
    interface PruneDependencyCacheResult {
      cacheRoot: string;
      removedEntries: string[];
      removedBytes: number;
      warnings: string[];
    }
    export async function pruneDependencyCache(input: PruneDependencyCacheInput): Promise<PruneDependencyCacheResult>;
    ```
  * **Code:**
    ```ts
    export async function pruneDependencyCache(input: PruneDependencyCacheInput): Promise<PruneDependencyCacheResult> {
      const cutoff = Date.now() - input.maxAgeDays * 86_400_000;
      // Walk known cache subdirs: npm/, pnpm-store/, yarn/, bun/, uv/, pip/, cargo/, sccache/.
      // For each top-level directory: stat mtime; if < cutoff, remove (or list in dryRun).
      // Subdirectories that are themselves package manager content (per-package) are removed atomically with their parent.
      // Emit structured warnings for any failure; never throw.
      ...
    }
    ```
    Wire from `cleanupFactoryRuns`:
    ```ts
    // runs/cleanup.ts inside cleanupFactoryRuns, after the per-runDir loop:
    const pruneInput: PruneDependencyCacheInput = {
      cacheRoot: path.resolve(loaded.effectiveConfig.dependencies.cacheRoot),
      maxAgeDays: loaded.effectiveConfig.dependencies.cacheMaxAgeDays ?? 30,
      dryRun: false,
    };
    const pruneResult = await pruneDependencyCache(pruneInput);
    ```
    Extend `CleanupFactoryRunsResult` with `prunedCache: PruneDependencyCacheResult`.
    Add `.factory/dependencies/*.json` marker removal inside the per-runDir loop: when `fs.rm(runDir, ...)` succeeds, no separate marker cleanup is needed (markers live under the run's workspace). Document this in a comment so future readers don't add a redundant pruner.
  * **Negative Paths:**
    * `cacheRoot` does not exist → return empty result, no warning.
    * `fs.rm` fails (permission, etc.) → add to `warnings`, continue.
    * `cacheRoot` is inside the project root → `assertCacheRootOutsideWorkspace` already throws at config load; guard here too with `if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return { cacheRoot, removedEntries: [], removedBytes: 0, warnings: ["cache root is inside the project; refusing to prune"] };`.
  * **Verification:** New test `tests/cleanup.test.mjs`: `cleanupFactoryRuns prunes dependency cache older than cacheMaxAgeDays` — fixture with old + new file under `cacheRoot`; run with `cacheMaxAgeDays: 1`; assert `prunedCache.removedEntries.length >= 1`.

* [ ] **Step 13: Adapter — surface prune result**

  * **Files:** Modify `packages/adapters/pi/src/gateway.ts:1380-1413` (`handleCleanup`).
  * **Interfaces:** None.
  * **Code:**
    ```ts
    renderLines(ctx, [
      "Factory cleanup",
      ...,
      `pruned cache entries: ${result.prunedCache.removedEntries.length}`,
      `pruned cache bytes: ${result.prunedCache.removedBytes}`,
      ...result.prunedCache.warnings.map((w) => `  cache warn ${w}`),
      ...result.prunedCache.removedEntries.map((p) => `  cache drop ${p}`),
      ...,
    ]);
    ```
  * **Negative Paths:** None — pure rendering.
  * **Verification:** `npm run typecheck` PASS; `node --test tests/dashboard-api.test.mjs` (no regression).

### Step 8: Tests — replace delegation test, add coverage

* [ ] **Step 14: Tests**

  * **Files:**
    * Modify `tests/runtime.test.mjs` (replace test at line 1812 `dependency preparation is delegated to the builder agent` with `dependency preparation runs in harness mode`).
    * Modify `tests/dependencies.test.mjs` (add: `dependencySetupTimeoutMs aborts hung setup`, `preflight blocks missing executable before running command`, `dependencies.missing maps to prepare-environment`, `discoverDependencyEvidence returns candidate with npm + missing node_modules`, `planDependencyStrategy returns deterministic when no executor`, `missing executable raises recoverable BLOCKED`, `missing executable recovers after retry`).
    * Modify `tests/cleanup.test.mjs` (add: `cleanupFactoryRuns prunes dependency cache older than cacheMaxAgeDays`, `dependency-hydration-blocked resumes to verification-planning`).
    * Modify `tests/runtime.test.mjs` (add: `summary.verificationStatus matches verification.overallStatus after env prep`, `early failure summary writes verificationStatus: incomplete when verification.json absent`).
  * **Interfaces:** Each test cites the function it exercises and the expected outcome.
  * **Code (representative):**
    ```js
    // tests/runtime.test.mjs — replace the old delegation test
    test('dependency preparation runs in harness mode', async () => {
      await withTempProject(async (root) => {
        // ... fixture with commands.setup: 'node -e ...'
        const result = await runRuntimeHarness({ ... });
        const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
        assert.match(eventsRaw, /dependencies\.hydration_completed/);
        assert.doesNotMatch(eventsRaw, /dependencies\.agent_delegated/);
        assert.match(eventsRaw, /dependency_strategy\.selected/);
      });
    });

    // tests/runtime.test.mjs
    test('missing executable raises recoverable BLOCKED', async () => {
      await withTempProject(async (root) => {
        // config has commands.lint: 'fakecli-lint'
        // requestFailureRecovery mock returns { action: 'stop' } (no user recovery available)
        const result = await runRuntimeHarness({ ... });
        const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
        assert.equal(state.status, 'BLOCKED');
        assert.equal(state.phase, 'dependency-hydration-blocked');
        const summary = JSON.parse(await fs.readFile(path.join(result.runDir, 'summary.json'), 'utf8'));
        assert.equal(summary.verificationStatus, 'incomplete');
      });
    });
    ```
  * **Negative Paths:** Tests assert both happy and blocked paths. Each test cleans up its temp project.
  * **Verification:** `node --test tests/runtime.test.mjs tests/dependencies.test.mjs tests/cleanup.test.mjs` — PASS, including the new tests.

### Step 9: Docs and skills

* [ ] **Step 15: Documentation updates**

  * **Files:**
    * Modify `docs/factory/worktrees-and-dependencies.md` (lines 50-65, replace "delegated to the agent" with "selected by the LLM dependency-strategy planner and executed by Factory under hard timeouts"; add a "Blocked by missing dependencies" subsection).
    * Modify `.pi/skills/factory-worktrees-dependencies/SKILL.md` (mirror the doc).
    * Modify `skills/factory-concierge/SKILL.md` (line 215 — replace "Factory should run the repository's configured `commands.setup`" with "Factory runs the LLM-selected setup command under enforced timeouts").
    * Modify `learnings.md` — append: "Dependency preparation is LLM-owned but Factory-enforced; the LLM picks workspace/package manager/setup via `planDependencyStrategy`, Factory executes it under `dependencySetupTimeoutMs`, and `summary.json.verificationStatus` is derived from `verification.json.overallStatus`."
  * **Interfaces:** None.
  * **Code:** Pure documentation edits.
  * **Negative Paths:** N/A.
  * **Verification:** Manual: `grep -rn "delegated to the agent" docs/factory .pi/skills skills` returns no hits. `grep -rn "dependencies.agent_delegated" docs/factory .pi/skills skills` returns no hits.

## 4. Testing

* **Run the full test suite:** `npm test` — PASS (includes `npm run build` + `node scripts/complexity-guard.mjs` + `node --test tests/**/*.test.mjs`).
* **Targeted runs:**
  * `node --test tests/dependencies.test.mjs` — hydration modes, preflight, remediation, **new** timeout, **new** dependency strategy, **new** `dependencies.missing` classification.
  * `node --test tests/runtime.test.mjs` — full controller flow including the **new** harness-mode test, **new** BLOCKED test, **new** summary-status-derivation test.
  * `node --test tests/cleanup.test.mjs` — **new** cache prune + marker behavior.
  * `node --test tests/ai-failure-classifier.test.mjs` — confirm `dependencies.missing` integration.
* **Negative-path coverage:**
  * Setup timeout: `dependencySetupTimeoutMs: 100`, command `sleep 5` → `DependencyHydrationError.code === "DEPENDENCY_SETUP_TIMEOUT"`, run marked `BLOCKED`, recovery prompt appears.
  * Missing executable in lint: preflight detects `fakecli-lint`, never invokes it, `verification.overallStatus === "failed"`, summary matches.
  * User revises after blocked: run resumes, planner picks a valid setup, verification passes, summary `verificationStatus: "passed"`.
  * Cache root inside project: `pruneDependencyCache` returns warning, does not delete.
* **Regression coverage:**
  * `tests/dependencies.test.mjs` (existing 25+ tests) still PASS after `mode` removal and timeout default change.
  * `tests/runtime.test.mjs` runs that never hit dependency blocks still produce the same final summary/status as before.

## 5. Definition of Done

* [ ] `hydrateWorkspaceDependencies` has no `mode === "agent"` branch; every caller passes none.
* [ ] Setup runs under `dependencySetupTimeoutMs` and `dependencySetupMaxBufferBytes`; timeout throws `DependencyHydrationError` with `code === "DEPENDENCY_SETUP_TIMEOUT"`.
* [ ] `runBlockingVerificationCommands` preflights every command's leading executable before invoking it; missing executables produce `verification.overallStatus === "failed"` without shell invocation.
* [ ] `failure-classification` maps synthetic `status: "missing"` rows from preflight to `category: "dependencies.missing", suggestedAction: "prepare-environment"`.
* [ ] Missing dependencies raise `status: "BLOCKED", phase: "dependency-hydration-blocked"` with a `requestFailureRecovery` decision; the run is resumable via `resume.ts` → `verification-planning`.
* [ ] `verification.json` is rewritten after `attemptEnvironmentPreparation`; `summary.json.verificationStatus` equals `verification.json.overallStatus` whenever `verification.json` exists.
* [ ] `cleanupFactoryRuns` prunes `dependencies.cacheRoot` entries older than `cacheMaxAgeDays` and removes `.factory/dependencies/*.json` markers inside dropped run dirs.
* [ ] `/factory cleanup` reports cache prune results.
* [ ] All tests pass (`npm test`); type check passes (`npm run typecheck`); build passes (`npm run build`).
* [ ] Docs and skills updated; "delegated to the agent" removed from `docs/factory/worktrees-and-dependencies.md` and `.pi/skills/factory-worktrees-dependencies/SKILL.md`.
* [ ] `learnings.md` records the LLM-owned/Factory-enforced pattern, the summary-status fix, and the cache/worktree accumulation risk.
* [ ] Worktree uncommitted partial edits reverted before any new commit.
