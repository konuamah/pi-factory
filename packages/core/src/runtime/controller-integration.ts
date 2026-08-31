// Integration phase of the run controller — extracted from controller-run.ts.

import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { writePrototypeSummaryArtifact } from "./artifacts.js";
import { runIntegrationPhase as runIntegration, classifyIntegrationFailure } from "./integration-phase.js";
import { movePhase, wait, emitProgress } from "./phase-plumbing.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult } from "./controller.js";
import type { TaskWorkspaceSelection } from "./controller.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { VerificationRunResult } from "./verification.js";
import type { VerificationFailureClassification } from "./failure-classification.js";
import type { VerificationEngineResult } from "../verification/index.js";
import path from "node:path";
import type { PlannerTask } from "./planner.js";

export interface ControllerIntegrationState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
  phases: string[];
  delayMs: number;
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath: string | undefined;
  plannerExecutionPath: string | undefined;
  builderExecutionPaths: string[];
  repairExecutionPaths: string[];
  integrationPath: string | undefined;
  repairGuidanceText: string;
  repairSkills: SkillBundleSelection;
  implementationRun: { taskWorkspaces: TaskWorkspaceSelection[] };
}

export async function runControllerIntegration(state: ControllerIntegrationState): Promise<RunFactoryControllerResult | { integrationPath: string | undefined }> {
  const {
    run, input, loaded, executionCwd, worktree, phases, delayMs, planPath, taskPaths,
    discoveryExecutionPath, plannerExecutionPath, builderExecutionPaths, repairExecutionPaths,
    repairGuidanceText, repairSkills, implementationRun,
  } = state;
  let integrationPath = state.integrationPath;
  const repairGuidance = { text: repairGuidanceText };

await movePhase(run.statePath, run.eventsPath, run.runId, input, "integration", "Integrating isolated task workspaces");
try {
  integrationPath = await runIntegration({
    runDir: run.runDir,
    eventsPath: run.eventsPath,
    executionCwd,
    taskWorkspaces: implementationRun.taskWorkspaces,
    goal: input.goal,
    runId: run.runId,
    repairExecutor: input.repairExecutor,
    repairModel: loaded.effectiveConfig.models.repair,
    repairGuidanceContext: repairGuidance.text,
    repairSkillBundleText: renderSkillBundleForPrompt(repairSkills),
    limits: loaded.effectiveConfig.runtime.limits,
  });
} catch (error) {
  const integrationFailure = await classifyIntegrationFailure(executionCwd, error);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.failed",
    data: integrationFailure,
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.failed",
    data: { reason: `integration failed: ${integrationFailure.reason}` },
  });
  const failedState = await updateFactoryRunState({
    statePath: run.statePath,
    patch: { status: "FAILED", phase: "integration-failed" },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "integration-failed",
    status: "FAILED",
    message: integrationFailure.conflictingFiles.length > 0
      ? `Integration failed with conflicts: ${integrationFailure.conflictingFiles.join(", ")}`
      : `Integration failed: ${integrationFailure.reason}`,
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

let verificationPath: string;
let verification: VerificationRunResult;
let verificationFailureClassification: VerificationFailureClassification | undefined;
let contractResult: VerificationEngineResult;

  return { integrationPath };
}
