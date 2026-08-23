import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFactorySkill, resolveFactorySkills } from '../packages/core/dist/index.js';

const base = `test-skill-${Date.now()}`;

registerFactorySkill({
  id: `${base}-api`,
  version: '1.0.0',
  description: 'Fastify API skill',
  taskTypes: ['api'],
  provides: { capabilities: ['http-routing', 'validation'] },
  applicability: {
    stages: ['build'],
    languages: ['TypeScript'],
    frameworks: ['fastify'],
    taskKinds: ['api'],
  },
  permissions: { allowedTools: ['read', 'edit'] },
  exclusiveGroup: `${base}-api-framework`,
});

registerFactorySkill({
  id: `${base}-db`,
  version: '1.0.0',
  description: 'Prisma DB skill',
  taskTypes: ['database-change'],
  provides: { capabilities: ['database-query'] },
  applicability: {
    stages: ['build'],
    languages: ['TypeScript'],
    taskKinds: ['database-change'],
  },
  permissions: { allowedTools: ['read', 'edit'] },
});

registerFactorySkill({
  id: `${base}-tests`,
  version: '1.0.0',
  description: 'Vitest testing skill',
  taskTypes: ['testing'],
  provides: { capabilities: ['integration-testing'] },
  applicability: {
    stages: ['build'],
    languages: ['TypeScript'],
    frameworks: ['vitest'],
    taskKinds: ['testing'],
  },
  permissions: { allowedTools: ['read', 'edit'] },
  exclusiveGroup: `${base}-test-framework`,
});

registerFactorySkill({
  id: `${base}-jest-tests`,
  version: '1.0.0',
  description: 'Generic testing skill',
  taskTypes: ['testing'],
  provides: { capabilities: ['integration-testing'] },
  applicability: {
    stages: ['build'],
    languages: ['TypeScript'],
    taskKinds: ['testing'],
  },
  permissions: { allowedTools: ['read', 'edit'] },
  exclusiveGroup: `${base}-test-framework`,
  conflictsWith: [`${base}-tests`],
});

test('resolveFactorySkills selects a minimal bundle covering required capabilities', () => {
  const selection = resolveFactorySkills({
    goal: 'Add paginated customer API and update tests',
    stage: 'build',
    languages: ['TypeScript'],
    frameworks: ['fastify', 'vitest'],
    taskKinds: ['api', 'testing', 'database-change'],
    requiredCapabilities: ['http-routing', 'database-query', 'integration-testing'],
    availableTools: ['read', 'edit'],
  });

  assert.deepEqual(selection.capabilityCoverage.missing, []);
  assert.deepEqual(selection.capabilityCoverage.covered.sort(), ['database-query', 'http-routing', 'integration-testing']);
  assert.equal(selection.selected.length, 3);
  assert.ok(selection.selected.some((item) => item.skill.id === `${base}-api`));
  assert.ok(selection.selected.some((item) => item.skill.id === `${base}-db`));
  assert.ok(selection.selected.some((item) => item.skill.id === `${base}-tests`));
  assert.ok(selection.rejected.some((item) => item.skill.id === `${base}-jest-tests`));
});

test('resolveFactorySkills reports missing capabilities when no compatible skill exists', () => {
  const selection = resolveFactorySkills({
    goal: 'Do a PCI-compliant card migration',
    stage: 'build',
    languages: ['TypeScript'],
    frameworks: ['fastify'],
    taskKinds: ['database-change'],
    requiredCapabilities: ['pci-card-migration'],
    availableTools: ['read', 'edit'],
  });

  assert.deepEqual(selection.capabilityCoverage.covered, []);
  assert.deepEqual(selection.capabilityCoverage.missing, ['pci-card-migration']);
  assert.equal(selection.confidence, 0);
});
