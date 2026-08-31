import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPlanArtifact, listFactoryRuns, showFactoryRun, smartRunTitle, writePrototypeSummaryArtifact } from '../packages/core/dist/index.js';

test('smartRunTitle shortens long natural prompts deterministically', () => {
  assert.equal(
    smartRunTitle('please can you add a smart status bar to the dashboard using the existing components and make sure it works on mobile'),
    'add smart status bar dashboard',
  );
});

test('smartRunTitle keeps compact prompts readable', () => {
  assert.equal(smartRunTitle('Add team invitations'), 'Add team invitations');
});

test('smartRunTitle strips command noise and file refs', () => {
  assert.equal(
    smartRunTitle('/factory please update @src/app/page.tsx --workflow=safe with a better header'),
    'update with better header',
  );
});

test('smartRunTitle falls back for empty prompts', () => {
  assert.equal(smartRunTitle(' @@@ --workflow=safe '), 'Untitled run');
});

test('summary writes title while list keeps old runs compatible', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-run-title-'));
  try {
    const runsDir = path.join(root, '.factory', 'runs');
    const newRunDir = path.join(runsDir, 'run_2');
    const oldRunDir = path.join(runsDir, 'run_1');
    await fs.mkdir(newRunDir, { recursive: true });
    await fs.mkdir(oldRunDir, { recursive: true });
    await fs.writeFile(path.join(newRunDir, 'state.json'), JSON.stringify({ status: 'COMPLETED', phase: 'complete', updatedAt: '2026-01-02T00:00:00.000Z' }), 'utf8');
    await fs.writeFile(path.join(oldRunDir, 'state.json'), JSON.stringify({ status: 'COMPLETED', phase: 'complete', updatedAt: '2026-01-01T00:00:00.000Z' }), 'utf8');
    await writePrototypeSummaryArtifact(newRunDir, {
      runId: 'run_2',
      goal: 'please add team invitations with email validation and tests',
      status: 'COMPLETED',
      phase: 'complete',
      approved: true,
      planPath: 'plan.json',
      taskPaths: [],
      verificationPath: 'verification.json',
      verificationStatus: 'passed',
    });
    await fs.writeFile(path.join(oldRunDir, 'summary.json'), JSON.stringify({ runId: 'run_1', goal: 'Old full prompt' }), 'utf8');

    const written = JSON.parse(await fs.readFile(path.join(newRunDir, 'summary.json'), 'utf8'));
    assert.equal(written.goal, 'please add team invitations with email validation and tests');
    assert.equal(written.title, 'add team invitations');

    const runs = await listFactoryRuns(runsDir);
    assert.equal(runs.find((run) => run.runId === 'run_2')?.title, 'add team invitations');
    assert.equal(runs.find((run) => run.runId === 'run_1')?.title, undefined);
    assert.equal(runs.find((run) => run.runId === 'run_1')?.goal, 'Old full prompt');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('planner task titles use compact run title while preserving full goal', () => {
  const goal = '/Users/slammtechnologies/Downloads/book-520x424.webp please publish the Beyond Breach launch article with the full press release text and supporting book page';
  const plan = buildPlanArtifact({
    goal,
    config: {
      git: { baseBranch: 'main' },
      approval: { finalMerge: 'required' },
      repair: { maxAttempts: 3 },
      resolvedWorkflow: {
        stages: [
          { name: 'plan', dependsOn: [], type: 'agent', role: 'planner' },
          { name: 'build', dependsOn: ['plan'], type: 'agent', role: 'builder' },
        ],
      },
    },
  });

  assert.equal(plan.goal, goal);
  assert.equal(plan.tasks[0].title, 'Plan work for: publish Beyond Breach launch article');
  assert.equal(plan.tasks[1].title, 'Implement changes for: publish Beyond Breach launch article');
});

test('showFactoryRun surfaces the latest task failure reason', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-task-failure-'));
  try {
    const runDir = path.join(root, 'run_1');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId: 'run_1', status: 'FAILED', phase: 'implementation-failed' }), 'utf8');
    await fs.writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ runId: 'run_1', goal: 'Publish launch article' }), 'utf8');
    await fs.writeFile(
      path.join(runDir, 'events.jsonl'),
      [
        {
          type: 'task.failed',
          data: {
            taskId: 'task-4',
            stage: 'build',
            title: 'Implement changes for: launch article',
            reason: 'Agent execution made no progress for 60s (model-timeout)',
            builderStatus: 'failed',
            builderExecutionPath: '/tmp/builder.json',
          },
        },
        {
          type: 'run.failed',
          data: {
            reason: 'VERIFICATION_PLANNER_INVALID_JSON: Verification planner returned invalid structured JSON.',
          },
        },
      ].map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8',
    );

    const shown = await showFactoryRun(root, 'run_1');
    assert.equal(shown.runFailure?.reason, 'VERIFICATION_PLANNER_INVALID_JSON: Verification planner returned invalid structured JSON.');
    assert.equal(shown.taskFailure?.taskId, 'task-4');
    assert.equal(shown.taskFailure?.reason, 'Agent execution made no progress for 60s (model-timeout)');
    assert.equal(shown.taskFailure?.builderExecutionPath, '/tmp/builder.json');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('implementation contract extracts target files from planner prose sections', () => {
  const planText = [
    '### 1. PLANNING DECISIONS',
    'Some narrative here.',
    '',
    '**New files Builder must create:**',
    '- `src/data/books/beyond-breach.json` - canonical content source',
    '- `src/app/books/beyond-breach/page.tsx` - standalone landing page',
    '',
    '**Existing files Builder must modify:**',
    '- `src/app/sitemap.ts` - add /books routes',
    '',
    'WAITING_FOR_APPROVAL',
  ].join('\n');
  const plan = buildPlanArtifact({
    goal: 'Publish the Beyond Breach book page',
    config: {
      git: { baseBranch: 'main' },
      approval: { finalMerge: 'required' },
      repair: { maxAttempts: 3 },
      resolvedWorkflow: {
        stages: [
          { name: 'plan', dependsOn: [], type: 'agent', role: 'planner' },
          { name: 'build', dependsOn: ['plan'], type: 'agent', role: 'builder' },
        ],
      },
    },
    planText,
  });

  const targetFiles = plan.implementationContract?.targetFiles ?? [];
  assert.ok(targetFiles.includes('src/data/books/beyond-breach.json'), 'new files extracted');
  assert.ok(targetFiles.includes('src/app/books/beyond-breach/page.tsx'), 'landing page extracted');
  assert.ok(targetFiles.includes('src/app/sitemap.ts'), 'modified files extracted');
});

test('build tasks receive planner contract target files as file hints', () => {
  const planText = [
    '**New files Builder must create:**',
    '- `src/data/books/beyond-breach.json` - canonical content source',
    '- `src/app/books/page.tsx` - series index',
    '',
    'WAITING_FOR_APPROVAL',
  ].join('\n');
  const plan = buildPlanArtifact({
    goal: 'Publish the Beyond Breach book page',
    config: {
      git: { baseBranch: 'main' },
      approval: { finalMerge: 'required' },
      repair: { maxAttempts: 3 },
      resolvedWorkflow: {
        stages: [
          { name: 'plan', dependsOn: [], type: 'agent', role: 'planner' },
          { name: 'build', dependsOn: ['plan'], type: 'agent', role: 'builder' },
        ],
      },
    },
    planText,
  });
  const buildTask = plan.tasks.find((t) => t.stage === 'build' || t.role === 'builder');
  assert.ok(buildTask, 'build task exists');
  const hints = buildTask.context?.fileHints ?? [];
  assert.ok(hints.includes('src/data/books/beyond-breach.json'), 'target files reach builder context');
  assert.ok(hints.includes('src/app/books/page.tsx'), 'series index reaches builder context');
});
