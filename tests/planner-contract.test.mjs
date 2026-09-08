import test from "node:test";
import assert from "node:assert/strict";
import { extractImplementationContract } from "../packages/core/dist/runtime/planner.js";

test("extractImplementationContract: prose 'out of scope now' is not a non-goals section", () => {
  const planText = [
    "Feature Plan",
    "- Update the target document",
    "The marker is out of scope now; flag to reviewer only.",
    "- **Risk: marker hits wrong elements.** Mitigation: reuse the existing selector.",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  // The prose phrase must NOT populate nonGoals; risks belong in risks.
  assert.equal(contract?.nonGoals, undefined, "prose 'out of scope' must not become nonGoals");
  assert.ok((contract?.risks ?? []).length >= 1, "risk bullets still extracted as risks");
});

test("extractImplementationContract: real non-goals heading IS extracted", () => {
  const planText = [
    "Feature Plan",
    "Non-goals:",
    "- contact-form.html",
    "- .factory/",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.deepEqual(contract?.nonGoals, ["contact-form.html", ".factory/"]);
});

test("extractImplementationContract: numbered non-goals heading is extracted", () => {
  const planText = [
    "Feature Plan",
    "3. Non-goals",
    "- contact-form.html",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.deepEqual(contract?.nonGoals, ["contact-form.html"]);
});

test("extractImplementationContract: structured TARGET FILES + NON-GOALS sections", () => {
  const planText = [
    "1. PLANNING DECISIONS",
    "- Modify index.html nav.",
    "2. TARGET FILES",
    "- index.html",
    "- script.js",
    "3. NON-GOALS",
    "- tests/verify-page.mjs",
    "- .factory/",
    "- None of the CSS: no style blocks",
    "4. IMPLEMENTATION SEQUENCE",
    "- Step 1: edit nav.",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.deepEqual(contract?.targetFiles, ["index.html", "script.js"]);
  // File-path non-goals survive (scope check uses paths); prose may too.
  assert.ok(contract?.nonGoals?.includes("tests/verify-page.mjs"), `expected tests/verify-page.mjs, got ${contract?.nonGoals}`);
  assert.ok(contract?.nonGoals?.includes(".factory/"), `expected .factory/, got ${contract?.nonGoals}`);
});

test("extractImplementationContract: prose 'target files' mention is not the section", () => {
  const planText = [
    "the target files are index.html and script.js",
    "2. TARGET FILES",
    "- index.html",
    "- script.js",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.deepEqual(contract?.targetFiles, ["index.html", "script.js"]);
});

test("extractImplementationContract: old-style prose (no sections) captures root files", () => {
  const planText = [
    "1. PLANNING DECISIONS",
    "- Modify `index.html` (nav) and `script.js` (toggle).",
    "2. IMPLEMENTATION SEQUENCE",
    "- Step 1: edit `index.html` nav.",
    "- Step 2: edit `script.js`.",
    "4. RISKS AND BLOCKERS",
    "- **Risk: marker drift.**",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.ok(contract?.targetFiles?.includes("index.html"), `expected index.html, got ${contract?.targetFiles}`);
  assert.ok(contract?.targetFiles?.includes("script.js"), `expected script.js, got ${contract?.targetFiles}`);
});

test("extractImplementationContract: CHANGE REQUIREMENT section captures status and gaps", () => {
  const planText = [
    "2. TARGET FILES",
    "- backend/index.js",
    "3. CHANGE REQUIREMENT",
    "Status: required",
    "Baseline gap: POST /api/tasks accepts a client-supplied id and overwrites the server id.",
    "Baseline gap: empty titles return 200 instead of 400.",
    "Required change: Ignore any client-supplied id in POST /api/tasks.",
    "Required change: Reject empty or whitespace-only titles with 400.",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.equal(contract?.changeRequired, "required");
  assert.ok(contract?.baselineFindings?.length === 2, `expected 2 baseline gaps, got ${contract?.baselineFindings}`);
  assert.ok(contract?.requiredChanges?.length === 2, `expected 2 required changes, got ${contract?.requiredChanges}`);
  assert.match(contract?.requiredChanges?.[0] ?? "", /client-supplied id/);
});

test("extractImplementationContract: Status not-required produces no required changes", () => {
  const planText = [
    "7. CHANGE REQUIREMENT",
    "Status: not-required",
    "Baseline gap: task creation is already implemented end to end.",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.equal(contract?.changeRequired, "not-required");
  assert.ok(contract?.baselineFindings?.length === 1);
  assert.equal(contract?.requiredChanges, undefined);
});

test("extractImplementationContract: no CHANGE REQUIREMENT section leaves the new fields undefined", () => {
  const planText = [
    "2. TARGET FILES",
    "- index.html",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.equal(contract?.changeRequired, undefined);
  assert.equal(contract?.baselineFindings, undefined);
  assert.equal(contract?.requiredChanges, undefined);
});

test("extractImplementationContract: verification command extraction strips leading list decoration", () => {
  const planText = [
    "5. VERIFICATION CONTRACT",
    "- — - Run `cd backend && npm start`.",
    "WAITING_FOR_APPROVAL",
  ].join("\n");
  const contract = extractImplementationContract(planText);
  assert.ok(contract?.verificationChecks?.length === 1, `expected 1 check, got ${contract?.verificationChecks}`);
  assert.equal(contract?.verificationChecks?.[0]?.command, "cd backend && npm start");
});
