// Small task/workspace utilities — extracted from controller.ts.

import type { TaskWorkspaceSelection } from "./controller.js";
import type { ModelRole, WorkflowStage } from "@factory/schemas";
import type { PlannerTask } from "./planner.js";

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function taskWorkspacesChangedFiles(workspaces: TaskWorkspaceSelection[]): string[] {
  return workspaces.flatMap((workspace) => workspace.changedFiles ?? []);
}

export function isBuildStage(stage: string): boolean {
  const normalized = stage.toLowerCase();
  return normalized === "build" || normalized === "implementation";
}

export function roleTools(role: ModelRole): string[] {
  if (role === "builder" || role === "repair") {
    return ["read", "write", "edit", "bash", "grep", "find", "ls"];
  }
  return ["read", "grep", "find", "ls"];
}

export function isExecutableWorkflowNode(task: PlannerTask): boolean {
  // Built-in phases are handled by dedicated controller code, regardless of
  // whether the workflow node is typed as an agent or command.
  const normalized = task.stage.toLowerCase();
  if (RESERVED_PHASE_STAGES.has(normalized)) {
    return false;
  }
  const type = task.type;
  if (type === "interview") {
    return false;
  }
  if (type === "command" || type === "task-graph") {
    return true;
  }
  if (type === "acceptance") {
    return false;
  }
  return true;
}

const RESERVED_PHASE_STAGES = new Set([
  "discover",
  "discovery",
  "interview",
  "plan",
  "planning",
  "verify",
  "verification",
  "review",
  "approval",
  "acceptance",
  "landing",
]);


export function findBuiltInWorkflowStage(stages: WorkflowStage[], names: string[]): WorkflowStage | undefined {
  const normalized = new Set(names.map((name) => name.toLowerCase()));
  return stages.find((stage) => normalized.has(stage.name.toLowerCase()));
}

export function classifyInterviewExecutionPoint(
  stage: WorkflowStage,
  allStages: WorkflowStage[],
): "pre-planning" | "post-verification" {
  const byName = new Map(allStages.map((candidate) => [candidate.name, candidate]));
  const seen = new Set<string>();
  const reachesVerification = (name: string): boolean => {
    if (name === "verify" || name === "verification") return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (byName.get(name)?.dependsOn ?? []).some(reachesVerification);
  };
  return (stage.dependsOn ?? []).some(reachesVerification) ? "post-verification" : "pre-planning";
}

export function orderWorkflowStages(stages: WorkflowStage[]): WorkflowStage[] {
  const byName = new Map(stages.map((stage) => [stage.name, stage]));
  const remaining = new Map(stages.map((stage) => [stage.name, new Set(stage.dependsOn ?? [])]));
  const ordered: WorkflowStage[] = [];
  while (remaining.size > 0) {
    const ready = stages.filter((stage) => remaining.has(stage.name) && [...(remaining.get(stage.name) ?? [])].every((dep) => !remaining.has(dep)));
    if (ready.length === 0) return stages;
    for (const stage of ready) {
      ordered.push(byName.get(stage.name)!);
      remaining.delete(stage.name);
    }
  }
  return ordered;
}
