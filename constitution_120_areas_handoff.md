# Handoff: Current Constitution + Runtime State

## Objective

This document now reflects the **current implemented state** of the Pi-native Factory prototype after the constitution and runtime work landed.

It is no longer a request to build 120-area coverage from scratch.
That work is largely complete.

The remaining goal is to maintain and polish the system while keeping the core design intact:
- project-authoritative config
- plan-first runtime with human approval
- Pi-native execution
- fact-first constitution generation
- AI interpretation without evidence invention

---

## Current repository

Project root:
- `D:/projects/pi-factory`

Recent relevant commits include:
- `5c91081` — `Deepen constitution evaluator coverage and add regression tests`
- `3debcb2` — `Require AI constitution interpretation and trim noisy scanner findings`
- `6b2edcd` — `Reuse finalized constitution on no-change refresh`
- `20ee589` — `Add targeted constitution refresh strategy`
- `74e76ea` — `Preserve finalized constitution on refresh failure`
- `fa84a94` — `Add plan approval gate and document next items`
- `3be2e22` — `Add runtime tests for plan approval flow`
- `52b1cc3` — `Add latest run plan inspection command`
- `ce27be4` — `Add richer plan approval decisions and feedback`
- `3d107ca` — `Refresh README for plan-first runtime and constitution flow`
- `0e6eea0` — `Improve resume semantics and plan feedback visibility`
- `07f4be3` — `Polish Pi plan approval interaction`

---

## What already exists

## Runtime

Implemented runtime behavior now includes:
- plan-first execution flow
- explicit `plan-approval` phase before implementation
- plan approval decisions:
  - `approve`
  - `reject`
  - `revise`
- optional plan feedback capture
- final approval still required later before merge
- planner / builder / repair / reviewer executor hooks
- per-task implementation scheduling
- per-task isolated workspaces
- integration phase
- verification phase
- reviewer phase
- final merge phase
- run persistence and inspection
- resume / cancel / cleanup flows

### Current runtime flow

```text
Goal
→ planning
→ plan-approval
→ implementation
→ integration
→ verification
→ review
→ approval-ready
→ merge
→ complete
```

### Approval semantics

Plan approval is no longer boolean-only.
Current contract is effectively:

```ts
PlanApprovalDecision = "approve" | "reject" | "revise"
PlanApprovalResult = { decision; feedback? }
```

Behavior:
- `approve` → continue to implementation
- `reject` → cancel before implementation
- `revise` → pause before implementation with `status: PENDING` and phase `plan-revision-requested`

Resume behavior is also now hardened:
- `plan-approval` resumes as still pending plan action
- `plan-revision-requested` resumes as still pending plan action
- `plan-approval-rejected` is not reopened

---

## Constitution system

Implemented constitution behavior now includes:
- full canonical 120-area output shape
- deterministic evaluator coverage across all 120 areas
- evidence-backed area generation
- claim-aware area structure
- critic warnings for generic or weak claims
- cross-area contradiction detection
- refresh metadata and impact routing
- constitution context injection into planner/builder/repair/reviewer prompts
- automatic constitution refresh before `/factory <goal>`

### Current public pipeline

The constitution engine is now a **single pipeline**:

```text
repository facts → AI interpretation → CONSTITUTION.md
```

Current behavior:
- scanner extracts observable facts first
- AI interpreter is required for newly finalized constitutions
- if AI is unavailable, facts are still written
- no finalized new constitution is produced without interpretation
- previous finalized constitution is preserved on failed refresh

### Refresh strategies

Refresh is now policy-driven:
- `reuse-finalized`
- `targeted-interpretation`
- `full-interpretation`

Rules:
- no change → reuse finalized constitution
- small non-structural changes → targeted interpretation
- structural changes → full interpretation
- failed refresh → preserve prior finalized constitution

### Scanner / AI boundary

This boundary is important and should not be regressed.

Scanner owns:
- observable facts
- evidence
- detected files/patterns
- deterministic findings

AI owns:
- interpretation
- architectural meaning
- conventions
- ambiguity resolution
- guidance phrasing

Scanner must not write normative policy.
AI must not invent evidence.

---

## Real SDK validation status

This is now updated from earlier handoff assumptions.

### Completed
- planner-only real SDK validation ✅
- fake full E2E validation ✅
- full realistic real-SDK runtime validation ✅

A full temp-repo real-SDK run completed through:
- planning
- plan approval
- implementation
- verification
- review
- final approval
- merge

Observed successful validation details:
- final status: `COMPLETED`
- final phase: `complete`
- verification: `passed`
- final merge: `merged`
- duration: roughly `105s`

So real-SDK validation is no longer a blocker.
Any remaining work there is optional profiling or latency optimization.

---

## Pi adapter state

Current Pi command surface includes:
- `/factory`
- `/factory setup`
- `/factory setup --force`
- `/factory status [run-id]`
- `/factory doctor`
- `/factory logs [run-id]`
- `/factory list`
- `/factory show <run-id>`
- `/factory plan`
- `/factory resume`
- `/factory cancel`
- `/factory worktree <branch>`
- `/factory cleanup [retain-count]`
- `/factory constitution`
- `/factory <goal>`

Current Pi-native approval behavior includes:
- inline plan preview rendering
- `select()` / `input()` path when available
- `confirm()` fallback
- reusable approval helper in:
  - `packages/adapters/pi/src/approval.ts`

Approval preview now shows:
- decision options
- plan summary
- task preview
- truncated task list with overflow hint

Dismissed rich-selection flows no longer auto-approve; they resolve safely to a revision request.

---

## Important files to understand first

### Constitution core
- `packages/core/src/constitution/types.ts`
- `packages/core/src/constitution/areas.ts`
- `packages/core/src/constitution/discovery.ts`
- `packages/core/src/constitution/refresh.ts`
- `packages/core/src/constitution/render.ts`
- `packages/core/src/constitution/scan.ts`
- `packages/core/src/constitution/context.ts`
- `packages/core/src/constitution/evaluators/`

### Runtime / approvals / run inspection
- `packages/core/src/runtime/controller.ts`
- `packages/core/src/runtime/harness.ts`
- `packages/core/src/runs/resume.ts`
- `packages/core/src/runs/logs-by-id.ts`
- `packages/core/src/runs/show.ts`
- `packages/adapters/pi/src/gateway.ts`
- `packages/adapters/pi/src/approval.ts`

### Source of truth for coverage model
- `SKILL.md`

---

## Current quality bar

The system is successful when it preserves these properties:

1. Project config remains authoritative.
2. Runtime remains plan-first.
3. Human approval remains explicit before implementation.
4. Final approval remains separate from plan approval.
5. Constitution remains fact-first and evidence-backed.
6. AI refines interpretation but does not replace evidence.
7. Refresh remains cheap on small changes.
8. Runtime context remains useful to planner/builder/repair/reviewer.

---

## What is actually left now

The highest-value remaining work is no longer broad constitution implementation.
It is mostly polish and maintenance:

1. Remaining docs / handoff cleanup
   - ensure all notes reflect current runtime and constitution behavior
   - remove references to obsolete boolean-only plan approval or older constitution modes

2. Optional real-SDK performance profiling
   - full E2E is already validated
   - only profile further if latency tuning matters

3. Local Windows `NUL` artifact cleanup
   - still excluded from commits
   - still causes local status noise

---

## Known current rough edges

1. `scan.ts` orchestration remains large even though evaluator logic is modularized.
2. Some heuristics will still need occasional tightening when tested on external repos.
3. Real-SDK full runs are validated but still relatively slow.
4. A stray filesystem artifact named `NUL` still exists locally on Windows and remains excluded from commits.

---

## Final instruction

Do not regress the current architecture by reintroducing:
- user-facing deterministic vs hybrid constitution modes
- boolean-only plan approval
- AI-first constitution generation
- project config being weaker than global defaults

Preserve the current end state:

```text
project-authoritative config
+ plan-first runtime
+ approve/reject/revise plan gate
+ evidence-backed 120-area constitution
+ single-pipeline AI interpretation
+ targeted/full refresh reuse policy
+ Pi-native run inspection and approval flow
+ validated real-SDK end-to-end execution
```
