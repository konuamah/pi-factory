// Setup config rendering helpers — extracted from plan.ts.

import fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { detectPiModelConfiguration, collectVisiblePiModels } from "@factory/core";
import type { FactorySetupRecommendation, SetupCommandConfig, ModelRole, ModelSelection } from "@factory/schemas";
import type { ProposedFactorySetup, SetupDiff } from "./types.js";
export const MODEL_ROLES: ModelRole[] = ["discovery", "planner", "builder", "reviewer", "repair"];

export interface ExistingConfigShape {
  project?: { baseBranch?: string };
  commands?: { setup?: SetupCommandConfig; lint?: string; typecheck?: string; test?: string; build?: string };
  models?: Record<string, unknown>;
  runtime?: { maxParallelAgents?: number };
  dependencies?: { enabled?: boolean; hydrate?: "auto" | "always" | "never"; cacheRoot?: string };
  constitution?: { enabled?: boolean };
  repair?: { enabled?: boolean; maxAttempts?: number };
  approval?: { finalMerge?: string };
}

export function buildProjectConfig(input: {
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

export async function readExistingConfig(filePath: string): Promise<ExistingConfigShape | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseYaml(raw) as ExistingConfigShape;
  } catch {
    return undefined;
  }
}

export function pick(...values: Array<string | unknown | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

export function pickSetupCommand(...values: Array<SetupCommandConfig | unknown | undefined>): SetupCommandConfig {
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

export function isSetupStep(value: unknown): value is { name?: string; description?: string; command: string } {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof (value as { command?: unknown }).command === "string";
}

export function renderSetupCommand(setup: SetupCommandConfig): string[] {
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

export function renderDependencyBlock(rec?: FactorySetupRecommendation, existing?: ExistingConfigShape): string {
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

export function renderTaskTypes(taskTypes: string[] | undefined): string {
  if (!taskTypes?.length) {
    return "";
  }
  const lines = taskTypes.map((id) => `  ${id}:\n    match:\n      keywords: [${id}]`).join("\n");
  return `\ntaskTypes:\n${lines}\n\n`;
}

export function renderModelBlock(pi?: Awaited<ReturnType<typeof detectPiModelConfiguration>>, rec?: FactorySetupRecommendation): string {
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

export function completeModelAssignments(
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

export function renderCapabilityBlock(rec?: FactorySetupRecommendation): string {
  if (!rec?.capabilities || (!rec.capabilities.allow?.length && !rec.capabilities.deny?.length)) return "";
  const lines: string[] = ["", "capabilities:"];
  if (rec.capabilities.allow?.length) lines.push(`  allow: [${rec.capabilities.allow.join(", ")}]`);
  if (rec.capabilities.deny?.length) lines.push(`  deny: [${rec.capabilities.deny.join(", ")}]`);
  lines.push("");
  return lines.join("\n");
}

export function renderGitBlock(rec?: FactorySetupRecommendation, existing?: ExistingConfigShape & { git?: { allowWorktrees?: boolean; worktreeDir?: string; cleanup?: { retainRuns?: number; pruneWorktrees?: boolean; pruneBranches?: boolean } } }): string {
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

export function renderCustomWorkflowYaml(wf: import("@factory/schemas").WorkflowDefinition): string {
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

export function inputForce(answers?: Record<string, string>): boolean {
  return Boolean(answers?.["force"]);
}

export async function buildDiffs(cwd: string, proposed: ProposedFactorySetup): Promise<SetupDiff[]> {
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

