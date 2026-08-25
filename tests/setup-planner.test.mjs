import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import {
  inspectRepositoryForSetup,
  planFactorySetup,
  applyFactorySetup,
  validateFactorySetup,
  recommendFromProfile,
} from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function initGitRepo(root) {
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 't@e.com'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'T'], { cwd: root });
}

async function withRepo(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-setup-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/index.ts'), 'export const x = 1;\n');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, 'utf8');
  }
  await initGitRepo(root);
  await execFile('git', ['add', '-A'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('inspectRepositoryForSetup builds a profile from a TypeScript repo', async () => {
  await withRepo({
    'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'vitest run', build: 'tsc' } }, null, 2),
    'pnpm-lock.yaml': '',
    'vitest.config.ts': '',
    'src/index.test.ts': 'import { test } from "vitest";\n',
  }, async (root) => {
    const profile = await inspectRepositoryForSetup(root);
    assert.ok(['NEW', 'ESTABLISHED'].includes(profile.maturity));
    assert.ok(profile.languages.includes('TypeScript'));
    assert.ok(profile.packageManagers.includes('pnpm'));
    assert.equal(profile.commands.test, 'vitest run');
    assert.equal(profile.testing.frameworks[0], 'vitest');
  });
});

test('recommendFromProfile derives commands and workflow from evidence', async () => {
  const profile = {
    maturity: 'ESTABLISHED',
    languages: ['TypeScript'],
    packageManagers: ['pnpm'],
    frameworks: ['vitest'],
    structure: { monorepo: false, packages: [] },
    commands: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'tsup' },
    testing: { frameworks: ['vitest'], unit: true, integration: true, e2e: false },
    persistence: { technologies: [], migrations: false },
    ci: { providers: ['github-actions'] },
    deployment: { detected: false, providers: [] },
    factory: { files: { constitution: false, workflow: false, projectConfig: false }, runsCount: 0, hasConstitutionMetadata: false },
  };
  const recommendations = recommendFromProfile(profile);
  assert.ok(recommendations.some((r) => r.id === 'verification:test' && r.confidence === 'HIGH' && r.origin === 'DISCOVERED'));
  assert.ok(recommendations.some((r) => r.id === 'workflow:preset' && r.confidence === 'MEDIUM' && r.requiresDecision));
});

test('planFactorySetup picks ADOPT mode for an existing repo without Factory files', async () => {
  await withRepo({ 'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'vitest run' } }, null, 2) }, async (root) => {
    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'safe' } });
    assert.equal(plan.mode, 'ADOPT');
    assert.ok(plan.proposed.files.some((f) => f.path.endsWith('factory.yaml')));
    assert.ok(plan.proposed.files.some((f) => f.path.includes('.factory') && f.path.endsWith(`config.yaml`)));
  });
});

test('applyFactorySetup writes files and validateFactorySetup returns READY', async () => {
  await withRepo({ 'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node -e ""', build: 'node -e ""', lint: 'node -e ""', typecheck: 'node -e ""' } }, null, 2) }, async (root) => {
    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'balanced' } });
    const written = await applyFactorySetup(plan);
    assert.ok(written.some((f) => f.endsWith('factory.yaml')));
    // Gitignore wiring: .factory/ and .worktrees/ are now ignored.
    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    assert.match(gitignore, /\.factory\//);
    assert.match(gitignore, /\.worktrees\//);
    const validation = await validateFactorySetup(root);
    assert.ok(['READY', 'READY_WITH_WARNINGS'].includes(validation.readiness));
  });
});

test('applyFactorySetup installs Pi-visible Factory Concierge skill with extension', async () => {
  await withRepo({ 'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node -e ""' } }, null, 2) }, async (root) => {
    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'balanced' } });
    const written = await applyFactorySetup(plan, { extensionSource: '@factory/adapters/pi' });
    const extensionPath = path.join(root, '.pi/extensions/factory/index.ts');
    const skillPath = path.join(root, '.pi/skills/factory-concierge/SKILL.md');

    assert.ok(written.includes(extensionPath));
    assert.ok(written.includes(skillPath));
    const skill = await fs.readFile(skillPath, 'utf8');
    assert.match(skill, /name: factory-concierge/);
    assert.match(skill, /operator brain for Factory inside Pi/);
    assert.match(skill, /You may directly edit Factory-owned\/project-agent files/);
    assert.match(skill, /edit `factory.yaml` directly/);
    assert.doesNotMatch(skill, /Return JSON only/);
  });
});

test('proposed setup uses the detected package manager for commands', async () => {
  await withRepo({ 'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test', build: 'node build.js' } }, null, 2), 'package-lock.json': '' }, async (root) => {
    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'balanced' } });
    const config = plan.proposed.files.find((f) => f.path.includes('.factory') && f.path.endsWith(`config.yaml`));
    assert.ok(config);
    assert.match(config.content, /setup: npm install/);
    assert.match(config.content, /test: node --test/);
  });
});

test('plan recommends capabilities and task types from repo shape', async () => {
  await withRepo({
    'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test', build: 'node build.js' } }, null, 2),
    'package-lock.json': '',
    'prisma/schema.prisma': 'model User { id Int @id }\n',
    'prisma/migrations/001_init/migration.sql': 'CREATE TABLE users;\n',
  }, async (root) => {
    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'balanced' } });
    const capabilities = plan.recommendations.find((r) => r.id === 'capability:suggestions');
    assert.ok(capabilities);
    assert.ok(Array.isArray(capabilities.proposedValue));
    const taskTypes = plan.recommendations.find((r) => r.id === 'task-type:suggestions');
    assert.ok(taskTypes);
    const config = plan.proposed.files.find((f) => f.path.includes('.factory') && f.path.endsWith(`config.yaml`));
    assert.ok(config);
    assert.match(config.content, /taskTypes:/);
    assert.match(config.content, /database-migration/);
  });
});

test('planFactorySetup preserves user-owned config in RECONCILE mode', async () => {
  await withRepo({ 'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'vitest run' } }, null, 2) }, async (root) => {
    // Simulate existing setup with a custom test command (user-owned).
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(path.join(root, '.factory/config.yaml'), [
      'project:', '  baseBranch: main',
      'commands:', '  test: ./scripts/test-ci.sh',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(root, 'factory.yaml'), 'stages:\n  - name: plan\n', 'utf8');

    const plan = await planFactorySetup({ cwd: root, answers: { 'workflow-preset': 'balanced' } });
    assert.equal(plan.mode, 'RECONCILE'); // factory.yaml + .factory/config.yaml exist
    const configProposed = plan.proposed.files.find((f) => f.path.includes('.factory') && f.path.endsWith(`config.yaml`));
    assert.ok(configProposed);
    // The user-owned test command must be preserved in the proposed config.
    assert.match(configProposed.content, /test: \.\/scripts\/test-ci\.sh/);
    // Existing factory.yaml is user-presence; config is created fresh here.
  });
});
