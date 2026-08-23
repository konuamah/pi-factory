import test from 'node:test';
import assert from 'node:assert/strict';
import { checkToolCall, buildResourcePolicyForContext, toolToCapability } from '../packages/core/dist/index.js';

function context(overrides = {}) {
  return {
    executionId: 'exec-1',
    cwd: process.cwd(),
    grantedCapabilities: ['repo.read', 'repo.write', 'shell.execute'],
    deniedCapabilities: [],
    needsApproval: [],
    approvedCapabilities: new Set(),
    ...overrides,
  };
}

test('allows a tool whose capability is granted', () => {
  const decision = checkToolCall({ toolName: 'read', args: { path: 'src/a.ts' }, context: context() });
  assert.equal(decision.action, 'allow');
});

test('denies a tool whose capability is denied', () => {
  const decision = checkToolCall({
    toolName: 'write',
    args: { path: 'src/a.ts' },
    context: context({ deniedCapabilities: ['repo.write'] }),
  });
  assert.equal(decision.action, 'deny');
  assert.equal(decision.rule, 'capability-deny');
});

test('denies a tool whose capability is not granted', () => {
  const decision = checkToolCall({
    toolName: 'bash',
    args: { command: 'ls' },
    context: context({ grantedCapabilities: ['repo.read'] }),
  });
  assert.equal(decision.action, 'deny');
  assert.equal(decision.rule, 'capability-not-granted');
});

test('requires approval for a needsApproval capability unless already approved', () => {
  const decision = checkToolCall({
    toolName: 'bash',
    args: { command: 'deploy' },
    context: context({ needsApproval: ['shell.execute'] }),
  });
  assert.equal(decision.action, 'require-approval');
  assert.equal(decision.capability, 'shell.execute');

  const approved = new Set(['shell.execute']);
  const second = checkToolCall({
    toolName: 'bash',
    args: { command: 'deploy' },
    context: context({ needsApproval: ['shell.execute'], approvedCapabilities: approved }),
  });
  assert.equal(second.action, 'allow');
});

test('enforces skill allowedTools', () => {
  const skills = [{ id: 'reviewer', version: '1', description: '', permissions: { allowedTools: ['read', 'grep'] } }];
  const ok = checkToolCall({ toolName: 'read', args: { path: 'a' }, context: context({ skills }) });
  assert.equal(ok.action, 'allow');
  const denied = checkToolCall({ toolName: 'write', args: { path: 'a' }, context: context({ skills }) });
  assert.equal(denied.action, 'deny');
  assert.equal(denied.rule, 'skill-tool-denied');
});

test('enforces forbidden write scopes', () => {
  const decision = checkToolCall(
    { toolName: 'write', args: { path: '.github/workflows/x.yml' }, context: context() },
    { forbiddenWriteScopes: ['.github/'] },
  );
  assert.equal(decision.action, 'deny');
  assert.equal(decision.rule, 'path-policy');
});

test('reviewer resource policy forbids dangerous bash commands', () => {
  const policy = buildResourcePolicyForContext(context({ role: 'reviewer' }));
  assert.ok(policy?.forbiddenCommands?.length);
  const denied = checkToolCall(
    { toolName: 'bash', args: { command: 'git push origin main' }, context: context({ role: 'reviewer' }) },
    policy,
  );
  assert.equal(denied.action, 'deny');
  assert.equal(denied.rule, 'path-policy');
});

test('toolToCapability maps built-in tools', () => {
  assert.equal(toolToCapability('read'), 'repo.read');
  assert.equal(toolToCapability('write'), 'repo.write');
  assert.equal(toolToCapability('bash'), 'shell.execute');
  assert.equal(toolToCapability('mcp.custom'), undefined);
});
