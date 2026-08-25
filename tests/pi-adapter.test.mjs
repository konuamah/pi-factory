import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlanApprovalPreviewLines,
  requestPlanApprovalDecision,
} from '../packages/adapters/pi/dist/approval.js';

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
  for (const char of value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) {
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
