import test from 'node:test';
import assert from 'node:assert/strict';
import { promptFactorySetupChoices } from '../packages/adapters/pi/dist/setup-wizard.js';

const piStatus = {
  agentDir: '/tmp/pi-agent',
  globalSettingsPath: '/tmp/pi-agent/settings.json',
  projectSettingsPath: '/repo/.pi/settings.json',
  authPath: '/tmp/pi-agent/auth.json',
  modelsPath: '/tmp/pi-agent/models.json',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-20250514',
  enabledModels: [],
  authProviders: ['anthropic'],
  customProviderCount: 0,
  customModelCount: 0,
  hasModelSelection: true,
  hasAuth: true,
};

test('promptFactorySetupChoices can apply the Pi default model to all roles', async () => {
  const choices = await promptFactorySetupChoices(
    {
      notify() {},
      setWidget() {},
      select: async (title, _options) => {
        if (title === 'Factory workflow preset') {
          return 'Balanced — Standard plan, build, verify, approve, merge flow';
        }
        return 'Use Pi default for all roles — anthropic/claude-sonnet-4-20250514';
      },
    },
    piStatus,
  );

  assert.equal(choices.workflowPreset, 'balanced');
  assert.deepEqual(choices.modelAssignments.discovery, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
  assert.deepEqual(choices.modelAssignments.planner, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
  assert.deepEqual(choices.modelAssignments.builder, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
  assert.deepEqual(choices.modelAssignments.reviewer, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
  assert.deepEqual(choices.modelAssignments.repair, {
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  });
});

test('promptFactorySetupChoices can collect per-role manual models', async () => {
  const selections = [
    'Fast — Lighter-weight plan, build, approve, merge flow',
    'Choose per role — Assign or skip models for discovery, planner, builder, reviewer, and repair',
    'Enter provider/model manually',
    'Enter provider/model manually',
    'Skip this role',
    'Use Pi default — anthropic/claude-sonnet-4-20250514',
    'Enter provider/model manually',
  ];
  const inputs = ['openai', 'gpt-5', 'anthropic', 'claude-opus-4-20250514', 'openai', 'gpt-5-mini'];
  const ui = {
    notify() {},
    setWidget() {},
    select: async () => selections.shift(),
    input: async () => inputs.shift(),
  };

  const choices = await promptFactorySetupChoices(ui, piStatus);
  assert.equal(choices.workflowPreset, 'fast');
  assert.deepEqual(choices.modelAssignments.discovery, { provider: 'openai', model: 'gpt-5' });
  assert.deepEqual(choices.modelAssignments.planner, { provider: 'anthropic', model: 'claude-opus-4-20250514' });
  assert.equal(choices.modelAssignments.builder, undefined);
  assert.deepEqual(choices.modelAssignments.reviewer, { provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
  assert.deepEqual(choices.modelAssignments.repair, { provider: 'openai', model: 'gpt-5-mini' });
});
