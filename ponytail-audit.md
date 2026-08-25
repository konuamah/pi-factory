# Ponytail Audit — pi-factory

Whole-repo scan for over-engineering. One-shot report; no fixes applied.
Scope: complexity only (correctness/security/performance routed elsewhere).

## Ranked findings

1. **`delete:` 24 compiled artifact files committed into `src/`. Delete them; the build already emits the same into `dist/` (gitignored).**
   `packages/executors/pi/src/*.js`, `*.d.ts`, `*.js.map`, `*.d.ts.map` — 419 lines.
   These are **stale**: 5 of 8 `.js` files differ from current `dist/` output, so they're not a working copy. Root cause: build was pointed at `src/` once (package.json now says `main: dist/index.js`, `dist/` is gitignored). `git rm` them.
   [packages/executors/pi/src/]

2. **`delete:` `packages/executors/fake/` — placeholder with zero callers.**
   `fakeExecutorPlaceholder` is referenced nowhere outside its own files; it's a workspace with a 3-line stub. Delete the whole workspace (package.json, tsconfig, src, root tsconfig ref).
   [packages/executors/fake/]

3. **`delete:` `runtime/prototype.ts` — pure delegation wrapper, zero callers.**
   `runPrototypeFactoryFlow` just calls `runFactoryController` with re-exported types; nothing imports it. Classic wrapper-with-one-implementation.
   [packages/core/src/runtime/prototype.ts]

4. **`delete:` `pi_native_factory_support_research.md` — 1999-line orphan research doc.**
   Nothing references it (not README, not docs/). Decision record, not a living doc.
   [pi_native_factory_support_research.md]

5. **`delete:` `factory.example.json` — orphan, confusingly named.**
   Workflow-only 9-line sample at repo root; nothing references it, and it contradicts the real example `.factory/config.example.json` (`stages` vs `project/commands`).
   [factory.example.json]

6. **`shrink:` `runtime/tasks.ts` → merge into `artifacts.ts`.**
   `updatePrototypeTaskArtifact` is the only content, a sibling of `artifacts.ts` which owns task artifact IO. One caller, one function, one home.
   [packages/core/src/runtime/tasks.ts]

7. **`shrink:` `logs.ts` → inline into its one caller.**
   10-line wrapper around `readLatestFactoryRunStatus` + `readFactoryRunLogs`.
   [packages/core/src/runs/logs.ts]

8. **`yagni:` `runtime/interfaces.ts` — partially unused abstraction.**
   `FactoryHarnessAdapter` (`showProgress`/`requestApproval`/`notify`) — verify callers; drop the interface if only one concrete path is wired.
   [packages/core/src/runtime/interfaces.ts]

9. **`yagni:` single-export barrels.** `context/index.ts`, `doctor/index.ts`, `models/index.ts`, `workflows/index.ts`, `git/index.ts` are each `export * from "./x.js"` for exactly one file. Import the real file directly; delete the barrel.
   (Keep multi-export barrels: `runs/`, `verification/`, `capabilities/`.)

10. **`shrink:` root `SKILL.md` (1747 lines) vs `docs/factory/*` (610 lines).**
    Two overlapping homes for the same product. Pick one canonical, link the other.
    [SKILL.md, docs/factory/]

## Clean — explicitly checked, no action

- `config/` layer (defaults/loader/merge/validate) — no dead flags.
- `constitution/evaluators/` (15 files) — genuinely domain-specific, not copy-paste.
- `runs/*` — distinct functions, real callers.
- `setup/*` — all exported functions have callers.
- `verification/`, `capabilities/`, `skills/`, `models/router.ts` — legit.

## Net

"-**430+ lines** dead/stale deletable, **-1 dependency/workspace** (`@factory/executor-fake`), **-6 files** from barrel/wrapper merges."

Biggest lever is the committed build artifacts — not over-engineering but accidental commit cruft that silently drifts from source. Then delete `executors/fake` + `prototype.ts` and fold the one-caller wrappers; the rest is marginal.

## Out of scope (route to normal review)

- `stages`-schema drift between the two example configs — correctness question, not complexity.