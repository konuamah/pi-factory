import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { removeRunGitIsolation } from '../packages/core/dist/runs/cleanup.js';

const execFile = promisify(execFileCb);

async function initGitRepo(root) {
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
}

async function worktreeBranches(root) {
  const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  return stdout
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.split(/\r?\n/).filter(Boolean))
    .filter((lines) => lines.some((line) => line.startsWith('branch refs/heads/')))
    .map((lines) => lines.find((line) => line.startsWith('branch refs/heads/')).slice('branch refs/heads/'.length));
}

async function worktreePaths(root) {
  const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  return stdout
    .split(/\r?\n\r?\n/)
    .map((entry) => entry.split(/\r?\n/)[0])
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

test('removeRunGitIsolation removes recorded worktrees and branches and prunes stale metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-cleanup-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await initGitRepo(root);

    // Create main + sibling worktrees the way Factory does.
    const wtDir = path.join(root, '.worktrees');
    await fs.mkdir(wtDir, { recursive: true });
    await execFile('git', ['worktree', 'add', path.join(wtDir, 'run-main'), '-b', 'factory-run-main'], { cwd: root });
    await execFile('git', ['worktree', 'add', path.join(wtDir, 'run-main-task-3'), '-b', 'factory-run-main-task-3'], { cwd: root });

    // Simulate the run artifacts that record workspace paths/branches.
    const runDir = path.join(root, '.factory', 'runs', 'run_1');
    await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'tasks', 'task-1.json'),
      JSON.stringify({
        id: 'task-1',
        workspacePath: path.join(wtDir, 'run-main'),
        workspaceMode: 'created',
        workspaceBranch: 'factory-run-main',
      }),
    );
    await fs.writeFile(
      path.join(runDir, 'tasks', 'task-3.json'),
      JSON.stringify({
        id: 'task-3',
        workspacePath: path.join(wtDir, 'run-main-task-3'),
        workspaceMode: 'created',
        workspaceBranch: 'factory-run-main-task-3',
      }),
    );

    // Also simulate an externally-deleted directory (stale metadata only).
    const staleDir = path.join(wtDir, 'run-stale');
    await execFile('git', ['worktree', 'add', staleDir, '-b', 'factory-run-stale'], { cwd: root });
    await fs.rm(staleDir, { recursive: true, force: true });

    const result = await removeRunGitIsolation({
      runDir,
      projectRoot: root,
      pruneWorktrees: true,
      pruneBranches: true,
      baseBranch: 'main',
    });

    assert.deepEqual(result.removedWorktrees.sort(), [path.join(wtDir, 'run-main'), path.join(wtDir, 'run-main-task-3')].sort());
    assert.deepEqual([...result.removedBranches].sort(), ['factory-run-main', 'factory-run-main-task-3'].sort());
    assert.deepEqual(result.warnings, []);

    // Factory-created worktree branches must be removed.
    const remaining = await worktreeBranches(root);
    assert.ok(!remaining.includes('factory-run-main'), 'main worktree branch should be gone');
    assert.ok(!remaining.includes('factory-run-main-task-3'), 'sibling worktree branch should be gone');

    // The externally-deleted worktree must be pruned from git metadata (its
    // directory was already gone, so the branch ref Factory never created
    // remains and is intentionally left alone — not Factory-managed).
    const remainingPaths = await worktreePaths(root);
    assert.ok(!remainingPaths.some((p) => p.includes('run-stale')), 'stale worktree metadata should be pruned');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('removeRunGitIsolation skips non-created workspaces and leaves unrelated worktrees alone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-cleanup-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await initGitRepo(root);

    const wtDir = path.join(root, '.worktrees');
    await fs.mkdir(wtDir, { recursive: true });
    // A pre-existing worktree that Factory reuses (mode "existing") and an
    // unrelated worktree that Factory never touched.
    await execFile('git', ['worktree', 'add', path.join(wtDir, 'preexisting'), '-b', 'preexisting-branch'], { cwd: root });
    await execFile('git', ['worktree', 'add', path.join(wtDir, 'other'), '-b', 'other-branch'], { cwd: root });

    const runDir = path.join(root, '.factory', 'runs', 'run_1');
    await fs.mkdir(path.join(runDir, 'tasks'), { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'tasks', 'task-1.json'),
      JSON.stringify({
        id: 'task-1',
        workspacePath: path.join(wtDir, 'preexisting'), // reused, must be skipped
        workspaceMode: 'existing',
        workspaceBranch: 'preexisting-branch',
      }),
    );

    const result = await removeRunGitIsolation({
      runDir,
      projectRoot: root,
      pruneWorktrees: true,
      pruneBranches: true,
      baseBranch: 'main',
    });

    assert.deepEqual(result.removedWorktrees, []);
    assert.deepEqual(result.removedBranches, []);
    assert.deepEqual(result.warnings, []);
    const remaining = await worktreeBranches(root);
    assert.ok(remaining.includes('preexisting-branch'), 'reused worktree must be left intact');
    assert.ok(remaining.includes('other-branch'), 'unrelated worktree must be left intact');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
