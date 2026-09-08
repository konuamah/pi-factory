import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanApprovalPreviewLines,
  requestPlanApprovalDecision,
  buildReviewerFindingLines,
  resolveFinalApprovalConfirm,
  defaultFinalApproval,
} from '../packages/adapters/pi/dist/approval.js';
import { requestDecisionInput } from '../packages/adapters/pi/dist/decision-dialog.js';
import { buildFactoryRunResultTitle } from '../packages/adapters/pi/dist/gateway-prototype.js';

function makePreview() {
  return {
    runId: 'run_demo',
    goal: 'Add a demo feature',
    planPath: '/tmp/plan.json',
    taskCount: 8,
    workflowStages: ['plan', 'build', 'verify'],
    summary: 'Goal: Add a demo feature\nKeep scope narrow\nAvoid risky changes',
    planText: 'Feature Plan\n- Improve the target area\n- Keep changes minimal\nWAITING_FOR_APPROVAL',
    tasks: [
      { stage: 'plan', title: 'Clarify scope' },
      { stage: 'build', title: 'Implement change' },
      { stage: 'verify', title: 'Run checks' },
      { stage: 'review', title: 'Prepare handoff' },
      { stage: 'merge', title: 'Finalize candidate' },
      { stage: 'docs', title: 'Document behavior' },
      { stage: 'follow-up', title: 'Optional cleanup' },
    ],
  };
}

test('plan approval preview includes decision guidance and truncation summary', () => {
  const lines = buildPlanApprovalPreviewLines(makePreview());
  assert.ok(lines.includes('Decision options'));
  assert.ok(lines.includes('Discovery report'));
  assert.ok(lines.includes('Feature plan'));
  assert.ok(lines.includes('- Improve the target area'));
  assert.ok(lines.includes('- Approve: continue to implementation'));
  assert.ok(lines.includes('- Request revisions: pause before implementation'));
  assert.ok(lines.includes('- Reject: cancel this run'));
  assert.ok(lines.some((line) => /and 2 more/.test(line)));
});

test('custom approval dialog can approve directly', async () => {
  const decision = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        component.handleInput?.('a');
        return result;
      },
    },
    makePreview(),
  );

  assert.equal(decision.decision, 'approve');
});

test('custom approval dialog uses Pi theme colors without overflowing width', async () => {
  const theme = {
    fg(color, text) {
      const codes = { accent: 36, muted: 90, dim: 2, success: 32, warning: 33, error: 31 };
      return `\u001b[${codes[color] ?? 37}m${text}\u001b[0m`;
    },
    bold(text) {
      return `\u001b[1m${text}\u001b[22m`;
    },
  };

  const decision = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, theme, undefined, (value) => {
          result = value;
        });
        const lines = component.render(72);
        assert.ok(lines.some((line) => /\u001b\[36m/.test(line)));
        assert.ok(lines.some((line) => /\u001b\[32m/.test(line)));
        assert.ok(lines.every((line) => visibleWidth(line) <= 72));
        component.handleInput?.('a');
        return result;
      },
    },
    {
      ...makePreview(),
      goal: 'Remove a very long upcoming courses entry with enough text to wrap inside the approval dialog',
    },
  );

  assert.equal(decision.decision, 'approve');
});

function visibleWidth(value) {
  let width = 0;
  for (const char of value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += codePoint >= 0x1100 ? 2 : codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) ? 0 : 1;
  }
  return width;
}

test('custom approval dialog can request revisions with feedback', async () => {
  const decision = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        component.handleInput?.('r');
        return result;
      },
      input: async () => ' tighten scope ',
    },
    makePreview(),
  );

  assert.deepEqual(decision, {
    decision: 'revise',
    feedback: 'tighten scope',
  });
});

test('dismissed select request becomes a revision request instead of implicit approval', async () => {
  const decision = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      select: async () => undefined,
    },
    makePreview(),
  );

  assert.equal(decision.decision, 'revise');
  assert.match(decision.feedback ?? '', /dismissed/i);
});

test('select rejection captures trimmed feedback', async () => {
  const decision = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      select: async () => 'Reject — Cancel the run before implementation',
      input: async () => '  needs clearer scope  ',
    },
    makePreview(),
  );

  assert.deepEqual(decision, {
    decision: 'reject',
    feedback: 'needs clearer scope',
  });
});

test('confirm fallback still supports approve/reject behavior', async () => {
  const approved = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      confirm: async () => true,
    },
    makePreview(),
  );
  assert.equal(approved.decision, 'approve');

  const rejected = await requestPlanApprovalDecision(
    {
      notify() {},
      setWidget() {},
      confirm: async () => false,
    },
    makePreview(),
  );
  assert.equal(rejected.decision, 'reject');
});

test('interview decision fails loudly when custom UI is unavailable', async () => {
  await assert.rejects(
    () => requestDecisionInput(
      {
        notify() {},
        setWidget() {},
        input: async () => ' use MongoDB text search only ',
      },
      {
        id: 'interview-1',
        title: 'Interview: grill',
        question: 'Q1: Which search behavior should govern?',
        options: [{ id: 'answered', label: 'Use my answer' }],
        source: 'INTERVIEW',
        reason: 'USER_PREFERENCE',
      },
    ),
    /requires Pi custom UI; no fallback is allowed/,
  );
});

test('interview uses custom overlay when editor is unavailable, one question at a time', async () => {
  const questions = [
    '❓ **Q1** - **What does “keyword search” need to mean for this gap?** Should it match title, description, tags, or all of them?\n\n**Recommended answer:** Include title, description, and tags.',
    '❓ **Q2** - **Which clients should this cover?** Web, mobile, or both?',
    '❓ **Q3** - **Should results prioritize relevance or recency?**',
    '❓ **Q4** - **What empty state should users see?**',
    '❓ **Q5** - **Should we add metrics now?**',
    '❓ **Q6** - **What verification should prove this works?**',
  ].join('\n\n---\n\n');
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      custom: async (factory, options) => {
        assert.equal(options?.overlay, true);
        assert.equal(options?.overlayOptions?.width, '95%');
        assert.equal(options?.overlayOptions?.maxHeight, 22);
        assert.equal(options?.overlayOptions?.anchor, 'top-center');
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        const lines = component.render(75);
        assert.equal(lines.length, 22);
        assert.ok(lines.every((line) => visibleWidth(line) <= 75));
        const title = lines.find((line) => /Question \d of 6/.test(line));
        const match = title ? /Question (\d) of 6/.exec(title) : null;
        const index = match ? Number(match[1]) : NaN;
        assert.ok(Number.isFinite(index), 'expected Question N of 6 header');
        const qStarts = [
          'What does',
          'Which clients',
          'Should results',
          'What empty state',
          'Should we add',
          'What verification',
        ];
        assert.ok(lines.some((line) => line.includes(qStarts[index - 1])), 'current question text should be visible');
        assert.ok(lines.some((line) => line === 'Answer'), 'answer label should be visible');
        assert.ok(lines.some((line) => line.startsWith('> ')), 'answer input should be visible');
        for (let q = 1; q <= 6; q++) {
          const expected = q === index;
          assert.equal(
            lines.some((line) => line.includes(qStarts[q - 1])),
            expected,
            `question ${q} visibility mismatch (current ${index})`,
          );
        }
        component.handleInput?.('\r');
        assert.equal(result, undefined);
        const answer = ['use mongodb text search', 'web and mobile', 'relevance first', 'clear no results message', 'no metrics yet', 'unit and api tests'][index - 1];
        for (const char of answer) {
          component.handleInput?.(char);
        }
        assert.ok(component.render(75).some((line) => line.includes(`> ${answer}`)));
        component.handleInput?.('\r');
        assert.ok(result, `step ${index} should resolve`);
        return result;
      },
    },
    {
      id: 'interview-wide',
      title: 'Interview: interview',
      question: questions,
      context: 'Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan.',
      options: [{ id: 'answered', label: 'Use my answer', description: 'Continue to planning with the feedback/answer provided.' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback, /Q1: .*keyword search/);
  assert.match(decision.feedback, /A1: use mongodb text search/);
  assert.match(decision.feedback, /Q6: .*verification/);
  assert.match(decision.feedback, /A6: unit and api tests/);
});

test('interview prefers select UI over custom overlay for MCQs when both exist', async () => {
  const question = [
    'Q1 - Search strategy: Which implementation should govern?',
    '',
    'Options:',
    '[A] MongoDB text search — Simpler and uses existing indexes',
    '[B] Regex fallback — Broader but less precise',
  ].join('\n');
  let customUsed = false;
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      select: async (title, options) => {
        assert.match(title, /Question 1 of 1/);
        assert.match(title, /Search strategy/);
        assert.match(title, /Which implementation should govern/);
        assert.ok(options.includes('MongoDB text search — Simpler and uses existing indexes'));
        assert.ok(options.includes('Regex fallback — Broader but less precise'));
        assert.ok(options.includes('Custom answer…'));
        return 'Regex fallback — Broader but less precise';
      },
      custom: async () => {
        customUsed = true;
        return undefined;
      },
    },
    {
      id: 'interview-select-first',
      title: 'Interview: grill',
      question,
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(customUsed, false);
  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback ?? '', /Choice1: \[B\] Regex fallback/);
  assert.equal(decision.interviewQuestions?.[0]?.selectedOptionId, 'b');
});

test('interview uses option overlay for MCQs and records selected option', async () => {
  const question = [
    'Q1 - Search strategy: Which implementation should govern?',
    '',
    'Options:',
    '[A] MongoDB text search — Simpler and uses existing indexes',
    '[B] Regex fallback — Broader but less precise',
    '',
    '-> Prefer MongoDB text search unless ranking semantics require more.',
  ].join('\n');
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        const lines = component.render(80);
        assert.ok(lines.some((line) => line.includes('Options')));
        assert.ok(lines.some((line) => line.includes('[A] MongoDB text search')));
        assert.ok(lines.some((line) => line.includes('[B] Regex fallback')));
        assert.ok(lines.some((line) => line.includes('Custom answer…')));
        component.handleInput?.('\u001b[B');
        component.handleInput?.('\r');
        assert.ok(result);
        return result;
      },
    },
    {
      id: 'interview-mcq',
      title: 'Interview: grill',
      question,
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback ?? '', /Choice1: \[B\] Regex fallback/);
  assert.match(decision.feedback ?? '', /A1: Regex fallback/);
  assert.equal(decision.interviewQuestions?.[0]?.selectedOptionId, 'b');
  assert.equal(decision.interviewQuestions?.[0]?.selectedOptionLabel, 'Regex fallback');
});

test('interview custom option collects typed answer for MCQs', async () => {
  const question = [
    'Q1 - Search strategy: Which implementation should govern?',
    '',
    'Options:',
    '[A] MongoDB text search',
    '[B] Regex fallback',
  ].join('\n');
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        component.handleInput?.('\u001b[B');
        component.handleInput?.('\u001b[B');
        component.handleInput?.('\r');
        for (const char of 'hybrid ranking service') {
          component.handleInput?.(char);
        }
        component.handleInput?.('\r');
        assert.ok(result);
        return result;
      },
    },
    {
      id: 'interview-custom-mcq',
      title: 'Interview: grill',
      question,
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback ?? '', /Choice1: custom/);
  assert.match(decision.feedback ?? '', /A1: hybrid ranking service/);
  assert.equal(decision.interviewQuestions?.[0]?.customAnswer, 'hybrid ranking service');
  assert.equal(decision.interviewQuestions?.[0]?.finalAnswer, 'hybrid ranking service');
});

test('interview uses Pi editor when available, one editor per question', async () => {
  const questions = ['Q1: Which search behavior should govern?', 'Q2: Which clients should this cover?'];
  const prompts = [];
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      editor: async (title, prefill) => {
        prompts.push({ title, prefill });
        return prompts.length === 1 ? 'editor text answer' : 'second answer';
      },
    },
    {
      id: 'interview-editor',
      title: 'Interview: grill',
      question: questions.join('\n\n---\n\n'),
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0].title, /Question 1 of 2/);
  assert.match(prompts[0].title, /Which search behavior should govern/);
  assert.match(prompts[0].title, /Answer:/);
  assert.match(prompts[1].title, /Question 2 of 2/);
  assert.match(prompts[1].title, /Which clients should this cover/);
  assert.equal(prompts[0].prefill, '');
  assert.match(decision.feedback, /Q1: .*search behavior/);
  assert.match(decision.feedback, /A1: editor text answer/);
  assert.match(decision.feedback, /A2: second answer/);
});

test('interview cancel skips the current question and preserves later answers', async () => {
  const questions = ['Q1: One', 'Q2: Two'];
  let promptIndex = 0;
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      custom: async (factory) => {
        promptIndex += 1;
        let result;
        const component = factory({ requestRender() {} }, undefined, undefined, (value) => {
          result = value;
        });
        if (promptIndex === 1) {
          component.handleInput?.('\u001b');
        } else {
          for (const char of 'second answer') {
            component.handleInput?.(char);
          }
          component.handleInput?.('\r');
        }
        return result;
      },
    },
    {
      id: 'interview-cancel',
      title: 'Interview: cancel',
      question: questions.join('\n\n---\n\n'),
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback ?? '', /Choice1: skipped/);
  assert.match(decision.feedback ?? '', /A1: \[skipped\]/);
  assert.match(decision.feedback ?? '', /A2: second answer/);
  assert.equal(decision.interviewQuestions?.[0]?.skipped, true);
  assert.equal(decision.interviewQuestions?.[0]?.finalAnswer, '');
  assert.equal(decision.interviewQuestions?.[1]?.finalAnswer, 'second answer');
});

test('interview editor returning blank records a skipped answer', async () => {
  const decision = await requestDecisionInput(
    {
      notify() {},
      setWidget() {},
      editor: async () => '   ',
    },
    {
      id: 'interview-blank',
      title: 'Interview: blank',
      question: 'Q1: One question only',
      options: [{ id: 'answered', label: 'Use my answer' }],
      source: 'INTERVIEW',
      reason: 'USER_PREFERENCE',
    },
  );

  assert.equal(decision.optionId, 'answered');
  assert.match(decision.feedback ?? '', /Choice1: skipped/);
  assert.match(decision.feedback ?? '', /A1: \[skipped\]/);
  assert.equal(decision.interviewQuestions?.[0]?.skipped, true);
  assert.equal(decision.interviewQuestions?.[0]?.finalAnswer, '');
});

test('reviewer finding lines render a blocking verdict with the summary', () => {
  const lines = buildReviewerFindingLines({
    verdict: 'block',
    summary: [
      '**Finding**',
      '- High: the consent flow no longer gates analytics loading.',
      'Not ready for approval.',
    ].join('\n'),
  });
  assert.ok(lines.includes('Factory approval — reviewer finding'));
  assert.ok(lines.includes('review status: completed before final approval'));
  assert.ok(lines.includes('reviewer verdict: block'));
  assert.ok(lines.some((line) => line.includes('consent flow no longer gates analytics loading')));
  assert.ok(lines.some((line) => line.includes('Not ready for approval')));
  assert.ok(lines.some((line) => line.includes('The reviewer is NOT ready for approval. Approving overrides that finding.')));
});

test('reviewer finding lines for a pass verdict are informational', () => {
  const lines = buildReviewerFindingLines({
    verdict: 'pass',
    summary: 'Ready for approval. All checks passed.',
  });
  assert.ok(lines.includes('reviewer verdict: pass'));
  assert.ok(lines.some((line) => line.includes('provided for your decision')));
  assert.ok(!lines.some((line) => line.includes('NOT ready for approval')));
});

test('reviewer finding lines are empty when no verdict exists', () => {
  assert.deepEqual(buildReviewerFindingLines(undefined), []);
});

test('final approval confirm prompt surfaces a blocking verdict as an explicit override', () => {
  const { prompt, body } = resolveFinalApprovalConfirm(
    { runId: 'run_1', goal: 'Add GA tag', hasBaselineDebt: false, hasScopeWarnings: false },
    { verdict: 'block', summary: 'Not ready for approval.' },
  );
  assert.equal(prompt, 'Approve candidate despite the reviewer blocking verdict?');
  assert.match(body, /Approve prototype run run_1 for goal: Add GA tag/);
  assert.match(body, /Review completed before this approval prompt\./);
  assert.match(body, /The reviewer is NOT ready for approval\. Only approve with explicit override intent\./);
});

test('final approval confirm prompt prefers reviewer block over baseline debt', () => {
  const { prompt } = resolveFinalApprovalConfirm(
    { runId: 'run_1', goal: 'g', hasBaselineDebt: true, hasScopeWarnings: true },
    { verdict: 'block', summary: 'blocked' },
  );
  assert.equal(prompt, 'Approve candidate despite the reviewer blocking verdict?');
});

test('final approval confirm without a verdict uses baseline-debt prompt when debt exists', () => {
  const { prompt } = resolveFinalApprovalConfirm(
    { runId: 'run_1', goal: 'g', hasBaselineDebt: true, hasScopeWarnings: false },
    undefined,
  );
  assert.equal(prompt, 'Approve candidate despite baseline debt?');
});

test('default final approval never silently approves a blocking verdict', () => {
  assert.equal(defaultFinalApproval({ verdict: 'block', summary: 'Not ready' }), false);
  assert.equal(defaultFinalApproval({ verdict: 'pass', summary: 'Ready' }), true);
  assert.equal(defaultFinalApproval({ verdict: 'unknown', summary: 'notes' }), true);
  assert.equal(defaultFinalApproval(undefined), true);
});

test('run result title distinguishes an implementation-blocked run from a failed one', () => {
  assert.equal(buildFactoryRunResultTitle('BLOCKED', 'implementation-blocked'), 'Factory prototype run blocked during implementation');
  assert.equal(buildFactoryRunResultTitle('FAILED', 'implementation-failed'), 'Factory prototype run failed during implementation');
  assert.equal(buildFactoryRunResultTitle('COMPLETED', 'complete'), 'Factory prototype run complete');
  assert.equal(buildFactoryRunResultTitle('CANCELLED', 'plan-approval-rejected'), 'Factory prototype run cancelled');
  assert.equal(buildFactoryRunResultTitle('BLOCKED', 'merge-blocked'), 'Factory prototype run failed');
});
