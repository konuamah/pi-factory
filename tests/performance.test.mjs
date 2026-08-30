import test from 'node:test';
import assert from 'node:assert/strict';
import { computePerformanceReport } from '../packages/core/dist/benchmark/performance.js';

const harbor = (overrides = {}) => ({
  startedAt: 1_000_000,
  finishedAt: 1_100_000,
  environmentSetup: { startedAt: 1_000_000, finishedAt: 1_001_000 },
  agentSetup: { startedAt: 1_001_000, finishedAt: 1_003_000 },
  agentExecution: { startedAt: 1_003_000, finishedAt: 1_090_000 },
  verifier: { startedAt: 1_090_000, finishedAt: 1_100_000 },
  ...overrides,
});

const ev = (type, at, data = {}) => ({ type, at, data });

function report(harborTiming = harbor(), events = [], artifacts = []) {
  return computePerformanceReport(harborTiming, events, artifacts);
}

test('bucket math: harness + agent + verifier from Harbor phases', () => {
  const r = report();
  assert.equal(r.totalMs, 100_000);
  assert.equal(r.harnessMs, 3_000); // 1s env + 2s setup
  assert.equal(r.agentMs, 87_000);
  assert.equal(r.harborVerifierMs, 10_000);
  assert.equal(r.harnessFraction, 0.03);
});

test('model time uses ONLY assistant message windows, not tool-result messages', () => {
  const events = [
    ev('message_start', 1_000, { message: { role: 'assistant' } }),
    ev('message_end', 4_000, { message: { role: 'assistant' } }), // 3s model
    ev('message_start', 5_000, { message: { role: 'toolResult' } }),
    ev('message_end', 9_000, { message: { role: 'toolResult' } }), // NOT model
  ];
  const r = report(harbor(), [], [{ events }]);
  assert.equal(r.modelMs, 3_000);
  assert.equal(r.modelCallCount, 1);
});

test('tools use the union of intervals, not the sum, when parallel', () => {
  const events = [
    ev('tool_execution_start', 1_000, { toolCallId: 'a' }),
    ev('tool_execution_start', 2_000, { toolCallId: 'b' }), // overlaps
    ev('tool_execution_end', 10_000, { toolCallId: 'a' }),   // a: 0..9s
    ev('tool_execution_end', 12_000, { toolCallId: 'b' }),   // b: 2..11s
  ];
  const r = report(harbor(), [], [{ events }]);
  assert.equal(r.toolsMs, 11_000); // union of [1,10] U [2,12] = [1,12] = 11s
  assert.equal(r.toolExecutionSumMs, 19_000); // sum = 9 + 10 = 19s (workload)
  assert.equal(r.toolCallCount, 2);
});

test('sequential tools: union equals sum', () => {
  const events = [
    ev('tool_execution_start', 1_000, { toolCallId: 'a' }),
    ev('tool_execution_end', 4_000, { toolCallId: 'a' }),
    ev('tool_execution_start', 5_000, { toolCallId: 'b' }),
    ev('tool_execution_end', 8_000, { toolCallId: 'b' }),
  ];
  const r = report(harbor(), [], [{ events }]);
  assert.equal(r.toolsMs, 6_000);
  assert.equal(r.toolExecutionSumMs, 6_000);
});

test('agentOther = agentMs - model - tools - factoryVerification', () => {
  // Agent window 87s (1_003_000..1_090_000); verification phase inside it (60s);
  // model 30s; tools 10s -> agentOther = 87 - 30 - 10 - 60 = -13... instead make
  // verification 30s so the remainder is positive: 87 - 30 - 10 - 30 = 17s.
  const events = [
    { timestamp: '2026-08-30T22:03:21.000Z', type: 'phase.verification', data: {} },
    { timestamp: '2026-08-30T22:03:51.000Z', type: 'phase.verified', data: {} }, // 30s verify
  ];
  const artifacts = [
    { events: [ev('message_start', 1_003_000, { message: { role: 'assistant' } }), ev('message_end', 1_033_000, { message: { role: 'assistant' } })] }, // 30s model
    { events: [ev('tool_execution_start', 1_033_000, { toolCallId: 'x' }), ev('tool_execution_end', 1_043_000, { toolCallId: 'x' })] }, // 10s tools
  ];
  const r = report(harbor(), events, artifacts);
  assert.equal(r.modelMs, 30_000);
  assert.equal(r.toolsMs, 10_000);
  assert.equal(r.factoryVerificationMs, 30_000);
  assert.equal(r.agentMs, 87_000);
  assert.equal(r.agentOtherMs, 17_000);
  assert.equal(r.unaccountedMs, 17_000);
  assert.equal(r.warnings.some((w) => /cannot be reconciled/.test(w)), false);
});

test('evalMs combines factory verification + harbor verifier', () => {
  const events = [
    { timestamp: '2026-08-30T22:03:21.000Z', type: 'phase.verification', data: {} },
    { timestamp: '2026-08-30T22:05:21.000Z', type: 'phase.verified', data: {} },
  ];
  const r = report(harbor(), events, []);
  assert.equal(r.evalMs, 120_000 + 10_000); // factory verify + harbor verifier
});

test('missing timestamps -> null + warning, never zero', () => {
  const r = report();
  assert.equal(r.modelMs, null);
  assert.equal(r.toolsMs, null);
  assert.equal(r.modelCallCount, null);
  assert.equal(r.toolCallCount, null);
  assert.ok(r.warnings.some((w) => /model time not measurable/.test(w)));
  assert.ok(r.warnings.some((w) => /tool time not measurable/.test(w)));
});

test('deterministic given the same inputs', () => {
  const events = [ev('message_start', 1_000, { message: { role: 'assistant' } }), ev('message_end', 4_000, { message: { role: 'assistant' } })];
  const a = report(harbor(), [], [{ events }]);
  const b = report(harbor(), [], [{ events }]);
  assert.deepEqual(a, b);
});
