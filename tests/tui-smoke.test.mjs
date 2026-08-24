import test from "node:test";
import assert from "node:assert/strict";
import { TuiTest } from "@microsoft/tui-test";

test("tui-test can open a shell and capture Factory CLI text", async () => {
  const t = TuiTest.ephemeral("pi-factory-tui-smoke-");
  await t.open();
  await t.submit("echo hello-tui-test");
  await t.waitCommand();
  await t.expectText("hello-tui-test", { strict: false });
  const txt = await t.text();
  assert.match(txt, /hello-tui-test/);
  await t.close();
});

test("factory gateway renders without crashing (pi adapter loads)", async () => {
  const { handleFactoryCommand } = await import("../packages/adapters/pi/dist/gateway.js");
  let widget = [];
  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify() {},
      setWidget(_id, lines) { widget = lines ?? []; },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  await handleFactoryCommand("", ctx);
  assert.ok(widget.join("\n").includes("Factory"));
});
