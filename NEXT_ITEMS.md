# Next Items

## Immediate

1. Commit current runtime changes
   - `packages/adapters/pi/src/gateway.ts`
   - `packages/core/src/runtime/controller.ts`
   - `packages/core/src/runtime/harness.ts`
   - `packages/executors/pi/src/runtime-harness.ts`
   - `packages/executors/pi/src/sdk-factory.ts`

2. Add runtime tests for plan approval flow
   - plan approval accepted
   - plan approval rejected
   - final approval still happens after implementation/review
   - resume behavior around `plan-approval`

## Pi-native UX

3. Improve plan approval interaction in Pi
   - keep current `confirm()` path as baseline
   - optionally add richer TUI approval UI
   - support approve / reject / revise
   - optionally collect short reviewer feedback

4. Add `/factory plan`
   - show latest run plan summary
   - handle empty/missing/stale plan cases
   - keep output adapter-friendly and concise

## Runtime / E2E

5. Validate full real-SDK E2E
   - planner-only real SDK already works
   - fake full E2E already works
   - still need one realistic full real-SDK run to complete end-to-end
   - isolate builder/reviewer latency if needed

6. Refine plan-first runtime semantics
   - clarify `plan-approval` vs final approval
   - improve resume semantics for pre-implementation approval states
   - optionally support plan-only stop/resume mode

## Documentation

7. Refresh docs / README
   - current command surface
   - constitution refresh strategy
   - SDK-backed execution requirements
   - plan approval phase
   - realistic current runtime flow

## Suggested order

1. Commit runtime changes
2. Add plan-approval tests
3. Add `/factory plan`
4. Improve Pi approval UX
5. Finish full real-SDK E2E validation
6. Refresh docs
