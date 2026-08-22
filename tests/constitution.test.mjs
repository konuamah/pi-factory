import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runConstitutionScan } from '../packages/core/dist/index.js';

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
      assert.equal(result.areas.length, 120);
      assert.equal(getArea(result, 1).status, 'DEFINED');
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
