import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Guards the Gate 4 property: the bombsite-01 verifier must pass on the
// reference solution and FAIL on the untouched fixture. A verifier that only
// ever returns 1.0 validates nothing.

const TASK_DIR = path.join(process.cwd(), 'harbor', 'tasks', 'bombsite-01-ui-shell');
const GRADE = path.join(TASK_DIR, 'tests', 'grade.mjs');
const SOLVE = path.join(TASK_DIR, 'solution', 'solve.sh');

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bombsite-01-'));
  for (const entry of fs.readdirSync(path.join(TASK_DIR, 'environment'), { withFileTypes: true })) {
    if (entry.name === 'Dockerfile') continue;
    fs.cpSync(path.join(TASK_DIR, 'environment', entry.name), path.join(root, entry.name), { recursive: true });
  }
  return root;
}

function envFor(workspace, extra = {}) {
  return { ...process.env, BENCHMARK_APP_DIR: workspace.replace(/\\/g, '/'), ...extra };
}

function grade(workspace) {
  const logDir = path.join(workspace, 'logs');
  try {
    const stdout = execFileSync(process.execPath, [GRADE], {
      cwd: workspace,
      env: envFor(workspace, { BENCHMARK_LOG_DIR: logDir }),
      encoding: 'utf8',
    });
    return { passed: true, stdout, rewards: JSON.parse(fs.readFileSync(path.join(logDir, 'reward.json'), 'utf8')) };
  } catch (error) {
    return {
      passed: false,
      stdout: error.stdout ?? '',
      rewards: fs.existsSync(path.join(logDir, 'reward.json'))
        ? JSON.parse(fs.readFileSync(path.join(logDir, 'reward.json'), 'utf8'))
        : undefined,
    };
  }
}

test('bombsite-01 verifier passes on the reference solution', () => {
  const workspace = makeWorkspace();
  execFileSync('bash', [SOLVE], { cwd: workspace, env: envFor(workspace), stdio: 'pipe' });
  const result = grade(workspace);
  assert.ok(result.passed, `reference solution should satisfy every check:\n${result.stdout}`);
  assert.equal(result.rewards.task_success, 1);
});

test('bombsite-01 verifier fails on the untouched fixture', () => {
  const result = grade(makeWorkspace());
  assert.equal(result.passed, false, 'the fixture must start unsolved or the task is trivial');
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /nav-is-a-list/);
});

test('bombsite-01 verifier rejects a CSS shortcut', () => {
  const workspace = makeWorkspace();
  fs.writeFileSync(path.join(workspace, 'styles.css'), 'nav ul { list-style: none }\n');
  const result = grade(workspace);
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /no-css-introduced/);
});
