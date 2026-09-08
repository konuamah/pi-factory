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

test('authoritative human decisions survive a tight budget even with large guidance', async () => {
  await withTempProject(async (root) => {
    // A long AGENTS.md guidance section would previously crowd out decisions.
    await fs.writeFile(path.join(root, 'AGENTS.md'), `${'very long project guidance line\n'.repeat(400)}`, 'utf8');
    const longAnswer = `Q1: placement -> A1: shared\nQ2: existing setup -> A2: reconcile\nQ3: consent behavior -> A3: keep current consent flow`.repeat(30);
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add the Google tag',
      planIntent: {
        targetFiles: ['src/app/layout.tsx'],
        implementationSteps: ['Step 1: edit layout'],
      },
      runDecisions: [
        {
          requestId: 'run-interview',
          question: 'Q3 - Consent behavior: should the tag wait for consent?',
          optionId: 'answered',
          feedback: longAnswer,
        },
      ],
      maxChars: 1500,
    });
    const text = compiled.instructions.join('\n');
    // The authoritative decision must survive the budget truncation.
    assert.match(text, /Human decisions \(authoritative run facts\):/);
    assert.match(text, /A3: keep current consent flow/);
    // Planner handoff also survives.
    assert.match(text, /Planner handoff \(authoritative\):/);
    assert.match(text, /Step 1: edit layout/);
  });
});

test('builder context includes CONTRACT_NOOP and verification-stage ownership rules', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add the Google tag',
      planIntent: {
        targetFiles: ['src/app/layout.tsx'],
        implementationSteps: ['Step 1: edit layout'],
      },
    });
    const text = compiled.instructions.join('\n');
    assert.match(text, /CONTRACT_BLOCKED/);
  });
});

test('full builder compiled prompt carries CONTRACT_NOOP and verification-stage ownership', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add the Google tag',
      planIntent: {
        targetFiles: ['src/app/layout.tsx'],
        implementationSteps: ['Step 1: edit layout'],
      },
    });
    const { buildCompiledPrompt } = await import('../packages/core/dist/runtime/prompts.js');
    const fullPrompt = buildCompiledPrompt('Add the Google tag', compiled, root);
    assert.match(fullPrompt, /CONTRACT_NOOP/);
    assert.match(fullPrompt, /verification stage owns broad lint, build, and test checks/);
    assert.match(fullPrompt, /modify source temporarily/i);
  });
});

test('builder context carries CHANGE REQUIREMENT status when the planner provided one', async () => {
  await withTempProject(async (root) => {
    const compiled = await compileAgentContext({
      cwd: root,
      role: 'builder',
      goal: 'Add the Google tag',
      planIntent: {
        targetFiles: ['src/app/layout.tsx'],
        implementationSteps: ['Step 1: edit layout'],
        changeRequired: 'required',
        baselineFindings: ['The consent banner is not rendered on the marketing page.'],
        requiredChanges: ['Render the banner in layout.tsx.'],
      },
    });
    const text = compiled.instructions.join('\n');
    assert.match(text, /Change requirement: required/);
    assert.match(text, /Baseline findings \(why this change is needed\):/);
    assert.match(text, /consent banner is not rendered/);
    assert.match(text, /Required changes:/);
  });
});

test('renderPriorityBudget keeps high-priority sections whole and truncates the tail visibly', async () => {
  const { renderPriorityBudget } = await import('../packages/core/dist/context/compiler.js');
  const sections = [
    { name: 'guidance', priority: 20, text: 'G'.repeat(1000) },
    { name: 'runDecisions', priority: 100, text: 'decisions: keep consent' },
    { name: 'planIntent', priority: 100, text: 'handoff: edit layout' },
    { name: 'roleRules', priority: 100, text: 'role rules block' },
  ];
  const rendered = renderPriorityBudget(sections, 200);
  const joined = rendered.join('\n');
  // High-priority sections are all present, low-priority guidance truncated/dropped.
  assert.match(joined, /role rules block/);
  assert.match(joined, /handoff: edit layout/);
  assert.match(joined, /decisions: keep consent/);
  // The overall size respects the budget.
  assert.ok(joined.length <= 210, `budget exceeded: ${joined.length}`);
  assert.ok(!joined.includes('G'.repeat(1000)), 'oversized guidance must not survive whole');
});
