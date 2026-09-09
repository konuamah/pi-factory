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
