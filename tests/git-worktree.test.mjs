import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitWorktree, createSiblingGitWorktree } from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-worktree-'));
  try {
    await fs.writeFile(path.join(root, 'README.md'), '# temp\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await execFile('git', ['branch', '-M', 'main'], { cwd: root });
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('createGitWorktree reuses an existing worktree for the same branch', async () => {
  await withTempRepo(async (root) => {
    const first = await createGitWorktree({
      cwd: root,
      branchName: 'factory-demo',
      baseBranch: 'main',
    });

    const second = await createGitWorktree({
      cwd: root,
      branchName: 'factory-demo',
      baseBranch: 'main',
    });

    assert.equal(first.mode, 'created');
    assert.equal(second.mode, 'existing');
    assert.equal(second.branch, 'factory-demo');
    assert.equal(path.normalize(second.path), path.normalize(first.path));
  });
});

test('createGitWorktree falls back to a unique branch when a stale branch already exists', async () => {
  await withTempRepo(async (root) => {
    const first = await createGitWorktree({
      cwd: root,
      branchName: 'factory-stale',
      baseBranch: 'main',
    });

    await execFile('git', ['worktree', 'remove', first.path, '--force'], { cwd: root });

    const second = await createGitWorktree({
      cwd: root,
      branchName: 'factory-stale',
      baseBranch: 'main',
    });

    assert.equal(second.mode, 'created');
    assert.ok(second.branch.startsWith('factory-stale'));
    assert.notEqual(second.branch, 'factory-stale');
  });
});

test('createGitWorktree does not reuse prunable worktree metadata when the directory is gone', async () => {
  await withTempRepo(async (root) => {
    const first = await createGitWorktree({
      cwd: root,
      branchName: 'factory-prunable',
      baseBranch: 'main',
    });

    await fs.rm(first.path, { recursive: true, force: true });

    const second = await createGitWorktree({
      cwd: root,
      branchName: 'factory-prunable',
      baseBranch: 'main',
    });

    assert.equal(second.mode, 'created');
    assert.notEqual(path.normalize(second.path), path.normalize(first.path));
    assert.ok(await fs.stat(second.path).then((stat) => stat.isDirectory()));
  });
});

test('createSiblingGitWorktree created from a linked worktree uses the main worktree storage dir', async () => {
  await withTempRepo(async (root) => {
    const parent = await createGitWorktree({
      cwd: root,
      branchName: 'factory-parent',
      baseBranch: 'main',
    });

    const child = await createSiblingGitWorktree({
      cwd: parent.path,
      branchName: 'factory-child',
      baseRef: 'factory-parent',
    });

    assert.equal(child.mode, 'created');
    assert.equal(await fs.realpath(path.dirname(child.path)), await fs.realpath(path.join(root, '.worktrees')));
    assert.ok(!child.path.includes(`${path.basename(parent.path)}/.worktrees/`));
  });
});
