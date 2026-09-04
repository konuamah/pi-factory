import test from "node:test";
import assert from "node:assert/strict";
import { mountFactoryStreamingWidget } from "../packages/adapters/pi/dist/streaming-panel.js";
import { formatToolActivityLine } from "../packages/executors/pi/dist/index.js";

test("Factory streaming panel clamps raw stream lines below Pi render width", () => {
  let component;
  const panel = mountFactoryStreamingWidget(
    {
      setWidget(_id, factory) {
        component = factory({ requestRender() {} });
      },
    },
    "factory-status",
    {
      title: "Factory run",
      goal: "remove old upcoming courses",
      phase: "repair",
      role: "repair",
      status: "streaming",
      lines: [],
      footer: "Live Factory stream. Use arrow keys to scroll.",
    },
  );

  panel.appendStream(
    '<｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">cd /Users/slammtechnologies/Documents/GitHub/slammghana/.worktrees/factory-remove-old-upcoming-courses && git status && echo "---BRANCH---"',
  );

  const width = 189;
  const lines = component.render(width);
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => visibleWidth(line) <= width - 6));
});

test("Factory streaming panel can render concise tool activity lines", () => {
  let component;
  const panel = mountFactoryStreamingWidget(
    {
      setWidget(_id, factory) {
        component = factory({ requestRender() {} });
      },
    },
    "factory-status",
    {
      title: "Factory run",
      phase: "implementation",
      role: "builder",
      status: "streaming",
      lines: [],
    },
  );

  const line = formatToolActivityLine({
    type: "tool.started",
    data: { toolName: "write", preview: "src/data/books.ts" },
  });
  panel.append(line);

  assert.ok(component.render(90).some((rendered) => rendered.includes("write: src/data/books.ts")));
});

function visibleWidth(value) {
  let width = 0;
  for (const char of value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += codePoint >= 0x1100 ? 2 : codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0) ? 0 : 1;
  }
  return width;
}
