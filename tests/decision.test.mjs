import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendDecisionLedgerEntry, readDecisionLedger, findPendingDecision, parseInterviewQuestions } from '../packages/core/dist/index.js';
import { normalizeInterviewOutput } from '../packages/core/dist/runtime/controller-interview.js';

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

test('parseInterviewQuestions extracts explicit options and recommendation', () => {
  const questions = parseInterviewQuestions([
    'Q1 - Search strategy: Which implementation should govern?',
    '',
    'Options:',
    '[A] MongoDB text search — Simpler and uses existing indexes',
    '[B] Regex fallback — Broader but less precise',
    '',
    '-> Prefer MongoDB text search unless ranking semantics require more.',
  ].join('\n'));

  assert.equal(questions.length, 1);
  assert.match(questions[0].prompt, /Search strategy/);
  assert.equal(questions[0].options.length, 2);
  assert.deepEqual(questions[0].options[0], {
    id: 'a',
    label: 'MongoDB text search',
    description: 'Simpler and uses existing indexes',
  });
  assert.deepEqual(questions[0].options[1], {
    id: 'b',
    label: 'Regex fallback',
    description: 'Broader but less precise',
  });
  assert.match(questions[0].recommendation ?? '', /Prefer MongoDB/);
});

test('parseInterviewQuestions ignores malformed options blocks and preserves free-text prompt', () => {
  const questions = parseInterviewQuestions([
    'Q1: Which clients should this cover?',
    '',
    'Options:',
    'Web and mobile',
    '',
    '-> Both if parity is expected.',
  ].join('\n'));

  assert.equal(questions.length, 1);
  assert.equal(questions[0].options.length, 0);
  assert.match(questions[0].prompt, /Web and mobile/);
  assert.match(questions[0].recommendation ?? '', /Both if parity/);
});

test('parseInterviewQuestions does not treat Markdown rules as question separators', () => {
  const questions = parseInterviewQuestions([
    '# Project specification',
    '',
    '---',
    '',
    '## Implementation notes',
    '',
    'Use the existing API.',
  ].join('\n'));

  assert.equal(questions.length, 1);
  assert.match(questions[0].prompt, /Project specification/);
  assert.match(questions[0].prompt, /Implementation notes/);
});

test('interview output rejects echoed instructions and keeps concrete questions', () => {
  assert.equal(normalizeInterviewOutput([
    'Role: Interview',
    'Format a round like this:',
    'Q1 - <question title>',
  ].join('\n')), undefined);
  assert.equal(normalizeInterviewOutput([
    'Here is the round:',
    'Q1 - Which date behavior should apply?',
    '',
    '---',
    'Q2 - Which clients need it?',
  ].join('\n')), 'Q1 - Which date behavior should apply?\n\n---\nQ2 - Which clients need it?');
});
