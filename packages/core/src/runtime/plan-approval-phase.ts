// Plan-approval phase of the run controller — extracted from controller-run.ts.

import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { movePhase, wait, emitProgress } from "./phase-plumbing.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { buildRunFailureResult } from "./controller-helpers.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { PlannerArtifact } from "./planner.js";
import { runImplementationTasks } from "./implementation.js";
import path from "node:path";

export interface PlanApprovalPhaseState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
  phases: string[];
  delayMs: number;
  plan: PlannerArtifact;
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath: string | undefined;
  plannerExecutionPath: string | undefined;
  builderExecutionPaths: string[];
  repairExecutionPaths: string[];
  discoveryOutputText: string | undefined;
  integrationPath: string | undefined;
}

export async function runPlanApprovalPhase(state: PlanApprovalPhaseState): Promise<RunFactoryControllerResult | undefined> {
  const {
    run, input, loaded, executionCwd, worktree, phases, delayMs, plan, planPath, taskPaths,
    discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, repairExecutionPaths, discoveryOutputText, integrationPath,
  } = state;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "plan-approval", "Plan ready for human approval");
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type: "plan.approval_required",
  data: {
    planPath,
    taskCount: plan.tasks.length,
    workflowStages: plan.workflowStages!.map((stage) => stage.name),
  },
});
await emitProgress(input, {
  runId: run.runId,
  phase: "plan-approval",
  status: "RUNNING",
  message: "Waiting for human plan approval",
});

const planApproval = (await input.requestPlanApproval?.({
  runId: run.runId,
  goal: input.goal,
  planPath,
  taskCount: plan.tasks.length,
  workflowStages: plan.workflowStages!.map((stage) => stage.name),
  summary: plan.summary,
  discoveryText: discoveryOutputText,
  planText: plan.planText,
  tasks: plan.tasks,
})) ?? { decision: "approve" as const };
await appendFactoryRunEvent(run.eventsPath, {
  timestamp: new Date().toISOString(),
  type:
    planApproval.decision === "approve"
      ? "plan.approved"
      : planApproval.decision === "revise"
        ? "plan.revision_requested"
        : "plan.rejected",
  data: { goal: input.goal, planPath, feedback: planApproval.feedback },
});

if (planApproval.decision !== "approve") {
  const rejected = planApproval.decision === "reject";
  const nextPhase = rejected ? "plan-approval-rejected" : "plan-revision-requested";
  const nextStatus = rejected ? "CANCELLED" : "PENDING";
  const nextMessage = rejected ? "Run stopped: plan approval rejected" : "Run paused: plan revisions requested";
  const stoppedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: nextStatus, phase: nextPhase },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: nextPhase,
    status: rejected ? "CANCELLED" : "PENDING",
    message: nextMessage,
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: nextStatus,
    phase: stoppedState.phase,
    approved: false,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    verificationStatus: "incomplete",
  });

  return {
    runId: run.runId,
    runDir: run.runDir,
    executionCwd,
    worktree,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: false,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    summaryPath,
  };
}

let implementationRun: Awaited<ReturnType<typeof runImplementationTasks>>;

  return undefined;
}
