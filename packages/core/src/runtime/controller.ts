import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEffectiveConfig } from "../config/loader.js";
import { selectConstitutionContext } from "../constitution/context.js";
import { discoverConstitutionRepository } from "../constitution/discovery.js";
import { compileAgentContext, type CompiledContext } from "../context/compiler.js";
import { createGitWorktree, createSiblingGitWorktree, inspectGitIsolation } from "../git/worktree.js";
import { initializeFactorySkills, resolveFactorySkills, type SkillBundleSelection } from "../skills/index.js";
import { appendFactoryRunEvent, createFactoryRun, updateFactoryRunState } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
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
import type { CapabilityPolicy, EffectiveFactoryConfig, ModelRole, ModelSelection } from "@factory/schemas";
import {
  capabilitiesToToolNames,
  defaultCapabilitiesForRole,
  resolveEffectiveCapabilities,
  type AutonomyLevel,
} from "../capabilities/index.js";
import {
  classifyTaskType,
  resolveModelForRole,
  taskTypeMatchPaths,
  type TaskTypeSelection,
} from "../models/index.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { classifyVerificationFailure } from "./failure-classification.js";
import { planVerificationExecution, runVerificationCommands } from "./verification.js";

export interface FactoryRunProgressEvent {
  runId: string;
  phase: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  message: string;
}

export type PlanApprovalDecision = "approve" | "reject" | "revise";

export interface PlanApprovalResult {
  decision: PlanApprovalDecision;
  feedback?: string;
}

export interface RunFactoryControllerInput {
  cwd: string;
  goal: string;
  branchName?: string;
  workflowId?: string;
  taskType?: string;
  modelOverrides?: Partial<Record<ModelRole, ModelSelection>>;
  plannerExecutor?: AgentExecutor;
  builderExecutor?: AgentExecutor;
  repairExecutor?: AgentExecutor;
  reviewerExecutor?: AgentExecutor;
  verificationPlannerExecutor?: AgentExecutor;
  onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
  requestPlanApproval?: (input: { runId: string; goal: string; planPath: string; taskCount: number; workflowStages: string[]; summary: string; planText?: string; tasks: PlannerTask[] }) => Promise<PlanApprovalResult>;
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
  const loaded = await loadEffectiveConfig({
    cwd: input.cwd,
    runOverrides: input.workflowId ? { workflowId: input.workflowId } : undefined,
  });
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
    workflowId: loaded.effectiveConfig.resolvedWorkflowId ?? input.workflowId,
  });

  const phases = ["planning", "plan-approval", "implementation", "integration", "verification", "review", "approval-ready", "merge", "complete"];
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

  const plannerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal });
  const builderGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "builder", goal: input.goal });
  const repairGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "repair", goal: input.goal });
  const reviewerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "reviewer", goal: input.goal });

  await initializeFactorySkills(projectRoot);
  const repoSkillSignals = await collectRuntimeSkillSignals(projectRoot);
  const plannerSkills = resolveFactorySkills({
    goal: input.goal,
    stage: "plan",
    taskKinds: ["planning", "repo-interpretation"],
    requiredCapabilities: ["repo-interpretation", "architecture-planning"],
    availableTools: ["read", "grep", "find", "ls"],
    ...repoSkillSignals,
  });
  const builderSkills = resolveFactorySkills({
    goal: input.goal,
    stage: "build",
    taskKinds: ["implementation"],
    requiredCapabilities: ["repo-interpretation", "implementation-task"],
    availableTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ...repoSkillSignals,
  });
  const repairSkills = resolveFactorySkills({
    goal: input.goal,
    stage: "repair",
    taskKinds: ["repair", "verification"],
    requiredCapabilities: ["failure-triage", "verification-repair"],
    availableTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    ...repoSkillSignals,
  });
  const reviewerSkills = resolveFactorySkills({
    goal: input.goal,
    stage: "review",
    taskKinds: ["review"],
    requiredCapabilities: ["acceptance-review"],
    availableTools: ["read", "grep", "find", "ls"],
    ...repoSkillSignals,
  });

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "guidance.context_selected",
    data: {
      plannerInstructionFiles: plannerGuidance.instructionFiles,
      builderInstructionFiles: builderGuidance.instructionFiles,
      repairInstructionFiles: repairGuidance.instructionFiles,
      reviewerInstructionFiles: reviewerGuidance.instructionFiles,
      plannerInstructionDetails: plannerGuidance.instructionDetails,
      builderInstructionDetails: builderGuidance.instructionDetails,
      repairInstructionDetails: repairGuidance.instructionDetails,
      reviewerInstructionDetails: reviewerGuidance.instructionDetails,
      plannerHasConstitution: plannerGuidance.hasConstitution,
      builderHasConstitution: builderGuidance.hasConstitution,
      repairHasConstitution: repairGuidance.hasConstitution,
      reviewerHasConstitution: reviewerGuidance.hasConstitution,
      plannerUsedConstitution: plannerGuidance.usedConstitution,
      builderUsedConstitution: builderGuidance.usedConstitution,
      repairUsedConstitution: repairGuidance.usedConstitution,
      reviewerUsedConstitution: reviewerGuidance.usedConstitution,
      plannerGuidanceChars: plannerGuidance.approxChars,
      builderGuidanceChars: builderGuidance.approxChars,
      repairGuidanceChars: repairGuidance.approxChars,
      reviewerGuidanceChars: reviewerGuidance.approxChars,
    },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "skills.selected",
    data: {
      planner: summarizeSkillBundle(plannerSkills),
      builder: summarizeSkillBundle(builderSkills),
      repair: summarizeSkillBundle(repairSkills),
      reviewer: summarizeSkillBundle(reviewerSkills),
    },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "planning",
    status: "RUNNING",
    message: `Guidance selected: planner files=${plannerGuidance.instructionFiles.length}, constitution=${plannerGuidance.usedConstitution ? "used" : "skipped"}, approx chars=${plannerGuidance.approxChars}`,
  });

  const runTaskType = await resolveRunTaskTypeWithPaths(input, loaded.effectiveConfig, projectRoot);
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.type_resolved",
    data: {
      taskType: runTaskType.id,
      source: runTaskType.source,
      confidence: runTaskType.confidence,
      reasons: runTaskType.reasons,
    },
  });

  let plannerExecutionPath: string | undefined;
  let plannerOutputText: string | undefined;
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
      prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig, plannerGuidance.text, renderSkillBundleForPrompt(plannerSkills)),
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
    planText: plannerOutputText,
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
      type: task.type,
      role: task.role,
      commands: task.commands,
      requiresApproval: task.requiresApproval,
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

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "plan-approval", "Plan ready for human approval");
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "plan.approval_required",
    data: {
      planPath,
      taskCount: plan.tasks.length,
      workflowStages: plan.workflowStages.map((stage) => stage.name),
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
    workflowStages: plan.workflowStages.map((stage) => stage.name),
    summary: plan.summary,
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
    allowTaskWorktrees: loaded.effectiveConfig.git.allowWorktrees,
    tasks: implementationTasks,
    maxParallelAgents: loaded.effectiveConfig.runtime.maxParallelAgents,
    projectRoot,
    dependencyTasks: plan.tasks,
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
    config: loaded.effectiveConfig,
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
  try {
    integrationPath = await runIntegrationPhase({
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

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "verification", "Planning verification strategy");
  const verificationPlan = await planVerificationExecution({
    cwd: executionCwd,
    goal: input.goal,
    commands: loaded.effectiveConfig.commands,
    constitutionContext: repairGuidance.text,
    executor: input.verificationPlannerExecutor ?? input.plannerExecutor,
    model: loaded.effectiveConfig.models.planner,
    runId: run.runId,
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.plan_selected",
    data: {
      verificationCwd: verificationPlan.cwd,
      verificationCwdResolution: verificationPlan.cwdResolution,
      commandNames: Object.keys(verificationPlan.commands),
      selectionSource: verificationPlan.selectionSource,
      rationale: verificationPlan.rationale,
      evidence: verificationPlan.evidence,
      skillId: verificationPlan.skill.id,
      skillVersion: verificationPlan.skill.version,
      skillMode: verificationPlan.skill.mode,
      skillSelectionReasons: verificationPlan.skill.selectionReasons,
    },
  });
  await appendRepoLearning({
    projectRoot,
    category: "verification-plan",
    summary: `Verification uses ${verificationPlan.cwdResolution} at ${verificationPlan.cwd}`,
    data: {
      cwd: verificationPlan.cwd,
      cwdResolution: verificationPlan.cwdResolution,
      commandNames: Object.keys(verificationPlan.commands),
      selectionSource: verificationPlan.selectionSource,
    },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "verification",
    status: "RUNNING",
    message: `Verification plan: ${Object.keys(verificationPlan.commands).join(", ") || "none"} in ${verificationPlan.cwd}`,
  });
  let verification = await runVerificationCommands({
    cwd: verificationPlan.cwd,
    commands: verificationPlan.commands,
  });
  verification.cwdResolution = verificationPlan.cwdResolution;
  const verificationFailureClassification = classifyVerificationFailure({ plan: verificationPlan, result: verification });
  let verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
    ...verification,
    selectionSource: verificationPlan.selectionSource,
    rationale: verificationPlan.rationale,
    skill: verificationPlan.skill,
    evidence: verificationPlan.evidence,
    failureClassification: verificationFailureClassification,
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.commands_detected",
    data: {
      ...verificationPlan.commands,
      verificationCwd: verificationPlan.cwd,
      verificationCwdResolution: verificationPlan.cwdResolution,
      verificationSelectionSource: verificationPlan.selectionSource,
      verificationRationale: verificationPlan.rationale,
      verificationEvidence: verificationPlan.evidence,
      verificationSkillId: verificationPlan.skill.id,
      verificationSkillVersion: verificationPlan.skill.version,
      verificationSkillMode: verificationPlan.skill.mode,
      verificationSkillSelectionReasons: verificationPlan.skill.selectionReasons,
      verificationFailureKind: verificationFailureClassification?.kind,
      verificationFailureReason: verificationFailureClassification?.reason,
    },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.completed",
    data: {
      overallStatus: verification.overallStatus,
      failureClassification: verificationFailureClassification as unknown as Record<string, unknown> | undefined,
    },
  });
  if (verificationFailureClassification) {
    await appendRepoLearning({
      projectRoot,
      category: "verification-failure",
      summary: verificationFailureClassification.reason,
      data: verificationFailureClassification as unknown as Record<string, unknown>,
    });
  }
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.artifact_written",
    data: { verificationPath },
  });
  await emitProgress(input, {
    runId: run.runId,
    phase: "verification",
    status: verification.overallStatus === "failed" ? "FAILED" : "RUNNING",
    message: `Verification ${verification.overallStatus} in ${verification.cwd}`,
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
        cwd: verification.cwd,
        prompt: buildRepairPrompt(input.goal, verification, repairGuidance.text, renderSkillBundleForPrompt(repairSkills)),
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
        cwd: verificationPlan.cwd,
        commands: verificationPlan.commands,
      });
      verification.cwdResolution = verificationPlan.cwdResolution;
      const recheckFailureClassification = classifyVerificationFailure({ plan: verificationPlan, result: verification });
      verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
        ...verification,
        selectionSource: verificationPlan.selectionSource,
        rationale: verificationPlan.rationale,
        skill: verificationPlan.skill,
        evidence: verificationPlan.evidence,
        failureClassification: recheckFailureClassification,
      });
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
      prompt: buildReviewerPrompt(input.goal, verification, reviewerGuidance.text, renderSkillBundleForPrompt(reviewerSkills)),
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
  projectRoot: string;
  dependencyTasks?: PlannerTask[];
  roleExecutors: Partial<Record<ModelRole, AgentExecutor>>;
  roleModels: Partial<Record<ModelRole, { provider?: string; model: string }>>;
  roleSkills: Partial<Record<ModelRole, SkillBundleSelection>>;
  autonomy?: AutonomyLevel;
  projectCapabilityPolicy?: CapabilityPolicy;
  workflowCapabilityPolicy?: CapabilityPolicy;
  runTaskType?: string;
  runModelOverrides?: Partial<Record<ModelRole, ModelSelection>>;
  config: EffectiveFactoryConfig;
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
          projectRoot: input.projectRoot,
          dependencyTasks: input.dependencyTasks,
          roleExecutors: input.roleExecutors,
          roleModels: input.roleModels,
          roleSkills: input.roleSkills,
          autonomy: input.autonomy,
          projectCapabilityPolicy: input.projectCapabilityPolicy,
          workflowCapabilityPolicy: input.workflowCapabilityPolicy,
          runTaskType: input.runTaskType,
          runModelOverrides: input.runModelOverrides,
          config: input.config,
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
  projectRoot: string;
  dependencyTasks?: PlannerTask[];
  roleExecutors: Partial<Record<ModelRole, AgentExecutor>>;
  roleModels: Partial<Record<ModelRole, { provider?: string; model: string }>>;
  roleSkills: Partial<Record<ModelRole, SkillBundleSelection>>;
  autonomy?: AutonomyLevel;
  projectCapabilityPolicy?: CapabilityPolicy;
  workflowCapabilityPolicy?: CapabilityPolicy;
  runTaskType?: string;
  runModelOverrides?: Partial<Record<ModelRole, ModelSelection>>;
  config: EffectiveFactoryConfig;
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

  if (input.task.type === "command" && input.task.commands?.length) {
    for (const command of input.task.commands) {
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.command_started",
        data: {
          taskId: input.task.id,
          command,
          workspacePath: workspace.path,
        },
      });
      try {
        const { stdout, stderr } = await execFileAsync(command, { cwd: workspace.path, shell: true, windowsHide: true });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_completed",
          data: {
            taskId: input.task.id,
            command,
            status: "passed",
            stdout,
            stderr,
          },
        });
      } catch (error) {
        const execError = error as Error & { code?: number; stdout?: string; stderr?: string };
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.command_failed",
          data: {
            taskId: input.task.id,
            command,
            status: "failed",
            exitCode: execError.code,
            stdout: execError.stdout,
            stderr: execError.stderr,
          },
        });
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
            command,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
    }
  } else {
    const nodeRole = resolveNodeRole(input.task);
    const executor = input.roleExecutors[nodeRole];
    if (executor) {
      const capabilities = resolveEffectiveCapabilities({
        requested: input.task.requiredCapabilities?.length ? input.task.requiredCapabilities : defaultCapabilitiesForRole(nodeRole),
        autonomy: (input.autonomy ?? "medium") as AutonomyLevel,
        projectPolicy: input.projectCapabilityPolicy,
        workflowPolicy: input.workflowCapabilityPolicy,
        nodePolicy: input.task.capabilityPolicy,
      });
      const compiled = await compileAgentContext({
        cwd: input.projectRoot,
        role: nodeRole,
        goal: input.goal,
        task: input.task,
        dependencyTasks: input.dependencyTasks?.filter((dep) => input.task.dependsOn.includes(dep.id)),
        skills: input.roleSkills[nodeRole]?.selected,
        fileHints: input.task.context?.fileHints,
        maxChars: 6000,
        grantedCapabilities: capabilities.granted,
        deniedCapabilities: capabilities.denied,
      });
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "task.context_compiled",
        data: {
          taskId: input.task.id,
          role: nodeRole,
          files: compiled.files.map((file) => file.path),
          dependencies: compiled.dependencies.map((dep) => dep.taskId),
          skills: compiled.skills.map((skill) => skill.id),
          capabilities: capabilities.granted,
          deniedCapabilities: capabilities.denied,
          tokenEstimate: compiled.tokenEstimate,
        },
      });
      const nodeTaskType = input.task.taskType ?? input.runTaskType ?? "general";
      const nodeModel = resolveModelForRole({
        role: nodeRole,
        taskType: nodeTaskType,
        config: input.config,
        nodeModel: input.task.model,
        runModelOverride: input.runModelOverrides?.[nodeRole],
      });
      await appendModelLedgerEntry(input.runDir, {
        operationId: `${input.runId}-${nodeRole}-${input.task.id}`,
        taskId: input.task.id,
        nodeId: input.task.id,
        role: nodeRole,
        taskType: nodeTaskType,
        taskTypeSource: input.task.taskType ? "node-override" : "run",
        requestedModel: nodeModel.model.model,
        resolvedModel: nodeModel.model.model,
        provider: nodeModel.model.provider,
        modelSource: nodeModel.source,
      });
      const builderResult = await executor.execute({
        executionId: `${input.runId}-${nodeRole}-${input.task.id}`,
        cwd: workspace.path,
        prompt: buildCompiledPrompt(input.goal, compiled),
        model: nodeModel.model,
        tools: [...roleTools(nodeRole), ...capabilitiesToToolNames(capabilities.granted)].filter((tool, index, arr) => arr.indexOf(tool) === index),
        metadata: {
          role: nodeRole,
          runId: input.runId,
          taskId: input.task.id,
          taskStage: input.task.stage,
          workspacePath: workspace.path,
          workspaceBranch: workspace.branch,
          grantedCapabilities: capabilities.granted,
          deniedCapabilities: capabilities.denied,
          needsApprovalCapabilities: capabilities.needsApproval,
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
  goal: string;
  runId: string;
  repairExecutor?: AgentExecutor;
  repairModel?: { provider?: string; model: string };
  repairGuidanceContext?: string;
  repairSkillBundleText?: string;
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

    try {
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
    } catch (error) {
      const failure = await classifyIntegrationFailure(input.executionCwd, error);
      await appendFactoryRunEvent(input.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "integration.merge_failed",
        data: {
          taskId: workspace.taskId,
          branch: workspace.branch,
          workspacePath: workspace.path,
          ...failure,
        },
      });

      const repaired = await attemptIntegrationAutoRepair({
        runId: input.runId,
        goal: input.goal,
        executionCwd: input.executionCwd,
        eventsPath: input.eventsPath,
        taskId: workspace.taskId,
        branch: workspace.branch,
        conflictingFiles: failure.conflictingFiles,
        repairExecutor: input.repairExecutor,
        repairModel: input.repairModel,
        repairGuidanceContext: input.repairGuidanceContext,
        repairSkillBundleText: input.repairSkillBundleText,
      });

      if (!repaired) {
        throw error;
      }

      mergedBranches.push({
        taskId: workspace.taskId,
        branch: workspace.branch,
        workspacePath: workspace.path,
        status: "merged",
      });
    }
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

async function attemptIntegrationAutoRepair(input: {
  runId: string;
  goal: string;
  executionCwd: string;
  eventsPath: string;
  taskId: string;
  branch: string;
  conflictingFiles: string[];
  repairExecutor?: AgentExecutor;
  repairModel?: { provider?: string; model: string };
  repairGuidanceContext?: string;
  repairSkillBundleText?: string;
}): Promise<boolean> {
  if (!input.repairExecutor || input.conflictingFiles.length === 0) {
    return false;
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.repair_requested",
    data: {
      taskId: input.taskId,
      branch: input.branch,
      conflictingFiles: input.conflictingFiles,
    },
  });

  await input.repairExecutor.execute({
    executionId: `${input.runId}-integration-repair-${input.taskId}`,
    cwd: input.executionCwd,
    prompt: buildIntegrationRepairPrompt(input.goal, input.branch, input.conflictingFiles, input.repairGuidanceContext, input.repairSkillBundleText),
    model: input.repairModel,
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
    metadata: {
      role: "repair",
      runId: input.runId,
      phase: "integration",
      taskId: input.taskId,
    },
  });

  const remainingConflicts = await readGitConflictFiles(input.executionCwd);
  const mergeInProgress = await hasGitMergeInProgress(input.executionCwd);
  if (remainingConflicts.length > 0) {
    await appendFactoryRunEvent(input.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "integration.repair_failed",
      data: {
        taskId: input.taskId,
        branch: input.branch,
        conflictingFiles: remainingConflicts,
      },
    });
    return false;
  }

  if (mergeInProgress) {
    await execFileAsync("git", ["add", "-A"], { cwd: input.executionCwd, windowsHide: true });
    await execFileAsync("git", ["commit", "--no-edit"], { cwd: input.executionCwd, windowsHide: true });
  }

  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "integration.repair_completed",
    data: {
      taskId: input.taskId,
      branch: input.branch,
    },
  });
  return true;
}

export async function classifyIntegrationFailure(
  cwd: string,
  error: unknown,
): Promise<{ reason: string; conflictingFiles: string[]; mergeInProgress: boolean }> {
  const reason = error instanceof Error ? error.message : String(error);
  const conflictingFiles = await readGitConflictFiles(cwd);
  const mergeInProgress = await hasGitMergeInProgress(cwd);
  return {
    reason,
    conflictingFiles,
    mergeInProgress,
  };
}

async function readGitConflictFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd,
      windowsHide: true,
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function hasGitMergeInProgress(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
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

function resolveRunTaskType(input: RunFactoryControllerInput, config: EffectiveFactoryConfig): TaskTypeSelection {
  if (input.taskType) {
    return { id: input.taskType, source: "run-override", confidence: 1, reasons: ["Explicit run task-type override."] };
  }
  const classifier = classifyTaskType(input.goal, config);
  if (classifier.source === "classifier" || classifier.source === "default") {
    return classifier;
  }
  return { id: "general", source: "default", confidence: 0.2, reasons: ["No task type matched."] };
}

async function resolveRunTaskTypeWithPaths(
  input: RunFactoryControllerInput,
  config: EffectiveFactoryConfig,
  projectRoot: string,
): Promise<TaskTypeSelection> {
  const classifier = resolveRunTaskType(input, config);
  if (input.taskType) {
    return classifier;
  }

  const changedFiles = await gitChangedFiles(projectRoot);
  if (changedFiles.length > 0) {
    const pathMatch = taskTypeMatchPaths(config.taskTypes ?? {}, changedFiles);
    if (pathMatch) {
      return {
        id: pathMatch,
        source: "classifier",
        confidence: 0.9,
        reasons: [`Changed files matched path hints: ${changedFiles.slice(0, 3).join(", ")}`],
      };
    }
  }
  return classifier;
}

async function gitChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((file) => file && file !== "NUL");
  } catch {
    return [];
  }
}

function resolveNodeRole(task: PlannerTask): ModelRole {
  const role = task.role as ModelRole | undefined;
  if (role === "planner" || role === "reviewer" || role === "repair" || role === "builder") {
    return role;
  }
  return "builder";
}

function roleTools(role: ModelRole): string[] {
  if (role === "builder" || role === "repair") {
    return ["read", "write", "edit", "bash", "grep", "find", "ls"];
  }
  return ["read", "grep", "find", "ls"];
}

function isExecutableWorkflowNode(task: PlannerTask): boolean {
  const type = task.type;
  if (type === "command" || type === "task-graph") {
    return true;
  }
  if (type === "approval") {
    return false;
  }
  // Agent/untyped nodes are executable unless they are reserved built-in phases
  // (planning, verification, review, approval, merge) handled by dedicated runtime steps.
  const normalized = task.stage.toLowerCase();
  return !RESERVED_PHASE_STAGES.has(normalized);
}

const RESERVED_PHASE_STAGES = new Set([
  "plan",
  "planning",
  "verify",
  "verification",
  "review",
  "approval",
  "approval-ready",
  "merge",
  "complete",
]);

function sanitizePlannerOutput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\bWAITING_FOR_APPROVAL\b\s*$/m, "").trim() || undefined;
}

function buildPlannerPrompt(
  goal: string,
  config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } },
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  return [
    "Act as a Principal Software Architect.",
    `I want to build: ${goal}`,
    "Do not write implementation code.",
    "Do not inspect or modify files unless absolutely necessary.",
    "Produce a short architecture plan for this repository and then stop.",
    "",
    `Base branch: ${config.git.baseBranch}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "",
    "Return exactly these sections and keep each section concise:",
    "1. Requirements Breakdown",
    "2. Technical Stack & Libraries",
    "3. Architecture & File Structure",
    "4. Step-by-Step Implementation Plan",
    "5. Trade-offs & Edge Cases",
    "",
    "Constraints:",
    "- Maximum 20 bullet points total across the whole response.",
    "- Maximum 6 implementation steps.",
    "- Reference likely files/modules only when strongly justified by repository evidence.",
    "- Do not broaden scope beyond the requested outcome.",
    "- Do not propose unrelated documentation rewrites or adjacent cleanup unless clearly required.",
    "- Do not repeat the prompt or project guidance context.",
    "- End with exactly: WAITING_FOR_APPROVAL",
  ].filter(Boolean).join("\n");
}

function buildCompiledPrompt(goal: string, compiled: CompiledContext): string {
  const sections = [
    `Goal: ${goal}`,
    ...compiled.instructions,
    `Role: ${compiled.role}`,
  ];
  return sections.join("\n");
}

function buildBuilderPrompt(
  goal: string,
  task: { id: string; title: string; stage: string; dependsOn: string[] },
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Task id: ${task.id}`,
    `Task stage: ${task.stage}`,
    `Task title: ${task.title}`,
    task.dependsOn.length > 0 ? `Depends on: ${task.dependsOn.join(", ")}` : "Depends on: none",
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Implement only the requested task in this repository and leave the workspace ready for verification.",
    "Do not broaden scope, rewrite unrelated docs, or make verification-stage content edits unless truly necessary for this task.",
  ].filter(Boolean).join("\n");
}

function buildIntegrationRepairPrompt(
  goal: string,
  branch: string,
  conflictingFiles: string[],
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  return [
    `Goal: ${goal}`,
    `Integration conflict while merging branch: ${branch}`,
    `Conflicting files: ${conflictingFiles.join(", ")}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Resolve the active git merge conflict in the current workspace.",
    "Keep the original task scope, preserve intended changes from both sides when possible, and avoid unrelated edits.",
    "After resolving, leave the workspace with no unresolved merge conflicts.",
  ].filter(Boolean).join("\n");
}

function buildRepairPrompt(
  goal: string,
  verification: { cwd: string; overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string; stdout?: string; stderr?: string }> },
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  const failures = verification.commands
    .filter((command) => command.status === "failed")
    .map((command) => `${command.name}: ${firstNonEmpty(command.stderr, command.stdout, "failed")}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    `Verification cwd: ${verification.cwd}`,
    failures ? `Failures:\n${failures}` : "Failures: none recorded",
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Repair the code so verification can pass.",
    "Focus only on the observed failures and avoid unrelated edits.",
  ].filter(Boolean).join("\n");
}

function buildReviewerPrompt(
  goal: string,
  verification: { overallStatus: "passed" | "failed" | "incomplete"; commands: Array<{ name: string; status: string }> },
  constitutionContext?: string,
  skillBundleText?: string,
): string {
  const commandStatuses = verification.commands
    .map((command) => `${command.name}: ${command.status}`)
    .join("\n");

  return [
    `Goal: ${goal}`,
    `Verification status: ${verification.overallStatus}`,
    commandStatuses ? `Command results:\n${commandStatuses}` : "Command results: none",
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    "Review the candidate and report whether it looks ready for approval.",
    "Call out unrelated edits, scope creep, missing verification, and instruction drift explicitly.",
  ].filter(Boolean).join("\n");
}

function renderSkillBundleForPrompt(bundle: SkillBundleSelection): string | undefined {
  if (bundle.selected.length === 0) {
    return undefined;
  }
  return bundle.selected
    .map((item) => `- ${item.skill.id}@${item.skill.version}: ${item.reasons.slice(0, 2).join("; ")}`)
    .join("\n");
}

function summarizeSkillBundle(bundle: SkillBundleSelection): Record<string, unknown> {
  return {
    selected: bundle.selected.map((item) => ({
      id: item.skill.id,
      version: item.skill.version,
      provides: item.provides,
      reasons: item.reasons,
      score: item.score,
    })),
    rejected: bundle.rejected.map((item) => ({
      id: item.skill.id,
      version: item.skill.version,
      rejectedReason: item.rejectedReason,
      score: item.score,
    })),
    capabilityCoverage: bundle.capabilityCoverage,
    confidence: bundle.confidence,
  };
}

async function collectRuntimeSkillSignals(projectRoot: string): Promise<{
  languages: string[];
  dependencies: string[];
  frameworks: string[];
  constitutionAreas: number[];
}> {
  try {
    const discovery = await discoverConstitutionRepository(projectRoot);
    const dependencies = await readRepositoryDependencies(projectRoot, discovery.manifests);
    const frameworks = inferFrameworksFromDependencies(dependencies);
    return {
      languages: discovery.languages,
      dependencies,
      frameworks,
      constitutionAreas: inferRelevantConstitutionAreas(discovery),
    };
  } catch {
    return {
      languages: [],
      dependencies: [],
      frameworks: [],
      constitutionAreas: [],
    };
  }
}

async function readRepositoryDependencies(projectRoot: string, manifests: string[]): Promise<string[]> {
  const deps = new Set<string>();
  for (const manifest of manifests.filter((file) => /(^|\/)package\.json$/i.test(file)).slice(0, 8)) {
    try {
      const raw = await fs.readFile(path.join(projectRoot, manifest), "utf8");
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const name of Object.keys(parsed.dependencies ?? {})) {
        deps.add(name);
      }
      for (const name of Object.keys(parsed.devDependencies ?? {})) {
        deps.add(name);
      }
    } catch {
      // ignore malformed manifests while collecting broad skill signals
    }
  }
  return [...deps].sort();
}

function inferFrameworksFromDependencies(dependencies: string[]): string[] {
  const lower = new Set(dependencies.map((value) => value.toLowerCase()));
  const frameworks: string[] = [];
  if (lower.has("next")) frameworks.push("next");
  if (lower.has("react")) frameworks.push("react");
  if (lower.has("fastify")) frameworks.push("fastify");
  if (lower.has("express")) frameworks.push("express");
  if (lower.has("vitest")) frameworks.push("vitest");
  if (lower.has("jest")) frameworks.push("jest");
  if (lower.has("prisma") || lower.has("@prisma/client")) frameworks.push("prisma");
  if (lower.has("zod")) frameworks.push("zod");
  return frameworks;
}

function inferRelevantConstitutionAreas(discovery: { languages: string[]; commands: Record<string, string>; testFiles: string[]; sourceFiles: string[] }): number[] {
  const areas = new Set<number>([1, 2, 3, 18]);
  if (discovery.sourceFiles.length > 0) {
    areas.add(40);
  }
  if (Object.keys(discovery.commands).length > 0) {
    areas.add(73);
  }
  if (discovery.testFiles.length > 0) {
    areas.add(76);
  }
  if (discovery.languages.some((language) => /typescript|javascript/i.test(language))) {
    areas.add(43);
    areas.add(45);
  }
  return [...areas].sort((a, b) => a - b);
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
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
