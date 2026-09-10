import test from 'node:test';
import assert from 'node:assert/strict';
import { negotiateStageCapabilities } from '../packages/core/dist/index.js';

const safety = { granted: ['repo.read', 'repo.write', 'shell.execute'], denied: [] };

test('negotiates stage policy with deny precedence and stable denials', () => {
  const result = negotiateStageCapabilities({
    stage: { role: 'builder', allowedTools: ['read', 'bash'], denyTools: ['bash'] },
    skills: [{ id: 'shell', version: '1', description: '', permissions: { allowedTools: ['read', 'bash'] } }],
    safety,
    provider: { available: ['read', 'bash'], unavailable: [], unknown: [] },
  });
  assert.deepEqual(result.granted, ['read']);
  assert.equal(result.denied[0].tool, 'bash');
  assert.equal(result.denied[0].reason, 'stage');
});

test('does not default-allow an unknown tool', () => {
  const result = negotiateStageCapabilities({
    stage: { role: 'planner', allowedTools: ['mcp.graphify'] },
    skills: [{ id: 'graphify', version: '1', description: '', permissions: { allowedTools: ['mcp.graphify'] } }],
    safety: { granted: ['repo.read'], denied: [] },
    provider: { available: [], unavailable: [], unknown: ['mcp.graphify'] },
  });
  assert.deepEqual(result.granted, []);
  assert.equal(result.denied[0].reason, 'unknown-tool');
});

test('uses role defaults when skills make no tool request', () => {
  const result = negotiateStageCapabilities({
    stage: { role: 'discovery' },
    skills: [{ id: 'plain', version: '1', description: '' }],
    safety: { granted: ['repo.read', 'ci.read'], denied: [] },
    provider: { available: ['read', 'grep', 'find', 'ls'], unavailable: [], unknown: [] },
  });
  assert.deepEqual(result.granted, ['read', 'grep', 'find', 'ls']);
});
