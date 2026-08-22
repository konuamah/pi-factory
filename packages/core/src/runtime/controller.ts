import path from "node:path";
import { loadEffectiveConfig } from "../config/loader.js";
import { appendFactoryRunEvent, createFactoryRun, updateFactoryRunState } from "../runs/store.js";
import {
  writePrototypePlanArtifact,
  writePrototypeSummaryArtifact,
  writePrototypeTaskArtifacts,
  writePrototypeVerificationArtifact,
} from "./artifacts.js";
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
  onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
  requestApproval?: (input: { runId: string; goal: string }) => Promise<boolean>;
  delayMs?: number;
}

export interface RunFactoryControllerResult {
  runId: string;
  runDir: string;
  statePath: string;
  eventsPath: string;
  phases: string[];
  approved: boolean;
  planPath: string;
  taskPaths: string[];
  verificationPath: string;
  summaryPath: string;
}

export async function runFactoryController(
  input: RunFactoryControllerInput,
): Promise<RunFactoryControllerResult> {
  const loaded = await loadEffectiveConfig({ cwd: input.cwd });
  const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
  const projectRoot = path.dirname(root);
  const run = await createFactoryRun({
    runsDir: path.join(projectRoot, ".factory", "runs"),
    initialPhase: "planning",
    effectiveConfig: loaded.effectiveConfig,
  });

  const phases = ["planning", "implementation", "verification", "approval-ready", "complete"];
  const delayMs = input.delayMs ?? 150;

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.goal_received",
    data: { goal: input.goal },
  });

  await emitProgress(input, {
    runId: run.runId,
    phase: "planning",
    status: "RUNNING",
    message: `Starting run for: ${input.goal}`,
  });

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "planning", "Building plan");
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
    await wait(delayMs);

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
  const verification = await runVerificationCommands({
    cwd: input.cwd,
    commands: loaded.effectiveConfig.commands,
  });
  const verificationPath = await writePrototypeVerificationArtifact(run.runDir, verification);
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
      verificationPath,
      verificationStatus: verification.overallStatus,
    });

    return {
      runId: run.runId,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      phases,
      approved: false,
      planPath,
      taskPaths,
      verificationPath,
      summaryPath,
    };
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
      verificationPath,
      verificationStatus: verification.overallStatus,
    });

    return {
      runId: run.runId,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      phases,
      approved: false,
      planPath,
      taskPaths,
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
    verificationPath,
    verificationStatus: verification.overallStatus,
  });

  return {
    runId: run.runId,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: true,
    planPath,
    taskPaths,
    verificationPath,
    summaryPath,
  };
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
