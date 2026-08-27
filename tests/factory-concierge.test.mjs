import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildResourcePolicyForContext,
  checkToolCall,
  normalizeFactoryConciergeRecommendation,
  recommendViaFactoryConciergeSkill,
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

test("factory concierge normalizes expanded support actions", () => {
  const cases = [
    ["list-workflows", "/factory workflow list"],
    ["show-workflow", "/factory workflow show safe-flow"],
    ["set-default-workflow", "/factory workflow set-default safe-flow"],
    ["inspect-capabilities", "/factory capabilities list"],
    ["show-capability", "/factory capabilities show filesystem:read"],
    ["validate-capabilities", "/factory capabilities validate"],
    ["show-status", "/factory status run_123"],
    ["list-runs", "/factory list"],
    ["show-run", "/factory show run_123"],
    ["show-logs", "/factory logs run_123"],
    ["show-plan", "/factory plan"],
    ["dashboard-status", "/factory dashboard status"],
    ["start-dashboard", "/factory dashboard start"],
    ["cleanup-runs", "/factory cleanup 5"],
  ];

  for (const [recommendedAction, suggestedCommand] of cases) {
    const rec = normalizeFactoryConciergeRecommendation({
      answer: `Use ${suggestedCommand}.`,
      recommendedAction,
      why: "This is a Factory support action.",
      suggestedCommand,
    });

    assert.equal(rec.recommendedAction, recommendedAction);
    assert.equal(rec.suggestedCommand, suggestedCommand);
  }
});

test("factory concierge guides task execution without allowing task commands", () => {
  const rec = normalizeFactoryConciergeRecommendation({
    answer: "Factory is ready. Review the command and run it directly when you want the task to start.",
    recommendedAction: "guide-task-execution",
    why: "Concierge can prepare task execution but must not start it.",
    handoff: "/factory add login form --workflow=safe",
  });

  assert.equal(rec.recommendedAction, "guide-task-execution");
  assert.equal(rec.suggestedCommand, undefined);
  assert.match(rec.handoff, /\/factory add login form/);

  assert.throws(
    () => normalizeFactoryConciergeRecommendation({
      answer: "Run the task.",
      recommendedAction: "guide-task-execution",
      why: "bad",
      suggestedCommand: "/factory add login form",
    }),
    /INVALID_COMMAND/,
  );
});

test("factory concierge forces approval for state-changing support actions", () => {
  const rec = normalizeFactoryConciergeRecommendation({
    answer: "Start setup.",
    recommendedAction: "run-setup",
    why: "Setup writes Factory-owned files.",
    needsApproval: false,
  });

  assert.equal(rec.needsApproval, true);
});

test("factory concierge supports dependency configuration without a runnable task command", () => {
  const rec = normalizeFactoryConciergeRecommendation({
    answer: "Use shared dependency hydration with isolated worktrees.",
    recommendedAction: "configure-dependencies",
    why: "This changes Factory config, not application code.",
    needsApproval: false,
    handoff: "Edit .factory/config.yaml dependencies.enabled=true and dependencies.hydrate=auto.",
  });

  assert.equal(rec.recommendedAction, "configure-dependencies");
  assert.equal(rec.needsApproval, true);
  assert.equal(rec.suggestedCommand, undefined);
  assert.match(rec.handoff, /dependencies\.hydrate=auto/);
});

test("factory concierge rejects task command for dependency configuration", () => {
  assert.throws(
    () => normalizeFactoryConciergeRecommendation({
      answer: "Bad route.",
      recommendedAction: "configure-dependencies",
      why: "bad",
      suggestedCommand: "/factory add a navbar",
    }),
    /INVALID_COMMAND/,
  );
});

test("factory concierge prompt is docs-first and does not expose repo read tools", async () => {
  let capturedInput;
  const executor = {
    async execute(input) {
      capturedInput = input;
      return {
        executionId: input.executionId,
        status: "completed",
        outputText: JSON.stringify({
          answer: "Use the docs-first setup path.",
          recommendedAction: "show-status",
          why: "Status is read-only.",
          needsApproval: false,
        }),
        events: [],
      };
    },
    async cancel() {},
  };

  await recommendViaFactoryConciergeSkill({
    cwd: process.cwd(),
    question: "How should Factory avoid dist?",
    executor,
    context: {
      repository: {},
      existing: { constitutionExists: false },
      availableModels: [],
      availableSkills: [],
      availableCapabilities: [],
      discoveredCommands: {},
    },
  });

  assert.ok(capturedInput);
  assert.deepEqual(capturedInput.tools, []);
  assert.equal(capturedInput.metadata?.contextMode, "docs-first-dist-blind");
  assert.match(capturedInput.prompt, /docs\/factory\/AGENT\.md/);
  assert.match(capturedInput.prompt, /Factory Agent Reference Rules/);
  assert.match(capturedInput.prompt, /Never use `dist\/`/);
});

test("factory concierge setup intent routes model-readiness failures to setup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-concierge-setup-"));
  try {
    const executor = {
      async execute() {
        return {
          executionId: "x",
          status: "completed",
          outputText: JSON.stringify({
            answer: "Inspect model routing next.",
            recommendedAction: "inspect-models",
            why: "Models are failing readiness.",
            needsApproval: false,
          }),
          events: [],
        };
      },
      async cancel() {},
    };

    const rec = await recommendViaFactoryConciergeSkill({
      cwd: root,
      question: "setup factory",
      executor,
      context: {
        repository: {},
        existing: { constitutionExists: false },
        availableModels: [{ provider: "openai-codex", model: "gpt-5.4-mini" }],
        availableSkills: [],
        availableCapabilities: [],
        discoveredCommands: {},
      },
    });

    assert.equal(rec.recommendedAction, "run-setup");
    assert.equal(rec.suggestedCommand, "/factory setup");
    assert.equal(rec.needsApproval, true);
    assert.match(rec.handoff, /role models/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("factory resource policy blocks generated-output reads", () => {
  const resourcePolicy = buildResourcePolicyForContext({
    executionId: "concierge-read-policy",
    cwd: process.cwd(),
    grantedCapabilities: ["repo.read"],
    deniedCapabilities: [],
    needsApproval: [],
    skills: [{
      id: "factory-concierge",
      version: "1.0.0",
      description: "Factory Concierge",
      permissions: {
        forbiddenReadScopes: ["dist", "node_modules", "build", ".next", "coverage", "generated", ".worktrees"],
      },
    }],
  });

  const docsDecision = checkToolCall({
    toolName: "read",
    args: { path: "docs/factory/AGENT.md" },
    context: {
      executionId: "concierge-read-policy",
      cwd: process.cwd(),
      grantedCapabilities: ["repo.read"],
      deniedCapabilities: [],
      needsApproval: [],
    },
  }, resourcePolicy);

  const distDecision = checkToolCall({
    toolName: "read",
    args: { path: "packages/core/dist/index.js" },
    context: {
      executionId: "concierge-read-policy",
      cwd: process.cwd(),
      grantedCapabilities: ["repo.read"],
      deniedCapabilities: [],
      needsApproval: [],
    },
  }, resourcePolicy);

  assert.deepEqual(docsDecision, { action: "allow" });
  assert.equal(distDecision.action, "deny");
  assert.equal(distDecision.rule, "path-policy");
});

test("factory docs library is complete and linked from Pi-facing concierge", async () => {
  const root = process.cwd();
  const docsDir = path.join(root, "docs/factory");
  const readmePath = path.join(docsDir, "README.md");
  const readme = await fs.readFile(readmePath, "utf8");
  const agentPath = path.join(docsDir, "AGENT.md");
  const agent = await fs.readFile(agentPath, "utf8");

  assert.match(readme, /\[AGENT\.md\]\(AGENT\.md\)/);
  assert.match(readme, /\[worktrees-and-dependencies\.md\]\(worktrees-and-dependencies\.md\)/);
  assert.match(agent, /Reference Order/);
  assert.match(agent, /Never use `dist\/`/);
  assert.match(agent, /Factory behavior, command, setup, workflow, capability, runtime, or agent UX change/);

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
  assert.match(piSkill, /docs\/factory\/AGENT\.md/);
  assert.match(piSkill, /Factory docs first/);
  assert.match(piSkill, /Factory Install Modes/);
  assert.match(piSkill, /Visible Transcript Discipline/);
  assert.match(piSkill, /Do not start a Factory implementation task yourself/);
  assert.match(piSkill, /worktrees\/dependencies: `docs\/factory\/worktrees-and-dependencies\.md`/);
  assert.match(piSkill, /Dependency hydration is part of setup/);
  assert.match(piSkill, /language-neutral/);
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
  assert.match(internalSkill, /Use Factory docs as the primary reference layer/);
  assert.match(internalSkill, /Never use `dist\/`/);
  assert.match(internalSkill, /setup and operations action layer/);
  assert.match(internalSkill, /set Factory up end to end/);
  assert.match(internalSkill, /dependency hydration and shared cache/i);
  assert.match(internalSkill, /Do not make the guidance Node-only/);
  assert.match(internalSkill, /Workflows are a first-class responsibility/);
  assert.match(internalSkill, /guide task execution/i);
  assert.match(internalSkill, /must not trigger task execution/i);
  assert.match(internalSkill, /Do not suggest `\/factory <goal>` as `suggestedCommand`/);

  const setupSkill = await fs.readFile(
    path.join(root, "skills/factory-setup/SKILL.md"),
    "utf8",
  );
  assert.match(setupSkill, /dependency hydration/);
  assert.match(setupSkill, /language-neutral/);
});

test("public Factory docs and Pi-facing concierge avoid project-specific local paths", async () => {
  const root = process.cwd();
  const checkedFiles = [
    "README.md",
    "docs/factory/AGENT.md",
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
