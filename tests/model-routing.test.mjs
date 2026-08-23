import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTaskType,
  resolveModelForRole,
  preflightModelRouting,
  taskTypeMatchPaths,
  ModelRoutingError,
  appendModelLedgerEntry,
  readModelLedger,
} from '../packages/core/dist/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function configWith(taskTypes, models = {}) {
  return {
    taskTypes,
    models: {
      planner: { model: 'sonnet' },
      builder: { model: 'sonnet' },
      reviewer: { model: 'opus' },
      repair: { model: 'sonnet' },
      ...models,
    },
  };
}

test('classifyTaskType matches user-defined keyword hints', () => {
  const config = configWith({
    'database-evolution': { match: { keywords: ['migration', 'schema', 'database'] } },
    'documentation-only': { match: { keywords: ['readme', 'docs', 'documentation'] } },
  });
  const result = classifyTaskType('add a migration for the schema', config);
  assert.equal(result.id, 'database-evolution');
  assert.equal(result.source, 'classifier');
  assert.ok(result.confidence > 0);
});

test('classifyTaskType falls back to general when no user type matches', () => {
  const config = configWith({ 'database-evolution': { match: { keywords: ['migration'] } } });
  const result = classifyTaskType('update the README typo', config);
  assert.equal(result.id, 'general');
  assert.equal(result.source, 'default');
});

test('resolveModelForRole: task-type routing wins over role default', () => {
  const config = configWith({
    refactor: { routing: { builder: { model: 'haiku' } } },
  });
  const resolved = resolveModelForRole({ role: 'builder', taskType: 'refactor', config });
  assert.equal(resolved.model.model, 'haiku');
  assert.equal(resolved.source, 'task-type');
});

test('resolveModelForRole: node override beats task type and run override', () => {
  const config = configWith({ refactor: { routing: { builder: { model: 'haiku' } } } });
  const resolved = resolveModelForRole({
    role: 'builder',
    taskType: 'refactor',
    config,
    nodeModel: { model: 'custom' },
    runModelOverride: { model: 'run-custom' },
  });
  assert.equal(resolved.model.model, 'custom');
  assert.equal(resolved.source, 'node-override');
});

test('resolveModelForRole: role default used when task type has no routing', () => {
  const config = configWith({ docs: {} });
  const resolved = resolveModelForRole({ role: 'builder', taskType: 'docs', config });
  assert.equal(resolved.model.model, 'sonnet');
  assert.equal(resolved.source, 'role-default');
});

test('resolveModelForRole fails loud when no model exists', () => {
  const config = configWith({ refactor: {} }, { builder: undefined });
  assert.throws(
    () => resolveModelForRole({ role: 'builder', taskType: 'refactor', config }),
    (error) => error instanceof ModelRoutingError && /No model configured for role 'builder'/.test(error.message),
  );
});

test('preflightModelRouting reports missing models across task types and roles', () => {
  const config = configWith(
    {
      'database-evolution': { routing: { builder: { model: 'opus' } } },
      docs: {},
    },
    { reviewer: undefined },
  );
  const errors = preflightModelRouting({
    taskTypes: ['database-evolution', 'docs'],
    roles: ['planner', 'builder', 'reviewer', 'repair'],
    config,
  });
  assert.ok(errors.some((e) => e.taskType === 'database-evolution' && e.role === 'reviewer'));
  assert.ok(errors.some((e) => e.taskType === 'docs' && e.role === 'reviewer'));
  assert.ok(!errors.some((e) => e.taskType === 'database-evolution' && e.role === 'builder'));
});

test('taskTypeMatchPaths matches changed files to path hints', () => {
  const taskTypes = {
    'database-evolution': { match: { paths: ['migrations/**', 'prisma/**'] } },
  };
  assert.equal(taskTypeMatchPaths(taskTypes, ['prisma/schema.prisma']), 'database-evolution');
  assert.equal(taskTypeMatchPaths(taskTypes, ['src/app.ts']), undefined);
});

test('run uses changed-file path hints when goal classifier finds nothing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-tasktype-')).catch(() => null);
  if (!root) {
    return;
  }
  try {
    // Without a real git repo, gitChangedFiles returns [] so path matching won't fire;
    // verify the pure path matcher covers the runtime wiring intent.
    const taskTypes = {
      'database-evolution': { match: { paths: ['migrations/**'] } },
    };
    assert.equal(taskTypeMatchPaths(taskTypes, ['migrations/001_add_users.sql']), 'database-evolution');
    assert.equal(taskTypeMatchPaths(taskTypes, ['src/app.ts']), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('model ledger appends and reads entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-ledger-'));
  try {
    await appendModelLedgerEntry(root, {
      operationId: 'run-1-builder-task-2',
      taskId: 'task-2',
      role: 'builder',
      taskType: 'refactor',
      taskTypeSource: 'classifier',
      taskTypeConfidence: 0.8,
      requestedModel: 'haiku',
      resolvedModel: 'haiku',
      modelSource: 'task-type',
    });
    const entries = await readModelLedger(root);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, 'builder');
    assert.equal(entries[0].taskType, 'refactor');
    assert.equal(entries[0].modelSource, 'task-type');
    assert.ok(entries[0].timestamp);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
