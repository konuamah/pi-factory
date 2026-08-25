import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compileAgentContext, initializeFactoryProject } from '../packages/core/dist/index.js';

async function withTempProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-context-'));
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use concise release notes.\n', 'utf8');
    await fs.mkdir(path.join(root, 'tests'), { recursive: true });
    await fs.writeFile(path.join(root, 'tests/user.test.ts'), '// user tests\n', 'utf8');
    await initializeFactoryProject({ cwd: root, force: true });
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('compileAgentContext builds a scoped builder context with dependencies and skills', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add team invitations',
      task: {
        id: 'task-3',
        title: 'Update tests',
        stage: 'tests',
        status: 'pending',
        dependsOn: ['task-2'],
        type: 'agent',
        context: { fileHints: ['tests/**'], requiredCapabilities: ['testing'] },
      },
      dependencyTasks: [
        {
          id: 'task-2',
          title: 'Modify schema',
          stage: 'implementation',
          status: 'done',
          dependsOn: [],
          type: 'agent',
          context: { fileHints: ['src/schema.ts'] },
        },
      ],
      skills: [
        {
          skill: {
            id: 'testing',
            version: '1.0.0',
            description: 'Testing skill',
            provides: { capabilities: ['testing'] },
          },
          score: 1,
          reasons: ['Supports build stage.', 'Required capabilities matched.'],
        },
      ],
    });

    assert.equal(compiled.role, 'builder');
    assert.equal(compiled.task?.id, 'task-3');
    assert.match(compiled.instructions.join('\n'), /Depends on: task-2/);
    assert.match(compiled.instructions.join('\n'), /Modify schema/);
    assert.match(compiled.instructions.join('\n'), /Selected skills:/);
    assert.match(compiled.instructions.join('\n'), /testing@1\.0\.0/);
    assert.ok(compiled.files.some((file) => file.path === 'tests/**'));
    assert.ok(compiled.dependencies.some((dep) => dep.taskId === 'task-2'));
    assert.ok(compiled.tokenEstimate > 0);
  });
});

test('compileAgentContext surfaces granted and denied capabilities in instructions', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add a migration',
      grantedCapabilities: ['repo.read', 'repo.write', 'shell.execute'],
      deniedCapabilities: ['deploy.production'],
    });
    const text = compiled.instructions.join('\n');
    assert.match(text, /Available capabilities:/);
    assert.match(text, /- repo\.read/);
    assert.match(text, /- repo\.write/);
    assert.match(text, /Unavailable capabilities \(do not attempt\):/);
    assert.match(text, /- deploy\.production/);
    assert.deepEqual(compiled.grantedCapabilities, ['repo.read', 'repo.write', 'shell.execute']);
    assert.deepEqual(compiled.deniedCapabilities, ['deploy.production']);
  });
});

test('compileAgentContext can skip constitution while keeping project instructions', async () => {
  await withTempProject(async (root) => {
    await fs.writeFile(
      path.join(root, 'CONSTITUTION.md'),
      [
        '# Observable Facts',
        '## Agent Operating Summary',
        'This constitution summary should not be included.',
        '## Interpretation',
      ].join('\n'),
      'utf8',
    );

    const compiled = await compileAgentContext({
      cwd: root,
      role: 'planner',
      goal: 'Update content',
      useConstitution: false,
    });
    const text = compiled.instructions.join('\n');
    assert.match(text, /Project instruction files:/);
    assert.match(text, /Use concise release notes/);
    assert.doesNotMatch(text, /Constitution summary:/);
    assert.doesNotMatch(text, /This constitution summary should not be included/);
  });
});

test('compileAgentContext respects a tight budget', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'planner',
      goal: 'Add team invitations',
      maxChars: 400,
    });
    const total = compiled.instructions.join('\n\n').length;
    assert.ok(total <= 450, `instructions exceed budget: ${total}`);
  });
});
