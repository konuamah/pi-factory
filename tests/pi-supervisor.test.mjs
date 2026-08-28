import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSupervisoryTurnContract,
  createSupervisoryPiSessionState,
  decideSupervisoryPiTurn,
  observeSupervisoryToolCall,
  observeSupervisoryToolResult,
  registerFactoryPiExtension,
} from '../packages/adapters/pi/dist/index.js';

test('supervisor classifies implementation turns and suggests builder guidance', () => {
  const decision = decideSupervisoryPiTurn('add navbar to the frontend');

  assert.equal(decision.kind, 'implement');
  assert.equal(decision.modelRole, 'builder');
  assert.ok(decision.skillHints.includes('frontend guidance'));
  assert.ok(decision.verificationHints.includes('prefer lint/typecheck/build before browser smoke'));
});

test('supervisor classifies failed check turns as repair', () => {
  const decision = decideSupervisoryPiTurn('pytest failed after the latest backend change');

  assert.equal(decision.kind, 'repair');
  assert.equal(decision.modelRole, 'repair');
  assert.ok(decision.verificationHints.includes('prefer targeted Python tests with hard timeouts'));
  assert.ok(decision.reminders.some((line) => /concrete failing evidence/.test(line)));
});

test('supervisor observes edits, checks, and failed tool results', () => {
  const state = createSupervisoryPiSessionState();

  observeSupervisoryToolCall(state, {
    toolName: 'edit',
    input: { path: 'src/app/page.tsx' },
  });
  observeSupervisoryToolCall(state, {
    toolName: 'bash',
    input: { command: 'npm run typecheck' },
  });
  observeSupervisoryToolResult(state, {
    toolName: 'bash',
    command: 'npm run typecheck',
    status: 'failed',
  });

  assert.deepEqual(state.touchedFiles, ['src/app/page.tsx']);
  assert.deepEqual(state.observedChecks, ['npm run typecheck']);
  assert.deepEqual(state.failures, ['npm run typecheck']);
});

test('turn contract includes current decision and session evidence', () => {
  const state = createSupervisoryPiSessionState();
  state.touchedFiles.push('src/app/page.tsx');
  const decision = decideSupervisoryPiTurn('verify the frontend navbar');
  const contract = buildSupervisoryTurnContract(decision, state);

  assert.match(contract, /Pi supervisory guidance:/);
  assert.match(contract, /Turn kind: verify/);
  assert.match(contract, /Suggested model role: planner/);
  assert.match(contract, /src\/app\/page\.tsx/);
});

test('extension registers supervisor hooks when Pi exposes them', async () => {
  let inputHandler;
  const calls = [];
  const notifications = [];
  const handlers = new Map();
  const pi = {
    registerCommand(name) {
      calls.push(['command', name]);
    },
    on(event, handler) {
      handlers.set(event, handler);
      if (event === 'input') inputHandler = handler;
      calls.push(['hook', event]);
    },
    setModel(model) {
      calls.push(['model', model]);
      return true;
    },
  };

  registerFactoryPiExtension(pi);
  const rewritten = await inputHandler({ text: 'add navbar', source: 'interactive' }, {
    cwd: process.cwd(),
    modelRegistry: { find: () => ({ provider: 'demo', model: 'demo-model' }) },
    ui: { notify: (...args) => notifications.push(args), setWidget() {} },
  });
  await handlers.get('before_agent_start')({}, {
    cwd: process.cwd(),
    ui: { notify: (...args) => notifications.push(args), setWidget() {} },
  });
  handlers.get('tool_result')({ toolName: 'bash', input: { command: 'npm run build' }, isError: true });
  await handlers.get('agent_end')({}, {
    cwd: process.cwd(),
    ui: { notify: (...args) => notifications.push(args), setWidget() {} },
  });

  assert.ok(calls.some(([type, name]) => type === 'command' && name === 'factory'));
  assert.ok(calls.some(([type, name]) => type === 'command' && name === 'supervisor'));
  assert.ok(calls.some(([type, name]) => type === 'hook' && name === 'input'));
  assert.equal(rewritten.action, 'transform');
  assert.match(rewritten.text, /Pi supervisory guidance/);
  assert.match(rewritten.text, /Turn kind: implement/);
  assert.ok(notifications.some(([message, level]) => /Supervisor: implement/.test(message) && level === 'info'));
  assert.ok(notifications.some(([message, level]) => /failing tool/.test(message) && level === 'warning'));
});

test('extension fails loudly when Pi supervisor hooks are unavailable', () => {
  assert.throws(
    () => registerFactoryPiExtension({
      registerCommand() {},
    }),
    /requires lifecycle hooks: missing setModel, on/,
  );
});

test('supervisor status command reports current session state', async () => {
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    setModel() {
      return true;
    },
  };

  registerFactoryPiExtension(pi);
  await handlers.get('input')({ text: 'pytest failed', source: 'interactive' }, {
    cwd: process.cwd(),
    modelRegistry: { find: () => ({}) },
    ui: { notify() {}, setWidget() {} },
  });
  handlers.get('tool_call')({ toolName: 'bash', input: { command: 'pytest tests/test_app.py' } });
  handlers.get('tool_result')({ toolName: 'bash', input: { command: 'pytest tests/test_app.py' }, isError: true });
  await commands.get('supervisor').handler('', {
    cwd: process.cwd(),
    ui: { notify: (...args) => notifications.push(args), setWidget() {} },
  });

  assert.match(notifications[0][0], /Pi supervisor status/);
  assert.match(notifications[0][0], /turn: repair/);
  assert.match(notifications[0][0], /observed checks: pytest tests\/test_app\.py/);
  assert.match(notifications[0][0], /failures: pytest tests\/test_app\.py/);
});
