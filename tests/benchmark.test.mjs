import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRunArtifacts, scoreRunArtifacts, scoreFactoryRun, summarizeBenchmarkResults } from '../packages/core/dist/index.js';

// Fixture builder: a synthetic run dir with exactly the artifacts one scenario
// proves. Generated rather than committed so each test states its inputs.

async function writeRunDir(overrides = {}) {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-benchmark-'));
  const now = Date.parse('2026-08-30T08:00:00.000Z');
  const at = (seconds) => new Date(now + seconds * 1000).toISOString();

  const events = overrides.events ?? [
    { timestamp: at(0), type: 'run.created', data: {} },
    { timestamp: at(1), type: 'phase.discovery', data: {} },
    { timestamp: at(30), type: 'phase.planning', data: {} },
    { timestamp: at(60), type: 'phase.plan-approval', data: {} },
    { timestamp: at(70), type: 'phase.implementation', data: {} },
    { timestamp: at(120), type: 'phase.verification', data: {} },
    { timestamp: at(130), type: 'phase.review', data: {} },
    { timestamp: at(150), type: 'phase.approval-ready', data: {} },
    { timestamp: at(160), type: 'phase.landing-planning', data: {} },
    { timestamp: at(180), type: 'run.completed', data: {} },
  ];

  const files = {
    'state.json': { runId: 'run_fixture', status: 'COMPLETED', phase: 'complete' },
    'summary.json': {
      runId: 'run_fixture',
      goal: 'add a navbar',
      status: 'COMPLETED',
      phase: 'complete',
      approved: true,
      planPath: 'plan.json',
      taskPaths: [],
      verificationPath: 'verification.json',
      verificationStatus: 'passed',
      landingStatus: 'landed',
      landingAttempts: 1,
      ...(overrides.summary ?? {}),
    },
    'plan.json': {
      goal: 'add a navbar',
      summary: 'Add navbar component with nav links.',
      planText: 'Create components/Navbar.tsx and render it in layout.',
      implementationContract: { targetFiles: ['components/Navbar.tsx'], nonGoals: ['no sidebar'], verificationChecks: [], risks: [], blockers: [] },
      workflowStages: [],
      tasks: [{ id: 'task-1', title: 'build navbar', stage: 'build', status: 'done', dependsOn: [] }],
      ...(overrides.plan ?? {}),
    },
    'verification.json': {
      cwd: '/app',
      cwdResolution: 'root-package',
      commands: [{ name: 'test', command: 'npm test', status: 'passed' }],
      overallStatus: 'passed',
      selectionSource: 'ai',
      evidence: { selectedCandidate: { path: '/app' }, allowedCommands: ['npm test'], commandDecisions: [{ name: 'test', configured: true, selected: true }] },
      contract: { plan: { requirements: [{ id: 'r1' }] }, results: [{ requirementId: 'r1' }], overallStatus: 'PASS', canComplete: true },
      ...(overrides.verification ?? {}),
    },
    'discovery-execution.json': { executionId: 'd', status: 'completed', outputText: '{}', events: [] },
    'planner-execution.json': { executionId: 'p', status: 'completed', outputText: 'plan', events: [] },
    'reviewer-execution.json': { executionId: 'r', status: 'completed', outputText: 'looks ready', events: [] },
    'completed-tasks.json': [{ taskId: 'task-1', targetBranch: 'main', sourceBranch: 'factory/x', commitSha: 'abc', changedFiles: ['components/Navbar.tsx'], workspaceMode: 'in-place' }],
    'landing-plan.json': { strategy: 'merge', targetBranch: 'main', reasoning: ['fast-forward'], verification: ['test'], risk: 'low', expectedFiles: ['components/Navbar.tsx'], guardVerdict: { ok: true, reasons: [] } },
    'final-merge.json': { mergeBaseBranch: 'main', candidateBranch: 'factory/x', candidateSha: 'abc', mergeCwd: '/app', targetBranch: 'main', sourceBranch: 'factory/x', strategy: 'merge', status: 'landed', outcome: 'landed' },
    'landing-attempts.jsonl': [{ attempt: 1, plan: {}, execution: { status: 'landed', outcome: 'landed' } }],
    'events.jsonl': events,
    'decisions.jsonl': overrides.decisions ?? [],
    'interview-decisions.json': overrides.interviewDecisions ?? [],
    'model-ledger.jsonl': overrides.modelLedger ?? [
      { operationId: 'o1', role: 'planner', taskType: 'general', taskTypeSource: 'default', requestedModel: 'm1', resolvedModel: 'm1', modelSource: 'role-default', timestamp: at(1) },
      { operationId: 'o2', role: 'reviewer', taskType: 'general', taskTypeSource: 'default', requestedModel: 'm1', resolvedModel: 'm1', modelSource: 'role-default', timestamp: at(2) },
    ],
  };

  for (const [name, value] of Object.entries(files)) {
    if (value === undefined) continue;
    const target = path.join(runDir, name);
    if (name.endsWith('.jsonl')) {
      await fs.writeFile(target, value.map((line) => JSON.stringify(line)).join('\n') + (value.length ? '\n' : ''), 'utf8');
    } else {
      await fs.writeFile(target, JSON.stringify(value, null, 2), 'utf8');
    }
  }
  for (const name of overrides.omit ?? []) {
    await fs.rm(path.join(runDir, name), { force: true });
  }
  for (const [name, contents] of Object.entries(overrides.raw ?? {})) {
    await fs.writeFile(path.join(runDir, name), contents, 'utf8');
  }
  return runDir;
}

const round = (value) => (value === null ? null : Math.round(value * 1000) / 1000);

const baseSpec = {
  id: 'bombsite-test',
  goal: 'add a navbar',
  interviewRequired: false,
  expectedFiles: ['components/Navbar.tsx'],
  expectedVerificationStatus: 'passed',
  agentTimeBudgetMs: 200_000,
};

test('reader exposes every artifact class the scorer needs', async () => {
  const runDir = await writeRunDir();
  const artifacts = await readRunArtifacts(runDir);
  assert.equal(artifacts.runId, path.basename(runDir));
  assert.ok(artifacts.summary);
  assert.ok(artifacts.landingPlan);
  assert.ok(artifacts.finalMerge);
  assert.equal(artifacts.completedTasks.length, 1);
  assert.equal(artifacts.events.length, 10);
  assert.equal(artifacts.modelLedger.length, 2);
  assert.deepEqual(artifacts.missing, []);
  assert.deepEqual(artifacts.errors, []);
});

test('reader distinguishes missing artifacts from unreadable ones', async () => {
  const missingRun = await writeRunDir({ omit: ['final-merge.json'] });
  const artifacts = await readRunArtifacts(missingRun);
  assert.ok(artifacts.missing.includes('finalMerge'));
  assert.deepEqual(artifacts.errors, []);

  const corruptRun = await writeRunDir({ raw: { 'verification.json': '{not json' } });
  const corrupt = await readRunArtifacts(corruptRun);
  assert.ok(corrupt.errors.some((error) => error.file === 'verification.json'));
  assert.equal(corrupt.missing.includes('verification'), false, 'corrupt must not read as absent');
});

test('scoring is deterministic and renormalizes weights around unmeasurable pillars', async () => {
  const runDir = await writeRunDir();
  const first = await scoreFactoryRun(runDir, baseSpec);
  const second = await scoreFactoryRun(runDir, baseSpec);
  assert.deepEqual(first, second);

  // interview/adaptation/scope measurable here; interviewRequired=false -> null.
  assert.equal(first.scores.interviewQuality, null);
  const measured = Object.entries(first.scores).filter(([name, value]) => name !== 'overall' && value !== null);
  assert.ok(measured.length >= 4);
  const weights = first.weights;
  const totalWeight = measured.reduce((sum, [name]) => sum + weights[name], 0);
  const manual = measured.reduce((sum, [name, value]) => sum + value * weights[name], 0) / totalWeight;
  assert.equal(first.scores.overall, round(manual));
});

test('interview presence: required but absent is penalized; not required is unmeasured', async () => {
  const runDir = await writeRunDir();
  const absent = await scoreFactoryRun(runDir, { ...baseSpec, interviewRequired: true, expectedInterviewRounds: { min: 1, max: 2 }, expectedTopics: ['links'] });
  assert.equal(absent.pillars.interviewQuality.components.presence, 0);
  assert.ok(absent.pillars.interviewQuality.warnings.some((warning) => /requires an interview but no interview decisions/.test(warning)));

  const notRequired = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(notRequired.scores.interviewQuality, null);
});

test('interview efficiency penalizes under- and over-questioning at round granularity', async () => {
  const rounds = (count) => Array.from({ length: count }, (_, index) => ({
    stage: 'grill',
    role: 'planner',
    question: `Q: which links belong in the navbar section round ${index}?`,
    optionId: 'answered',
    answer: `Put home, services and contact links in the navbar section, round ${index} detail${index}extra`,
    decisionRequestId: `req-${index}`,
  }));
  const runDir = await writeRunDir({ interviewDecisions: rounds(5) });
  const over = await scoreFactoryRun(runDir, { ...baseSpec, interviewRequired: true, expectedInterviewRounds: { min: 1, max: 2 }, expectedTopics: ['links'] });
  assert.equal(over.pillars.interviewQuality.components.roundCount, 5);
  assert.ok(over.pillars.interviewQuality.components.efficiency < 1);
  assert.ok(over.pillars.interviewQuality.warnings.some((warning) => /expected at most 2/.test(warning)));

  const single = await writeRunDir({ interviewDecisions: rounds(1) });
  const under = await scoreFactoryRun(single, { ...baseSpec, interviewRequired: true, expectedInterviewRounds: { min: 3, max: 4 }, expectedTopics: ['links'] });
  assert.ok(under.pillars.interviewQuality.components.efficiency < 1);
  assert.ok(under.pillars.interviewQuality.warnings.some((warning) => /expected at least 3/.test(warning)));
});

test('interview-to-plan continuity uses distinctive answer words, never echoed questions', async () => {
  const carried = [{
    stage: 'grill',
    role: 'planner',
    question: 'Q1: Which search platform?',
    optionId: 'answered',
    answer: 'Use MongoDB text search only; do not add elasticsearch.',
    decisionRequestId: 'req-1',
  }];
  const withPlan = await writeRunDir({
    interviewDecisions: carried,
    plan: { summary: 'Add navbar with MongoDB text search.', planText: 'Use MongoDB text search only; add no elasticsearch dependency.' },
  });
  const scored = await scoreFactoryRun(withPlan, { ...baseSpec, interviewRequired: true, expectedTopics: ['search'] });
  assert.equal(scored.pillars.handoffQuality.components.interviewToPlan, 1);

  // Answer that echoes the question verbatim -> zero distinctive content.
  const echoed = [{ ...carried[0], answer: 'Q1: Which search platform?' }];
  const echoRun = await writeRunDir({ interviewDecisions: echoed });
  const echoScored = await scoreFactoryRun(echoRun, { ...baseSpec, interviewRequired: true, expectedTopics: ['search'] });
  assert.equal(echoScored.pillars.handoffQuality.components.interviewToPlan, null);
  assert.ok(echoScored.pillars.handoffQuality.warnings.some((warning) => /not measurable/.test(warning)));
});

test('empty contract cannot raise any pillar score', async () => {
  const runDir = await writeRunDir({
    verification: {
      cwd: '/app',
      cwdResolution: 'default-root',
      commands: [{ name: 'automated-checks', command: '', status: 'missing', stderr: 'none configured' }],
      overallStatus: 'incomplete',
      selectionSource: 'ai',
      evidence: { selectedCandidate: { path: '/app' }, allowedCommands: [], commandDecisions: [{ name: 'test', configured: false, selected: false }] },
      contract: { plan: { requirements: [] }, results: [], overallStatus: 'PASS', canComplete: true },
    },
    summary: { verificationStatus: 'incomplete', status: 'BLOCKED', phase: 'merge-blocked' },
  });
  const scored = await scoreFactoryRun(runDir, { ...baseSpec, expectedVerificationStatus: 'incomplete' });
  assert.equal(scored.pillars.handoffQuality.components.verificationContext, 0);
  assert.ok(scored.pillars.handoffQuality.warnings.some((warning) => /contract status ignored as non-evidence/.test(warning)));
  // No commands configured or discovered -> adaptation unmeasurable, not 1.0.
  assert.equal(scored.scores.adaptationQuality, null);
  assert.ok(scored.pillars.adaptationQuality.warnings.some((warning) => /would fake a pass/.test(warning)));
});

test('timing separates human wait from agent time and reports handoff latencies', async () => {
  const runDir = await writeRunDir({
    decisions: [
      { type: 'request', request: { id: 'req-1' }, result: undefined },
      { type: 'resolution', result: { requestId: 'req-1', optionId: 'answered' } },
    ],
    events: [
      { timestamp: '2026-08-30T08:00:00.000Z', type: 'run.created', data: {} },
      { timestamp: '2026-08-30T08:00:10.000Z', type: 'phase.discovery', data: {} },
      { timestamp: '2026-08-30T08:00:20.000Z', type: 'decision.required', data: {} },
      { timestamp: '2026-08-30T08:02:20.000Z', type: 'decision.resolved', data: {} },
      { timestamp: '2026-08-30T08:02:30.000Z', type: 'phase.planning', data: {} },
      { timestamp: '2026-08-30T08:02:40.000Z', type: 'phase.plan-approval', data: {} },
      { timestamp: '2026-08-30T08:02:50.000Z', type: 'phase.implementation', data: {} },
      { timestamp: '2026-08-30T08:03:00.000Z', type: 'phase.verification', data: {} },
      { timestamp: '2026-08-30T08:03:10.000Z', type: 'phase.review', data: {} },
      { timestamp: '2026-08-30T08:03:20.000Z', type: 'phase.approval-ready', data: {} },
      { timestamp: '2026-08-30T08:03:30.000Z', type: 'phase.landing-planning', data: {} },
      { timestamp: '2026-08-30T08:03:40.000Z', type: 'run.completed', data: {} },
    ],
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.timing.totalMs, 220_000);
  assert.equal(scored.timing.humanWaitMs, 120_000);
  assert.equal(scored.timing.agentMs, 100_000);
  assert.equal(scored.timing.handoffs['phase.review->phase.approval-ready'], 10_000);
  assert.equal(scored.timing.handoffs['run.created->phase.discovery'], 10_000);
  // Missing terminal phase for an unknown ordering stays null, never zero.
  assert.equal(scored.timing.handoffs['phase.plan-approval->phase.implementation'], 10_000);
});

test('mergeQuality: legacy skipped-on-failed-merge is penalized and labeled', async () => {
  const runDir = await writeRunDir({
    raw: {
      'final-merge.json': JSON.stringify({
        mergeBaseBranch: 'main',
        mergeCwd: '/app',
        status: 'skipped',
        reason: 'Command failed: git merge --no-ff --no-edit factory/x\nerror: Your local changes would be overwritten',
      }),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.mergeQuality.components.landed, 0);
  assert.ok(scored.pillars.mergeQuality.warnings.some((warning) => /predates landing outcomes/.test(warning)));
  assert.ok(scored.pillars.mergeQuality.warnings.some((warning) => /failed git merge/.test(warning)));
});

test('mergeQuality: guard blocking on incomplete verification is scored as an incorrect guard', async () => {
  const runDir = await writeRunDir({
    raw: {
      'landing-plan.json': JSON.stringify({
        strategy: 'merge', targetBranch: 'main', reasoning: [], verification: [], risk: 'medium',
        expectedFiles: ['components/Navbar.tsx'],
        guardVerdict: { ok: false, reasons: ['Required landing cannot execute while verification is incomplete.'] },
      }),
      'landing-diagnosis-1.json': JSON.stringify({ kind: 'dirty-target', reasoning: [], retryable: true, recoveryAction: 'block', risk: 'medium', recoveryHint: 'clean the checkout' }),
      'final-merge.json': JSON.stringify({ mergeBaseBranch: 'main', mergeCwd: '/app', status: 'blocked', outcome: 'dirty-checkout', strategy: 'merge', reason: 'guard', recoveryHint: 'x' }),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.mergeQuality.components.guardCorrectness, 0);
  assert.equal(scored.pillars.mergeQuality.components.diagnosisAccuracy, 0);
  assert.ok(scored.pillars.mergeQuality.warnings.some((warning) => /mislabeled cause/.test(warning)));
});

test('adaptationQuality measures cwd choice, stale commands, and invention', async () => {
  const runDir = await writeRunDir({
    verification: {
      cwd: '/app/frontend/app',
      cwdResolution: 'inferred-single-package',
      commands: [{ name: 'lint', command: 'npm exec eslint src', status: 'passed' }],
      overallStatus: 'passed',
      selectionSource: 'ai',
      evidence: { selectedCandidate: { path: '/app/frontend/app' }, allowedCommands: ['npm exec eslint src'], commandDecisions: [{ name: 'lint', configured: true, selected: true }] },
      contract: { plan: { requirements: [{ id: 'r' }] }, results: [{ requirementId: 'r' }], overallStatus: 'PASS', canComplete: true },
    },
  });
  const good = await scoreFactoryRun(runDir, { ...baseSpec, expectedVerificationCwd: 'frontend/app', staleCommands: ['next lint'], allowedCommands: ['npm exec eslint src'] });
  assert.equal(good.scores.adaptationQuality, 1);

  const staleSpec = { ...baseSpec, expectedVerificationCwd: 'backend', staleCommands: ['npm exec eslint src'], allowedCommands: ['other'] };
  const bad = await scoreFactoryRun(runDir, staleSpec);
  assert.ok(bad.scores.adaptationQuality < 1);
  assert.ok(bad.pillars.adaptationQuality.warnings.some((warning) => /stale command still executed/.test(warning)));
  assert.ok(bad.pillars.adaptationQuality.warnings.some((warning) => /outside the allowed set/.test(warning)));
});

test('scopeQuality penalizes drift beyond expected files and non-goal violation', async () => {
  const runDir = await writeRunDir({
    raw: {
      'completed-tasks.json': JSON.stringify([{
        taskId: 'task-1', targetBranch: 'main', sourceBranch: 'factory/x', commitSha: 'abc',
        changedFiles: ['components/Navbar.tsx', 'components/Sidebar.tsx', 'app/legacy.ts'], workspaceMode: 'in-place',
      }]),
    },
  });
  const scored = await scoreFactoryRun(runDir, { ...baseSpec, forbiddenFiles: ['app/legacy.ts'] });
  assert.ok(scored.pillars.scopeQuality.components.scopeDiscipline < 1);
  assert.equal(scored.pillars.scopeQuality.components.nonGoalsRespected, 0);
  assert.ok(scored.pillars.scopeQuality.warnings.some((warning) => /non-goals violated/.test(warning)));
});

test('routing instability across retries is surfaced as a signal', async () => {
  const runDir = await writeRunDir({
    modelLedger: [
      { operationId: 'o1', role: 'planner', taskType: 'general', taskTypeSource: 'default', requestedModel: 'm1', resolvedModel: 'm1', modelSource: 'role-default', timestamp: '2026-08-30T08:00:00.000Z' },
      { operationId: 'o2', role: 'planner', taskType: 'general', taskTypeSource: 'default', requestedModel: 'm1', resolvedModel: 'm2', modelSource: 'role-default', timestamp: '2026-08-30T08:00:01.000Z' },
    ],
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.signals.routingStableAcrossRetries, false);
  assert.deepEqual(scored.signals.routingUnstableRoles, ['planner']);
});

test('oracle trials carry diagnostics only and are excluded from statistics', async () => {
  const runDir = await writeRunDir();
  const oracle = await scoreFactoryRun(runDir, baseSpec, { trialKind: 'oracle' });
  assert.equal(oracle.trialKind, 'oracle');
  assert.ok(oracle.warnings.some((warning) => /must not enter benchmark statistics/.test(warning)));

  const agentReport = await scoreFactoryRun(runDir, baseSpec);
  const summary = summarizeBenchmarkResults([
    { trialKind: 'oracle', taskSuccess: 1 },
    { trialKind: 'agent', taskSuccess: 1, report: agentReport },
    { trialKind: 'agent', taskSuccess: 0, report: { ...agentReport, scores: { ...agentReport.scores, overall: 0.5 } } },
  ]);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.excludedOracleTrials, 1);
  assert.equal(summary.successRate, 0.5);
  assert.equal(summary.bestScore, agentReport.scores.overall);
  assert.equal(summary.worstScore, 0.5);
  assert.equal(summary.medianScore, (agentReport.scores.overall + 0.5) / 2);
});

test('aggregator fails loud on ambiguous input instead of averaging holes', () => {
  assert.throws(() => summarizeBenchmarkResults([]), /no trials provided/);
  assert.throws(() => summarizeBenchmarkResults([{ trialKind: 'mystery' }]), /unknown trialKind/);
  assert.throws(() => summarizeBenchmarkResults([{ trialKind: 'oracle', taskSuccess: 1 }]), /only 1 oracle trial/);
  assert.throws(() => summarizeBenchmarkResults([{ trialKind: 'agent' }]), /missing factory score/);
  assert.throws(
    () => summarizeBenchmarkResults([{ trialKind: 'agent', report: { trialKind: 'oracle' } }]),
    /labelled "oracle"/,
  );
  assert.throws(
    () => summarizeBenchmarkResults([{ trialKind: 'agent', report: { trialKind: 'agent', scores: { overall: 0.5 }, timing: { totalMs: 1, agentMs: 1 }, pillars: { interviewQuality: { components: {} } } } }]),
    /missing taskSuccess/,
  );
});

test('scorer reports unmeasurable pillars as null and never crashes on partial runs', async () => {
  const runDir = await writeRunDir({ omit: ['plan.json', 'verification.json', 'final-merge.json', 'landing-plan.json', 'completed-tasks.json'] });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.scores.handoffQuality, null);
  assert.equal(scored.scores.mergeQuality, null);
  assert.equal(scored.scores.adaptationQuality, null);
  assert.ok(scored.warnings.some((warning) => /artifact missing: plan/.test(warning)));
  assert.equal(scored.scores.executionQuality === null, false);
});

test('handoff: nonGoalsSurviveToLanding and landingMatchesBuild are 1 on a good run', async () => {
  const runDir = await writeRunDir();
  const scored = await scoreFactoryRun(runDir, { ...baseSpec, forbiddenFiles: ['components/Sidebar.tsx'] });
  assert.equal(scored.pillars.handoffQuality.components.nonGoalsSurviveToLanding, 1);
  assert.equal(scored.pillars.handoffQuality.components.landingMatchesBuild, 1);
});

test('handoff: landing shipping a forbidden file scores 0 with warning', async () => {
  const runDir = await writeRunDir({
    raw: {
      'landing-plan.json': JSON.stringify({
        strategy: 'merge', targetBranch: 'main', reasoning: [], verification: ['test'], risk: 'low',
        expectedFiles: ['components/Navbar.tsx', 'components/Sidebar.tsx'],
        guardVerdict: { ok: true, reasons: [] },
      }),
    },
  });
  const scored = await scoreFactoryRun(runDir, { ...baseSpec, forbiddenFiles: ['components/Sidebar.tsx'] });
  assert.equal(scored.pillars.handoffQuality.components.nonGoalsSurviveToLanding, 0);
  assert.ok(scored.pillars.handoffQuality.warnings.some((warning) => /outside forbidden set/.test(warning)));
});

test('handoff: landing shipping an unbuilt file scores 0 for landingMatchesBuild', async () => {
  const runDir = await writeRunDir({
    raw: {
      'landing-plan.json': JSON.stringify({
        strategy: 'merge', targetBranch: 'main', reasoning: [], verification: ['test'], risk: 'low',
        expectedFiles: ['components/Navbar.tsx', 'components/Unbuilt.tsx'],
        guardVerdict: { ok: true, reasons: [] },
      }),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.landingMatchesBuild, 0);
  assert.ok(scored.pillars.handoffQuality.warnings.some((warning) => /not in the built set/.test(warning)));
});

test('handoff: missing landing plan makes both signals null, not 0', async () => {
  const runDir = await writeRunDir({ omit: ['landing-plan.json'] });
  const scored = await scoreFactoryRun(runDir, { ...baseSpec, forbiddenFiles: ['components/Sidebar.tsx'] });
  assert.equal(scored.pillars.handoffQuality.components.nonGoalsSurviveToLanding, null);
  assert.equal(scored.pillars.handoffQuality.components.landingMatchesBuild, null);
});

test('handoff: no forbiddenFiles in spec makes nonGoalsSurviveToLanding null', async () => {
  const runDir = await writeRunDir();
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.nonGoalsSurviveToLanding, null);
  assert.equal(scored.pillars.handoffQuality.components.landingMatchesBuild, 1);
});

test('planToBuilder measures build execution, not stale plan status', async () => {
  // Plan build task stays "pending" (Factory never updates plan.json statuses)
  // but completed-tasks proves execution -> signal must be 1, not 0.
  const runDir = await writeRunDir({
    plan: { tasks: [
      { id: 'task-1', title: 'discover', stage: 'discover', status: 'done', dependsOn: [] },
      { id: 'task-2', title: 'plan', stage: 'plan', status: 'done', dependsOn: ['task-1'] },
      { id: 'task-3', title: 'build', stage: 'build', status: 'pending', dependsOn: ['task-2'] },
      { id: 'task-4', title: 'verify', stage: 'verify', status: 'pending', dependsOn: ['task-3'] },
    ] },
    raw: {
      'completed-tasks.json': JSON.stringify([{ taskId: 'task-3', targetBranch: 'main', sourceBranch: 'factory/x', commitSha: 'abc', changedFiles: ['components/Navbar.tsx'], workspaceMode: 'in-place' }]),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.planToBuilder, 1, 'build task executed despite pending plan status');
});

test('planToBuilder is 0 when plan build task has no completed-task record', async () => {
  const runDir = await writeRunDir({
    plan: { tasks: [{ id: 'task-9', title: 'build', stage: 'build', status: 'pending', dependsOn: [] }] },
    raw: { 'completed-tasks.json': JSON.stringify([]) },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.planToBuilder, 0);
  assert.ok(scored.pillars.handoffQuality.warnings.some((warning) => /no completed task/.test(warning)));
});

test('reviewerAgreement ignores benign "block"/"fail" mentions and reads the conclusion', async () => {
  // Transcript says "the form block" and "would fail if" mid-review, but the
  // conclusion is positive -> agreement (1), not disagreement (0).
  const runDir = await writeRunDir({
    raw: {
      'reviewer-execution.json': JSON.stringify({
        executionId: 'r', status: 'completed',
        outputText: 'Let me check the form block and nav wording. The tests would fail if the ids changed. '
          + 'I verified the candidate satisfies every constraint, stays within scope, '
          + 'keeps both repo checks green, and is ready for approval.',
        events: [],
      }),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.reviewerAgreement, 1);
  assert.ok(!scored.pillars.handoffQuality.warnings.some((warning) => /reviewer reported/.test(warning)), 'no false disagreement warning');
});

test('reviewerAgreement is 0 when the conclusion explicitly blocks while controller completed', async () => {
  const runDir = await writeRunDir({
    raw: {
      'reviewer-execution.json': JSON.stringify({
        executionId: 'r', status: 'completed',
        outputText: 'The candidate changes files outside scope. This is not ready for approval; must fix the scope drift first.',
        events: [],
      }),
    },
  });
  const scored = await scoreFactoryRun(runDir, baseSpec);
  assert.equal(scored.pillars.handoffQuality.components.reviewerAgreement, 0);
  assert.ok(scored.pillars.handoffQuality.warnings.some((warning) => /reviewer reported/.test(warning)));
});
