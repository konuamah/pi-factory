import path from "node:path";
import { loadEffectiveConfig } from "../config/loader.js";
import { appendFactoryRunEvent, createFactoryRun, updateFactoryRunState } from "../runs/store.js";
import {
  writePrototypePlanArtifact,
  writePrototypeVerificationArtifact,
} from "./artifacts.js";

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
  verificationPath: string;
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
  const planPath = await writePrototypePlanArtifact(run.runDir, {
    goal: input.goal,
    tasks: [
      { id: "task-1", title: "Analyze goal", status: "done" },
      { id: "task-2", title: "Prepare implementation slice", status: "pending" },
      { id: "task-3", title: "Verify candidate", status: "pending" },
    ],
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "planning.artifact_written",
    data: { planPath },
  });
  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "implementation", "Executing fake builder tasks");
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "implementation.fake_task",
    data: {
      task: "prototype-builder",
      workflowStages: loaded.effectiveConfig.workflow?.stages.map((stage) => stage.name) ?? [],
    },
  });
  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "verification", "Checking configured commands");
  const verificationCommands = Object.entries(loaded.effectiveConfig.commands).map(([name, command]) => ({
    name,
    command: command ?? "",
    status: command ? "configured" as const : "missing" as const,
  }));
  const verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
    commands: verificationCommands,
    overallStatus: verificationCommands.every((entry) => entry.status === "configured") ? "passed" : "incomplete",
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.commands_detected",
    data: loaded.effectiveConfig.commands,
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.artifact_written",
    data: { verificationPath },
  });
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
    await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "CANCELLED", phase: "approval-rejected" },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "approval-rejected",
      status: "CANCELLED",
      message: "Run stopped: approval rejected",
    });

    return {
      runId: run.runId,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      phases,
      approved: false,
      planPath,
      verificationPath,
    };
  }

  await wait(delayMs);

  await updateFactoryRunState({
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

  return {
    runId: run.runId,
    runDir: run.runDir,
    statePath: run.statePath,
    eventsPath: run.eventsPath,
    phases,
    approved: true,
    planPath,
    verificationPath,
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
