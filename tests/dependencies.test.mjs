import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeDependencyKey,
  hydrateWorkspaceDependencies,
  loadEffectiveConfig,
  DependencyHydrationError,
  extractExecutable,
  preflightSetupCommands,
  remediateSetupCommands,
} from '../packages/core/dist/index.js';

async function withWorkspace(configLines, fn, files = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-deps-parent-'));
  const root = path.join(parent, 'workspace');
  const cacheRoot = path.join(parent, 'cache');
  try {
    await fs.mkdir(path.join(root, '.factory'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.factory/config.yaml'),
      [
        'project:',
        '  baseBranch: main',
        'commands:',
        ...configLines.map((line) => `  ${line}`),
        'dependencies:',
        `  cacheRoot: ${JSON.stringify(cacheRoot.replace(/\\/g, '/'))}`,
      ].join('\n'),
      'utf8',
    );
    for (const [rel, content] of Object.entries(files)) {
      const filePath = path.join(root, rel);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
    }
    return await fn(root, cacheRoot);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function hydrate(root, cacheRoot, overrides = {}) {
  const loaded = await loadEffectiveConfig({ cwd: root });
  const config = {
    ...loaded.effectiveConfig,
    dependencies: {
      ...loaded.effectiveConfig.dependencies,
      cacheRoot,
      ...overrides,
    },
  };
  const events = [];
  const result = await hydrateWorkspaceDependencies({
    workspacePath: root,
    projectRoot: root,
    config,
    runId: 'run_test',
    phase: 'test',
    onEvent: async (event) => events.push(event),
  });
  return { result, events };
}

test('dependency hydration runs setup once in auto mode and then uses the marker', async () => {
  await withWorkspace([
    'setup: node -e "require(\'fs\').appendFileSync(\'hydrated.txt\', \'setup\' + String.fromCharCode(10))"',
  ], async (root, cacheRoot) => {
    const first = await hydrate(root, cacheRoot);
    const second = await hydrate(root, cacheRoot);

    assert.equal(first.result.status, 'completed');
    assert.equal(second.result.status, 'skipped');
    assert.equal(second.result.reason, 'dependency marker is current');
    assert.ok(first.events.some((event) => event.type === 'dependencies.hydration_started'));
    assert.ok(first.events.some((event) => event.type === 'dependencies.hydration_completed'));
    assert.ok(second.events.some((event) => event.type === 'dependencies.hydration_skipped'));
    assert.match(await fs.readFile(path.join(root, 'hydrated.txt'), 'utf8'), /^setup\n$/);
    assert.ok(first.result.markerPath);
    await fs.access(first.result.markerPath);
  }, {
    'package.json': JSON.stringify({ name: 'demo' }, null, 2),
    'package-lock.json': '{}\n',
  });
});

test('dependency hydration always mode reruns setup even with a current marker', async () => {
  await withWorkspace([
    'setup: node -e "require(\'fs\').appendFileSync(\'hydrated.txt\', \'setup\' + String.fromCharCode(10))"',
  ], async (root, cacheRoot) => {
    await hydrate(root, cacheRoot, { hydrate: 'always' });
    await hydrate(root, cacheRoot, { hydrate: 'always' });

    assert.equal(await fs.readFile(path.join(root, 'hydrated.txt'), 'utf8'), 'setup\nsetup\n');
  }, {
    'pyproject.toml': '[project]\nname = "demo"\n',
    'uv.lock': '# lock\n',
  });
});

test('dependency hydration disabled or never skips setup', async () => {
  await withWorkspace([
    'setup: node -e "require(\'fs\').writeFileSync(\'should-not-exist.txt\', \'bad\')"',
  ], async (root, cacheRoot) => {
    const disabled = await hydrate(root, cacheRoot, { enabled: false });
    const never = await hydrate(root, cacheRoot, { enabled: true, hydrate: 'never' });

    assert.equal(disabled.result.status, 'skipped');
    assert.equal(never.result.status, 'skipped');
    await assert.rejects(fs.access(path.join(root, 'should-not-exist.txt')));
  }, {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n',
    'Cargo.lock': '# lock\n',
  });
});

test('dependency hydration failure fails loud with event details', async () => {
  await withWorkspace([
    'setup: node -e "process.exit(7)"',
  ], async (root, cacheRoot) => {
    const loaded = await loadEffectiveConfig({ cwd: root });
    const events = [];
    await assert.rejects(
      hydrateWorkspaceDependencies({
        workspacePath: root,
        projectRoot: root,
        config: { ...loaded.effectiveConfig, dependencies: { ...loaded.effectiveConfig.dependencies, cacheRoot } },
        runId: 'run_test',
        phase: 'test',
        onEvent: async (event) => events.push(event),
      }),
      DependencyHydrationError,
    );
    assert.ok(events.some((event) => event.type === 'dependencies.hydration_failed' && event.data.exitCode === 7));
  }, {
    'go.mod': 'module example.com/demo\n',
    'go.sum': '',
  });
});

test('dependency key is language neutral and changes for non-node manifests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-deps-key-'));
  try {
    await fs.writeFile(path.join(root, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    await fs.writeFile(path.join(root, 'Cargo.lock'), '# lock v1\n', 'utf8');

    const first = await computeDependencyKey({ workspacePath: root, setupCommand: 'uv sync --frozen' });
    await fs.writeFile(path.join(root, 'Cargo.lock'), '# lock v2\n', 'utf8');
    const second = await computeDependencyKey({ workspacePath: root, setupCommand: 'uv sync --frozen' });

    assert.notEqual(first, second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('dependency hydration does not create a shared node_modules symlink', async () => {
  await withWorkspace([
    'setup: node -e "require(\'fs\').mkdirSync(\'node_modules\', {recursive:true})"',
  ], async (root, cacheRoot) => {
    await hydrate(root, cacheRoot);
    const stat = await fs.lstat(path.join(root, 'node_modules'));
    assert.equal(stat.isSymbolicLink(), false);
  }, {
    'package.json': JSON.stringify({ name: 'demo' }, null, 2),
  });
});

// --- extractExecutable tests ---

test('extractExecutable parses the first token from a command', () => {
  assert.equal(extractExecutable('pip install -r requirements.txt'), 'pip');
  assert.equal(extractExecutable('npm install'), 'npm');
  assert.equal(extractExecutable('cd frontend && npm install'), 'npm');
  assert.equal(extractExecutable('./mvnw dependency:resolve'), './mvnw');
  assert.equal(extractExecutable('uv sync --frozen'), 'uv');
});

test('extractExecutable returns undefined for cd-only commands', () => {
  assert.equal(extractExecutable('cd frontend'), undefined);
  assert.equal(extractExecutable('cd'), undefined);
});

// --- preflightSetupCommands tests ---

test('preflightSetupCommands passes for available executables', async () => {
  const result = await preflightSetupCommands([
    { name: 'install', command: 'node -e "console.log(1)"' },
  ]);
  assert.equal(result.ok, true);
});

test('preflightSetupCommands fails for missing executables', async () => {
  const result = await preflightSetupCommands([
    { name: 'install-flask', command: 'pip install -r requirements.txt' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.executable, 'pip');
  assert.equal(result.stepName, 'install-flask');
  assert.equal(result.command, 'pip install -r requirements.txt');
});

test('preflightSetupCommands reports alternatives when found', async () => {
  const result = await preflightSetupCommands([
    { name: 'setup', command: 'pip install -r requirements.txt' },
  ]);
  assert.equal(result.ok, false);
  // pip3 exists on this machine, pip does not
  assert.ok(Array.isArray(result.alternatives));
  assert.ok(result.alternatives.includes('pip3'));
});

test('preflightSetupCommands skips shell builtins and relative paths', async () => {
  const result = await preflightSetupCommands([
    { name: 'go', command: 'cd frontend && npm install' },
    { name: 'wrapper', command: './mvnw dependency:resolve' },
    { name: 'script', command: '../scripts/setup.sh' },
  ]);
  assert.equal(result.ok, true);
});

// --- hydrateWorkspaceDependencies preflight integration ---

test('dependency hydration fails at preflight when command is unavailable', async () => {
  await withWorkspace([
    'setup: pip install -r requirements.txt',
  ], async (root, cacheRoot) => {
    const loaded = await loadEffectiveConfig({ cwd: root });
    const events = [];
    await assert.rejects(
      hydrateWorkspaceDependencies({
        workspacePath: root,
        projectRoot: root,
        config: { ...loaded.effectiveConfig, dependencies: { ...loaded.effectiveConfig.dependencies, cacheRoot } },
        runId: 'run_test',
        phase: 'test',
        onEvent: async (event) => events.push(event),
      }),
      DependencyHydrationError,
    );
    assert.ok(events.some((e) => e.type === 'dependencies.preflight'));
    assert.ok(!events.some((e) => e.type === 'dependencies.hydration_started'));
  }, {
    'pyproject.toml': '[project]\nname = "demo"\n',
  });
});

test('dependency hydration skips preflight for available executables', async () => {
  await withWorkspace([
    'setup: node -v',
  ], async (root, cacheRoot) => {
    const result = await hydrate(root, cacheRoot);
    assert.equal(result.result.status, 'completed');
  }, {
    'package.json': JSON.stringify({ name: 'demo' }, null, 2),
  });
});

// --- remediation tests ---

test('remediateSetupCommands finds pip3 replacement for pip', async () => {
  const result = await remediateSetupCommands([
    { name: 'install-flask', command: 'pip install -r requirements.txt' },
  ]);
  assert.ok(result);
  assert.equal(result.executable, 'pip');
  assert.equal(result.replacement, 'pip3');
  assert.equal(result.remediatedCommand, 'pip3 install -r requirements.txt');
  assert.equal(result.temporary, true);
  assert.equal(result.confidence, 'HIGH');
});

test('remediateSetupCommands skips available executables', async () => {
  const result = await remediateSetupCommands([
    { name: 'install', command: 'npm install' },
  ]);
  assert.equal(result, undefined);
});

test('remediateSetupCommands preserves cd prefix in command', async () => {
  const result = await remediateSetupCommands([
    { name: 'install-flask', command: 'cd flask && pip install -r requirements.txt' },
  ]);
  assert.ok(result);
  assert.equal(result.remediatedCommand, 'cd flask && pip3 install -r requirements.txt');
});

test('dependency hydration accepts approved remediation', async () => {
  await withWorkspace([
    'setup: pip --version',
  ], async (root, cacheRoot) => {
    const loaded = await loadEffectiveConfig({ cwd: root });
    const events = [];
    let offered = false;
    const result = await hydrateWorkspaceDependencies({
      workspacePath: root,
      projectRoot: root,
      config: { ...loaded.effectiveConfig, dependencies: { ...loaded.effectiveConfig.dependencies, cacheRoot } },
      runId: 'run_test',
      phase: 'test',
      onEvent: async (event) => events.push(event),
      onRemediation: async (candidate) => {
        offered = true;
        assert.equal(candidate.executable, 'pip');
        assert.equal(candidate.replacement, 'pip3');
        assert.equal(candidate.temporary, true);
        return true;
      },
    });
    assert.ok(offered);
    assert.equal(result.status, 'completed');
    assert.ok(events.some((e) => e.type === 'dependencies.remediation_approved'));
  }, {
    'pyproject.toml': '[project]\nname = "demo"\n',
  });
});

test('dependency hydration fails when remediation is rejected', async () => {
  await withWorkspace([
    'setup: pip --version',
  ], async (root, cacheRoot) => {
    const loaded = await loadEffectiveConfig({ cwd: root });
    const events = [];
    await assert.rejects(
      hydrateWorkspaceDependencies({
        workspacePath: root,
        projectRoot: root,
        config: { ...loaded.effectiveConfig, dependencies: { ...loaded.effectiveConfig.dependencies, cacheRoot } },
        runId: 'run_test',
        phase: 'test',
        onEvent: async (event) => events.push(event),
        onRemediation: async () => false,
      }),
      DependencyHydrationError,
    );
    assert.ok(events.some((e) => e.type === 'dependencies.remediation_rejected'));
  }, {
    'pyproject.toml': '[project]\nname = "demo"\n',
  });
});
