import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerFactoryPiExtension } from '../packages/adapters/pi/dist/index.js';

async function withTempRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-factory-gateway-'));
  try {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('factory constitution command renders immediate progress feedback', async () => {
  await withTempRepo(async (root) => {
    const widgets = [];
    let captured;
    registerFactoryPiExtension({
      registerCommand(name, command) {
        if (name === 'factory') {
          captured = command;
        }
      },
    });

    assert.ok(captured);
    const run = captured.handler('constitution', {
      cwd: root,
      ui: {
        notify() {},
        setWidget(_id, lines) {
          widgets.push(lines);
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = widgets[0];
    const second = widgets[1];
    const third = widgets[2];
    assert.equal(first, undefined);
    assert.ok(Array.isArray(second));
    assert.ok(second.includes('Factory'));
    assert.ok(second.some((line) => /refreshing the repository constitution/i.test(line)));
    assert.ok(Array.isArray(third));
    assert.ok(third.includes('Factory constitution'));
    assert.ok(third.includes('phase: constitution-refresh'));
    assert.ok(third.includes('message: Refreshing repository constitution'));

    await run.catch(() => {});
  });
});
