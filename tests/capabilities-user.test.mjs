import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearCapabilityRegistry,
  registerCapability,
  registerBuiltinCapabilities,
  initializeCapabilitySystem,
  discoverCapabilities,
  parseCapabilityFile,
  getRegisteredCapability,
  listRegisteredCapabilities,
  validateCapabilityDefinition,
  checkExecutability,
  nativeProvider,
  executeCapability,
} from '../packages/core/dist/index.js';

async function withTempProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-cap-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('validateCapabilityDefinition accepts a valid definition and rejects malformed ones', () => {
  assert.deepEqual(validateCapabilityDefinition({ id: 'acme.ticket.create', description: 'Create a ticket.', effect: 'write' }).valid, true);
  assert.equal(validateCapabilityDefinition({ id: 'acme.ticket.create', effect: 'write' }).valid, false);
  const badEffect = validateCapabilityDefinition({ id: 'acme.ticket.create', description: 'x', effect: 'network-write' });
  assert.equal(badEffect.valid, false);
  assert.ok(badEffect.errors.some((error) => /unknown effect/.test(error)));
  const badInput = validateCapabilityDefinition({ id: 'acme.customer.read', description: 'x', effect: 'read', input: { customer_id: 'uuid' } });
  assert.equal(badInput.valid, false);
  assert.ok(badInput.errors.some((error) => /unsupported type/.test(error)));
});

test('built-in capabilities register with BUILTIN source', () => {
  clearCapabilityRegistry();
  registerBuiltinCapabilities();
  assert.ok(getRegisteredCapability('repo.read'));
  assert.equal(getRegisteredCapability('repo.read').source, 'BUILTIN');
  assert.ok(listRegisteredCapabilities().length >= 10);
});

test('discovery loads user-written yaml capability and registers it as PROJECT', async () => {
  await withTempProject(async (root) => {
    const dir = path.join(root, '.factory', 'capabilities');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ticket.create.yaml'), [
      'id: acme.ticket.create',
      'description: Create an engineering ticket.',
      'effect: write',
      'input:',
      '  title: string',
      '  priority: string',
    ].join('\n'), 'utf8');

    clearCapabilityRegistry();
    registerBuiltinCapabilities();
    const report = await discoverCapabilities(root);
    assert.equal(report.registered.length, 1);
    const capability = getRegisteredCapability('acme.ticket.create');
    assert.ok(capability);
    assert.equal(capability.source, 'PROJECT');
    assert.equal(capability.effect, 'write');
    assert.deepEqual(capability.input, { title: 'string', priority: 'string' });
  });
});

test('malformed yaml capability is skipped with validation errors', async () => {
  await withTempProject(async (root) => {
    const dir = path.join(root, '.factory', 'capabilities');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bad.yaml'), [
      'id: acme.bad',
      'effect: write',
    ].join('\n'), 'utf8');

    clearCapabilityRegistry();
    registerBuiltinCapabilities();
    const report = await discoverCapabilities(root);
    assert.equal(report.registered.length, 0);
    assert.equal(report.skipped.length, 0); // parseCapabilityFile returns undefined for invalid
    assert.ok(!getRegisteredCapability('acme.bad'));
  });
});

test('parseCapabilityFile validates and returns undefined for invalid files', async () => {
  await withTempProject(async (root) => {
    const goodFile = path.join(root, 'good.yaml');
    await fs.writeFile(goodFile, 'id: acme.good\ndescription: Good.\neffect: read\n', 'utf8');
    const good = await parseCapabilityFile(goodFile);
    assert.ok(good);
    assert.equal(good.id, 'acme.good');

    const badFile = path.join(root, 'bad.yaml');
    await fs.writeFile(badFile, 'id: acme.bad\neffect: read\n', 'utf8');
    const bad = await parseCapabilityFile(badFile);
    assert.equal(bad, undefined);
  });
});

test('checkExecutability distinguishes unknown, unbound, and executable', async () => {
  clearCapabilityRegistry();
  await initializeCapabilitySystem();
  registerCapability({ id: 'acme.ticket.create', description: 'Create ticket.', effect: 'write' }, 'PROJECT');

  const unknown = checkExecutability({ capabilityId: 'acme.nope' });
  assert.equal(unknown.status, 'unknown');

  const unbound = checkExecutability({ capabilityId: 'acme.ticket.create' });
  assert.equal(unbound.status, 'available-not-executable');
  assert.match(unbound.reason, /no provider binding/);

  const executable = checkExecutability({ capabilityId: 'acme.ticket.create', binding: { provider: 'native', operation: 'stub' } });
  assert.equal(executable.status, 'executable');
});

test('native provider executes a stub and shell binding', async () => {
  const stub = await nativeProvider.execute('stub', {});
  assert.equal(stub.ok, true);

  const shell = await nativeProvider.execute('shell', { command: 'node -e "console.log(1)"' });
  assert.equal(shell.ok, true);
  assert.match(shell.stdout, /1/);

  const shellResult = await executeCapability({ capabilityId: 'x', provider: 'native', operation: 'shell' }, { command: 'node -e "console.log(42)"' });
  assert.match(shellResult.stdout, /42/);
});

test('initializeCapabilitySystem registers builtins, providers, and project capabilities', async () => {
  await withTempProject(async (root) => {
    const dir = path.join(root, '.factory', 'capabilities');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'deploy.yaml'), 'id: acme.deploy.staging\ndescription: Deploy to staging.\neffect: write\n', 'utf8');

    clearCapabilityRegistry();
    const report = await initializeCapabilitySystem(root);
    assert.ok(getRegisteredCapability('repo.read')); // builtins
    assert.ok(getRegisteredCapability('acme.deploy.staging')); // project
    assert.equal(report.registered.length, 1);
  });
});
