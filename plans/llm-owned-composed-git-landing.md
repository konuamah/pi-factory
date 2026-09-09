# LLM-Owned Composed Git Landing with Deterministic Safety Rails

## 1. Understanding & Scope

### Core Goal

Replace Factory's hard-coded `LandingStrategy` (`merge | cherry-pick | rebase | pull-request | skip | block`) with an LLM-owned composed Git landing plan. The LLM returns an ordered list of typed Git operations plus an optional pull-request action; deterministic code only:

1. parses the operations into a Git command AST;
2. classifies their effects (`GitEffects`);
3. accepts or rejects the plan against hard safety invariants;
4. executes only validated argv sequences.

Deterministic code must never rewrite, substitute, or choose a different Git operation. Recovery decisions return a new plan that is revalidated from scratch.

### Current Behavior

`packages/core/src/runtime/landing-types.ts:1-50` defines `LandingStrategy` as a fixed string union; `runLandingFlow` and `validateLandingPlan` (`packages/core/src/runtime/landing.ts:54-160`, `packages/core/src/runtime/landing-git.ts:64-141`) branch on it. `executeLandingStrategy` (`packages/core/src/runtime/landing-git.ts:143-180`) switches on the strategy name and hard-codes `git checkout`, `git merge`, `git cherry-pick`, `git rebase`. The multi-commit cherry-pick → merge override lives at `packages/core/src/runtime/landing.ts:117-122` (deterministic code rewrites the LLM plan), which violates the user's constraint that the deterministic layer must not change the strategy. Provider PRs are not Git commands and are still created via `createRecoveryPullRequest` (`packages/core/src/git/pull-request.ts`).

### Target Behavior

`LandingPlan.actions` is the source of truth. Actions are typed Git steps or pull-request actions; the executor validates each step's argv before spawn, runs only validated argv sequentially, and aborts safely on the first hard-violation step. Pull requests are modeled as a separate action kind, validated against provider constraints (not arbitrary shell). Recovery returns a new plan; constraints re-run.

### Files Affected

Create:

- `packages/core/src/runtime/git-command-parser.ts`
- `packages/core/src/runtime/git-command-effects.ts`
- `packages/core/src/runtime/git-execution.ts`

Modify:

- `packages/core/src/runtime/landing-types.ts`
- `packages/core/src/runtime/landing-ai.ts`
- `packages/core/src/runtime/landing.ts`
- `packages/core/src/runtime/landing-git.ts`
- `packages/core/src/runtime/policy-constraints.ts`
- `packages/core/src/runtime/failure-recovery.ts`
- `packages/core/src/runtime/artifacts.ts`
- `packages/core/src/runs/show.ts`
- `packages/core/src/runs/logs-by-id.ts`
- `packages/schemas/src/config.ts`
- `docs/factory/workflow-authoring.md`

Tests:

- Create `tests/git-command-parser.test.mjs`
- Create `tests/git-command-effects.test.mjs`
- Create `tests/landing-composed.test.mjs`
- Modify `tests/landing.test.mjs`
- Modify `tests/runtime.test.mjs`

### Out of Scope

- Provider implementations beyond `github` via `gh`.
- Reverting accepted landings.
- Changing worktree creation logic in `packages/core/src/git/worktree.ts`.
- Removing the legacy `strategy` field (kept read-only for backward compatibility, derived from the first step).

## 2. Assumptions & Blockers

### Assumptions

- `gh` is the only supported PR provider for this design.
- Tests run with `npm test` at the repo root (per `package.json` scripts).
- The landing LLM already emits structured JSON (`landing-ai.ts`); this change widens that contract to include `actions[]` and an optional `pullRequest`.
- Hooks, alias expansion, credential helpers, and external diff drivers are reachable through Git itself; the parser must reject arguments that could enable them (`--exec`, `-c alias.*`, `-c core.editor`, etc.).

### Questions / Blockers

- The legacy `LandingStrategy` field is referenced by the dashboard and run artifacts. Keep it as a derived field for one release, then remove.
- `merge-no-ff` vs `merge` is modeled as a flag on `MergeArgs.fastForward`.
- `landing-ai.ts` requires a schema bump. Confirm the prompt can ask for `actions[]` instead of `strategy`.

## 3. Implementation Plan

- [ ] **Step 1: New Git command AST and parser**

  - **Files:** Create `packages/core/src/runtime/git-command-parser.ts`.
  - **Interfaces:**
    - `GitAction { program: "git"; args: string[]; intent: string }`
    - `GitCommand` discriminated union (subset below).
    - `parseGitAction(input: { args: string[] }): ParseResult<GitCommand>` returning `{ ok: true, command: GitCommand } | { ok: false, reason: string }`.
  - **Code (skeleton):**

    ```ts
    export type GitCommand =
      | { command: "merge"; args: MergeArgs }
      | { command: "rebase"; args: RebaseArgs }
      | { command: "cherry-pick"; args: CherryPickArgs }
      | { command: "checkout"; args: CheckoutArgs }
      | { command: "switch"; args: SwitchArgs }
      | { command: "branch"; args: BranchArgs }
      | { command: "reset"; args: ResetArgs }
      | { command: "restore"; args: RestoreArgs }
      | { command: "commit"; args: CommitArgs }
      | { command: "fetch"; args: FetchArgs }
      | { command: "push"; args: PushArgs }
      | { command: "update-ref"; args: UpdateRefArgs }
      | { command: "rev-parse"; args: RevParseArgs }
      | { command: "diff"; args: DiffArgs }
      | { command: "status"; args: StatusArgs }
      | { command: "log"; args: LogArgs }
      | { command: "show"; args: ShowArgs };

    export function parseGitAction(input: { args: string[] }): ParseResult<GitCommand> { /* ... */ }
    ```

    The parser must reject:

    - Any argument starting with `--exec`, `-c`, `--upload-pack`, `--receive-pack`, `--config-env`.
    - Anything outside the union.
    - Path arguments containing `..` segments, NUL bytes, or shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `\n`).
    - Empty argv or argv length exceeding 64.

  - **Negative Paths:**
    - Unknown verb: reject with `reason: "Unsupported git command: <verb>"`.
    - Banned argument: reject with `reason: "Argument enables external execution: <arg>"`.
    - Path traversal: reject with `reason: "Path argument escapes worktree"`.

  - **Verification:** `node --test tests/git-command-parser.test.mjs` — PASS, including:
    - `parses merge --no-ff target`
    - `parses cherry-pick abc def`
    - `rejects --exec <cmd>`
    - `rejects -c alias.x=foo`
    - `rejects shell metacharacters in paths`
    - `rejects empty argv`

- [ ] **Step 2: Effect classifier**

  - **Files:** Create `packages/core/src/runtime/git-command-effects.ts`.
  - **Interfaces:**
    - `GitEffects` with boolean flags and `affectedRefs`, `affectedPaths`, `remotes` arrays.
    - `classifyEffects(cmd: GitCommand, ctx: { repoRoot: string }): GitEffects`.
  - **Code (skeleton):**

    ```ts
    export interface GitEffects {
      modifiesWorktree: boolean;
      modifiesIndex: boolean;
      createsCommit: boolean;
      movesLocalRefs: boolean;
      modifiesRemoteRefs: boolean;
      mayDiscardChanges: boolean;
      mayOverwriteRef: boolean;
      invokesExternalProcess: boolean;
      modifiesGitConfig: boolean;
      affectedRefs: string[];
      affectedPaths: string[];
      remotes: string[];
    }
    ```

    `reset --hard`, `restore --staged --worktree --source=<ref>`, and force push set `mayDiscardChanges=true`. `cherry-pick` with multiple SHAs sets `mayOverwriteRef=true`. `update-ref` always sets `mayOverwriteRef=true`.

  - **Negative Paths:** Unknown verb → throw to caller; the parser must run first. Effects that depend on environment (e.g. `--force`) must be derived purely from argv.
  - **Verification:** `node --test tests/git-command-effects.test.mjs` — PASS, including:
    - `reset --soft HEAD~1 → mayDiscardChanges=false`
    - `reset --hard HEAD~1 → mayDiscardChanges=true`
    - `push origin candidate → modifiesRemoteRefs=true, mayOverwriteRef=false`
    - `push --force-with-lease origin candidate → mayOverwriteRef=true`
    - `cherry-pick abc def → mayOverwriteRef=true`

- [ ] **Step 3: Composed landing-plan type**

  - **Files:** Modify `packages/core/src/runtime/landing-types.ts`.
  - **Interfaces:**

    ```ts
    export interface LandingActionGit {
      kind: "git";
      step: GitAction;
    }
    export interface LandingActionPullRequest {
      kind: "pull-request";
      provider: "github";
      sourceBranch: string;
      targetBranch: string;
      title: string;
      body: string;
      draft: boolean;
    }
    export type LandingAction = LandingActionGit | LandingActionPullRequest;
    export interface LandingPlan {
      goal: string;
      rationale: string;
      actions: LandingAction[];
      /** Derived from first git action; legacy readers continue to work. */
      strategy?: LandingStrategy;
      targetBranch: string;
      candidateSha?: string;
      sourceBranch?: string;
      expectedFiles: string[];
      risk: LandingRisk;
    }
    ```

  - **Code:** Keep `LandingStrategy` (line 4) for derived read-only display. Add the union above. Replace `reasoning: string[]` with `rationale: string`. Add a `derivedStrategy()` helper that maps the first git action to a strategy name when needed by artifacts.
  - **Negative Paths:** Empty `actions` is allowed only for explicit PR plans; the validator in Step 4 rejects empty arrays.
  - **Verification:** `npm run typecheck` — PASS. `node --test tests/landing.test.mjs` — PASS for existing tests that still construct `LandingPlan` with `strategy`.

- [ ] **Step 4: Validator: accept or reject only**

  - **Files:** Modify `packages/core/src/runtime/landing-git.ts`. Keep `validateLandingPlan`; pass `actions[]` instead of `strategy` and return `LandingGuardVerdict` with `reasons[]` and `notes[]` only.
  - **Interfaces:**

    ```ts
    export async function validateLandingPlan(input: {
      mergeCwd: string;
      plan: LandingPlan;
      dirtyRelevantFiles: string[];
      dirtyUnrelatedFiles: string[];
      finalMergePolicy: "required" | "not-required";
      completedTasks: PrototypeCompletedTaskArtifact[];
      verificationStatus: string;
      nonGoals?: string[];
      scopeGuardBlocking?: boolean;
      allowedRemotes?: string[];
    }): Promise<LandingGuardVerdict>;
    ```

  - **Code (skeleton):**

    ```ts
    const verdicts: string[] = [];
    for (const action of plan.actions) {
      if (action.kind === "pull-request") {
        // provider constraints only; never executed as shell
      } else {
        const parsed = parseGitAction({ args: action.step.args });
        if (!parsed.ok) verdicts.push(parsed.reason);
        else {
          const effects = classifyEffects(parsed.command, { repoRoot: input.mergeCwd });
          if (effects.invokesExternalProcess) verdicts.push("EXTERNAL_PROCESS");
          if (effects.modifiesRemoteRefs && !effects.remotes.every(r => (input.allowedRemotes ?? []).includes(r))) verdicts.push("UNAUTHORIZED_REMOTE");
          // ...continue for each invariant
        }
      }
    }
    ```

    Hard invariants kept: refs exist, candidate scope, dirty-target overlap, multi-commit source branch, etc. The validator never substitutes steps.

  - **Negative Paths:**
    - Parser failure → `reasons.push("PARSE_FAILED: <reason>")`.
    - `mayDiscardChanges && hasUnprotectedDirtyWork` → `reasons.push("WOULD_DESTROY_DIRTY_WORK")`.
    - `modifiesRemoteRefs && !allowedRemotes.includes(...)` → `reasons.push("UNAUTHORIZED_REMOTE")`.
    - `finalMergePolicy === "required" && actions.length === 0` → `reasons.push("EMPTY_PLAN")`.
  - **Verification:** `node --test tests/landing-composed.test.mjs` — PASS, including:
    - `rejects plan that destroys dirty worktree`
    - `rejects unauthorized remote`
    - `rejects --exec argument`
    - `accepts merge --no-ff + push sequence`
    - `accepts reset --soft (does not destroy worktree)`

- [ ] **Step 5: New executor that runs validated argv sequences**

  - **Files:** Create `packages/core/src/runtime/git-execution.ts`. Modify `packages/core/src/runtime/landing-git.ts` (replace `executeLandingStrategy` and `runGitLandingCommand`).
  - **Interfaces:**

    ```ts
    export async function executeLandingPlan(input: {
      cwd: string;
      plan: LandingPlan;
    }): Promise<LandingExecutionResult>;
    ```

    Behavior:

    - For each action in `plan.actions`:
      1. parse with `parseGitAction`;
      2. classify effects;
      3. compare against `currentGitState(cwd)` to detect unexpected dirty state mid-plan;
      4. spawn `execFile("git", parsedArgs)` **with the exact argv** (no rewriting).
      5. on failure, run the corresponding abort command (`merge --abort`, `rebase --abort`, `cherry-pick --abort`) and stop.
    - For `kind: "pull-request"`, call `createRecoveryPullRequest` with the validated fields.

  - **Code (skeleton):**

    ```ts
    for (const action of input.plan.actions) {
      if (action.kind === "pull-request") {
        const pr = await createRecoveryPullRequest({ cwd: input.cwd, sourceBranch: action.sourceBranch, targetBranch: action.targetBranch, runId, goal, reason: input.plan.rationale });
        // record outcome, continue
        continue;
      }
      const parsed = parseGitAction({ args: action.step.args });
      if (!parsed.ok) return { status: "blocked", outcome: "unsafe-plan", reason: parsed.reason };
      try {
        await execFileAsync("git", parsedArgs(parsed.command), { cwd: input.cwd });
      } catch (e) {
        await abortGitOperation(input.cwd, parsed.command);
        return { status: "blocked", outcome: classifyOperationFailure(parsed.command, e), reason: String(e) };
      }
    }
    return { status: "landed", outcome: "landed" };
    ```

  - **Negative Paths:**
    - Abort failure during cleanup is logged and surfaced; status stays `blocked`.
    - `push --force` is allowed only when effects classify as `mayOverwriteRef=true` and the validator approved it; the executor does not second-guess.
  - **Verification:** `node --test tests/landing-composed.test.mjs` — PASS, including:
    - `executes a multi-step git sequence end-to-end`
    - `aborts merge cleanly on conflict and reports blocked`
    - `does not execute --exec argument`

- [ ] **Step 6: Update `runLandingFlow` to call the composed executor and validator**

  - **Files:** Modify `packages/core/src/runtime/landing.ts`.
  - **Interfaces:** Keep `runLandingFlow` signature; change internal call sites to use `validateLandingPlan` and `executeLandingPlan`.
  - **Code (skeleton):**

    ```ts
    plan = (await buildLandingPlanWithRecovery(input, executor, modelSelection, dirtyContext)).plan;
    let guardVerdict = await validateLandingPlan({
      mergeCwd: input.mergeCwd,
      plan,
      dirtyRelevantFiles: dirtyContext.relevant,
      dirtyUnrelatedFiles: dirtyContext.unrelated,
      finalMergePolicy: input.config.approval.finalMerge,
      completedTasks: input.completedTasks,
      verificationStatus: input.verification.overallStatus,
      nonGoals: input.planContract?.nonGoals,
      scopeGuardBlocking: input.config.scope?.landing === "block",
      allowedRemotes: await listRemotes(input.mergeCwd),
    });
    // remove the multi-commit cherry-pick → merge rewrite
    // let execution = await executeLandingStrategy(...); → executeLandingPlan(...)
    ```

  - **Negative Paths:** Empty plan + `finalMergePolicy=required` blocks; the validator handles this in Step 4.
  - **Verification:** `node --test tests/landing.test.mjs` — PASS for legacy tests; `node --test tests/landing-composed.test.mjs` — PASS for new flows.

- [ ] **Step 7: Recovery returns new plans, not strategy overrides**

  - **Files:** Modify `packages/core/src/runtime/failure-recovery.ts` and `packages/core/src/runtime/landing.ts`.
  - **Interfaces:**

    ```ts
    export type RecoveryAction =
      | { action: "execute-plan"; plan: LandingPlan }
      | { action: "stop"; reason: string };
    ```

  - **Code:** Replace strategy-level `retry | revise | repair` recovery for landing with the above union. The LLM proposes a new plan or stops. `policy-constraints.ts` checks that:
    - `nextPhase` is in allowed phases,
    - `attempt` matches and does not exceed `maxAttempts`,
    - `decidedAt` parses,
    - if `action === "execute-plan"`, the plan must pass `validateLandingPlan` before execution.
  - **Negative Paths:**
    - Plan fails revalidation → fall back to `stop` with the validator's reason.
    - `attempt > maxAttempts` → reject.
  - **Verification:** `node --test tests/runtime.test.mjs` — PASS; `node --test tests/landing-composed.test.mjs` — PASS, including `recovery plan re-validates before execution`.

- [ ] **Step 8: Artifact and event updates**

  - **Files:** Modify `packages/core/src/runtime/artifacts.ts`, `packages/core/src/runs/show.ts`, `packages/core/src/runs/logs-by-id.ts`.
  - **Interfaces:** `PrototypeLandingPlanArtifact` adds `actions: LandingAction[]`, `rationale: string`. Per-step execution results go to `landing-attempts.jsonl` entries.
  - **Code:** Add `landing.step_applied` and `landing.step_blocked` events with `{ index, args, exitCode, stderr }`.
  - **Negative Paths:** Missing argv at write-time is impossible; the parser guarantees argv exists.
  - **Verification:** `node --test tests/landing-composed.test.mjs` — assert events are written and `landing-plan.json` round-trips through `run/show.ts`.

- [ ] **Step 9: Update prompts in `landing-ai.ts`**

  - **Files:** Modify `packages/core/src/runtime/landing-ai.ts`.
  - **Interfaces:** `LandingPlan` from Step 3 is the contract.
  - **Code (skeleton):**

    ```ts
    const prompt = [
      "Return ONLY JSON for LandingPlan.",
      "- `actions[]` is required. Each action is `{ kind: 'git', step: { program: 'git', args, intent } }` or `{ kind: 'pull-request', provider: 'github', ... }`.",
      "- Do NOT use --exec, -c alias.*, -c core.editor, --upload-pack, --receive-pack.",
      "- Do NOT include shell metacharacters in any path.",
      "- Prefer non-destructive operations when possible. Use --soft or --mixed before --hard.",
      "- For multi-commit candidates, prefer a single `merge --no-ff` over per-commit cherry-picks.",
      "- The validator will reject plans that destroy dirty work, push to disallowed remotes, or invoke external processes.",
    ].join("\n");
    ```

  - **Negative Paths:** Invalid JSON → `buildBlockingLandingPlan` (existing fallback). Plan with banned argument → still rejected by validator; never silently accepted.
  - **Verification:** `node --test tests/landing.test.mjs` and `tests/landing-composed.test.mjs` — PASS.

- [ ] **Step 10: Documentation and dashboard text**

  - **Files:** Modify `docs/factory/workflow-authoring.md`. Update landing section.
  - **Code (prose):** Document that landing is now an LLM-owned composed Git plan with deterministic validation; show a minimal plan example and the validator invariants.
  - **Verification:** No runtime check; manual review.

## 4. Testing

### New tests

- `tests/git-command-parser.test.mjs`:
  - happy paths for each supported verb;
  - rejection of `--exec`, `-c`, path traversal, metacharacters, empty argv, oversized argv.
- `tests/git-command-effects.test.mjs`:
  - `reset --soft` vs `reset --hard`;
  - normal push vs force push (`--force`, `--force-with-lease`);
  - multi-arg cherry-pick → `mayOverwriteRef=true`;
  - `update-ref` → `mayOverwriteRef=true`.
- `tests/landing-composed.test.mjs`:
  - validator accepts a multi-step merge-then-push plan;
  - validator rejects dirty-work destruction;
  - validator rejects unauthorized remote;
  - executor aborts merge on conflict and returns `blocked`;
  - executor executes exact argv (no rewriting);
  - recovery plan revalidates before execution;
  - empty plan blocks under `finalMergePolicy=required`;
  - PR-only plan skips Git steps.

### Existing test updates

- `tests/landing.test.mjs`: keep tests that exercise `LandingPlan.strategy` for backward compatibility; the field becomes derived.
- `tests/runtime.test.mjs`: add a scenario where the LLM returns `actions[]` and confirm event order.

### Commands

```bash
cd /Users/slammtechnologies/Documents/GitHub/pi-factory
npm run build
node --test tests/git-command-parser.test.mjs
node --test tests/git-command-effects.test.mjs
node --test tests/landing-composed.test.mjs
node --test tests/landing.test.mjs
node --test tests/runtime.test.mjs
npm run typecheck
npm test
```

Expected: all PASS.

## 5. Definition of Done

- [ ] Landing plans are stored as `actions[]`; the validator accepts or rejects only.
- [ ] Parser rejects `--exec`, `-c alias.*`, `-c core.*`, shell metacharacters, path traversal, empty argv.
- [ ] Executor runs exact validated argv per step; never rewrites.
- [ ] Validator never substitutes one strategy for another.
- [ ] Recovery returns `execute-plan` or `stop`; new plans revalidate.
- [ ] Force push, `reset --hard`, and destructive restores are blocked when dirty or unauthorized.
- [ ] Multi-commit candidates land via branch merge unless the LLM proposes otherwise.
- [ ] PR-only plans skip Git execution entirely.
- [ ] Per-step events and per-step attempts are recorded in `landing-attempts.jsonl` and `landing-plan.json`.
- [ ] `npm run typecheck` passes.
- [ ] All new and existing landing tests pass.
- [ ] `docs/factory/workflow-authoring.md` documents the new model.
