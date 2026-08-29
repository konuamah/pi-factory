// Implementation phase of the run controller — extracted from controller-run.ts.

import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { runImplementationTasks } from "./implementation.js";
import { movePhase, wait, emitProgress, loadRunDecisions } from "./phase-plumbing.js";
import { isExecutableWorkflowNode } from "./task-utils.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, InterviewDecisionRecord } from "./controller.js";
import path from "node:path";
import type { PlannerTask } from "./planner.js";
import type { TaskWorkspaceSelection } from "./controller.js";
import type { ImplementationContract } from "./planner.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";
import type { AutonomyLevel } from "../capabilities/index.js";

export interface ImplementationPhaseState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  projectRoot: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
  phases: string[];
  delayMs: number;
  plan: { tasks: PlannerTask[]; implementationContract?: ImplementationContract };
  planPath: string;
  plannerSkills: SkillBundleSelection;
  builderSkills: SkillBundleSelection;
  reviewerSkills: SkillBundleSelection;
  repairSkills: SkillBundleSelection;
  runTaskType: TaskTypeSelection;
  taskPaths: string[];
  plannerExecutionPath: string | undefined;
  builderExecutionPaths: string[];
  integrationPath: string | undefined;
  repairExecutionPaths: string[];
  discoveryExecutionPath: string | undefined;
  interviewDecisions: InterviewDecisionRecord[];
}

export async function runImplementationPhase(state: ImplementationPhaseState): Promise<RunFactoryControllerResult | { implementationRun: Awaited<ReturnType<typeof runImplementationTasks>>; builderExecutionPaths: string[]; integrationPath: string | undefined }> {
  const {
    run, input, loaded, executionCwd, projectRoot, worktree, phases, delayMs, plan, planPath, taskPaths,
    plannerExecutionPath, builderExecutionPaths, integrationPath, repairExecutionPaths,
    plannerSkills, builderSkills, reviewerSkills, repairSkills, runTaskType, discoveryExecutionPath, interviewDecisions,
  } = state;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "implementation", "Executing task artifacts");

const implementationTasks = plan.tasks.filter((task) => isExecutableWorkflowNode(task));
const implementationRun = await runImplementationTasks({
  runId: run.runId,
  runDir: run.runDir,
  statePath: run.statePath,
  eventsPath: run.eventsPath,
  goal: input.goal,
  executionCwd,
  executionBranch: worktree.branch,
  worktreeLocation: worktree.location ?? loaded.effectiveConfig.git.worktreeDir,
  allowTaskWorktrees: false,
  tasks: implementationTasks,
  maxParallelAgents: 1,
  projectRoot,
  dependencyTasks: plan.tasks,
  planIntent: plan.implementationContract,
  roleExecutors: {
    planner: input.plannerExecutor,
    builder: input.builderExecutor,
    reviewer: input.reviewerExecutor,
    repair: input.repairExecutor,
  },
  roleModels: loaded.effectiveConfig.models,
  roleSkills: {
    planner: plannerSkills,
    builder: builderSkills,
    reviewer: reviewerSkills,
    repair: repairSkills,
  },
  autonomy: loaded.effectiveConfig.defaults.autonomy as AutonomyLevel,
  projectCapabilityPolicy: loaded.effectiveConfig.capabilities,
  workflowCapabilityPolicy: loaded.effectiveConfig.resolvedWorkflow?.capabilityPolicy,
  runTaskType: runTaskType.id,
  runModelOverrides: input.modelOverrides,
  runDecisions: [
    ...(await loadRunDecisions(run.runDir)),
    ...interviewDecisions.map((decision) => ({
      requestId: decision.decisionRequestId,
      question: decision.question,
      optionId: decision.optionId,
      ...(decision.answer ? { feedback: decision.answer } : {}),
    })),
  ],
  config: loaded.effectiveConfig,
  requestDependencyRemediation: input.requestDependencyRemediation,
  onProgress: async (event) => emitProgress(input, event),
  delayMs,
  builderExecutionPaths,
});

if (!implementationRun.ok) {
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason: `implementation task failed: ${implementationRun.failedTask.id}` },
  });
  const failedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: implementationRun.failedPhase },
  });
  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "FAILED",
    phase: failedState.phase,
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

await wait(delayMs);


  return { implementationRun, builderExecutionPaths, integrationPath };
}
