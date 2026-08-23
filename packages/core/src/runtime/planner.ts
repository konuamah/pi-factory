import type { EffectiveFactoryConfig, WorkflowNodeType, WorkflowStage } from "@factory/schemas";

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
}

export interface PlannerArtifact {
  goal: string;
  summary: string;
  planText?: string;
  workflowStages: Array<{
    name: string;
    dependsOn: string[];
    type?: WorkflowNodeType;
    role?: string;
    commands?: string[];
    requiresApproval?: boolean;
  }>;
  tasks: PlannerTask[];
}

export function buildPlanArtifact(input: {
  goal: string;
  config: EffectiveFactoryConfig;
  planText?: string;
}): PlannerArtifact {
  const workflowStages = normalizeWorkflowStages(input.config.resolvedWorkflow?.stages ?? []);

  const tasks = workflowStages.map((stage, index) => ({
    id: `task-${index + 1}`,
    title: buildTaskTitle(stage.name, input.goal),
    stage: stage.name,
    status: stage.name === "planning" || stage.name === "plan" ? "done" as const : "pending" as const,
    dependsOn: stage.dependsOn,
    type: stage.type,
    role: stage.role,
    commands: stage.commands,
    requiresApproval: stage.requiresApproval,
  }));

  return {
    goal: input.goal,
    summary: buildSummary(input.goal, input.config, workflowStages),
    planText: input.planText,
    workflowStages,
    tasks,
  };
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
  }));
}

function buildTaskTitle(stageName: string, goal: string): string {
  switch (stageName) {
    case "plan":
    case "planning":
      return `Plan work for: ${goal}`;
    case "build":
    case "implementation":
      return `Implement changes for: ${goal}`;
    case "verify":
    case "verification":
      return `Verify changes for: ${goal}`;
    case "approval":
    case "approval-ready":
      return `Prepare approval package for: ${goal}`;
    case "merge":
      return `Merge approved changes for: ${goal}`;
    default:
      return `${capitalize(stageName)} for: ${goal}`;
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
