import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEffectiveCapabilities,
  capabilitiesToToolNames,
  toolsToRequiredCapabilities,
  defaultCapabilitiesForRole,
  isCapability,
} from '../packages/core/dist/index.js';

test('medium autonomy grants read/write/shell and denies deploy', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['repo.read', 'repo.write', 'shell.execute', 'git.commit', 'deploy.production'],
    autonomy: 'medium',
  });
  assert.deepEqual(result.granted, ['repo.read', 'repo.write', 'shell.execute']);
  assert.deepEqual(result.denied, ['git.commit', 'deploy.production']);
});

test('low autonomy is mostly read-only', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['repo.read', 'repo.write', 'shell.execute', 'ci.read'],
    autonomy: 'low',
  });
  assert.deepEqual(result.granted, ['repo.read', 'ci.read']);
  assert.deepEqual(result.denied, ['repo.write', 'shell.execute']);
});

test('project deny wins over autonomy grant', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['repo.write'],
    autonomy: 'high',
    projectPolicy: { deny: ['repo.write'] },
  });
  assert.deepEqual(result.granted, []);
  assert.deepEqual(result.denied, ['repo.write']);
});

test('node allow can grant a capability beyond autonomy', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['git.commit'],
    autonomy: 'low',
    nodePolicy: { allow: ['git.commit'] },
  });
  assert.deepEqual(result.granted, ['git.commit']);
});

test('unknown or legacy autonomy values default to medium', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['repo.write', 'deploy.production'],
    autonomy: 'safe',
  });
  assert.deepEqual(result.granted, ['repo.write']);
  assert.deepEqual(result.denied, ['deploy.production']);
});

test('deploy.production always requires approval', () => {
  const result = resolveEffectiveCapabilities({
    requested: ['deploy.production'],
    autonomy: 'high',
    nodePolicy: { allow: ['deploy.production'] },
  });
  assert.deepEqual(result.granted, ['deploy.production']);
  assert.deepEqual(result.needsApproval, ['deploy.production']);
});

test('capabilities map to tools and back', () => {
  assert.deepEqual(capabilitiesToToolNames(['repo.read', 'repo.write', 'shell.execute']), ['read', 'grep', 'find', 'ls', 'write', 'edit', 'bash']);
  assert.deepEqual(toolsToRequiredCapabilities(['read', 'edit', 'bash']).sort(), ['repo.read', 'repo.write', 'shell.execute'].sort());
});

test('default capabilities by role', () => {
  assert.deepEqual(defaultCapabilitiesForRole('reviewer'), ['repo.read', 'ci.read']);
  assert.deepEqual(defaultCapabilitiesForRole('builder'), ['repo.read', 'repo.write', 'shell.execute', 'ci.read']);
});

test('isCapability validates the union', () => {
  assert.equal(isCapability('repo.read'), true);
  assert.equal(isCapability('deploy.production'), true);
  assert.equal(isCapability('delete.everything'), false);
});
