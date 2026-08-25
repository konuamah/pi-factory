# Factory Handoff

Date: 2026-08-25

## Repositories

- Source Factory repo: `/Users/slammtechnologies/Documents/GitHub/pi-factory`
- Active SLAMM repo: `/Users/slammtechnologies/Documents/GitHub/slammghana`
- Vendored Factory copy: `/Users/slammtechnologies/Documents/GitHub/slammghana/vendor/pi-factory`
- Innopriv repo: `/Users/slammtechnologies/Documents/GitHub/innopriv` (vendored Factory at `/Users/slammtechnologies/Documents/GitHub/innopriv/vendor/pi-factory`)

## Skill Docs Structure (updated 2026-08-25)

The `factory-concierge` skill references real docs at `docs/factory/`, not vendored files.

- Factory docs (11 files: README, concepts, setup-operations, workflow-authoring, model-routing, skills-library, dashboard, constitution, permissions-and-safety, troubleshooting, examples) are copied into each consuming project at `<project>/docs/factory/`.
- The skill (`.pi/skills/factory-concierge/SKILL.md`) references `docs/factory/README.md` as the hub and each specific doc by `docs/factory/<name>.md` — resolved from the project root.
- Copies exist in: `pi-factory` (source, already had `docs/factory/`), `innopriv`, `slammghana`. All three skill copies are byte-identical (verified by md5).
- When Factory docs change in `pi-factory/docs/factory/`, re-copy to each project's `docs/factory/` (they are NOT synced by the vendor rsync).

## Innopriv Pi Discovery Setup (added 2026-08-25)

To make pi find and run Factory in `innopriv`, the same plumbing slammghana has must exist. `innopriv` is now set up with the **vendor copy** (unlike slammghana, whose `node_modules/@factory` symlinks point at the *source* repo).

Files created in `innopriv`:

- `.pi/extensions/factory/index.ts` — pi extension entry (imports `@factory/adapter-pi`).
- `.pi/skills/factory-concierge/SKILL.md` — copied from slammghana.
- `node_modules/@factory/{adapter-pi,adapter-web,core,executor-pi,schemas}` — symlinks to `../../vendor/pi-factory/packages/*`.
- `node_modules/@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui}` — symlinks to the global pi install (`/Users/slammtechnologies/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/*`). **Required** because the Pi SDK executor dynamically `import("@earendil-works/pi-coding-agent")`, and the vendored copy excludes `node_modules/`.
- `.gitignore` — `node_modules/` added; `/vendor/` was already present. `.pi/` is NOT ignored (should be committed).

Important: keep `@earendil-works` symlinks at `innopriv/node_modules/@earendil-works/` (NOT inside `vendor/pi-factory/node_modules/`) so they survive the rsync vendor re-sync (which `--delete`-s vendored `node_modules`).

Status: pi finds `/factory`; `@factory/adapter-pi` loads; SDK session creation verified. `validateFactorySetup` is `NOT_READY` until `/factory setup` runs (missing `factory.yaml`, `.factory/config.yaml`, `CONSTITUTION.md`, repo commands).

Treat `pi-factory` as authoritative, then sync into `slammghana/vendor/pi-factory` with:

```sh
rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.factory/' \
  --exclude='.worktrees/' \
  /Users/slammtechnologies/Documents/GitHub/pi-factory/ \
  /Users/slammtechnologies/Documents/GitHub/slammghana/vendor/pi-factory/
```

## User Intent

The user is building a Pi extension/workflow system called Factory for `slammghana`.

The desired behavior is:

- Factory works inside Pi using the vendored package.
- Discovery is evidence-based and does not hallucinate files.
- Planner uses Discovery evidence and does not rediscover.
- Builder actually edits files, not commentary-only intent.
- Verification and repair are scoped to the implementation, not the whole repo's old problems.
- Failures should be loud and specific. No silent fallbacks.
- Constitution refresh is disabled in `slammghana` and should stay disabled unless explicitly re-enabled.
- `slammghana` should use `openai-codex/gpt-5.4-mini` for all Factory roles.

Current model config in `/Users/slammtechnologies/Documents/GitHub/slammghana/.factory/config.yaml`:

```yaml
models:
  discovery: { provider: openai-codex, model: gpt-5.4-mini }
  planner: { provider: openai-codex, model: gpt-5.4-mini }
  builder: { provider: openai-codex, model: gpt-5.4-mini }
  reviewer: { provider: openai-codex, model: gpt-5.4-mini }
  repair: { provider: openai-codex, model: gpt-5.4-mini }
```

## Important Fixes Already Made

### Pi SDK Tool Contract

Root cause found via Pi docs and installed SDK inspection:

- Pi SDK `createAgentSession({ tools })` expects active tool names like `["read", "bash", "edit"]`.
- Factory was incorrectly passing tool objects in `tools`.
- This caused builders to respond with text like "I'll inspect..." without native tool calls.

Fix:

- `/Users/slammtechnologies/Documents/GitHub/pi-factory/packages/executors/pi/src/sdk-factory.ts`
- Factory now passes `createOptions.tools = tools`.
- Executable tool objects are kept separately for Factory's DSML/manual bridge.

Tests:

- `/Users/slammtechnologies/Documents/GitHub/pi-factory/tests/pi-executor.test.mjs`
- Covers active tool names and bridge execution.

### Builder No-Diff Guardrail

Factory now treats this as failure:

```text
builder completed + no file changes
```

It retries once with explicit implementation instructions, then fails loudly if no diff is produced.

Files:

- `/Users/slammtechnologies/Documents/GitHub/pi-factory/packages/core/src/runtime/controller.ts`
- `/Users/slammtechnologies/Documents/GitHub/pi-factory/tests/runtime.test.mjs`

### Verification/Repair Scope Guard

Latest issue: Factory ran full-repo lint, failed on old unrelated lint errors, then repair edited unrelated files.

Fix added:

- Verification classification now supports `baseline/unrelated`.
- Failed repo scripts that mention files outside the implementation-changed files are not treated as implementation-caused.
- Verification repair now only runs for `real code failure`.
- Git porcelain changed-file parsing was fixed so paths do not lose the first character (`src/...` was previously logged as `rc/...`).

Files:

- `/Users/slammtechnologies/Documents/GitHub/pi-factory/packages/core/src/runtime/failure-classification.ts`
- `/Users/slammtechnologies/Documents/GitHub/pi-factory/packages/core/src/runtime/controller.ts`
- `/Users/slammtechnologies/Documents/GitHub/pi-factory/packages/core/src/runtime/artifacts.ts`
- `/Users/slammtechnologies/Documents/GitHub/pi-factory/tests/runtime.test.mjs`

## Verification Already Run

In `pi-factory`:

```sh
npm run build
node --test tests/pi-executor.test.mjs tests/pi-executor-gate.test.mjs
node --test tests/runtime.test.mjs
```

All passed after the latest repair-scope changes.

## Latest Factory Run In Slammghana

Run:

```text
/Users/slammtechnologies/Documents/GitHub/slammghana/.factory/runs/run_1787659577663_69facd88
```

State:

```text
status: COMPLETED
phase: complete
goal: run add next intake badges to course cards
candidateSha: c1f49607e74b5577cbcaa481bfee3e371af00155
verificationStatus: passed
```

What changed in the actual feature commit:

```text
src/app/courses/components/EvergreenCourseGrid.tsx | 15 insertions
```

Main `slammghana` log now includes:

```text
18af167 Merge branch 'factory-run-add-next-intake-badges-to--8mcrfg'
c1f4960 Merge branch 'factory-run-add-next-intake-badges-to--8mcrfg-task-3'
c66af7a Factory task task-3: Implement changes for: run add next intake badges to course cards
```

Important caution:

- The run worktree `/Users/slammtechnologies/Documents/GitHub/slammghana/.worktrees/factory-run-add-next-intake-badges-to--8mcrfg` has dirty repair edits in unrelated files.
- These appear to be broad lint repairs caused by the old Factory behavior.
- Do not treat them as intentional unless the user explicitly wants full-repo lint cleanup.

Dirty files in that run worktree:

```text
hooks/useRateLimiter.js
src/app/components/CountryBadge.jsx
src/app/components/GeoRedirectPopup.jsx
src/app/courses/components/navbarclient.js
src/app/cybersecurity-certification-course-ghana/promotion/CoursePopup.tsx
src/app/services/components/navbarclient.js
src/app/upcoming-course/components/AIEnhancedQuestionnaire.js
src/app/verify/components/VerificationResult.tsx
```

## Worktree Cleanup Fix (added 2026-08-25)

### Root cause

Worktrees were created but never removed by the run lifecycle. The only cleanup path was the manual `/factory cleanup` subcommand (`gateway.ts` → `cleanupFactoryRuns`), and it only ran `git worktree remove` on recorded paths — it never ran `git worktree prune`. When a worktree directory was removed externally (e.g. by an outside process or a previous manual cleanup), `git worktree remove` failed and the stale metadata (plus branches) remained, showing as `prunable` entries in `git worktree list`.

### Fixes

- `packages/core/src/runs/cleanup.ts`: extracted `removeRunGitIsolation()` (worktree + branch removal for one run's recorded artifacts) and made it **always run `git worktree prune`** after removal so stale metadata is cleared even when directories are already gone. Only `workspaceMode === "created"` entries are removed — pre-existing/reused (`existing`) and in-place workspaces are never touched.
- `packages/core/src/runtime/controller.ts`: wrapped `runFactoryController` in a `try/finally`. The `finally` runs `removeRunGitIsolation` for the run's task artifacts plus an explicit `git worktree remove --force` for the main worktree when Factory created it (`mode === "created"`). This guarantees cleanup on completed, failed, cancelled, and exception paths. Cleanup warnings are appended to the run's `events.jsonl` as `run.cleanup_warnings`.
- `tests/cleanup.test.mjs` (new): covers recorded-worktree removal + prune of externally-deleted stale worktrees, and non-removal of `existing`/`in-place`/unrelated worktrees.

### Immediate cleanup performed in `slammghana`

- `git worktree prune` cleared all 14 stale `factory-run-*` entries (directories were already gone).
- Deleted the 16 orphaned merged `factory-run-*` branches (all were in `git branch --merged main`).
- Verified: `git worktree list` shows only the main checkout; zero `factory-run-*` branches remain.

## Current Source Working Tree

`pi-factory` currently has uncommitted changes in:

```text
packages/core/src/runtime/artifacts.ts
packages/core/src/runtime/controller.ts
packages/core/src/runtime/failure-classification.ts
packages/core/src/runs/cleanup.ts
packages/executors/pi/src/sdk-factory.ts
tests/cleanup.test.mjs
tests/pi-executor.test.mjs
tests/runtime.test.mjs
```

These are intentional Factory fixes from this session. Note: `slammghana` main tip is now `6448e72 Revert next intake badges on course cards` — the earlier feature was reverted after the handoff was written.

## Next Safe Steps

1. Sync `pi-factory` into `slammghana/vendor/pi-factory` again if needed.
2. Validate `slammghana`:

```sh
cd /Users/slammtechnologies/Documents/GitHub/slammghana
node -e "import('./vendor/pi-factory/packages/core/dist/index.js').then(async m => console.log(JSON.stringify(await m.validateFactorySetup(process.cwd()), null, 2)))"
```

3. Restart `pi` before testing again, so the extension reloads the vendored runtime.
4. Test a new Factory run. Expected improved behavior:
   - Builder sees native Pi tools.
   - Builder edits files.
   - If lint fails only in unrelated baseline files, Factory classifies it as `baseline/unrelated`, skips repair, and fails clearly rather than editing unrelated files.

## Useful Commands

Inspect latest run:

```sh
cd /Users/slammtechnologies/Documents/GitHub/slammghana
latest=$(ls -td .factory/runs/run_* | head -n1)
cat "$latest/state.json"
tail -n 160 "$latest/events.jsonl"
```

Inspect builder/repair artifacts:

```sh
cd /Users/slammtechnologies/Documents/GitHub/slammghana
latest=$(ls -td .factory/runs/run_* | head -n1)
ls -la "$latest"
```

Compare source and vendor:

```sh
diff -qr \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=.factory \
  --exclude=.worktrees \
  /Users/slammtechnologies/Documents/GitHub/pi-factory \
  /Users/slammtechnologies/Documents/GitHub/slammghana/vendor/pi-factory
```

