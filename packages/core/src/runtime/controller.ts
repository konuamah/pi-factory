import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEffectiveConfig } from "../config/loader.js";
import { selectConstitutionContext } from "../constitution/context.js";
import { createGitWorktree, createSiblingGitWorktree, inspectGitIsolation } from "../git/worktree.js";
import { appendFactoryRunEvent, createFactoryRun, updateFactoryRunState } from "../runs/store.js";
import {
  writePrototypeBuilderExecutionArtifact,
  writePrototypeFinalMergeArtifact,
  writePrototypeIntegrationArtifact,
  writePrototypePlanArtifact,
  writePrototypePlannerExecutionArtifact,
  writePrototypeRepairExecutionArtifact,
  writePrototypeReviewerExecutionArtifact,
  writePrototypeSummaryArtifact,
  writePrototypeTaskArtifacts,
  writePrototypeVerificationArtifact,
} from "./artifacts.js";
import type { AgentExecutor } from "./interfaces.js";
import { buildPlanArtifact, type PlannerTask } from "./planner.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { runVerificationCommands } from "./verification.js";

export interface FactoryRunProgressEvent {
  runId: string;
  phase: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  message: string;
}

export interface RunFactoryControllerInput {
  cwd: string;
  goal: string;
  branchName?: string;
  plannerExecutor?: AgentExecutor;
  builderExecutor?: AgentExecutor;
  repairExecutor?: AgentExecutor;
  reviewerExecutor?: AgentExecutor;
  onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
  requestApproval?: (input: { runId: string; goal: string; candidateSha?: string }) => Promise<boolean>;
  delayMs?: number;
}

const execFileAsync = promisify(execFile);

export interface RunFactoryControllerResult {
  runId: string;
  runDir: string;
  executionCwd: string;
  worktree?: {
    mode: "existing" | "created" | "in-place";
    path: string;
    branch?: string;
    reason?: string;
    location?: string;
  };
  statePath: string;
  eventsPath: string;
  phases: string[];
  approved: boolean;
  planPath: string;
  taskPaths: string[];
  plannerExecutionPath?: string;
  builderExecutionPaths: string[];
  integrationPath?: string;
  finalMergePath?: string;
  candidateSha?: string;
  repairExecutionPaths: string[];
  reviewerExecutionPath?: string;
  verificationPath: string;
  summaryPath: string;
}

export async function runFactoryController(
  input: RunFactoryControllerInput,
): Promise<RunFactoryControllerResult> {
  const loaded = await loadEffectiveConfig({ cwd: input.cwd });
  const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
  const projectRoot = path.dirname(root);
  const isolation = await inspectGitIsolation(input.cwd);
  const worktree = loaded.effectiveConfig.git.allowWorktrees
    ? await createGitWorktree({
        cwd: input.cwd,
        branchName: input.branchName ?? `${slugifyGoal(input.goal)}-${Date.now()}`,
        baseBranch: loaded.effectiveConfig.git.baseBranch,
        preferredLocation: loaded.effectiveConfig.git.worktreeDir,
      })
    : {
        mode: "in-place" as const,
        path: input.cwd,
        branch: isolation.branch,
        reason: "Project config disables worktrees",
      };
  const executionCwd = worktree.path;

  const run = await createFactoryRun({
    runsDir: path.join(projectRoot, ".factory", "runs"),
    initialPhase: "planning",
    effectiveConfig: loaded.effectiveConfig,
  });

  const phases = ["planning", "implementation", "integration", "verification", "review", "approval-ready", "merge", "complete"];
  const delayMs = input.delayMs ?? 150;
  const builderExecutionPaths: string[] = [];
  let integrationPath: string | undefined;
  let finalMergePath: string | undefined;
  let candidateSha: string | undefined;
  const repairExecutionPaths: string[] = [];

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.goal_received",
    data: { goal: input.goal },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.workspace_selected",
    data: {
      mode: worktree.mode,
      path: worktree.path,
      branch: worktree.branch,
      reason: worktree.reason,
      location: worktree.location,
    },
  });

  await emitProgress(input, {
    runId: run.runId,
    phase: "planning",
    status: "RUNNING",
    message: `Starting run for: ${input.goal}`,
  });

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "planning", "Building plan");

  const plannerConstitutionContext = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal });
  const builderConstitutionContext = await selectConstitutionContext({ cwd: projectRoot, role: "builder", goal: input.goal });
  const repairConstitutionContext = await selectConstitutionContext({ cwd: projectRoot, role: "repair", goal: input.goal });
  const reviewerConstitutionContext = await selectConstitutionContext({ cwd: projectRoot, role: "reviewer", goal: input.goal });

  let plannerExecutionPath: string | undefined;
  if (input.plannerExecutor) {
    const plannerResult = await input.plannerExecutor.execute({
      executionId: `${run.runId}-planner`,
      cwd: executionCwd,
      prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig, plannerConstitutionContext),
      model: loaded.effectiveConfig.models.planner,
      tools: ["read", "grep", "find", "ls"],
      metadata: {
        role: "planner",
        runId: run.runId,
      },
    });
    plannerExecutionPath = await writePrototypePlannerExecutionArtifact(run.runDir, plannerResult);
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "planning.executor_completed",
      data: {
        plannerExecutionPath,
        plannerStatus: plannerResult.status,
      },
    });
  }

  const plan = buildPlanArtifact({
    goal: input.goal,
    config: loaded.effectiveConfig,
  });
  const planPath = await writePrototypePlanArtifact(run.runDir, plan);
  const taskPaths = await writePrototypeTaskArtifacts(
    run.runDir,
    plan.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      stage: task.stage,
      status: task.status,
      dependsOn: task.dependsOn,
      workspacePath: task.id === "task-1" ? executionCwd : undefined,
      workspaceMode: task.id === "task-1" ? worktree.mode : undefined,
      workspaceBranch: task.id === "task-1" ? worktree.branch : undefined,
    })),
  );
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "planning.artifact_written",
    data: {
      planPath,
      taskCount: plan.tasks.length,
      workflowStages: plan.workflowStages.map((stage) => stage.name),
      tasksDir: taskPaths.length > 0 ? path.dirname(taskPaths[0]!) : undefined,
      plannerExecutionPath,
    },
  });
  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "implementation", "Executing task artifacts");

  const implementationTasks = plan.tasks.filter((task) => isImplementationTaskStage(task.stage));
  const implementationRun = await runImplementationTasks({
    runId: run.runId,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    goal: input.goal,
    executionCwd,
    executionBranch: worktree.branch,
    worktreeLocation: worktree.location ?? loaded.effectiveConfig.git.worktreeDir,
    allowTaskWorktrees: loaded.effectiveConfig.git.allowWorktrees,
    tasks: implementationTasks,
    maxParallelAgents: loaded.effectiveConfig.runtime.maxParallelAgents,
    builderExecutor: input.builderExecutor,
    builderModel: loaded.effectiveConfig.models.builder,
    builderConstitutionContext,
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
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      verificationPath: path.join(run.runDir, "verification.json"),
      summaryPath,
    };
  }

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "integration", "Integrating isolated task workspaces");
  integrationPath = await runIntegrationPhase({
    runDir: run.runDir,
    eventsPath: run.eventsPath,
    executionCwd,
    taskWorkspaces: implementationRun.taskWorkspaces,
  });

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "verification", "Running configured verification commands");
  let verification = await runVerificationCommands({
    cwd: executionCwd,
    commands: loaded.effectiveConfig.commands,
  });
  let verificationPath = await writePrototypeVerificationArtifact(run.runDir, verification);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.commands_detected",
    data: loaded.effectiveConfig.commands,
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.completed",
    data: { overallStatus: verification.overallStatus },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.artifact_written",
    data: { verificationPath },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "verification",
    status: verification.overallStatus === "failed" ? "FAILED" : "RUNNING",
    message: `Verification ${verification.overallStatus}`,
  });

  if (verification.overallStatus === "failed" && input.repairExecutor && loaded.effectiveConfig.repair.enabled) {
    for (let attempt = 1; attempt <= loaded.effectiveConfig.repair.maxAttempts; attempt++) {
      await emitProgress(input, {
        runId: run.runId,
        phase: "repair",
        status: "RUNNING",
        message: `Repair attempt ${attempt}`,
      });
      const repairResult = await input.repairExecutor.execute({
        executionId: `${run.runId}-repair-${attempt}`,
        cwd: executionCwd,
        prompt: buildRepairPrompt(input.goal, verification, repairConstitutionContext),
        model: loaded.effectiveConfig.models.repair,
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        metadata: {
          role: "repair",
          runId: run.runId,
          attempt,
        },
      });
      const repairExecutionPath = await writePrototypeRepairExecutionArtifact(run.runDir, {
        attempt,
        ...repairResult,
      });
      repairExecutionPaths.push(repairExecutionPath);
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "repair.attempt_completed",
        data: {
          attempt,
          repairExecutionPath,
          repairStatus: repairResult.status,
        },
      });

      verification = await runVerificationCommands({
        cwd: executionCwd,
        commands: loaded.effectiveConfig.commands,
      });
      verificationPath = await writePrototypeVerificationArtifact(run.runDir, verification);
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "verification.recheck_completed",
        data: {
          attempt,
          overallStatus: verification.overallStatus,
          verificationPath,
        },
      });

      if (verification.overallStatus !== "failed") {
        break;
      }
    }
  }

  let reviewerExecutionPath: string | undefined;

  if (verification.overallStatus === "failed") {
    const failedState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "verification-failed" },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.failed",
      data: { reason: "verification failed" },
    });
    const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
      runId: run.runId,
      goal: input.goal,
      status: "FAILED",
      phase: failedState.phase,
      approved: false,
      planPath,
      taskPaths,
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      verificationStatus: verification.overallStatus,
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
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      summaryPath,
    };
  }

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "review", "Reviewing verified candidate");
  if (input.reviewerExecutor) {
    const reviewerResult = await input.reviewerExecutor.execute({
      executionId: `${run.runId}-reviewer`,
      cwd: executionCwd,
      prompt: buildReviewerPrompt(input.goal, verification, reviewerConstitutionContext),
      model: loaded.effectiveConfig.models.reviewer,
      tools: ["read", "grep", "find", "ls"],
      metadata: {
        role: "reviewer",
        runId: run.runId,
      },
    });
    reviewerExecutionPath = await writePrototypeReviewerExecutionArtifact(run.runDir, reviewerResult);
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "review.completed",
      data: {
        reviewerExecutionPath,
        reviewerStatus: reviewerResult.status,
      },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "review",
      status: reviewerResult.status === "failed" ? "FAILED" : "RUNNING",
      message: `Reviewer ${reviewerResult.status}`,
    });

    if (reviewerResult.status === "failed") {
      const failedState = await updateFactoryRunState({
        statePath: run.statePath,
        patch: { status: "FAILED", phase: "review-failed" },
      });
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "run.failed",
        data: { reason: "review failed" },
      });
      const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
        runId: run.runId,
        goal: input.goal,
        status: "FAILED",
        phase: failedState.phase,
        approved: false,
        planPath,
        taskPaths,
        plannerExecutionPath,
        builderExecutionPaths,
        integrationPath,
        repairExecutionPaths,
        reviewerExecutionPath,
        verificationPath,
        verificationStatus: verification.overallStatus,
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
        plannerExecutionPath,
        builderExecutionPaths,
        integrationPath,
        repairExecutionPaths,
        reviewerExecutionPath,
        verificationPath,
        summaryPath,
      };
    }
  }

  await wait(delayMs);

  candidateSha = await readGitHeadSha(executionCwd);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "approval-ready", "Candidate ready for approval");
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "approval.required",
    data: {
      finalMerge: loaded.effectiveConfig.approval.finalMerge,
      candidateSha,
      candidateBranch: worktree.branch,
    },
  });

  await emitProgress(input, {
    runId: run.runId,
    phase: "approval-ready",
    status: "RUNNING",
    message: "Waiting for human approval",
  });

  const approved = (await input.requestApproval?.({ runId: run.runId, goal: input.goal, candidateSha })) ?? true;
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: approved ? "approval.approved" : "approval.rejected",
    data: { goal: input.goal, candidateSha },
  });

  if (!approved) {
    const cancelledState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "CANCELLED", phase: "approval-rejected" },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "approval-rejected",
      status: "CANCELLED",
      message: "Run stopped: approval rejected",
    });
    const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
      runId: run.runId,
      goal: input.goal,
      status: "CANCELLED",
      phase: cancelledState.phase,
      approved: false,
      candidateSha,
      planPath,
      taskPaths,
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      finalMergePath,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      verificationStatus: verification.overallStatus,
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
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      finalMergePath,
      candidateSha,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      summaryPath,
    };
  }

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "merge", "Finalizing approved candidate");
  finalMergePath = await runFinalMergePhase({
    runDir: run.runDir,
    eventsPath: run.eventsPath,
    mergeCwd: input.cwd,
    candidateBranch: worktree.branch,
    candidateSha,
    baseBranch: loaded.effectiveConfig.git.baseBranch,
    finalMergePolicy: loaded.effectiveConfig.approval.finalMerge,
    worktreeMode: worktree.mode,
  });

  await wait(delayMs);

  const completedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "COMPLETED", phase: "complete" },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.completed",
    data: { goal: input.goal },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "complete",
    status: "COMPLETED",
    message: "Prototype controller run completed",
  });

  const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
    runId: run.runId,
    goal: input.goal,
    status: "COMPLETED",
    phase: completedState.phase,
    approved: true,
    candidateSha,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    finalMergePath,
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    verificationStatus: verification.overallStatus,
  });

  return {
    runId: run.runId,
    runDir: run.runDir,
    executionCwd,
    worktree,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: true,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    finalMergePath,
    candidateSha,
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  };
}

interface TaskWorkspaceSelection {
  taskId: string;
  path: string;
  mode: "existing" | "created" | "in-place";
  branch?: string;
  shouldIntegrate: boolean;
}

async function runImplementationTasks(input: {
  runId: string;
  runDir: string;
  statePath: string;
  eventsPath: string;
  goal: string;
  executionCwd: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
  tasks: PlannerTask[];
  maxParallelAgents: number;
  builderExecutor?: AgentExecutor;
  builderModel?: { provider?: string; model: string };
  builderConstitutionContext?: string;
  onProgress: (event: FactoryRunProgressEvent) => Promise<void>;
  delayMs: number;
  builderExecutionPaths: string[];
}): Promise<
  | { ok: true; taskWorkspaces: TaskWorkspaceSelection[] }
  | { ok: false; failedTask: PlannerTask; failedPhase: string; taskWorkspaces: TaskWorkspaceSelection[] }
> {
  if (input.tasks.length === 0) {
    return { ok: true, taskWorkspaces: [] };
  }

  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const dependencyMap = resolveTaskDependencies(input.tasks);
  const completed = new Set<string>(
    input.tasks.filter((task) => task.status === "done").map((task) => task.id),
  );
  const pending = new Set<string>(
    input.tasks.filter((task) => task.status !== "done").map((task) => task.id),
  );
  const parallelism = Math.max(1, input.maxParallelAgents || 1);
  const taskWorkspaces: TaskWorkspaceSelection[] = [];

  while (pending.size > 0) {
    const runnable = Array.from(pending)
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is PlannerTask => Boolean(task))
      .filter((task) => dependencyMap.get(task.id)?.every((dependencyId) => completed.has(dependencyId)) ?? true);

    if (runnable.length === 0) {
      const blockedTasks = Array.from(pending)
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is PlannerTask => Boolean(task));
      const blockedTask = blockedTasks[0] ?? input.tasks[0]!;
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "implementation.blocked",
        data: {
          blockedTaskIds: blockedTasks.map((task) => task.id),
          completedTaskIds: Array.from(completed),
        },
      });
      return { ok: false, failedTask: blockedTask, failedPhase: "implementation-blocked", taskWorkspaces };
    }

    const batch = runnable.slice(0, parallelism);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "implementation.batch_started",
      data: {
        taskIds: batch.map((task) => task.id),
        parallelism,
      },
    });

    const results = await Promise.all(
      batch.map((task) =>
        runImplementationTask({
          runId: input.runId,
          runDir: input.runDir,
          eventsPath: input.eventsPath,
          goal: input.goal,
          executionCwd: input.executionCwd,
          executionBranch: input.executionBranch,
          worktreeLocation: input.worktreeLocation,
          allowTaskWorktrees: input.allowTaskWorktrees,
          task,
          builderExecutor: input.builderExecutor,
          builderModel: input.builderModel,
          builderConstitutionContext: input.builderConstitutionContext,
          onProgress: input.onProgress,
          delayMs: input.delayMs,
          builderExecutionPaths: input.builderExecutionPaths,
        }),
      ),
    );

    for (const result of results) {
      pending.delete(result.task.id);
      taskWorkspaces.push(result.workspace);
      if (result.ok) {
        completed.add(result.task.id);
        continue;
      }
      return { ok: false, failedTask: result.task, failedPhase: "implementation-failed", taskWorkspaces };
    }
  }

  return { ok: true, taskWorkspaces };
}

async function runImplementationTask(input: {
  runId: string;
  runDir: string;
  eventsPath: string;
  goal: string;
  executionCwd: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
  task: PlannerTask;
  builderExecutor?: AgentExecutor;
  builderModel?: { provider?: string; model: string };
  builderConstitutionContext?: string;
  onProgress: (event: FactoryRunProgressEvent) => Promise<void>;
  delayMs: number;
  builderExecutionPaths: string[];
}): Promise<
  | { ok: true; task: PlannerTask; workspace: TaskWorkspaceSelection }
  | { ok: false; task: PlannerTask; workspace: TaskWorkspaceSelection }
> {
  const workspace = await resolveTaskWorkspace({
    cwd: input.executionCwd,
    taskId: input.task.id,
    executionBranch: input.executionBranch,
    worktreeLocation: input.worktreeLocation,
    allowTaskWorktrees: input.allowTaskWorktrees,
  });

  await updatePrototypeTaskArtifact({
    runDir: input.runDir,
    taskId: input.task.id,
    patch: {
      status: "running",
      workspacePath: workspace.path,
      workspaceMode: workspace.mode,
      workspaceBranch: workspace.branch,
    },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.started",
    data: {
      taskId: input.task.id,
      stage: input.task.stage,
      title: input.task.title,
      workspacePath: workspace.path,
      workspaceMode: workspace.mode,
      workspaceBranch: workspace.branch,
    },
  });
  await input.onProgress({
    runId: input.runId,
    phase: "implementation",
    status: "RUNNING",
    message: `Running task ${input.task.id}: ${input.task.title}`,
  });

  if (input.builderExecutor) {
    const builderResult = await input.builderExecutor.execute({
      executionId: `${input.runId}-builder-${input.task.id}`,
      cwd: workspace.path,
      prompt: buildBuilderPrompt(input.goal, input.task, input.builderConstitutionContext),
      model: input.builderModel,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      metadata: {
        role: "builder",
        runId: input.runId,
        taskId: input.task.id,
        taskStage: input.task.stage,
        workspacePath: workspace.path,
        workspaceBranch: workspace.branch,
      },
    });

    if (builderResult.status === "completed") {
      await commitWorkspaceChanges(workspace.path, input.task);
    }

    const builderExecutionPath = await writePrototypeBuilderExecutionArtifact(input.runDir, {
      taskId: input.task.id,
      workspacePath: workspace.path,
      workspaceBranch: workspace.branch,
      ...builderResult,
    });
    input.builderExecutionPaths.push(builderExecutionPath);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "task.executor_completed",
      data: {
        taskId: input.task.id,
        taskStage: input.task.stage,
        builderExecutionPath,
        builderStatus: builderResult.status,
        workspacePath: workspace.path,
        workspaceBranch: workspace.branch,
      },
    });

    if (builderResult.status !== "completed") {
      await updatePrototypeTaskArtifact({
        runDir: input.runDir,
        taskId: input.task.id,
        patch: { status: "failed" },
      });
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.failed",
        data: {
          taskId: input.task.id,
          stage: input.task.stage,
          title: input.task.title,
          builderExecutionPath,
          builderStatus: builderResult.status,
          workspacePath: workspace.path,
          workspaceBranch: workspace.branch,
        },
      });
      return { ok: false, task: input.task, workspace };
    }
  } else {
    await wait(input.delayMs);
  }

  await updatePrototypeTaskArtifact({
    runDir: input.runDir,
    taskId: input.task.id,
    patch: { status: "done" },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.completed",
    data: {
      taskId: input.task.id,
      stage: input.task.stage,
      title: input.task.title,
      workspacePath: workspace.path,
      workspaceBranch: workspace.branch,
    },
  });
  return { ok: true, task: input.task, workspace };
}

async function runIntegrationPhase(input: {
  runDir: string;
  eventsPath: string;
  executionCwd: string;
  taskWorkspaces: TaskWorkspaceSelection[];
}): Promise<string | undefined> {
  const mergedBranches: Array<{
    taskId: string;
    branch?: string;
    workspacePath: string;
    status: "merged" | "skipped";
    reason?: string;
  }> = [];

  for (const workspace of input.taskWorkspaces) {
    if (!workspace.shouldIntegrate || !workspace.branch) {
      mergedBranches.push({
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
        status: "skipped",
        reason: "Task executed in primary workspace",
      });
      continue;
    }

    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "integration.merge_started",
      data: {
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
      },
    });

    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", workspace.branch], {
      cwd: input.executionCwd,
      windowsHide: true,
    });

    mergedBranches.push({
      taskId: workspace.taskId,
      branch: workspace.branch,
      workspacePath: workspace.path,
      status: "merged",
    });
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.completed",
    data: {
      mergedBranches,
    },
  });

  return writePrototypeIntegrationArtifact(input.runDir, {
    executionCwd: input.executionCwd,
    mergedBranches,
  });
}

async function resolveTaskWorkspace(input: {
  cwd: string;
  taskId: string;
  executionBranch?: string;
  worktreeLocation?: string;
  allowTaskWorktrees: boolean;
}): Promise<TaskWorkspaceSelection> {
  if (!input.allowTaskWorktrees) {
    return {
      taskId: input.taskId,
      path: input.cwd,
      mode: "in-place",
      branch: input.executionBranch,
      shouldIntegrate: false,
    };
  }

  const workspace = await createSiblingGitWorktree({
    cwd: input.cwd,
    branchName: `${input.executionBranch ?? "factory"}-${input.taskId}`,
    baseRef: input.executionBranch,
    preferredLocation: input.worktreeLocation,
  });

  return {
    taskId: input.taskId,
    path: workspace.path,
    mode: workspace.mode,
    branch: workspace.branch,
    shouldIntegrate: workspace.path !== input.cwd && Boolean(workspace.branch),
  };
}

async function commitWorkspaceChanges(cwd: string, task: PlannerTask): Promise<void> {
  try {
    await execFileAsync("git", ["add", "-A"], { cwd, windowsHide: true });
    await execFileAsync("git", ["commit", "--allow-empty", "-m", `Factory task ${task.id}: ${task.title}`], {
      cwd,
      windowsHide: true,
    });
  } catch {
    // Ignore non-git or no-op commit failures in prototype mode.
  }
}

async function readGitHeadSha(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true });
    const value = stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function runFinalMergePhase(input: {
  runDir: string;
  eventsPath: string;
  mergeCwd: string;
  candidateBranch?: string;
  candidateSha?: string;
  baseBranch: string;
  finalMergePolicy: "required" | "not-required";
  worktreeMode: "existing" | "created" | "in-place";
}): Promise<string | undefined> {
  if (process.env.FACTORY_SKIP_FINAL_MERGE === "1") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Final merge skipped by FACTORY_SKIP_FINAL_MERGE=1",
    });
  }

  if (input.finalMergePolicy !== "required") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Final merge policy does not require automatic merge",
    });
  }

  if (!input.candidateBranch) {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "No candidate branch available for merge",
    });
  }

  if (input.worktreeMode === "existing") {
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason: "Existing linked worktree does not provide a known primary merge checkout",
    });
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "merge.started",
    data: {
      baseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
    },
  });

  try {
    await execFileAsync("git", ["checkout", input.baseBranch], { cwd: input.mergeCwd, windowsHide: true });
    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", input.candidateBranch], {
      cwd: input.mergeCwd,
      windowsHide: true,
    });
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "merge.completed",
      data: {
        baseBranch: input.baseBranch,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
      },
    });
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "merged",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "merge.skipped",
      data: {
        baseBranch: input.baseBranch,
        candidateBranch: input.candidateBranch,
        candidateSha: input.candidateSha,
        reason,
      },
    });
    return writePrototypeFinalMergeArtifact(input.runDir, {
      mergeBaseBranch: input.baseBranch,
      candidateBranch: input.candidateBranch,
      candidateSha: input.candidateSha,
      mergeCwd: input.mergeCwd,
      status: "skipped",
      reason,
    });
  }
}

function resolveTaskDependencies(tasks: PlannerTask[]): Map<string, string[]> {
  const tasksByStage = new Map<string, string[]>();
  for (const task of tasks) {
    const stageKey = task.stage.toLowerCase();
    const existing = tasksByStage.get(stageKey) ?? [];
    existing.push(task.id);
    tasksByStage.set(stageKey, existing);
  }

  const dependencies = new Map<string, string[]>();
  for (const task of tasks) {
    const resolved = task.dependsOn.flatMap((dependency) => tasksByStage.get(dependency.toLowerCase()) ?? []);
    dependencies.set(task.id, resolved);
  }
  return dependencies;
}

function isImplementationTaskStage(stage: string): boolean {
  const normalized = stage.toLowerCase();
  return normalized === "build" || normalized === "implementation" || normalized === "verify" || normalized === "verification";
}

function buildPlannerPrompt(
  goal: string,
  config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } },
  constitutionContext?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Base branch: ${config.git.baseBranch}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
    constitutionContext ? `Constitution context:\n${constitutionContext}` : undefined,
    "Produce a concise implementation plan for this repository.",
  ].filter(Boolean).join("\n");
}

function buildBuilderPrompt(
  goal: string,
  task: { id: string; title: string; stage: string; dependsOn: string[] },
  constitutionContext?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Task id: ${task.id}`,
    `Task stage: ${task.stage}`,
    `Task title: ${task.title}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "Depends on: none",
    constitutionContext ? `Constitution context:\n${constitutionContext}` : undefined,
    "Implement the task in this repository and leave the workspace ready for verification.",
  ].filter(Boolean).join("\n");
}

function buildRepairPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string; stderr?: string }> },
  constitutionContext?: string,
): string {
  const failures = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => `${command.name}: ${command.stderr ?? "failed"}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    failures ? `Failures:\n${failures}` : "Failures: none recorded",
    constitutionContext ? `Constitution context:\n${constitutionContext}` : undefined,
    "Repair the code so verification can pass.",
  ].filter(Boolean).join("\n");
}

function buildReviewerPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string }> },
  constitutionContext?: string,
): string {
  const commandStatuses = verification.commands
    .map((command) => `${command.name}: ${command.status}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    commandStatuses ? `Command results:\n${commandStatuses}` : "Command results: none",
    constitutionContext ? `Constitution context:\n${constitutionContext}` : undefined,
    "Review the candidate and report whether it looks ready for approval.",
  ].filter(Boolean).join("\n");
}

function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "factory-run";
}

async function movePhase(
  statePath: string,
  eventsPath: string,
  runId: string,
  input: RunFactoryControllerInput,
  phase: string,
  message: string,
): Promise<void> {
  await updateFactoryRunState({
    statePath,
    patch: { status: "RUNNING", phase },
  });
  await appendFactoryRunEvent(eventsPath, {
    timestamp: new Date().toISOString(),
    type: `phase.${phase}`,
    data: { message },
  });
  await emitProgress(input, {
    runId,
    phase,
    status: "RUNNING",
    message,
  });
}

async function emitProgress(
  input: RunFactoryControllerInput,
  event: FactoryRunProgressEvent,
): Promise<void> {
  await input.onProgress?.(event);
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
