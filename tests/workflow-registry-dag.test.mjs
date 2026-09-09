import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultWorkflowDefinition, validateWorkflowDependencies } from '../packages/core/dist/workflows/registry.js';

test('built-in workflow has valid dependencies', () => {
  assert.deepEqual(validateWorkflowDependencies(defaultWorkflowDefinition()), []);
});

test('workflow validation reports unknown dependencies and cycles', () => {
  const issues = validateWorkflowDependencies({
    id: 'invalid',
    name: 'Invalid',
    stages: [
      { name: 'a', dependsOn: ['b', 'missing'] },
      { name: 'b', dependsOn: ['a'] },
    ],
  });
  assert.ok(issues.some((issue) => issue.code === 'unknown-depends-on'));
  assert.ok(issues.some((issue) => issue.code === 'cycle'));
  assert.ok(issues.some((issue) => issue.code === 'unreachable-stage'));
});

test('workflow validation requires approval to depend on a reviewer', () => {
  const issues = validateWorkflowDependencies({
    id: 'no-review',
    name: 'No review',
    stages: [
      { name: 'build' },
      { name: 'approval', type: 'approval', dependsOn: ['build'] },
    ],
  });
  assert.equal(issues.filter((issue) => issue.code === 'approval-without-review').length, 1);
});
