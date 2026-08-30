import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { inspectRepositoryForSetup } from "./profile.js";
import { recommendFromProfile } from "./recommend.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { collectVisiblePiModels, detectPiModelConfiguration } from "./pi-models.js";
import { buildFactorySetupContext } from "./setup-context.js";
import { validateSetupRecommendation } from "./recommend-validate.js";
import { defaultConstitutionTemplate, defaultWorkflowTemplate } from "./init.js";
import type { FactorySetupRecommendation, SetupCommandConfig } from "@factory/schemas";
import type { ModelRole, ModelSelection } from "@factory/schemas";
import type {
  FactorySetupPlan,
  ProposedFactorySetup,
  SetupDecision,
  SetupDiff,
  SetupMode,
  SetupRecommendation,
} from "./types.js";
import { buildDiffs, renderCustomWorkflowYaml, readExistingConfig, inputForce, pick, pickSetupCommand, buildProjectConfig, type ExistingConfigShape, completeModelAssignments } from "./setup-config-render.js";

const MODEL_ROLES: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair", "landing"];

export interface PlanFactorySetupInput {
  cwd: string;
  answers?: Record<string, string>;
  force?: boolean;
  /** Pre-built LLM recommendation; when supplied, validated and applied before answers. */
  recommendation?: FactorySetupRecommendation;
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

  // Validate external recommendation against allowlists before it influences proposed files.
  if (input.recommendation) {
    const ctx = await buildFactorySetupContext(input.cwd);
    validateSetupRecommendation(input.recommendation, ctx);
  }

  const proposed = await buildProposedSetup(input.cwd, profile, recommendations, input.answers, input.recommendation);
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
  rec?: FactorySetupRecommendation,
): Promise<ProposedFactorySetup> {
  const root = profile.gitRoot ?? cwd;
  const files: ProposedFactorySetup["files"] = [];

  const findValue = (id: string): unknown => recommendations.find((r) => r.id === id)?.proposedValue;

  // Recommendation takes precedence over heuristic, but answers still win (user customization).
  let workflowContent: string;
  const customRec = rec?.workflow?.value as { kind?: string; preset?: string; workflow?: import("@factory/schemas").WorkflowDefinition } | undefined;
  const isCustom = customRec?.kind === "custom" && customRec.workflow;
  if (isCustom && !answers?.["workflow-preset"]) {
    workflowContent = renderCustomWorkflowYaml(customRec.workflow as import("@factory/schemas").WorkflowDefinition);
  } else {
    const effectivePreset = customRec?.kind === "preset" ? customRec.preset : undefined;
    const workflowPreset = (answers?.["workflow-preset"] as string) ?? effectivePreset ?? String(findValue("workflow:preset") ?? "balanced");
    workflowContent = defaultWorkflowTemplate(workflowPreset as "balanced" | "fast" | "safe");
  }
  const workflowPath = path.join(root, "factory.yaml");
  files.push({
    path: workflowPath,
    content: workflowContent,
    action: profile.factory.files.workflow ? "update" : "create",
  });

  // .factory/config.yaml — reconcile with existing config, preserving user-owned values.
  // Recommendation commands are applied only if DISCOVERED, or AI_SUGGESTED with explicit user confirmation via answers.
  const pi = await detectPiModelConfiguration(root).catch(() => undefined);
  const pm = profile.packageManagers[0] ?? "pnpm";
  const existing = profile.factory.files.projectConfig ? await readExistingConfig(path.join(root, ".factory", "config.yaml")) : undefined;
  const configPath = path.join(root, ".factory", "config.yaml");
  const configContent = await resolveConfigContent({
    profile,
    answers,
    rec,
    findValue,
    pm,
    existing,
    pi,
  });
  files.push({
    path: configPath,
    content: configContent,
    action: profile.factory.files.projectConfig ? "update" : "create",
  });

  // CONSTITUTION.md — stub unless generation/refresh is chosen. Recommendation drives this.
  const constitutionDecision = (answers?.["constitution"] as string) ?? (rec ? rec.constitution.toLowerCase() : "stub");
  const shouldWriteConstitution = !profile.factory.files.constitution || constitutionDecision === "generate" || constitutionDecision === "refresh" || inputForce(answers);
  if (shouldWriteConstitution) {
    const constitutionPath = path.join(root, "CONSTITUTION.md");
    files.push({
      path: constitutionPath,
      content: defaultConstitutionTemplate(),
      action: profile.factory.files.constitution ? "update" : "create",
    });
  }

  return { files };
}

async function resolveConfigContent(input: {
  profile: Awaited<ReturnType<typeof inspectRepositoryForSetup>>;
  answers?: Record<string, string>;
  rec?: FactorySetupRecommendation;
  findValue: (id: string) => unknown;
  pm: string;
  existing?: ExistingConfigShape;
  pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>;
}): Promise<string> {
  const { rec, answers, findValue, pm, existing, pi } = input;
  const recCmd = (field: "setup" | "lint" | "typecheck" | "test" | "build"): string | undefined => {
    const r = rec?.commands?.[field];
    if (!r) return undefined;
    if (r.source === "AI_SUGGESTED" && answers?.[`confirm:${field}`] !== "yes") return undefined;
    return r.value;
  };
  const commandFields = ["test", "lint", "typecheck", "build"] as const;
  const commandNames: Record<string, string> = { test: "test", lint: "lint", typecheck: "typecheck", build: "build" };
  const commands = {} as Record<string, string>;
  for (const field of commandFields) {
    commands[field] = pick(existing?.commands?.[field], answers?.[`cmd:${field}`], recCmd(field), findValue(`verification:${field}`), `${pm} ${commandNames[field]}`);
  }
  const testCommand = commands.test;
  const lintCommand = commands.lint;
  const typecheckCommand = commands.typecheck;
  const buildCommand = commands.build;
  const setupCommand = pickSetupCommand(existing?.commands?.setup, answers?.["cmd:setup"], recCmd("setup"), `${pm} install`);
  const maxParallelAgents = Number(answers?.["runtime:maxParallelAgents"] ?? rec?.runtime?.maxParallelAgents?.value ?? existing?.runtime?.maxParallelAgents ?? 4);
  const repairEnabled = answers?.["repair:enabled"] ? answers["repair:enabled"] === "true" : (rec?.repair?.enabled?.value ?? existing?.repair?.enabled ?? true);
  const maxAttempts = Number(answers?.["repair:maxAttempts"] ?? rec?.repair?.maxAttempts?.value ?? existing?.repair?.maxAttempts ?? 3);
  const finalMerge = (answers?.["approval:finalMerge"] as string) ?? rec?.approval?.finalMerge?.value ?? existing?.approval?.finalMerge ?? "required";
  const baseBranch = (answers?.["git:baseBranch"] as string) ?? rec?.git?.baseBranch?.value ?? existing?.project?.baseBranch ?? "main";
  return buildProjectConfig({
    testCommand,
    lintCommand,
    typecheckCommand,
    buildCommand,
    setupCommand,
    baseBranch,
    maxParallelAgents,
    repairEnabled,
    maxAttempts,
    finalMerge,
    pm,
    existing,
    pi,
    rec,
    recommendedTaskTypes: rec?.taskTypes?.map((t) => t.id) ?? (String(findValue("task-type:suggestions") ?? "").length ? findValue("task-type:suggestions") as string[] : undefined),
  });
}
