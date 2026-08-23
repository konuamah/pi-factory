import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createDashboardServer } from '../packages/adapters/web/dist/index.js';
import {
  queryStatus,
  queryRuns,
  queryRun,
  queryRunLogs,
  queryRepository,
} from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-dash-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'T'], { cwd: root });
  await execFile('git', ['add', '-A'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('queryStatus returns readiness, runs, and needs-attention', async () => {
  await withRepo(async (root) => {
    const status = await queryStatus(root);
    assert.equal(status.readiness, 'READY_WITH_WARNINGS'); // no factory files
    assert.ok(Array.isArray(status.recentRuns));
    assert.equal(status.constitution.totalAreas, 120);
  });
});

test('queryRuns and queryRunLogs work on a run', async () => {
  await withRepo(async (root) => {
    const runsDir = path.join(root, '.factory', 'runs');
    const runId = `run_${Date.now()}_test`;
    const runDir = path.join(runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId, status: 'RUNNING', phase: 'verification' }), 'utf8');
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ runId, goal: 'Add pagination', status: 'RUNNING' }), 'utf8');
    await fs.writeFile(path.join(runDir, 'events.jsonl'), [
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'run.created', data: { runId } }),
      JSON.stringify({ timestamp: new Date().toISOString(), type: 'verification.completed', data: { overallStatus: 'failed' } }),
    ].join('\n'), 'utf8');

    const runs = await queryRuns(root);
    assert.ok(runs.some((run) => run.runId === runId));
    const detail = await queryRun(root, runId);
    assert.equal(detail.status, 'RUNNING');
    assert.equal(detail.goal, 'Add pagination');
    const logs = await queryRunLogs(root, runId);
    assert.equal(logs.length, 2);
    assert.equal(logs[0].source, 'SYSTEM');
    assert.ok(logs.some((log) => log.level === 'ERROR'));
  });
});

test('server serves read-only GET endpoints', async () => {
  await withRepo(async (root) => {
    const server = await createDashboardServer({ cwd: root });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);

      const status = await fetch(`${base}/api/status`);
      assert.equal(status.status, 200);
      assert.ok((await status.json()).readiness);

      const runs = await fetch(`${base}/api/runs`);
      assert.equal(runs.status, 200);
      assert.ok(Array.isArray(await runs.json()));

      const repository = await fetch(`${base}/api/repository`);
      assert.equal(repository.status, 200);

      const skills = await fetch(`${base}/api/skills`);
      assert.equal(skills.status, 200);
      assert.ok(Array.isArray(await skills.json()));

      const capabilities = await fetch(`${base}/api/capabilities`);
      assert.equal(capabilities.status, 200);
      assert.ok(Array.isArray(await capabilities.json()));
    } finally {
      await server.close();
    }
  });
});

test('server rejects state-changing methods (read-only guarantee)', async () => {
  await withRepo(async (root) => {
    const server = await createDashboardServer({ cwd: root });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}/api/status`, { method });
        assert.equal(res.status, 405, `${method} should be rejected`);
        const body = await res.json();
        assert.match(body.error, /read-only/i);
      }
    } finally {
      await server.close();
    }
  });
});

test('queryRepository returns repository profile', async () => {
  await withRepo(async (root) => {
    const repo = await queryRepository(root);
    assert.ok(repo.gitRoot);
    assert.ok(['NEW', 'ESTABLISHED'].includes(repo.maturity));
  });
});
