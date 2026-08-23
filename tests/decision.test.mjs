import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendDecisionLedgerEntry, readDecisionLedger, findPendingDecision } from '../packages/core/dist/index.js';

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-decision-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('decision ledger persists request then resolution and finds pending', async () => {
  await withTempDir(async (root) => {
    const request = {
      id: 'decision-17',
      title: 'API compatibility conflict',
      question: 'Which behavior should govern?',
      options: [
        { id: 'preserve', label: 'Preserve it' },
        { id: 'remove', label: 'Remove it' },
      ],
      evidenceRefs: ['EV-41', 'EV-53'],
      source: 'REVIEWER',
      reason: 'CONFLICT',
    };
    await appendDecisionLedgerEntry(root, { type: 'request', request });

    const pending = await findPendingDecision(root);
    assert.equal(pending?.id, 'decision-17');

    await appendDecisionLedgerEntry(root, {
      type: 'resolution',
      result: { requestId: 'decision-17', optionId: 'preserve', feedback: 'Maintain until v3', decidedAt: new Date().toISOString() },
    });

    const entries = await readDecisionLedger(root);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'request');
    assert.equal(entries[1].type, 'resolution');
    assert.equal(await findPendingDecision(root), undefined);
  });
});
