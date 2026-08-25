import test from 'node:test';
import assert from 'node:assert/strict';
import { PiAgentExecutor, createPiSdkSessionFactory } from '../packages/executors/pi/dist/index.js';

function makeSdkSession() {
  return {
    async prompt() {},
    subscribe() {
      return () => {};
    },
    async abort() {},
    async dispose() {},
  };
}

test('resolved provider/model is passed through to the Pi SDK session', async () => {
  const resolvedModel = { id: 'provider:model-1' };
  let receivedOptions;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      ModelRuntime: {
        async create() {
          return {
            getModel(provider, model) {
              assert.equal(provider, 'demo');
              assert.equal(model, 'model-1');
              return resolvedModel;
            },
          };
        },
      },
      async createAgentSession(options) {
        receivedOptions = options;
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  const result = await executor.execute({
    executionId: 'exec-1',
    cwd: process.cwd(),
    prompt: 'plan',
    model: { provider: 'demo', model: 'model-1' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(receivedOptions.model, resolvedModel);
  assert.equal(result.events.some((event) => event.type === 'model.selection_warning'), false);
});

test('requested tools are resolved to Pi SDK tool objects', async () => {
  let receivedOptions;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      createReadOnlyTools() {
        return [
          { name: 'read', execute: async () => ({ ok: true }) },
          { name: 'grep', execute: async () => ({ ok: true }) },
        ];
      },
      createCodingTools() {
        return [
          { name: 'bash', execute: async () => ({ ok: true }) },
          { name: 'edit', execute: async () => ({ ok: true }) },
        ];
      },
      async createAgentSession(options) {
        receivedOptions = options;
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  const result = await executor.execute({
    executionId: 'exec-tools',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['read', 'bash', 'edit'],
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(receivedOptions.tools.map((tool) => tool.name), ['read', 'bash', 'edit']);
  assert.equal(typeof receivedOptions.tools[0].execute, 'function');
});

test('Pi SDK tools are invoked with toolCallId and params', async () => {
  const invocations = [];
  let receivedOptions;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      createReadOnlyTools() {
        return [];
      },
      createCodingTools() {
        return [
          {
            name: 'bash',
            execute: async (toolCallId, params) => {
              invocations.push({ toolCallId, params });
              return { stdout: 'ok' };
            },
          },
        ];
      },
      async createAgentSession(options) {
        receivedOptions = options;
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  await executor.execute({
    executionId: 'exec-sdk-tool-shape',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  const result = await receivedOptions.tools[0].execute({ command: 'pwd' });
  assert.deepEqual(result, { stdout: 'ok' });
  assert.equal(invocations.length, 1);
  assert.match(invocations[0].toolCallId, /^factory-bash-/);
  assert.deepEqual(invocations[0].params, { command: 'pwd' });
});

test('DSML parser accepts single-pipe delimiter variants', async () => {
  const prompts = [];
  const toolCalls = [];
  const session = {
    listener: undefined,
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) {
        this.listener?.({
          type: 'message_update',
          text: '<｜DSML｜｜tool_calls><｜DSML｜｜invoke name="shell_execute"><｜DSML｜｜parameter name="command" string="true">pwd</｜DSML｜｜parameter></｜DSML｜｜invoke></｜DSML｜｜tool_calls>',
        });
        return;
      }
      this.listener?.({ type: 'message_update', text: 'done' });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async executeTool(name, args) {
      toolCalls.push({ name, args });
      return { stdout: '/tmp/demo\n', exitCode: 0 };
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: {
      async create() {
        return { session };
      },
    },
  });

  const result = await executor.execute({
    executionId: 'exec-dsml-variant',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(toolCalls, [{ name: 'bash', args: { command: 'pwd' } }]);
});

test('malformed DSML markup fails clearly instead of completing as no-op', async () => {
  const session = {
    listener: undefined,
    async prompt() {
      this.listener?.({
        type: 'message_update',
        text: '<｜DSML｜｜tool_calls><｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>',
      });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async executeTool() {
      throw new Error('should not execute malformed markup');
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: {
      async create() {
        return { session };
      },
    },
  });

  const result = await executor.execute({
    executionId: 'exec-malformed-dsml',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /malformed DSML/);
  assert.equal(result.events.some((event) => event.type === 'executor.malformed_dsml_tool_markup'), true);
});

test('missing requested SDK tools fail loudly', async () => {
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      createReadOnlyTools() {
        return [{ name: 'read', execute: async () => ({ ok: true }) }];
      },
      createCodingTools() {
        return [];
      },
      async createAgentSession() {
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  await assert.rejects(
    executor.execute({
      executionId: 'exec-missing-tools',
      cwd: process.cwd(),
      prompt: 'build',
      tools: ['read', 'bash'],
    }),
    /required Factory tool\(s\): bash/,
  );
});

test('DSML tool markup returned as text fails instead of pretending tools executed', async () => {
  const session = {
    listener: undefined,
    async prompt() {
      this.listener?.({
        type: 'message_update',
        text: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="shell.execute"></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
      });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: {
      async create() {
        return { session };
      },
    },
  });

  const result = await executor.execute({
    executionId: 'exec-dsml',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /tool-call markup/);
  assert.equal(result.events.some((event) => event.type === 'executor.unexecuted_tool_markup'), true);
});

test('DSML tool markup is bridged through executable session tools', async () => {
  const prompts = [];
  const toolCalls = [];
  const session = {
    listener: undefined,
    async prompt(text) {
      prompts.push(text);
      if (prompts.length === 1) {
        this.listener?.({
          type: 'message_update',
          text: [
            'I need to inspect files.',
            '<｜｜DSML｜｜tool_calls>',
            '<｜｜DSML｜｜invoke name="shell.execute">',
            '<｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter>',
            '<｜｜DSML｜｜parameter name="description" string="true">Show cwd</｜｜DSML｜｜parameter>',
            '</｜｜DSML｜｜invoke>',
            '</｜｜DSML｜｜tool_calls>',
          ].join('\n'),
        });
        return;
      }
      this.listener?.({
        type: 'message_update',
        text: 'I used the tool result and finished.',
      });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async executeTool(name, args) {
      toolCalls.push({ name, args });
      return { stdout: '/tmp/demo\n', exitCode: 0 };
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: {
      async create() {
        return { session };
      },
    },
  });

  const result = await executor.execute({
    executionId: 'exec-dsml-bridge',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(prompts.length, 2);
  assert.deepEqual(toolCalls, [
    {
      name: 'bash',
      args: {
        command: 'pwd',
        description: 'Show cwd',
      },
    },
  ]);
  assert.equal(result.events.some((event) => event.type === 'executor.dsml_tool_completed'), true);
});

test('configured model without provider throws a loud provider resolution error', async () => {
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      async createAgentSession() {
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  await assert.rejects(
    executor.execute({
      executionId: 'exec-2',
      cwd: process.cwd(),
      prompt: 'build',
      model: { model: 'opus' },
    }),
    /provider|resolve/i,
  );
});

test('configured provider/model that cannot be resolved throws loudly', async () => {
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      ModelRuntime: {
        async create() {
          return {
            getModel() {
              return undefined;
            },
          };
        },
      },
      async createAgentSession() {
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  await assert.rejects(
    executor.execute({
      executionId: 'exec-3',
      cwd: process.cwd(),
      prompt: 'review',
      model: { provider: 'demo', model: 'missing-model' },
    }),
    /could not be resolved/i,
  );
});
