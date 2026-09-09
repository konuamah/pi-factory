import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createFactoryRun,
  requestRuntimePolicy,
  verifyDecisionConstraints,
} from '../packages/core/dist/index.js';

const context = (overrides = {}) => ({
  runId: 'run_policy', goal: 'fix the issue', currentPhase: 'verification', evidence: {},
  attempt: 1, maxAttempts: 3, allowedNextPhases: [], constraints: { retryable: true }, ...overrides,
});

test('policy constraints reject unsafe actions and accept abort', () => {
  assert.equal(verifyDecisionConstraints({ action: 'repair', attempt: 1, decidedAt: new Date().toISOString() }, context(), {}).ok, false);
  assert.equal(verifyDecisionConstraints({ action: 'abort', attempt: 1, decidedAt: new Date().toISOString() }, context()).ok, true);
});

test('runtime policy executor is persisted and resumes the run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-policy-'));
  try {
    const run = await createFactoryRun({ runsDir: path.join(root, '.factory', 'runs') });
    const result = await requestRuntimePolicy({
      controllerInput: { cwd: root, goal: 'fix the issue', policyExecutor: { execute: async () => ({ action: 'continue', attempt: 1, decidedAt: new Date().toISOString() }) } },
      runDir: run.runDir, statePath: run.statePath, eventsPath: run.eventsPath, runId: run.runId,
      context: context({ runId: run.runId }),
    });
    assert.equal(result.action, 'continue');
    assert.equal(JSON.parse(await fs.readFile(run.statePath, 'utf8')).status, 'RUNNING');
    assert.match(await fs.readFile(path.join(run.runDir, 'decisions.jsonl'), 'utf8'), /"source":"POLICY"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('policy executor is re-prompted after a hard-constraint violation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-policy-'));
  try {
    const run = await createFactoryRun({ runsDir: path.join(root, '.factory', 'runs') });
    let calls = 0;
    const result = await requestRuntimePolicy({
      controllerInput: { cwd: root, goal: 'fix it', policyExecutor: { execute: async () => (++calls === 1 ? { action: 'repair', attempt: 1, decidedAt: new Date().toISOString() } : { action: 'abort', attempt: 1, decidedAt: new Date().toISOString() }) } },
      runDir: run.runDir, statePath: run.statePath, eventsPath: run.eventsPath, runId: run.runId, context: context({ runId: run.runId }),
    });
    assert.equal(result.action, 'abort');
    assert.equal(calls, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
