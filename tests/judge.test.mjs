import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJudgePrompt, judgeRunQuality, parseStrictJson, sanitizeJudgeVerdict } from '../packages/core/dist/benchmark/judge.js';

const spec = {
  id: 'bombsite-test', goal: 'add a navbar', interviewRequired: true,
  expectedTopics: ['links', 'mobile'], expectedFiles: ['components/Navbar.tsx'],
};

const artifacts = {
  runId: 'run_x', runDir: '/tmp/run_x',
  interviewDecisions: [{ stage: 'grill', role: 'planner', question: 'Q1 which links?', optionId: 'answered', answer: 'home, services', decisionRequestId: 'r1' }],
  plan: { summary: 'plan', planText: 'build navbar', workflowStages: [], tasks: [], implementationContract: { targetFiles: ['components/Navbar.tsx'] } },
  verification: { overallStatus: 'passed', cwd: '/app', commands: [{ name: 'test', status: 'passed' }] },
  completedTasks: [{ taskId: 't1', targetBranch: 'main', sourceBranch: 'x', commitSha: 'abc', changedFiles: ['components/Navbar.tsx'], workspaceMode: 'in-place' }],
  finalMerge: { status: 'landed', outcome: 'landed', mergeBaseBranch: 'main', mergeCwd: '/app' },
  summary: { status: 'COMPLETED', verificationStatus: 'passed' },
  events: [], decisions: [], modelLedger: [], repairExecutions: [], interviewExecutions: [],
  builderExecutions: [], landingDiagnoses: [], landingAttempts: [], missing: [], errors: [],
  discoveryExecution: undefined, plannerExecution: undefined, reviewerExecution: undefined, landingPlan: undefined, state: undefined,
};

test('no executor -> judge returns undefined (deterministic fallback)', async () => {
  const verdict = await judgeRunQuality({ artifacts, spec, rubric: 'good' });
  assert.equal(verdict, undefined);
});

test('judge prompt includes rubric, evidence, and asks for strict JSON', () => {
  const prompt = buildJudgePrompt(artifacts, spec, 'score interview insight');
  assert.match(prompt, /benchmark judge/);
  assert.match(prompt, /score interview insight/);
  assert.match(prompt, /Return STRICT JSON/);
  assert.match(prompt, /interviewDecisions/);
  assert.match(prompt, /changedFiles/);
  assert.match(prompt, /"scores"/);
  assert.match(prompt, /"reasoning"/);
});

test('parseStrictJson handles fenced and bare output', () => {
  assert.deepEqual(parseStrictJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseStrictJson('prefix {"a":1} suffix'), { a: 1 });
  assert.equal(parseStrictJson('no json here'), undefined);
  assert.equal(parseStrictJson('{"broken'), undefined);
});

test('sanitizeJudgeVerdict clamps scores and warns on missing pillars', () => {
  const verdict = sanitizeJudgeVerdict({
    scores: { interviewQuality: 1.5, handoffQuality: -0.2, executionQuality: 0.8 },
    reasoning: { interviewQuality: 'asked well', executionQuality: 'good' },
  });
  assert.equal(verdict.scores.interviewQuality, 1);
  assert.equal(verdict.scores.handoffQuality, 0);
  assert.equal(verdict.scores.executionQuality, 0.8);
  assert.equal(verdict.reasoning.interviewQuality, 'asked well');
  // pillars with no numeric score -> warning
  assert.ok(verdict.warnings.some((w) => /mergeQuality/.test(w)));
});

test('judgeRunQuality runs the executor and sanitizes its output', async () => {
  const executor = {
    async execute(input) {
      assert.match(input.prompt, /benchmark judge/);
      return { executionId: input.executionId, status: 'completed', outputText: JSON.stringify({
        scores: { interviewQuality: 0.9, handoffQuality: 0.8, executionQuality: 0.7, mergeQuality: 0.6, adaptationQuality: 0.5, scopeQuality: 0.9, timeEfficiency: 0.4 },
        reasoning: { interviewQuality: 'asked the right clarifying questions' },
      }), events: [] };
    },
    async cancel() {},
  };
  const verdict = await judgeRunQuality({ executor, artifacts, spec, rubric: 'good' });
  assert.ok(verdict);
  assert.equal(verdict.scores.interviewQuality, 0.9);
  assert.equal(verdict.reasoning.interviewQuality, 'asked the right clarifying questions');
});

test('executor failure -> undefined, never a fabricated score', async () => {
  const executor = {
    async execute() { throw new Error('model down'); },
    async cancel() {},
  };
  const verdict = await judgeRunQuality({ executor, artifacts, spec, rubric: 'good' });
  assert.equal(verdict, undefined);
});
