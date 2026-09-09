import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { queryRun } from '../packages/core/dist/index.js';

async function withRun(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-query-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'query-fixture', type: 'module' }));
    const runDir = path.join(root, '.factory', 'runs', 'run_test');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId: 'run_test', status: 'COMPLETED', phase: 'accepted' }));
    for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(runDir, name), typeof value === 'string' ? value : JSON.stringify(value));
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('queryRun returns normalized acceptance evidence, including reviewer blocks', async () => {
  await withRun({
    'final-merge.json': { phase: 'complete', landingStatus: 'landed', targetHeadBefore: 'before', targetHeadAfter: 'after', postLandingVerification: { status: 'passed', commands: ['npm test'], repairAttempted: false } },
    'events.jsonl': JSON.stringify({ type: 'acceptance.accepted', data: { landingStatus: 'landed', evidence: { reviewVerdict: { verdict: 'block', summary: 'Not ready for approval.' }, verificationStatus: 'passed', contractComplete: true, baselineDebt: [{ commandName: 'lint', category: 'baseline', reason: 'old issue', suggestedAction: 'fix later' }], scopeWarnings: [{ file: 'x.js', nonGoal: 'not requested' }] } } }),
  }, async (root) => {
    const detail = await queryRun(root, 'run_test');
    assert.equal(detail.acceptanceEvidence.decision, 'accept');
    assert.equal(detail.acceptanceEvidence.reviewVerdict.verdict, 'block');
    assert.equal(detail.acceptanceEvidence.landingStatus, 'landed');
    assert.equal(detail.acceptanceEvidence.postLandingVerification.overallStatus, 'passed');
    assert.equal(detail.acceptanceEvidence.baselineDebt.length, 1);
  });
});

test('queryRun omits acceptance evidence for legacy runs', async () => {
  await withRun({ 'summary.json': { title: 'Legacy run' } }, async (root) => {
    const detail = await queryRun(root, 'run_test');
    assert.equal('acceptanceEvidence' in detail, false);
  });
});
