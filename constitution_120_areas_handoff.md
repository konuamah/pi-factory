# Handoff: Make the 120 Constitution Areas Intelligent

## Objective

Upgrade the current constitution engine from:
- **full 120-area schema coverage with partial deterministic evaluation**

to:
- **full 120-area evidence-backed evaluation with deterministic logic + structured AI refinement**

The target is to make `CONSTITUTION.md` genuinely useful as:
1. human-facing repository truth
2. coding-agent runtime context
3. refreshable, drift-aware engineering memory

---

## Current repository

Project root:
- `D:/projects/pi-factory`

Latest relevant commit at handoff time:
- `7780150` — `Add hybrid constitution engine and context-driven runtime`

This repo is a Pi-native Factory prototype with:
- config-first runtime
- run persistence
- worktree isolation
- executor-backed planner/builder/repair/reviewer
- constitution scan + refresh + runtime prompt injection

---

## What already exists

## Constitution package

Current files:
- `packages/core/src/constitution/areas.ts`
- `packages/core/src/constitution/context.ts`
- `packages/core/src/constitution/discovery.ts`
- `packages/core/src/constitution/index.ts`
- `packages/core/src/constitution/refresh.ts`
- `packages/core/src/constitution/render.ts`
- `packages/core/src/constitution/scan.ts`
- `packages/core/src/constitution/types.ts`

### Current behavior

Implemented today:
- deterministic repository discovery
- full **120-area output shape**
- refresh metadata
- changed-file impact routing
- patch-style reuse of non-impacted areas
- basic drift warnings
- optional AI constitution reasoner
- constitution context injected into planner/builder/repair/reviewer prompts
- auto constitution refresh before `/factory <goal>`

### Important current limitation

All 120 areas are present in output, but only a subset has real evaluator logic.
Many areas currently default to:
- `NOT_DEFINED`
- `UNCERTAIN`

This handoff is specifically to solve that.

---

## Files you must understand first

### Constitution core
- `packages/core/src/constitution/types.ts`
- `packages/core/src/constitution/areas.ts`
- `packages/core/src/constitution/discovery.ts`
- `packages/core/src/constitution/refresh.ts`
- `packages/core/src/constitution/render.ts`
- `packages/core/src/constitution/scan.ts`
- `packages/core/src/constitution/context.ts`

### Runtime integration
- `packages/core/src/runtime/controller.ts`
- `packages/adapters/pi/src/gateway.ts`

### Config and exports
- `packages/core/src/index.ts`
- `packages/core/src/config/defaults.ts`
- `packages/core/src/config/merge.ts`
- `packages/core/src/config/validate.ts`
- `packages/schemas/src/config.ts`

### Skill / source of truth for scan design
- `SKILL.md`

This is the most important design document for the constitution system.

---

## Critical product/design intent

## 1. Deterministic-first, AI-second

The architecture is intentionally:

```text
deterministic scan
→ evidence bundle
→ area candidates
→ optional AI reasoner
→ validated structured refinement
→ CONSTITUTION.md
```

Do **not** invert this into:
- AI guesses first
- files consulted second

### Why
- deterministic facts must remain authoritative
- refresh must still work cheaply and reliably
- AI should improve interpretation, not replace evidence collection

---

## 2. AI should be involved by default in practice

Product direction from the user:
- AI is expected to be available in normal operation
- no separate constitution-specific AI config should be required

Engineering implication:
- constitution scan should use the same executor/model path as the rest of Factory
- but graceful fallback should still exist internally for robustness

So preserve:
- deterministic-first
- AI-enhanced by default when executor exists
- fallback-safe behavior if AI errors

---

## 3. Project config remains authoritative

Global rule already established in this repo:

```text
built-ins < global defaults < project config < run overrides
```

Do not violate that when adding constitution-related behavior.

---

## 4. `CONSTITUTION.md` is repository context, not just documentation

Agents are already consuming compact constitution context during runtime.
So area quality directly affects:
- planner prompt quality
- builder prompt quality
- repair prompt quality
- reviewer prompt quality

This means weak constitution areas reduce actual Factory intelligence.

---

## Current constitution implementation details

## Discovery (`discovery.ts`)

Current discovery already gathers signals like:
- tracked files
- instruction files
- manifests
- lockfiles
- CI files
- test files
- docker files
- source files
- docs files
- script files
- generated files
- asset files
- env files
- version files
- lint files
- format files
- typecheck files
- api files
- data files
- languages
- package managers
- package scripts

This is the evidence substrate you should extend rather than bypass.

### Important note
If a new area needs better evidence, first extend discovery and/or add a deterministic extractor.
Do not stuff all logic directly into `scan.ts`.

---

## Refresh (`refresh.ts`)

Current refresh already supports:
- previous scan SHA
- current scan SHA
- dirty tree detection
- changed file detection
- impacted area IDs
- `FAST` / `FULL`
- no-change detection

It currently routes impacts with heuristics.

### Next-level requirement
Refresh routing should become much more area-aware:
- API files should impact 40–47 strongly
- persistence files should impact 48–55 strongly
- security-related files should impact 63–72
- testing files should impact 73–80
- tooling files should impact 81–86
- CI/CD files should impact 87–93
- logging/metrics files should impact 94–99
- deployment files should impact 112–116

---

## Scan (`scan.ts`)

Current responsibilities in `scan.ts`:
- run discovery
- run refresh analysis
- read previous constitution
- build deterministic areas
- merge refresh reuse/drift
- optional AI refinement
- render markdown
- write metadata

### Current weak point
`buildDeterministicAreas(...)` still contains too much inline logic.
As the evaluator grows, this should be refactored into something like:
- `evaluateStructureAreas(...)`
- `evaluateDependencyAreas(...)`
- `evaluateEnvironmentAreas(...)`
- etc.

Eventually preferably:
- one evaluator file/module per section
- shared helpers for evidence extraction

---

## AI structured refinement

Current AI path already supports:
- freeform notes
- optional structured per-area proposals embedded in output

Prompt contract in current code expects JSON between markers:
- `AI_AREA_PROPOSALS_START`
- `AI_AREA_PROPOSALS_END`

Format:
```json
[
  {
    "id": 34,
    "status": "INFERRED",
    "confidence": "MEDIUM",
    "finding": "...",
    "driftWarnings": ["..."]
  }
]
```

### Current limitation
This merge is still basic.
It needs stronger validation rules so AI can improve findings without corrupting deterministic truth.

### Required principles
AI may:
- refine status
- refine confidence
- improve finding text
- add drift warnings

AI must not:
- invent evidence paths
- rewrite non-impacted areas without justification
- override clear deterministic facts

---

## Current 120-area state

The file `packages/core/src/constitution/areas.ts` contains the full canonical 120 schema.

At handoff time:
- all 120 areas render
- only a subset have meaningful deterministic evaluation
- some placeholders become `UNCERTAIN` if related evidence exists

This is structurally complete but not semantically complete.

---

## What “intelligent” should mean

For this project, an intelligent area means:

1. It uses **deterministic evidence** where possible.
2. It produces the right status:
   - `DEFINED`
   - `INFERRED`
   - `NOT_DEFINED`
   - `NOT_APPLICABLE`
   - `UNCERTAIN`
3. It includes **specific evidence**.
4. It uses AI only for:
   - ambiguity
n   - synthesis
   - conflict interpretation
   - weak/partial areas
5. It behaves correctly under refresh:
   - impacted areas reevaluated
   - non-impacted areas reused
   - drift surfaced, not normalized away

---

## High-priority work plan

## Phase 1 — Refactor evaluator structure

### Goal
Make the evaluator maintainable before deepening all 120 areas.

### Recommended file structure
Create something like:

```text
packages/core/src/constitution/evaluators/
  structure.ts
  dependencies.ts
  environment.ts
  style.ts
  architecture.ts
  api.ts
  data.ts
  reliability.ts
  security.ts
  testing.ts
  tooling.ts
  cicd.ts
  observability.ts
  performance.ts
  git-review.ts
  deployment.ts
  compliance.ts
  maintainability.ts
  shared.ts
```

Then `scan.ts` should compose them.

### Why
Right now the logic is too centralized.
You will need separation to make all 120 areas smart.

---

## Phase 2 — Deep deterministic coverage for highest-value sections

Implement strong deterministic evaluators in this order:

### A. API & external contracts (40–47)
Needed signals:
- route files
- API handler structure
- OpenAPI/Swagger files
- validation libs
- request/response schemas
- error contract patterns
- pagination/filter params
- idempotency/rate limiting evidence

### B. Data & persistence (48–55)
Needed signals:
- prisma/sql/schema/migrations
- ORM imports/usages
- query/data access layers
- migrations
- seed/fixture files
- transaction helpers
- indexing/schema evidence

### C. Testing (73–80)
Needed signals:
- framework detection from deps + config + file patterns
- unit vs integration vs e2e file conventions
- fixture/mock/factory patterns
- coverage config
- flaky/quality gate CI logic

### D. Tooling (81–86)
Needed signals:
- build/start/lint/format/typecheck scripts
- eslint/prettier/biome/etc
- static analysis tooling
- scripts/tools directories
- repo automation

### E. CI/CD (87–93)
Needed signals:
- workflow job names/stages
- triggers
- required checks
- artifact publish/retention
- caches
- deploy jobs

### F. Git & code review (106–111)
Needed signals:
- branch naming conventions from refs/docs
- commit conventions from history (if safe to inspect)
- PR templates
- CODEOWNERS
- branch protection proxies from docs/CI
- approval requirements from docs/workflows

### G. Deployment/release (112–116)
Needed signals:
- deployment targets
- environment promotion patterns
- version tagging/release scripts
- feature flag systems
- rollback language/docs/scripts

These sections will produce the largest practical improvement for Factory.

---

## Phase 3 — Architecture/style/security/reliability depth

Then deepen:
- 22–31 source code style/conventions
- 32–39 architecture/module boundaries
- 56–72 reliability + security
- 94–105 observability + performance
- 117–120 compliance + maintainability

These will require more pattern analysis and, in some repos, more AI help.

---

## Desired evaluator design per area

Each area should eventually follow a pattern like:

```ts
{
  id,
  title,
  status,
  confidence,
  finding,
  evidence,
  driftWarnings,
}
```

### Status guidance
- `DEFINED`
  - explicit config/docs/enforcement exists
- `INFERRED`
  - repeated strong pattern evidence exists
- `NOT_DEFINED`
  - relevant but no convincing evidence
- `NOT_APPLICABLE`
  - tech/domain absent
- `UNCERTAIN`
  - conflicting or incomplete evidence

### Confidence guidance
Only use for:
- `INFERRED`
- `UNCERTAIN`

---

## Required refactor suggestion

Move these helper patterns out of `scan.ts` over time:
- area construction
- evidence normalization
- pattern counting
- confidence scoring
- section-level evaluators
- AI merge policy

Also consider introducing:

```ts
interface ConstitutionEvaluationContext {
  discovery: ConstitutionDiscovery;
  refresh: ConstitutionScanResult["refresh"];
  previousAreas: ConstitutionArea[];
}
```

and section evaluators returning arrays of areas.

---

## AI engineer task specifically

If you are the AI engineer taking this over, your job is **not** just to improve prose.
Your job is to improve the **area reasoning loop**.

### Specifically
1. Strengthen the structured JSON proposal contract.
2. Make the AI reasoner focus only on:
   - impacted areas
   - uncertain areas
   - conflicting areas
3. Feed it a **compact evidence packet per area**, not a giant whole-repo dump.
4. Validate every returned proposal before merge.
5. Preserve deterministic truth for hard facts.

### Ideal AI input shape later
For each area under refinement:
- area id + title
- current deterministic status
- current deterministic finding
- evidence list
- changed files relevant to area
- prior area result if reused
- nearby related areas if useful

### Ideal AI output
Structured only:
```json
[
  {
    "id": 63,
    "status": "UNCERTAIN",
    "confidence": "LOW",
    "finding": "Authentication-related files exist, but the primary auth boundary is not yet explicit.",
    "driftWarnings": [
      "Recent changes touched auth-adjacent files without enough evidence to confirm a stable repository-wide auth approach."
    ]
  }
]
```

Then Factory merges it.

---

## Immediate engineering backlog

## 1. Refactor evaluator organization
- split `scan.ts`
- introduce evaluator modules by section
- keep `scan.ts` orchestration-only

## 2. Add reusable evidence helpers
Examples:
- `findFilesByRegex(...)`
- `countImports(...)`
- `detectConfigPresence(...)`
- `detectScript(...)`
- `detectDependency(...)`
- `classifyTestFiles(...)`
- `collectRouteEvidence(...)`
- `collectMigrationEvidence(...)`

## 3. Improve AI proposal merge policy
- only impacted/uncertain areas
- reject invalid status/confidence
- reject empty findings
- reject attempts to modify unrelated areas
- preserve deterministic evidence list

## 4. Add metadata for per-area refresh lineage
Suggested metadata fields:
- last evaluated by area id
- deterministic vs AI-refined
- last impacted by file set
- last confidence source

## 5. Add tests
You need tests for:
- discovery
- refresh routing
- section evaluators
- AI proposal parsing
- AI proposal validation
- patch-only area reuse
- drift warnings

---

## Quality bar

This system is successful when:

1. All 120 areas exist.
2. Most high-value areas are not placeholders anymore.
3. AI is used to refine ambiguity, not replace evidence.
4. Refresh is cheap for small changes.
5. Runtime prompt context becomes noticeably more relevant.

---

## Areas that matter most for Factory runtime behavior

If prioritization is needed, these are the highest impact for agent execution quality:
- 1–7 structure
- 9–21 dependencies/environment/bootstrap/runtime
- 32–39 architecture/boundaries
- 40–55 API + data
- 73–85 testing/tooling/typecheck
- 87–93 CI/CD
- 106–116 git/review/release/deployment
- 119–120 maintainability

These most strongly influence planner/builder/reviewer decisions.

---

## Known current rough edges

1. `scan.ts` is still too large.
2. Many areas are placeholders.
3. AI proposal support exists but is still lightly validated.
4. Drift detection is generic, not section-smart.
5. Some local repo artifacts may exist from development runs:
   - `.factory/constitution/metadata.json`
   - generated `CONSTITUTION.md`
6. A stray filesystem artifact named `NUL` existed locally and was excluded from commit; watch for Windows reserved-name edge cases during cleanup or scans.

---

## Recommended next concrete implementation order

1. Refactor evaluator code by section
2. Implement deterministic evaluators for 40–55
3. Improve AI proposal contract + validation
4. Implement deterministic evaluators for 73–93
5. Implement deterministic evaluators for 106–116
6. Add area-family-specific drift rules
7. Add tests for refresh + AI merge + evaluators

---

## Final instruction

Do **not** chase all 120 areas with shallow heuristics.
Prioritize:
- evidence quality
- maintainability of evaluator code
- useful runtime guidance
- safe AI refinement

The right end state is:

```text
120 areas present
+ high-value areas deeply evaluated
+ AI structured refinement for ambiguity
+ refreshable and drift-aware
+ directly useful to Factory runtime
```
