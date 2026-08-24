import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultWorkflowDefinition,
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
  assert.deepEqual(config.workflows[0].stages.map((stage) => stage.name), ['plan', 'implementation', 'verification', 'approval']);
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
            { name: 'architecture-review', type: 'agent', role: 'reviewer', model: { provider: 'openai-codex', model: 'gpt-5' }, dependsOn: ['plan'] },
            { name: 'implementation', type: 'agent', role: 'builder', dependsOn: ['plan'] },
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
    assert.equal(highRisk.stages.length, 6);
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'tests')?.commands, ['node -e ""']);
    assert.deepEqual(highRisk.stages.find((stage) => stage.name === 'architecture-review')?.model, { provider: 'openai-codex', model: 'gpt-5' });
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
