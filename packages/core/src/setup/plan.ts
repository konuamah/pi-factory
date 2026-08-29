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

const MODEL_ROLES: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair"];

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

interface ExistingConfigShape {
  project?: { baseBranch?: string };
  commands?: { setup?: SetupCommandConfig; lint?: string; typecheck?: string; test?: string; build?: string };
  models?: Record<string, unknown>;
  runtime?: { maxParallelAgents?: number };
  dependencies?: { enabled?: boolean; hydrate?: "auto" | "always" | "never"; cacheRoot?: string };
  constitution?: { enabled?: boolean };
  repair?: { enabled?: boolean; maxAttempts?: number };
  approval?: { finalMerge?: string };
}

function buildProjectConfig(input: {
  testCommand: string;
  lintCommand: string;
  typecheckCommand: string;
  buildCommand: string;
  setupCommand: SetupCommandConfig;
  baseBranch: string;
  maxParallelAgents: number;
  repairEnabled: boolean;
  maxAttempts: number;
  finalMerge: string;
  pm: string;
  existing?: ExistingConfigShape;
  pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>;
  rec?: FactorySetupRecommendation;
  recommendedTaskTypes?: string[];
}): string {
  const modelBlock = renderModelBlock(input.pi, input.rec);
  const taskTypeBlock = renderTaskTypes(input.recommendedTaskTypes);
  const capabilityBlock = renderCapabilityBlock(input.rec);
  const gitBlock = renderGitBlock(input.rec, input.existing);
  const dependencyBlock = renderDependencyBlock(input.rec, input.existing);

  return [
    "project:",
    `  baseBranch: ${input.baseBranch}`,
    "",
    "commands:",
    ...renderSetupCommand(input.setupCommand),
    `  lint: ${input.lintCommand}`,
    `  typecheck: ${input.typecheckCommand}`,
    `  test: ${input.testCommand}`,
    `  build: ${input.buildCommand}`,
    modelBlock,
    taskTypeBlock,
    capabilityBlock,
    gitBlock,
    dependencyBlock,
    "runtime:",
    `  maxParallelAgents: ${input.maxParallelAgents}`,
    "",
    "constitution:",
    `  enabled: ${input.existing?.constitution?.enabled ?? false}`,
    "",
    "repair:",
    `  enabled: ${input.repairEnabled}`,
    `  maxAttempts: ${input.maxAttempts}`,
    "",
    "approval:",
    `  finalMerge: ${input.finalMerge}`,
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

function pickSetupCommand(...values: Array<SetupCommandConfig | unknown | undefined>): SetupCommandConfig {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
    if (Array.isArray(value) && value.some((step) => isSetupStep(step) && step.command.trim())) {
      return value.filter((step): step is { name?: string; description?: string; command: string } => isSetupStep(step) && Boolean(step.command.trim()));
    }
  }
  return "";
}

function isSetupStep(value: unknown): value is { name?: string; description?: string; command: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { command?: unknown }).command === "string";
}

function renderSetupCommand(setup: SetupCommandConfig): string[] {
  if (typeof setup === "string") {
    return [`  setup: ${setup}`];
  }
  if (!Array.isArray(setup) || setup.length === 0) {
    return ["  setup: "];
  }
  const lines = ["  setup:"];
  for (const step of setup) {
    lines.push(`    - command: ${JSON.stringify(step.command)}`);
    if (step.name) lines.push(`      name: ${JSON.stringify(step.name)}`);
    if (step.description) lines.push(`      description: ${JSON.stringify(step.description)}`);
  }
  return lines;
}

function renderDependencyBlock(rec?: FactorySetupRecommendation, existing?: ExistingConfigShape): string {
  const enabled = rec?.dependencies?.enabled?.value ?? existing?.dependencies?.enabled ?? true;
  const hydrate = rec?.dependencies?.hydrate?.value ?? existing?.dependencies?.hydrate ?? "auto";
  const cacheRoot = rec?.dependencies?.cacheRoot?.value ?? existing?.dependencies?.cacheRoot;

  const lines = ["", "dependencies:"];
  lines.push(`  enabled: ${enabled}`);
  lines.push(`  hydrate: ${hydrate}`);
  if (cacheRoot) lines.push(`  cacheRoot: ${cacheRoot}`);
  lines.push("");
  return lines.join("\n");
}

function renderTaskTypes(taskTypes: string[] | undefined): string {
  if (!taskTypes?.length) {
    return "";
  }
  const lines = taskTypes.map((id) => `  ${id}:\n    match:\n      keywords: [${id}]`).join("\n");
  return `\ntaskTypes:\n${lines}\n\n`;
}

function renderModelBlock(pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>, rec?: FactorySetupRecommendation): string {
  const visibleDefault = collectVisiblePiModels(pi)[0];
  const assignments = completeModelAssignments(rec, visibleDefault);
  if (Object.keys(assignments).length === 0) {
    return "";
  }

  const lines: string[] = ["", "models:"];
  for (const role of MODEL_ROLES) {
    const selection = assignments[role];
    if (!selection?.model) continue;
    const provider = selection.provider ? `provider: ${selection.provider}, ` : "";
    lines.push(`  ${role}: { ${provider}model: ${selection.model} }`);
  }
  if (lines.length <= 2) {
    return "";
  }
  lines.push("");
  return lines.join("\n");
}

function completeModelAssignments(
  rec: FactorySetupRecommendation | undefined,
  visibleDefault: ModelSelection | undefined,
): Partial<Record<ModelRole, ModelSelection>> {
  const out: Partial<Record<ModelRole, ModelSelection>> = {};

  for (const role of MODEL_ROLES) {
    const selection = rec?.models?.[role]?.value;
    if (selection?.model) {
      out[role] = selection;
    }
  }

  if (!visibleDefault) {
    return out;
  }

  for (const role of MODEL_ROLES) {
    if (!out[role]?.model) {
      out[role] = visibleDefault;
    }
  }

  return out;
}

function renderCapabilityBlock(rec?: FactorySetupRecommendation): string {
  if (!rec?.capabilities || (!rec.capabilities.allow?.length && !rec.capabilities.deny?.length)) return "";
  const lines: string[] = ["", "capabilities:"];
  if (rec.capabilities.allow?.length) lines.push(`  allow: [${rec.capabilities.allow.join(", ")}]`);
  if (rec.capabilities.deny?.length) lines.push(`  deny: [${rec.capabilities.deny.join(", ")}]`);
  lines.push("");
  return lines.join("\n");
}

function renderGitBlock(rec?: FactorySetupRecommendation, existing?: ExistingConfigShape & { git?: { allowWorktrees?: boolean; worktreeDir?: string; cleanup?: { retainRuns?: number; pruneWorktrees?: boolean; pruneBranches?: boolean } } }): string {
  if (!rec?.git) return "";
  const lines: string[] = ["", "git:"];
  if (rec.git.baseBranch) lines.push(`  baseBranch: ${rec.git.baseBranch.value}`);
  if (rec.git.allowWorktrees) lines.push(`  allowWorktrees: ${rec.git.allowWorktrees.value}`);
  if (rec.git.worktreeDir) lines.push(`  worktreeDir: ${rec.git.worktreeDir.value}`);
  if (rec.git.cleanup) {
    const cl = rec.git.cleanup;
    const parts: string[] = [];
    if (cl.retainRuns) parts.push(`retainRuns: ${cl.retainRuns.value}`);
    if (cl.pruneWorktrees) parts.push(`pruneWorktrees: ${cl.pruneWorktrees.value}`);
    if (cl.pruneBranches) parts.push(`pruneBranches: ${cl.pruneBranches.value}`);
    if (parts.length) { lines.push("  cleanup:"); for (const p of parts) lines.push(`    ${p}`); }
  }
  if (lines.length <= 2) return "";
  lines.push("");
  return lines.join("\n");
}

function renderCustomWorkflowYaml(wf: import("@factory/schemas").WorkflowDefinition): string {
  const lines: string[] = [`defaultWorkflowId: ${wf.id}`, "workflows:", `  - id: ${wf.id}`, `    name: ${JSON.stringify(wf.name)}`];
  if (wf.description) lines.push(`    description: ${JSON.stringify(wf.description)}`);
  lines.push("    stages:");
  for (const st of wf.stages) {
    lines.push(`      - name: ${st.name}`);
    if (st.type) lines.push(`        type: ${st.type}`);
    if (st.role) lines.push(`        role: ${st.role}`);
    if (st.dependsOn?.length) lines.push(`        dependsOn: [${st.dependsOn.join(", ")}]`);
    if (st.commands?.length) lines.push(`        commands: [${st.commands.map((c) => JSON.stringify(c)).join(", ")}]`);
    if (st.requiresApproval) lines.push(`        requiresApproval: true`);
    if (st.requiredCapabilities?.length) lines.push(`        requiredCapabilities: [${st.requiredCapabilities.join(", ")}]`);
    if (st.model) lines.push(`        model: ${JSON.stringify(st.model)}`);
  }
  return lines.join("\n") + "\n";
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
