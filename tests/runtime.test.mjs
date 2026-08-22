import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeFactoryProject, readLatestFactoryRunPlan, runRuntimeHarness } from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-runtime-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
    await initGitRepo(root);
    await initializeFactoryProject({ cwd: root, force: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: node -e ""',
        '  typecheck: node -e ""',
        '  test: node -e ""',
        '  build: node -e ""',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: false',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function initGitRepo(root) {
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
}

function makeExecutor(label, calls) {
  return {
    async execute(input) {
      calls.push({ label, executionId: input.executionId, prompt: input.prompt });
      return {
        executionId: input.executionId,
        status: 'completed',
        outputText: `${label} completed`,
        events: [],
      };
    },
    async cancel() {},
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('plan approval rejection stops the run before implementation', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    let finalApprovalCalled = false;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => false,
      requestApproval: async () => {
        finalApprovalCalled = true;
        return true;
      },
    });

    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'CANCELLED');
    assert.equal(summary.phase, 'plan-approval-rejected');
    assert.equal(result.builderExecutionPaths?.length ?? 0, 0);
    assert.equal(finalApprovalCalled, false);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 1);
    assert.equal(calls.filter((call) => call.label === 'builder').length, 0);
  });
});

test('latest run plan summary can be read after a successful run', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => true,
      requestApproval: async () => true,
    });

    const plan = await readLatestFactoryRunPlan(path.join(root, '.factory', 'runs'));
    assert.equal(plan.goal, 'Add a demo feature');
    assert.ok(plan.planPath?.endsWith('plan.json'));
    assert.ok((plan.tasks?.length ?? 0) > 0);
    assert.match(plan.summary ?? '', /Goal: Add a demo feature/);
  });
});

test('final approval still happens after plan approval and implementation', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);

    let planApprovalCalled = 0;
    let finalApprovalCalled = 0;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => {
        planApprovalCalled += 1;
        return true;
      },
      requestApproval: async () => {
        finalApprovalCalled += 1;
        return false;
      },
    });

    const summary = await readJson(result.summaryPath);
    assert.equal(planApprovalCalled, 1);
    assert.equal(finalApprovalCalled, 1);
    assert.ok((result.builderExecutionPaths?.length ?? 0) > 0);
    assert.equal(summary.status, 'CANCELLED');
    assert.equal(summary.phase, 'approval-rejected');
    assert.equal(calls.filter((call) => call.label === 'reviewer').length, 1);
  });
});
