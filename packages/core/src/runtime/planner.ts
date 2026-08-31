import type { Capability, CapabilityPolicy, EffectiveFactoryConfig, ModelSelection, WorkflowNodeType, WorkflowStage, WorkflowStageSkillPolicy } from "@factory/schemas";
import { smartRunTitle } from "../runs/title.js";
import { isBuildStage, uniqueStrings } from "./task-utils.js";

export interface PlannerTask {
  id: string;
  title: string;
  stage: string;
  status: "pending" | "done";
  dependsOn: string[];
  type?: WorkflowNodeType;
  role?: string;
  commands?: string[];
  requiresApproval?: boolean;
  context?: {
    fileHints?: string[];
    constitutionAreas?: number[];
    requiredCapabilities?: string[];
    includeDependencyArtifacts?: boolean;
  };
  requiredCapabilities?: Capability[];
  capabilityPolicy?: CapabilityPolicy;
  taskType?: string;
  model?: ModelSelection;
  skills?: WorkflowStageSkillPolicy;
  controllerHandled?: boolean;
  artifactRefs?: {
    discoveryExecutionPath?: string;
    interviewExecutionPath?: string;
    plannerExecutionPath?: string;
  };
}

export interface ImplementationContract {
  targetFiles?: string[];
  nonGoals?: string[];
  verificationChecks?: Array<{ name: string; command?: string; reason?: string }>;
  risks?: Array<{ risk: string; mitigation?: string }>;
  blockers?: string[];
}

export interface PlannerArtifact {
  goal: string;
  summary: string;
  discoveryText?: string;
  planText?: string;
  implementationContract?: ImplementationContract;
  workflowStages: Array<{
    name: string;
    dependsOn: string[];
    type?: WorkflowNodeType;
    role?: string;
    commands?: string[];
    requiresApproval?: boolean;
    requiredCapabilities?: Capability[];
    taskType?: string;
    model?: ModelSelection;
    skills?: WorkflowStageSkillPolicy;
  }>;
  tasks: PlannerTask[];
}

export function buildPlanArtifact(input: {
  goal: string;
  config: EffectiveFactoryConfig;
  discoveryText?: string;
  planText?: string;
  artifactRefs?: {
    discoveryExecutionPath?: string;
    interviewExecutionPath?: string;
    plannerExecutionPath?: string;
  };
}): PlannerArtifact {
  const workflowStages = normalizeWorkflowStages(input.config.resolvedWorkflow?.stages ?? []);

  const tasks: PlannerTask[] = workflowStages.map((stage, index) => {
    const controllerHandled = isControllerHandledStage(stage.name, stage.type);
    return {
      id: `task-${index + 1}`,
      title: buildTaskTitle(stage.name, input.goal),
      stage: stage.name,
      status: controllerHandled ? "done" as const : "pending" as const,
      dependsOn: stage.dependsOn,
      type: stage.type,
      role: stage.role,
      commands: stage.commands,
      requiresApproval: stage.requiresApproval,
      requiredCapabilities: stage.requiredCapabilities,
      taskType: stage.taskType,
      model: stage.model,
      skills: stage.skills,
      context: undefined,
      controllerHandled: controllerHandled || undefined,
      artifactRefs: controllerHandled ? input.artifactRefs : undefined,
    };
  });

  const implementationContract = extractImplementationContract(input.planText, input.discoveryText);

  // Planner intent must reach Builder as explicit file targets: when discovery
  // is a net-new surface (implementationSurface: missing), discovery hints are
  // empty and Builder would otherwise rediscover the whole implementation
  // surface from scratch.
  const contractTargetFiles = implementationContract?.targetFiles ?? [];
  if (contractTargetFiles.length > 0) {
    for (const task of tasks) {
      if (!isBuildStage(task.stage) && task.role !== "builder") {
        continue;
      }
      task.context = {
        ...task.context,
        fileHints: uniqueStrings([...(task.context?.fileHints ?? []), ...contractTargetFiles]),
      };
    }
  }

  return {
    goal: input.goal,
    summary: buildSummary(input.goal, input.config, workflowStages),
    discoveryText: input.discoveryText,
    planText: input.planText,
    implementationContract,
    workflowStages,
    tasks,
  };
}

/**
 * Best-effort extraction of structured planner intent from prose.
 * Backward-compatible: returns undefined when nothing can be extracted.
 */
export function extractImplementationContract(
  planText?: string,
  discoveryText?: string,
): ImplementationContract | undefined {
  const targetFiles = extractFileList(planText, "target files")
    ?? extractFileList(planText, "new files builder must create")
    ?? extractFileList(planText, "existing files builder must modify")
    ?? extractFileList(discoveryText, "target files")
    ?? (() => {
      const inline = extractInlineFilePaths(planText);
      return inline.length > 0 ? inline : undefined;
    })();
  const nonGoals = extractBulletSection(planText, "non-goals", "non goals", "out of scope");
  const blockers = extractBulletSection(planText, "blockers", "blocked");
  const risks = extractRisks(planText);
  const verificationChecks = extractVerificationChecks(planText);

  if (!targetFiles && !nonGoals && !blockers && !risks && !verificationChecks) {
    return undefined;
  }
  return {
    ...(targetFiles?.length ? { targetFiles } : {}),
    ...(nonGoals?.length ? { nonGoals } : {}),
    ...(verificationChecks?.length ? { verificationChecks } : {}),
    ...(risks?.length ? { risks } : {}),
    ...(blockers?.length ? { blockers } : {}),
  };
}

function extractFileList(text: string | undefined, section: string): string[] | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const sectionIndex = lower.indexOf(section);
  if (sectionIndex < 0) return undefined;
  const after = text.slice(sectionIndex + section.length).slice(0, 600);
  const lines = after.split(/\r?\n/);
  const files: string[] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s*/, "").trim();
    if (!cleaned || /^[a-z ]*$/.test(cleaned)) break;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sql|json|ya?ml|md)$/i.test(cleaned)) {
      files.push(cleaned.replace(/^`|`$/g, ""));
    }
  }
  return files.length > 0 ? files : undefined;
}

/**
 * File paths mentioned inline in prose, e.g. "Create `src/data/books/book.json`
 * - ..." or "Edit `src/app/sitemap.ts` to ...". Planner prose often names target
 * files without a dedicated "Target files" section, so this catches paths
 * anywhere in the text as a fallback for contract extraction.
 */
export function extractInlineFilePaths(text: string | undefined): string[] {
  if (!text) return [];
  const paths = new Set<string>();
  const pathPattern = /`?([\w@][\w./-]*\/)*(src|public|app|packages|docs|lib|tests?|scripts)[\w./-]*\.[\w]{1,8}`?/g;
  for (const match of text.matchAll(pathPattern)) {
    const cleaned = match[0].replace(/^`|`$/g, "");
    if (cleaned.length > 3 && cleaned.length < 200) {
      paths.add(cleaned);
    }
  }
  return [...paths];
}

function extractBulletSection(text: string | undefined, ...sectionNames: string[]): string[] | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  let start = -1;
  for (const name of sectionNames) {
    const idx = lower.indexOf(name);
    if (idx >= 0) { start = idx; break; }
  }
  if (start < 0) return undefined;
  const after = text.slice(start).split(/\r?\n/);
  const items: string[] = [];
  for (const line of after.slice(1)) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    if (cleaned.startsWith("-") || cleaned.startsWith("*")) {
      items.push(cleaned.replace(/^[-*]\s*/, "").trim());
    } else if (items.length > 0) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
}

function extractRisks(text: string | undefined): ImplementationContract["risks"] {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const risks: ImplementationContract["risks"] = [];
  let inSection = false;
  for (const line of lines) {
    if (/risk|edge case|trade.?off/i.test(line) && /^[-*]|^\d+\./.test(line.trim())) {
      inSection = true;
    }
    if (inSection) {
      const cleaned = line.replace(/^[-*]\s*|^\d+\.\s*/, "").trim();
      if (cleaned && cleaned !== "Risk") {
        risks.push({ risk: cleaned });
      }
    }
  }
  return risks.length > 0 ? risks : undefined;
}

function extractVerificationChecks(text: string | undefined): ImplementationContract["verificationChecks"] {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const checks: ImplementationContract["verificationChecks"] = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s*/, "").trim();
    if (/(npm|pnpm|yarn|npx)\s+(run\s+)?[a-z0-9:_-]+/i.test(cleaned)) {
      checks.push({ name: cleaned.split(/\s+/)[0] ?? cleaned, command: cleaned });
    }
  }
  return checks.length > 0 ? checks : undefined;
}

function normalizeWorkflowStages(stages: WorkflowStage[]): PlannerArtifact["workflowStages"] {
  if (stages.length === 0) {
    return [
      { name: "planning", dependsOn: [], type: "agent", role: "planner" },
      { name: "implementation", dependsOn: ["planning"], type: "agent", role: "builder" },
      { name: "verification", dependsOn: ["implementation"], type: "command", commands: ["lint", "typecheck", "test", "build"] },
      { name: "approval", dependsOn: ["verification"], type: "approval" },
    ];
  }

  return stages.map((stage) => ({
    name: stage.name,
    dependsOn: stage.dependsOn ?? [],
    type: stage.type,
    role: stage.role,
    commands: stage.commands,
    requiresApproval: stage.requiresApproval,
    requiredCapabilities: stage.requiredCapabilities,
    taskType: stage.taskType,
    model: stage.model,
    skills: stage.skills,
  }));
}

function isControllerHandledStage(stageName: string, type?: WorkflowNodeType): boolean {
  const name = stageName.toLowerCase();
  return type === "interview"
    || name === "plan"
    || name === "planning"
    || name === "discover"
    || name === "discovery";
}

function buildTaskTitle(stageName: string, goal: string): string {
  const title = smartRunTitle(goal);
  switch (stageName) {
    case "plan":
    case "planning":
      return `Plan work for: ${title}`;
    case "interview":
      return `Interview before planning for: ${title}`;
    case "build":
    case "implementation":
      return `Implement changes for: ${title}`;
    case "verify":
    case "verification":
      return `Verify changes for: ${title}`;
    case "approval":
    case "approval-ready":
      return `Prepare approval package for: ${title}`;
    case "merge":
      return `Merge approved changes for: ${title}`;
    default:
      return `${capitalize(stageName)} for: ${title}`;
  }
}

function buildSummary(
  goal: string,
  config: EffectiveFactoryConfig,
  workflowStages: PlannerArtifact["workflowStages"],
): string {
  return [
    `Goal: ${goal}`,
    `Base branch: ${config.git.baseBranch}`,
    `Workflow: ${workflowStages.map((stage) => stage.name).join(" -> ")}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
  ].join("\n");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
