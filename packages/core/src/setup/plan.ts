import fs from "node:fs/promises";
import path from "node:path";
import { inspectRepositoryForSetup } from "./profile.js";
import { recommendFromProfile } from "./recommend.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { detectPiModelConfiguration } from "./pi-models.js";
import { defaultConstitutionTemplate, defaultWorkflowTemplate } from "./init.js";
import type {
  FactorySetupPlan,
  ProposedFactorySetup,
  SetupDecision,
  SetupDiff,
  SetupMode,
  SetupRecommendation,
} from "./types.js";

export interface PlanFactorySetupInput {
  cwd: string;
  answers?: Record<string, string>;
  force?: boolean;
}

export async function planFactorySetup(input: PlanFactorySetupInput): Promise<FactorySetupPlan> {
  const profile = await inspectRepositoryForSetup(input.cwd);
  const recommendations = recommendFromProfile(profile);

  const existingFiles = profile.factory.files;
  const mode: SetupMode = !profile.gitRoot || profile.maturity === "EMPTY"
    ? "BOOTSTRAP"
    : !existingFiles.workflow && !existingFiles.projectConfig
      ? "ADOPT"
      : "RECONCILE";

  const decisions = collectDecisions(profile, recommendations, mode);

  const proposed = await buildProposedSetup(input.cwd, profile, recommendations, input.answers);
  const diffs = await buildDiffs(input.cwd, proposed);

  return {
    mode,
    profile,
    recommendations,
    decisions,
    proposed,
    diffs,
  };
}

function collectDecisions(
  profile: Awaited<ReturnType<typeof inspectRepositoryForSetup>>,
  recommendations: SetupRecommendation[],
  mode: SetupMode,
): SetupDecision[] {
  const decisions: SetupDecision[] = [];
  const needsDecision = recommendations.filter((r) => r.requiresDecision);

  for (const recommendation of needsDecision) {
    if (recommendation.id === "workflow:preset") {
      decisions.push({
        id: "workflow-preset",
        question: "Which workflow preset should Factory use?",
        options: [
          { id: "fast", label: "Fast — plan → build → approval → merge" },
          { id: "balanced", label: "Balanced — plan → build → verify → approval → merge" },
          { id: "safe", label: "Safe — verification-first with extra checks" },
        ],
        context: `Recommended: ${String(recommendation.proposedValue)} (${recommendation.reason})`,
      });
    }
    if (recommendation.id === "constitution:refresh") {
      decisions.push({
        id: "constitution",
        question: "Generate a repository-specific CONSTITUTION.md?",
        options: [
          { id: "generate", label: "Generate now (requires Pi auth/model)" },
          { id: "stub", label: "Write a minimal stub for now" },
        ],
        context: recommendation.reason,
      });
    }
  }

  // In ADOPT mode, always confirm before adopting.
  if (mode === "ADOPT") {
    decisions.push({
      id: "adopt",
      question: "Adopt Factory for this repository?",
      options: [
        { id: "yes", label: "Yes, set up Factory" },
        { id: "no", label: "No, cancel" },
      ],
    });
  }

  return decisions;
}

async function buildProposedSetup(
  cwd: string,
  profile: Awaited<ReturnType<typeof inspectRepositoryForSetup>>,
  recommendations: SetupRecommendation[],
  answers?: Record<string, string>,
): Promise<ProposedFactorySetup> {
  const root = profile.gitRoot ?? cwd;
  const files: ProposedFactorySetup["files"] = [];

  const findValue = (id: string): unknown => recommendations.find((r) => r.id === id)?.proposedValue;

  // factory.yaml
  const workflowPreset = (answers?.["workflow-preset"] as string) ?? String(findValue("workflow:preset") ?? "balanced");
  const workflowContent = defaultWorkflowTemplate(workflowPreset as "balanced" | "fast" | "safe");
  const workflowPath = path.join(root, "factory.yaml");
  files.push({
    path: workflowPath,
    content: workflowContent,
    action: profile.factory.files.workflow ? "update" : "create",
  });

  // .factory/config.yaml
  const pi = await detectPiModelConfiguration(root).catch(() => undefined);
  const testCommand = (findValue("verification:test") as string) ?? "pnpm test";
  const lintCommand = (findValue("verification:lint") as string) ?? "pnpm lint";
  const typecheckCommand = (findValue("verification:typecheck") as string) ?? "pnpm typecheck";
  const buildCommand = (findValue("verification:build") as string) ?? "pnpm build";
  const configContent = buildProjectConfig({
    testCommand,
    lintCommand,
    typecheckCommand,
    buildCommand,
    pi,
  });
  const configPath = path.join(root, ".factory", "config.yaml");
  files.push({
    path: configPath,
    content: configContent,
    action: profile.factory.files.projectConfig ? "update" : "create",
  });

  // CONSTITUTION.md — stub unless generation is chosen.
  const constitutionDecision = answers?.["constitution"] ?? "stub";
  if (!profile.factory.files.constitution || constitutionDecision === "generate" || inputForce(answers)) {
    const constitutionPath = path.join(root, "CONSTITUTION.md");
    files.push({
      path: constitutionPath,
      content: defaultConstitutionTemplate(),
      action: profile.factory.files.constitution ? "update" : "create",
    });
  }

  return { files };
}

function buildProjectConfig(input: {
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  buildCommand: string;
  pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>;
}): string {
  const modelBlock = renderModelBlock(input.pi);
  return [
    "project:",
    "  baseBranch: main",
    "",
    "commands:",
    `  setup: pnpm install`,
    `  lint: ${input.lintCommand}`,
    `  typecheck: ${input.typecheckCommand}`,
    `  test: ${input.testCommand}`,
    `  build: ${input.buildCommand}`,
    modelBlock,
    "runtime:",
    "  maxParallelAgents: 4",
    "",
    "repair:",
    "  enabled: true",
    "  maxAttempts: 3",
    "",
    "approval:",
    "  finalMerge: required",
    "",
  ].join("\n");
}

function renderModelBlock(pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>): string {
  if (!pi?.hasModelSelection) {
    return "";
  }
  const model = pi.defaultModel ? pi.defaultModel : "sonnet";
  return [
    "",
    "models:",
    `  planner: { model: ${model} }`,
    `  builder: { model: ${model} }`,
    `  reviewer: { model: ${model} }`,
    `  repair: { model: ${model} }`,
    "",
  ].join("\n");
}

function inputForce(answers?: Record<string, string>): boolean {
  return Boolean(answers?.["force"]);
}

async function buildDiffs(cwd: string, proposed: ProposedFactorySetup): Promise<SetupDiff[]> {
  const diffs: SetupDiff[] = [];
  for (const file of proposed.files) {
    let before = "";
    try {
      before = await fs.readFile(file.path, "utf8");
    } catch {
      before = "";
    }
    const changes: string[] = [];
    if (file.action === "create") {
      changes.push("create file");
    } else if (before !== file.content) {
      changes.push("content changes");
    } else {
      changes.push("unchanged");
    }
    diffs.push({
      file: file.path,
      before,
      after: file.content,
      changes,
    });
  }
  return diffs;
}
