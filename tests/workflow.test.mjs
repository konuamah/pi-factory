import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultWorkflowDefinition,
  defaultWorkflowTemplate,
  normalizeWorkflowConfig,
  readWorkflowRegistry,
  resolveWorkflowDefinition,
  writeWorkflowRegistry,
  initializeFactoryProject,
  loadEffectiveConfig,
} from '../packages/core/dist/index.js';

test('normalizeWorkflowConfig fills in a default workflow when empty', () => {
  const config = normalizeWorkflowConfig();
  assert.equal(config.defaultWorkflowId, 'default-dev');
  assert.equal(config.workflows.length, 1);
  assert.deepEqual(config.workflows[0].stages.map((stage) => stage.name), ['discover', 'plan', 'implementation', 'verification', 'review', 'approval']);
  const approvalStage = config.workflows[0].stages.find((stage) => stage.name === 'approval');
  assert.ok(approvalStage);
  assert.deepEqual(approvalStage.dependsOn, ['review']);
  assert.ok(config.workflows[0].stages.some((stage) => stage.name === 'review' && stage.role === 'reviewer'));
});

test('setup workflow templates put review before final approval', () => {
  const fast = defaultWorkflowTemplate('fast');
  const safe = defaultWorkflowTemplate('safe');
  const balanced = defaultWorkflowTemplate('balanced');
  for (const [name, content] of [['fast', fast], ['safe', safe], ['balanced', balanced]]) {
    const reviewIndex = content.indexOf('name: review');
    const approvalIndex = content.indexOf('name: approval');
    assert.ok(reviewIndex >= 0, `${name} template must contain a reviewer stage`);
    assert.ok(approvalIndex >= 0, `${name} template must contain an approval stage`);
    assert.ok(reviewIndex < approvalIndex, `${name} template must place review before approval`);
    assert.match(content, /role: reviewer/, `${name} template must role a reviewer`);
    const afterApproval = content.slice(content.indexOf('type: approval'));
    assert.ok(afterApproval.startsWith('type: approval\n        dependsOn: [review]'), `${name} template approval must depend on review`);
  }
});

test('normalizeWorkflowConfig preserves multi-workflow registry', () => {
  const config = normalizeWorkflowConfig({
    defaultWorkflowId: 'docs',
    workflows: [
      { id: 'dev', name: 'Dev', stages: [{ name: 'plan' }] },
      { id: 'docs', name: 'Docs', stages: [{ name: 'research' }, { name: 'write' }] },
    ],
  });
  assert.equal(config.defaultWorkflowId, 'docs');
  assert.equal(config.workflows.length, 2);
});

test('resolveWorkflowDefinition picks requested, then default, then first', () => {
  const config = normalizeWorkflowConfig({
    defaultWorkflowId: 'dev',
    workflows: [
      { id: 'dev', name: 'Dev', stages: [{ name: 'plan' }] },
      { id: 'docs', name: 'Docs', stages: [{ name: 'write' }] },
    ],
  });
  const effective = { workflow: config };

  assert.equal(resolveWorkflowDefinition(effective, 'docs')?.id, 'docs');
  assert.equal(resolveWorkflowDefinition(effective)?.id, 'dev');
  assert.equal(resolveWorkflowDefinition({ workflow: { workflows: [{ id: 'a', name: 'A', stages: [] }] } })?.id, 'a');
});

test('workflow registry round-trips through factory.yaml', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    const registry = {
      defaultWorkflowId: 'high-risk',
      workflows: [
        defaultWorkflowDefinition(),
        {
          id: 'high-risk',
          name: 'High Risk Change',
          description: 'Extra reviews for risky changes',
          stages: [
            { name: 'plan', type: 'agent', role: 'planner' },
            { name: 'grill', description: 'Interview before planning', type: 'interview', role: 'planner', dependsOn: ['plan'], skills: { require: ['grilling'] } },
            { name: 'architecture-review', description: 'Review architecture and rollout risk before implementation', type: 'agent', role: 'reviewer', model: { provider: 'openai-codex', model: 'gpt-5' }, dependsOn: ['plan'] },
            { name: 'implementation', type: 'agent', role: 'builder', dependsOn: ['plan'], skills: { require: ['implementation-task'], prefer: ['repo-interpretation'], exclude: ['slamm-copy-humanizer'] } },
            { name: 'tests', type: 'command', commands: ['node -e ""'], dependsOn: ['implementation'] },
            { name: 'security-review', type: 'agent', role: 'reviewer', dependsOn: ['implementation'] },
            { name: 'final-approval', type: 'approval', dependsOn: ['tests', 'security-review'] },
          ],
        },
      ],
    };
    await writeWorkflowRegistry(root, registry);

    const reloaded = await readWorkflowRegistry(root);
    assert.equal(reloaded.defaultWorkflowId, 'high-risk');
    assert.equal(reloaded.workflows.length, 2);
    const highRisk = reloaded.workflows.find((workflow) => workflow.id === 'high-risk');
    assert.ok(highRisk);
    assert.equal(highRisk.stages.length, 7);
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'tests')?.commands, ['node -e ""']);
    assert.equal(highRisk.stages.find((stage) => stage.name === 'grill')?.type, 'interview');
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'grill')?.skills, { require: ['grilling'] });
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'architecture-review')?.model, { provider: 'openai-codex', model: 'gpt-5' });
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'implementation')?.skills, {
      require: ['implementation-task'],
      prefer: ['repo-interpretation'],
      exclude: ['slamm-copy-humanizer'],
    });
    assert.equal(highRisk.stages.find((stage) => stage.name === 'architecture-review')?.description, 'Review architecture and rollout risk before implementation');
    assert.equal(highRisk.stages.find((stage) => stage.name === 'security-review')?.dependsOn?.join(','), 'implementation');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig resolves requested workflow via run override', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    await initializeFactoryProject({ cwd: root, force: true });
    await writeWorkflowRegistry(root, {
      defaultWorkflowId: 'default-dev',
      workflows: [
        defaultWorkflowDefinition(),
        { id: 'docs', name: 'Docs Only', stages: [{ name: 'research' }, { name: 'write' }, { name: 'review', type: 'approval' }] },
      ],
    });

    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.resolvedWorkflowId, 'default-dev');
    assert.equal(loaded.effectiveConfig.resolvedWorkflow?.name, 'Default Development');

    const loadedDocs = await loadEffectiveConfig({ cwd: root, runOverrides: { workflowId: 'docs' } });
    assert.equal(loadedDocs.effectiveConfig.resolvedWorkflowId, 'docs');
    assert.equal(loadedDocs.effectiveConfig.resolvedWorkflow?.name, 'Docs Only');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig honors disabled constitution config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    await initializeFactoryProject({ cwd: root, force: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'constitution:',
        '  enabled: false',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.constitution.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig defaults constitution to disabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.constitution.enabled, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig honors explicit enabled constitution config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'constitution:',
        '  enabled: true',
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.constitution.enabled, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig provides dependency hydration defaults', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.dependencies.enabled, true);
    assert.equal(loaded.effectiveConfig.dependencies.hydrate, 'auto');
    assert.ok(path.isAbsolute(loaded.effectiveConfig.dependencies.cacheRoot));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig honors dependency hydration project overrides', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  const root = path.join(parent, 'repo');
  const cacheRoot = path.join(parent, 'factory-cache');
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'dependencies:',
        '  enabled: false',
        '  hydrate: never',
        `  cacheRoot: ${JSON.stringify(cacheRoot.replace(/\\/g, '/'))}`,
      ].join('\n'),
      'utf8',
    );

    const loaded = await loadEffectiveConfig({ cwd: root });
    assert.equal(loaded.effectiveConfig.dependencies.enabled, false);
    assert.equal(loaded.effectiveConfig.dependencies.hydrate, 'never');
    assert.equal(path.resolve(loaded.effectiveConfig.dependencies.cacheRoot), path.resolve(cacheRoot));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig rejects invalid dependency hydration config', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'dependencies:',
        '  hydrate: sometimes',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(() => loadEffectiveConfig({ cwd: root }), /dependencies\.hydrate/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('loadEffectiveConfig rejects dependency cache roots inside the active repo', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-workflow-'));
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'dependencies:',
        '  cacheRoot: .factory/cache',
      ].join('\n'),
      'utf8',
    );

    await assert.rejects(() => loadEffectiveConfig({ cwd: root }), /dependencies\.cacheRoot must be outside/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
