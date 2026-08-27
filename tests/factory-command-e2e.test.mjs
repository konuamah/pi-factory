import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { initializeFactoryProject } from '../packages/core/dist/index.js';
import { registerFactoryPiExtension } from '../packages/adapters/pi/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-e2e-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module' }, null, 2));
    await fs.writeFile(path.join(root, 'README.md'), '# temp\n');
    await execFile('git', ['init'], { cwd: root });
    await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await execFile('git', ['add', '.'], { cwd: root });
    await execFile('git', ['commit', '-m', 'init'], { cwd: root });
    await execFile('git', ['branch', '-M', 'main'], { cwd: root });
    await initializeFactoryProject({ cwd: root, force: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: node -e ""',
        '  typecheck: node -e ""',
        '  test: node -e ""',
        '  build: node -e ""',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: false',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
      ].join('\n'),
      'utf8',
    );
    return await fn(root);
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('factory doctor command surfaces model availability failures clearly', async () => {
  await withTempRepo(async (root) => {
    let command;
    registerFactoryPiExtension({
      registerCommand(name, value) {
        if (name === 'factory') {
          command = value;
        }
      },
    });

    assert.ok(command);

    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4' }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        '  lint: node -e ""',
        '  typecheck: node -e ""',
        '  test: node -e ""',
        '  build: node -e ""',
        'runtime:',
        '  maxParallelAgents: 1',
        'git:',
        '  allowWorktrees: false',
        'repair:',
        '  enabled: false',
        'approval:',
        '  finalMerge: required',
        'models:',
        '  discovery:',
        '    provider: openai-codex',
        '    model: gpt-5.4-mini',
        '  planner:',
        '    provider: openai-codex',
        '    model: gpt-5.4-mini',
        '  builder:',
        '    provider: openai-codex',
        '    model: gpt-5.4-mini',
        '  reviewer:',
        '    provider: openai-codex',
        '    model: gpt-5.4-mini',
        '  repair:',
        '    provider: openai-codex',
        '    model: gpt-5.4-mini',
      ].join('\n'),
      'utf8',
    );

    const widgets = [];
    const notifications = [];

    await command.handler('doctor', {
      cwd: root,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
        setWidget(id, widget) {
          widgets.push({ id, widget });
        },
      },
    });

    const lastWidget = widgets.at(-1)?.widget;
    assert.ok(Array.isArray(lastWidget));
    assert.ok(lastWidget.includes('Factory doctor'));
    assert.ok(lastWidget.some((line) => /summary: \d+ ok, \d+ failed/.test(line)));
    assert.ok(lastWidget.includes('Failures'));
    assert.ok(lastWidget.some((line) => /FAIL model-availability: role=discovery/.test(line)));
    assert.ok(lastWidget.some((line) => /taskType=general/.test(line)));
    assert.ok(lastWidget.some((line) => /missing model key=openai-codex:gpt-5\.4-mini/.test(line)));
    assert.ok(lastWidget.some((line) => /\/factory models/.test(line)));
    assert.ok(lastWidget.includes('OK checks'));
    assert.ok(notifications.some((entry) => entry.message === 'Factory doctor found issues' && entry.level === 'warning'));
  });
});

test('factory doctor command keeps widget compact and never renders object command values', async () => {
  await withTempRepo(async (root) => {
    let command;
    registerFactoryPiExtension({
      registerCommand(name, value) {
        if (name === 'factory') {
          command = value;
        }
      },
    });

    assert.ok(command);

    const agentDir = path.join(root, 'agent');
    await fs.mkdir(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'gpt-5.4-mini' }, null, 2),
      'utf8',
    );
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      JSON.stringify({
        project: { baseBranch: 'main' },
        commands: {
          setup: { value: 'pnpm install', reason: 'legacy object shape' },
          checks: { value: 'pnpm lint', reason: 'legacy object shape' },
        },
        runtime: { maxParallelAgents: 1 },
        git: { allowWorktrees: false },
        repair: { enabled: false },
        approval: { finalMerge: 'required' },
        models: {
          discovery: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
          planner: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
          builder: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
          reviewer: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
          repair: { provider: 'openai-codex', model: 'gpt-5.4-mini' },
        },
      }, null, 2),
      'utf8',
    );

    const widgets = [];

    await command.handler('doctor', {
      cwd: root,
      ui: {
        notify() {},
        setWidget(id, widget) {
          widgets.push({ id, widget });
        },
      },
    });

    const lastWidget = widgets.at(-1)?.widget;
    assert.ok(Array.isArray(lastWidget));
    assert.ok(lastWidget.some((line) => /summary: \d+ ok, 0 failed/.test(line)));
    assert.ok(lastWidget.includes('OK checks'));
    assert.equal(lastWidget.some((line) => /\[object Object\]/.test(line)), false);
    assert.equal(lastWidget.some((line) => /commands-configured/.test(line)), true);
  });
});

test.skip('factory goal command completes in sdk mode with a loadable sdk module', async () => {
  await withTempRepo(async (root) => {
    let command;
    registerFactoryPiExtension({
      registerCommand(name, value) {
        if (name === 'factory') {
          command = value;
        }
      },
    });

    assert.ok(command);

    const sdkPath = pathToFileURL(path.resolve('tests/fixtures/fake-pi-sdk.mjs')).href;
    const previousPackage = process.env.FACTORY_PI_SDK_PACKAGE;

    const widgets = [];
    const notifications = [];

    process.env.FACTORY_PI_SDK_PACKAGE = sdkPath;
    try {
      await command.handler('demo goal --executor=sdk', {
        cwd: root,
        ui: {
          notify(message, level) {
            notifications.push({ message, level });
          },
          setWidget(id, widget) {
            widgets.push({ id, widget });
          },
          confirm: async () => true,
        },
      });
    } finally {
      if (previousPackage === undefined) {
        delete process.env.FACTORY_PI_SDK_PACKAGE;
      } else {
        process.env.FACTORY_PI_SDK_PACKAGE = previousPackage;
      }
    }

    const lastWidget = widgets.at(-1)?.widget;
    assert.ok(Array.isArray(lastWidget));
    assert.ok(lastWidget.includes('Factory prototype run complete'));
    assert.ok(lastWidget.includes('executor mode: sdk'));
    assert.ok(notifications.some((entry) => entry.message === 'Factory prototype run complete'));
  });
});
