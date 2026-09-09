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
  implementationSteps?: string[];
  verificationChecks?: Array<{ name: string; command?: string; reason?: string }>;
  risks?: Array<{ risk: string; mitigation?: string }>;
  blockers?: string[];
  changeRequired?: "required" | "not-required" | "uncertain";
  baselineFindings?: string[];
  requiredChanges?: string[];
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

  // Discovery-declared create-targets (newFiles) are authoritative: the goal
  // requires creating them, so ensure they appear in the contract's target
  // files even if the planner prose did not list them explicitly. This closes
  // the loop for mixed edit+create tasks where discovery reports newFiles.
  const discoveryNewFiles = extractDiscoveryNewFiles(input.discoveryText);
  const mergedContract: ImplementationContract | undefined = discoveryNewFiles.length === 0
    ? implementationContract
    : {
        ...(implementationContract ?? {}),
        targetFiles: uniqueStrings([...(implementationContract?.targetFiles ?? []), ...discoveryNewFiles]),
      };

  // Planner intent must reach Builder as explicit file targets: when discovery
  // is a net-new surface (implementationSurface: missing), discovery hints are
  // empty and Builder would otherwise rediscover the whole implementation
  // surface from scratch.
  const contractTargetFiles = mergedContract?.targetFiles ?? [];
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
    implementationContract: mergedContract,
    workflowStages,
    tasks,
  };
}

/**
 * Parse discovery output JSON and return its newFiles array (files the goal
 * requires creating). Returns [] when discovery is absent or has no newFiles.
 */
export function extractDiscoveryNewFiles(discoveryText?: string): string[] {
  if (!discoveryText) return [];
  try {
    const parsed = JSON.parse(discoveryText) as { newFiles?: unknown };
    if (!Array.isArray(parsed.newFiles)) return [];
    return parsed.newFiles.filter((file): file is string => typeof file === "string" && Boolean(file.trim()));
  } catch {
    return [];
  }
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
  const nonGoals = extractBulletSection(planText, "non-goals", "non goals");
  const implementationSteps = extractImplementationSteps(planText);
  const blockers = extractBulletSection(planText, "blockers", "blocked");
  const risks = extractRisks(planText);
  const verificationChecks = extractVerificationChecks(planText);
  const changeRequirement = extractChangeRequirement(planText);

  if (!targetFiles && !nonGoals && !implementationSteps && !blockers && !risks && !verificationChecks && !changeRequirement) {
    return undefined;
  }
  return {
    ...(targetFiles?.length ? { targetFiles } : {}),
    ...(nonGoals?.length ? { nonGoals } : {}),
    ...(implementationSteps?.length ? { implementationSteps } : {}),
    ...(verificationChecks?.length ? { verificationChecks } : {}),
    ...(risks?.length ? { risks } : {}),
    ...(blockers?.length ? { blockers } : {}),
    ...(changeRequirement ? changeRequirement : {}),
  };
}

function extractFileList(text: string | undefined, section: string): string[] | undefined {
  if (!text) return undefined;
  // The section heading must be its own line (optionally numbered / markdown
  // headed), not a phrase inside prose — "the target files are ..." in a
  // sentence must never be treated as the section.
  const lines = text.split(/\r?\n/);
  let sectionIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^#{1,6}\s*/, "");
    const idx = line.toLowerCase().indexOf(section);
    if (idx < 0) continue;
    if (idx === 0 || /^\d+\.\s*/.test(line.slice(0, idx))) {
      sectionIndex = i;
      break;
    }
  }
  if (sectionIndex < 0) return undefined;
  const after = lines.slice(sectionIndex + 1);
  const files: string[] = [];
  for (const rawLine of after) {
    const line = rawLine.trim();
    // Skip blank lines; stop only at the next section heading or a non-file
    // line — a heading may be followed by a blank line before its bullets.
    if (!line) continue;
    if (/^#{1,6}\s/.test(line) || /^\d+\.\s+[A-Z]/.test(line)) break;
    const cleaned = line.replace(/^[-*]\s*/, "").trim();
    if (/^[a-z ]*$/.test(cleaned)) break;
    const file = extractFirstFilePath(cleaned);
    if (file) {
      files.push(file);
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
  // Root-level files (index.html, script.js) have no directory prefix; prefixed
  // paths (src/app/x.ts, tests/verify-page.mjs) do. Match a file path (with
  // optional backtick quoting) ending in a known source extension.
  const pathPattern = /`?[\w@][\w./-]*\.(tsx|jsx|mjs|cjs|json|ya?ml|scss|html|css|ts|js|py|go|rs|sql|md)`?/gi;
  for (const match of text.matchAll(pathPattern)) {
    const cleaned = match[0].replace(/^`|`$/g, "");
    if (cleaned.length > 3 && cleaned.length < 200 && !cleaned.includes("://")) {
      paths.add(cleaned);
    }
  }
  return [...paths];
}

function extractFirstFilePath(value: string): string | undefined {
  const match = value.match(/`?([\w@][\w./-]*\.(tsx|jsx|mjs|cjs|json|ya?ml|scss|html|css|ts|js|py|go|rs|sql|md))`?/i);
  return match?.[1];
}

function extractBulletSection(text: string | undefined, ...sectionNames: string[]): string[] | undefined {
  if (!text) return undefined;
  const lower = text.toLowerCase();
  const lines = lower.split(/\r?\n/);
  let startLine = -1;
  // A section heading must be its own line (optionally numbered / markdown
  // headed), not a phrase inside prose — "out of scope now" in a sentence
  // must never be treated as a "Non-goals" heading.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^#{1,6}\s*/, "");
    const match = sectionNames.some((name) => {
      const idx = line.toLowerCase().indexOf(name);
      if (idx < 0) return false;
      return idx === 0 || /^\d+\.\s*/.test(line.slice(0, idx));
    });
    if (match) { startLine = i; break; }
  }
  if (startLine < 0) return undefined;
  const after = text.split(/\r?\n/).slice(startLine + 1);
  const items: string[] = [];
  for (const line of after) {
    const cleaned = line.trim();
    if (!cleaned) continue;
    // Stop at the next section heading (numbered or markdown headed).
    if (/^#{1,6}\s/.test(cleaned) || /^\d+\.\s+[A-Z]/.test(cleaned)) break;
    if (cleaned.startsWith("-") || cleaned.startsWith("*")) {
      items.push(cleaned.replace(/^[-*]\s*/, "").trim().replace(/^`|`$/g, ""));
    } else if (items.length > 0) {
      break;
    }
  }
  return items.length > 0 ? items : undefined;
}

function extractImplementationSteps(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim().replace(/^#{1,6}\s*/, "");
    if (/^(\d+\.\s*)?implementation sequence\b/i.test(line)) {
      startLine = i;
      break;
    }
  }
  if (startLine < 0) return undefined;

  const steps: string[] = [];
  for (const rawLine of lines.slice(startLine + 1)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line) || /^\d+\.\s+[A-Z]/.test(line)) break;
    const cleaned = line
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .trim();
    if (/^step\s+\d+\b/i.test(cleaned) || steps.length > 0) {
      steps.push(cleaned);
      continue;
    }
    if (cleaned && !/^none\.?$/i.test(cleaned)) {
      steps.push(cleaned);
    }
  }
  return steps.length > 0 ? steps : undefined;
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
    // Normalize list decoration artifacts (e.g. "- — - Run `cd backend && npm start`")
    // down to the command itself, then extract a package-manager command.
    const commandOnly = cleaned
      .replace(/^(?:[-–—]+\s*)+/, "")
      .replace(/^Run\s+/i, "")
      .replace(/`/g, "")
      .replace(/\.+$/, "")
      .trim();
    if (!/(npm|pnpm|yarn|npx)\s+(run\s+)?[a-z0-9:_-]+/i.test(commandOnly)) {
      continue;
    }
    checks.push({ name: commandOnly.split(/\s+/)[0] ?? commandOnly, command: commandOnly });
  }
  return checks.length > 0 ? checks : undefined;
}

function extractChangeRequirement(text: string | undefined): Pick<
  ImplementationContract,
  "changeRequired" | "baselineFindings" | "requiredChanges"
> | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    /^#{0,6}\s*(?:\d+\.\s*)?CHANGE REQUIREMENT\s*$/i.test(line.trim()),
  );
  if (headingIndex < 0) return undefined;
  const section = lines.slice(headingIndex + 1);
  const statusLine = section.find((line) => /^\s*[-*]?\s*Status:\s*/i.test(line));
  const match = statusLine?.match(/Status:\s*(required|not-required|uncertain)\s*$/i);
  const changeRequired = match?.[1]?.toLowerCase() as "required" | "not-required" | "uncertain" | undefined;
  const baselineFindings = section
    .filter((line) => /^\s*[-*]?\s*Baseline gap:\s*/i.test(line))
    .map((line) => line.replace(/^\s*[-*]?\s*Baseline gap:\s*/i, "").trim())
    .filter(Boolean);
  const requiredChanges = section
    .filter((line) => /^\s*[-*]?\s*Required change:\s*/i.test(line))
    .map((line) => line.replace(/^\s*[-*]?\s*Required change:\s*/i, "").trim())
    .filter(Boolean);
  if (!changeRequired && baselineFindings.length === 0 && requiredChanges.length === 0) {
    return undefined;
  }
  return {
    ...(changeRequired ? { changeRequired } : {}),
    ...(baselineFindings.length > 0 ? { baselineFindings } : {}),
    ...(requiredChanges.length > 0 ? { requiredChanges } : {}),
  };
}

function normalizeWorkflowStages(stages: WorkflowStage[]): PlannerArtifact["workflowStages"] {
  if (stages.length === 0) {
    return [
      { name: "planning", dependsOn: [], type: "agent", role: "planner" },
      { name: "implementation", dependsOn: ["planning"], type: "agent", role: "builder" },
      { name: "verification", dependsOn: ["implementation"], type: "command", commands: ["lint", "typecheck", "test", "build"] },
      { name: "review", dependsOn: ["verification"], type: "agent", role: "reviewer" },
      { name: "acceptance", dependsOn: ["review"], type: "acceptance" },
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
    || name === "discovery"
    || name === "approval"
    || name === "acceptance";
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
    case "acceptance":
      return `Prepare acceptance package for: ${title}`;
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
