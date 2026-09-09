import test from "node:test";
import assert from "node:assert/strict";
import { classifyEffects } from "../packages/core/dist/runtime/git-command-effects.js";
import { parseGitAction } from "../packages/core/dist/runtime/git-command-parser.js";

const effects = (args) => {
  const parsed = parseGitAction({ args });
  assert.equal(parsed.ok, true);
  return classifyEffects(parsed.command, { repoRoot: process.cwd() });
};

test("classifies destructive and remote effects", () => {
  assert.equal(effects(["reset", "--soft", "HEAD~1"]).mayDiscardChanges, false);
  assert.equal(effects(["reset", "--hard", "HEAD~1"]).mayDiscardChanges, true);
  assert.equal(effects(["push", "origin", "candidate"]).modifiesRemoteRefs, true);
  assert.equal(effects(["push", "--force-with-lease", "origin", "candidate"]).mayOverwriteRef, true);
  assert.equal(effects(["cherry-pick", "abc", "def"]).mayOverwriteRef, true);
});
