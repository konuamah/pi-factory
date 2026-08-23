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
