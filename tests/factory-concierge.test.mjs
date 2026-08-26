import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeFactoryConciergeRecommendation,
} from "../packages/core/dist/index.js";

test("factory concierge normalizes allowed routed action", () => {
  const rec = normalizeFactoryConciergeRecommendation({
    answer: "Factory is already set up. I can check readiness next.",
    recommendedAction: "run-doctor",
    why: "Doctor verifies the current config without changing files.",
    needsApproval: false,
  });

  assert.equal(rec.recommendedAction, "run-doctor");
  assert.equal(rec.suggestedCommand, "/factory doctor");
  assert.equal(rec.needsApproval, false);
});

test("factory concierge rejects unknown action and arbitrary command", () => {
  assert.throws(
    () => normalizeFactoryConciergeRecommendation({
      answer: "I will do something.",
      recommendedAction: "delete-project",
      why: "bad",
    }),
    /INVALID_ACTION/,
  );

  assert.throws(
    () => normalizeFactoryConciergeRecommendation({
      answer: "Run setup.",
      recommendedAction: "run-setup",
      suggestedCommand: "rm -rf .",
      why: "bad",
    }),
    /INVALID_COMMAND/,
  );
});

test("factory docs library is complete and linked from Pi-facing concierge", async () => {
  const root = process.cwd();
  const docsDir = path.join(root, "docs/factory");
  const readmePath = path.join(docsDir, "README.md");
  const readme = await fs.readFile(readmePath, "utf8");

  const linkedDocs = [
    ...new Set(
      [...readme.matchAll(/\(([^)]+\.md)\)/g)]
        .map((match) => match[1])
        .filter((link) => !link.startsWith("http")),
    ),
  ];

  assert.ok(linkedDocs.length >= 10);

  for (const linkedDoc of linkedDocs) {
    await fs.access(path.join(docsDir, linkedDoc));
  }

  const piSkill = await fs.readFile(
    path.join(root, ".pi/skills/factory-concierge/SKILL.md"),
    "utf8",
  );
  assert.match(piSkill, /docs\/factory\/README\.md/);
  assert.match(piSkill, /Factory Install Modes/);
  assert.match(piSkill, /Visible Transcript Discipline/);
  assert.match(piSkill, /Do not look for docs under `?\.pi\/skills\/factory-concierge\/docs\/?`?/);
  assert.match(piSkill, /Do not narrate every internal step/);
  assert.match(piSkill, /do not inspect Factory source, schemas, `dist`, binaries, or CLI bootstrap files/i);
  assert.match(piSkill, /only for legacy project-local extension installs/);
  assert.doesNotMatch(piSkill, /Return JSON only/);

  const internalSkill = await fs.readFile(
    path.join(root, "skills/factory-concierge/SKILL.md"),
    "utf8",
  );
  assert.match(internalSkill, /Return JSON only/);
});

test("public Factory docs and Pi-facing concierge avoid project-specific local paths", async () => {
  const root = process.cwd();
  const checkedFiles = [
    "README.md",
    "docs/factory/README.md",
    "docs/factory/setup-operations.md",
    "docs/factory/troubleshooting.md",
    ".pi/skills/factory-concierge/SKILL.md",
  ];

  for (const file of checkedFiles) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /slammghana/i, `${file} should not point agents at slammghana`);
    assert.doesNotMatch(text, /\/Users\/slammtechnologies\/Documents\/GitHub\/slammghana/i, `${file} should use placeholders, not a concrete project path`);
  }
});
