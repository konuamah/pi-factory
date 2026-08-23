import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverSkillFiles, parseSkillFile, skillFileToContract, skillContractToPrompt, resetFactorySkills, initializeFactorySkills, listFactorySkills } from '../packages/core/dist/index.js';

test('parseSkillFile reads name, description, body, and metadata', async () => {
  const raw = `---
name: postgres-migrations
description: Safely create and validate PostgreSQL migrations.
metadata:
  version: 2.1.0
  provides:
    - database-migration
    - migration-validation
  stages:
    - build
    - review
  taskTypes:
    - database-change
  constitutionAreas:
    - 48
    - 49
allowed-tools: read write bash grep
---

# Postgres Migrations

## Usage

Run migrations with:
\`\`\`bash
./scripts/migrate.sh
\`\`\`
`;
  const parsed = parseSkillContent(raw, '/tmp/skill.md');
  assert.ok(parsed);
  assert.equal(parsed.name, 'postgres-migrations');
  assert.equal(parsed.description, 'Safely create and validate PostgreSQL migrations.');
  assert.match(parsed.body, /Run migrations with/);
  assert.deepEqual(parsed.allowedTools, ['read', 'write', 'bash', 'grep']);
  assert.deepEqual(parsed.metadata.provides, ['database-migration', 'migration-validation']);
  assert.deepEqual(parsed.metadata.stages, ['build', 'review']);
});

test('skillFileToContract maps markdown metadata to a capability-aware SkillContract', async () => {
  const parsed = parseSkillContent(`---
name: postgres-migrations
description: Safely create and validate PostgreSQL migrations.
metadata:
  version: 2.1.0
  provides:
    - database-migration
  stages:
    - build
  taskTypes:
    - database-change
allowed-tools: read write bash
---

# Body
`, '/tmp/skill.md');
  const contract = skillFileToContract(parsed);
  assert.equal(contract.id, 'postgres-migrations');
  assert.equal(contract.version, '2.1.0');
  assert.deepEqual(contract.provides?.capabilities, ['database-migration']);
  assert.deepEqual(contract.applicability?.stages, ['build']);
  assert.deepEqual(contract.permissions?.allowedTools, ['read', 'write', 'bash']);
  assert.deepEqual(contract.taskTypes, ['database-change']);
});

test('skillContractToPrompt includes frontmatter-derived context plus markdown body', () => {
  const contract = {
    id: 'postgres-migrations',
    version: '2.1.0',
    description: 'Safely create and validate PostgreSQL migrations.',
    provides: { capabilities: ['database-migration'] },
  };
  const prompt = skillContractToPrompt(contract, '## Usage\nRun the migration.');
  assert.match(prompt, /# Skill: postgres-migrations@2\.1\.0/);
  assert.match(prompt, /Capabilities: database-migration/);
  assert.match(prompt, /## Usage/);
  assert.match(prompt, /Run the migration\./);
});

test('discoverSkillFiles finds SKILL.md directories and initializeFactorySkills loads them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-skill-loader-'));
  try {
    const skillDir = path.join(root, '.pi', 'skills', 'postgres-migrations');
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---
name: postgres-migrations
description: Safely create and validate PostgreSQL migrations.
metadata:
  provides:
    - database-migration
---

# Body
`, 'utf8');

    const files = await discoverSkillFiles(path.join(root, '.pi', 'skills'));
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('SKILL.md'));

    resetFactorySkills();
    const loaded = await initializeFactorySkills(root);
    const skills = listFactorySkills();
    assert.ok(skills.some((skill) => skill.id === 'postgres-migrations'));
    assert.ok(loaded === undefined || loaded === undefined); // returns void
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Export parseSkillContent for direct testing
import { parseSkillContent } from '../packages/core/dist/index.js';
