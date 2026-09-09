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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-setup-'));
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
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function makeExecutor() {
  return {
    async execute() {
      return { executionId: 'x', status: 'completed', outputText: 'done', events: [] };
    },
    async cancel() {},
  };
}

test('setup failure (invalid config) returns a FAILED run record, not a raw throw', async () => {
  await withTempProject(async (root) => {
    // Invalid config: git.baseBranch is required but missing/empty.
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:',
      '  baseBranch: ""',
      'commands:',
      '  lint: node -e ""',
    ].join('\n'), 'utf8');

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor: makeExecutor(),
    });

    // A run record + summary exist, marked FAILED/setup-failed.
    assert.ok(result.runDir, 'expected a run dir');
    assert.ok(result.summaryPath, 'expected a summary path');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'setup-failed');
    const summary = JSON.parse(await fs.readFile(result.summaryPath, 'utf8'));
    assert.equal(summary.status, 'FAILED');
    assert.equal(summary.phase, 'setup-failed');
  });
});

test('setup failure writes a run.failed event with the reason', async () => {
  await withTempProject(async (root) => {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:',
      '  baseBranch: ""',
      'commands:',
      '  lint: node -e ""',
    ].join('\n'), 'utf8');

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor: makeExecutor(),
    });

    const events = (await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const failed = events.find((event) => event.type === 'run.failed');
    assert.ok(failed, 'expected run.failed event');
    assert.ok(failed.data.reason, 'expected a reason');
  });
});

test('setup failure creates a minimal run dir even when validation fails before run creation', async () => {
  await withTempProject(async (root) => {
    // A config that fails validation (negative retainRuns) BEFORE the run is
    // created — setup must still produce a FAILED run record.
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:',
      '  baseBranch: main',
      'git:',
      '  cleanup:',
      '    retainRuns: -1',
    ].join('\n'), 'utf8');

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor: makeExecutor(),
    });

    assert.ok(result.runDir, 'expected a run dir even when setup failed');
    const state = JSON.parse(await fs.readFile(path.join(result.runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
  });
});
