import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeFactoryProject, runRuntimeHarness } from '../packages/core/dist/index.js';
import { createScriptedDecisionHandler, loadScriptedDecisionAnswers, parseScriptedDecisionAnswers } from '../packages/executors/pi/dist/headless.js';
import { writeRoleModelsConfig } from '../packages/executors/pi/dist/runtime-harness.js';

const execFile = promisify(execFileCb);

test('parseScriptedDecisionAnswers rejects malformed files loudly', () => {
  assert.throws(() => parseScriptedDecisionAnswers('nope'), /not valid JSON/);
  assert.throws(() => parseScriptedDecisionAnswers('[]'), /must be a JSON object/);
  assert.throws(() => parseScriptedDecisionAnswers('{"a": 1}'), /must be a non-empty answer string/);
  assert.throws(() => parseScriptedDecisionAnswers('{"a": "  "}'), /must be a non-empty answer string/);
  assert.deepEqual(parseScriptedDecisionAnswers('{"INTERVIEW":"yes"}'), { INTERVIEW: 'yes' });
});

test('createScriptedDecisionHandler matches by title, source, or wildcard and refuses gaps', async () => {
  const request = {
    id: 'req-1',
    title: 'Interview: grill',
    question: 'Q1: Which search?',
    options: [{ id: 'answered', label: 'Use my answer' }],
    source: 'INTERVIEW',
    reason: 'USER_PREFERENCE',
  };

  const byTitle = createScriptedDecisionHandler({ 'title:Interview: grill': 'mongo text search' });
  const resolved = await byTitle(request);
  assert.equal(resolved.requestId, 'req-1');
  assert.equal(resolved.optionId, 'answered');
  assert.equal(resolved.feedback, 'mongo text search');

  const bySource = createScriptedDecisionHandler({ interview: 'wildcard-free answer' });
  assert.equal((await bySource(request)).feedback, 'wildcard-free answer');

  const byWildcard = createScriptedDecisionHandler({ '*': 'fallback answer' });
  assert.equal((await byWildcard(request)).feedback, 'fallback answer');

  await assert.rejects(
    () => createScriptedDecisionHandler({ 'something-else': 'x' })(request),
    /no entry for decision "Interview: grill"/,
  );
});

test('writeRoleModelsConfig injects models for every role and replaces stale blocks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-models-'));
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory', 'config.yaml'),
      ['project:', '  baseBranch: main', 'models:', '  planner:', '    provider: stale', '    model: old'].join('\n') + '\n',
      'utf8',
    );

    await writeRoleModelsConfig(root, 'openai-codex', 'gpt-5.4-mini');
    const text = await fs.readFile(path.join(root, '.factory', 'config.yaml'), 'utf8');

    assert.match(text, /models:/);
    assert.doesNotMatch(text, /provider: stale/);
    for (const role of ['discovery', 'planner', 'builder', 'reviewer', 'repair', 'landing']) {
      assert.match(text, new RegExp(`${role}:\\n    provider: openai-codex\\n    model: gpt-5\\.4-mini`));
    }
    assert.match(text, /project:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeRoleModelsConfig creates .factory/config.yaml when missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-models-missing-'));
  try {
    await writeRoleModelsConfig(root, 'openai-codex', 'gpt-5.4-mini');
    const text = await fs.readFile(path.join(root, '.factory', 'config.yaml'), 'utf8');
    assert.match(text, /models:/);
    assert.match(text, /discovery:/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function withInterviewProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-headless-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await initializeFactoryProject({ cwd: root, force: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      ['project:', '  baseBranch: main', 'runtime:', '  maxParallelAgents: 1', 'git:', '  allowWorktrees: false', 'repair:', '  enabled: false', 'approval:', '  finalMerge: not-required'].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview',
        'workflows:',
        '  - id: interview',
        '    name: Interview',
        '    stages:',
        '      - name: grill',
        '        type: interview',
        '        role: planner',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '        dependsOn: [grill]',
        '      - name: build',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
      ].join('\n'),
      'utf8',
    );
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function interviewExecutor(calls) {
  return {
    async execute(input) {
      const label = input.executionId.includes('discovery')
        ? 'discovery'
        : input.metadata?.role === 'landing'
          ? 'landing'
          : input.metadata?.role === 'interview' || input.executionId.includes('grill')
            ? 'interview'
            : 'planner';
      calls.push({ label, executionId: input.executionId });
      if (label === 'interview') {
        return { executionId: input.executionId, status: 'completed', outputText: 'Q1: Which search behavior?', events: [] };
      }
      return { executionId: input.executionId, status: 'completed', outputText: label === 'discovery'
        ? JSON.stringify({ status: 'complete', files: [], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'demo surface' }], unknowns: [] })
        : `${label} done`, events: [] };
    },
    async cancel() {},
  };
}

test('headless scripted decisions drive an interview workflow to completion', async () => {
  await withInterviewProject(async (root) => {
    const calls = [];
    const executor = interviewExecutor(calls);
    const handler = createScriptedDecisionHandler({ INTERVIEW: 'MongoDB text search only.' });

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add search to the demo feature',
      plannerExecutor: executor,
      builderExecutor: {
        async execute(input) {
          calls.push({ label: 'builder', executionId: input.executionId });
          await fs.writeFile(path.join(input.cwd, 'src/index.ts'), 'export const x = 2;\n');
          return { executionId: input.executionId, status: 'completed', outputText: 'built', events: [] };
        },
        async cancel() {},
      },
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
      requestDecision: handler,
    });

    // Gate 1: the run used to die with "no requestDecision handler is configured".
    assert.ok(calls.some((call) => call.label === 'interview'));
    assert.ok(calls.some((call) => call.label === 'builder'));
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = JSON.parse(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'));
    assert.notEqual(state.status, 'DECISION_REQUIRED');
    const interviewDecisions = JSON.parse(await fs.readFile(path.join(runDir, 'interview-decisions.json'), 'utf8'));
    assert.equal(interviewDecisions.length, 1);
    assert.equal(interviewDecisions[0].stage, 'grill');
    assert.match(interviewDecisions[0].question, /Q1: Which search behavior/);
    assert.match(interviewDecisions[0].answer, /MongoDB text search only/);
    assert.ok(result.runId);
  });
});
