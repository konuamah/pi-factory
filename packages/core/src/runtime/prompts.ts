// Prompt builders + skill rendering — extracted from controller.ts so the
// runtime controller focuses on orchestration. Pure string builders; no
// controller state.

import type { CompiledContext } from "../context/compiler.js";
import type { AgentExecutionResult } from "./interfaces.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { InterviewDecisionRecord } from "./controller.js";

export function buildCompiledPrompt(goal: string, compiled: CompiledContext, workspacePath?: string): string {
  const sections = [
    `Goal: ${goal}`,
    ...(workspacePath ? [`Working directory: ${workspacePath}`] : []),
    ...compiled.instructions,
    ...(compiled.role === "builder" ? [
      "Before modifying files, prepare the repository environment yourself: inspect README and project configuration, determine whether dependencies are already usable, and install or synchronize them only when needed.",
      "Prefer repository-provided wrappers, lockfiles, and setup instructions. Do not replace lockfiles, upgrade dependencies, use sudo, or install system packages unless explicitly required and approved.",
      "Use the lightest readiness check first, keep setup within the available run budget, and report setup actions and verification results in your final response.",
    ] : []),
    `Role: ${compiled.role}`,
  ];
  return sections.join("\n");
}

export function buildNoChangeRetryPrompt(
  goal: string,
  compiled: CompiledContext,
  previousResult?: AgentExecutionResult,
  workspacePath?: string,
): string {
  const previousOutput = previousResult?.outputText?.trim();
  const previousSummary = previousOutput
    ? `Previous builder output:\n${previousOutput.slice(0, 2000)}`
    : "Previous builder output: (empty)";
  return [
    buildCompiledPrompt(goal, compiled, workspacePath),
    "",
    "Factory implementation retry:",
    "Your previous implementation turn completed without any file changes.",
    previousSummary,
    "",
    "You are still in the Builder role.",
    "All file paths in your tool calls must be under the working directory above.",
    "Do not stop after saying what you will inspect or change.",
    "Use the available native Pi tools now to edit/write the required files in the current workspace.",
    "If implementation is impossible, return a clear failure reason instead of completing successfully.",
  ].join("\n");
}

export function buildBuilderPrompt(
  goal: string,
  task: { id: string; title: string; stage: string; dependsOn: string[] },
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Task id: ${task.id}`,
    `Task stage: ${task.stage}`,
    `Task title: ${task.title}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "Depends on: none",
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Before modifying files, prepare the repository environment yourself: inspect README and project configuration, determine whether dependencies are already usable, and install or synchronize them only when needed.",
    "Prefer repository-provided wrappers, lockfiles, and setup instructions. Do not replace lockfiles, upgrade dependencies, use sudo, or install system packages unless explicitly required and approved.",
    "Use the lightest readiness check first, keep setup within the available run budget, and report setup actions and verification results in your final response.",
    "Implement only the requested task in this repository and leave the workspace ready for verification.",
    "Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits unless truly necessary for this task.",
  ].filter(Boolean).join("\n");
}

export function buildIntegrationRepairPrompt(
  goal: string,
  branch: string,
  conflictingFiles: string[],
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Integration conflict while merging branch: ${branch}`,
    `Conflicting files: ${conflictingFiles.join(", ")}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Resolve the active git merge conflict in the current workspace.",
    "Keep the original task scope, preserve intended changes from both sides when possible, and avoid unrelated edits.",
    "After resolving, leave the workspace with no unresolved merge conflicts.",
  ].filter(Boolean).join("\n");
}

export function buildRepairPrompt(
  goal: string,
  verification: { cwd: string; overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string; stdout?: string; stderr?: string }> },
  constitutionContext?: string,
  skillBundleText?: string,
  generalFix?: string,
): string {
  const failures = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => `${command.name}: ${firstNonEmpty(command.stderr, command.stdout, "failed")}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    `Verification cwd: ${verification.cwd}`,
    failures ? `Failures:\n${failures}` : "Failures: none recorded",
    generalFix ? `General fix direction:\n${generalFix}` : undefined,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Repair the code so verification can pass.",
    "Focus only on the observed failures and avoid unrelated edits.",
    "Aim for the general fix that resolves the root cause across all failing commands, not per-command patches.",
  ].filter(Boolean).join("\n");
}

export function buildEnvironmentPrepPrompt(
  cwd: string,
  failures: Array<{ commandName: string; category: string; reason: string; suggestedAction: string }>,
): string {
  const issues = failures.map((f) => `  - ${f.commandName} (${f.category}): ${f.reason}`).join("\n");
  return [
    `The following verification commands failed because the runtime environment is not prepared:`,
    issues,
    `Working directory: ${cwd}`,
    ``,
    `Do the following in this exact directory:`,
    `1. Inspect the repository to find how dependencies should be prepared for each failing command.`,
    `2. For Python: create a .venv if needed, activate it, and install requirements.`,
    `3. For Node: run npm install if node_modules is missing.`,
    `4. For any other language: use the appropriate package manager and lockfile.`,
    `5. Prefer project-local virtual environments and wrappers.`,
    `6. Do NOT change source code. Do NOT modify config files.`,
    `7. After preparation, run the failing verification command to confirm it passes.`,
  ].join("\n");
}

export function buildReviewerPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string }> },
  constitutionContext?: string,
  skillBundleText?: string,
  interviewDecisions?: InterviewDecisionRecord[],
): string {
  const commandStatuses = verification.commands
    .map((command) => `${command.name}: ${command.status}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    commandStatuses ? `Command results:\n${commandStatuses}` : "Command results: none",
    interviewDecisions?.length
      ? `Human interview decisions (authoritative):\n${interviewDecisions.map((d) => `- ${d.question} → ${d.answer ?? d.optionId}`).join("\n")}`
      : undefined,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Review the candidate and report whether it looks ready for approval.",
    "Call out unrelated edits, scope creep, missing verification, and instruction drift explicitly.",
  ].filter(Boolean).join("\n");
}

export function renderSkillBundleForPrompt(bundle: SkillBundleSelection): string | undefined {
  if (bundle.selected.length === 0) {
    return undefined;
  }
  return bundle.selected
    .map((item) => {
      const header = `## ${item.skill.id}@${item.skill.version}`;
      const reasons = `Selection reasons: ${item.reasons.slice(0, 2).join("; ")}`;
      const description = item.skill.description ? `Description: ${item.skill.description}` : undefined;
      const body = item.skill.body?.trim() ? `Instructions:\n${item.skill.body.trim()}` : undefined;
      return [header, description, reasons, body].filter(Boolean).join("\n");
    })
    .join("\n\n");
}


export function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

