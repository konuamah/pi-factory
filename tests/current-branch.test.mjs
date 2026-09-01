import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadEffectiveConfig,
  validateEffectiveConfig,
  getChangedFilesFromBase,
  runFactoryDoctor,
} from '../packages/core/dist/index.js';
import { CURRENT_BRANCH_SENTINEL } from '@factory/schemas';

const execFile = promisify(execFileCb);

async function withTempRepo(fn, { branch = 'main' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-current-'));
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# temp\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await execFile('git', ['branch', '-M', 'main'], { cwd: root });
    if (branch !== 'main') {
      await execFile('git', ['checkout', '-b', branch], { cwd: root });
    }
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeProjectConfig(root, config) {
  await fs.mkdir(path.join(root, '.factory'), { recursive: true });
  await fs.writeFile(path.join(root, '.factory', 'config.yaml'), config, 'utf8');
}

test('git.baseBranch: @current resolves to the checked-out branch in all fields', async () => {
  await withTempRepo(async (root) => {
    await writeProjectConfig(root, `git:\n  baseBranch: "${CURRENT_BRANCH_SENTINEL}"\n  pullRequest:\n    baseBranch: "${CURRENT_BRANCH_SENTINEL}"\nproject:\n  baseBranch: "${CURRENT_BRANCH_SENTINEL}"\n`);
    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.git.baseBranch, 'feature-x');
    assert.equal(loaded.effectiveConfig.project.baseBranch, 'feature-x');
    assert.equal(loaded.effectiveConfig.git.pullRequest.baseBranch, 'feature-x');
    assert.equal(loaded.baseBranchSource, 'current');
  }, { branch: 'feature-x' });
});

test('explicit baseBranch is unchanged and reported as explicit', async () => {
  await withTempRepo(async (root) => {
    await writeProjectConfig(root, 'git:\n  baseBranch: main\nproject:\n  baseBranch: main\n');
    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.git.baseBranch, 'main');
    assert.equal(loaded.effectiveConfig.project.baseBranch, 'main');
    assert.equal(loaded.baseBranchSource, 'explicit');
  }, { branch: 'feature-x' });
});

test('@current on detached HEAD fails loud with an actionable message', async () => {
  await withTempRepo(async (root) => {
    await writeProjectConfig(root, `git:\n  baseBranch: "${CURRENT_BRANCH_SENTINEL}"\n`);
    await execFile('git', ['checkout', '--detach'], { cwd: root });
    await assert.rejects(
      () => loadEffectiveConfig({ cwd: root }),
      /could not be resolved/,
    );
  });
});

test('surviving sentinel in validateEffectiveConfig is rejected', () => {
  const base = {
    git: { baseBranch: 'main', allowWorktrees: true, cleanup: { retainRuns: 10, pruneWorktrees: true, pruneBranches: true }, pullRequest: { enabled: true, provider: 'github', cli: 'gh', draft: false } },
    project: { baseBranch: 'main' },
    runtime: { maxParallelAgents: 2, limits: {} },
    ui: { showWorkerDetails: false },
    defaults: { autonomy: 'safe', workflow: 'balanced' },
    commands: {},
    repair: { enabled: true, maxAttempts: 3, maxTotalAttempts: 10 },
    constitution: { enabled: false },
    approval: { finalMerge: 'required' },
    dashboard: { enabled: false, port: 4199, host: '127.0.0.1', autoOpen: false },
    dependencies: { enabled: true, hydrate: 'auto', cacheRoot: path.join(os.tmpdir(), 'factory-cache-test') },
    models: {},
    taskTypes: {},
    workflow: {},
  };
  assert.throws(() => validateEffectiveConfig({ ...base, git: { ...base.git, baseBranch: CURRENT_BRANCH_SENTINEL } }, { projectRoot: '/tmp' }), /must be resolved by the config loader/);
  assert.throws(() => validateEffectiveConfig({ ...base, git: { ...base.git, pullRequest: { ...base.git.pullRequest, baseBranch: CURRENT_BRANCH_SENTINEL } } }, { projectRoot: '/tmp' }), /must be resolved by the config loader/);
});

test('getChangedFilesFromBase falls back to the local branch when origin ref is missing', async () => {
  await withTempRepo(async (root) => {
    // Create a local-only base branch (no origin configured) and a feature
    // branch on top of it; the base branch must differ from HEAD.
    await execFile('git', ['checkout', '-b', 'local-base'], { cwd: root });
    await fs.writeFile(path.join(root, 'base-file.txt'), 'base\n');
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'base'], { cwd: root });
    await execFile('git', ['checkout', '-b', 'feature-x'], { cwd: root });
    await fs.writeFile(path.join(root, 'new-file.txt'), 'hello\n');
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'add file'], { cwd: root });

    const changed = await getChangedFilesFromBase(root, 'local-base');
    assert.ok(changed.includes('new-file.txt'));
  });
});

test('doctor reports baseBranch provenance when resolved from @current', async () => {
  await withTempRepo(async (root) => {
    await writeProjectConfig(root, `git:\n  baseBranch: "${CURRENT_BRANCH_SENTINEL}"\n`);
    const result = await runFactoryDoctor(root);
    const configLoad = result.checks.find((c) => c.name === 'config-load');
    assert.ok(configLoad);
    assert.equal(configLoad.ok, true);
    assert.match(configLoad.detail, /baseBranch=feature-x/);
    assert.match(configLoad.detail, /resolved from @current/);
  }, { branch: 'feature-x' });
});

test('run-level snapshot: effective-config.json persists the resolved branch', async () => {
  await withTempRepo(async (root) => {
    await writeProjectConfig(root, `git:\n  baseBranch: "${CURRENT_BRANCH_SENTINEL}"\n`);
    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.git.baseBranch, 'feature-x');
  }, { branch: 'feature-x' });
});
