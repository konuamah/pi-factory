import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nonGoalViolations, loadPlanContract } from "../packages/core/dist/runtime/scope-check.js";

test("nonGoalViolations: exact match", () => {
  const violations = nonGoalViolations(["contact-form.html", "index.html"], ["contact-form.html"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "contact-form.html");
  assert.equal(violations[0].match, "exact");
});

test("nonGoalViolations: directory prefix match", () => {
  const violations = nonGoalViolations(["src/app/foo.ts"], ["src"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].nonGoal, "src");
  assert.equal(violations[0].match, "prefix");
});

test("nonGoalViolations: no violation when files untouched", () => {
  assert.deepEqual(nonGoalViolations(["index.html", "script.js"], ["contact-form.html"]), []);
});

test("nonGoalViolations: normalizes windows separators and ./ prefix", () => {
  const violations = nonGoalViolations([".\\src\\foo.ts"], ["src"]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "src/foo.ts");
});

test("nonGoalViolations: empty inputs return []", () => {
  assert.deepEqual(nonGoalViolations([], ["a"]), []);
  assert.deepEqual(nonGoalViolations(["a"], []), []);
  assert.deepEqual(nonGoalViolations([], []), []);
});

test("nonGoalViolations: dedupes repeated violations", () => {
  const violations = nonGoalViolations(["a.ts", "a.ts", "b.ts"], ["a.ts"]);
  assert.equal(violations.length, 1);
});

test("loadPlanContract: reads implementationContract from plan.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-plan-"));
  const planPath = path.join(dir, "plan.json");
  await fs.writeFile(planPath, JSON.stringify({
    implementationContract: { nonGoals: ["contact-form.html"], targetFiles: ["index.html"] },
  }), "utf8");
  const contract = await loadPlanContract(planPath);
  assert.deepEqual(contract?.nonGoals, ["contact-form.html"]);
  assert.deepEqual(contract?.targetFiles, ["index.html"]);
});

test("loadPlanContract: missing file returns undefined", async () => {
  const contract = await loadPlanContract("/nonexistent/plan.json");
  assert.equal(contract, undefined);
});

test("loadPlanContract: malformed json returns undefined", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "scope-plan-"));
  const planPath = path.join(dir, "plan.json");
  await fs.writeFile(planPath, "{not json", "utf8");
  const contract = await loadPlanContract(planPath);
  assert.equal(contract, undefined);
});
