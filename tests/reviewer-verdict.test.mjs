import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyReviewerVerdict } from '../packages/core/dist/runtime/review-surface.js';

test('classifyReviewerVerdict: explicit block verdict', () => {
  const output = [
    '**Finding**',
    '- High — consent flow regression: the tag now loads unconditionally.',
    '',
    '**What needs to change**',
    '- Restore consent-aware loading.',
    '',
    'Not ready for approval.',
  ].join('\n');
  assert.equal(classifyReviewerVerdict(output), 'block');
});

test('classifyReviewerVerdict: explicit pass verdict', () => {
  const output = 'Ready for approval. Deterministic review passed for a trivial scoped change; verification passed; no high-risk files or scope violations were detected.';
  assert.equal(classifyReviewerVerdict(output), 'pass');
});

test('classifyReviewerVerdict: blocking headline is honored when recommendation omits block words', () => {
  const output = [
    'Not ready for approval yet.',
    '',
    'Findings:',
    '- Blocking scope/repository hygiene issue: backend/tasks.db is committed as a binary runtime database.',
    '- Missing behavior-specific verification: setup/lint/build passed, but restart persistence was not smoke tested.',
    '',
    'Recommendation:',
    '- Remove backend/tasks.db from the commit.',
    '- Add/confirm ignore coverage for the runtime DB if allowed by the task scope.',
    '- Run a restart persistence smoke test before approval.',
  ].join('\n');
  assert.equal(classifyReviewerVerdict(output), 'block');
});

test('classifyReviewerVerdict: "looks ready; ship it" passes', () => {
  const output = 'The change is scoped correctly, verification passed, looks ready. Ship it.';
  assert.equal(classifyReviewerVerdict(output), 'pass');
});

test('classifyReviewerVerdict: mid-transcript negative mentions do not block', () => {
  const output = [
    'Notes: the form block would fail if the API changed, but the current contract is stable.',
    'No issues found in the diff.',
    'Ready for approval.',
  ].join('\n');
  assert.equal(classifyReviewerVerdict(output), 'pass');
});

test('classifyReviewerVerdict: cannot approve blocks', () => {
  const output = 'The consent flow regressed and I cannot approve this candidate. Needs rework before merge.';
  assert.equal(classifyReviewerVerdict(output), 'block');
});

test('classifyReviewerVerdict: empty or ambiguous output is unknown', () => {
  assert.equal(classifyReviewerVerdict(''), 'unknown');
  assert.equal(classifyReviewerVerdict('Review completed with a couple of notes.'), 'unknown');
});

test('classifyReviewerVerdict: negated "ready" must not pass', () => {
  const output = 'This is not ready for approval because the consent flow changed.';
  assert.equal(classifyReviewerVerdict(output), 'block');
});

test('evaluateDeterministicReview refuses trivial pass when a plan target file is untouched', async () => {
  const { evaluateDeterministicReview } = await import('../packages/core/dist/runtime/review-surface.js');
  const surface = {
    changedFiles: ['script.js'],
    directImports: [],
    planTargetFiles: ['index.html', 'script.js'],
    planNonGoals: [],
    nonGoalViolations: [],
    highRiskFiles: [],
    diff: { ok: true, truncated: false, additions: 13, deletions: 0, fileCount: 1, diff: '', strategy: 'per-commit' },
  };
  const verification = {
    overallStatus: 'passed',
    commands: [{ name: 'test', status: 'passed' }],
  };
  const decision = evaluateDeterministicReview(surface, verification, undefined);
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.some((reason) => /plan target files not changed: index\.html/.test(reason)));
});

test('evaluateDeterministicReview still passes trivially when the single plan target is touched', async () => {
  const { evaluateDeterministicReview } = await import('../packages/core/dist/runtime/review-surface.js');
  const surface = {
    changedFiles: ['index.html'],
    directImports: [],
    planTargetFiles: ['index.html'],
    planNonGoals: [],
    nonGoalViolations: [],
    highRiskFiles: [],
    diff: { ok: true, truncated: false, additions: 20, deletions: 7, fileCount: 1, diff: '', strategy: 'per-commit' },
  };
  const verification = {
    overallStatus: 'passed',
    commands: [{ name: 'test', status: 'passed' }],
  };
  const decision = evaluateDeterministicReview(surface, verification, undefined);
  assert.equal(decision.eligible, true);
});

test('evaluateDeterministicReview is not affected when the plan declares no target files', async () => {
  const { evaluateDeterministicReview } = await import('../packages/core/dist/runtime/review-surface.js');
  const surface = {
    changedFiles: ['src/index.ts'],
    directImports: [],
    planTargetFiles: [],
    planNonGoals: [],
    nonGoalViolations: [],
    highRiskFiles: [],
    diff: { ok: true, truncated: false, additions: 1, deletions: 1, fileCount: 1, diff: '', strategy: 'per-commit' },
  };
  const verification = {
    overallStatus: 'passed',
    commands: [{ name: 'test', status: 'passed' }],
  };
  const decision = evaluateDeterministicReview(surface, verification, undefined);
  assert.equal(decision.eligible, true);
});
