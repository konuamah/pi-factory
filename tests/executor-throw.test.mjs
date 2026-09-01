import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runRuntimeHarness } from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempProject(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-throw-'));
  try {
    if (options.rootPackage !== false) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    }
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:',
      '  baseBranch: main',
      'commands:',
      '  lint: node -e ""',
      '  test: node -e ""',
      'runtime:',
      '  limits:',
      '    runTimeoutMs: 120000',
      'git:',
      '  allowWorktrees: false',
      'repair:',
      '  enabled: false',
      'approval:',
      '  finalMerge: required',
    ].join('\n'), 'utf8');
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function discoveryOk() {
  return {
    async execute() {
      return {
        executionId: 'd', status: 'completed',
        outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'Entry point observed' }], unknowns: [] }),
        events: [],
      };
    },
    async cancel() {},
  };
}

test('discovery executor throw returns a FAILED run record, not a raw throw', async () => {
  await withTempProject(async (root) => {
    const throwing = {
      async execute() { throw new Error('SDK crash: ECONNRESET'); },
      async cancel() {},
    };
    const result = await runRuntimeHarness({
      cwd: root, goal: 'Add a feature',
      plannerExecutor: throwing,
    });
    // plannerExecutor is also used as discovery fallback -> discovery throws.
    assert.ok(result.runDir, 'expected a run dir');
    assert.ok(result.summaryPath, 'expected a summary path');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
    assert.equal(summary.status, 'FAILED');
    assert.match(summary.recoveryHint ?? '', /ECONNRESET/);
    const events = (await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === 'run.failed'), 'expected run.failed event');
  });
});

test('planner executor throw (after discovery ok) returns FAILED record', async () => {
  await withTempProject(async (root) => {
    const plannerThrows = {
      async execute(input) {
        if (input.metadata?.role === 'discovery') {
          return {
            executionId: 'd', status: 'completed',
            outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'x' }], unknowns: [] }),
            events: [],
          };
        }
        throw new Error('planner model timeout');
      },
      async cancel() {},
    };
    const result = await runRuntimeHarness({
      cwd: root, goal: 'Add a feature',
      plannerExecutor: plannerThrows,
    });
    assert.ok(result.runDir, 'expected a run dir');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
    assert.match(summary.recoveryHint ?? '', /timeout/);
  });
});

test('reviewer executor throw returns FAILED record', async () => {
  await withTempProject(async (root) => {
    const reviewerThrows = {
      async execute(input) {
        if (input.metadata?.role === 'discovery') return { executionId: 'd', status: 'completed', outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'x' }], unknowns: [] }), events: [] };
        if (input.metadata?.role === 'planner') return { executionId: 'p', status: 'completed', outputText: 'Feature Plan\n- Update the target document\nWAITING_FOR_APPROVAL', events: [] };
        if (input.metadata?.role === 'reviewer') throw new Error('reviewer SDK crash');
        return { executionId: input.executionId, status: 'completed', outputText: 'done', events: [] };
      },
      async cancel() {},
    };
    const result = await runRuntimeHarness({
      cwd: root, goal: 'Add a feature',
      plannerExecutor: reviewerThrows,
      reviewerExecutor: reviewerThrows,
      requestPlanApproval: async () => ({ decision: 'approve' }),
    });
    assert.ok(result.runDir, 'expected a run dir');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
    assert.match(summary.recoveryHint ?? '', /reviewer SDK crash/);
  });
});

test('builder executor throw returns FAILED record', async () => {
  await withTempProject(async (root) => {
    const builderThrows = {
      async execute(input) {
        if (input.metadata?.role === 'discovery') return { executionId: 'd', status: 'completed', outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'x' }], unknowns: [] }), events: [] };
        if (input.metadata?.role === 'planner') return { executionId: 'p', status: 'completed', outputText: 'Feature Plan\n- Update the target document\nWAITING_FOR_APPROVAL', events: [] };
        if (input.metadata?.role === 'builder') throw new Error('builder provider 500');
        return { executionId: input.executionId, status: 'completed', outputText: 'done', events: [] };
      },
      async cancel() {},
    };
    const result = await runRuntimeHarness({
      cwd: root, goal: 'Add a feature',
      plannerExecutor: builderThrows,
      builderExecutor: builderThrows,
      requestPlanApproval: async () => ({ decision: 'approve' }),
    });
    assert.ok(result.runDir, 'expected a run dir');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
    assert.match(summary.recoveryHint ?? '', /500/);
  });
});
