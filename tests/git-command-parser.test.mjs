import test from "node:test";
import assert from "node:assert/strict";
import { parseGitAction } from "../packages/core/dist/runtime/git-command-parser.js";

test("parses a merge action", () => {
  assert.deepEqual(parseGitAction({ args: ["merge", "--no-ff", "candidate"] }), { ok: true, command: { command: "merge", args: ["--no-ff", "candidate"] } });
});

test("rejects execution flags, traversal, and empty argv", () => {
  assert.equal(parseGitAction({ args: ["merge", "--exec=sh"] }).ok, false);
  assert.equal(parseGitAction({ args: ["checkout", "../other"] }).reason, "Path argument escapes worktree");
  assert.equal(parseGitAction({ args: [] }).ok, false);
});
