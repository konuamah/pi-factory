import type { SkillContract, SkillExecutionStage } from "@factory/schemas";
import type { PlannerTask } from "../runtime/planner.js";
import { selectConstitutionContext } from "../constitution/context.js";
import { findFactorySkills } from "../skills/registry.js";
import type { SkillSelectionResult } from "../skills/types.js";

export type ContextRole = "discovery" | "planner" | "builder" | "reviewer" | "repair" | "verification" | "landing";

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
  planIntent?: {
    targetFiles?: string[];
    nonGoals?: string[];
    implementationSteps?: string[];
    verificationChecks?: Array<{ name: string; command?: string; reason?: string }>;
    blockers?: string[];
    risks?: Array<{ risk: string; mitigation?: string }>;
  };
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
    case "landing":
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
  return [
    renderTaskSection(input.task),
    renderRoleSection(input.role),
    renderDependenciesSection(dependencies),
    renderFileHintsSection(input.fileHints),
    ...renderPlanIntentSection(input.planIntent),
    renderRunDecisionsSection(input.runDecisions),
    renderSkillsSection(skills),
    ...renderCapabilitiesSection(input.grantedCapabilities, input.deniedCapabilities),
    renderFailuresSection(input.failures),
    renderGuidanceSection(guidance.text),
  ].filter((section): section is string => Boolean(section));
}

function renderTaskSection(task: ContextCompileRequest["task"]): string | undefined {
  if (!task) return undefined;
  const lines = [
    `Task id: ${task.id}`,
    `Task stage: ${task.stage}`,
    `Task title: ${task.title}`,
  ];
  if (task.dependsOn?.length) lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
  return lines.join("\n");
}

function renderRoleSection(role: ContextCompileRequest["role"]): string | undefined {
  return buildRoleRules(role) ?? undefined;
}

function renderDependenciesSection(dependencies: DependencyContext[]): string | undefined {
  if (dependencies.length === 0) return undefined;
  return `Dependency context:\n${dependencies.map((dep) => `- ${dep.taskId} (${dep.stage}): ${dep.title}`).join("\n")}`;
}

function renderSkillsSection(skills: SkillContext[]): string | undefined {
  if (skills.length === 0) return undefined;
  return `Selected skills:\n${skills.map((skill) => `- ${skill.id}@${skill.version}: ${skill.reasons.slice(0, 2).join("; ")}`).join("\n")}`;
}

function renderFailuresSection(failures: ContextCompileRequest["failures"]): string | undefined {
  if (!failures?.length) return undefined;
  return `Prior failures:\n${failures.map((failure) => `- attempt ${failure.attempt}: ${failure.summary}`).join("\n")}`;
}

function renderGuidanceSection(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return `Project guidance context:\n${text}`;
}

function renderFileHintsSection(fileHints: ContextCompileRequest["fileHints"]): string | undefined {
  if (!fileHints?.length) return undefined;
  return `Likely files: ${fileHints.join(", ")}`;
}

function renderPlanIntentSection(planIntent: ContextCompileRequest["planIntent"]): string[] {
  if (!planIntent) return [];
  const { targetFiles, nonGoals, implementationSteps, verificationChecks, blockers, risks } = planIntent;
  const sections: string[] = [
    "Planner handoff (authoritative): use these file targets, ordered steps, and checks as the implementation contract. Do not re-plan or broadly rediscover target files unless a named file is missing or contradicts the handoff.",
  ];
  if (targetFiles?.length) sections.push(`Target files:\n${targetFiles.map((file) => `- ${file}`).join("\n")}`);
  if (implementationSteps?.length) sections.push(`Implementation sequence:\n${implementationSteps.map((step) => `- ${step}`).join("\n")}`);
  if (verificationChecks?.length) {
    sections.push(`Verification contract:\n${verificationChecks.map((check) => {
      const command = check.command ? ` — ${check.command}` : "";
      const reason = check.reason ? ` (${check.reason})` : "";
      return `- ${check.name}${command}${reason}`;
    }).join("\n")}`);
  }
  if (nonGoals?.length) sections.push(`Non-goals (do not do):\n${nonGoals.map((item) => `- ${item}`).join("\n")}`);
  if (risks?.length) sections.push(`Known risks:\n${risks.map((r) => `- ${r.risk}${r.mitigation ? ` (mitigation: ${r.mitigation})` : ""}`).join("\n")}`);
  if (blockers?.length) sections.push(`Blockers:\n${blockers.map((item) => `- ${item}`).join("\n")}`);
  return sections.length > 1 ? sections : [];
}

function renderCapabilitiesSection(granted: ContextCompileRequest["grantedCapabilities"], denied: ContextCompileRequest["deniedCapabilities"]): string[] {
  const sections: string[] = [];
  if (granted?.length) sections.push(`Available capabilities:\n${granted.map((capability) => `- ${capability}`).join("\n")}`);
  if (denied?.length) sections.push(`Unavailable capabilities (do not attempt):\n${denied.map((capability) => `- ${capability}`).join("\n")}`);
  return sections;
}

function renderRunDecisionsSection(runDecisions: ContextCompileRequest["runDecisions"]): string | undefined {
  if (!runDecisions?.length) return undefined;
  return `Human decisions (authoritative run facts):\n${runDecisions.map((decision) => `- D: ${decision.question} → ${decision.optionId}${decision.feedback ? ` (${decision.feedback})` : ""}`).join("\n")}`;
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
      return "Role rules:\n- Treat the Planner handoff as the authoritative implementation contract.\n- Keep changes tightly scoped to the requested task.\n- Use the native Pi tools provided to you; do not print DSML/XML/tool-call markup as text.\n- Do not broadly search, locate, or identify implementation files when the handoff names concrete target files.\n- Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits unless truly necessary for this task.";
    case "reviewer":
      return "Role rules:\n- Focus on acceptance, consistency, risk, and scope control.\n- Flag unrelated edits, scope creep, missing verification, and instruction drift explicitly.";
    case "landing":
      return "Role rules:\n- Decide whether the candidate is safe to land and which landing strategy is appropriate.\n- Prefer explicit risk reasoning, preserve user work, and block loudly when landing is unsafe or ambiguous.";
    case "repair":
      return "Role rules:\n- Focus only on the concrete verification failures.\n- Minimize changes and avoid opportunistic refactors or unrelated doc rewrites.";
    default:
      return undefined;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
