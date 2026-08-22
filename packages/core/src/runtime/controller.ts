import path from "node:path";
import { loadEffectiveConfig } from "../config/loader.js";
import { createGitWorktree, inspectGitIsolation } from "../git/worktree.js";
import { appendFactoryRunEvent, createFactoryRun, updateFactoryRunState } from "../runs/store.js";
import {
  writePrototypeBuilderExecutionArtifact,
  writePrototypePlanArtifact,
  writePrototypePlannerExecutionArtifact,
  writePrototypeRepairExecutionArtifact,
  writePrototypeReviewerExecutionArtifact,
  writePrototypeSummaryArtifact,
  writePrototypeTaskArtifacts,
  writePrototypeVerificationArtifact,
} from "./artifacts.js";
import type { AgentExecutor } from "./interfaces.js";
import { buildPlanArtifact } from "./planner.js";
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
  requestApproval?: (input: { runId: string; goal: string }) => Promise<boolean>;
  delayMs?: number;
}

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

  const phases = ["planning", "implementation", "verification", "review", "approval-ready", "complete"];
  const delayMs = input.delayMs ?? 150;
  const builderExecutionPaths: string[] = [];
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

  let plannerExecutionPath: string | undefined;
  if (input.plannerExecutor) {
    const plannerResult = await input.plannerExecutor.execute({
      executionId: `${run.runId}-planner`,
      cwd: executionCwd,
      prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig),
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

  const implementationTasks = plan.tasks.filter((task) => {
    const stage = task.stage.toLowerCase();
    return stage === "build" || stage === "implementation" || stage === "verify" || stage === "verification";
  });

  for (const task of implementationTasks) {
    await updatePrototypeTaskArtifact({
      runDir: run.runDir,
      taskId: task.id,
      patch: { status: "running" },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "task.started",
      data: {
        taskId: task.id,
        stage: task.stage,
        title: task.title,
      },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "implementation",
      status: "RUNNING",
      message: `Running task ${task.id}: ${task.title}`,
    });

    if (input.builderExecutor) {
      const builderResult = await input.builderExecutor.execute({
        executionId: `${run.runId}-builder-${task.id}`,
        cwd: executionCwd,
        prompt: buildBuilderPrompt(input.goal, task),
        model: loaded.effectiveConfig.models.builder,
        tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
        metadata: {
          role: "builder",
          runId: run.runId,
          taskId: task.id,
          taskStage: task.stage,
        },
      });
      const builderExecutionPath = await writePrototypeBuilderExecutionArtifact(run.runDir, {
        taskId: task.id,
        ...builderResult,
      });
      builderExecutionPaths.push(builderExecutionPath);
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.executor_completed",
        data: {
          taskId: task.id,
          taskStage: task.stage,
          builderExecutionPath,
          builderStatus: builderResult.status,
        },
      });

      if (builderResult.status !== "completed") {
        await updatePrototypeTaskArtifact({
          runDir: run.runDir,
          taskId: task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: task.id,
            stage: task.stage,
            title: task.title,
            builderExecutionPath,
            builderStatus: builderResult.status,
          },
        });

        const failedState = await updateFactoryRunState({
          statePath: run.statePath,
          patch: { status: "FAILED", phase: "implementation-failed" },
        });
        await appendFactoryRunEvent(run.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "run.failed",
          data: { reason: `implementation task failed: ${task.id}` },
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
          repairExecutionPaths,
          verificationPath: path.join(run.runDir, "verification.json"),
          summaryPath,
        };
      }
    } else {
      await wait(delayMs);
    }

    await updatePrototypeTaskArtifact({
      runDir: run.runDir,
      taskId: task.id,
      patch: { status: "done" },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "task.completed",
      data: {
        taskId: task.id,
        stage: task.stage,
        title: task.title,
      },
    });
  }

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
        prompt: buildRepairPrompt(input.goal, verification),
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
      prompt: buildReviewerPrompt(input.goal, verification),
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
        repairExecutionPaths,
        reviewerExecutionPath,
        verificationPath,
        summaryPath,
      };
    }
  }

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "approval-ready", "Candidate ready for approval");
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "approval.required",
    data: {
      finalMerge: loaded.effectiveConfig.approval.finalMerge,
    },
  });

  await emitProgress(input, {
    runId: run.runId,
    phase: "approval-ready",
    status: "RUNNING",
    message: "Waiting for human approval",
  });

  const approved = (await input.requestApproval?.({ runId: run.runId, goal: input.goal })) ?? true;
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: approved ? "approval.approved" : "approval.rejected",
    data: { goal: input.goal },
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
      planPath,
      taskPaths,
      plannerExecutionPath,
      builderExecutionPaths,
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
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      summaryPath,
    };
  }

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
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
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
    repairExecutionPaths,
    reviewerExecutionPath,
    verificationPath,
    summaryPath,
  };
}

function buildPlannerPrompt(goal: string, config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } }): string {
  return [
    `Goal: ${goal}`,
    `Base branch: ${config.git.baseBranch}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
    "Produce a concise implementation plan for this repository.",
  ].join("\n");
}

function buildBuilderPrompt(
  goal: string,
  task: { id: string; title: string; stage: string; dependsOn: string[] },
): string {
  return [
    `Goal: ${goal}`,
    `Task id: ${task.id}`,
    `Task stage: ${task.stage}`,
    `Task title: ${task.title}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "Depends on: none",
    "Implement the task in this repository and leave the workspace ready for verification.",
  ].join("\n");
}

function buildRepairPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string; stderr?: string }> },
): string {
  const failures = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => `${command.name}: ${command.stderr ?? "failed"}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    failures ? `Failures:\n${failures}` : "Failures: none recorded",
    "Repair the code so verification can pass.",
  ].join("\n");
}

function buildReviewerPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string }> },
): string {
  const commandStatuses = verification.commands
    .map((command) => `${command.name}: ${command.status}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    commandStatuses ? `Command results:\n${commandStatuses}` : "Command results: none",
    "Review the candidate and report whether it looks ready for approval.",
  ].join("\n");
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
