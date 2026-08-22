import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { runConstitutionScan } from '../packages/core/dist/index.js';

const execFile = promisify(execFileCb);

async function withTempProject(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-constitution-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const filePath = path.join(root, relative);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function initGitRepo(root) {
  await execFile('git', ['init'], { cwd: root });
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await execFile('git', ['add', '.'], { cwd: root });
  await execFile('git', ['commit', '-m', 'init'], { cwd: root });
}

function getArea(result, id) {
  const area = result.areas.find((item) => item.id === id);
  assert.ok(area, `Missing area ${id}`);
  return area;
}

test('constitution scan emits 120 areas for a minimal repo', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module', scripts: { build: 'tsc -b' } }, null, 2),
      'src/index.ts': 'export const hello = "world";\n',
      'README.md': '# temp\n',
    },
    async (root) => {
      const result = await runConstitutionScan({ cwd: root });
      assert.equal(result.mode, 'single-pipeline');
      assert.equal(result.finalized, false);
      assert.equal(result.interpreter.status, 'unavailable');
      assert.equal(result.areas.length, 120);
      assert.equal(getArea(result, 1).status, 'DEFINED');
    },
  );
});

test('no-change finalized constitution is reused without requiring an executor', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module', scripts: { build: 'tsc -b' } }, null, 2),
      'src/index.ts': 'export const hello = "world";\n',
      'README.md': '# temp\n',
    },
    async (root) => {
      const executor = {
        async execute() {
          return {
            executionId: 'test',
            status: 'completed',
            outputText: 'AI_AREA_PROPOSALS_START\n[]\nAI_AREA_PROPOSALS_END\n',
            events: [],
          };
        },
        async cancel() {},
      };

      const first = await runConstitutionScan({ cwd: root, constitutionExecutor: executor });
      assert.equal(first.finalized, true);
      assert.equal(first.interpreter.status, 'completed');

      const second = await runConstitutionScan({ cwd: root });
      assert.equal(second.finalized, true);
      assert.equal(second.interpreter.status, 'completed');
      assert.equal(second.refresh.noChange, true);
      assert.equal(second.refresh.reusedAreaIds.length, 120);
    },
  );
});

test('small non-structural changes use targeted interpretation', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module', scripts: { test: 'node --test tests/**/*.test.mjs' } }, null, 2),
      'README.md': '# temp\n',
      'tests/example.test.mjs': 'test("x", () => {});\n',
    },
    async (root) => {
      await initGitRepo(root);
      const prompts = [];
      const executor = {
        async execute(input) {
          prompts.push(input.prompt);
          return {
            executionId: 'test',
            status: 'completed',
            outputText: 'AI_AREA_PROPOSALS_START\n[]\nAI_AREA_PROPOSALS_END\n',
            events: [],
          };
        },
        async cancel() {},
      };

      await runConstitutionScan({ cwd: root, constitutionExecutor: executor });
      prompts.length = 0;
      await fs.writeFile(path.join(root, 'tests/example.test.mjs'), 'test("y", () => {});\n', 'utf8');

      const result = await runConstitutionScan({ cwd: root, constitutionExecutor: executor });
      assert.equal(result.refreshStrategy, 'targeted-interpretation');
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Refresh strategy: targeted-interpretation/);
      assert.match(prompts[0], /Impacted areas: 4, 73/);
    },
  );
});

test('structural changes use full interpretation', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module', scripts: { build: 'tsc -b' } }, null, 2),
      'README.md': '# temp\n',
      'src/index.ts': 'export const x = 1;\n',
    },
    async (root) => {
      await initGitRepo(root);
      const prompts = [];
      const executor = {
        async execute(input) {
          prompts.push(input.prompt);
          return {
            executionId: 'test',
            status: 'completed',
            outputText: 'AI_AREA_PROPOSALS_START\n[]\nAI_AREA_PROPOSALS_END\n',
            events: [],
          };
        },
        async cancel() {},
      };

      await runConstitutionScan({ cwd: root, constitutionExecutor: executor });
      prompts.length = 0;
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'tmp', type: 'module', scripts: { build: 'tsc -b', test: 'node --test' } }, null, 2), 'utf8');

      const result = await runConstitutionScan({ cwd: root, constitutionExecutor: executor });
      assert.equal(result.refreshStrategy, 'full-interpretation');
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /Refresh strategy: full-interpretation/);
      assert.match(prompts[0], /Changed files: .*package\.json/);
    },
  );
});

test('architecture evaluator detects package/module boundaries', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module', workspaces: ['packages/*'] }, null, 2),
      'tsconfig.json': JSON.stringify({ references: [{ path: './packages/core' }, { path: './packages/adapter' }] }, null, 2),
      'packages/core/src/index.ts': 'export interface CoreThing {}\n',
      'packages/adapter/src/index.ts': 'import type { CoreThing } from "@factory/core";\nexport const useCore = (x) => x;\n',
    },
    async (root) => {
      const result = await runConstitutionScan({ cwd: root });
      assert.equal(getArea(result, 33).status, 'DEFINED');
      assert.match(getArea(result, 34).finding, /dependency direction|core logic/i);
      assert.equal(getArea(result, 39).status, 'INFERRED');
    },
  );
});

test('api evaluator detects route, validation, and error contract evidence', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module' }, null, 2),
      'src/api/users.ts': [
        'import { z } from "zod";',
        'const schema = z.object({ id: z.string() });',
        'export function getUser(req, res) {',
        '  schema.parse(req.body);',
        '  return res.status(400).json({ error: "bad_request" });',
        '}',
      ].join('\n'),
    },
    async (root) => {
      const result = await runConstitutionScan({ cwd: root });
      assert.equal(getArea(result, 40).status, 'DEFINED');
      assert.equal(getArea(result, 43).status, 'INFERRED');
      assert.equal(getArea(result, 45).status, 'INFERRED');
    },
  );
});

test('contradiction detection flags env usage without clear secrets controls', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module' }, null, 2),
      '.env.example': 'API_KEY=example\n',
      'src/index.ts': 'export const value = process.env.API_KEY;\n',
    },
    async (root) => {
      const result = await runConstitutionScan({ cwd: root });
      const envArea = getArea(result, 15);
      const secretsArea = getArea(result, 17);
      const secretControlsArea = getArea(result, 68);
      assert.equal(envArea.status, 'INFERRED');
      assert.ok(
        (secretsArea.claims ?? []).some((claim) => claim.kind === 'conflict') ||
          (secretControlsArea.claims ?? []).some((claim) => claim.kind === 'conflict'),
      );
    },
  );
});

test('testing evaluator detects naming conventions and test doubles', async () => {
  await withTempProject(
    {
      'package.json': JSON.stringify({ name: 'tmp', type: 'module' }, null, 2),
      'src/sum.ts': 'export const sum = (a, b) => a + b;\n',
      'tests/sum.test.ts': [
        'const fakeRepo = { get: () => 1 };',
        'describe("sum", () => {',
        '  it("works", () => {',
        '    const fixture = { a: 1, b: 2 };',
        '  });',
        '});',
      ].join('\n'),
    },
    async (root) => {
      const result = await runConstitutionScan({ cwd: root });
      assert.equal(getArea(result, 77).status, 'DEFINED');
      assert.equal(getArea(result, 78).status, 'INFERRED');
      assert.equal(getArea(result, 79).status, 'INFERRED');
    },
  );
});
