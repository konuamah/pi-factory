import test from "node:test";
import assert from "node:assert/strict";
import { classifyBuilderOutcome } from "../packages/core/dist/runtime/builder-outcome.js";

const noCommit = {
  committed: false,
  changedFiles: [],
  allChangedFiles: [],
};

const committed = {
  committed: true,
  changedFiles: ["src/index.ts"],
  allChangedFiles: ["src/index.ts"],
  commitSha: "abc123",
};

function result(outputText, status = "completed", errorMessage) {
  return {
    executionId: "builder-1",
    status,
    outputText,
    events: [],
    errorMessage,
  };
}

test("classifies a committed completed Builder result as implemented", () => {
  assert.deepEqual(
    classifyBuilderOutcome(result("CONTRACT_NOOP but changed files exist"), committed),
    { kind: "implemented" },
  );
});

test("classifies an explicit no-op without changes", () => {
  assert.deepEqual(
    classifyBuilderOutcome(
      result("CONTRACT_NOOP The requested behavior is already implemented."),
      noCommit,
    ),
    {
      kind: "contract-noop",
      reason: "The requested behavior is already implemented.",
    },
  );
});

test("classifies an explicit contract block without changes", () => {
  assert.deepEqual(
    classifyBuilderOutcome(
      result("CONTRACT_BLOCKED backend/package.json is required by the contract but is missing."),
      noCommit,
    ),
    {
      kind: "contract-blocked",
      reason: "backend/package.json is required by the contract but is missing.",
    },
  );
});

test("classifies unexplained no-change completion as retryable", () => {
  assert.deepEqual(
    classifyBuilderOutcome(result("I inspected the files but made no edits."), noCommit),
    { kind: "no-change-unclear" },
  );
});

test("classifies executor failure and preserves its error", () => {
  assert.deepEqual(
    classifyBuilderOutcome(
      result("", "failed", "tool timeout"),
      noCommit,
    ),
    { kind: "executor-failed", reason: "tool timeout" },
  );
});

test("does not treat an embedded prose mention as a directive", () => {
  assert.deepEqual(
    classifyBuilderOutcome(result("The phrase CONTRACT_NOOP is not applicable."), noCommit),
    { kind: "no-change-unclear" },
  );
});