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

test('requested tools are passed to Pi SDK as active tool names', async () => {
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
  assert.deepEqual(receivedOptions.tools, ['read', 'bash', 'edit']);
});

test('no requested tools are passed to Pi SDK as an empty active tool list', async () => {
  let receivedOptions;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
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
    executionId: 'exec-no-tools',
    cwd: process.cwd(),
    prompt: 'discover',
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(receivedOptions.tools, []);
});

test('project service modelRegistry resolves provider models for current Pi SDKs', async () => {
  const resolvedModel = { provider: 'demo', id: 'model-1' };
  const serviceModelRegistry = {
    find(provider, model) {
      assert.equal(provider, 'demo');
      assert.equal(model, 'model-1');
      return resolvedModel;
    },
  };
  let receivedOptions;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: {
        inMemory(cwd) {
          return { cwd };
        },
      },
      async createAgentSessionServices() {
        return {
          cwd: process.cwd(),
          agentDir: process.cwd(),
          modelRegistry: serviceModelRegistry,
          settingsManager: {},
          resourceLoader: {},
        };
      },
      async createAgentSession(options) {
        receivedOptions = options;
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  const result = await executor.execute({
    executionId: 'exec-registry-model',
    cwd: process.cwd(),
    prompt: 'plan',
    model: { provider: 'demo', model: 'model-1' },
  });

  assert.equal(result.status, 'completed');
  assert.equal(receivedOptions.model, resolvedModel);
  assert.equal(receivedOptions.modelRegistry, serviceModelRegistry);
});

test('Pi SDK tool objects stay executable through Factory bridge', async () => {
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
        const session = {
          listener: undefined,
          async prompt(text) {
            if (!this.listener || text.includes('Factory executed the tool call')) {
              return;
            }
            this.listener({
              type: 'message_update',
              text: '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>',
            });
          },
          subscribe(listener) {
            this.listener = listener;
            return () => {};
          },
          async abort() {},
          async dispose() {},
        };
        return { session };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  const execution = await executor.execute({
    executionId: 'exec-sdk-tool-shape',
    cwd: process.cwd(),
    prompt: 'build',
    tools: ['bash'],
  });

  assert.equal(execution.status, 'completed');
  assert.deepEqual(receivedOptions.tools, ['bash']);
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

test('missing limits fall back to Factory default timeouts instead of hanging', async () => {
  let aborted = false;
  const session = {
    async prompt() {
      await new Promise(() => {});
    },
    subscribe() {
      return () => {};
    },
    async abort() {
      aborted = true;
    },
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: {
      async create() {
        return { session };
      },
    },
  });

  const result = await Promise.race([
    executor.execute({ executionId: 'exec-default-timeout', cwd: process.cwd(), prompt: 'build' }),
    new Promise((resolve) => setTimeout(() => resolve('HUNG'), 90_000)),
  ]);

  assert.notEqual(result, 'HUNG');
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /model-idle-timeout/);
  assert.equal(aborted, true);
});

test('streaming message_update events are not accumulated into result events', async () => {
  const session = {
    async prompt() {
      for (let i = 0; i < 500; i += 1) {
        this.listener?.({
          type: 'message_update',
          data: { type: 'message_update', message: 'x'.repeat(2000) },
        });
      }
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({
    sessionFactory: { async create() { return { session }; } },
  });

  const result = await executor.execute({ executionId: 'exec-stream-bloat', cwd: process.cwd(), prompt: 'build' });

  assert.equal(result.events.filter((event) => event.type === 'message_update').length, 0);
  assert.ok(JSON.stringify(result.events).length < 10_000);
});

test('model timeout fails a silent SDK turn with a clear watchdog error', async () => {
  let aborted = false;
  const session = {
    async prompt() {
      await new Promise(() => {});
    },
    subscribe() {
      return () => {};
    },
    async abort() {
      aborted = true;
    },
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
    executionId: 'exec-silent-timeout',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 20,
      turnTimeoutMs: 1000,
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(aborted, true);
  assert.match(result.errorMessage, /model-idle-timeout/);
  const timeoutEvent = result.events.find((event) => event.type === 'executor.timeout');
  assert.equal(timeoutEvent?.data?.timeoutType, 'model-idle-timeout');
  assert.ok(timeoutEvent?.data?.lastActivityAt === undefined);
  assert.deepEqual(timeoutEvent?.data?.activityCounts, {});
  assert.equal(timeoutEvent?.data?.graceUsed, false);
});

test('model timeout watchdog resets when SDK events arrive', async () => {
  const session = {
    listener: undefined,
    async prompt() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'working ' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'done' });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      throw new Error('should not abort while progress is flowing');
    },
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
    executionId: 'exec-progress-timeout-reset',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 25,
      turnTimeoutMs: 1000,
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.outputText, 'working done');
  assert.equal(result.events.some((event) => event.type === 'executor.timeout'), false);
});

test('tool execution pauses the model idle watchdog and tools are tracked', async () => {
  // A long tool (200ms) must not trip a 60ms idle watchdog; the tool timeout
  // and turn timeout bound it instead. Tool start/end also count as progress.
  const session = {
    listener: undefined,
    async prompt() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.listener?.({
        type: 'tool_execution_start',
        data: {
          toolCallId: 't1',
          assistantMessageEvent: { type: 'toolCall', name: 'bash' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      this.listener?.({
        type: 'tool_execution_end',
        data: {
          toolCallId: 't1',
          assistantMessageEvent: { type: 'toolCall', name: 'bash' },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'done' });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      throw new Error('should not abort');
    },
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({
    executionId: 'exec-tool-pause',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 60,
      toolTimeoutMs: 1000,
      turnTimeoutMs: 2000,
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.events.some((event) => event.type === 'executor.timeout'), false);
});

test('tool timeout aborts a session when a single tool exceeds its bound', async () => {
  let aborted = false;
  const session = {
    listener: undefined,
    async prompt() {
      // Emit a tool start, then never emit tool end or more events. The tool
      // timeout (30ms) should fire before the model idle watchdog (1000ms).
      this.listener?.({
        type: 'tool_execution_start',
        data: {
          toolCallId: 't1',
          assistantMessageEvent: { type: 'toolCall', name: 'bash' },
        },
      });
      await new Promise(() => {});
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      aborted = true;
    },
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
    executionId: 'exec-tool-timeout',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 1000,
      toolTimeoutMs: 30,
      turnTimeoutMs: 2000,
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /tool-timeout/);
  assert.equal(aborted, true);
  const ev = result.events.find((e) => e.type === 'executor.timeout');
  assert.equal(ev?.data?.timeoutType, 'tool-timeout');
  assert.equal(ev?.data?.executionState, 'tool');
  assert.ok(ev?.data?.activeTools.some((t) => t.name === 'bash'));
});

test('run deadline is not reset by a new prompt and fails deterministically', async () => {
  let aborted = false;
  const session = {
    listener: undefined,
    async prompt() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'tick ' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'tock' });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      aborted = true;
    },
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({
    executionId: 'exec-run-deadline',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 5000,
      turnTimeoutMs: 5000,
      runDeadlineAt: Date.now() - 1, // already spent
      runTimeoutMs: 5000,
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /run-timeout/);
  assert.equal(aborted, false); // never started a session, so nothing to abort
  const ev = result.events.find((e) => e.type === 'executor.timeout');
  assert.equal(ev?.data?.timeoutType, 'run-timeout');
});

test('model idle timeout emits detailed diagnostics', async () => {
  let aborted = false;
  const session = {
    listener: undefined,
    async prompt() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.listener?.({ type: 'message_update', text: 'some narration' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // then go silent and never emit again
      await new Promise(() => {});
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      aborted = true;
    },
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({
    executionId: 'exec-diagnostics',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 25,
      turnTimeoutMs: 5000,
    },
  });
  assert.equal(result.status, 'failed');
  const ev = result.events.find((e) => e.type === 'executor.timeout');
  assert.equal(ev?.data?.timeoutType, 'model-idle-timeout');
  assert.ok(ev?.data?.lastActivityType === 'message_update');
  assert.ok(typeof ev?.data?.lastActivityAt === 'number');
  assert.deepEqual(ev?.data?.activityCounts, { message_update: 1 });
  assert.equal(ev?.data?.graceUsed, false);
  assert.equal(aborted, true);
});

test('bounded adaptive grace extends the model idle window once per turn', async () => {
  // modelIdleTimeoutMs=30 with a 60ms gap would normally fire the idle
  // watchdog. Adaptive grace (durationMs=100) should keep the turn alive once.
  let aborted = false;
  const session = {
    listener: undefined,
    async prompt() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      this.listener?.({ type: 'message_update', text: 'thinking hard' });
      await new Promise((resolve) => setTimeout(resolve, 50)); // exceeds idle 30ms
      this.listener?.({ type: 'message_update', text: 'done' });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {
      aborted = true;
    },
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({
    executionId: 'exec-grace',
    cwd: process.cwd(),
    prompt: 'build',
    limits: {
      modelIdleTimeoutMs: 30,
      turnTimeoutMs: 2000,
      adaptiveGrace: { enabled: true, durationMs: 100, maxExtensionsPerTurn: 1 },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(aborted, false);
  const timeoutEvent = result.events.find((e) => e.type === 'executor.timeout');
  assert.equal(timeoutEvent, undefined);
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

test('provider packages are resolved through session services, not a bare runtime', async () => {
  // Regression for the Gate 5d failure: a bare ModelRuntime.create() knows only
  // built-in providers, so a model from an installed provider package (e.g.
  // commandcode) cannot be resolved unless the runtime from
  // createAgentSessionServices -- which registers package providers -- is used.
  const calls = [];
  let receivedModel;
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: { inMemory: (cwd) => ({ cwd }) },
      // Present but deliberately unable to resolve the model, to prove it is
      // not the runtime that wins.
      ModelRuntime: {
        async create() {
          calls.push('bare-runtime');
          return { getModel: () => undefined };
        },
      },
      async createAgentSessionServices({ cwd }) {
        calls.push(`services:${cwd}`);
        return {
          cwd,
          agentDir: '/tmp/agent',
          modelRuntime: {
            getModel: (provider, model) => ({ provider, id: model }),
          },
          settingsManager: { id: 'settings' },
          resourceLoader: { id: 'resources' },
          diagnostics: [],
        };
      },
      async createAgentSession(options) {
        receivedModel = options.model;
        calls.push(`session:runtime=${options.modelRuntime ? 'yes' : 'no'}`);
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  const result = await executor.execute({
    executionId: 'exec-services-model',
    cwd: '/work/app',
    prompt: 'review',
    model: { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' },
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['services:/work/app', 'session:runtime=yes']);
  assert.equal(receivedModel.provider, 'commandcode');
});

test('unresolvable model reports Pi extension diagnostics instead of a bare message', async () => {
  const sdkFactory = createPiSdkSessionFactory({
    sdkLoader: async () => ({
      SessionManager: { inMemory: (cwd) => ({ cwd }) },
      async createAgentSessionServices({ cwd }) {
        return {
          cwd,
          agentDir: '/tmp/agent',
          modelRuntime: { getModel: () => undefined },
          diagnostics: [{ type: 'error', message: 'Extension "pi-broken" failed to load' }],
        };
      },
      async createAgentSession() {
        return { session: makeSdkSession() };
      },
    }),
  });

  const executor = new PiAgentExecutor({ sessionFactory: sdkFactory });
  await assert.rejects(
    executor.execute({
      executionId: 'exec-services-diagnostics',
      cwd: process.cwd(),
      prompt: 'review',
      model: { provider: 'commandcode', model: 'nope' },
    }),
    /could not be resolved.*pi-broken/s,
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

test('recorded events carry monotonic arrival timestamps', async () => {
  const events = [];
  const session = {
    async prompt() {
      this.listener?.({ type: 'message_start', data: { message: 'x' } });
      await new Promise((resolve) => setTimeout(resolve, 15));
      this.listener?.({ type: 'message_end', data: { message: 'x' } });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({ executionId: 'exec-at', cwd: process.cwd(), prompt: 'build' });
  const stamped = result.events.filter((event) => event.type === 'message_start' || event.type === 'message_end');
  assert.equal(stamped.length, 2);
  for (const event of stamped) {
    assert.equal(typeof event.at, 'number');
  }
  assert.ok(stamped[1].at >= stamped[0].at, 'timestamps must be monotonic');
});

test('SDK assistant stopReason error fails execution even with empty text', async () => {
  const session = {
    async prompt() {
      this.listener?.({
        type: 'message_end',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            stopReason: 'error',
            errorMessage: "Cannot read properties of undefined (reading 'includes')",
          },
        },
      });
    },
    subscribe(listener) {
      this.listener = listener;
      return () => {};
    },
    async abort() {},
    async dispose() {},
  };
  const executor = new PiAgentExecutor({ sessionFactory: { async create() { return { session }; } } });
  const result = await executor.execute({ executionId: 'exec-sdk-error', cwd: process.cwd(), prompt: 'discover' });
  assert.equal(result.status, 'failed');
  assert.match(result.errorMessage, /Cannot read properties of undefined/);
  assert.equal(result.outputText, '');
});
