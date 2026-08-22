import type { PlanApprovalDecision, PlanApprovalResult } from "@factory/core";
import type { FactoryPiUi } from "./types.js";

export interface PlanApprovalPreviewInput {
  runId: string;
  goal: string;
  planPath: string;
  taskCount: number;
  workflowStages: string[];
  summary: string;
  tasks: Array<{ title: string; stage: string }>;
}

export function buildPlanApprovalPreviewLines(input: PlanApprovalPreviewInput): string[] {
  const summaryLines = input.summary.split(/\r?\n/).filter(Boolean).slice(0, 8);
  const taskLines = input.tasks.slice(0, 6).map((task) => `- [${task.stage}] ${task.title}`);
  const remainingTasks = Math.max(0, input.taskCount - taskLines.length);

  return [
    "Factory plan approval",
    `Run: ${input.runId}`,
    `Goal: ${input.goal}`,
    `Tasks: ${input.taskCount}`,
    `Stages: ${input.workflowStages.join(" -> ")}`,
    `Plan: ${input.planPath}`,
    "",
    "Decision options",
    "- Approve: continue to implementation",
    "- Request revisions: pause before implementation",
    "- Reject: cancel this run",
    "",
    "Summary",
    ...(summaryLines.length > 0 ? summaryLines : ["(no summary)"]),
    "",
    "Tasks",
    ...(taskLines.length > 0 ? taskLines : ["- (no tasks)"]),
    ...(remainingTasks > 0 ? [`- ... and ${remainingTasks} more`] : []),
  ];
}

export async function requestPlanApprovalDecision(
  ui: FactoryPiUi,
  input: PlanApprovalPreviewInput,
): Promise<PlanApprovalResult> {
  if (ui.select) {
    const selected = await ui.select("Factory plan decision", [
      { label: "Approve", value: "approve", description: "Continue to implementation" },
      { label: "Request revisions", value: "revise", description: "Pause before implementation and record feedback" },
      { label: "Reject", value: "reject", description: "Cancel the run before implementation" },
    ]);

    if (selected === "approve") {
      return { decision: "approve" };
    }

    if (selected === "revise" || selected === "reject") {
      const feedback = await ui.input?.(
        selected === "revise" ? "Revision feedback" : "Rejection feedback",
        "Optional short feedback",
      );
      return { decision: selected, feedback: normalizeFeedback(feedback) };
    }

    return {
      decision: "revise",
      feedback: "Plan decision dismissed; leaving run paused for human follow-up.",
    };
  }

  if (ui.confirm) {
    const approved = await ui.confirm(
      "Approve Factory plan?",
      [
        `Run: ${input.runId}`,
        `Goal: ${input.goal}`,
        `Tasks: ${input.taskCount}`,
        `Stages: ${input.workflowStages.join(" -> ")}`,
        `Plan: ${input.planPath}`,
        "",
        "Approve to continue to implementation.",
        "Reject to cancel this run.",
      ].join("\n"),
    );
    return { decision: approved ? "approve" : "reject" };
  }

  return { decision: "approve" };
}

function normalizeFeedback(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function isPlanApprovalDecision(value: string | undefined): value is PlanApprovalDecision {
  return value === "approve" || value === "reject" || value === "revise";
}
