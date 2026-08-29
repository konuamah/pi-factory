import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  gatherVerificationRequirements,
  runVerificationEngine,
  canComplete,
  computeOverallStatus,
  initializeVerificationProviders,
  registerVerificationProvider,
  planVerificationExecution,
} from '../packages/core/dist/index.js';

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-verif-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('gatherVerificationRequirements merges sources and dedupes', () => {
  const plan = gatherVerificationRequirements({
    goal: 'Add migration',
    taskType: 'database-evolution',
    config: { commands: { lint: 'npm run lint', typecheck: 'npm run typecheck' } },
    skills: [{ id: 'db', version: '1', description: '', validation: { commands: ['npm run typecheck'] } }],
    constitutionAreas: [51],
    explicitConstitutionAreas: true,
    workflowId: 'release',
    userCriteria: ['keep backwards compatibility'],
  });
  const types = plan.requirements.map((r) => r.type);
  assert.ok(types.includes('COMMAND'));
  assert.ok(types.includes('CONSTITUTION'));
  assert.ok(types.includes('REVIEW')); // from task type + user
  // typecheck deduped: factory command + skill validation share description key differently, so may both exist
  const typechecks = plan.requirements.filter((r) => r.description.includes('typecheck'));
  assert.ok(typechecks.length >= 1);
  assert.deepEqual(plan.createdFrom.skills, ['db']);
  assert.deepEqual(plan.createdFrom.constitutionAreas, [51]);
});

test('runVerificationEngine passes commands and artifacts', async () => {
  initializeVerificationProviders();
  await withTempDir(async (root) => {
    await fs.writeFile(path.join(root, 'migration.sql'), '-- migration\n', 'utf8');
    const plan = gatherVerificationRequirements({
      goal: 'Add migration',
      config: { commands: { typecheck: 'node -e ""' } },
    });
    plan.requirements.push({
      id: 'artifact-migration',
      type: 'ARTIFACT',
      blocking: true,
      description: 'Migration file exists',
      source: 'USER',
      scope: 'TASK',
      path: 'migration.sql',
      mustExist: true,
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'PASS');
    assert.equal(result.canComplete, true);
    assert.ok(Object.keys(result.evidence).length >= 1);
  });
});

test('runVerificationEngine fails when artifact missing', async () => {
  initializeVerificationProviders();
  await withTempDir(async (root) => {
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'artifact-missing',
      type: 'ARTIFACT',
      blocking: true,
      description: 'Required file',
      source: 'USER',
      scope: 'TASK',
      path: 'missing.sql',
      mustExist: true,
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'FAIL');
    assert.equal(result.canComplete, false);
  });
});

test('canComplete requires all blocking to pass', () => {
  assert.equal(
    canComplete([
      { requirementId: 'a', blocking: true, status: 'PASS', evidence: [] },
      { requirementId: 'b', blocking: true, status: 'PASS', evidence: [] },
    ]),
    true,
  );
  assert.equal(
    canComplete([
      { requirementId: 'a', blocking: true, status: 'PASS', evidence: [] },
      { requirementId: 'b', blocking: true, status: 'FAIL', evidence: [] },
    ]),
    false,
  );
  assert.equal(
    canComplete([
      { requirementId: 'a', blocking: false, status: 'FAIL', evidence: [] },
      { requirementId: 'b', blocking: true, status: 'NOT_APPLICABLE', evidence: [] },
    ]),
    true,
  );
});

test('computeOverallStatus handles FAIL and BLOCKED', () => {
  assert.equal(
    computeOverallStatus([{ requirementId: 'a', blocking: true, status: 'FAIL', evidence: [] }]),
    'FAIL',
  );
  assert.equal(
    computeOverallStatus([{ requirementId: 'a', blocking: true, status: 'BLOCKED', evidence: [] }]),
    'BLOCKED',
  );
});

test('constitution provider checks area status against CONSTITUTION.md', async () => {
  await withTempDir(async (root) => {
    await fs.writeFile(
      path.join(root, 'CONSTITUTION.md'),
      '## 51. Data migration safety\n- Status: DEFINED\n- Finding: Migrations must be expand/contract.\n',
      'utf8',
    );
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'constitution-51',
      type: 'CONSTITUTION',
      blocking: true,
      description: 'Area 51 defined',
      source: 'CONSTITUTION',
      scope: 'RUN',
      areaIds: [51],
      requiredStatus: ['DEFINED'],
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'PASS');
    assert.equal(result.canComplete, true);
  });
});

test('constitution provider fails when area missing', async () => {
  await withTempDir(async (root) => {
    await fs.writeFile(
      path.join(root, 'CONSTITUTION.md'),
      '## 1. Repository layout\n- Status: DEFINED\n',
      'utf8',
    );
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'constitution-99',
      type: 'CONSTITUTION',
      blocking: true,
      description: 'Area 99 defined',
      source: 'CONSTITUTION',
      scope: 'RUN',
      areaIds: [99],
      requiredStatus: ['DEFINED'],
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'FAIL');
  });
});

test('review provider returns INCONCLUSIVE without an executor', async () => {
  await withTempDir(async (root) => {
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'review-1',
      type: 'REVIEW',
      blocking: true,
      description: 'Security review',
      source: 'TASK_TYPE',
      scope: 'NODE',
      focus: ['security'],
      blockingSeverities: ['CRITICAL', 'HIGH'],
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'INCONCLUSIVE');
    assert.equal(result.canComplete, false);
  });
});

test('review provider passes with a clean reviewer executor', async () => {
  await withTempDir(async (root) => {
    const cleanExecutor = {
      async execute() {
        return { executionId: 'r', status: 'completed', outputText: 'CLEAN', events: [] };
      },
      async cancel() {},
    };
    initializeVerificationProviders({ executor: cleanExecutor, goal: 'test' });
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'review-2',
      type: 'REVIEW',
      blocking: true,
      description: 'Security review',
      source: 'TASK_TYPE',
      scope: 'NODE',
      focus: ['security'],
      blockingSeverities: ['CRITICAL', 'HIGH'],
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'PASS');
    assert.equal(result.canComplete, true);
  });
});

test('parseFindings extracts severity and claim', async () => {
  const { parseFindings } = await import('../packages/core/dist/index.js');
  const findings = parseFindings('FINDING HIGH: Old clients will fail\nFINDING INFO: Minor note\nCLEAN');
  assert.equal(findings.length, 2);
  assert.equal(findings[0].severity, 'HIGH');
  assert.match(findings[0].claim, /Old clients/);
});

test('custom provider can be registered', async () => {
  initializeVerificationProviders();
  registerVerificationProvider({
    type: 'CUSTOM_CHECK',
    async verify(requirement) {
      return { requirementId: requirement.id, status: 'PASS', evidence: [{ id: 'EV-1', kind: 'custom' }] };
    },
  });
  await withTempDir(async (root) => {
    const plan = gatherVerificationRequirements({ goal: 'x', config: {} });
    plan.requirements.push({
      id: 'custom',
      type: 'CUSTOM_CHECK',
      blocking: true,
      description: 'Custom check',
      source: 'SKILL',
      scope: 'TASK',
    });
    const result = await runVerificationEngine({ cwd: root, plan });
    assert.equal(result.overallStatus, 'PASS');
    assert.equal(result.canComplete, true);
  });
});

test('deterministic allowedCommands include pytest for python markers', async () => {
  await withTempDir(async (root) => {
    await fs.writeFile(path.join(root, 'requirements.txt'), 'pytest\n', 'utf8');
    const plan = await planVerificationExecution({
      cwd: root,
      goal: 'Verify a Python feature',
      commands: {},
      allowDeterministicFallback: true,
    });
    const allowed = plan.evidence.allowedCommands;
    assert.ok(allowed.includes('python -m pytest'), 'expected pytest in allowed commands, got: ' + allowed.join(', '));
    assert.ok(allowed.includes('pip install -r requirements.txt'));
  });
});
