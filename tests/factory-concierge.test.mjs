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

async function captureConciergePrompt(question) {
  let capturedInput;
  const executor = {
    async execute(input) {
      capturedInput = input;
      return {
        executionId: input.executionId,
        status: "completed",
        outputText: JSON.stringify({
          answer: "Use the skill-orchestrated setup path.",
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
    question,
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
  return capturedInput;
}

test("factory concierge prompt is skill-orchestrated and does not expose repo read tools", async () => {
  const capturedInput = await captureConciergePrompt("How should Factory avoid dist?");
  assert.ok(capturedInput);
  assert.deepEqual(capturedInput.tools, []);
  assert.equal(capturedInput.metadata?.contextMode, "skill-orchestrated");
  assert.match(capturedInput.prompt, /# Factory operational skill context/);
  assert.match(capturedInput.prompt, /factory-troubleshooting/);
  assert.match(capturedInput.prompt, /Never use `dist\/`/);
  assert.doesNotMatch(capturedInput.prompt, /## docs\/factory\/AGENT\.md/);
  assert.doesNotMatch(capturedInput.prompt, /## docs\/factory\/README\.md/);
});

test("factory concierge selects domain operational skills by question", async () => {
  const setup = await captureConciergePrompt("set everything up and make Factory ready");
  assert.match(setup.prompt, /### factory-setup-operations/);

  const workflow = await captureConciergePrompt("create a workflow with an interview stage");
  assert.match(workflow.prompt, /### factory-workflows/);

  const models = await captureConciergePrompt("why is my model routing failing?");
  assert.match(models.prompt, /### factory-model-routing/);

  const failure = await captureConciergePrompt("the latest run is blocked after a timeout");
  assert.match(failure.prompt, /### factory-troubleshooting/);
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

test("factory concierge runs setup through the setup interview path", async () => {
  const source = await fs.readFile(path.join(process.cwd(), "packages/adapters/pi/dist/gateway-concierge.js"), "utf8");
  assert.match(source, /handleSetup\(\["--from-concierge"\], ctx\)/);

  const docs = await fs.readFile(path.join(process.cwd(), "docs/factory/setup-operations.md"), "utf8");
  assert.match(docs, /grilling/);
  assert.match(docs, /workflow preset and role-model assignment preferences/);
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

test("factory operational skills are complete and Concierge names orchestration model", async () => {
  const root = process.cwd();
  const docsDir = path.join(root, "docs/factory");
  const readmePath = path.join(docsDir, "README.md");
  const readme = await fs.readFile(readmePath, "utf8");
  const agentPath = path.join(docsDir, "AGENT.md");
  const agent = await fs.readFile(agentPath, "utf8");
  const workflowAuthoring = await fs.readFile(path.join(docsDir, "workflow-authoring.md"), "utf8");
  const bundledGrilling = await fs.readFile(path.join(root, "skills/grilling/SKILL.md"), "utf8");
  const bundledGrillMe = await fs.readFile(path.join(root, "skills/grill-me/SKILL.md"), "utf8");
  const expectedOperationalSkills = [
    "factory-setup-operations",
    "factory-workflows",
    "factory-model-routing",
    "factory-skills-library",
    "factory-dashboard",
    "factory-constitution",
    "factory-permissions-safety",
    "factory-troubleshooting",
    "factory-worktrees-dependencies",
    "factory-quality-testing",
  ];

  assert.match(readme, /\[AGENT\.md\]\(AGENT\.md\)/);
  assert.match(readme, /\[worktrees-and-dependencies\.md\]\(worktrees-and-dependencies\.md\)/);
  assert.match(agent, /Reference Order/);
  assert.match(agent, /Never use `dist\/`/);
  assert.match(agent, /\.pi\/skills\/factory-\*/);
  assert.match(workflowAuthoring, /bundled interview skill/i);
  assert.match(workflowAuthoring, /There is no `interviewer` role/);
  assert.match(workflowAuthoring, /skills\/grilling/);
  assert.match(workflowAuthoring, /skills\.require: \[grilling\]/);
  assert.match(workflowAuthoring, /top-level `defaultWorkflowId`/);
  assert.match(workflowAuthoring, /top-level `workflows`/);
  assert.match(workflowAuthoring, /Do not create a top-level `stages:` list/);
  assert.match(bundledGrilling, /^name: grilling$/m);
  assert.match(bundledGrilling, /Interview the user relentlessly until you reach a shared understanding\./);
  assert.match(bundledGrillMe, /^name: grill-me$/m);
  assert.match(bundledGrillMe, /Call the Skill tool with "grilling"\./);

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

  for (const skillId of expectedOperationalSkills) {
    const skill = await fs.readFile(
      path.join(root, ".pi/skills", skillId, "SKILL.md"),
      "utf8",
    );
    assert.match(skill, /^---\nname: /);
    assert.match(skill, /^description: /m);
  }
  const workflowSkill = await fs.readFile(
    path.join(root, ".pi/skills/factory-workflows/SKILL.md"),
    "utf8",
  );
  assert.match(workflowSkill, /There is no `interviewer` role/);
  assert.match(workflowSkill, /require.*prefer.*exclude/s);

  const piSkill = await fs.readFile(
    path.join(root, ".pi/skills/factory-concierge/SKILL.md"),
    "utf8",
  );
  assert.match(piSkill, /Concierge is the orchestrator/);
  assert.match(piSkill, /focused Factory operational skill/);
  assert.match(piSkill, /Factory Install Modes/);
  assert.match(piSkill, /Visible Transcript Discipline/);
  assert.match(piSkill, /Do not start a Factory implementation task yourself/);
  assert.match(piSkill, /worktrees\/dependencies: `factory-worktrees-dependencies`/);
  assert.match(piSkill, /bundled `skills\/grilling` skill first/i);
  assert.match(piSkill, /bind `skills\.require: \[grilling\]` directly/i);
  assert.match(piSkill, /top-level `defaultWorkflowId` plus `workflows`/);
  assert.match(piSkill, /Do not create a top-level `stages:` list/);
  assert.match(piSkill, /`agent`, `interview`, `command`, `approval`, or `task-graph`/);
  assert.match(piSkill, /Do not narrate every internal step/);
  assert.match(piSkill, /do not inspect Factory source, schemas, `dist`, binaries, or CLI bootstrap files/i);
  assert.match(piSkill, /only for legacy project-local extension installs/);
  assert.doesNotMatch(piSkill, /Return JSON only/);

  const internalSkill = await fs.readFile(
    path.join(root, "skills/factory-concierge/SKILL.md"),
    "utf8",
  );
  assert.match(internalSkill, /Return JSON only/);
  assert.match(internalSkill, /Use focused Factory operational skills as the primary runtime reference layer/);
  assert.match(internalSkill, /Never use `dist\/`/);
  assert.match(internalSkill, /setup and operations action layer/);
  assert.match(internalSkill, /set Factory up end to end/);
  assert.match(internalSkill, /dependency hydration and shared cache/i);
  assert.match(internalSkill, /Do not make the guidance Node-only/);
  assert.match(internalSkill, /bundled `skills\/grilling` skill first/i);
  assert.match(internalSkill, /bind `skills\.require: \[grilling\]` directly/i);
  assert.match(internalSkill, /top-level `defaultWorkflowId` plus `workflows`/);
  assert.match(internalSkill, /Do not create a top-level `stages:` list/);
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
  assert.match(setupSkill, /Workflow Shape Guardrail/);
  assert.match(setupSkill, /Never recommend or describe a top-level `stages:` list/);
  assert.match(setupSkill, /skills\.require: \["grilling"\]/);
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
