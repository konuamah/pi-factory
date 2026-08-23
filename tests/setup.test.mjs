import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectPiModelConfiguration, initializeFactoryProject } from '../packages/core/dist/index.js';

async function withTempDirs(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-setup-'));
  const agentDir = path.join(root, 'agent');
  const projectDir = path.join(root, 'project');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  try {
    return await fn({ root, agentDir, projectDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('detectPiModelConfiguration finds global default provider/model and auth', async () => {
  await withTempDirs(async ({ agentDir, projectDir }) => {
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(agentDir, 'auth.json'),
      JSON.stringify({ anthropic: { type: 'api_key', key: 'x' } }, null, 2),
      'utf8',
    );

    const result = await detectPiModelConfiguration(projectDir, { agentDir });
    assert.equal(result.hasModelSelection, true);
    assert.equal(result.hasAuth, true);
    assert.equal(result.defaultProvider, 'anthropic');
    assert.equal(result.defaultModel, 'claude-sonnet-4-20250514');
    assert.deepEqual(result.authProviders, ['anthropic']);
  });
});

test('detectPiModelConfiguration lets project Pi settings override global defaults', async () => {
  await withTempDirs(async ({ agentDir, projectDir }) => {
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'global-model', enabledModels: ['claude-*'] }, null, 2),
      'utf8',
    );
    await fs.mkdir(path.join(projectDir, '.pi'), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, '.pi/settings.json'),
      JSON.stringify({ defaultProvider: 'openai', defaultModel: 'gpt-5', enabledModels: ['gpt-*', 'o*'] }, null, 2),
      'utf8',
    );

    const result = await detectPiModelConfiguration(projectDir, { agentDir });
    assert.equal(result.defaultProvider, 'openai');
    assert.equal(result.defaultModel, 'gpt-5');
    assert.deepEqual(result.enabledModels, ['gpt-*', 'o*']);
    assert.equal(result.hasModelSelection, true);
  });
});

test('detectPiModelConfiguration counts custom models from models.json', async () => {
  await withTempDirs(async ({ agentDir, projectDir }) => {
    await fs.writeFile(
      path.join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          ollama: {
            models: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder:7b' }],
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await detectPiModelConfiguration(projectDir, { agentDir });
    assert.equal(result.customProviderCount, 1);
    assert.equal(result.customModelCount, 2);
    assert.equal(result.hasModelSelection, true);
    assert.equal(result.hasAuth, false);
  });
});

test('initializeFactoryProject writes selected workflow preset and role models', async () => {
  await withTempDirs(async ({ projectDir, agentDir }) => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await initializeFactoryProject({
      cwd: projectDir,
      force: true,
      setup: {
        workflowPreset: 'fast',
        modelAssignments: {
          planner: { provider: 'anthropic', model: 'claude-sonnet-4-20250514' },
          reviewer: { provider: 'anthropic', model: 'claude-opus-4-20250514' },
        },
      },
    });

    const workflow = await fs.readFile(path.join(projectDir, 'factory.yaml'), 'utf8');
    const config = await fs.readFile(path.join(projectDir, '.factory/config.yaml'), 'utf8');

    assert.match(workflow, /workflows:/);
    assert.match(workflow, /- name: plan/);
    assert.match(workflow, /- name: build/);
    assert.doesNotMatch(workflow, /- name: verify/);
    assert.match(config, /models:/);
    assert.match(config, /planner:/);
    assert.match(config, /provider: anthropic/);
    assert.match(config, /model: claude-sonnet-4-20250514/);
    assert.match(config, /reviewer:/);
    assert.match(config, /model: claude-opus-4-20250514/);
  });
});

test('initializeFactoryProject can write the safe workflow preset', async () => {
  await withTempDirs(async ({ projectDir, agentDir }) => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await initializeFactoryProject({
      cwd: projectDir,
      force: true,
      setup: {
        workflowPreset: 'safe',
      },
    });

    const workflow = await fs.readFile(path.join(projectDir, 'factory.yaml'), 'utf8');
    assert.match(workflow, /- name: verify/);
    assert.match(workflow, /dependsOn: \[build\]/);
  });
});

test('initializeFactoryProject reconfigure updates workflow/config without overwriting constitution', async () => {
  await withTempDirs(async ({ projectDir, agentDir }) => {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await initializeFactoryProject({
      cwd: projectDir,
      force: true,
      setup: {
        workflowPreset: 'balanced',
      },
    });

    const constitutionPath = path.join(projectDir, 'CONSTITUTION.md');
    await fs.writeFile(constitutionPath, '# CUSTOM CONSTITUTION\n', 'utf8');

    await initializeFactoryProject({
      cwd: projectDir,
      setup: {
        workflowPreset: 'fast',
        reconfigure: true,
        modelAssignments: {
          planner: { provider: 'openai', model: 'gpt-5' },
        },
      },
    });

    const constitution = await fs.readFile(constitutionPath, 'utf8');
    const workflow = await fs.readFile(path.join(projectDir, 'factory.yaml'), 'utf8');
    const config = await fs.readFile(path.join(projectDir, '.factory/config.yaml'), 'utf8');

    assert.equal(constitution, '# CUSTOM CONSTITUTION\n');
    assert.doesNotMatch(workflow, /- name: verify/);
    assert.match(config, /planner:/);
    assert.match(config, /provider: openai/);
    assert.match(config, /model: gpt-5/);
  });
});
