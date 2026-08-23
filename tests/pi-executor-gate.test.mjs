import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentExecutor, wrapToolsWithGate } from '../packages/executors/pi/dist/index.js';

function makeSession(events = []) {
  return {
    async prompt() {
      for (const event of events) {
        // push synchronously via listener captured at subscribe time
      }
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {},
    async dispose() {},
    emit(event) {
      this.listener?.(event);
    },
  };
}

function toolCallEvent(name, args = {}) {
  return {
    type: 'message_update',
    data: {
      assistantMessageEvent: {
        type: 'toolCall',
        partial: { name, arguments: args },
      },
    },
  };
}

test('capability gate strips denied tools from the session tool list', async () => {
  let receivedTools;
  const session = makeSession();
  const sessionFactory = {
    async create(input) {
      receivedTools = input.tools;
      return { session };
    },
  };
  const executor = new PiAgentExecutor({
    sessionFactory,
    capabilityGate: {
      granted: ['repo.read', 'repo.write'],
      denied: ['shell.execute'],
      needsApproval: [],
      toolAllowlist: ['read', 'grep', 'find', 'ls', 'write', 'edit'],
    },
  });
  await executor.execute({
    executionId: 'exec-1',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['read', 'write', 'bash', 'edit'],
    metadata: {},
  });
  assert.deepEqual(receivedTools, ['read', 'write', 'edit']);
});

test('executor records policy violation when a denied tool is used', async () => {
  const session = makeSession();
  const sessionFactory = {
    async create() {
      return { session };
    },
  };
  const executor = new PiAgentExecutor({
    sessionFactory,
    capabilityGate: {
      granted: ['repo.read'],
      denied: ['repo.write'],
      needsApproval: [],
    },
  });
  const resultPromise = executor.execute({
    executionId: 'exec-2',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['read', 'write'],
    metadata: { deniedCapabilities: ['repo.write'] },
  });
  // Emit a tool call for write (denied) after subscribe runs.
  await new Promise((resolve) => setTimeout(resolve, 10));
  session.emit(toolCallEvent('write', { path: 'src/a.ts', content: 'x' }));
  const result = await resultPromise;
  const violations = result.events.filter((event) => event.type === 'policy.violation');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].data?.capability, 'repo.write');
  assert.match(String(violations[0].data?.reason), /denied/);
});

test('executor routes needsApproval capabilities through the approval callback', async () => {
  const session = makeSession();
  let approvalAsked = null;
  let receivedTools = null;
  const sessionFactory = {
    async create(input) {
      receivedTools = input.tools;
      return { session };
    },
  };
  const executor = new PiAgentExecutor({
    sessionFactory,
    capabilityGate: {
      granted: ['shell.execute'],
      denied: [],
      needsApproval: ['shell.execute'],
      onApprovalRequired: (input) => {
        approvalAsked = input;
        return true;
      },
    },
  });
  await executor.execute({
    executionId: 'exec-3',
    cwd: process.cwd(),
    prompt: 'deploy',
    tools: ['bash'],
    metadata: {},
  });
  assert.ok(approvalAsked);
  assert.equal(approvalAsked.capability, 'shell.execute');
  assert.equal(approvalAsked.toolName, 'bash');
  assert.deepEqual(receivedTools, ['bash']);
});

test('wrapToolsWithGate returns structured denial instead of executing', async () => {
  let executed = false;
  const tools = [{ name: 'write', execute: async () => { executed = true; return 'ok'; } }];
  const wrapped = wrapToolsWithGate(tools, {
    context: {
      executionId: 'exec-5',
      cwd: process.cwd(),
      grantedCapabilities: ['repo.read'],
      deniedCapabilities: ['repo.write'],
      needsApproval: [],
      approvedCapabilities: new Set(),
    },
  });
  const result = await wrapped[0].execute({ path: 'src/a.ts', content: 'x' });
  assert.equal(executed, false);
  assert.equal(result.__factory_blocked, true);
  assert.equal(result.capability, 'repo.write');
});

test('wrapToolsWithGate executes when allowed', async () => {
  let executed = false;
  const tools = [{ name: 'read', execute: async () => { executed = true; return 'content'; } }];
  const wrapped = wrapToolsWithGate(tools, {
    context: {
      executionId: 'exec-6',
      cwd: process.cwd(),
      grantedCapabilities: ['repo.read'],
      deniedCapabilities: [],
      needsApproval: [],
      approvedCapabilities: new Set(),
    },
  });
  const result = await wrapped[0].execute({ path: 'a.ts' });
  assert.equal(executed, true);
  assert.equal(result, 'content');
});

test('wrapToolsWithGate requires approval then executes when approved', async () => {
  let executed = false;
  const tools = [{ name: 'bash', execute: async () => { executed = true; return 'done'; } }];
  const wrapped = wrapToolsWithGate(tools, {
    context: {
      executionId: 'exec-7',
      cwd: process.cwd(),
      grantedCapabilities: ['shell.execute'],
      deniedCapabilities: [],
      needsApproval: ['shell.execute'],
      approvedCapabilities: new Set(),
    },
    onApprovalRequired: () => true,
  });
  const result = await wrapped[0].execute({ command: 'ls' });
  assert.equal(executed, true);
  assert.equal(result, 'done');
});

test('executor drops a needsApproval tool when approval is denied', async () => {
  const session = makeSession();
  let receivedTools = null;
  const sessionFactory = {
    async create(input) {
      receivedTools = input.tools;
      return { session };
    },
  };
  const executor = new PiAgentExecutor({
    sessionFactory,
    capabilityGate: {
      granted: ['shell.execute'],
      denied: [],
      needsApproval: ['shell.execute'],
      onApprovalRequired: () => false,
    },
  });
  await executor.execute({
    executionId: 'exec-4',
    cwd: process.cwd(),
    prompt: 'deploy',
    tools: ['bash'],
    metadata: {},
  });
  assert.deepEqual(receivedTools, []);
});
