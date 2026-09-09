import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyIntegrationFailure, classifyVerificationFailure, initializeFactoryProject, planVerificationExecution, readLatestFactoryRunLogs, readLatestFactoryRunPlan, resumeLatestFactoryRun, runRuntimeHarness, runVerificationCommands, showFactoryRun } from '../packages/core/dist/index.js';

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
      const actualLabel = input.executionId.includes('discovery')
        ? 'discovery'
        : input.metadata?.role === 'landing'
          ? 'landing'
          : label;
      calls.push({ label: actualLabel, executionId: input.executionId, prompt: input.prompt, limits: input.limits, tools: input.tools, metadata: input.metadata });
      if (actualLabel === 'builder') {
        await fs.writeFile(path.join(input.cwd, 'factory-builder-output.txt'), `${input.executionId}\n`, 'utf8');
      }
      return {
        executionId: input.executionId,
        status: 'completed',
        outputText: actualLabel === 'discovery'
          ? JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [
                { status: 'confirmed', file: 'src/index.ts', finding: 'src/index.ts exists and is the demo implementation surface.' },
              ],
              unknowns: [],
            }, null, 2)
          : actualLabel === 'planner'
          ? ['Feature Plan', '- Update the target document for clarity', '- Keep scope limited to the requested file', 'WAITING_FOR_APPROVAL'].join('\n')
          : actualLabel === 'landing'
          ? JSON.stringify({
              strategy: 'cherry-pick',
              targetBranch: 'main',
              reasoning: ['Land the isolated candidate commit after review.'],
              verification: ['lint', 'typecheck', 'test', 'build'],
              risk: 'low',
              expectedFiles: ['factory-builder-output.txt'],
            })
          : `${actualLabel} completed`,
        events: [],
      };
    },
    async cancel() {},
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeProjectSkill(root, id, body, metadataLines = []) {
  const dir = path.join(root, '.pi', 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${id}`,
      `description: ${id} test skill.`,
      ...metadataLines,
      '---',
      '',
      body,
    ].join('\n'),
    'utf8',
  );
}

test('a single run deadline is shared across discovery and planner executor calls', async () => {
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
        'runtime:',
        '  limits:',
        '    runTimeoutMs: 120000',
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
    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const discoveryCall = calls.find((call) => call.label === 'discovery');
    const plannerCall = calls.find((call) => call.label === 'planner');
    assert.ok(discoveryCall?.limits?.runDeadlineAt, 'discovery gets a run deadline');
    assert.ok(plannerCall?.limits?.runDeadlineAt, 'planner gets a run deadline');
    assert.equal(discoveryCall.limits.runDeadlineAt, plannerCall.limits.runDeadlineAt);
    assert.ok(discoveryCall.limits.runDeadlineAt > Date.now());
  });
});

test('project instruction files are injected into planner context ahead of constitution summary', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use concise release notes.\nPrefer root docs for contributor guidance.\n', 'utf8');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), 'Always check developer-facing markdown files before editing them.\n', 'utf8');

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);

    const result = await runRuntimeHarness({
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
    const reviewerExecutor = makeExecutor('reviewer', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/helper.ts'), 'export const helper = 2;\n', 'utf8');
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), "import { helper } from './helper';\nexport const x = helper;\n", 'utf8');
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'builder completed',
          events: [],
        };
      },
      async cancel() {},
    };
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    const discoveryPrompt = calls.find((call) => call.label === 'discovery')?.prompt ?? '';
    assert.match(discoveryPrompt, /Role: Discovery/);
    assert.match(discoveryPrompt, /You are in Discovery only/);
    assert.match(discoveryPrompt, /Do not:\n- implement anything\n- modify files\n- write code\n- create an implementation plan/);
    assert.match(discoveryPrompt, /Return JSON only/);
    assert.match(discoveryPrompt, /"status": "complete"/);
    assert.match(discoveryPrompt, /implementationSurface/);
    assert.match(discoveryPrompt, /If no existing implementation file exists/);
    assert.doesNotMatch(discoveryPrompt, /DISCOVERY_FAILED/);
    assert.match(discoveryPrompt, /Repository evidence packet \(authoritative\):/);
    assert.match(discoveryPrompt, /candidate_files:/);
    assert.match(discoveryPrompt, /observed_files:/);
    assert.match(discoveryPrompt, /observed_files:\n(?:- [^\n]+\n)*- \.factory\/config\.yaml/);
    const builderPrompt = calls.find((call) => call.label === 'builder')?.prompt ?? '';
    const reviewerPrompt = calls.find((call) => call.label === 'reviewer')?.prompt ?? '';

    assert.ok(calls.findIndex((call) => call.label === 'discovery') < calls.findIndex((call) => call.label === 'planner'));
    assert.match(plannerPrompt, /Selected skills:/);
    assert.match(plannerPrompt, /repo-interpretation@1\.0\.0/);
    assert.match(plannerPrompt, /architecture-planning@1\.0\.0/);
    assert.match(plannerPrompt, /Validated Discovery result \(authoritative pre-planning evidence\):/);
    assert.match(plannerPrompt, /src\/index\.ts/);
    assert.match(plannerPrompt, /precise execution contract for the Builder/);
    assert.match(plannerPrompt, /Builder should not need to reconstruct the plan/);
    assert.match(plannerPrompt, /Do not perform broad repository discovery here/);
    assert.match(plannerPrompt, /Do not ask Builder to broadly find, locate, search for, or identify implementation files/);
    assert.match(plannerPrompt, /PLANNING DECISIONS/);
    assert.match(plannerPrompt, /IMPLEMENTATION SEQUENCE/);
    assert.match(plannerPrompt, /VERIFICATION CONTRACT/);
    assert.match(plannerPrompt, /RISKS AND BLOCKERS/);
    assert.match(plannerPrompt, /Name the confirmed files, components, data sources, commands, or config surfaces/);
    assert.match(plannerPrompt, /For each step, include: affected file\(s\), exact action, negative path\/edge case to preserve, and verification signal/);
    assert.match(plannerPrompt, /Do not make the first step a broad search/);
    assert.match(plannerPrompt, /Do not broaden scope beyond the requested outcome\./);
    assert.match(builderPrompt, /Selected skills:/);
    assert.match(builderPrompt, /implementation-task@1\.0\.0/);
    assert.match(builderPrompt, /Likely files: src\/index\.ts/);
    assert.match(builderPrompt, /Treat the Planner handoff as the authoritative implementation contract/);
    assert.match(builderPrompt, /Use the native Pi tools provided to you; do not print DSML\/XML\/tool-call markup as text/);
    assert.match(builderPrompt, /Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits/);
    assert.match(builderPrompt, /The workspace is already prepared/);
    assert.match(builderPrompt, /CONTRACT_BLOCKED/);
    assert.match(builderPrompt, /Edit from the contract: read only the handoff-named target files/);
    assert.doesNotMatch(builderPrompt, /prepare the repository environment yourself/);
    assert.match(plannerPrompt, /Each step names exact target file\(s\) to read and\/or edit/);
    assert.match(plannerPrompt, /Stop discovery after/);
    assert.match(plannerPrompt, /Do not write steps like 'inspect exports\/imports before editing'/);
    assert.doesNotMatch(plannerPrompt, /A narrow read\/inspection step is allowed only for concrete files/);
    assert.match(reviewerPrompt, /Selected skills:/);
    assert.match(reviewerPrompt, /acceptance-review@1\.0\.0/);
    assert.match(reviewerPrompt, /Call out unrelated edits, scope creep, missing verification, and instruction drift explicitly\./);
    assert.match(reviewerPrompt, /Review surface \(authoritative\):/);
    assert.match(reviewerPrompt, /Changed files:/);
    assert.match(reviewerPrompt, /src\/helper\.ts/);
    assert.match(reviewerPrompt, /Only read files listed above or their direct imports\. Do not search or scan the repository\./);
    assert.deepEqual(calls.find((call) => call.label === 'reviewer')?.tools, ['read']);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const plan = await readJson(path.join(runDir, 'plan.json'));
    const buildTask = plan.tasks.find((task) => task.stage === 'build');
    assert.deepEqual(buildTask.context.fileHints, ['src/index.ts']);
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const contextEvent = eventsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'task.context_compiled' && event.data.role === 'builder');
    assert.deepEqual(contextEvent.data.files, ['src/index.ts']);
  });
});

test('prompt-template wrappers are stripped from model-facing task objectives', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const wrappedGoal = [
      '# Planner Mode',
      '',
      'You are the Lead Software Architect & Planner.',
      '',
      'Your job for this task — **Improve planner prompt handoff...',
      '',
      '# Lead Software Architect & Planner',
      'Analyze the users request and existing codebase.',
      'Do **not** write or modify production code.** — is to analyze the codebase and produce a precise implementation plan.',
      '',
      '## Response Format',
      '- Understanding & Scope',
    ].join('\n');
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: wrappedGoal,
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const discoveryPrompt = calls.find((call) => call.label === 'discovery')?.prompt ?? '';
    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    const builderPrompt = calls.find((call) => call.label === 'builder')?.prompt ?? '';
    assert.match(discoveryPrompt, /User task: Improve planner prompt handoff/);
    assert.match(plannerPrompt, /Task: Improve planner prompt handoff/);
    assert.match(builderPrompt, /Goal: Improve planner prompt handoff/);
    for (const prompt of [discoveryPrompt, plannerPrompt, builderPrompt]) {
      assert.doesNotMatch(prompt, /Do \*\*not\*\* write or modify production code/);
      assert.doesNotMatch(prompt, /Response Format/);
    }
    const summary = await readJson(path.join(result.runDir, 'summary.json'));
    assert.equal(summary.goal, wrappedGoal);
  });
});

test('trivial final review is deterministic and skips the reviewer executor', async () => {
  await withTempProject(async (root) => {
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), 'export const x = 2;\n', 'utf8');
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'builder completed',
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => false,
    });

    assert.equal(calls.filter((call) => call.label === 'reviewer').length, 0);
    const reviewerExecution = await readJson(path.join(result.runDir, 'reviewer-execution.json'));
    assert.equal(reviewerExecution.status, 'completed');
    assert.match(reviewerExecution.outputText, /Ready for approval\./);
    assert.match(reviewerExecution.outputText, /Deterministic review passed/);
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /review\.deterministic/);
    assert.match(eventsRaw, /"reviewerTools":\[\]/);
  });
});

test('blocking reviewer verdict reaches the approval gate and blocks silent auto-approve', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/helper.ts'), 'export const helper = 2;\n', 'utf8');
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), "import { helper } from './helper';\nexport const x = helper;\n", 'utf8');
        return { executionId: input.executionId, status: 'completed', outputText: 'builder completed', events: [] };
      },
      async cancel() {},
    };
    const reviewerExecutor = {
      async execute(input) {
        calls.push({ label: 'reviewer', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            '**Finding**',
            '- High: the consent flow no longer gates analytics loading.',
            'Not ready for approval.',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };

    let approvalInput;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      // No confirm UI: harness-level default requestApproval is used, which must
      // NOT silently approve past a blocking review verdict.
      requestApproval: async (input) => {
        approvalInput = input;
        return false;
      },
    });

    assert.equal(approvalInput.reviewerVerdict.verdict, 'block');
    assert.match(approvalInput.reviewerVerdict.summary, /Not ready for approval/);
    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'CANCELLED');
    assert.equal(summary.phase, 'approval-rejected');
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /review\.verdict/);
    assert.match(eventsRaw, /"verdict":"block"/);
  });
});

test('final approval is requested only after reviewer verdict exists', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const sequence = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), "import { helper } from './helper.js';\nexport const x = helper;\n", 'utf8');
        await fs.writeFile(path.join(input.cwd, 'src/helper.ts'), 'export const helper = 2;\n', 'utf8');
        return { executionId: input.executionId, status: 'completed', outputText: 'builder completed', events: [] };
      },
      async cancel() {},
    };
    const reviewerExecutor = {
      async execute(input) {
        sequence.push('reviewer');
        calls.push({ label: 'reviewer', executionId: input.executionId, prompt: input.prompt });
        return { executionId: input.executionId, status: 'completed', outputText: 'Ready for approval. Review passed.', events: [] };
      },
      async cancel() {},
    };

    let approvalInput;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async (input) => {
        approvalInput = input;
        sequence.push(`approval:${input.reviewerVerdict?.verdict ?? 'none'}`);
        return false;
      },
    });

    assert.deepEqual(sequence, ['reviewer', 'approval:pass']);
    assert.equal(approvalInput.reviewerVerdict.verdict, 'pass');
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.ok(eventsRaw.indexOf('"type":"review.verdict"') < eventsRaw.indexOf('"type":"approval.required"'));
  });
});

test('missing reviewer blocks final approval when deterministic review is ineligible', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), "import { helper } from './helper.js';\nexport const x = helper;\n", 'utf8');
        await fs.writeFile(path.join(input.cwd, 'src/helper.ts'), 'export const helper = 2;\n', 'utf8');
        return { executionId: input.executionId, status: 'completed', outputText: 'builder completed', events: [] };
      },
      async cancel() {},
    };

    let finalApprovalCalled = 0;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => {
        finalApprovalCalled += 1;
        return true;
      },
    });

    const summary = await readJson(result.summaryPath);
    assert.equal(finalApprovalCalled, 0);
    assert.equal(summary.status, 'FAILED');
    assert.equal(summary.phase, 'review-unavailable');
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /review\.unavailable/);
    assert.equal(eventsRaw.includes('"type":"approval.required"'), false);
  });
});

test('invalid discovery output fails loudly before planning', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt, limits: input.limits });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'I will inspect the repository now.',
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery returned invalid structured JSON/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.find((call) => call.label === 'discovery').limits.modelIdleTimeoutMs, 60_000);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = await readJson(path.join(runDir, 'state.json'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'discovery-failed');
  });
});

test('failed discovery executor reports executor error instead of empty output', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, limits: input.limits });
        return {
          executionId: input.executionId,
          status: 'failed',
          outputText: '',
          events: [],
          errorMessage: 'Agent execution timed out after 60s (model-timeout)',
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Agent execution timed out after 60s \(model-timeout\)/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.find((call) => call.label === 'discovery').limits.turnTimeoutMs, 900_000);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const event = eventsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.type === 'discovery.invalid_output');
    assert.equal(event.data.reason, 'Agent execution timed out after 60s (model-timeout)');
    assert.equal(event.data.discoveryStatus, 'failed');
  });
});

test('malformed discovery json gets one strict json repair retry', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt, tools: input.tools });
        if (input.metadata?.attempt === 'json-repair') {
          return {
            executionId: input.executionId,
            status: 'completed',
            outputText: JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [
                {
                  status: 'confirmed',
                  file: 'src/index.ts',
                  finding: 'Existing source file can host the demo feature and contains a TODO marker.',
                },
              ],
              unknowns: [],
            }),
            events: [],
          };
        }
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            'Here is the discovery result:',
            '```json',
            '{',
            '  "status": "complete",',
            '  "files": ["src/index.ts"],',
            '  "evidence": [{ "status": "confirmed", "file": "src/index.ts", "finding": "Route returns {"error"} on failure." }],',
            '  "unknowns": []',
            '}',
            '```',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      discoveryExecutor,
      plannerExecutor,
      builderExecutor: makeExecutor('builder', calls),
      reviewerExecutor: makeExecutor('reviewer', calls),
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 2);
    assert.equal(calls.find((call) => call.executionId.endsWith('json-repair')).tools.length, 0);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 1);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /discovery\.json_repair_retrying/);
  });
});

test('invalid discovery output can pause for runtime recovery and retry successfully', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    let recoveryRequests = 0;
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt, tools: input.tools, attempt: input.metadata?.attempt });
        if (input.executionId.includes('retry-2') && input.metadata?.attempt !== 'json-repair') {
          return {
            executionId: input.executionId,
            status: 'completed',
            outputText: JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'source exists' }],
              unknowns: [],
            }),
            events: [],
          };
        }
        return { executionId: input.executionId, status: 'completed', outputText: '{ bad json', events: [] };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      discoveryExecutor,
      plannerExecutor,
      builderExecutor: makeExecutor('builder', calls),
      reviewerExecutor: makeExecutor('reviewer', calls),
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
      requestDecision: async (request) => {
        recoveryRequests += 1;
        assert.equal(request.source, 'RUNTIME');
        assert.equal(request.reason, 'FAILURE_RECOVERY');
        assert.match(request.question, /Phase: discovery/);
        return { requestId: request.id, optionId: 'retry', feedback: 'try again with strict JSON', decidedAt: new Date().toISOString() };
      },
    });

    assert.equal(recoveryRequests, 1);
    assert.ok(calls.some((call) => call.executionId.includes('discovery-retry-2')));
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /run\.recovery_requested/);
    assert.match(eventsRaw, /run\.recovery_resolved/);
  });
});

test('workflow plan skills are applied to built-in planner prompt with full skill body', async () => {
  await withTempProject(async (root) => {
    await writeProjectSkill(root, 'grilling', 'Interview the user in rounds before planning.');
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview-plan',
        'workflows:',
        '  - id: interview-plan',
        '    name: Interview Plan',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          prefer: [grilling]',
        '      - name: build',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: approval',
        '        type: approval',
        '        dependsOn: [build]',
      ].join('\n'),
      'utf8',
    );

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
    assert.match(plannerPrompt, /## grilling@1\.0\.0/);
    assert.match(plannerPrompt, /Description: grilling test skill\./);
    assert.match(plannerPrompt, /Instructions:\nInterview the user in rounds before planning\./);
  });
});

test('missing required built-in planner skill fails loudly before planner execution', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: missing-plan-skill',
        'workflows:',
        '  - id: missing-plan-skill',
        '    name: Missing Plan Skill',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          require: [missing-planner-skill]',
        '      - name: build',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        plannerExecutor,
        builderExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Missing required workflow skill\(s\): missing-planner-skill/,
    );

    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = await readJson(path.join(runDir, 'state.json'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'planning-failed');
    const eventText = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventText, /task.skill_policy_failed/);
    assert.match(eventText, /missing-planner-skill/);
  });
});

test('interview workflow stage pauses before planning when no decision handler is configured', async () => {
  await withTempProject(async (root) => {
    await writeProjectSkill(root, 'grilling', 'Ask the user questions and wait for answers.');
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview',
        'workflows:',
        '  - id: interview',
        '    name: Interview',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: grill',
        '        type: interview',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          require: [grilling]',
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

    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        const actualLabel = input.executionId.includes('discovery') ? 'discovery' : input.executionId.includes('grill') ? 'interview' : 'planner';
        calls.push({ label: actualLabel, executionId: input.executionId, prompt: input.prompt });
        if (actualLabel === 'interview') {
          return { executionId: input.executionId, status: 'completed', outputText: 'Q1: Which search behavior should govern?', events: [] };
        }
        return makeExecutor('planner', calls).execute(input);
      },
      async cancel() {},
    };
    const builderExecutor = makeExecutor('builder', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        plannerExecutor,
        builderExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Decision required/,
    );

    assert.ok(calls.some((call) => call.label === 'interview'));
    assert.equal(calls.some((call) => call.label === 'planner'), false);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = await readJson(path.join(runDir, 'state.json'));
    assert.equal(state.status, 'DECISION_REQUIRED');
    assert.equal(state.phase, 'decision-interview');
    const eventText = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventText, /decision.required/);
    assert.match(eventText, /Q1: Which search behavior should govern/);
  });
});

test('interview answers are included in planner prompt after decision resolution', async () => {
  await withTempProject(async (root) => {
    await writeProjectSkill(root, 'grilling', 'Ask the user questions and wait for answers.');
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview',
        'workflows:',
        '  - id: interview',
        '    name: Interview',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: grill',
        '        type: interview',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          require: [grilling]',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '        dependsOn: [grill]',
        '      - name: build',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: approval',
        '        type: approval',
        '        dependsOn: [build]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        const actualLabel = input.executionId.includes('discovery') ? 'discovery' : input.executionId.includes('grill') ? 'interview' : 'planner';
        calls.push({ label: actualLabel, executionId: input.executionId, prompt: input.prompt });
        if (actualLabel === 'interview') {
          return { executionId: input.executionId, status: 'completed', outputText: 'Q1: Which search behavior should govern?', events: [] };
        }
        return makeExecutor('planner', calls).execute(input);
      },
      async cancel() {},
    };
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
      requestDecision: async (request) => ({
        requestId: request.id,
        optionId: 'answered',
        feedback: 'Use MongoDB text search only; do not add a new search platform.',
        decidedAt: new Date().toISOString(),
      }),
    });

    const interviewPrompt = calls.find((call) => call.label === 'interview')?.prompt ?? '';
    assert.match(interviewPrompt, /## grilling@1\.0\.0/);
    assert.match(interviewPrompt, /Instructions:\nAsk the user questions and wait for answers\./);
    assert.match(interviewPrompt, /When a question is genuinely multiple-choice, include an explicit options block/);
    assert.match(interviewPrompt, /Options:\n\[A\] <option label>/);
    assert.match(interviewPrompt, /Do not emit an 'Other' option/);
    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /Interview answers and decisions:/);
    assert.match(plannerPrompt, /Q1: Which search behavior should govern/);
    assert.match(plannerPrompt, /Use MongoDB text search only; do not add a new search platform\./);
  });
});

test('all-skipped interview reaches planner and fails clearly when planner needs clarification', async () => {
  await withTempProject(async (root) => {
    await writeProjectSkill(root, 'grilling', 'Ask the user questions and wait for answers.');
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview',
        'workflows:',
        '  - id: interview',
        '    name: Interview',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: grill',
        '        type: interview',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          require: [grilling]',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '        dependsOn: [grill]',
        '      - name: build',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: approval',
        '        type: approval',
        '        dependsOn: [build]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        const actualLabel = input.executionId.includes('discovery') ? 'discovery' : input.executionId.includes('grill') ? 'interview' : 'planner';
        calls.push({ label: actualLabel, executionId: input.executionId, prompt: input.prompt });
        if (actualLabel === 'interview') {
          return { executionId: input.executionId, status: 'completed', outputText: 'Q1: Which product behavior should Factory implement?', events: [] };
        }
        if (actualLabel === 'discovery') {
          return {
            executionId: input.executionId,
            status: 'completed',
            outputText: JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'src/index.ts exists and is the demo implementation surface.' }],
              unknowns: [],
            }),
            events: [],
          };
        }
        assert.match(input.prompt, /A1: \[skipped\]/);
        assert.match(input.prompt, /Interview answers and decisions:/);
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'INTERVIEW_SKIPPED_NEEDS_CLARIFICATION: Missing product behavior preference.',
          events: [],
        };
      },
      async cancel() {},
    };
    const builderExecutor = makeExecutor('builder', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Make the ambiguous workflow better',
        plannerExecutor,
        builderExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
        requestDecision: async (request) => ({
          requestId: request.id,
          optionId: 'answered',
          feedback: 'Q1: Which product behavior should Factory implement?\nChoice1: skipped\nA1: [skipped]',
          interviewQuestions: [{
            index: 1,
            prompt: 'Q1: Which product behavior should Factory implement?',
            finalAnswer: '',
            skipped: true,
          }],
          decidedAt: new Date().toISOString(),
        }),
      }),
      /Planning failed: Interview answers were skipped and planning needs clarification: Missing product behavior preference/,
    );

    assert.ok(calls.some((call) => call.label === 'interview'));
    assert.ok(calls.some((call) => call.label === 'planner'));
  });
});

test('discovery accepts valid structured JSON wrapped in prose and a fence', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            'I have completed the read-only discovery pass.',
            '',
            '```json',
            JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [
                {
                  status: 'confirmed',
                  file: 'src/index.ts',
                  finding: 'This file is the concrete implementation surface for the demo feature.',
                },
              ],
              unknowns: [],
            }, null, 2),
            '```',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      discoveryExecutor,
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'reject' }),
      requestApproval: async () => true,
    });

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 1);
    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /Validated Discovery result \(authoritative pre-planning evidence\):/);
    assert.match(plannerPrompt, /src\/index\.ts/);
  });
});

test('directory-only discovery fails loudly before planning', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            status: 'complete',
            files: ['src/'],
            evidence: [
              { status: 'confirmed', file: 'src/', finding: 'Courses are somewhere under src/.' },
            ],
            unknowns: ['Exact file is unknown.'],
          }),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Remove outdated upcoming course',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery listed files, but none were concrete implementation files/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
  });
});

test('missing implementation surface is passed to planning as structured discovery status', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            status: 'complete',
            implementationSurface: 'missing',
            files: [],
            evidence: [
              { status: 'unknown', finding: 'No application implementation files were found in the repository evidence.' },
            ],
            unknowns: ['The requested portfolio page needs a new implementation surface.'],
          }),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'make a portfolio page for a doctor in html js no css',
      discoveryExecutor,
      plannerExecutor,
      requestPlanApproval: async () => ({ decision: 'reject' }),
      requestApproval: async () => true,
    });

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 1);
    const plannerPrompt = calls.find((call) => call.label === 'planner')?.prompt ?? '';
    assert.match(plannerPrompt, /"implementationSurface": "missing"/);
    assert.match(plannerPrompt, /choose explicit new files for the Builder to create/);
    assert.match(plannerPrompt, /portfolio page needs a new implementation surface/);
  }, { rootPackage: false });
});

test('discovery with missing files fails loudly before planning', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            status: 'complete',
            files: ['src/components/courses/UpcomingCourses.tsx'],
            evidence: [
              {
                status: 'confirmed',
                file: 'src/components/courses/UpcomingCourses.tsx',
                finding: 'This component renders the upcoming courses list.',
              },
            ],
            unknowns: [],
          }),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Remove outdated upcoming courses',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery identified files that do not exist: src\/components\/courses\/UpcomingCourses\.tsx/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
  });
});

test('discovery with existing but unobserved files fails loudly before planning', async () => {
  await withTempProject(async (root) => {
    await fs.mkdir(path.join(root, 'vendor/pi-factory/packages/core/src'), { recursive: true });
    await fs.writeFile(path.join(root, 'vendor/pi-factory/packages/core/src/index.ts'), 'export const vendored = true;\n', 'utf8');

    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            status: 'complete',
            files: ['vendor/pi-factory/packages/core/src/index.ts'],
            evidence: [
              {
                status: 'confirmed',
                file: 'vendor/pi-factory/packages/core/src/index.ts',
                finding: 'This vendored Factory file exists but should not be part of project Discovery evidence.',
              },
            ],
            unknowns: [],
          }),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery referenced files not observed by Factory evidence: vendor\/pi-factory\/packages\/core\/src\/index\.ts/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
  });
});

test('discovery with no confirmed evidence fails loudly before planning', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: JSON.stringify({
            status: 'complete',
            files: ['src/index.ts'],
            evidence: [
              { status: 'inferred', file: 'src/index.ts', finding: 'Might be relevant.' },
            ],
            unknowns: [],
          }),
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery did not provide confirmed evidence tied to a concrete file/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
  });
});

test('magic-string discovery failure is rejected as invalid structured output', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = {
      async execute(input) {
        calls.push({ label: 'discovery', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'DISCOVERY_FAILED: Could not identify the implementation surface.',
          events: [],
        };
      },
      async cancel() {},
    };
    const plannerExecutor = makeExecutor('planner', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Add a demo feature',
        discoveryExecutor,
        plannerExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Discovery failed: Discovery returned invalid structured JSON/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 0);
  });
});

test('planner cannot delegate broad discovery to builder', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const discoveryExecutor = makeExecutor('discovery', calls);
    const plannerExecutor = {
      async execute(input) {
        calls.push({ label: 'planner', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            '1. PLANNING DECISIONS',
            '- Use the frontend.',
            '2. IMPLEMENTATION SEQUENCE',
            '- Step 1: Search for the upcoming courses and identify the relevant file.',
            '3. VERIFICATION CONTRACT',
            '- Run lint.',
            '4. RISKS AND BLOCKERS',
            '- None.',
            'WAITING_FOR_APPROVAL',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };
    const builderExecutor = makeExecutor('builder', calls);

    await assert.rejects(
      () => runRuntimeHarness({
        cwd: root,
        goal: 'Remove outdated upcoming course',
        discoveryExecutor,
        plannerExecutor,
        builderExecutor,
        requestPlanApproval: async () => ({ decision: 'approve' }),
        requestApproval: async () => true,
      }),
      /Planning failed: Planner delegated broad discovery to Builder/,
    );

    assert.equal(calls.filter((call) => call.label === 'discovery').length, 1);
    assert.equal(calls.filter((call) => call.label === 'planner').length, 1);
    assert.equal(calls.filter((call) => call.label === 'builder').length, 0);
  });
});

test('repair prompt focuses on observed failures only', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        await fs.writeFile(path.join(input.cwd, 'src/index.ts'), 'export const x = 2;\n', 'utf8');
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'builder completed',
          events: [],
        };
      },
      async cancel() {},
    };
    const repairExecutor = makeExecutor('repair', calls);

    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: npm run lint',
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
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'tmp',
        type: 'module',
        scripts: {
          lint: "node -e \"console.log(process.cwd() + '/src/index.ts'); process.exit(1)\"",
        },
      }, null, 2),
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
      JSON.stringify(
        {
          name: 'tmp',
          type: 'module',
          scripts: { 'install:all': 'node -e ""', lint: 'node -e ""', build: 'node -e ""' },
        },
        null,
        2,
      ),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  setup: npm run install:all',
        '  lint: node -e ""',
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
              setup: 'npm run install:all',
              lint: 'node -e ""',
              build: 'node -e ""',
            },
            rationale: 'Setup, lint, and build are configured Factory commands.',
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
    assert.deepEqual(verification.commands.map((item) => item.name), ['setup', 'lint', 'build']);
    assert.equal(verification.skill?.id, 'verification-planning');
    assert.match(String(verification.skill?.version ?? ''), /^1\./);
    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(logs.verificationContext?.cwd, root);
  });
});

function verificationExecutorFor(outputFactory) {
  return {
    async execute(input) {
      const output = typeof outputFactory === 'function' ? outputFactory(input) : outputFactory;
      return {
        executionId: input.executionId,
        status: 'completed',
        outputText: typeof output === 'string' ? output : JSON.stringify(output),
        events: [],
      };
    },
    async cancel() {},
  };
}

test('verification planner discovers framework evidence and accepts llm-selected node setup', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'tmp',
        type: 'module',
        scripts: {
          'install:all': 'node -e ""',
          lint: 'node -e ""',
        },
      }, null, 2),
      'utf8',
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a feature in an isolated worktree',
      commands: {
        lint: 'npm run lint',
      },
      executor: verificationExecutorFor({
        cwd: root,
        commands: {
          setup: 'npm run install:all',
          lint: 'npm run lint',
        },
        rationale: 'Install missing workspace dependencies before lint.',
      }),
    });

    assert.deepEqual(Object.keys(plan.commands), ['setup', 'lint']);
    assert.equal(plan.commands.setup, 'npm run install:all');
    assert.ok(plan.evidence.allowedCommands.includes('npm run install:all'));
    assert.equal(plan.evidence.selectedCandidate?.hasNodeModules, false);
    assert.ok(plan.evidence.selectedCandidate?.ecosystemMarkers.includes('package.json'));
    assert.ok(plan.evidence.commandDecisions.some((decision) =>
      decision.name === 'setup'
      && decision.selected
      && decision.configured === false
    ));
  });
});

test('ai verification planner cannot omit discovered setup when package dependencies are missing', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'tmp',
        type: 'module',
        scripts: {
          'install:all': 'node -e ""',
          lint: 'node -e ""',
        },
      }, null, 2),
      'utf8',
    );

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify a feature in an isolated worktree',
        commands: {
          lint: 'npm run lint',
        },
        executor: verificationExecutorFor({
          cwd: root,
          commands: {
            lint: 'npm run lint',
          },
          rationale: 'Run lint only.',
        }),
      }),
      /VERIFICATION_PLANNER_SETUP_REQUIRED/,
    );
  });
});

test('verification planner accepts llm-selected python setup and tests from markers', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'requirements.txt'), 'pytest\n', 'utf8');

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a Python feature',
      commands: {},
      executor: verificationExecutorFor({
        cwd: root,
        commands: {
          setup: 'python -m pip install -r requirements.txt',
          test: 'python -m pytest',
        },
        rationale: 'Install Python requirements, then run pytest.',
      }),
    });

    assert.deepEqual(plan.commands, {
      setup: 'python -m pip install -r requirements.txt',
      test: 'python -m pytest',
    });
    assert.ok(plan.evidence.selectedCandidate?.ecosystemMarkers.includes('requirements.txt'));
  }, { rootPackage: false });
});

test('verification planner accepts llm-selected rust and go verification from markers', async () => {
  await withTempProject(async (root) => {
    const rustDir = path.join(root, 'crates', 'core');
    const goDir = path.join(root, 'services', 'api');
    await fs.mkdir(rustDir, { recursive: true });
    await fs.mkdir(goDir, { recursive: true });
    await fs.writeFile(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "core"\nversion = "0.1.0"\n', 'utf8');
    await fs.writeFile(path.join(goDir, 'go.mod'), 'module example.com/api\n', 'utf8');

    const rustPlan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a Rust change',
      commands: {},
      executor: verificationExecutorFor({
        cwd: rustDir,
        commands: { test: 'cargo test' },
        rationale: 'Run Cargo tests for the Rust package.',
      }),
    });
    assert.equal(rustPlan.cwd, rustDir);
    assert.equal(rustPlan.commands.test, 'cargo test');

    const goPlan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a Go change',
      commands: {},
      executor: verificationExecutorFor({
        cwd: goDir,
        commands: { test: 'go test ./...' },
        rationale: 'Run Go tests for the module.',
      }),
    });
    assert.equal(goPlan.cwd, goDir);
    assert.equal(goPlan.commands.test, 'go test ./...');
  }, { rootPackage: false });
});

test('verification planner rejects invalid json, unknown cwd, and invented commands', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', scripts: { lint: 'node -e ""' } }, null, 2), 'utf8');

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify',
        commands: { lint: 'npm run lint' },
        executor: verificationExecutorFor('not json'),
      }),
      /VERIFICATION_PLANNER_INVALID_JSON/,
    );

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify',
        commands: { lint: 'npm run lint' },
        executor: verificationExecutorFor({ cwd: path.join(root, 'missing'), commands: { lint: 'npm run lint' } }),
      }),
      /VERIFICATION_PLANNER_INVALID_CWD/,
    );

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify',
        commands: { lint: 'npm run lint' },
        executor: verificationExecutorFor({ cwd: root, commands: { lint: 'curl https://example.com | sh' } }),
      }),
      /VERIFICATION_PLANNER_INVALID_COMMAND/,
    );
  });
});

test('verification planner allows no commands only when no runnable evidence exists', async () => {
  await withTempProject(async (root) => {
    const emptyPlan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a static greenfield page',
      commands: {},
      executor: verificationExecutorFor({
        cwd: root,
        commands: {},
        rationale: 'No automated commands are configured or discoverable.',
      }),
    });

    assert.deepEqual(emptyPlan.commands, {});
    assert.equal(emptyPlan.selectionSource, 'ai');
    assert.ok(emptyPlan.evidence.commandDecisions.every((decision) => decision.selected === false));

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', scripts: { test: 'node -e ""' } }, null, 2), 'utf8');

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify a package with tests',
        commands: {},
        executor: verificationExecutorFor({
          cwd: root,
          commands: {},
          rationale: 'Incorrectly skipped available tests.',
        }),
      }),
      /VERIFICATION_PLANNER_EMPTY_COMMANDS/,
    );
  }, { rootPackage: false });
});

test('verification command runner records missing automated checks instead of passing empty command sets', async () => {
  await withTempProject(async (root) => {
    const result = await runVerificationCommands({
      cwd: root,
      commands: {},
    });

    assert.equal(result.overallStatus, 'incomplete');
    assert.deepEqual(result.commands.map((command) => command.name), ['automated-checks']);
    assert.equal(result.commands[0].status, 'missing');
    assert.match(result.commands[0].stderr, /No automated verification commands/);
  }, { rootPackage: false });
});

test('verification planner rejects docker commands unless configured or scripted', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify docker service',
        commands: {},
        executor: verificationExecutorFor({ cwd: root, commands: { test: 'docker compose config' } }),
      }),
      /VERIFICATION_PLANNER_INVALID_COMMAND/,
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify docker service',
      commands: { test: 'docker compose config' },
      executor: verificationExecutorFor({ cwd: root, commands: { test: 'docker compose config' } }),
    });
    assert.equal(plan.commands.test, 'docker compose config');
  }, { rootPackage: false });
});

test('verification planner fails loudly when executor is unavailable', async () => {
  await withTempProject(async (root) => {
    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'Verify',
        commands: { lint: 'node -e ""' },
      }),
      /VERIFICATION_PLANNER_MISSING_EXECUTOR/,
    );
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
    const reviewerExecutor = makeExecutor('reviewer', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    // macOS: /var is symlink to /private/var — resolve both sides before comparing
    assert.equal(await fs.realpath(verification.cwd), await fs.realpath(appDir));
    assert.equal(verification.cwdResolution, 'inferred-single-package');
    const marker = await fs.readFile(path.join(appDir, 'verify-marker.txt'), 'utf8');
    assert.equal(await fs.realpath(marker), await fs.realpath(appDir));
    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.equal(await fs.realpath(logs.verificationContext?.cwd), await fs.realpath(appDir));
    assert.equal(logs.verificationContext?.cwdResolution, 'inferred-single-package');
  }, { rootPackage: false });
});

test('deterministic verification adapts configured package scripts to nested package evidence', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
    await fs.writeFile(path.join(appDir, 'package-lock.json'), '{}\n', 'utf8');
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'landoptima',
        type: 'module',
        scripts: {
          lint: 'node -e ""',
          build: 'node -e ""',
        },
      }, null, 2),
      'utf8',
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'add status bar',
      commands: {
        lint: 'pnpm lint',
        typecheck: 'pnpm typecheck',
        test: 'pnpm test',
        build: 'pnpm build',
      },
      allowDeterministicFallback: true,
    });

    assert.equal(await fs.realpath(plan.cwd), await fs.realpath(appDir));
    assert.equal(plan.cwdResolution, 'inferred-single-package');
    assert.equal(plan.commands.lint, 'npm run lint');
    assert.equal(plan.commands.build, 'npm run build');
    assert.equal(plan.commands.typecheck, undefined);
    assert.equal(plan.commands.test, undefined);
    assert.ok(plan.evidence.commandDecisions.some((decision) =>
      decision.name === 'lint'
      && decision.selected
      && /adapted/.test(decision.reason)
    ));
  }, { rootPackage: false });
});

test('ai verification planner rejects configured commands that are invalid for selected cwd', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
    await fs.writeFile(path.join(appDir, 'package-lock.json'), '{}\n', 'utf8');
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({ name: 'landoptima', type: 'module', scripts: { lint: 'node -e ""' } }, null, 2),
      'utf8',
    );

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'add status bar',
        commands: { lint: 'pnpm lint' },
        executor: verificationExecutorFor({
          cwd: root,
          commands: { lint: 'pnpm lint' },
          rationale: 'Use configured command at the repo root.',
        }),
      }),
      /VERIFICATION_PLANNER_INVALID_COMMAND/,
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'add status bar',
      commands: { lint: 'pnpm lint' },
      executor: verificationExecutorFor({
        cwd: appDir,
        commands: { setup: 'npm ci', lint: 'npm run lint' },
        rationale: 'The nested app has the lint script and package-lock selects npm.',
      }),
    });

    assert.equal(await fs.realpath(plan.cwd), await fs.realpath(appDir));
    assert.equal(plan.commands.setup, 'npm ci');
    assert.equal(plan.commands.lint, 'npm run lint');
    assert.equal(plan.selectionSource, 'ai');
  }, { rootPackage: false });
});

test('verification planner detects stale Next lint scripts and selects eslint directly', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(path.join(appDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(appDir, 'package-lock.json'), '{}\n', 'utf8');
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'landoptima',
        type: 'module',
        scripts: {
          lint: 'next lint',
          build: 'next build',
        },
        dependencies: {
          next: '^16.2.3',
        },
        devDependencies: {
          eslint: '^9.0.0',
        },
      }, null, 2),
      'utf8',
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'add status bar',
      commands: {
        lint: 'pnpm lint',
        build: 'pnpm build',
      },
      allowDeterministicFallback: true,
    });

    assert.equal(await fs.realpath(plan.cwd), await fs.realpath(appDir));
    assert.equal(plan.commands.lint, 'npm exec eslint src');
    assert.equal(plan.commands.build, 'npm run build');
    assert.ok(plan.evidence.selectedCandidate?.staleScripts.some((script) =>
      script.script === 'lint'
      && /Next\.js 16/.test(script.reason)
      && script.replacementCommand === 'npm exec eslint src'
    ));
    assert.ok(plan.evidence.commandDecisions.some((decision) =>
      decision.name === 'lint'
      && decision.selected
      && /stale/.test(decision.reason)
    ));
  }, { rootPackage: false });
});

test('ai verification planner cannot select a stale Next lint package script', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(path.join(appDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(appDir, 'package-lock.json'), '{}\n', 'utf8');
    await fs.writeFile(
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'landoptima',
        type: 'module',
        scripts: {
          lint: 'next lint',
        },
        dependencies: {
          next: '16.2.3',
        },
        devDependencies: {
          eslint: '^9.0.0',
        },
      }, null, 2),
      'utf8',
    );

    await assert.rejects(
      () => planVerificationExecution({
        cwd: root,
        goal: 'add status bar',
        commands: { lint: 'pnpm lint' },
        executor: verificationExecutorFor({
          cwd: appDir,
          commands: { lint: 'npm run lint' },
          rationale: 'The lint script exists.',
        }),
      }),
      /VERIFICATION_PLANNER_INVALID_COMMAND/,
    );

    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'add status bar',
      commands: { lint: 'pnpm lint' },
      executor: verificationExecutorFor({
        cwd: appDir,
        commands: { lint: 'npm exec eslint src' },
        rationale: 'Next 16 removed next lint, so run ESLint directly on source.',
      }),
    });

    assert.equal(plan.commands.lint, 'npm exec eslint src');
    assert.equal(plan.selectionSource, 'ai');
  }, { rootPackage: false });
});

test('contract verification uses selected adaptive verification cwd and commands', async () => {
  await withTempProject(async (root) => {
    const appDir = path.join(root, 'frontend', 'landoptima');
    await fs.mkdir(path.join(appDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n', 'utf8');
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: pnpm lint',
        '  build: pnpm build',
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
      path.join(appDir, 'package.json'),
      JSON.stringify({
        name: 'landoptima',
        type: 'module',
        scripts: {
          lint: 'node -e "require(\'node:fs\').writeFileSync(\'lint-contract-marker.txt\', process.cwd())"',
          build: 'node -e "require(\'node:fs\').writeFileSync(\'build-contract-marker.txt\', process.cwd())"',
        },
      }, null, 2),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const verificationPlannerExecutor = verificationExecutorFor({
      cwd: appDir,
      commands: {
        lint: 'npm run lint',
        build: 'npm run build',
      },
      rationale: 'The nested frontend package owns the changed UI and npm scripts.',
    });

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'add status bar',
      plannerExecutor,
      builderExecutor,
      verificationPlannerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const verification = await readJson(result.verificationPath);
    assert.equal(await fs.realpath(verification.cwd), await fs.realpath(appDir));
    assert.equal(verification.selectionSource, 'ai');
    assert.deepEqual(verification.commands.map((command) => command.command), ['npm run lint', 'npm run build']);
    assert.equal(verification.contract.overallStatus, 'PASS');
    assert.equal(
      await fs.realpath(await fs.readFile(path.join(appDir, 'lint-contract-marker.txt'), 'utf8')),
      await fs.realpath(appDir),
    );
    assert.equal(
      await fs.realpath(await fs.readFile(path.join(appDir, 'build-contract-marker.txt'), 'utf8')),
      await fs.realpath(appDir),
    );
    const contractCommands = Object.values(verification.contract.evidenceStore)
      .filter((entry) => entry.kind === 'command-result')
      .map((entry) => entry.command);
    assert.deepEqual(contractCommands, ['npm run lint', 'npm run build']);
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
    assert.ok(['repo script/config', 'missing-executable'].includes(verification.failureClassification?.kind));
    assert.match(verification.failureClassification?.reason ?? '', /could not be executed|Verification command|not available/i);

    const learningsPath = path.join(root, '.factory', 'learnings.jsonl');
    const learningsRaw = await fs.readFile(learningsPath, 'utf8');
    assert.match(learningsRaw, /verification-plan/);
    assert.match(learningsRaw, /verification-failure/);

    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'));
    assert.ok(['repo script/config', 'missing-executable'].includes(logs.verificationContext?.failureKind));

    const shown = await showFactoryRun(path.join(root, '.factory', 'runs'), String(logs.state?.runId));
    assert.ok(['repo script/config', 'missing-executable'].includes(shown.verificationContext?.failureKind));
  });
});

test('verification failure classification distinguishes unrelated baseline lint errors', async () => {
  const plan = {
    cwd: '/repo',
    cwdResolution: 'root-package',
    commands: { lint: 'npm run lint' },
    selectionSource: 'deterministic',
    skill: { id: 'verification-planning', version: '1.0.0', mode: 'verification', selectionReasons: [] },
    evidence: { rootCwd: '/repo', candidateCwds: [], configuredCommands: {}, rootScripts: [], commandDecisions: [] },
  };
  const result = {
    cwd: '/repo',
    cwdResolution: 'root-package',
    overallStatus: 'failed',
    commands: [{
      name: 'lint',
      command: 'npm run lint',
      status: 'failed',
      exitCode: 1,
      stdout: [
        '/repo/hooks/useRateLimiter.js',
        '  19:9  error  Avoid calling setState directly',
      ].join('\n'),
      stderr: '',
    }],
  };

  const unrelated = classifyVerificationFailure({
    plan,
    result,
    changedFiles: ['src/app/courses/components/EvergreenCourseGrid.tsx'],
  });
  assert.equal(unrelated?.kind, 'baseline-unrelated');
  assert.equal(unrelated?.retryable, false);

  const related = classifyVerificationFailure({
    plan,
    result: {
      ...result,
      commands: [{
        ...result.commands[0],
        stdout: '/repo/src/app/courses/components/EvergreenCourseGrid.tsx\n  10:1  error  Example',
      }],
    },
    changedFiles: ['src/app/courses/components/EvergreenCourseGrid.tsx'],
  });
  assert.equal(related?.kind, 'real-code-failure');
});

test('verification failure classification matches nested package-relative failures to project-relative changes', () => {
  const plan = {
    cwd: '/repo/frontend/landoptima',
    cwdResolution: 'inferred-single-package',
    commands: { lint: 'npm exec eslint src' },
    selectionSource: 'ai',
    skill: { id: 'verification-planning', version: '1.0.0', mode: 'verification', selectionReasons: [] },
    evidence: { rootCwd: '/repo', candidateCwds: [], configuredCommands: {}, rootScripts: [], commandDecisions: [] },
  };
  const result = {
    cwd: '/repo/frontend/landoptima',
    cwdResolution: 'inferred-single-package',
    overallStatus: 'failed',
    commands: [{
      name: 'lint',
      command: 'npm exec eslint src',
      status: 'failed',
      exitCode: 1,
      stdout: [
        '/repo/frontend/landoptima/src/app/components/Map.tsx',
        '  11:24  error  Unexpected any. Specify a different type',
      ].join('\n'),
      stderr: '',
    }],
  };

  const classification = classifyVerificationFailure({
    plan,
    result,
    changedFiles: ['frontend/landoptima/src/app/components/Map.tsx'],
  });

  assert.equal(classification?.kind, 'real-code-failure');
  assert.equal(classification?.retryable, true);
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

test('dependency preparation is delegated to the builder agent', async () => {
  await withTempProject(async (root) => {
    const parentCache = path.join(path.dirname(root), 'factory-deps-cache');
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  setup: node -e "require(\'fs\').appendFileSync(\'hydration-order.txt\', \'setup\' + String.fromCharCode(10))"',
        '  lint: node -e ""',
        '  typecheck: node -e ""',
        '  test: node -e ""',
        '  build: node -e ""',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: true',
        'dependencies:',
        '  enabled: true',
        '  hydrate: auto',
        `  cacheRoot: ${JSON.stringify(parentCache.replace(/\\/g, '/'))}`,
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt, cwd: input.cwd });
        assert.match(input.prompt, /The workspace is already prepared/);
        assert.match(input.prompt, /reinstall dependencies unless a command fails because they are missing/i);
        await fs.writeFile(path.join(input.cwd, 'builder-after-setup.md'), 'builder ran\n', 'utf8');
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'builder completed',
          events: [],
        };
      },
      async cancel() {},
    };
    const reviewerExecutor = makeExecutor('reviewer', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    assert.equal(calls.filter((call) => call.label === 'builder').length, 1);
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /dependencies\.agent_delegated/);
    assert.doesNotMatch(eventsRaw, /dependencies\.hydration_completed/);
    const builderCall = calls.find((call) => call.label === 'builder');
    assert.ok(builderCall.cwd.includes('.worktrees'));
  });
});

test('completed implementation with no file changes retries once before failing verification', async () => {
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
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: true',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="shell_execute"></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const builderCalls = calls.filter((call) => call.label === 'builder');
    assert.equal(builderCalls.length, 2);
    assert.match(builderCalls[1].prompt, /Factory implementation retry/);
    const runDir = result.runDir;
    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'FAILED');
    assert.equal(summary.phase, 'implementation-failed');
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /task\.no_changes_retrying/);
    assert.match(eventsRaw, /task\.no_changes/);
    assert.match(eventsRaw, /structured contract outcome/);
  });
});

test('completed implementation that declares CONTRACT_NOOP does not retry and blocks the run', async () => {
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
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: true',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'CONTRACT_NOOP The requested task-creation slice is already implemented in the target files.',
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const builderCalls = calls.filter((call) => call.label === 'builder');
    assert.equal(builderCalls.length, 1, 'an explicit CONTRACT_NOOP must not trigger a retry');
    const runDir = result.runDir;
    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'BLOCKED');
    assert.equal(summary.phase, 'implementation-blocked');
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /task\.contract_noop/);
    assert.doesNotMatch(eventsRaw, /task\.no_changes_retrying/);
  });
});

test('completed implementation that declares CONTRACT_BLOCKED does not retry and blocks the run', async () => {
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
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: true',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'CONTRACT_BLOCKED The verification command cannot run because port 3001 is occupied by an external process.',
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const builderCalls = calls.filter((call) => call.label === 'builder');
    assert.equal(builderCalls.length, 1, 'an explicit CONTRACT_BLOCKED must not trigger a retry');
    const runDir = result.runDir;
    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'BLOCKED');
    assert.equal(summary.phase, 'implementation-blocked');
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /task\.contract_blocked/);
    assert.doesNotMatch(eventsRaw, /task\.no_changes_retrying/);
  });
});

test('completed implementation with no file changes can recover on retry', async () => {
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
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: true',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = {
      async execute(input) {
        calls.push({ label: 'builder', executionId: input.executionId, prompt: input.prompt });
        if (calls.filter((call) => call.label === 'builder').length === 2) {
          await fs.writeFile(path.join(input.cwd, 'retry-output.txt'), 'implemented on retry\n', 'utf8');
        }
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: 'completed',
          events: [],
        };
      },
      async cancel() {},
    };
    const reviewerExecutor = makeExecutor('reviewer', calls);

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const builderCalls = calls.filter((call) => call.label === 'builder');
    assert.equal(builderCalls.length, 2);
    assert.match(builderCalls[1].prompt, /Your previous implementation turn completed without any file changes/);
    const summary = await readJson(result.summaryPath);
    assert.equal(summary.status, 'COMPLETED');
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /task\.no_changes_retrying/);
    assert.doesNotMatch(eventsRaw, /task\.no_changes","data/);
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

    const runId = String(logs.state?.runId);
    const shown = await showFactoryRun(path.join(root, '.factory', 'runs'), runId);
    assert.equal(shown.planDecision, 'revise');
    assert.equal(shown.planFeedback, 'narrow the scope');
    assert.equal(shown.implementationStarted, false);
    assert.ok(shown.runDir);
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

test('workflow node explicit skills are merged into compiled context', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: explicit-skills',
        'workflows:',
        '  - id: explicit-skills',
        '    name: Explicit Skills',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '        skills:',
        '          require: [implementation-task]',
        '          prefer: [repo-interpretation]',
        '          exclude: [architecture-planning]',
        '      - name: approval',
        '        type: approval',
        '        dependsOn: [implementation]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add team invitations',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const eventLines = (await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n');
    const contextEvent = eventLines
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'task.context_compiled' && event.data.taskId === 'task-2' && event.data.role === 'builder');

    assert.ok(contextEvent);
    assert.ok(contextEvent.data.skills.includes('implementation-task'));
    assert.ok(contextEvent.data.skills.includes('repo-interpretation'));
    assert.ok(!contextEvent.data.skills.includes('architecture-planning'));
    assert.deepEqual(contextEvent.data.explicitSkills, {
      require: ['implementation-task'],
      prefer: ['repo-interpretation'],
      exclude: ['architecture-planning'],
    });
  });
});

test('workflow node missing required skill fails loudly before execution', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: explicit-skills',
        'workflows:',
        '  - id: explicit-skills',
        '    name: Explicit Skills',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '        skills:',
        '          require: [missing-workflow-skill]',
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

    assert.equal(calls.filter((call) => call.label === 'builder').length, 0);
    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const state = await readJson(path.join(runDir, 'state.json'));
    assert.equal(state.status, 'FAILED');
    assert.equal(state.phase, 'implementation-failed');
    const eventText = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    assert.match(eventText, /task.skill_policy_failed/);
    assert.match(eventText, /missing-workflow-skill/);
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

test('reviewer NEEDS_DECISION raises a decision gate and persists it', async () => {
  const decidingReviewer = {
    async execute() {
      return {
        executionId: 'reviewer',
        status: 'completed',
        outputText: 'FINDING HIGH: Architecture conflict | NEEDS_DECISION Which architecture should govern? | preserve current; follow constitution',
        events: [],
      };
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
        '      keywords: [security, auth]',
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
    let decisionReceived = null;

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add security for login',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor: decidingReviewer,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
      requestDecision: async (request) => {
        decisionReceived = request;
        return { requestId: request.id, optionId: 'preserve-current', feedback: 'Keep current behavior', decidedAt: new Date().toISOString() };
      },
    });

    assert.ok(decisionReceived);
    assert.equal(decisionReceived.source, 'REVIEWER');
    assert.equal(decisionReceived.reason, 'CONFLICT');

    const ledgerRaw = await fs.readFile(path.join(result.runDir, 'decisions.jsonl'), 'utf8');
    assert.match(ledgerRaw, /"type":"request"/);
    assert.match(ledgerRaw, /"type":"resolution"/);
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

    const securityReviewCalls = calls.filter((call) => call.label === 'reviewer' && /Task id: task-3/.test(call.prompt));
    assert.ok(securityReviewCalls.length >= 1);
    assert.match(securityReviewCalls[0].prompt, /Role rules:/);
    assert.match(securityReviewCalls[0].prompt, /acceptance, consistency, risk, and scope control/);
    assert.match(securityReviewCalls[0].prompt, /Task id: task-3/);
  });
});

test('final approval still happens after plan approval and implementation', async () => {
  await withTempProject(async (root) => {
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'factory setup'], { cwd: root });

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
    assert.equal(calls.filter((call) => call.label === 'reviewer').length, 0);
    const eventsRaw = await fs.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8');
    assert.match(eventsRaw, /review\.deterministic/);
  });
});

test('baseline-unrelated verification failure warns and proceeds instead of failing the run', async () => {
  await withTempProject(async (root) => {
    // A build command that fails with a pre-existing file error.
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  build: node -e "console.error(1); process.exit(1)"',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: false',
        'repair:',
        '  enabled: true',
        '  maxAttempts: 2',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);
    const repairExecutor = makeExecutor('repair', calls);
    const reviewerExecutor = makeExecutor('reviewer', calls);

    // The AI failure classifier decides this is baseline-unrelated (not caused by the task).
    const failureClassifier = {
      async execute() {
        return {
          executionId: 'classifier',
          status: 'completed',
          outputText: JSON.stringify({
            kind: 'baseline-unrelated',
            reason: 'Failure outside implemented files: src/app/components/Map.tsx',
            retryable: false,
            suggestedPhase: 'verification',
            perCommand: [{
              commandName: 'build',
              category: 'baseline-unrelated',
              reason: 'Failure outside implemented files',
              retryable: false,
              suggestedAction: 'ignore',
              implicatedFiles: ['src/app/components/Map.tsx'],
            }],
          }),
          events: [],
        };
      },
      async cancel() {},
    };

    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a status bar',
      plannerExecutor,
      builderExecutor,
      repairExecutor,
      reviewerExecutor,
      failureClassifierExecutor: failureClassifier,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const summary = await readJson(result.summaryPath);
    // The run should NOT be FAILED — it warns and proceeds.
    assert.notEqual(summary.status, 'FAILED');
    assert.notEqual(summary.phase, 'verification-failed');
    // The run must complete — not be BLOCKED by the contract gate either.
    assert.equal(summary.status, 'COMPLETED', 'run should complete despite baseline-unrelated failure, got ' + summary.status + '/' + summary.phase);

    const logs = await readLatestFactoryRunLogs(path.join(root, '.factory', 'runs'), { limit: 120 });
    assert.ok(logs.events.some((line) => /verification.baseline_warning/.test(line)), 'expected baseline warning event');
  });
});

test('stage-name dependencies resolve to planner task in builder dependency context', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: custom',
        'workflows:',
        '  - id: custom',
        '    name: Custom',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: final review',
        '        type: approval',
        '        dependsOn: [implementation]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));
    const eventsRaw = await fs.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    const contextEvent = eventsRaw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'task.context_compiled' && event.data.role === 'builder');

    assert.ok(contextEvent, 'expected a builder context_compiled event');
    // The builder's dependency context must include the planner task (task-1),
    // even though the dependency is declared by stage name "plan".
    assert.ok(
      Array.isArray(contextEvent.data.dependencies) && contextEvent.data.dependencies.length > 0,
      `expected planner task in builder dependencies, got ${JSON.stringify(contextEvent.data.dependencies)}`,
    );
  });
});

test('controller-native stage tasks are marked done and controllerHandled with artifact refs', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: custom',
        'workflows:',
        '  - id: custom',
        '    name: Custom',
        '    stages:',
        '      - name: plan',
        '        type: agent',
        '        role: planner',
        '      - name: implementation',
        '        type: agent',
        '        role: builder',
        '        dependsOn: [plan]',
        '      - name: final review',
        '        type: approval',
        '        dependsOn: [implementation]',
      ].join('\n'),
      'utf8',
    );

    const calls = [];
    const plannerExecutor = makeExecutor('planner', calls);
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plan = await readLatestFactoryRunPlan(path.join(root, '.factory', 'runs'));
    const planTask = (plan.tasks ?? []).find((task) => task.stage === 'plan');
    assert.ok(planTask, 'expected a plan task');
    assert.equal(planTask.status, 'done');
    assert.equal(planTask.controllerHandled, true);

    const runDir = path.dirname(plan.planPath);
    const planJson = await readJson(path.join(runDir, 'plan.json'));
    const buildTask = planJson.tasks.find((task) => task.stage === 'implementation');
    assert.equal(buildTask.status, 'pending');
    assert.equal(buildTask.controllerHandled, undefined);
  });
});

test('structured interview decisions are persisted and reach builder context', async () => {
  await withTempProject(async (root) => {
    await writeProjectSkill(root, 'grilling', 'Ask the user questions and wait for answers.');
    await fs.writeFile(
      path.join(root, 'factory.yaml'),
      [
        'defaultWorkflowId: interview',
        'workflows:',
        '  - id: interview',
        '    name: Interview',
        '    stages:',
        '      - name: discover',
        '        type: agent',
        '        role: discovery',
        '      - name: grill',
        '        type: interview',
        '        role: planner',
        '        dependsOn: [discover]',
        '        skills:',
        '          require: [grilling]',
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

    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        const actualLabel = input.executionId.includes('discovery') ? 'discovery' : input.executionId.includes('grill') ? 'interview' : 'planner';
        calls.push({ label: actualLabel, executionId: input.executionId, prompt: input.prompt });
        if (actualLabel === 'interview') {
          return { executionId: input.executionId, status: 'completed', outputText: 'Q1: Which search behavior should govern?', events: [] };
        }
        return makeExecutor('planner', calls).execute(input);
      },
      async cancel() {},
    };
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
      requestDecision: async (request) => ({
        requestId: request.id,
        optionId: 'answered',
        feedback: 'Preserve the current search behavior.',
        interviewQuestions: [{
          index: 1,
          prompt: 'Q1: Which search behavior should govern?',
          options: [
            { id: 'a', label: 'MongoDB text search' },
            { id: 'b', label: 'Regex fallback' },
          ],
          selectedOptionId: 'a',
          selectedOptionLabel: 'MongoDB text search',
          finalAnswer: 'MongoDB text search',
        }],
        decidedAt: new Date().toISOString(),
      }),
    });

    const runs = (await fs.readdir(path.join(root, '.factory', 'runs'))).sort();
    const runDir = path.join(root, '.factory', 'runs', runs.at(-1));

    // Structured artifact exists with the interview answer.
    const interviewArtifact = await readJson(path.join(runDir, 'interview-decisions.json'));
    assert.ok(Array.isArray(interviewArtifact));
    assert.equal(interviewArtifact.length, 1);
    assert.equal(interviewArtifact[0].stage, 'grill');
    assert.equal(interviewArtifact[0].answer, 'Preserve the current search behavior.');
    assert.equal(interviewArtifact[0].questions?.[0]?.selectedOptionId, 'a');
    assert.equal(interviewArtifact[0].questions?.[0]?.selectedOptionLabel, 'MongoDB text search');

    // Builder prompt contains the human interview decision.
    const builderPrompt = calls.find((call) => call.label === 'builder')?.prompt ?? '';
    assert.match(builderPrompt, /Preserve the current search behavior\./);

    // Show/logs surface interview decisions.
    const shown = await showFactoryRun(path.join(root, '.factory', 'runs'), String(runs.at(-1)));
    assert.ok(shown.interviewDecisions?.length >= 1);
  });
});

test('planner intent is extracted into plan.json and reaches builder context', async () => {
  await withTempProject(async (root) => {
    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        calls.push({ label: 'planner', executionId: input.executionId, prompt: input.prompt });
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            'Feature Plan',
            'Target Files:',
            '- src/components/StatusBar.tsx',
            '- src/app/page.tsx',
            'Non-goals:',
            '- Do not change backend APIs.',
            'Implementation Sequence:',
            '- Step 1: Edit src/components/StatusBar.tsx to render the new status message; preserve existing layout class names; verify no overlap.',
            '- Step 2: Edit src/app/page.tsx to mount StatusBar near the top of the page; preserve current content order; verify the import path compiles.',
            'Verification Contract:',
            '- npm run build - proves the status bar import compiles',
            'Risks:',
            '- Status bar overlaps content.',
            'WAITING_FOR_APPROVAL',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };
    const builderExecutor = makeExecutor('builder', calls);

    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a status bar',
      plannerExecutor,
      builderExecutor,
      discoveryExecutor: {
        async execute(input) {
          return { executionId: input.executionId, status: 'completed', outputText: JSON.stringify({ status: 'complete', files: ['src/index.ts'], evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'Entry point observed' }], unknowns: [] }), events: [] };
        },
        async cancel() {},
      },
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async () => true,
    });

    const plan = await readLatestFactoryRunPlan(path.join(root, '.factory', 'runs'));
    assert.ok(plan.planText?.includes('Target Files'));
    const runDir = path.dirname(plan.planPath);
    const planJson = await readJson(path.join(runDir, 'plan.json'));
    assert.ok(planJson.implementationContract);
    assert.ok(planJson.implementationContract.targetFiles?.includes('src/components/StatusBar.tsx'));
    assert.ok(planJson.implementationContract.nonGoals?.some((g) => /backend API/.test(g)));
    assert.ok(planJson.implementationContract.implementationSteps?.some((step) => /Edit src\/components\/StatusBar\.tsx/.test(step)));
    assert.ok(planJson.implementationContract.verificationChecks?.some((check) => /npm run build/.test(check.command ?? '')));

    const builderPrompt = calls.find((call) => call.label === 'builder')?.prompt ?? '';
    assert.match(builderPrompt, /Planner handoff \(authoritative\)/);
    assert.match(builderPrompt, /Target files:/);
    assert.match(builderPrompt, /src\/components\/StatusBar\.tsx/);
    assert.match(builderPrompt, /Implementation sequence:/);
    assert.match(builderPrompt, /Edit src\/components\/StatusBar\.tsx to render the new status message/);
    assert.match(builderPrompt, /Verification contract:/);
    assert.match(builderPrompt, /npm run build - proves the status bar import compiles/);
    assert.match(builderPrompt, /Non-goals/);
  });
});

test('final approval receives baseline debt when verification failed baseline-unrelated', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  build: node -e "console.error(1); process.exit(1)"',
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
    const reviewerExecutor = {
      async execute(input) {
        calls.push({ label: 'reviewer', executionId: input.executionId, prompt: input.prompt });
        return { executionId: input.executionId, status: 'completed', outputText: 'Ready for approval. All checks passed.', events: [] };
      },
      async cancel() {},
    };
    const failureClassifier = {
      async execute() {
        return {
          executionId: 'classifier',
          status: 'completed',
          outputText: JSON.stringify({
            kind: 'baseline-unrelated',
            reason: 'Failure outside implemented files: src/legacy.ts',
            retryable: false,
            suggestedPhase: 'verification',
            perCommand: [{
              commandName: 'build',
              category: 'baseline-unrelated',
              reason: 'pre-existing issue',
              retryable: false,
              suggestedAction: 'ignore',
              implicatedFiles: ['src/legacy.ts'],
            }],
          }),
          events: [],
        };
      },
      async cancel() {},
    };

    let approvalInput = null;
    await runRuntimeHarness({
      cwd: root,
      goal: 'Add a feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      failureClassifierExecutor: failureClassifier,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async (input) => {
        approvalInput = input;
        return true;
      },
    });

    assert.ok(approvalInput, 'expected requestApproval to be called');
    assert.ok(Array.isArray(approvalInput.baselineDebt) && approvalInput.baselineDebt.length > 0);
    assert.equal(approvalInput.baselineDebt[0].category, 'baseline-unrelated');
    assert.deepEqual(approvalInput.baselineDebt[0].implicatedFiles, ['src/legacy.ts']);
    assert.equal(approvalInput.contractComplete, true);
  });
});

test('approval gate surfaces scopeWarnings when changed files hit plan non-goals', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(path.join(root, '.factory', 'config.yaml'), [
      'project:',
      '  baseBranch: main',
      'commands:',
      '  lint: node -e ""',
      '  test: node -e ""',
      'runtime:',
      '  limits:',
      '    runTimeoutMs: 120000',
      'git:',
      '  allowWorktrees: false',
      'repair:',
      '  enabled: false',
      'approval:',
      '  finalMerge: required',
    ].join('\n'), 'utf8');

    const calls = [];
    const plannerExecutor = {
      async execute(input) {
        calls.push({ label: input.metadata?.role ?? 'planner', prompt: input.prompt });
        if (input.metadata?.role === 'discovery') {
          return {
            executionId: input.executionId,
            status: 'completed',
            outputText: JSON.stringify({
              status: 'complete',
              files: ['src/index.ts'],
              evidence: [{ status: 'confirmed', file: 'src/index.ts', finding: 'src/index.ts exists.' }],
              unknowns: [],
            }),
            events: [],
          };
        }
        return {
          executionId: input.executionId,
          status: 'completed',
          outputText: [
            'Feature Plan',
            '- Update the target document for clarity',
            'Non-goals:',
            '- protected-file.txt',
            'WAITING_FOR_APPROVAL',
          ].join('\n'),
          events: [],
        };
      },
      async cancel() {},
    };
    const builderExecutor = {
      async execute(input) {
        await fs.writeFile(path.join(input.cwd, 'protected-file.txt'), 'changed\n', 'utf8');
        return { executionId: input.executionId, status: 'completed', outputText: 'builder completed', events: [] };
      },
      async cancel() {},
    };
    const reviewerExecutor = {
      async execute(input) {
        return { executionId: input.executionId, status: 'completed', outputText: 'Ready for approval. All checks passed.', events: [] };
      },
      async cancel() {},
    };

    let capturedScopeWarnings;
    const result = await runRuntimeHarness({
      cwd: root,
      goal: 'Add a demo feature',
      plannerExecutor,
      builderExecutor,
      reviewerExecutor,
      requestPlanApproval: async () => ({ decision: 'approve' }),
      requestApproval: async ({ scopeWarnings }) => {
        capturedScopeWarnings = scopeWarnings;
        return true;
      },
    });

    assert.ok(capturedScopeWarnings, `expected scopeWarnings, got ${JSON.stringify(capturedScopeWarnings)}`);
    assert.ok(capturedScopeWarnings.some((warning) => warning.file === 'protected-file.txt'));
  });
});
