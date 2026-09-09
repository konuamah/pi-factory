import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendDecisionLedgerEntry,
  buildFailureRecoveryRequest,
  createFactoryRun,
  readDecisionLedger,
  readRecoveryCheckpoint,
  requestFailureRecovery,
  resumeLatestFactoryRun,
  updateFactoryRunState,
  writeRecoveryCheckpoint,
} from '../packages/core/dist/index.js';

async function withRun(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-recovery-'));
  try {
    const run = await createFactoryRun({ runsDir: path.join(root, '.factory', 'runs') });
    return await fn(run);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('buildFailureRecoveryRequest creates a runtime recovery decision with bounded actions', async () => {
  const request = await buildFailureRecoveryRequest('run_1', {
    phase: 'verification-planning',
    title: 'verification planning failed',
    reason: 'Planner omitted all runnable commands',
    category: 'verification-planning',
    retryable: true,
    canRevise: true,
    canRepair: false,
    evidenceRefs: ['/tmp/run/verification-planner-execution.json'],
    attempt: 2,
    maxAttempts: 3,
  }, { disableNarrator: true });

  assert.equal(request.source, 'RUNTIME');
  assert.equal(request.reason, 'FAILURE_RECOVERY');
  assert.equal(request.id, 'run_1-recovery-verification-planning-2');
  assert.deepEqual(request.options.map((option) => option.id), ['retry', 'revise', 'stop']);
  assert.match(request.question, /Phase: verification-planning/);
  assert.match(request.context ?? '', /2 of 3/);
  assert.deepEqual(request.evidenceRefs, ['/tmp/run/verification-planner-execution.json']);
});

test('requestFailureRecovery persists request, checkpoint, and resolution then returns selected action with feedback', async () => {
  await withRun(async (run) => {
    const result = await requestFailureRecovery({
      controllerInput: {
        cwd: run.runDir,
        goal: 'demo',
        requestDecision: async (request) => ({
          requestId: request.id,
          optionId: 'revise',
          feedback: 'Use the package app root',
          decidedAt: new Date().toISOString(),
        }),
      },
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      checkpoint: {
        runId: run.runId,
        goal: 'demo',
        phase: 'implementation',
        executionCwd: run.runDir,
        projectRoot: run.runDir,
      },
      context: {
        phase: 'planning',
        title: 'planner output was not usable',
        reason: 'Planner delegated broad discovery to Builder',
        category: 'planner-output',
        retryable: true,
        canRevise: true,
        attempt: 1,
      },
    });

    assert.deepEqual(result, {
      action: 'revise',
      feedback: 'Use the package app root',
      requestId: `${run.runId}-recovery-planning-1`,
    });
    const state = JSON.parse(await fs.readFile(run.statePath, 'utf8'));
    assert.equal(state.status, 'RUNNING');
    const checkpoint = await readRecoveryCheckpoint(run.runDir);
    assert.equal(checkpoint?.phase, 'implementation');
    assert.equal(checkpoint?.recoveryContext.phase, 'planning');
    const decisions = await readDecisionLedger(run.runDir);
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].type, 'request');
    assert.equal(decisions[1].type, 'resolution');
    const events = (await fs.readFile(run.eventsPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === 'run.recovery_requested'));
    assert.ok(events.some((event) => event.type === 'run.recovery_resolved'));
  });
});

test('requestFailureRecovery stops when no decision handler is configured', async () => {
  await withRun(async (run) => {
    const result = await requestFailureRecovery({
      controllerInput: { cwd: run.runDir, goal: 'demo' },
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      context: {
        phase: 'discovery',
        title: 'discovery output was not usable',
        reason: 'Invalid JSON',
        category: 'discovery-output',
        retryable: true,
        attempt: 1,
      },
    });

    assert.equal(result.action, 'stop');
    const decisions = await readDecisionLedger(run.runDir);
    assert.equal(decisions.length, 0);
  });
});

test('resumeLatestFactoryRun reports a pending runtime recovery decision without reopening it', async () => {
  await withRun(async (run) => {
    const request = await buildFailureRecoveryRequest(run.runId, {
      phase: 'implementation',
      title: 'implementation failed',
      reason: 'builder failed',
      category: 'executor-failed',
      retryable: true,
      attempt: 1,
    });
    await appendDecisionLedgerEntry(run.runDir, { type: 'request', request });
    await writeRecoveryCheckpoint(run.runDir, {
      version: 1,
      runId: run.runId,
      goal: 'demo',
      phase: 'implementation',
      createdAt: new Date().toISOString(),
      executionCwd: run.runDir,
      projectRoot: run.runDir,
      recoveryContext: {
        phase: 'implementation',
        title: 'implementation failed',
        reason: 'builder failed',
        category: 'executor-failed',
        retryable: true,
        attempt: 1,
      },
    });
    const decisions = await readDecisionLedger(run.runDir);
    const pending = decisions.find((entry) => entry.type === 'request' && entry.request.id === request.id);
    assert.ok(pending);
    await updateFactoryRunState({ statePath: run.statePath, patch: { status: 'PENDING', phase: 'decision-runtime' } });

    const result = await resumeLatestFactoryRun(path.dirname(run.runDir));
    assert.equal(result.resumed, false);
    assert.match(result.reason, /awaiting a runtime recovery decision/);
    assert.equal(result.recovery?.pendingDecision?.requestId, request.id);
    assert.equal(result.recovery?.resumable, true);
  });
});

test('requestFailureRecovery converts an invalid selected option into stop', async () => {
  await withRun(async (run) => {
    const result = await requestFailureRecovery({
      controllerInput: {
        cwd: run.runDir,
        goal: 'demo',
        requestDecision: async (request) => ({
          requestId: request.id,
          optionId: 'approve',
          decidedAt: new Date().toISOString(),
        }),
      },
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      context: {
        phase: 'planning',
        title: 'planner output was not usable',
        reason: 'Invalid plan',
        category: 'planner-output',
        retryable: true,
        attempt: 1,
      },
    });

    assert.equal(result.action, 'stop');
    assert.match(result.feedback ?? '', /Invalid recovery option/);
    const events = (await fs.readFile(run.eventsPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === 'decision.invalid'));
  });
});
