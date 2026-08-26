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
  const widgets = [];
  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify() {},
      setWidget(id, lines) { widgets.push({ id, widget: lines }); },
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  await handleFactoryCommand("", ctx);
  assert.equal(widgets[0]?.id, "factory-status");
  assert.equal(widgets[0]?.widget, undefined);
  const widget = widgets.at(-1)?.widget ?? [];
  assert.ok(widget.join("\n").includes("Factory"));
});
