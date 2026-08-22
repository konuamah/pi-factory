# Codebase Constitution

## Agent Operating Summary
- Repository root: D:/projects/pi-factory
- Languages: JavaScript, TypeScript
- Package managers: npm
- Source roots: packages
- Docs roots: README.md
- API files: 0
- Data files: 0
- Tests: 1
- CI: not detected
- Deterministic areas evaluated: 120
- Refresh mode: FAST
- Changed files: 19
- Impacted areas: 1, 2, 3, 4, 9, 10, 11, 20, 73, 81, 83, 85
- Reused areas: none
- Critic warnings: 0

## Interpretation
Brief repository-constitution summary from repo evidence:

- **Layout / architecture:** This is a small **npm workspace monorepo** rooted at `package.json`, with TypeScript project references in `tsconfig.json` pointing at `packages/schemas`, `packages/core`, `packages/adapters/pi`, `packages/executors/fake`, and `packages/executors/pi`.
- **Package roles:**  
  - `packages/schemas/src` holds shared schema/types.  
  - `packages/core/src` is the main domain package: config loading/merge/validation, constitution scanning, doctor, git/worktree support, setup, runs, and runtime control.  
  - `packages/adapters/pi/src` contains the Pi adapter/extension-facing layer.  
  - `packages/executors/fake/src` and `packages/executors/pi/src` provide executor implementations/harnesses.
- **Source organization:** Each package follows `src/**/*.ts` with `rootDir: "src"` and `outDir: "dist"` in package `tsconfig.json` files. Root build/typecheck uses `tsc -b`, so static analysis is TypeScript composite-project based.
- **Testing:** Tests live under `tests/`; naming is `*.test.mjs` at least at root (`tests/constitution.test.mjs`). The actual framework is **Node’s built-in test runner** (`node:test`), invoked via root script: `npm test` = `npm run build && node --test tests/**/*.test.mjs`. Tests import compiled output from `packages/core/dist/...`, so build-before-test is part of convention.
- **Package/tooling conventions:** Package manager is clearly **npm** (`package-lock.json`, root scripts). Manifest conventions are standard per-package `package.json` plus per-package `tsconfig.json`.
- **Module/dependency conventions:** Packages are ESM (`"type": "module"` everywhere). Internal package dependencies are explicit and directional: `core` depends on `schemas`; executors depend on `core`/`schemas`; Pi adapter depends on `core`, `schemas`, and Pi executor.
- **Bootstrap/build:** Evidence shows local development is centered on `npm install`, `npm run build`, `npm run typecheck`, `npm test`, plus harness scripts `harness:pi-executor` and `harness:pi-runtime`.

**Ambiguity explicitly noted:**
- `README.md` describes project focus and runtime/setup behavior, but does **not** give a full step-by-step developer bootstrap guide.
- No lint or format tool/config is present in the provided manifests/files, so **linting conventions are not defined** by evidence.
- `packages/executors/pi/src` contains checked-in `.js`/`.d.ts` alongside `.ts`, which makes generated-file handling somewhat ambiguous from the available evidence.

## Project Snapshot
- Root: D:/projects/pi-factory
- Languages: JavaScript, TypeScript
- Package managers: npm
- Tracked files: 120
- Test files: 1
- CI files: 0
- Docs files: 1
- Script/tool files: 0
- API files: 0
- Data files: 0

## Status Legend
- DEFINED
- INFERRED
- NOT_DEFINED
- NOT_APPLICABLE
- UNCERTAIN

# Observable Facts

## 1. Repository layout
- Status: DEFINED
- Finding: Tracked repository with 120 files and source roots in packages.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: packages — source root
- Claim: [observed] Tracked repository with 120 files and source roots in packages.
  - Claim evidence: packages — source root

## 2. Monorepo / single-project model
- Status: DEFINED (HIGH)
- Finding: Root `package.json` declares `workspaces: ["packages/*"]`, and root `tsconfig.json` references multiple package projects, so the repository model is explicitly a monorepo.
- Evidence: package.json — workspace/manifests
- Evidence: packages/adapters/pi/package.json — workspace/manifests
- Evidence: packages/adapters/pi/tsconfig.json — workspace/manifests
- Evidence: packages/core/package.json — workspace/manifests
- Evidence: packages/core/tsconfig.json — workspace/manifests
- Evidence: packages/executors/fake/package.json — workspace/manifests
- Evidence: packages/executors/fake/tsconfig.json — workspace/manifests
- Evidence: packages/executors/pi/package.json — workspace/manifests
- Evidence: packages/executors/pi/tsconfig.json — workspace/manifests
- Evidence: packages/schemas/package.json — workspace/manifests
- Evidence: packages/schemas/tsconfig.json — workspace/manifests
- Evidence: tsconfig.json — workspace/manifests
- Claim: [observed/HIGH] Root `package.json` declares `workspaces: ["packages/*"]`, and root `tsconfig.json` references multiple package projects, so the repository model is explicitly a monorepo.
  - Claim evidence: package.json — workspace/manifests
  - Claim evidence: packages/adapters/pi/package.json — workspace/manifests
  - Claim evidence: packages/adapters/pi/tsconfig.json — workspace/manifests
  - Claim evidence: packages/core/package.json — workspace/manifests
  - Claim evidence: packages/core/tsconfig.json — workspace/manifests
  - Claim evidence: packages/executors/fake/package.json — workspace/manifests
  - Claim evidence: packages/executors/fake/tsconfig.json — workspace/manifests
  - Claim evidence: packages/executors/pi/package.json — workspace/manifests
  - Claim evidence: packages/executors/pi/tsconfig.json — workspace/manifests
  - Claim evidence: packages/schemas/package.json — workspace/manifests
  - Claim evidence: packages/schemas/tsconfig.json — workspace/manifests
  - Claim evidence: tsconfig.json — workspace/manifests

## 3. Source directory organization
- Status: DEFINED
- Finding: Detected source roots: packages.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: packages — source organization
- Claim: [observed] Detected source roots: packages.
  - Claim evidence: packages — source organization

## 4. Test directory organization
- Status: DEFINED (HIGH)
- Finding: Test organization is explicitly evidenced by root `tests/` and `tests/constitution.test.mjs`, with root `package.json` running `node --test tests/**/*.test.mjs`.
- Evidence: tests/constitution.test.mjs — test organization
- Claim: [observed/HIGH] Test organization is explicitly evidenced by root `tests/` and `tests/constitution.test.mjs`, with root `package.json` running `node --test tests/**/*.test.mjs`.
  - Claim evidence: tests/constitution.test.mjs — test organization

## 5. Documentation organization
- Status: DEFINED
- Finding: Detected documentation files in README.md.
- Evidence: README.md — documentation file
- Claim: [observed] Detected documentation files in README.md.
  - Claim evidence: README.md — documentation file

## 6. Script/tool directory organization
- Status: NOT_DEFINED
- Finding: No dedicated scripts/tools directories detected.
- Claim: [unknown] No dedicated scripts/tools directories detected.

## 7. Generated/build directory handling
- Status: NOT_DEFINED
- Finding: No generated/build output handling evidence detected.
- Drift warning: Status changed from INFERRED to NOT_DEFINED based on current repository evidence.
- Claim: [unknown] No generated/build output handling evidence detected.

## 8. Asset/static file organization
- Status: NOT_APPLICABLE
- Finding: No obvious asset/static file organization detected.
- Claim: [unknown] No obvious asset/static file organization detected.

## 9. Package/dependency manager
- Status: DEFINED
- Finding: Detected package managers: npm.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: package.json — package manager evidence
- Evidence: packages/adapters/pi/package.json — package manager evidence
- Evidence: packages/adapters/pi/tsconfig.json — package manager evidence
- Evidence: packages/core/package.json — package manager evidence
- Evidence: packages/core/tsconfig.json — package manager evidence
- Evidence: packages/executors/fake/package.json — package manager evidence
- Evidence: packages/executors/fake/tsconfig.json — package manager evidence
- Evidence: packages/executors/pi/package.json — package manager evidence
- Evidence: packages/executors/pi/tsconfig.json — package manager evidence
- Evidence: packages/schemas/package.json — package manager evidence
- Evidence: packages/schemas/tsconfig.json — package manager evidence
- Evidence: tsconfig.json — package manager evidence
- Evidence: package-lock.json — package manager evidence
- Claim: [observed] Detected package managers: npm.
  - Claim evidence: package.json — package manager evidence
  - Claim evidence: packages/adapters/pi/package.json — package manager evidence
  - Claim evidence: packages/adapters/pi/tsconfig.json — package manager evidence
  - Claim evidence: packages/core/package.json — package manager evidence
  - Claim evidence: packages/core/tsconfig.json — package manager evidence
  - Claim evidence: packages/executors/fake/package.json — package manager evidence
  - Claim evidence: packages/executors/fake/tsconfig.json — package manager evidence
  - Claim evidence: packages/executors/pi/package.json — package manager evidence
  - Claim evidence: packages/executors/pi/tsconfig.json — package manager evidence
  - Claim evidence: packages/schemas/package.json — package manager evidence
  - Claim evidence: packages/schemas/tsconfig.json — package manager evidence
  - Claim evidence: tsconfig.json — package manager evidence
  - Claim evidence: package-lock.json — package manager evidence

## 10. Manifest files
- Status: DEFINED
- Finding: Detected manifests: package.json, packages/adapters/pi/package.json, packages/adapters/pi/tsconfig.json, packages/core/package.json, packages/core/tsconfig.json, packages/executors/fake/package.json, packages/executors/fake/tsconfig.json, packages/executors/pi/package.json, packages/executors/pi/tsconfig.json, packages/schemas/package.json, packages/schemas/tsconfig.json, tsconfig.json.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: package.json — manifest file
- Evidence: packages/adapters/pi/package.json — manifest file
- Evidence: packages/adapters/pi/tsconfig.json — manifest file
- Evidence: packages/core/package.json — manifest file
- Evidence: packages/core/tsconfig.json — manifest file
- Evidence: packages/executors/fake/package.json — manifest file
- Evidence: packages/executors/fake/tsconfig.json — manifest file
- Evidence: packages/executors/pi/package.json — manifest file
- Evidence: packages/executors/pi/tsconfig.json — manifest file
- Evidence: packages/schemas/package.json — manifest file
- Evidence: packages/schemas/tsconfig.json — manifest file
- Evidence: tsconfig.json — manifest file
- Claim: [observed] Detected manifests: package.json, packages/adapters/pi/package.json, packages/adapters/pi/tsconfig.json, packages/core/package.json, packages/core/tsconfig.json, packages/executors/fake/package.json, packages/executors/fake/tsconfig.json, packages/executors/pi/package.json, packages/executors/pi/tsconfig.json, packages/schemas/package.json, packages/schemas/tsconfig.json, tsconfig.json.
  - Claim evidence: package.json — manifest file
  - Claim evidence: packages/adapters/pi/package.json — manifest file
  - Claim evidence: packages/adapters/pi/tsconfig.json — manifest file
  - Claim evidence: packages/core/package.json — manifest file
  - Claim evidence: packages/core/tsconfig.json — manifest file
  - Claim evidence: packages/executors/fake/package.json — manifest file
  - Claim evidence: packages/executors/fake/tsconfig.json — manifest file
  - Claim evidence: packages/executors/pi/package.json — manifest file
  - Claim evidence: packages/executors/pi/tsconfig.json — manifest file
  - Claim evidence: packages/schemas/package.json — manifest file
  - Claim evidence: packages/schemas/tsconfig.json — manifest file
  - Claim evidence: tsconfig.json — manifest file

## 11. Lockfile strategy
- Status: DEFINED
- Finding: Detected lockfiles: package-lock.json.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: package-lock.json — lockfile
- Claim: [observed] Detected lockfiles: package-lock.json.
  - Claim evidence: package-lock.json — lockfile

## 12. Dependency version policy
- Status: INFERRED (MEDIUM)
- Finding: Dependency versioning policy is implied by lockfiles and/or manifest version expressions in package.json, packages/core/package.json, package-lock.json.
- Critic warning: Finding is generic or placeholder-like; deepen evidence before trusting this area.
- Evidence: package.json — ^0
- Evidence: packages/core/package.json — ^2
- Evidence: package-lock.json — lockfile
- Claim: [inferred/MEDIUM] Dependency versioning policy is implied by lockfiles and/or manifest version expressions in package.json, packages/core/package.json, package-lock.json.
  - Claim critic warning: Claim appears generic enough to fit unrelated repositories.
  - Claim evidence: package.json — ^0
  - Claim evidence: packages/core/package.json — ^2
  - Claim evidence: package-lock.json — lockfile

## 13. Private registry/package source usage
- Status: NOT_DEFINED
- Finding: No private registry or package-source override evidence detected.
- Claim: [unknown] No private registry or package-source override evidence detected.

## 14. Dependency vulnerability/licensing controls
- Status: NOT_DEFINED
- Finding: No dependency vulnerability or licensing control evidence detected.
- Claim: [unknown] No dependency vulnerability or licensing control evidence detected.

## 15. Environment separation
- Status: NOT_DEFINED
- Finding: No environment separation files detected.
- Claim: [unknown] No environment separation files detected.

## 16. Environment variable conventions
- Status: NOT_DEFINED
- Finding: No environment variable convention evidence detected.
- Claim: [unknown] No environment variable convention evidence detected.

## 17. Secrets handling
- Status: NOT_DEFINED
- Finding: No secrets handling evidence detected.
- Drift warning: Status changed from INFERRED to NOT_DEFINED based on current repository evidence.
- Claim: [unknown] No secrets handling evidence detected.

## 18. Configuration hierarchy
- Status: INFERRED (MEDIUM)
- Finding: Configuration precedence or override layering is documented in README.md.
- Evidence: README.md — built-ins < global defaults < project config < run overrides
- Claim: [inferred/MEDIUM] Configuration precedence or override layering is documented in README.md.
  - Claim evidence: README.md — built-ins < global defaults < project config < run overrides

## 19. Runtime/language version pinning
- Status: DEFINED
- Finding: Detected runtime/version pinning evidence in package.json, packages/adapters/pi/package.json, packages/core/package.json, packages/executors/fake/package.json, packages/executors/pi/package.json, packages/schemas/package.json.
- Evidence: package.json — runtime/version file
- Evidence: packages/adapters/pi/package.json — runtime/version file
- Evidence: packages/core/package.json — runtime/version file
- Evidence: packages/executors/fake/package.json — runtime/version file
- Evidence: packages/executors/pi/package.json — runtime/version file
- Evidence: packages/schemas/package.json — runtime/version file
- Claim: [observed] Detected runtime/version pinning evidence in package.json, packages/adapters/pi/package.json, packages/core/package.json, packages/executors/fake/package.json, packages/executors/pi/package.json, packages/schemas/package.json.
  - Claim evidence: package.json — runtime/version file
  - Claim evidence: packages/adapters/pi/package.json — runtime/version file
  - Claim evidence: packages/core/package.json — runtime/version file
  - Claim evidence: packages/executors/fake/package.json — runtime/version file
  - Claim evidence: packages/executors/pi/package.json — runtime/version file
  - Claim evidence: packages/schemas/package.json — runtime/version file

## 20. Local development bootstrap
- Status: DEFINED
- Finding: Repository bootstrap/developer commands are script-driven: build, typecheck, test, harness:pi-executor, harness:pi-runtime.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: build: tsc -b
- Evidence: typecheck: tsc -b --pretty false
- Evidence: test: npm run build && node --test tests/**/*.test.mjs
- Evidence: harness:pi-executor: node packages/executors/pi/dist/harness.js
- Evidence: harness:pi-runtime: node packages/executors/pi/dist/runtime-harness.js
- Claim: [observed] Repository bootstrap/developer commands are script-driven: build, typecheck, test, harness:pi-executor, harness:pi-runtime.
  - Claim evidence: build: tsc -b
  - Claim evidence: typecheck: tsc -b --pretty false
  - Claim evidence: test: npm run build && node --test tests/**/*.test.mjs
  - Claim evidence: harness:pi-executor: node packages/executors/pi/dist/harness.js
  - Claim evidence: harness:pi-runtime: node packages/executors/pi/dist/runtime-harness.js

## 21. Containerized development/runtime configuration
- Status: NOT_APPLICABLE
- Finding: No containerized runtime configuration detected.
- Claim: [unknown] No containerized runtime configuration detected.

## 22. File naming conventions
- Status: INFERRED (MEDIUM)
- Finding: File names commonly use kebab-case patterns such as packages/core/src/runs/logs-by-id.ts, packages/executors/pi/src/fake-session-factory.js, packages/executors/pi/src/fake-session-factory.ts, packages/executors/pi/src/runtime-harness.js, packages/executors/pi/src/runtime-harness.ts.
- Evidence: packages/core/src/runs/logs-by-id.ts — kebab-case file name
- Evidence: packages/executors/pi/src/fake-session-factory.js — kebab-case file name
- Evidence: packages/executors/pi/src/fake-session-factory.ts — kebab-case file name
- Evidence: packages/executors/pi/src/runtime-harness.js — kebab-case file name
- Claim: [inferred/MEDIUM] File names commonly use kebab-case patterns such as packages/core/src/runs/logs-by-id.ts, packages/executors/pi/src/fake-session-factory.js, packages/executors/pi/src/fake-session-factory.ts, packages/executors/pi/src/runtime-harness.js, packages/executors/pi/src/runtime-harness.ts.
  - Claim evidence: packages/core/src/runs/logs-by-id.ts — kebab-case file name
  - Claim evidence: packages/executors/pi/src/fake-session-factory.js — kebab-case file name
  - Claim evidence: packages/executors/pi/src/fake-session-factory.ts — kebab-case file name
  - Claim evidence: packages/executors/pi/src/runtime-harness.js — kebab-case file name

## 23. Type/class/component naming
- Status: INFERRED (MEDIUM)
- Finding: Types, interfaces, or classes commonly use PascalCase identifiers.
- Evidence: packages/adapters/pi/src/types.ts — interface FactoryPiUi
- Evidence: packages/core/src/config/loader.ts — interface LoadedFactoryConfig
- Evidence: packages/core/src/constitution/areas.ts — interface ConstitutionAreaDefinition
- Evidence: packages/core/src/constitution/evaluators/shared.ts — interface ConstitutionEvaluationContext
- Evidence: packages/executors/pi/src/executor.d.ts — class PiAgentExecutor
- Evidence: packages/executors/pi/src/executor.js — class PiAgentExecutor
- Evidence: packages/executors/pi/src/executor.ts — class PiAgentExecutor
- Evidence: packages/executors/pi/src/fake-session-factory.js — class FakePiSession
- Claim: [inferred/MEDIUM] Types, interfaces, or classes commonly use PascalCase identifiers.
  - Claim evidence: packages/adapters/pi/src/types.ts — interface FactoryPiUi
  - Claim evidence: packages/core/src/config/loader.ts — interface LoadedFactoryConfig
  - Claim evidence: packages/core/src/constitution/areas.ts — interface ConstitutionAreaDefinition
  - Claim evidence: packages/core/src/constitution/evaluators/shared.ts — interface ConstitutionEvaluationContext
  - Claim evidence: packages/executors/pi/src/executor.d.ts — class PiAgentExecutor
  - Claim evidence: packages/executors/pi/src/executor.js — class PiAgentExecutor
  - Claim evidence: packages/executors/pi/src/executor.ts — class PiAgentExecutor
  - Claim evidence: packages/executors/pi/src/fake-session-factory.js — class FakePiSession

## 24. Variable/function naming
- Status: INFERRED (MEDIUM)
- Finding: Functions and local identifiers commonly use camelCase names.
- Evidence: packages/adapters/pi/src/extension.ts — function registerFactoryPiExtension
- Evidence: packages/adapters/pi/src/gateway.ts — function getFactoryCommandCompletions
- Evidence: packages/core/src/config/loader.ts — function loadEffectiveConfig
- Evidence: packages/core/src/config/merge.ts — function mergeConfigLayers
- Evidence: packages/core/src/config/paths.ts — function buildProjectPaths
- Evidence: packages/core/src/config/validate.ts — function validateEffectiveConfig
- Evidence: packages/core/src/constitution/areas.ts — function naming
- Evidence: packages/core/src/constitution/context.ts — function selectConstitutionContext
- Claim: [inferred/MEDIUM] Functions and local identifiers commonly use camelCase names.
  - Claim evidence: packages/adapters/pi/src/extension.ts — function registerFactoryPiExtension
  - Claim evidence: packages/adapters/pi/src/gateway.ts — function getFactoryCommandCompletions
  - Claim evidence: packages/core/src/config/loader.ts — function loadEffectiveConfig
  - Claim evidence: packages/core/src/config/merge.ts — function mergeConfigLayers
  - Claim evidence: packages/core/src/config/paths.ts — function buildProjectPaths
  - Claim evidence: packages/core/src/config/validate.ts — function validateEffectiveConfig
  - Claim evidence: packages/core/src/constitution/areas.ts — function naming
  - Claim evidence: packages/core/src/constitution/context.ts — function selectConstitutionContext

## 25. Constant naming
- Status: INFERRED (LOW)
- Finding: Some constants use SCREAMING_SNAKE_CASE identifiers.
- Evidence: packages/adapters/pi/src/gateway.ts — const FACTORY_WIDGET_ID
- Evidence: packages/core/src/constitution/areas.ts — const CONSTITUTION_AREA_DEFINITIONS
- Evidence: packages/core/src/constitution/discovery.ts — const execFileAsync
- Claim: [inferred/LOW] Some constants use SCREAMING_SNAKE_CASE identifiers.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — const FACTORY_WIDGET_ID
  - Claim evidence: packages/core/src/constitution/areas.ts — const CONSTITUTION_AREA_DEFINITIONS
  - Claim evidence: packages/core/src/constitution/discovery.ts — const execFileAsync

## 26. Import/export conventions
- Status: DEFINED (HIGH)
- Finding: Modules consistently use ES module import/export syntax.
- Evidence: packages/adapters/pi/src/extension.ts — import type { FactoryPiExtensionApiLike } from "./types.js"
- Evidence: packages/adapters/pi/src/gateway.ts — import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  cancelLatestFactoryRun,
  cleanupFactoryRuns,
  createGitWorktree,
  inspectFactoryRun,
  runConstitutionScan,
  inspectGitIsolation,
  listFactoryRuns,
  readFactoryRunLogs,
  readLatestFactoryRunLogs,
  readLatestFactoryRunStatus,
  readLatestFactoryRunSummary,
  resumeLatestFactoryRun,
  runFactoryDoctor,
  runPrototypeFactoryFlow,
  showFactoryRun,
  type AgentExecutor,
  type FactoryRunProgressEvent,
} from "@factory/core"
- Evidence: packages/adapters/pi/src/types.ts — export interface
- Evidence: packages/core/src/config/defaults.ts — import type { FactoryBuiltInDefaults } from "@factory/schemas"
- Evidence: packages/core/src/config/loader.ts — import fs from "node:fs/promises"
- Evidence: packages/core/src/config/merge.ts — import type {
  EffectiveFactoryConfig,
  FactoryBuiltInDefaults,
  GlobalFactoryConfig,
  ProjectFactoryConfig,
  RunOverrides,
  WorkflowConfig,
} from "@factory/schemas"
- Evidence: packages/core/src/config/paths.ts — import path from "node:path"
- Evidence: packages/core/src/config/validate.ts — import type { EffectiveFactoryConfig } from "@factory/schemas"
- Claim: [observed/HIGH] Modules consistently use ES module import/export syntax.
  - Claim evidence: packages/adapters/pi/src/extension.ts — import type { FactoryPiExtensionApiLike } from "./types.js"
  - Claim evidence: packages/adapters/pi/src/gateway.ts — import {
  discoverFactoryProject,
  initializeFactoryProject,
  loadEffectiveConfig,
  cancelLatestFactoryRun,
  cleanupFactoryRuns,
  createGitWorktree,
  inspectFactoryRun,
  runConstitutionScan,
  inspectGitIsolation,
  listFactoryRuns,
  readFactoryRunLogs,
  readLatestFactoryRunLogs,
  readLatestFactoryRunStatus,
  readLatestFactoryRunSummary,
  resumeLatestFactoryRun,
  runFactoryDoctor,
  runPrototypeFactoryFlow,
  showFactoryRun,
  type AgentExecutor,
  type FactoryRunProgressEvent,
} from "@factory/core"
  - Claim evidence: packages/adapters/pi/src/types.ts — export interface
  - Claim evidence: packages/core/src/config/defaults.ts — import type { FactoryBuiltInDefaults } from "@factory/schemas"
  - Claim evidence: packages/core/src/config/loader.ts — import fs from "node:fs/promises"
  - Claim evidence: packages/core/src/config/merge.ts — import type {
  EffectiveFactoryConfig,
  FactoryBuiltInDefaults,
  GlobalFactoryConfig,
  ProjectFactoryConfig,
  RunOverrides,
  WorkflowConfig,
} from "@factory/schemas"
  - Claim evidence: packages/core/src/config/paths.ts — import path from "node:path"
  - Claim evidence: packages/core/src/config/validate.ts — import type { EffectiveFactoryConfig } from "@factory/schemas"

## 27. In-file organization
- Status: INFERRED (LOW)
- Finding: Files typically start with imports and expose named exports, suggesting conventional in-file organization.
- Evidence: packages/adapters/pi/src/extension.ts — imports/exports present
- Evidence: packages/adapters/pi/src/gateway.ts — imports/exports present
- Evidence: packages/adapters/pi/src/types.ts — imports/exports present
- Evidence: packages/core/src/config/defaults.ts — imports/exports present
- Evidence: packages/core/src/config/loader.ts — imports/exports present
- Evidence: packages/core/src/config/merge.ts — imports/exports present
- Claim: [inferred/LOW] Files typically start with imports and expose named exports, suggesting conventional in-file organization.
  - Claim evidence: packages/adapters/pi/src/extension.ts — imports/exports present
  - Claim evidence: packages/adapters/pi/src/gateway.ts — imports/exports present
  - Claim evidence: packages/adapters/pi/src/types.ts — imports/exports present
  - Claim evidence: packages/core/src/config/defaults.ts — imports/exports present
  - Claim evidence: packages/core/src/config/loader.ts — imports/exports present
  - Claim evidence: packages/core/src/config/merge.ts — imports/exports present

## 28. File size conventions
- Status: INFERRED (LOW)
- Finding: Repository appears to prefer multiple smaller source files over a single monolithic entrypoint, but explicit file size limits are not enforced.
- Evidence: packages/adapters/pi/src/extension.ts — source file sample
- Evidence: packages/adapters/pi/src/gateway.ts — source file sample
- Evidence: packages/adapters/pi/src/index.ts — source file sample
- Evidence: packages/adapters/pi/src/types.ts — source file sample
- Evidence: packages/core/src/config/defaults.ts — source file sample
- Evidence: packages/core/src/config/loader.ts — source file sample
- Claim: [inferred/LOW] Repository appears to prefer multiple smaller source files over a single monolithic entrypoint, but explicit file size limits are not enforced.
  - Claim evidence: packages/adapters/pi/src/extension.ts — source file sample
  - Claim evidence: packages/adapters/pi/src/gateway.ts — source file sample
  - Claim evidence: packages/adapters/pi/src/index.ts — source file sample
  - Claim evidence: packages/adapters/pi/src/types.ts — source file sample
  - Claim evidence: packages/core/src/config/defaults.ts — source file sample
  - Claim evidence: packages/core/src/config/loader.ts — source file sample

## 29. Function/method size conventions
- Status: UNCERTAIN (LOW)
- Finding: Functions are present, but deterministic function-size enforcement is not explicitly detectable from current heuristics.
- Evidence: packages/adapters/pi/src/extension.ts — function sample
- Evidence: packages/adapters/pi/src/gateway.ts — function sample
- Evidence: packages/core/src/config/loader.ts — function sample
- Evidence: packages/core/src/config/merge.ts — function sample
- Claim: [unknown/LOW] Functions are present, but deterministic function-size enforcement is not explicitly detectable from current heuristics.
  - Claim evidence: packages/adapters/pi/src/extension.ts — function sample
  - Claim evidence: packages/adapters/pi/src/gateway.ts — function sample
  - Claim evidence: packages/core/src/config/loader.ts — function sample
  - Claim evidence: packages/core/src/config/merge.ts — function sample

## 30. Comment/documentation conventions
- Status: INFERRED (MEDIUM)
- Finding: Repository uses inline comments and/or markdown documentation files for developer guidance.
- Evidence: packages/core/src/constitution/discovery.ts — //
- Evidence: packages/core/src/constitution/evaluators/api.ts — //
- Evidence: packages/core/src/constitution/evaluators/architecture.ts — //
- Evidence: packages/core/src/constitution/evaluators/data.ts — //
- Evidence: packages/core/src/constitution/evaluators/maintainability.ts — //
- Evidence: packages/core/src/constitution/evaluators/observability.ts — //
- Evidence: README.md — markdown documentation file
- Claim: [inferred/MEDIUM] Repository uses inline comments and/or markdown documentation files for developer guidance.
  - Claim evidence: packages/core/src/constitution/discovery.ts — //
  - Claim evidence: packages/core/src/constitution/evaluators/api.ts — //
  - Claim evidence: packages/core/src/constitution/evaluators/architecture.ts — //
  - Claim evidence: packages/core/src/constitution/evaluators/data.ts — //
  - Claim evidence: packages/core/src/constitution/evaluators/maintainability.ts — //
  - Claim evidence: packages/core/src/constitution/evaluators/observability.ts — //
  - Claim evidence: README.md — markdown documentation file

## 31. TODO/FIXME/HACK conventions
- Status: INFERRED (MEDIUM)
- Finding: TODO/FIXME/HACK markers are used in files such as packages/core/src/constitution/areas.ts, packages/core/src/constitution/evaluators/maintainability.ts, packages/core/src/constitution/evaluators/style.ts.
- Evidence: packages/core/src/constitution/areas.ts — TODO
- Evidence: packages/core/src/constitution/evaluators/maintainability.ts — TODO
- Evidence: packages/core/src/constitution/evaluators/style.ts — todo
- Claim: [inferred/MEDIUM] TODO/FIXME/HACK markers are used in files such as packages/core/src/constitution/areas.ts, packages/core/src/constitution/evaluators/maintainability.ts, packages/core/src/constitution/evaluators/style.ts.
  - Claim evidence: packages/core/src/constitution/areas.ts — TODO
  - Claim evidence: packages/core/src/constitution/evaluators/maintainability.ts — TODO
  - Claim evidence: packages/core/src/constitution/evaluators/style.ts — todo

## 32. Overall application architecture
- Status: INFERRED (MEDIUM)
- Finding: Repository is organized into multiple top-level packages such as packages/adapters, packages/core, packages/executors, packages/schemas, suggesting a modular package-based architecture.
- Evidence: packages/adapters — top-level package/module
- Evidence: packages/core — top-level package/module
- Evidence: packages/executors — top-level package/module
- Evidence: packages/schemas — top-level package/module
- Claim: [inferred/MEDIUM] Repository is organized into multiple top-level packages such as packages/adapters, packages/core, packages/executors, packages/schemas, suggesting a modular package-based architecture.
  - Claim evidence: packages/adapters — top-level package/module
  - Claim evidence: packages/core — top-level package/module
  - Claim evidence: packages/executors — top-level package/module
  - Claim evidence: packages/schemas — top-level package/module

## 33. Module/package boundaries
- Status: DEFINED (HIGH)
- Finding: Package/module boundaries are explicit via directories and TypeScript project references.
- Evidence: packages/adapters — package boundary
- Evidence: packages/core — package boundary
- Evidence: packages/executors — package boundary
- Evidence: packages/schemas — package boundary
- Evidence: tsconfig reference: ./packages/schemas
- Evidence: tsconfig reference: ./packages/core
- Evidence: tsconfig reference: ./packages/adapters/pi
- Evidence: tsconfig reference: ./packages/executors/fake
- Evidence: tsconfig reference: ./packages/executors/pi
- Claim: [observed/HIGH] Package/module boundaries are explicit via directories and TypeScript project references.
  - Claim evidence: packages/adapters — package boundary
  - Claim evidence: packages/core — package boundary
  - Claim evidence: packages/executors — package boundary
  - Claim evidence: packages/schemas — package boundary
  - Claim evidence: tsconfig reference: ./packages/schemas
  - Claim evidence: tsconfig reference: ./packages/core
  - Claim evidence: tsconfig reference: ./packages/adapters/pi
  - Claim evidence: tsconfig reference: ./packages/executors/fake
  - Claim evidence: tsconfig reference: ./packages/executors/pi

## 34. Layering/dependency direction
- Status: INFERRED (MEDIUM)
- Finding: Adapters and executors import core packages, suggesting inward dependency direction toward shared core logic.
- Evidence: packages/adapters/pi/src/gateway.ts — imports @factory/core
- Evidence: packages/adapters/pi/src/gateway.ts — cross-package import @factory/core
- Evidence: packages/core/src/config/defaults.ts — cross-package import @factory/schemas
- Evidence: packages/core/src/config/loader.ts — cross-package import @factory/schemas
- Evidence: packages/core/src/config/merge.ts — cross-package import @factory/schemas
- Claim: [inferred/MEDIUM] Adapters and executors import core packages, suggesting inward dependency direction toward shared core logic.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — imports @factory/core
  - Claim evidence: packages/adapters/pi/src/gateway.ts — cross-package import @factory/core
  - Claim evidence: packages/core/src/config/defaults.ts — cross-package import @factory/schemas
  - Claim evidence: packages/core/src/config/loader.ts — cross-package import @factory/schemas
  - Claim evidence: packages/core/src/config/merge.ts — cross-package import @factory/schemas

## 35. Feature/domain organization
- Status: INFERRED (MEDIUM)
- Finding: Code is partitioned by package/function (for example packages/adapters, packages/core, packages/executors, packages/schemas) more than by a single flat source tree.
- Evidence: packages/adapters — feature/domain package
- Evidence: packages/core — feature/domain package
- Evidence: packages/executors — feature/domain package
- Evidence: packages/schemas — feature/domain package
- Claim: [inferred/MEDIUM] Code is partitioned by package/function (for example packages/adapters, packages/core, packages/executors, packages/schemas) more than by a single flat source tree.
  - Claim evidence: packages/adapters — feature/domain package
  - Claim evidence: packages/core — feature/domain package
  - Claim evidence: packages/executors — feature/domain package
  - Claim evidence: packages/schemas — feature/domain package

## 36. Shared/common code strategy
- Status: INFERRED (MEDIUM)
- Finding: Shared logic appears centralized in reusable core/schema packages rather than duplicated per adapter.
- Evidence: packages/core/package.json — shared/common path
- Evidence: packages/core/src/config/defaults.ts — shared/common path
- Evidence: packages/core/src/config/loader.ts — shared/common path
- Evidence: packages/core/src/config/merge.ts — shared/common path
- Evidence: packages/core/src/config/paths.ts — shared/common path
- Evidence: packages/core/src/config/validate.ts — shared/common path
- Evidence: packages/core — shared package
- Evidence: packages/schemas — shared package
- Claim: [inferred/MEDIUM] Shared logic appears centralized in reusable core/schema packages rather than duplicated per adapter.
  - Claim evidence: packages/core/package.json — shared/common path
  - Claim evidence: packages/core/src/config/defaults.ts — shared/common path
  - Claim evidence: packages/core/src/config/loader.ts — shared/common path
  - Claim evidence: packages/core/src/config/merge.ts — shared/common path
  - Claim evidence: packages/core/src/config/paths.ts — shared/common path
  - Claim evidence: packages/core/src/config/validate.ts — shared/common path
  - Claim evidence: packages/core — shared package
  - Claim evidence: packages/schemas — shared package

## 37. Dependency injection/inversion approach
- Status: INFERRED (MEDIUM)
- Finding: Factory/session abstractions suggest dependency injection via interchangeable factories and executors.
- Evidence: packages/executors/pi/src/factory.ts — factory/injection boundary
- Evidence: packages/executors/pi/src/fake-session-factory.ts — factory/injection boundary
- Evidence: packages/executors/pi/src/sdk-factory.ts — factory/injection boundary
- Claim: [inferred/MEDIUM] Factory/session abstractions suggest dependency injection via interchangeable factories and executors.
  - Claim evidence: packages/executors/pi/src/factory.ts — factory/injection boundary
  - Claim evidence: packages/executors/pi/src/fake-session-factory.ts — factory/injection boundary
  - Claim evidence: packages/executors/pi/src/sdk-factory.ts — factory/injection boundary

## 38. Cross-module communication rules
- Status: INFERRED (MEDIUM)
- Finding: Cross-module communication is primarily expressed through package imports such as @factory/core, @factory/schemas, @factory/schemas, @factory/schemas, @factory/schemas.
- Evidence: packages/adapters/pi/src/gateway.ts — imports @factory/core
- Evidence: packages/core/src/config/defaults.ts — imports @factory/schemas
- Evidence: packages/core/src/config/loader.ts — imports @factory/schemas
- Evidence: packages/core/src/config/merge.ts — imports @factory/schemas
- Evidence: packages/core/src/config/paths.ts — imports @factory/schemas
- Evidence: packages/core/src/config/validate.ts — imports @factory/schemas
- Evidence: packages/core/src/project/discovery.ts — imports @factory/schemas
- Evidence: packages/core/src/runs/store.ts — imports @factory/schemas
- Claim: [inferred/MEDIUM] Cross-module communication is primarily expressed through package imports such as @factory/core, @factory/schemas, @factory/schemas, @factory/schemas, @factory/schemas.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — imports @factory/core
  - Claim evidence: packages/core/src/config/defaults.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/config/loader.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/config/merge.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/config/paths.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/config/validate.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/project/discovery.ts — imports @factory/schemas
  - Claim evidence: packages/core/src/runs/store.ts — imports @factory/schemas

## 39. Architectural boundary enforcement
- Status: INFERRED (MEDIUM)
- Finding: TypeScript project references provide some structural boundary enforcement between packages.
- Evidence: tsconfig reference: ./packages/schemas
- Evidence: tsconfig reference: ./packages/core
- Evidence: tsconfig reference: ./packages/adapters/pi
- Evidence: tsconfig reference: ./packages/executors/fake
- Evidence: tsconfig reference: ./packages/executors/pi
- Evidence: packages/core/src/config/loader.ts — relative boundary import ../project/discovery.js
- Evidence: packages/core/src/constitution/evaluators/api.ts — relative boundary import ../types.js
- Evidence: packages/core/src/constitution/evaluators/architecture.ts — relative boundary import ../types.js
- Evidence: packages/core/src/constitution/evaluators/cicd.ts — relative boundary import ../types.js
- Claim: [inferred/MEDIUM] TypeScript project references provide some structural boundary enforcement between packages.
  - Claim evidence: tsconfig reference: ./packages/schemas
  - Claim evidence: tsconfig reference: ./packages/core
  - Claim evidence: tsconfig reference: ./packages/adapters/pi
  - Claim evidence: tsconfig reference: ./packages/executors/fake
  - Claim evidence: tsconfig reference: ./packages/executors/pi
  - Claim evidence: packages/core/src/config/loader.ts — relative boundary import ../project/discovery.js
  - Claim evidence: packages/core/src/constitution/evaluators/api.ts — relative boundary import ../types.js
  - Claim evidence: packages/core/src/constitution/evaluators/architecture.ts — relative boundary import ../types.js
  - Claim evidence: packages/core/src/constitution/evaluators/cicd.ts — relative boundary import ../types.js

## 40. API style/protocols
- Status: NOT_APPLICABLE
- Finding: No API files detected.
- Claim: [unknown] No API files detected.

## 41. Route/endpoint organization
- Status: NOT_APPLICABLE
- Finding: No route or endpoint files detected.
- Claim: [unknown] No route or endpoint files detected.

## 42. API versioning
- Status: NOT_DEFINED
- Finding: No API versioning evidence detected.
- Claim: [unknown] No API versioning evidence detected.

## 43. Request validation
- Status: NOT_DEFINED
- Finding: No request validation evidence detected.
- Claim: [unknown] No request validation evidence detected.

## 44. Response contracts
- Status: NOT_DEFINED
- Finding: No response contract evidence detected.
- Claim: [unknown] No response contract evidence detected.

## 45. Error response format
- Status: NOT_DEFINED
- Finding: No API error format evidence detected.
- Claim: [unknown] No API error format evidence detected.

## 46. Pagination/filtering conventions
- Status: NOT_DEFINED
- Finding: No pagination or filtering evidence detected.
- Claim: [unknown] No pagination or filtering evidence detected.

## 47. Idempotency/rate-limit contract handling
- Status: NOT_DEFINED
- Finding: No idempotency or rate-limit evidence detected.
- Claim: [unknown] No idempotency or rate-limit evidence detected.

## 48. Database/storage technologies
- Status: NOT_APPLICABLE
- Finding: No database or persistence files detected.
- Claim: [unknown] No database or persistence files detected.

## 49. ORM/query/data-access approach
- Status: NOT_DEFINED
- Finding: No explicit ORM or query-layer patterns detected in inspected data files.
- Claim: [unknown] No explicit ORM or query-layer patterns detected in inspected data files.

## 50. Model/schema organization
- Status: NOT_DEFINED
- Finding: No model or schema organization evidence detected.
- Claim: [unknown] No model or schema organization evidence detected.

## 51. Migration strategy
- Status: NOT_DEFINED
- Finding: No migration files detected.
- Claim: [unknown] No migration files detected.

## 52. Transaction boundaries
- Status: NOT_DEFINED
- Finding: No transaction boundary patterns detected in inspected data files.
- Claim: [unknown] No transaction boundary patterns detected in inspected data files.

## 53. Query performance conventions
- Status: NOT_DEFINED
- Finding: No explicit query performance convention evidence detected.
- Claim: [unknown] No explicit query performance convention evidence detected.

## 54. Indexing/data access conventions
- Status: NOT_DEFINED
- Finding: No indexing or access-path evidence detected.
- Claim: [unknown] No indexing or access-path evidence detected.

## 55. Seed/fixture/reference-data handling
- Status: NOT_DEFINED
- Finding: No seed, fixture, or reference-data files detected.
- Claim: [unknown] No seed, fixture, or reference-data files detected.

## 56. Error handling conventions
- Status: INFERRED (MEDIUM)
- Finding: Error handling patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/loader.ts, packages/core/src/config/validate.ts, packages/core/src/doctor/check.ts, packages/core/src/git/worktree.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — try {
- Evidence: packages/core/src/config/loader.ts — try {
- Evidence: packages/core/src/config/validate.ts — throw new Error
- Evidence: packages/core/src/doctor/check.ts — try {
- Evidence: packages/core/src/git/worktree.ts — try {
- Evidence: packages/core/src/project/discovery.ts — try {
- Evidence: packages/core/src/runs/cleanup.ts — try {
- Evidence: packages/core/src/runs/inspect.ts — try {
- Claim: [inferred/MEDIUM] Error handling patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/loader.ts, packages/core/src/config/validate.ts, packages/core/src/doctor/check.ts, packages/core/src/git/worktree.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — try {
  - Claim evidence: packages/core/src/config/loader.ts — try {
  - Claim evidence: packages/core/src/config/validate.ts — throw new Error
  - Claim evidence: packages/core/src/doctor/check.ts — try {
  - Claim evidence: packages/core/src/git/worktree.ts — try {
  - Claim evidence: packages/core/src/project/discovery.ts — try {
  - Claim evidence: packages/core/src/runs/cleanup.ts — try {
  - Claim evidence: packages/core/src/runs/inspect.ts — try {

## 57. Timeout conventions
- Status: INFERRED (MEDIUM)
- Finding: Timeout or abort-control patterns detected in packages/core/src/runtime/controller.ts, packages/executors/pi/src/executor.ts, packages/executors/pi/src/fake-session-factory.ts, packages/executors/pi/src/sdk-factory.ts, packages/executors/pi/src/types.d.ts.
- Evidence: packages/core/src/runtime/controller.ts — setTimeout(
- Evidence: packages/executors/pi/src/executor.ts — abort(
- Evidence: packages/executors/pi/src/fake-session-factory.ts — abort(
- Evidence: packages/executors/pi/src/sdk-factory.ts — abort(
- Evidence: packages/executors/pi/src/types.d.ts — abort(
- Evidence: packages/executors/pi/src/types.ts — abort(
- Claim: [inferred/MEDIUM] Timeout or abort-control patterns detected in packages/core/src/runtime/controller.ts, packages/executors/pi/src/executor.ts, packages/executors/pi/src/fake-session-factory.ts, packages/executors/pi/src/sdk-factory.ts, packages/executors/pi/src/types.d.ts.
  - Claim evidence: packages/core/src/runtime/controller.ts — setTimeout(
  - Claim evidence: packages/executors/pi/src/executor.ts — abort(
  - Claim evidence: packages/executors/pi/src/fake-session-factory.ts — abort(
  - Claim evidence: packages/executors/pi/src/sdk-factory.ts — abort(
  - Claim evidence: packages/executors/pi/src/types.d.ts — abort(
  - Claim evidence: packages/executors/pi/src/types.ts — abort(

## 58. Retry/backoff policy
- Status: INFERRED (MEDIUM)
- Finding: Retry or backoff patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runtime/artifacts.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — maxAttempts
- Evidence: packages/core/src/config/defaults.ts — maxAttempts
- Evidence: packages/core/src/config/merge.ts — maxAttempts
- Evidence: packages/core/src/config/validate.ts — maxAttempts
- Evidence: packages/core/src/runtime/artifacts.ts — attempt
- Evidence: packages/core/src/runtime/controller.ts — attempt
- Evidence: packages/core/src/runtime/planner.ts — maxAttempts
- Evidence: packages/core/src/setup/init.ts — maxAttempts
- Claim: [inferred/MEDIUM] Retry or backoff patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runtime/artifacts.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — maxAttempts
  - Claim evidence: packages/core/src/config/defaults.ts — maxAttempts
  - Claim evidence: packages/core/src/config/merge.ts — maxAttempts
  - Claim evidence: packages/core/src/config/validate.ts — maxAttempts
  - Claim evidence: packages/core/src/runtime/artifacts.ts — attempt
  - Claim evidence: packages/core/src/runtime/controller.ts — attempt
  - Claim evidence: packages/core/src/runtime/planner.ts — maxAttempts
  - Claim evidence: packages/core/src/setup/init.ts — maxAttempts

## 59. Circuit-breaking/failure isolation
- Status: INFERRED (MEDIUM)
- Finding: Failure-isolation or circuit-breaker patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/git/worktree.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — isolated workspace
- Evidence: packages/core/src/git/worktree.ts — isolated workspace
- Claim: [inferred/MEDIUM] Failure-isolation or circuit-breaker patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/git/worktree.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — isolated workspace
  - Claim evidence: packages/core/src/git/worktree.ts — isolated workspace

## 60. Graceful degradation/fallbacks
- Status: INFERRED (MEDIUM)
- Finding: Fallback or graceful-degradation language detected in packages/core/src/git/worktree.ts, packages/core/src/runs/resume.ts, README.md.
- Evidence: packages/core/src/git/worktree.ts — working in place
- Evidence: packages/core/src/runs/resume.ts — fallback
- Evidence: README.md — fallback
- Claim: [inferred/MEDIUM] Fallback or graceful-degradation language detected in packages/core/src/git/worktree.ts, packages/core/src/runs/resume.ts, README.md.
  - Claim evidence: packages/core/src/git/worktree.ts — working in place
  - Claim evidence: packages/core/src/runs/resume.ts — fallback
  - Claim evidence: README.md — fallback

## 61. Health/readiness/liveness checks
- Status: INFERRED (MEDIUM)
- Finding: Health, readiness, liveness, or diagnostic checks are referenced in packages/adapters/pi/src/gateway.ts, packages/core/src/doctor/check.ts, packages/core/src/index.ts, README.md.
- Evidence: packages/adapters/pi/src/gateway.ts — Doctor
- Evidence: packages/core/src/doctor/check.ts — Doctor
- Evidence: packages/core/src/index.ts — doctor
- Evidence: README.md — doctor
- Claim: [inferred/MEDIUM] Health, readiness, liveness, or diagnostic checks are referenced in packages/adapters/pi/src/gateway.ts, packages/core/src/doctor/check.ts, packages/core/src/index.ts, README.md.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — Doctor
  - Claim evidence: packages/core/src/doctor/check.ts — Doctor
  - Claim evidence: packages/core/src/index.ts — doctor
  - Claim evidence: README.md — doctor

## 62. Idempotent operation handling
- Status: INFERRED (MEDIUM)
- Finding: Idempotency or replay-safe operation patterns detected in README.md.
- Evidence: README.md — resume event
- Claim: [inferred/MEDIUM] Idempotency or replay-safe operation patterns detected in README.md.
  - Claim evidence: README.md — resume event

## 63. Authentication approach
- Status: NOT_DEFINED
- Finding: No authentication approach evidence detected.
- Claim: [unknown] No authentication approach evidence detected.

## 64. Authorization/permission model
- Status: NOT_DEFINED
- Finding: No authorization or permission model evidence detected.
- Claim: [unknown] No authorization or permission model evidence detected.

## 65. Input validation/sanitization
- Status: INFERRED (MEDIUM)
- Finding: Validation or sanitization patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/loader.ts, packages/core/src/config/paths.ts, packages/core/src/doctor/check.ts, packages/core/src/git/worktree.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — joi
- Evidence: packages/core/src/config/loader.ts — joi
- Evidence: packages/core/src/config/paths.ts — joi
- Evidence: packages/core/src/doctor/check.ts — joi
- Evidence: packages/core/src/git/worktree.ts — joi
- Evidence: packages/core/src/project/discovery.ts — joi
- Evidence: packages/core/src/runs/cancel.ts — joi
- Evidence: packages/core/src/runs/cleanup.ts — joi
- Claim: [inferred/MEDIUM] Validation or sanitization patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/loader.ts, packages/core/src/config/paths.ts, packages/core/src/doctor/check.ts, packages/core/src/git/worktree.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — joi
  - Claim evidence: packages/core/src/config/loader.ts — joi
  - Claim evidence: packages/core/src/config/paths.ts — joi
  - Claim evidence: packages/core/src/doctor/check.ts — joi
  - Claim evidence: packages/core/src/git/worktree.ts — joi
  - Claim evidence: packages/core/src/project/discovery.ts — joi
  - Claim evidence: packages/core/src/runs/cancel.ts — joi
  - Claim evidence: packages/core/src/runs/cleanup.ts — joi

## 66. Output encoding/XSS controls
- Status: NOT_DEFINED
- Finding: No output encoding or XSS-control evidence detected.
- Claim: [unknown] No output encoding or XSS-control evidence detected.

## 67. CSRF/CORS/browser security controls
- Status: NOT_DEFINED
- Finding: No CSRF, CORS, or browser-security control evidence detected.
- Claim: [unknown] No CSRF, CORS, or browser-security control evidence detected.

## 68. Secrets scanning/storage
- Status: NOT_DEFINED
- Finding: No secrets scanning or storage evidence detected.
- Claim: [unknown] No secrets scanning or storage evidence detected.

## 69. Dependency/SCA security scanning
- Status: NOT_DEFINED
- Finding: No dependency or SCA security scanning evidence detected.
- Claim: [unknown] No dependency or SCA security scanning evidence detected.

## 70. Static code/security analysis
- Status: UNCERTAIN (LOW)
- Finding: Static analysis exists via typecheck tooling, but dedicated security analysis is not explicit.
- Evidence: typecheck: tsc -b --pretty false
- Claim: [unknown/LOW] Static analysis exists via typecheck tooling, but dedicated security analysis is not explicit.
  - Claim evidence: typecheck: tsc -b --pretty false

## 71. Encryption/TLS/data protection
- Status: NOT_DEFINED
- Finding: No encryption, TLS, or data-protection evidence detected.
- Claim: [unknown] No encryption, TLS, or data-protection evidence detected.

## 72. Security headers/network trust boundaries
- Status: NOT_DEFINED
- Finding: No security-header or network trust-boundary evidence detected.
- Claim: [unknown] No security-header or network trust-boundary evidence detected.

## 73. Test framework/tooling
- Status: DEFINED (MEDIUM)
- Finding: Testing tooling is explicitly Node's built-in test runner: `tests/constitution.test.mjs` imports from `node:test`, and root `package.json` runs `node --test tests/**/*.test.mjs`.
- Evidence: tests/constitution.test.mjs — test framework evidence
- Claim: [observed/MEDIUM] Testing tooling is explicitly Node's built-in test runner: `tests/constitution.test.mjs` imports from `node:test`, and root `package.json` runs `node --test tests/**/*.test.mjs`.
  - Claim evidence: tests/constitution.test.mjs — test framework evidence

## 74. Unit test conventions
- Status: INFERRED (MEDIUM)
- Finding: Unit-style tests detected in tests/constitution.test.mjs.
- Evidence: tests/constitution.test.mjs — unit-style test
- Claim: [inferred/MEDIUM] Unit-style tests detected in tests/constitution.test.mjs.
  - Claim evidence: tests/constitution.test.mjs — unit-style test

## 75. Integration test conventions
- Status: NOT_DEFINED
- Finding: No integration test conventions detected.
- Claim: [unknown] No integration test conventions detected.

## 76. End-to-end test conventions
- Status: NOT_DEFINED
- Finding: No end-to-end test conventions detected.
- Claim: [unknown] No end-to-end test conventions detected.

## 77. Test naming/location conventions
- Status: DEFINED (HIGH)
- Finding: Tests are organized using detected naming/location patterns such as tests/constitution.test.mjs.
- Evidence: tests/constitution.test.mjs — test naming/location
- Claim: [observed/HIGH] Tests are organized using detected naming/location patterns such as tests/constitution.test.mjs.
  - Claim evidence: tests/constitution.test.mjs — test naming/location

## 78. Mock/fake/test-double strategy
- Status: INFERRED (MEDIUM)
- Finding: Mock/fake/test-double patterns detected in tests/constitution.test.mjs.
- Evidence: tests/constitution.test.mjs — test double
- Claim: [inferred/MEDIUM] Mock/fake/test-double patterns detected in tests/constitution.test.mjs.
  - Claim evidence: tests/constitution.test.mjs — test double

## 79. Test data/factory/fixture strategy
- Status: INFERRED (MEDIUM)
- Finding: Fixture/factory/test-data patterns detected in tests/constitution.test.mjs.
- Evidence: tests/constitution.test.mjs — factory
- Claim: [inferred/MEDIUM] Fixture/factory/test-data patterns detected in tests/constitution.test.mjs.
  - Claim evidence: tests/constitution.test.mjs — factory

## 80. Coverage/flaky-test/quality gates
- Status: NOT_DEFINED
- Finding: No coverage, flaky-test, or test quality-gate evidence detected.
- Claim: [unknown] No coverage, flaky-test, or test quality-gate evidence detected.

## 81. Build commands/tooling
- Status: DEFINED
- Finding: Build command detected: tsc -b.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: build: tsc -b
- Claim: [observed] Build command detected: tsc -b.
  - Claim evidence: build: tsc -b

## 82. Development/start commands
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.
- Claim: [unknown] Full deterministic evaluation for this area is not implemented yet.
  - Claim critic warning: Claim appears generic enough to fit unrelated repositories.

## 83. Linting rules/tooling
- Status: NOT_DEFINED
- Finding: No ESLint, Prettier, Biome, or similar linting configuration or lint script is present in the provided repository evidence.
- Claim: [unknown] No ESLint, Prettier, Biome, or similar linting configuration or lint script is present in the provided repository evidence.

## 84. Formatting rules/tooling
- Status: NOT_DEFINED
- Finding: No formatting rules/tooling detected.
- Claim: [unknown] No formatting rules/tooling detected.

## 85. Type checking/static analysis
- Status: DEFINED
- Finding: Type checking/static analysis evidence detected with command tsc -b --pretty false.
- Drift warning: Finding changed for this impacted area during refresh.
- Evidence: packages/adapters/pi/tsconfig.json — typecheck config
- Evidence: packages/core/tsconfig.json — typecheck config
- Evidence: packages/executors/fake/tsconfig.json — typecheck config
- Evidence: packages/executors/pi/tsconfig.json — typecheck config
- Evidence: packages/schemas/tsconfig.json — typecheck config
- Evidence: tsconfig.json — typecheck config
- Evidence: typecheck: tsc -b --pretty false
- Claim: [observed] Type checking/static analysis evidence detected with command tsc -b --pretty false.
  - Claim evidence: packages/adapters/pi/tsconfig.json — typecheck config
  - Claim evidence: packages/core/tsconfig.json — typecheck config
  - Claim evidence: packages/executors/fake/tsconfig.json — typecheck config
  - Claim evidence: packages/executors/pi/tsconfig.json — typecheck config
  - Claim evidence: packages/schemas/tsconfig.json — typecheck config
  - Claim evidence: tsconfig.json — typecheck config
  - Claim evidence: typecheck: tsc -b --pretty false

## 86. Repository automation scripts
- Status: NOT_DEFINED
- Finding: Full deterministic evaluation for this area is not implemented yet.
- Claim: [unknown] Full deterministic evaluation for this area is not implemented yet.
  - Claim critic warning: Claim appears generic enough to fit unrelated repositories.

## 87. CI/CD platform
- Status: NOT_DEFINED
- Finding: No CI/CD platform detected.
- Claim: [unknown] No CI/CD platform detected.

## 88. Pipeline stages
- Status: NOT_DEFINED
- Finding: No CI pipeline stages detected.
- Claim: [unknown] No CI pipeline stages detected.

## 89. Branch/PR pipeline triggers
- Status: NOT_DEFINED
- Finding: No CI trigger configuration detected.
- Claim: [unknown] No CI trigger configuration detected.

## 90. Required quality checks
- Status: NOT_DEFINED
- Finding: No required quality checks detected from CI configuration.
- Claim: [unknown] No required quality checks detected from CI configuration.

## 91. Build artifact creation/retention
- Status: NOT_DEFINED
- Finding: No build artifact or retention evidence detected.
- Claim: [unknown] No build artifact or retention evidence detected.

## 92. Pipeline dependency/build caching
- Status: NOT_DEFINED
- Finding: No CI caching configuration detected.
- Claim: [unknown] No CI caching configuration detected.

## 93. Deployment automation
- Status: NOT_DEFINED
- Finding: No deployment automation configuration detected.
- Claim: [unknown] No deployment automation configuration detected.

## 94. Logging format/conventions
- Status: NOT_DEFINED
- Finding: No logging format or convention evidence detected.
- Claim: [unknown] No logging format or convention evidence detected.

## 95. Log levels and production logging
- Status: INFERRED (MEDIUM)
- Finding: Log-level or severity language detected in packages/adapters/pi/src/gateway.ts, packages/adapters/pi/src/types.ts, packages/core/src/config/loader.ts, packages/core/src/config/validate.ts, packages/core/src/doctor/check.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — info
- Evidence: packages/adapters/pi/src/types.ts — info
- Evidence: packages/core/src/config/loader.ts — error
- Evidence: packages/core/src/config/validate.ts — Error
- Evidence: packages/core/src/doctor/check.ts — error
- Evidence: packages/core/src/git/worktree.ts — error
- Evidence: packages/core/src/runs/cleanup.ts — warn
- Evidence: packages/core/src/runs/inspect.ts — error
- Claim: [inferred/MEDIUM] Log-level or severity language detected in packages/adapters/pi/src/gateway.ts, packages/adapters/pi/src/types.ts, packages/core/src/config/loader.ts, packages/core/src/config/validate.ts, packages/core/src/doctor/check.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — info
  - Claim evidence: packages/adapters/pi/src/types.ts — info
  - Claim evidence: packages/core/src/config/loader.ts — error
  - Claim evidence: packages/core/src/config/validate.ts — Error
  - Claim evidence: packages/core/src/doctor/check.ts — error
  - Claim evidence: packages/core/src/git/worktree.ts — error
  - Claim evidence: packages/core/src/runs/cleanup.ts — warn
  - Claim evidence: packages/core/src/runs/inspect.ts — error

## 96. Request/trace/correlation IDs
- Status: NOT_DEFINED
- Finding: No request/trace/correlation ID evidence detected.
- Claim: [unknown] No request/trace/correlation ID evidence detected.

## 97. Metrics instrumentation
- Status: NOT_DEFINED
- Finding: No metrics instrumentation evidence detected.
- Claim: [unknown] No metrics instrumentation evidence detected.

## 98. Distributed tracing
- Status: NOT_DEFINED
- Finding: No distributed tracing evidence detected.
- Claim: [unknown] No distributed tracing evidence detected.

## 99. Alerting/operational monitoring
- Status: NOT_DEFINED
- Finding: No alerting or operational monitoring evidence detected.
- Claim: [unknown] No alerting or operational monitoring evidence detected.

## 100. Caching strategy
- Status: INFERRED (MEDIUM)
- Finding: Caching-related patterns detected in packages/executors/pi/src/sdk-factory.ts.
- Evidence: packages/executors/pi/src/sdk-factory.ts — lRu
- Claim: [inferred/MEDIUM] Caching-related patterns detected in packages/executors/pi/src/sdk-factory.ts.
  - Claim evidence: packages/executors/pi/src/sdk-factory.ts — lRu

## 101. Async/background work
- Status: INFERRED (MEDIUM)
- Finding: Async or background-work patterns detected in packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/schemas/src/config.ts.
- Evidence: packages/core/src/config/defaults.ts — Worker
- Evidence: packages/core/src/config/merge.ts — Worker
- Evidence: packages/schemas/src/config.ts — Worker
- Claim: [inferred/MEDIUM] Async or background-work patterns detected in packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/schemas/src/config.ts.
  - Claim evidence: packages/core/src/config/defaults.ts — Worker
  - Claim evidence: packages/core/src/config/merge.ts — Worker
  - Claim evidence: packages/schemas/src/config.ts — Worker

## 102. Payload/upload size controls
- Status: INFERRED (MEDIUM)
- Finding: Payload or upload size control patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/runs/logs-by-id.ts, packages/core/src/runs/logs.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — limit
- Evidence: packages/core/src/runs/logs-by-id.ts — limit
- Evidence: packages/core/src/runs/logs.ts — limit
- Claim: [inferred/MEDIUM] Payload or upload size control patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/runs/logs-by-id.ts, packages/core/src/runs/logs.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — limit
  - Claim evidence: packages/core/src/runs/logs-by-id.ts — limit
  - Claim evidence: packages/core/src/runs/logs.ts — limit

## 103. Connection/resource pooling
- Status: NOT_DEFINED
- Finding: No connection or resource pooling evidence detected.
- Claim: [unknown] No connection or resource pooling evidence detected.

## 104. Performance profiling/benchmarking
- Status: NOT_DEFINED
- Finding: No performance profiling or benchmarking evidence detected.
- Claim: [unknown] No performance profiling or benchmarking evidence detected.

## 105. Scalability/concurrency conventions
- Status: INFERRED (MEDIUM)
- Finding: Concurrency or scalability-oriented patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runtime/controller.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — parallel
- Evidence: packages/core/src/config/defaults.ts — maxParallel
- Evidence: packages/core/src/config/merge.ts — maxParallel
- Evidence: packages/core/src/config/validate.ts — maxParallel
- Evidence: packages/core/src/runtime/controller.ts — maxParallel
- Evidence: packages/core/src/setup/init.ts — maxParallel
- Evidence: packages/schemas/src/config.ts — maxParallel
- Claim: [inferred/MEDIUM] Concurrency or scalability-oriented patterns detected in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runtime/controller.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — parallel
  - Claim evidence: packages/core/src/config/defaults.ts — maxParallel
  - Claim evidence: packages/core/src/config/merge.ts — maxParallel
  - Claim evidence: packages/core/src/config/validate.ts — maxParallel
  - Claim evidence: packages/core/src/runtime/controller.ts — maxParallel
  - Claim evidence: packages/core/src/setup/init.ts — maxParallel
  - Claim evidence: packages/schemas/src/config.ts — maxParallel

## 106. Branch naming/workflow
- Status: INFERRED (MEDIUM)
- Finding: Branch names suggest a task- or feature-oriented workflow, e.g. create-a-prototype-implementation-plan-1787389718933, create-a-prototype-implementation-plan-1787389899712, create-a-prototype-implementation-plan-1787390395486, create-a-prototype-implementation-plan-1787390432329, create-a-prototype-implementation-plan-1787390588229.
- Evidence: branch: create-a-prototype-implementation-plan-1787389718933
- Evidence: branch: create-a-prototype-implementation-plan-1787389899712
- Evidence: branch: create-a-prototype-implementation-plan-1787390395486
- Evidence: branch: create-a-prototype-implementation-plan-1787390432329
- Evidence: branch: create-a-prototype-implementation-plan-1787390588229
- Claim: [inferred/MEDIUM] Branch names suggest a task- or feature-oriented workflow, e.g. create-a-prototype-implementation-plan-1787389718933, create-a-prototype-implementation-plan-1787389899712, create-a-prototype-implementation-plan-1787390395486, create-a-prototype-implementation-plan-1787390432329, create-a-prototype-implementation-plan-1787390588229.
  - Claim evidence: branch: create-a-prototype-implementation-plan-1787389718933
  - Claim evidence: branch: create-a-prototype-implementation-plan-1787389899712
  - Claim evidence: branch: create-a-prototype-implementation-plan-1787390395486
  - Claim evidence: branch: create-a-prototype-implementation-plan-1787390432329
  - Claim evidence: branch: create-a-prototype-implementation-plan-1787390588229

## 107. Commit message conventions
- Status: INFERRED (LOW)
- Finding: Recent commit subjects appear free-form, e.g. Deepen constitution evaluator coverage and add regression tests | Add hybrid constitution engine and context-driven runtime | Add worktree-aware runtime and builder executor flow | Add reviewer executor phase to prototype runtime.
- Evidence: commit: Deepen constitution evaluator coverage and add regression tests
- Evidence: commit: Add hybrid constitution engine and context-driven runtime
- Evidence: commit: Add worktree-aware runtime and builder executor flow
- Evidence: commit: Add reviewer executor phase to prototype runtime
- Claim: [inferred/LOW] Recent commit subjects appear free-form, e.g. Deepen constitution evaluator coverage and add regression tests | Add hybrid constitution engine and context-driven runtime | Add worktree-aware runtime and builder executor flow | Add reviewer executor phase to prototype runtime.
  - Claim evidence: commit: Deepen constitution evaluator coverage and add regression tests
  - Claim evidence: commit: Add hybrid constitution engine and context-driven runtime
  - Claim evidence: commit: Add worktree-aware runtime and builder executor flow
  - Claim evidence: commit: Add reviewer executor phase to prototype runtime

## 108. Pull request conventions
- Status: INFERRED (MEDIUM)
- Finding: Pull request or review process guidance detected in README.md.
- Evidence: README.md — approval
- Claim: [inferred/MEDIUM] Pull request or review process guidance detected in README.md.
  - Claim evidence: README.md — approval

## 109. Review/approval requirements
- Status: INFERRED (MEDIUM)
- Finding: Review or approval requirements are referenced in README.md.
- Critic warning: Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Evidence: README.md — approval
- Claim: [inferred/MEDIUM] Review or approval requirements are referenced in README.md.
  - Claim evidence: README.md — approval
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
  - Claim evidence: README.md — approval
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
  - Claim evidence: README.md — approval
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
  - Claim evidence: README.md — approval
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
  - Claim evidence: README.md — approval

## 110. Protected branch/force-push rules
- Status: NOT_DEFINED
- Finding: No protected branch or force-push rule evidence detected.
- Critic warning: Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [unknown] No protected branch or force-push rule evidence detected.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.

## 111. Code ownership rules
- Status: NOT_DEFINED
- Finding: No CODEOWNERS evidence detected.
- Critic warning: Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [unknown] No CODEOWNERS evidence detected.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.
- Claim: [conflict/MEDIUM] Review/approval expectations exist, but branch protection and code ownership enforcement are not evident.

## 112. Deployment model
- Status: NOT_DEFINED
- Finding: No deployment model evidence detected.
- Claim: [unknown] No deployment model evidence detected.

## 113. Environment promotion strategy
- Status: NOT_DEFINED
- Finding: No environment promotion strategy evidence detected.
- Claim: [unknown] No environment promotion strategy evidence detected.

## 114. Versioning/release strategy
- Status: NOT_DEFINED
- Finding: No release or versioning strategy evidence detected.
- Claim: [unknown] No release or versioning strategy evidence detected.

## 115. Feature flag/release-control strategy
- Status: NOT_DEFINED
- Finding: No feature flag or release-control strategy evidence detected.
- Claim: [unknown] No feature flag or release-control strategy evidence detected.

## 116. Rollback/recovery strategy
- Status: INFERRED (MEDIUM)
- Finding: Rollback or recovery guidance detected in README.md.
- Evidence: README.md — recover
- Claim: [inferred/MEDIUM] Rollback or recovery guidance detected in README.md.
  - Claim evidence: README.md — recover

## 117. Sensitive/PII data handling
- Status: NOT_DEFINED
- Finding: No sensitive/PII data handling evidence detected.
- Claim: [unknown] No sensitive/PII data handling evidence detected.

## 118. Audit/retention/access logging controls
- Status: INFERRED (MEDIUM)
- Finding: Audit, retention, or access-logging evidence detected in README.md, packages/core/src/runs/cancel.ts, packages/core/src/runs/logs-by-id.ts, packages/core/src/runs/resume.ts, packages/core/src/runs/store.ts.
- Evidence: README.md — events.jsonl
- Evidence: packages/core/src/runs/cancel.ts — appendFactoryRunEvent
- Evidence: packages/core/src/runs/logs-by-id.ts — events.jsonl
- Evidence: packages/core/src/runs/resume.ts — appendFactoryRunEvent
- Evidence: packages/core/src/runs/store.ts — events.jsonl
- Evidence: packages/core/src/runtime/controller.ts — appendFactoryRunEvent
- Evidence: packages/core/src/setup/init.ts — appendFactoryRunEvent
- Claim: [inferred/MEDIUM] Audit, retention, or access-logging evidence detected in README.md, packages/core/src/runs/cancel.ts, packages/core/src/runs/logs-by-id.ts, packages/core/src/runs/resume.ts, packages/core/src/runs/store.ts.
  - Claim evidence: README.md — events.jsonl
  - Claim evidence: packages/core/src/runs/cancel.ts — appendFactoryRunEvent
  - Claim evidence: packages/core/src/runs/logs-by-id.ts — events.jsonl
  - Claim evidence: packages/core/src/runs/resume.ts — appendFactoryRunEvent
  - Claim evidence: packages/core/src/runs/store.ts — events.jsonl
  - Claim evidence: packages/core/src/runtime/controller.ts — appendFactoryRunEvent
  - Claim evidence: packages/core/src/setup/init.ts — appendFactoryRunEvent

## 119. Complexity/duplication/technical-debt controls
- Status: INFERRED (MEDIUM)
- Finding: Technical-debt or cleanup signals appear in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runs/cleanup.ts.
- Evidence: packages/adapters/pi/src/gateway.ts — cleanup
- Evidence: packages/core/src/config/defaults.ts — cleanup
- Evidence: packages/core/src/config/merge.ts — cleanup
- Evidence: packages/core/src/config/validate.ts — cleanup
- Evidence: packages/core/src/runs/cleanup.ts — Cleanup
- Evidence: packages/core/src/runs/index.ts — cleanup
- Evidence: packages/schemas/src/config.ts — cleanup
- Claim: [inferred/MEDIUM] Technical-debt or cleanup signals appear in packages/adapters/pi/src/gateway.ts, packages/core/src/config/defaults.ts, packages/core/src/config/merge.ts, packages/core/src/config/validate.ts, packages/core/src/runs/cleanup.ts.
  - Claim evidence: packages/adapters/pi/src/gateway.ts — cleanup
  - Claim evidence: packages/core/src/config/defaults.ts — cleanup
  - Claim evidence: packages/core/src/config/merge.ts — cleanup
  - Claim evidence: packages/core/src/config/validate.ts — cleanup
  - Claim evidence: packages/core/src/runs/cleanup.ts — Cleanup
  - Claim evidence: packages/core/src/runs/index.ts — cleanup
  - Claim evidence: packages/schemas/src/config.ts — cleanup

## 120. Simplicity/reuse/anti-overengineering conventions
- Status: INFERRED (MEDIUM)
- Finding: Simplicity, reuse, or minimalism language detected in README.md, packages/adapters/pi/src/gateway.ts, packages/core/src/runtime/artifacts.ts, packages/core/src/runtime/controller.ts, packages/core/src/runtime/index.ts.
- Evidence: README.md — minimal
- Evidence: packages/adapters/pi/src/gateway.ts — Prototype
- Evidence: packages/core/src/runtime/artifacts.ts — Prototype
- Evidence: packages/core/src/runtime/controller.ts — Prototype
- Evidence: packages/core/src/runtime/index.ts — prototype
- Evidence: packages/core/src/runtime/prototype.ts — Prototype
- Evidence: packages/core/src/runtime/tasks.ts — Prototype
- Evidence: packages/executors/pi/src/harness.ts — prototype
- Evidence: packages/core — shared core package
- Claim: [inferred/MEDIUM] Simplicity, reuse, or minimalism language detected in README.md, packages/adapters/pi/src/gateway.ts, packages/core/src/runtime/artifacts.ts, packages/core/src/runtime/controller.ts, packages/core/src/runtime/index.ts.
  - Claim evidence: README.md — minimal
  - Claim evidence: packages/adapters/pi/src/gateway.ts — Prototype
  - Claim evidence: packages/core/src/runtime/artifacts.ts — Prototype
  - Claim evidence: packages/core/src/runtime/controller.ts — Prototype
  - Claim evidence: packages/core/src/runtime/index.ts — prototype
  - Claim evidence: packages/core/src/runtime/prototype.ts — Prototype
  - Claim evidence: packages/core/src/runtime/tasks.ts — Prototype
  - Claim evidence: packages/executors/pi/src/harness.ts — prototype
  - Claim evidence: packages/core — shared core package
