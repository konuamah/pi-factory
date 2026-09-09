import test from "node:test";
import assert from "node:assert/strict";
import { executeLandingPlan } from "../packages/core/dist/runtime/git-execution.js";

test("composed executor never runs an unsafe argv", async () => {
  const result = await executeLandingPlan({
    cwd: process.cwd(),
    plan: {
      actions: [{ kind: "git", step: { program: "git", args: ["merge", "--exec=echo-danger"], intent: "unsafe" } }],
      targetBranch: "main",
      rationale: "test",
      verification: [],
      risk: "high",
      expectedFiles: [],
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /external execution/i);
});
