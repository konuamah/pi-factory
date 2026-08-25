import type { SkillContract, SkillExecutionStage } from "@factory/schemas";
import type { PlannerTask } from "../runtime/planner.js";
import { selectConstitutionContext } from "../constitution/context.js";
import { findFactorySkills } from "../skills/registry.js";
import type { SkillSelectionResult } from "../skills/types.js";

export type ContextRole = "discovery" | "planner" | "builder" | "reviewer" | "repair" | "verification";

export interface ContextFile {
  path: string;
  reason: string;
  relevance: number;
}

export interface ContextDecision {
  label: string;
  value: string;
  reason: string;
}

export interface DependencyContext {
  taskId: string;
  stage: string;
  title: string;
  reason: string;
}

export interface FailureContext {
  attempt: number;
  summary: string;
}

export interface SkillContext {
  id: string;
  version: string;
  reasons: string[];
}

export interface CompiledContext {
  role: ContextRole;
  goal: string;
  task?: PlannerTask;
  instructions: string[];
  files: ContextFile[];
  decisions: ContextDecision[];
  dependencies: DependencyContext[];
  failures: FailureContext[];
  skills: SkillContext[];
  capabilities: string[];
  grantedCapabilities: string[];
  deniedCapabilities: string[];
  runDecisions: Array<{ requestId: string; question: string; optionId: string; feedback?: string }>;
  tokenEstimate: number;
}

export interface ContextCompileRequest {
  cwd: string;
  role: ContextRole;
  goal: string;
  task?: PlannerTask;
  dependencyTasks?: PlannerTask[];
  skills?: SkillSelectionResult[];
  failures?: FailureContext[];
  constitutionAreas?: number[];
  fileHints?: string[];
  maxChars?: number;
  grantedCapabilities?: string[];
  deniedCapabilities?: string[];
  runDecisions?: Array<{ requestId: string; question: string; optionId: string; feedback?: string }>;
  useConstitution?: boolean;
}

export async function compileAgentContext(input: ContextCompileRequest): Promise<CompiledContext> {
  const guidance = await selectConstitutionContext({
    cwd: input.cwd,
    role: toGuidanceRole(input.role),
    goal: input.goal,
    useConstitution: input.useConstitution,
  });

  const dependencyContexts = (input.dependencyTasks ?? []).map((task) => ({
    taskId: task.id,
    stage: task.stage,
    title: task.title,
    reason: `Upstream dependency of ${input.task?.id ?? input.goal}; its output is relevant to this task.`,
  }));

  const skills = (input.skills ?? []).map((selection) => ({
    id: selection.skill.id,
    version: selection.skill.version,
    reasons: selection.reasons,
  }));

  const capabilities = dedupe((input.skills ?? []).flatMap((selection) => selection.skill.provides?.capabilities ?? []));

  const files = await selectRelevantFiles(input);

  const decisions: ContextDecision[] = [
    { label: "guidance", value: guidance.usedConstitution ? "constitution" : guidance.instructionFiles.length > 0 ? "instruction-files" : "none", reason: "Selected highest-relevance repo guidance." },
    ...(input.skills?.length ? [{ label: "skills", value: input.skills.map((item) => item.skill.id).join(","), reason: "Selected skill bundle for this role/stage." }] : []),
  ];

  const instructions = renderInstructions(input, guidance, dependencyContexts, skills);

  const approxChars = instructions.join("\n\n").length;
  const tokenEstimate = Math.ceil(approxChars / 4);
  const budget = input.maxChars ?? 8000;

  return {
    role: input.role,
    goal: input.goal,
    task: input.task,
    instructions: fitBudget(instructions, budget),
    files,
    decisions,
    dependencies: dependencyContexts,
    failures: input.failures ?? [],
    skills,
    capabilities,
    grantedCapabilities: input.grantedCapabilities ?? [],
    deniedCapabilities: input.deniedCapabilities ?? [],
    runDecisions: input.runDecisions ?? [],
    tokenEstimate,
  };
}

function toGuidanceRole(role: ContextRole): "planner" | "builder" | "reviewer" | "repair" {
  switch (role) {
    case "discovery":
      return "planner";
    case "planner":
      return "planner";
    case "builder":
      return "builder";
    case "reviewer":
      return "reviewer";
    case "verification":
      return "repair";
    default:
      return "repair";
  }
}

function renderInstructions(
  input: ContextCompileRequest,
  guidance: Awaited<ReturnType<typeof selectConstitutionContext>>,
  dependencies: DependencyContext[],
  skills: SkillContext[],
): string[] {
  const instructions: string[] = [];

  if (input.task) {
    instructions.push(`Task id: ${input.task.id}`);
    instructions.push(`Task stage: ${input.task.stage}`);
    instructions.push(`Task title: ${input.task.title}`);
    if (input.task.dependsOn?.length) {
      instructions.push(`Depends on: ${input.task.dependsOn.join(", ")}`);
    }
  }

  const roleRules = buildRoleRules(input.role);
  if (roleRules) {
    instructions.push(roleRules);
  }

  if (dependencies.length > 0) {
    instructions.push(`Dependency context:\n${dependencies.map((dep) => `- ${dep.taskId} (${dep.stage}): ${dep.title}`).join("\n")}`);
  }

  if (skills.length > 0) {
    instructions.push(`Selected skills:\n${skills.map((skill) => `- ${skill.id}@${skill.version}: ${skill.reasons.slice(0, 2).join("; ")}`).join("\n")}`);
  }

  if (input.failures?.length) {
    instructions.push(`Prior failures:\n${input.failures.map((failure) => `- attempt ${failure.attempt}: ${failure.summary}`).join("\n")}`);
  }

  if (guidance.text) {
    instructions.push(`Project guidance context:\n${guidance.text}`);
  }

  if (input.fileHints?.length) {
    instructions.push(`Likely files: ${input.fileHints.join(", ")}`);
  }

  if (input.grantedCapabilities?.length) {
    instructions.push(`Available capabilities:\n${input.grantedCapabilities.map((capability) => `- ${capability}`).join("\n")}`);
  }
  if (input.deniedCapabilities?.length) {
    instructions.push(`Unavailable capabilities (do not attempt):\n${input.deniedCapabilities.map((capability) => `- ${capability}`).join("\n")}`);
  }

  if (input.runDecisions?.length) {
    instructions.push(`Human decisions (authoritative run facts):\n${input.runDecisions.map((decision) => `- D: ${decision.question} → ${decision.optionId}${decision.feedback ? ` (${decision.feedback})` : ""}`).join("\n")}`);
  }

  return instructions;
}

async function selectRelevantFiles(input: ContextCompileRequest): Promise<ContextFile[]> {
  const files = new Map<string, ContextFile>();
  for (const hint of [...(input.task?.context?.fileHints ?? []), ...(input.fileHints ?? [])]) {
    addContextFile(files, { path: hint, reason: "Declared file hint for this task/role.", relevance: 0.8 });
  }
  for (const dep of input.dependencyTasks ?? []) {
    for (const hint of dep.context?.fileHints ?? []) {
      addContextFile(files, { path: hint, reason: `File hint from dependency task ${dep.id}.`, relevance: 0.6 });
    }
  }
  return [...files.values()];
}

function addContextFile(files: Map<string, ContextFile>, file: ContextFile): void {
  const existing = files.get(file.path);
  if (!existing || file.relevance > existing.relevance) {
    files.set(file.path, file);
  }
}

function fitBudget(sections: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const section of sections) {
    const cost = section.length + (kept.length > 0 ? 2 : 0);
    if (used + cost <= maxChars) {
      kept.push(section);
      used += cost;
      continue;
    }
    const remaining = maxChars - used - (kept.length > 0 ? 2 : 0);
    if (remaining > 80) {
      kept.push(`${section.slice(0, remaining - 3)}...`);
    }
    break;
  }
  return kept;
}

function buildRoleRules(role: ContextRole): string | undefined {
  switch (role) {
    case "discovery":
      return "Role rules:\n- Produce discovery guidance only; do not implement code.\n- Inspect enough repository evidence for planning.\n- Do not broaden scope beyond the requested outcome.";
    case "planner":
      return "Role rules:\n- Produce architecture and execution guidance only; do not implement code.\n- Do not broaden scope beyond the requested outcome.";
    case "builder":
      return "Role rules:\n- Keep changes tightly scoped to the requested task.\n- Use the native Pi tools provided to you; do not print DSML/XML/tool-call markup as text.\n- Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits unless truly necessary for this task.";
    case "reviewer":
      return "Role rules:\n- Focus on acceptance, consistency, risk, and scope control.\n- Flag unrelated edits, scope creep, missing verification, and instruction drift explicitly.";
    case "repair":
      return "Role rules:\n- Focus only on the concrete verification failures.\n- Minimize changes and avoid opportunistic refactors or unrelated doc rewrites.";
    default:
      return undefined;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
