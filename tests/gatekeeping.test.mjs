import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runRuntimeHarness, mergeConfigLayers } from '../packages/core/dist/index.js';
import { builtInDefaults } from '../packages/core/dist/config/defaults.js';

const execFile = promisify(execFileCb);

async function withTempProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-gate-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:', '  baseBranch: main',
      'commands:', '  lint: node -e ""', '  test: node -e ""',
      'runtime:', '  limits:', '    runTimeoutMs: 120000',
      'git:', '  allowWorktrees: false',
      'repair:', '  enabled: false',
      'approval:', '  finalMerge: required',
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
        outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'Entry point' }], unknowns: [] }),
        events: [],
      };
    },
    async cancel() {},
  };
}

async function runWithoutHandlers(cwd, goal) {
  const { runFactoryController } = await import('../packages/core/dist/runtime/controller.js');
  const executor = {
    async execute(input) {
      if (input.metadata?.role === 'discovery') return discoveryOk().execute(input);
      if (input.metadata?.role === 'planner') {
        return { executionId: 'p', status: 'completed', outputText: 'Feature Plan\n- Do the thing\nWAITING_FOR_APPROVAL', events: [] };
      }
      return { executionId: input.executionId, status: 'completed', outputText: 'done', events: [] };
    },
    async cancel() {},
  };
  return runFactoryController({
    cwd, goal,
    discoveryExecutor: executor,
    plannerExecutor: executor,
    builderExecutor: executor,
    reviewerExecutor: executor,
  });
}

test('missing plan-approval handler fails loud (no silent approve)', async () => {
  await withTempProject(async (root) => {
    const result = await runWithoutHandlers(root, 'Add a feature');
    // A run record + FAILED state exist, and the run did NOT auto-approve.
    assert.ok(result.runDir, 'expected a run dir');
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'plan-approval-unavailable');
    const events = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === 'run.failed'), 'expected run.failed event');
  });
});

test('missing planner executor fails loud instead of silent empty plan', async () => {
  await withTempProject(async (root) => {
    const { runFactoryController } = await import('../packages/core/dist/runtime/controller.js');
    // discovery executor works, but NO planner executor.
    await assert.rejects(
      () => runFactoryController({
        cwd: root, goal: 'Add a feature',
        discoveryExecutor: discoveryOk(),
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Planning failed: no planner executor/i,
    );
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'planning-failed');
  });
});

test('plan revise replans (bounded) and pauses after the limit', async () => {
  await withTempProject(async (root) => {
    let plannerCalls = 0;
    const executor = {
      async execute(input) {
        if (input.metadata?.role === 'discovery') return discoveryOk().execute(input);
        if (input.metadata?.role === 'planner') {
          plannerCalls += 1;
          return { executionId: 'p', status: 'completed', outputText: 'Feature Plan\n- Do the thing\nWAITING_FOR_APPROVAL', events: [] };
        }
        return { executionId: input.executionId, status: 'completed', outputText: 'done', events: [] };
      },
      async cancel() {},
    };
    // Always revise -> replan loop hits the bound (2 replans) then pauses.
    await runRuntimeHarness({
      cwd: root, goal: 'Add a feature',
      plannerExecutor: executor,
      requestPlanApproval: async () => ({ decision: 'revise', feedback: 'narrow it' }),
      requestApproval: async () => true,
    });
    // Initial plan + 2 replans = 3 planner calls.
    assert.ok(plannerCalls >= 3, `expected >=3 planner calls (initial + replans), got ${plannerCalls}`);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'));
    assert.equal(state.status, 'PENDING');
    assert.equal(state.phase, 'plan-revision-requested');
  });
});

test('git.cleanup.preserveFailedRuns config flag merges with default false', () => {
  const config = mergeConfigLayers({ builtIns: builtInDefaults });
  assert.equal(config.git.cleanup.preserveFailedRuns, false);
  const enabled = mergeConfigLayers({
    builtIns: builtInDefaults,
    project: { git: { cleanup: { preserveFailedRuns: true } } },
  });
  assert.equal(enabled.git.cleanup.preserveFailedRuns, true);
});
