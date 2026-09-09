import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyVerificationFailuresWithAI,
  buildFailureEvidence,
} from '../packages/core/dist/index.js';

function failedResult(commandName, stderr, exitCode = 1) {
  return {
    cwd: '/repo',
    cwdResolution: 'root-package',
    commands: [
      { name: commandName, command: `pnpm ${commandName}`, status: 'failed', exitCode, stderr, stdout: '' },
    ],
    overallStatus: 'failed',
  };
}

const plan = {
  cwd: '/repo',
  cwdResolution: 'root-package',
  commands: { test: 'pnpm test', lint: 'pnpm lint' },
  selectionSource: 'deterministic',
  skill: { id: 'verification-planning', version: '1.0.0', mode: 'verification', selectionReasons: [] },
  evidence: {},
};

function deterministic(kind) {
  return {
    kind,
    reason: 'det reason',
    retryable: true,
    suggestedPhase: 'verification',
    perCommand: [{ commandName: 'lint', category: kind, reason: 'det', retryable: true, suggestedAction: 'repair' }],
  };
}

function executorReturning(outputText) {
  return {
    async execute() {
      return { executionId: 'x', status: 'completed', outputText, events: [] };
    },
    async cancel() {},
  };
}

test('AI classifier accepts a valid classification with implicated files', async () => {
  const output = JSON.stringify({
    kind: 'real-code-failure',
    reason: 'ESLint errors in Map.tsx which was changed.',
    retryable: true,
    suggestedPhase: 'verification',
    perCommand: [{
      commandName: 'lint',
      category: 'real-code-failure',
      reason: 'no-explicit-any in Map.tsx',
      retryable: true,
      suggestedAction: 'repair',
      implicatedFiles: ['frontend/src/app/components/Map.tsx'],
    }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('lint', 'error TS7006 in Map.tsx'),
    changedFiles: ['frontend/src/app/components/Map.tsx'],
    deterministic: deterministic('real-code-failure'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  assert.equal(result.kind, 'real-code-failure');
  assert.equal(result.perCommand[0].suggestedAction, 'repair');
  assert.deepEqual(result.perCommand[0].implicatedFiles, ['frontend/src/app/components/Map.tsx']);
});

test('AI cannot mark a failure as passed or invent categories', async () => {
  const output = JSON.stringify({
    kind: 'PASS', // invalid — must be rejected/constrained
    reason: 'looks fine',
    retryable: false,
    suggestedPhase: 'complete', // invalid phase
    perCommand: [{ commandName: 'lint', category: 'magic-category', reason: 'x', retryable: false, suggestedAction: 'delete-everything' }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('lint', 'error'),
    deterministic: deterministic('unknown'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  // kind must fall back to allowed (deterministic unknown) — never PASS
  assert.notEqual(result.kind, 'PASS');
  // phase constrained
  assert.ok(['verification', 'verification-planning'].includes(result.suggestedPhase));
  // per-command category constrained, action constrained to a safe default
  const cmd = result.perCommand[0];
  assert.ok(['missing-executable', 'invalid-command', 'missing-dependency', 'environment-policy', 'real-code-failure', 'baseline-unrelated', 'harness/config', 'unknown'].includes(cmd.category));
  assert.ok(['repair', 'prepare-environment', 'diagnose', 'ignore', 'blocker'].includes(cmd.suggestedAction));
});

test('AI cannot use repair for non-code categories', async () => {
  const output = JSON.stringify({
    kind: 'missing-dependency',
    reason: 'module not found',
    retryable: true,
    suggestedPhase: 'verification-planning',
    perCommand: [{ commandName: 'test', category: 'missing-dependency', reason: 'x', retryable: true, suggestedAction: 'repair' }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('test', 'Cannot find module'),
    deterministic: deterministic('missing-dependency'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  // repair is invalid for missing-dependency → must become prepare-environment
  assert.notEqual(result.perCommand[0].suggestedAction, 'repair');
  assert.equal(result.perCommand[0].suggestedAction, 'prepare-environment');
});

test('invalid JSON falls back to undefined (deterministic wins)', async () => {
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('test', 'error'),
    deterministic: deterministic('unknown'),
    executor: executorReturning('not json at all'),
  });
  assert.equal(result, undefined);
});

test('no executor returns undefined (deterministic path)', async () => {
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('test', 'error'),
    deterministic: deterministic('unknown'),
  });
  assert.equal(result, undefined);
});

test('buildFailureEvidence includes deterministic guess and truncated output', async () => {
  const evidence = buildFailureEvidence({
    plan,
    result: failedResult('lint', 'x'.repeat(2000)),
    changedFiles: ['src/a.ts'],
    deterministic: deterministic('real-code-failure'),
  });
  assert.equal(evidence.verificationCwd, '/repo');
  assert.ok(Array.isArray(evidence.changedFiles));
  assert.ok(evidence.deterministicClassification);
  const failed = evidence.failedCommands[0];
  assert.ok(failed.stdoutHead.length < 2000); // truncated
});

test('AI baseline-unrelated with build-output files is forced to real-code-failure', async () => {
  const output = JSON.stringify({
    kind: 'baseline-unrelated',
    reason: 'Failure in .next build output',
    retryable: false,
    suggestedPhase: 'verification',
    perCommand: [{
      commandName: 'build',
      category: 'baseline-unrelated',
      reason: 'prerender error in .next output',
      retryable: false,
      suggestedAction: 'ignore',
      implicatedFiles: ['.next/server/chunks/ssr/xyz.js'],
    }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('build', 'window is not defined'),
    changedFiles: ['src/app/page.tsx'],
    deterministic: deterministic('baseline-unrelated'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  // .next/ is generated output → baseline-unrelated is invalid → real-code-failure + repair.
  assert.equal(result.perCommand[0].category, 'real-code-failure');
  assert.equal(result.perCommand[0].suggestedAction, 'repair');
  assert.equal(result.kind, 'real-code-failure');
});

test('AI baseline-unrelated with a real source file outside changes is preserved', async () => {
  const output = JSON.stringify({
    kind: 'baseline-unrelated',
    reason: 'Failure in untouched legacy file',
    retryable: false,
    suggestedPhase: 'verification',
    perCommand: [{
      commandName: 'build',
      category: 'baseline-unrelated',
      reason: 'type error in legacy util',
      retryable: false,
      suggestedAction: 'ignore',
      implicatedFiles: ['src/legacy/old-util.ts'],
    }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('build', 'error in src/legacy/old-util.ts'),
    changedFiles: ['src/app/page.tsx'],
    deterministic: deterministic('baseline-unrelated'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  // Real source file, not changed → baseline-unrelated is valid.
  assert.equal(result.perCommand[0].category, 'baseline-unrelated');
  assert.equal(result.perCommand[0].suggestedAction, 'ignore');
});

test('AI classification carries rootCause and suggestedGeneralFix', async () => {
  const output = JSON.stringify({
    kind: 'real-code-failure',
    reason: 'browser API in server component',
    rootCause: 'window used during SSR prerender',
    suggestedGeneralFix: 'Guard window access or move component to client side',
    retryable: true,
    suggestedPhase: 'verification',
    perCommand: [{
      commandName: 'build',
      category: 'real-code-failure',
      reason: 'window is not defined',
      retryable: true,
      suggestedAction: 'repair',
      implicatedFiles: ['src/app/StatusBar.tsx'],
    }],
  });
  const result = await classifyVerificationFailuresWithAI({
    plan,
    result: failedResult('build', 'window is not defined'),
    changedFiles: ['src/app/StatusBar.tsx'],
    deterministic: deterministic('real-code-failure'),
    executor: executorReturning(output),
  });
  assert.ok(result);
  assert.equal(result.rootCause, 'window used during SSR prerender');
  assert.equal(result.suggestedGeneralFix, 'Guard window access or move component to client side');
});
