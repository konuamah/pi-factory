# Next Items

## Highest priority

1. Refine resume semantics for plan approval states
   - improve `/factory resume` behavior for `plan-approval`
   - improve `/factory resume` behavior for `plan-revision-requested`
   - surface clearer suggested recovery phases
   - tighten UI/status wording for paused pre-implementation runs

2. Surface plan feedback in run inspection
   - show plan revision feedback in `/factory logs`
   - show plan revision feedback in `/factory show <run-id>`
   - show rejected/revise plan decisions more clearly
   - make plan approval events easier to scan

## Pi-native UX polish

3. Improve the plan approval interaction further
   - keep current `select()` / `input()` path when available
   - keep `confirm()` fallback for simpler environments
   - consider a reusable approval widget/dialog
   - improve inline summary/task rendering

## Runtime / validation

4. Revisit real-SDK runtime performance
   - full realistic real-SDK E2E is now validated
   - latest successful run completed planning → approval → implementation → verification → review → merge
   - observed duration was roughly 105s in temp-repo validation
   - next performance work should isolate builder/reviewer latency only if needed

## Documentation / housekeeping

5. Refresh remaining docs and handoff notes
   - ensure no docs still describe boolean-only plan approval
   - align handoff notes with current runtime and constitution behavior

6. Clean up local Windows `NUL` filesystem artifact if possible
   - still excluded from commits
   - still causes local status noise

## Suggested order

1. Resume semantics for `plan-approval` / `plan-revision-requested`
2. Surface plan feedback in logs/show
3. Pi approval UX polish
4. Remaining docs/handoff cleanup
5. Optional performance profiling
6. `NUL` cleanup
