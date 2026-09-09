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
import { requestRuntimePolicy } from "./policy.js";

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

export async function runPlanApprovalPhase(state: PlanApprovalPhaseState): Promise<RunFactoryControllerResult | { decision: "revise"; feedback?: string } | undefined> {
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

if (input.policyExecutor) {
  const decision = await requestRuntimePolicy({
    controllerInput: input, runDir: run.runDir, statePath: run.statePath, eventsPath: run.eventsPath, runId: run.runId,
    context: {
      runId: run.runId, goal: input.goal, currentPhase: "plan-approval",
      evidence: { planPath, taskCount: plan.tasks.length, workflowStages: plan.workflowStages?.map((stage) => stage.name) ?? [], summary: plan.summary },
      attempt: 0, maxAttempts: input.policy?.maxAttempts ?? 3, allowedNextPhases: [],
      constraints: { retryable: true, repairEnabled: false, hasRepairExecutor: false, completedTasksRerunnable: true },
    },
  });
  await appendFactoryRunEvent(run.eventsPath, { timestamp: new Date().toISOString(), type: decision.action === "continue" ? "plan.approved" : decision.action === "revise" ? "plan.revision_requested" : "plan.rejected", data: { goal: input.goal, planPath, feedback: decision.feedback } });
  if (decision.action === "continue") return undefined;
  if (decision.action === "revise") return { decision: "revise", feedback: decision.feedback };
  const nextPhase = "plan-approval-rejected";
  await updateFactoryRunState({ statePath: run.statePath, patch: { status: "CANCELLED", phase: nextPhase } });
  return buildRunFailureResult({ run, executionCwd, worktree, phases, planPath, taskPaths, discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, integrationPath, repairExecutionPaths, verificationPath: path.join(run.runDir, "verification.json"), summaryPath: await writePrototypeSummaryArtifact(run.runDir, { runId: run.runId, goal: input.goal, status: "CANCELLED", phase: nextPhase, approved: false, planPath, taskPaths, discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, integrationPath, repairExecutionPaths, verificationPath: path.join(run.runDir, "verification.json"), verificationStatus: "incomplete" }) });
}

if (!input.requestPlanApproval) {
  // No approval handler configured: fail loud instead of silently approving
  // the plan (a real deployment must not auto-approve without a gate).
  const unavailableState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "plan-approval-unavailable" },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason: "No plan approval handler configured; refusing to auto-approve", phase: "plan-approval-unavailable" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "plan-approval-unavailable",
    status: "FAILED",
    message: "No plan approval handler configured; refusing to auto-approve",
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: "plan-approval-unavailable",
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
    recoveryHint: "No plan approval handler configured; refusing to auto-approve",
  });
  return buildRunFailureResult({
    run,
    executionCwd,
    worktree,
    phases,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath: path.join(run.runDir, "verification.json"),
    summaryPath,
  });
}

const planApproval = await input.requestPlanApproval({
  runId: run.runId,
  goal: input.goal,
  planPath,
  taskCount: plan.tasks.length,
  workflowStages: plan.workflowStages!.map((stage) => stage.name),
  summary: plan.summary,
  discoveryText: discoveryOutputText,
  planText: plan.planText,
  tasks: plan.tasks,
});
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
  if (!rejected) {
    // Revise: return the feedback so the caller can re-run planning with it
    // (bounded loop). The run is not over — it continues to a replan.
    return { decision: "revise" as const, feedback: planApproval.feedback };
  }
  const nextPhase = "plan-approval-rejected";
  const nextStatus = "CANCELLED";
  const nextMessage = "Run stopped: plan approval rejected";
  const stoppedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: nextStatus, phase: nextPhase },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: nextPhase,
    status: nextStatus,
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
