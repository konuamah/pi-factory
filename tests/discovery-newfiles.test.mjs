import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateDiscoveryOutput } from '../packages/core/dist/runtime/discovery-validate.js';
import { buildPlanArtifact, extractDiscoveryNewFiles } from '../packages/core/dist/runtime/planner.js';

async function withTempRepo(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-newfiles-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const baseEvidence = (root) => ({
  root,
  observedFiles: ['index.html', 'script.js', 'package.json'],
  candidateFiles: ['index.html', 'script.js'],
  snippets: [],
  terms: ['contact', 'form'],
  truncated: false,
});

test('validateDiscoveryOutput accepts a to-be-created newFile without requiring existence', async () => {
  await withTempRepo({
    'index.html': '<html></html>',
    'script.js': '// script',
  }, async (root) => {
    const output = JSON.stringify({
      status: 'complete',
      implementationSurface: 'identified',
      files: ['index.html', 'script.js'],
      newFiles: ['data/schedule.js'],
      evidence: [
        { status: 'confirmed', file: 'index.html', finding: 'Has the contact form.' },
      ],
      unknowns: ['data/schedule.js must be created to hold visit slots.'],
    });
    const result = await validateDiscoveryOutput(output, root, baseEvidence(root));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.discovery.files, ['index.html', 'script.js']);
      assert.deepEqual(result.discovery.newFiles, ['data/schedule.js']);
    }
  });
});

test('validateDiscoveryOutput still rejects a non-existent file listed in files[]', async () => {
  await withTempRepo({ 'index.html': '<html></html>' }, async (root) => {
    const output = JSON.stringify({
      status: 'complete',
      implementationSurface: 'identified',
      files: ['index.html', 'missing.js'],
      evidence: [
        { status: 'confirmed', file: 'index.html', finding: 'Has the form.' },
      ],
      unknowns: [],
    });
    const result = await validateDiscoveryOutput(output, root, baseEvidence(root));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /do not exist/);
  });
});

test('validateDiscoveryOutput rejects the same file in both files[] and newFiles[]', async () => {
  await withTempRepo({
    'index.html': '<html></html>',
    'script.js': '// script',
  }, async (root) => {
    const output = JSON.stringify({
      status: 'complete',
      implementationSurface: 'identified',
      files: ['index.html'],
      newFiles: ['index.html'],
      evidence: [{ status: 'confirmed', file: 'index.html', finding: 'Form.' }],
      unknowns: [],
    });
    const result = await validateDiscoveryOutput(output, root, baseEvidence(root));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /both files\[\] and newFiles\[\]/);
  });
});

test('validateDiscoveryOutput treats newFiles-only discovery as identified (not missing)', async () => {
  await withTempRepo({ 'index.html': '<html></html>' }, async (root) => {
    const output = JSON.stringify({
      status: 'complete',
      implementationSurface: 'identified',
      files: ['index.html'],
      newFiles: ['data/config.js'],
      evidence: [{ status: 'confirmed', file: 'index.html', finding: 'Loads the config.' }],
      unknowns: ['data/config.js does not exist yet.'],
    });
    const result = await validateDiscoveryOutput(output, root, baseEvidence(root));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.discovery.implementationSurface, 'identified');
  });
});

test('buildPlanArtifact merges discovery newFiles into the contract target files', () => {
  const discoveryText = JSON.stringify({
    status: 'complete',
    files: ['index.html'],
    newFiles: ['data/schedule.js'],
  });
  const plan = buildPlanArtifact({
    goal: 'Add visit availability',
    config: {
      git: { baseBranch: 'main' },
      approval: { finalMerge: 'required' },
      repair: { maxAttempts: 3 },
      resolvedWorkflow: {
        stages: [
          { name: 'build', type: 'agent', role: 'builder', dependsOn: [] },
        ],
      },
    },
    discoveryText,
    planText: ['1. PLANNING DECISIONS', '- Add availability.', '2. TARGET FILES', '- index.html', 'WAITING_FOR_APPROVAL'].join('\n'),
  });
  const targets = plan.implementationContract?.targetFiles ?? [];
  assert.ok(targets.includes('index.html'), 'existing target preserved');
  assert.ok(targets.includes('data/schedule.js'), `discovery newFile should be a target; got ${targets.join(', ')}`);
});

test('extractDiscoveryNewFiles returns [] for absent or non-JSON discovery text', () => {
  assert.deepEqual(extractDiscoveryNewFiles(undefined), []);
  assert.deepEqual(extractDiscoveryNewFiles('not json'), []);
  assert.deepEqual(extractDiscoveryNewFiles(JSON.stringify({ files: ['a.js'] })), []);
  assert.deepEqual(extractDiscoveryNewFiles(JSON.stringify({ newFiles: ['a.js', 'b/c.js'] })), ['a.js', 'b/c.js']);
});
