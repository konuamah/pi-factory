import test from 'node:test';
import assert from 'node:assert/strict';
import { __resetRecoveryNarratorCacheForTests, fallbackRecoveryNarration, narrateRecovery } from '../packages/core/dist/index.js';

const context = { phase: 'verification', title: 'verification failed', reason: 'The test command failed.', category: 'verification', retryable: true, canRepair: false, canRevise: true, attempt: 1, maxAttempts: 3 };
const executor = (outputText) => ({ execute: async () => ({ executionId: 'n', status: 'completed', outputText, events: [] }), cancel: async () => {} });

test('recovery narration uses deterministic fallback without an executor', async () => {
  __resetRecoveryNarratorCacheForTests();
  const result = await narrateRecovery({ runId: 'r1', phase: 'verification', context, enabledOptions: ['retry', 'revise', 'stop'] });
  assert.deepEqual(result, fallbackRecoveryNarration(context, ['retry', 'revise', 'stop']));
});

test('recovery narration sanitizes model prose and option ids', async () => {
  __resetRecoveryNarratorCacheForTests();
  const result = await narrateRecovery({
    runId: 'r2', phase: 'verification', context, enabledOptions: ['retry', 'revise', 'stop'],
    executor: executor(JSON.stringify({ title: 'Tests need attention', problem: 'A test failed.', howToRecover: 'Fix it and retry.', options: [
      { id: 'retry', label: 'Run tests again' }, { id: 'auto', label: 'Skip it' }, { id: 'stop', label: 'Stop here' },
    ] })),
  });
  assert.equal(result.title, 'Tests need attention');
  assert.deepEqual(result.options.map((option) => option.id), ['retry', 'stop']);
});

test('recovery narration caches by run and phase', async () => {
  __resetRecoveryNarratorCacheForTests();
  let calls = 0;
  const wrapped = { execute: async (input) => { calls++; return executor(JSON.stringify({ title: 'cached', options: [{ id: 'retry', label: 'Retry' }, { id: 'stop', label: 'Stop' }] })).execute(input); }, cancel: async () => {} };
  await narrateRecovery({ runId: 'r3', phase: 'verification', context, enabledOptions: ['retry', 'stop'], executor: wrapped });
  await narrateRecovery({ runId: 'r3', phase: 'verification', context, enabledOptions: ['retry', 'stop'], executor: wrapped });
  assert.equal(calls, 1);
});
