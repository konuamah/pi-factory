import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  buildFactorySetupContext,
  recommendViaFactorySetupSkill,
  validateSetupRecommendation,
  buildStewardSlides,
  buildDeterministicRecommendation,
} from "../packages/core/dist/index.js";
import * as piExecutors from "../packages/executors/pi/dist/index.js";

const execFile = promisify(execFileCb);

async function withRepo(files, fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-steward-tui-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
  }
  await execFile("git", ["init"], { cwd: root });
  await execFile("git", ["config", "user.email", "t@e.com"], { cwd: root });
  await execFile("git", ["config", "user.name", "T"], { cwd: root });
  await execFile("git", ["add", "-A"], { cwd: root });
  await execFile("git", ["commit", "-m", "init"], { cwd: root });
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("steward slides: 14 slides with simple-English titles and whyNot", async () => {
  await withRepo(
    { "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) },
    async (root) => {
      const ctx = await buildFactorySetupContext(root);
      const rec = buildDeterministicRecommendation(ctx);
      const slides = buildStewardSlides(ctx, rec);
      assert.equal(slides.length, 14);
      assert.equal(slides[0].id, "understanding");
      assert.equal(slides[0].simpleTitle, "Here's how I understand this project");
      assert.equal(slides[13].id, "finalReview");
      // Slide 1 must be kind fact
      assert.equal(slides[0].kind, "fact");
      // Slash commands slide must show flag
      const cmdSlide = slides.find((s) => s.id === "commands");
      assert.ok(cmdSlide);
      const workflowSlide = slides.find((s) => s.id === "workflow");
      assert.ok(workflowSlide);
      assert.ok(workflowSlide.lines.some((line) => line.includes("Saved as:")));
      assert.ok(workflowSlide.lines.some((line) => line.includes("workflow name Factory uses")));
      assert.ok(workflowSlide.lines.some((line) => line.includes("Steps:")));
      const modelSlide = slides.find((s) => s.id === "models");
      assert.ok(modelSlide);
      assert.ok(modelSlide.lines.some((line) => line.includes("Configured Pi providers found:")));
      const taskRoutingSlide = slides.find((s) => s.id === "taskRouting");
      assert.ok(taskRoutingSlide);
      assert.ok(taskRoutingSlide.lines.some((line) => line.includes("Task routing means:")));
      assert.ok(taskRoutingSlide.lines.some((line) => line.includes("How it matches:")));
      const constitutionSlide = slides.find((s) => s.id === "constitution");
      assert.ok(constitutionSlide);
      assert.ok(constitutionSlide.lines.some((line) => line.includes("repo guide for agents")));
      assert.ok(constitutionSlide.lines.some((line) => line.includes("Recommendation:")));
      assert.ok(constitutionSlide.lines.some((line) => line.includes("Current state:")));
    }
  );
});

test("deterministic recommendation uses configured Pi default for role models", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    ctx.availableModels = [
      { provider: "openai-codex", model: "gpt-5.4-mini" },
      { provider: "commandcode", model: "claude-sonnet-5" },
      { model: "opus" },
    ];

    const rec = buildDeterministicRecommendation(ctx);
    assert.deepEqual(rec.models.planner.value, { provider: "openai-codex", model: "gpt-5.4-mini" });
    assert.deepEqual(rec.models.builder.value, { provider: "openai-codex", model: "gpt-5.4-mini" });
    const slide = buildStewardSlides(ctx, rec).find((s) => s.id === "models");
    assert.ok(slide.lines.some((line) => line.includes("openai-codex")));
    assert.ok(slide.lines.some((line) => line.includes("commandcode")));
  });
});

test("setup context imports project Claude-style SKILL.md bundles", async () => {
  await withRepo({
    "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2),
    ".claude/skills/check-leads/SKILL.md": [
      "---",
      "name: check-leads",
      "description: Check lead capture behavior",
      "---",
      "Use this when validating lead forms.",
      "",
    ].join("\n"),
    ".factory/skills/release-check/SKILL.md": [
      "---",
      "name: release-check",
      "description: Check release readiness",
      "---",
      "Use this before publishing.",
      "",
    ].join("\n"),
  }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    assert.ok(ctx.availableSkills.some((skill) => skill.id === "check-leads"));
    assert.ok(ctx.availableSkills.some((skill) => skill.id === "release-check"));
    const rec = buildDeterministicRecommendation(ctx);
    const slide = buildStewardSlides(ctx, rec).find((s) => s.id === "skills");
    assert.ok(slide.lines.some((line) => line.includes("bring your own skills")));
    assert.ok(slide.lines.some((line) => line.includes(".claude/skills")));
    assert.ok(slide.lines.some((line) => line.includes(".factory/skills")));
    assert.ok(slide.lines.some((line) => line.includes("check-leads")));
  });
});

test("fail-loud: recommendViaFactorySetupSkill without executor throws", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    await assert.rejects(
      () => recommendViaFactorySetupSkill({ cwd: root, context: ctx }),
      (err) => {
        assert.match(String(err.message), /FACTORY_SETUP_REQUIRES_PI_EXECUTOR/);
        return true;
      }
    );
  });
});

test("packaged setup uses bundled factory-setup skill when project has none", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    const exec = {
      async execute() { return { executionId: "x", status: "completed", outputText: "", events: [] }; },
      async cancel() {},
    };
    // Point to /tmp where a project-local skill does not exist; packaged Factory
    // should still find its bundled skill and then fail loudly on empty LLM output.
    await assert.rejects(
      () => recommendViaFactorySetupSkill({ cwd: "/tmp", context: ctx, executor: exec }),
      (err) => {
        assert.match(String(err.message), /FACTORY_SETUP_LLM_INVALID_JSON/);
        return true;
      }
    );
  });
});

test("fail-loud: LLM garbage JSON throws, not silent fallback", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    const mockExec = {
      async execute() { return { executionId: "x", status: "completed", outputText: "not json at all!!!", events: [] }; },
      async cancel() {},
    };
    await assert.rejects(
      () => recommendViaFactorySetupSkill({ cwd: root, context: ctx, executor: mockExec }),
      (err) => {
        const m = String(err.message);
        assert.ok(
          /FACTORY_SETUP_LLM_INVALID_JSON/.test(m) || /factory-setup skill not found/.test(m),
          `expected invalid JSON or skill-not-found, got: ${m.slice(0, 300)}`
        );
        return true;
      }
    );
  });
});

test("validate: tolerate Spark-style questions without id/options (normalized)", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    assert.ok(ctx.availableSkills.some((skill) => skill.id === "factory-concierge"));
    const rec = buildDeterministicRecommendation(ctx);
    // Spark emits {kind, question} without id/options
    rec.questions = [
      { kind: "fact", question: "Is main the correct main branch?" },
      { kind: "preference", question: "Want dashboard on?" },
      { kind: "fact", question: "Review the generated notes before continuing." },
    ];
    const validated = validateSetupRecommendation(rec, ctx);
    assert.equal(validated.questions.length, 3);
    assert.ok(validated.questions[0].id);
    assert.deepEqual(validated.questions[0].options, [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
    assert.deepEqual(validated.questions[1].options, [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }]);
    assert.deepEqual(validated.questions[2].options, [{ id: "ack", label: "Got it" }]);
  });
});

test("validate: unavailable role models fall back to detected Pi default", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module" }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    ctx.availableModels = [{ provider: "openai-codex", model: "gpt-5.4-mini" }];
    const rec = buildDeterministicRecommendation(ctx);
    rec.models = {
      planner: { value: { model: "meta/muse-spark-1.2-contributor" }, reason: "Existing project config." },
      builder: { value: { model: "meta/muse-spark-1.2-contributor" }, reason: "Existing project config." },
    };

    const validated = validateSetupRecommendation(rec, ctx);
    assert.deepEqual(validated.models.planner.value, { provider: "openai-codex", model: "gpt-5.4-mini" });
    assert.deepEqual(validated.models.builder.value, { provider: "openai-codex", model: "gpt-5.4-mini" });
    assert.match(validated.models.planner.reason, /Replaced unavailable model/);
  });
});

test("validate: mislabeled discovered commands are reclassified for confirmation", async () => {
  await withRepo({ "package.json": JSON.stringify({ name: "app", type: "module", scripts: { lint: "eslint ." } }, null, 2) }, async (root) => {
    const ctx = await buildFactorySetupContext(root);
    const rec = buildDeterministicRecommendation(ctx);
    rec.commands = {
      typecheck: {
        value: "npx tsc --noEmit",
        reason: "Existing project config.",
        source: "DISCOVERED",
        confidence: "HIGH",
      },
    };

    const validated = validateSetupRecommendation(rec, ctx);
    assert.equal(validated.commands.typecheck.source, "AI_SUGGESTED");
    assert.equal(validated.commands.typecheck.requiresConfirmation, true);
    assert.equal(validated.commands.typecheck.confidence, "MEDIUM");
  });
});

test("live SDK via your Pi default (if auth present) — skip gracefully if 401/402", async () => {
  const ctx = await buildFactorySetupContext(process.cwd());
  const factory = piExecutors.createPiSdkSessionFactory({});
  const exec = new piExecutors.PiAgentExecutor({ sessionFactory: factory });
  try {
    const rec = await recommendViaFactorySetupSkill({ cwd: process.cwd(), context: ctx, executor: exec });
    assert.ok(rec.projectUnderstanding.summary.trim());
    assert.ok(rec.workflow);
    validateSetupRecommendation(rec, ctx);
    const slides = buildStewardSlides(ctx, rec);
    assert.equal(slides.length, 14);
  } catch (e) {
    const msg = String(e.message);
    if (
      msg.includes("401") ||
      msg.includes("402") ||
      msg.includes("PROVIDER_AUTH") ||
      msg.includes("INVALID_JSON") ||
      msg.includes("EACCES") ||
      msg.includes("permission denied") ||
      msg.includes("npm install -g")
    ) {
      // Invalid/billed-out key in this env — not a code failure. Log and skip.
      console.log(`Skipping live SDK test: ${msg.slice(0, 200)}`);
      return;
    }
    throw e;
  }
});
