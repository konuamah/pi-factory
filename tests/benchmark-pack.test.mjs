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

function envFor(workspace, extra = {}) {
  return { ...process.env, BENCHMARK_APP_DIR: workspace.replace(/\\/g, '/'), ...extra };
}

function makeWorkspace(taskDir = TASK_DIR, prefix = 'bombsite-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const entry of fs.readdirSync(path.join(taskDir, 'environment'), { withFileTypes: true })) {
    if (entry.name === 'Dockerfile') continue;
    fs.cpSync(path.join(taskDir, 'environment', entry.name), path.join(root, entry.name), { recursive: true });
  }
  return root;
}

function grade(workspace, gradePath = GRADE) {
  const logDir = path.join(workspace, 'logs');
  try {
    const stdout = execFileSync(process.execPath, [gradePath], {
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

// --- bombsite-02: status-surface-extension ---

const TASK2 = path.join(process.cwd(), 'harbor', 'tasks', 'bombsite-02-status-surface');
const GRADE2 = path.join(TASK2, 'tests', 'grade.mjs');
const SOLVE2 = path.join(TASK2, 'solution', 'solve.sh');

test('bombsite-02 verifier passes on the reference solution', () => {
  const workspace = makeWorkspace(TASK2, 'bombsite-02-');
  execFileSync('bash', [SOLVE2], { cwd: workspace, env: envFor(workspace), stdio: 'pipe' });
  const result = grade(workspace, GRADE2);
  assert.ok(result.passed, `reference solution should satisfy every check:\n${result.stdout}`);
  assert.equal(result.rewards.task_success, 1);
});

test('bombsite-02 verifier fails on the untouched fixture', () => {
  const result = grade(makeWorkspace(TASK2, 'bombsite-02-'), GRADE2);
  assert.equal(result.passed, false, 'the fixture must start unsolved or the task is trivial');
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /availability-surface-exists/);
});

test('bombsite-02 verifier rejects the surface with the wrong status text', () => {
  const workspace = makeWorkspace(TASK2, 'bombsite-02-');
  const html = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
  const block = '  <section id="availability">\n    <h2>Availability</h2>\n    <p>Not accepting new patients</p>\n  </section>\n';
  fs.writeFileSync(path.join(workspace, 'index.html'), html.replace('<main>', block + '<main>'), 'utf8');
  const result = grade(workspace, GRADE2);
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /availability-status-text/);
});

// --- bombsite-03: verification-adaptation ---

const TASK3 = path.join(process.cwd(), 'harbor', 'tasks', 'bombsite-03-verification-adaptation');
const GRADE3 = path.join(TASK3, 'tests', 'grade.mjs');
const SOLVE3 = path.join(TASK3, 'solution', 'solve.sh');

test('bombsite-03 verifier passes on the reference solution', () => {
  const workspace = makeWorkspace(TASK3, 'bombsite-03-');
  execFileSync('bash', [SOLVE3], { cwd: workspace, env: envFor(workspace), stdio: 'pipe' });
  const result = grade(workspace, GRADE3);
  assert.ok(result.passed, `reference solution should satisfy every check:\n${result.stdout}`);
  assert.equal(result.rewards.task_success, 1);
});

test('bombsite-03 verifier fails on the untouched fixture', () => {
  const result = grade(makeWorkspace(TASK3, 'bombsite-03-'), GRADE3);
  assert.equal(result.passed, false, 'the fixture must start unsolved or the task is trivial');
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /all-three-credentials-present/);
});

test('bombsite-03 verifier rejects credentials outside the Experience section', () => {
  const workspace = makeWorkspace(TASK3, 'bombsite-03-');
  const html = fs.readFileSync(path.join(workspace, 'index.html'), 'utf8');
  const block = '  <ul>\n    <li>M.D., University of Ghana Medical School</li>\n    <li>Board Certified, Family Medicine</li>\n    <li>12 years of clinical experience</li>\n  </ul>\n';
  fs.writeFileSync(path.join(workspace, 'index.html'), html.replace('<main>', block + '<main>'), 'utf8');
  const result = grade(workspace, GRADE3);
  assert.equal(result.rewards.task_success, 0);
  assert.match(result.stdout, /credentials-inside-experience/);
});
