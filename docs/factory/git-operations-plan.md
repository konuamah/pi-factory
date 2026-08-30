# Factory Git Operations Plan — Safe Merge with Recovery

Status: proposal — not yet implemented.

Use this plan when making Factory's git integration land work safely and honestly. It replaces the current blind `git merge --no-ff` in the user's checkout with a readiness-checked, failure-classified, recovery-safe merge pipeline.

## Background

A "add a hero section" run in LandOptima reported `COMPLETED` while the final merge was actually `skipped`:

```json
{
  "status": "skipped",
  "reason": "Your local changes to the following files would be overwritten by merge:
            frontend/landoptima/next-env.d.ts
            frontend/landoptima/src/app/LandAnalysis.tsx
            frontend/landoptima/src/app/layout.tsx
  Please commit your changes or stash them before you merge."
}
```

The builder had built the hero correctly (dangling commit `5bd59c5`), but:

- Factory never checked `git status` before merging, so the dirty checkout aborted the merge.
- Factory reported `COMPLETED` anyway because merge `skipped` was treated as success.
- The candidate branch was later pruned, leaving the hero only as a dangling commit unreachable from any branch.

## Problem Summary

1. **Dirty-checkout blind spot** — no `git status` preflight before the final merge.
2. **`skipped` is a catch-all** — policy skip, env skip, and failure all collapse into one status, and the controller ignores it.
3. **No conflict handling on final merge** — task integration has conflict classification and AI repair; the final merge has none.
4. **Merge mutates the user's checkout** — Factory checks out the base branch in the primary worktree.
5. **Cleanup outruns safety** — candidate branches are pruned even when never merged.

## Goals

- Land candidate work into the base branch, or fail loudly and honestly.
- Never report `COMPLETED` when the work did not land.
- Preserve recovery paths: candidate branch + SHA survive merge failure.
- Reuse the existing failure-classification and decision-gate philosophy (facts first, deterministic guards, AI where judgment matters).
- Keep it language- and framework-agnostic.

## Non-Goals

- Do not replace the task-level integration merge (per-task worktree merging already works and has conflict repair).
- Do not introduce a remote git service or PR flow in this pass.
- Do not auto-resolve real merge conflicts silently beyond the bounded AI repair already used at integration time.

## Pass 1: Merge readiness preflight

Problem: Factory merges without checking whether the target checkout can accept the merge.

Implementation:

- Add a `git operations` helper that runs before any final merge:

```ts
interface MergePreflight {
  ok: boolean;
  reason?: string;
  dirtyOverlappingFiles: string[];
  dirtyUnrelatedFiles: string[];
  candidateExists: boolean;
  candidateSha?: string;
  baseClean: boolean;
}
```

- Compute:
  - `git status --porcelain` in `mergeCwd`
  - `git rev-parse --verify <candidateBranch>` (candidate exists / SHA)
  - overlap between dirty files and the candidate's changed files (`git diff --name-only <base>...<candidate>`)
- Decision:
  - candidate missing → `ok: false`, reason `missing-candidate`
  - dirty files overlapping candidate changes → `ok: false`, reason `dirty-checkout`, with the exact file list
  - dirty files not overlapping → `ok: true`, but record `dirtyUnrelatedFiles` (safe to merge over)
- Emit `merge.preflight` event with the preflight result.

Primary files:

- `packages/core/src/git/merge.ts` (new)
- `packages/core/src/runtime/controller.ts`

Tests:

- clean checkout merges (preflight ok)
- dirty overlapping file blocks with the file list
- dirty unrelated file is allowed and recorded
- missing candidate branch blocks with `missing-candidate`

## Pass 2: Classify merge outcomes

Problem: `merged` vs `skipped` is not enough; failures need a category and a recovery action.

Implementation:

- Add merge outcome classification:

```ts
type MergeOutcome =
  | "merged"
  | "policy-skipped"
  | "dirty-checkout"
  | "conflict"
  | "missing-candidate"
  | "unknown";
```

- `conflict` reuses `classifyIntegrationFailure` (conflicting files, merge-in-progress).
- `dirty-checkout` maps to Pass 1's overlap list.
- Each non-success outcome records:
  - `candidateBranch`
  - `candidateSha`
  - `reason`
  - `recoveryHint` (e.g. "stash or commit these files, then merge <branch>" or "cherry-pick <sha>")
- Write the classification into `final-merge.json` (extend the artifact with `outcome` and `recoveryHint`).

Primary files:

- `packages/core/src/git/merge.ts`
- `packages/core/src/runtime/artifacts.ts`

Tests:

- dirty-checkout classified with overlapping files
- conflict classified via existing integration classifier
- policy skip still classified `policy-skipped`
- unknown failures fall back to `unknown`

## Pass 3: Honest run states

Problem: a run reports `COMPLETED` even when the merge was `skipped` or failed.

Implementation:

- After the final merge phase, branch on outcome:

```text
merged            → COMPLETED / complete
policy-skipped    → COMPLETED / complete (merge not required by policy — still honest)
dirty-checkout    → BLOCKED / merge-blocked
conflict          → BLOCKED / merge-blocked (or AI repair, see Pass 4)
missing-candidate → BLOCKED / merge-blocked
unknown           → BLOCKED / merge-blocked
```

- Never write `run.completed` for a blocked merge.
- Emit `run.blocked` with `reason: "final merge did not land"` and the recovery hint.
- `/factory resume` gains a `merge-blocked` branch that:
  - re-runs the preflight
  - if the checkout is clean now, retries the merge
  - otherwise reports what still blocks it
- `/factory show` and `/factory logs` surface the merge outcome + recovery hint.

Primary files:

- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runs/resume.ts`
- `packages/core/src/runs/show.ts`
- `packages/core/src/runs/logs-by-id.ts`

Tests:

- failed merge → `BLOCKED / merge-blocked`, not `COMPLETED`
- policy-skipped merge → `COMPLETED`
- resume on `merge-blocked` retries when clean

## Pass 4: Conflict handling on final merge

Problem: a real merge conflict at final-merge time has no automatic repair (only the manual gateway path).

Implementation:

- Reuse the integration conflict path for the final merge:
  - classify conflict files
  - bounded AI repair (single attempt) with the existing `repairExecutor`
  - if conflict cleared and merge still in progress, finalize the merge commit
  - if repair fails, `BLOCKED / merge-blocked` with the conflicting files
- Keep it bounded: one attempt, same as integration auto-repair.

Primary files:

- `packages/core/src/git/merge.ts`
- `packages/core/src/runtime/controller.ts`

Tests:

- a seeded merge conflict is repaired once and merged
- a repair that fails leaves the run blocked with conflicting files

## Pass 5: Branch cleanup safety

Problem: unmerged candidate branches are pruned, stranding work as dangling commits.

Implementation:

- Cleanup (`git.cleanup.pruneBranches`) only prunes a candidate branch when its tip is an ancestor of the base branch (already merged) or a policy flag explicitly allows pruning unmerged branches.
- Add a `pruneUnmerged: false` default to `git.cleanup`.
- When a merge fails, never prune that branch; record `candidateBranch` + `candidateSha` in the run artifact so recovery is possible.

Primary files:

- `packages/core/src/git/cleanup.ts` (or the existing cleanup in `runs/cleanup.ts`)
- `packages/schemas/src/config.ts` (`git.cleanup.pruneUnmerged`)

Tests:

- an unmerged candidate branch survives cleanup
- a merged branch is pruned
- `pruneUnmerged: true` overrides and prunes anyway

## Pass 6: Optional config

```yaml
git:
  merge:
    strategy: merge        # merge | merge-no-ff | rebase
    autoStash: true        # stash non-overlapping dirty state before merge
```

- `strategy: rebase` is a future path; this pass implements `merge` and `merge-no-ff`.
- `autoStash: true` applies only when `dirtyUnrelatedFiles` is non-empty (never stashes overlapping changes).

Primary files:

- `packages/schemas/src/config.ts`
- `packages/core/src/config/merge.ts`
- `packages/core/src/git/merge.ts`

Tests:

- `autoStash` merges over unrelated dirty files and restores them
- overlapping dirty files are never auto-stashed

## Docs And Skills

Update in the same change as implementation:

- `docs/factory/troubleshooting.md` — "Run Completes With Baseline Repository Debt" → add "Run Blocked Because Merge Did Not Land"
- `docs/factory/worktree-and-dependencies.md` (or the git section) — merge strategy + recovery
- `skills/factory-concierge/SKILL.md` + `.pi/skills/factory-concierge/SKILL.md` — recovery guidance for `merge-blocked`
- `learnings.md`

Concierge should explain:

- why a run can be `BLOCKED / merge-blocked`
- how to inspect `final-merge.json` (outcome, reason, recoveryHint)
- the exact commands to recover (commit/stash, then `/factory resume` or manual merge/cherry-pick)

## Rollout Order

1. Merge readiness preflight.
2. Classify merge outcomes.
3. Honest run states + resume.
4. Conflict handling on final merge.
5. Branch cleanup safety.
6. Optional config (strategy / autoStash).

This order gives the safety fix first (no more false COMPLETED), then recovery, then conflict handling, then cleanup guarantees.

## Verification

Run after each pass:

```bash
npm run build
node --test tests/git-merge.test.mjs
node --test tests/runtime.test.mjs
```

For merge-specific changes, add focused tests that assert:

- a run never reports `COMPLETED` when `final-merge.json` is not `merged`
- dirty overlapping files block with the exact file list
- an unmerged candidate branch survives cleanup
- `merge-blocked` resume retries after the checkout is cleaned
