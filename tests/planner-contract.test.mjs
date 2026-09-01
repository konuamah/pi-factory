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
