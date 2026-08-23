import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
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

  // .factory/config.yaml — reconcile with existing config, preserving user-owned values.
  const pi = await detectPiModelConfiguration(root).catch(() => undefined);
  const pm = profile.packageManagers[0] ?? "pnpm";
  const existing = profile.factory.files.projectConfig ? await readExistingConfig(path.join(root, ".factory", "config.yaml")) : undefined;
  const testCommand = pick(existing?.commands?.test, findValue("verification:test"), `${pm} test`);
  const lintCommand = pick(existing?.commands?.lint, findValue("verification:lint"), `${pm} lint`);
  const typecheckCommand = pick(existing?.commands?.typecheck, findValue("verification:typecheck"), `${pm} typecheck`);
  const buildCommand = pick(existing?.commands?.build, findValue("verification:build"), `${pm} build`);
  const configContent = buildProjectConfig({
    testCommand,
    lintCommand,
    typecheckCommand,
    buildCommand,
    pm,
    existing,
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

interface ExistingConfigShape {
  project?: { baseBranch?: string };
  commands?: { setup?: string; lint?: string; typecheck?: string; test?: string; build?: string };
  models?: Record<string, unknown>;
  runtime?: { maxParallelAgents?: number };
  repair?: { enabled?: boolean; maxAttempts?: number };
  approval?: { finalMerge?: string };
}

function buildProjectConfig(input: {
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  buildCommand: string;
  pm: string;
  existing?: ExistingConfigShape;
  pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>;
}): string {
  const modelBlock = renderModelBlock(input.pi);
  const maxParallelAgents = input.existing?.runtime?.maxParallelAgents ?? 4;
  const repairEnabled = input.existing?.repair?.enabled ?? true;
  const maxAttempts = input.existing?.repair?.maxAttempts ?? 3;
  const finalMerge = input.existing?.approval?.finalMerge ?? "required";
  const baseBranch = input.existing?.project?.baseBranch ?? "main";
  const setupCommand = input.existing?.commands?.setup ?? `${input.pm} install`;

  return [
    "project:",
    `  baseBranch: ${baseBranch}`,
    "",
    "commands:",
    `  setup: ${setupCommand}`,
    `  lint: ${input.lintCommand}`,
    `  typecheck: ${input.typecheckCommand}`,
    `  test: ${input.testCommand}`,
    `  build: ${input.buildCommand}`,
    modelBlock,
    "runtime:",
    `  maxParallelAgents: ${maxParallelAgents}`,
    "",
    "repair:",
    `  enabled: ${repairEnabled}`,
    `  maxAttempts: ${maxAttempts}`,
    "",
    "approval:",
    `  finalMerge: ${finalMerge}`,
    "",
  ].join("\n");
}

async function readExistingConfig(filePath: string): Promise<ExistingConfigShape | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseYaml(raw) as ExistingConfigShape;
  } catch {
    return undefined;
  }
}

function pick(...values: Array<string | unknown | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
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
