// Planning phase of the run controller — extracted from controller-run.ts.

import { appendFactoryRunEvent, updateFactoryRunState, createFactoryRun } from "../runs/store.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { writePrototypePlannerExecutionArtifact, writePrototypePlanArtifact, writePrototypeTaskArtifacts } from "./artifacts.js";
import { renderSkillBundleForPrompt } from "./prompts.js";
import { buildPlannerPrompt } from "./controller-interview.js";
import { buildPlanArtifact, type PlannerArtifact } from "./planner.js";
import { resolveModelForRole } from "../models/index.js";
import { sanitizePlannerOutput, validatePlannerOutput, validatePlannerOutputWithLLM } from "./planner-validate.js";
import { attachDiscoveryFileHintsToBuildTasks } from "./controller.js";
import { movePhase, wait } from "./phase-plumbing.js";
import { loadEffectiveConfig } from "../config/loader.js";
import type { RunFactoryControllerInput, InterviewDecisionRecord, RunFactoryControllerResult } from "./controller.js";
import path from "node:path";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";
import type { AgentExecutor } from "./interfaces.js";

export interface PlanningPhaseState {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  loaded: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  executionCwd: string;
  worktree: NonNullable<RunFactoryControllerResult["worktree"]>;
  delayMs: number;
  runTaskType: TaskTypeSelection;
  repoSkillSignals: { constitutionAreas: number[] };
  plannerGuidanceText: string;
  plannerSkills: SkillBundleSelection;
  discoveryOutputText: string | undefined;
  interviewContext: string;
  discoveryFileHints: string[];
  discoveryExecutionPath: string | undefined;
  interviewExecutionPath: string;
}

export async function runPlanningPhase(state: PlanningPhaseState): Promise<{
  plannerExecutionPath: string | undefined;
  plannerOutputText: string | undefined;
  planPath: string;
  taskPaths: string[];
  plan: PlannerArtifact;
}> {
  const {
    run, input, loaded, executionCwd, worktree, delayMs, runTaskType, repoSkillSignals,
    plannerGuidanceText, plannerSkills, discoveryOutputText, interviewContext, discoveryFileHints,
    discoveryExecutionPath, interviewExecutionPath,
  } = state;
  const plannerGuidance = { text: plannerGuidanceText };
  let plannerExecutionPath: string | undefined;
  let plannerOutputText: string | undefined;

await movePhase(run.statePath, run.eventsPath, run.runId, input, "planning", "Building plan");
if (input.plannerExecutor) {
  const plannerModel = resolveModelForRole({
    role: "planner",
    taskType: runTaskType.id,
    config: loaded.effectiveConfig,
    runModelOverride: input.modelOverrides?.planner,
  });
  await appendModelLedgerEntry(run.runDir, {
    operationId: `${run.runId}-planner`,
    role: "planner",
    taskType: runTaskType.id,
    taskTypeSource: runTaskType.source,
    taskTypeConfidence: runTaskType.confidence,
    requestedModel: plannerModel.model.model,
    resolvedModel: plannerModel.model.model,
    provider: plannerModel.model.provider,
    modelSource: plannerModel.source,
  });
  const plannerResult = await input.plannerExecutor.execute({
    executionId: `${run.runId}-planner`,
    cwd: executionCwd,
    prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig, plannerGuidance.text, renderSkillBundleForPrompt(plannerSkills), discoveryOutputText, interviewContext),
    model: plannerModel.model,
    tools: ["read", "grep", "find", "ls"],
    metadata: {
      role: "planner",
      runId: run.runId,
      taskType: runTaskType.id,
    },
  });
  plannerOutputText = sanitizePlannerOutput(plannerResult.outputText);
  plannerExecutionPath = await writePrototypePlannerExecutionArtifact(run.runDir, plannerResult);
  let plannerValidation = validatePlannerOutput(plannerOutputText);
  const deterministicPlannerBlock = !plannerValidation.ok
    && /^Planner delegated broad discovery to Builder/.test(plannerValidation.reason);
  if (!plannerValidation.ok && !deterministicPlannerBlock && input.plannerExecutor) {
    // Deterministic check failed — try LLM context-aware validation
    const llmValidation = await validatePlannerOutputWithLLM({
      plannerOutput: plannerOutputText ?? "",
      executor: input.plannerExecutor,
      model: plannerModel.model,
      runId: run.runId,
    });
    if (llmValidation.ok) {
      plannerValidation = { ok: true };
    } else {
      plannerValidation = llmValidation;
    }
  }
  if (!plannerValidation.ok) {
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "planning.invalid_output",
      data: {
        plannerExecutionPath,
        reason: plannerValidation.reason,
      },
    });
    await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "planning-failed" },
    });
    throw new Error(`Planning failed: ${plannerValidation.reason}`);
  }
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
  discoveryText: discoveryOutputText,
  planText: plannerOutputText,
  artifactRefs: {
    discoveryExecutionPath,
    interviewExecutionPath,
    plannerExecutionPath,
  },
});
attachDiscoveryFileHintsToBuildTasks(plan.tasks, discoveryFileHints);
const planPath = await writePrototypePlanArtifact(run.runDir, plan);
const taskPaths = await writePrototypeTaskArtifacts(
  run.runDir,
  plan.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    stage: task.stage,
    status: task.status,
    dependsOn: task.dependsOn,
    type: task.type,
    role: task.role,
    commands: task.commands,
    requiresApproval: task.requiresApproval,
    context: task.context,
    workspacePath: task.id === "task-1" ? executionCwd : undefined,
    workspaceMode: task.id === "task-1" ? worktree.mode : undefined,
    workspaceBranch: task.id === "task-1" ? worktree.branch : undefined,
    controllerHandled: task.controllerHandled,
    artifactRefs: task.artifactRefs,
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
    discoveryExecutionPath,
    plannerExecutionPath,
  },
});
await wait(delayMs);


  return { plannerExecutionPath, plannerOutputText, planPath, taskPaths, plan };
}
