import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyIntegrationFailure, initializeFactoryProject, readLatestFactoryRunLogs, readLatestFactoryRunPlan, resumeLatestFactoryRun, runRuntimeHarness, showFactoryRun } from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempProject(fn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-runtime-'));
  try {
    if (options.rootPackage !== false) {
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    }
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
        outputText: label === 'planner'
          ? ['Feature Plan', '- Update the target document for clarity', '- Keep scope limited to the requested file', 'WAITING_FOR_APPROVAL'].join('\n')
          : `${label} completed`,
        events: [],
      };
    },
    async cancel() {},
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('project instruction files are injected into planner context ahead of constitution summary', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use concise release notes.\nPrefer root docs for contributor guidance.\n', 'utf8');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Always check developer-facing markdown files before editing them.\n', 'utf8');

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'reject' }),
      requestApproval: async () => true,
    });

    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /Project guidance context:/);
    assert.match(plannerPrompt, /Project instruction files:/);
    assert.match(plannerPrompt, /AGENTS\.md:/);
    assert.match(plannerPrompt, /Use concise release notes\./);
    assert.match(plannerPrompt, /CLAUDE\.md:/);
    assert.match(plannerPrompt, /Always check developer-facing markdown files/);
    assert.ok(plannerPrompt.indexOf('Project instruction files:') > plannerPrompt.indexOf('Project guidance context:'));
  });
});

test('planner, builder, and reviewer prompts include tighter scope rules', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    const builderPrompt = calls.find((call) => call.label === 'builder')?.prompt ?? '';
    const reviewerPrompt = calls.find((call) => call.label === 'reviewer')?.prompt ?? '';

    assert.match(plannerPrompt, /Selected skills:/);
    assert.match(plannerPrompt, /repo-interpretation@1\.0\.0/);
    assert.match(plannerPrompt, /architecture-planning@1\.0\.0/);
    assert.match(plannerPrompt, /Do not broaden scope beyond the requested outcome\./);
    assert.match(builderPrompt, /Selected skills:/);
    assert.match(builderPrompt, /implementation-task@1\.0\.0/);
    assert.match(builderPrompt, /Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits/);
    assert.match(reviewerPrompt, /Selected skills:/);
    assert.match(reviewerPrompt, /acceptance-review@1\.0\.0/);
    assert.match(reviewerPrompt, /Call out unrelated edits, scope creep, missing verification, and instruction drift explicitly\./);
  });
});

test('repair prompt focuses on observed failures only', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const repairExecutor = makeExecutor('repair', calls);

    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: node -e "process.exit(1)"',
        '  typecheck: node -e ""',
        '  test: node -e ""',
        '  build: node -e ""',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: false',
        'repair:',
        '  enabled: true',
        '  maxAttempts: 1',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      repairExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const repairPrompt = calls.find((call) => call.label === 'repair')?.prompt ?? '';
    assert.match(repairPrompt, /Selected skills:/);
    assert.match(repairPrompt, /repair-triage@1\.0\.0/);
    assert.match(repairPrompt, /Focus only on the observed failures and avoid unrelated edits\./);
    assert.match(repairPrompt, /Verification cwd:/);
  });
});

test('verification planner can choose only repo-authoritative commands from package script evidence', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'tmp', type: 'module', scripts: { lint: 'node -e ""', build: 'node -e ""' } }, null, 2),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const verificationPlannerExecutor = {
      async execute(input) {
        calls.push({ label: 'verification-planner', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            cwd: root,
            commands: {
              lint: 'node -e ""',
              build: 'node -e ""',
            },
            rationale: 'Only lint and build exist as package scripts.',
          }),
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      verificationPlannerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    assert.deepEqual(verification.commands.map((item) => item.name), ['lint', 'build']);
    assert.equal(verification.skill?.id, 'verification-planning');
    assert.match(String(verification.skill?.version ?? ''), /^1\./);
    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(logs.verificationContext?.cwd, root);
  });
});

test('verification infers a single nested package root when the worktree root has no package.json', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'landoptima-web', type: 'module' }, null, 2), 'utf8');
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  build: node -e "require(\'node:fs\').writeFileSync(\'verify-marker.txt\', process.cwd())"',
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

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    assert.equal(verification.cwd, appDir);
    assert.equal(verification.cwdResolution, 'inferred-single-package');
    const marker = await fs.readFile(path.join(appDir, 'verify-marker.txt'), 'utf8');
    assert.equal(marker, appDir);
    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(logs.verificationContext?.cwd, appDir);
    assert.equal(logs.verificationContext?.cwdResolution, 'inferred-single-package');
  }, { rootPackage: false });
});

test('verification artifacts persist reasoning, classification, and repo learnings', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: npm run lint',
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
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'tmp', type: 'module', scripts: {} }, null, 2),
      'utf8',
    );

    const plannerExecutor = makeExecutor('planner', []);
    const builderExecutor = makeExecutor('builder', []);
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    assert.equal(verification.selectionSource, 'deterministic');
    assert.ok(Array.isArray(verification.evidence?.candidateCwds));
    assert.ok(Array.isArray(verification.evidence?.commandDecisions));
    assert.equal(verification.failureClassification?.kind, 'repo script/config');
    assert.match(verification.failureClassification?.reason ?? '', /could not be executed|Verification command/i);

    const learningsPath = path.join(root, '.factory', 'learnings.jsonl');
    const learningsRaw = await fs.readFile(learningsPath, 'utf8');
    assert.match(learningsRaw, /verification-plan/);
    assert.match(learningsRaw, /verification-failure/);

    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(logs.verificationContext?.failureKind, 'repo script/config');

    const shown = await showFactoryRun(path.join(root, '.factory', 'runs'), String(logs.state?.runId));
    assert.equal(shown.verificationContext?.failureKind, 'repo script/config');
  });
});

test('resume re-plans verification after config-classified verification failures', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: npm run lint',
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
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'tmp', type: 'module', scripts: {} }, null, 2),
      'utf8',
    );

    const plannerExecutor = makeExecutor('planner', []);
    const builderExecutor = makeExecutor('builder', []);
    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const resumed = await resumeLatestFactoryRun(path.join(root, '.factory', 'runs'));
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.recovery?.suggestedPhase, 'verification-planning');
    assert.match(resumed.recovery?.policyReason ?? '', /re-planning verification/i);
  });
});

test('transient worktree guidance files are ignored during instruction selection', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root guidance only.\n', 'utf8');
    await fs.mkdir(path.join(root, '.worktrees', 'old-run'), { recursive: true });
    await fs.writeFile(path.join(root, '.worktrees', 'old-run', 'AGENTS.md'), 'Stale worktree guidance.\n', 'utf8');

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Update docs',
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'reject' }),
      requestApproval: async () => true,
    });

    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /AGENTS\.md:/);
    assert.match(plannerPrompt, /Root guidance only\./);
    assert.doesNotMatch(plannerPrompt, /Stale worktree guidance\./);
    assert.doesNotMatch(plannerPrompt, /\.worktrees\/old-run\/AGENTS\.md/);
  });
});

test('path-relevant subtree instruction files are preferred over root-only guidance', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Root guidance only.\n', 'utf8');
    await fs.mkdir(path.join(root, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(root, 'frontend', 'AGENTS.md'), 'Frontend local guidance.\n', 'utf8');

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Update frontend docs',
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'reject' }),
      requestApproval: async () => true,
    });

    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /frontend\/AGENTS\.md:/);
    assert.match(plannerPrompt, /Frontend local guidance\./);
  });
});

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
      requestPlanApproval: async () => ({ decision: 'reject', feedback: 'not aligned' }),
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

test('verification stages are not executed as builder task branches', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    assert.equal(calls.filter((call) => call.label === 'builder').length, 1);
    assert.ok((result.builderExecutionPaths?.length ?? 0) === 1);
  });
});

test('integration failure classifier surfaces conflicting files clearly', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'README.md'), 'base\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: root });
    await execFile('git', ['commit', '-m', 'add readme'], { cwd: root });

    await execFile('git', ['checkout', '-b', 'branch-a'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'branch-a\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: root });
    await execFile('git', ['commit', '-m', 'branch a'], { cwd: root });

    await execFile('git', ['checkout', 'main'], { cwd: root });
    await execFile('git', ['checkout', '-b', 'branch-b'], { cwd: root });
    await fs.writeFile(path.join(root, 'README.md'), 'branch-b\n', 'utf8');
    await execFile('git', ['add', 'README.md'], { cwd: root });
    await execFile('git', ['commit', '-m', 'branch b'], { cwd: root });

    await execFile('git', ['checkout', 'main'], { cwd: root });
    await execFile('git', ['merge', '--no-ff', '--no-edit', 'branch-a'], { cwd: root });

    let mergeError;
    try {
      await execFile('git', ['merge', '--no-ff', '--no-edit', 'branch-b'], { cwd: root });
    } catch (error) {
      mergeError = error;
    }

    assert.ok(mergeError);
    const classified = await classifyIntegrationFailure(root, mergeError);
    assert.equal(classified.mergeInProgress, true);
    assert.ok(classified.conflictingFiles.includes('README.md'));
    assert.match(classified.reason, /git merge/i);
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
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plan = await readLatestFactoryRunPlan(path.join(root, '.factory', 'runs'));
    assert.equal(plan.goal, 'Add a demo feature');
    assert.ok(plan.planPath?.endsWith('plan.json'));
    assert.ok((plan.tasks?.length ?? 0) > 0);
    assert.match(plan.summary ?? '', /Goal: Add a demo feature/);
    assert.match(plan.planText ?? '', /Update the target document for clarity/);
  });
});

test('requesting plan revisions pauses before implementation', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'revise', feedback: 'narrow the scope' }),
      requestApproval: async () => true,
    });

    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'PENDING');
    assert.equal(summary.phase, 'plan-revision-requested');
    assert.equal(result.builderExecutionPaths?.length ?? 0, 0);
    assert.equal(calls.filter((call) => call.label === 'builder').length, 0);
  });
});

test('resume keeps plan revision runs paused before implementation', async () => {
  await withTempProject(async (root) => {
    const plannerExecutor = makeExecutor('planner', []);
    const builderExecutor = makeExecutor('builder', []);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'revise', feedback: 'narrow the scope' }),
      requestApproval: async () => true,
    });

    const resumed = await resumeLatestFactoryRun(path.join(root, '.factory', 'runs'));
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.state?.status, 'PENDING');
    assert.equal(resumed.state?.phase, 'plan-revision-requested');
    assert.equal(resumed.recovery?.suggestedPhase, 'plan-revision-requested');
    assert.equal(resumed.recovery?.nextStatus, 'PENDING');
  });
});

test('resume does not reopen plan approval rejection runs', async () => {
  await withTempProject(async (root) => {
    const plannerExecutor = makeExecutor('planner', []);
    const builderExecutor = makeExecutor('builder', []);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'reject', feedback: 'not aligned' }),
      requestApproval: async () => true,
    });

    const resumed = await resumeLatestFactoryRun(path.join(root, '.factory', 'runs'));
    assert.equal(resumed.resumed, false);
    assert.equal(resumed.recovery?.resumable, false);
    assert.match(resumed.reason, /rejected during plan approval/i);
  });
});

test('logs and show surface plan feedback clearly', async () => {
  await withTempProject(async (root) => {
    const plannerExecutor = makeExecutor('planner', []);
    const builderExecutor = makeExecutor('builder', []);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'revise', feedback: 'narrow the scope' }),
      requestApproval: async () => true,
    });

    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(logs.planDecision, 'revise');
    assert.equal(logs.planFeedback, 'narrow the scope');
    assert.equal(logs.implementationStarted, false);
    assert.ok(logs.events.some((line) => /plan revision requested/i.test(line)));
    assert.ok(logs.events.some((line) => /narrow the scope/i.test(line)));
    assert.ok(logs.events.some((line) => /guidance selected/i.test(line)));
    assert.ok(Array.isArray(logs.guidance?.plannerInstructionFiles));
    assert.ok(Array.isArray(logs.guidance?.plannerInstructionDetails));
    assert.ok((logs.guidance?.plannerGuidanceChars ?? 0) >= 0);

    const runId = String(logs.state?.runId);
    const shown = await showFactoryRun(path.join(root, '.factory', 'runs'), runId);
    assert.equal(shown.planDecision, 'revise');
    assert.equal(shown.planFeedback, 'narrow the scope');
    assert.equal(shown.implementationStarted, false);
    assert.ok(Array.isArray(shown.guidance?.plannerInstructionFiles));
    assert.ok(Array.isArray(shown.guidance?.plannerInstructionDetails));
    assert.ok((shown.guidance?.plannerGuidanceChars ?? 0) >= 0);
  });
});

test('custom workflow with nested stages and command nodes runs in dependency order', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: custom',
        'workflows:',
        '  - id: custom',
        '    name: Custom Workflow',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: tests',
        '        type: command',
        '        commands: [node -e ""]',
        '        dependsOn: [implementation]',
        '      - name: docs',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [implementation]',
        '      - name: final review',
        '        type: approval',
        '        dependsOn: [tests, docs]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add team invitations',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plan = await readLatestFactoryRunPlan(path.join(root, '.factory', 'runs'));
    const stages = plan.workflowStages ?? [];
    const stageNames = stages.map((stage) => stage.name);
    assert.deepEqual(stageNames, ['plan', 'implementation', 'tests', 'docs', 'final review']);

    const events = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'), { limit: 80 });
    assert.ok(events.events.some((line) => /task.command_started/.test(line)));
    assert.ok(events.events.some((line) => /task.command_completed/.test(line)));
    assert.ok(events.events.some((line) => /plan approved/.test(line)));
  });
});

test('contract verification runs and emits results after command verification', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'), { limit: 80 });
    assert.ok(logs.events.some((line) => /verification.contract_completed/.test(line)));
    assert.ok(logs.events.some((line) => /verification.completed/.test(line)));
  });
});

test('contract completion gate blocks the run when a blocking requirement fails', async () => {
  // A security-change task type with a reviewer executor that reports a blocking finding
  // should leave the run BLOCKED instead of COMPLETED.
  const failingReviewer = {
    async execute() {
      return { executionId: 'reviewer', status: 'completed', outputText: 'FINDING HIGH: Schema change breaks old clients', events: [] };
    },
    async cancel() {},
  };

  await withTempProject(async (root) => {
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
        'taskTypes:',
        '  security-change:',
        '    match:',
        '      keywords: [security, auth, permission]',
        '    routing:',
        '      builder: { model: opus }',
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

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add security for login',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor: failingReviewer,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'BLOCKED');
    assert.equal(summary.phase, 'verification-blocked');
  });
});

test('verification artifact holds contract plan, results, and evidence', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    assert.ok(verification.contract);
    assert.ok(Array.isArray(verification.contract.plan.requirements));
    assert.ok(verification.contract.plan.requirements.length > 0);
    assert.ok(Array.isArray(verification.contract.results));
    assert.equal(verification.contract.overallStatus, 'PASS');
    assert.equal(verification.contract.canComplete, true);
  });
});

test('workflow node roles select the correct executor and context role', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: custom',
        'workflows:',
        '  - id: custom',
        '    name: Custom Workflow',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: security review',
        '        type: agent',
        '        role: reviewer',
        '        dependsOn: [implementation]',
        '      - name: final review',
        '        type: approval',
        '        dependsOn: [security review]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add team invitations',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const securityReviewCalls = calls.filter((call) => call.label === 'reviewer' && /security review/.test(call.prompt));
    assert.equal(securityReviewCalls.length, 1);
    assert.match(securityReviewCalls[0].prompt, /Role rules:/);
    assert.match(securityReviewCalls[0].prompt, /acceptance, consistency, risk, and scope control/);
    assert.match(securityReviewCalls[0].prompt, /Task id: task-3/);
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
        return { decision: 'approve' };
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
