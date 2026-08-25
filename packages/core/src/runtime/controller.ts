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
import { removeRunGitIsolation } from "../runs/cleanup.js";
import { appendRepoLearning } from "../learnings/store.js";
import {
  writePrototypeBuilderExecutionArtifact,
  writePrototypeDiscoveryExecutionArtifact,
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
import type { AgentExecutionResult, AgentExecutor } from "./interfaces.js";
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
import { appendDecisionLedgerEntry, findPendingDecision } from "../decisions/index.js";
import type { DecisionRequest, DecisionResult } from "../decisions/index.js";
import { gatherVerificationRequirements, initializeVerificationProviders, runVerificationEngine } from "../verification/index.js";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";
import { updatePrototypeTaskArtifact } from "./tasks.js";
import { classifyVerificationFailure } from "./failure-classification.js";
import { planVerificationExecution, runVerificationCommands } from "./verification.js";

export interface FactoryRunProgressEvent {
  runId: string;
  phase: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "BLOCKED" | "DECISION_REQUIRED";
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
  discoveryExecutor?: AgentExecutor;
  plannerExecutor?: AgentExecutor;
  builderExecutor?: AgentExecutor;
  repairExecutor?: AgentExecutor;
  reviewerExecutor?: AgentExecutor;
  verificationPlannerExecutor?: AgentExecutor;
  onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
  requestPlanApproval?: (input: { runId: string; goal: string; planPath: string; taskCount: number; workflowStages: string[]; summary: string; discoveryText?: string; planText?: string; tasks: PlannerTask[] }) => Promise<PlanApprovalResult>;
  requestApproval?: (input: { runId: string; goal: string; candidateSha?: string }) => Promise<boolean>;
  requestDecision?: (request: DecisionRequest) => Promise<DecisionResult>;
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
  discoveryExecutionPath?: string;
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
  let runDir: string | undefined;
  let projectRoot: string | undefined;
  let createdWorktreePath: string | undefined;
  let baseBranch: string | undefined;
  try {
    const result = await runFactoryControllerInner(input, (info) => {
      runDir = info.runDir;
      projectRoot = info.projectRoot;
      createdWorktreePath = info.createdWorktreePath;
      baseBranch = info.baseBranch;
    });
    return result;
  } finally {
    if (runDir && projectRoot) {
      const warnings: string[] = [];
      const outcome = await removeRunGitIsolation({
        runDir,
        projectRoot,
        pruneWorktrees: true,
        pruneBranches: true,
        baseBranch: baseBranch ?? "main",
      });
      warnings.push(...outcome.warnings);
      // The main run worktree is recorded in task-1 artifacts, but remove it
      // explicitly as well in case task artifacts were never written (early
      // failure before the planning phase).
      if (createdWorktreePath) {
        try {
          await execFileAsync("git", ["worktree", "remove", "--force", createdWorktreePath], {
            cwd: projectRoot,
            windowsHide: true,
          });
        } catch {
          // Best effort; git worktree prune in removeRunGitIsolation clears stale metadata.
        }
      }
      if (warnings.length > 0) {
        await appendFactoryRunEvent(path.join(runDir, "events.jsonl"), {
          timestamp: new Date().toISOString(),
          type: "run.cleanup_warnings",
          data: { warnings },
        });
      }
    }
  }
}

async function runFactoryControllerInner(
  input: RunFactoryControllerInput,
  onWorkspaceReady?: (info: { runDir: string; projectRoot: string; createdWorktreePath?: string; baseBranch: string }) => void,
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

  onWorkspaceReady?.({
    runDir: run.runDir,
    projectRoot,
    createdWorktreePath: worktree.mode === "created" ? worktree.path : undefined,
    baseBranch: loaded.effectiveConfig.git.baseBranch,
  });

  const phases = ["discovery", "planning", "plan-approval", "implementation", "integration", "verification", "repair", "verified", "review", "approval-ready", "merge", "complete"];
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

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "discovery", "Discovering relevant system context");

  const useConstitution = loaded.effectiveConfig.constitution.enabled;
  const discoveryGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
  const plannerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
  const builderGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "builder", goal: input.goal, useConstitution });
  const repairGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "repair", goal: input.goal, useConstitution });
  const reviewerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "reviewer", goal: input.goal, useConstitution });

  await initializeFactorySkills(projectRoot);
  const repoSkillSignals = await collectRuntimeSkillSignals(projectRoot);
  const discoverySkills = resolveFactorySkills({
    goal: input.goal,
    stage: "discover",
    taskKinds: ["repo-interpretation", "planning"],
    requiredCapabilities: ["repo-interpretation"],
    availableTools: ["read", "grep", "find", "ls"],
    ...repoSkillSignals,
  });
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
      discoveryInstructionFiles: discoveryGuidance.instructionFiles,
      builderInstructionFiles: builderGuidance.instructionFiles,
      repairInstructionFiles: repairGuidance.instructionFiles,
      reviewerInstructionFiles: reviewerGuidance.instructionFiles,
      plannerInstructionDetails: plannerGuidance.instructionDetails,
      discoveryInstructionDetails: discoveryGuidance.instructionDetails,
      builderInstructionDetails: builderGuidance.instructionDetails,
      repairInstructionDetails: repairGuidance.instructionDetails,
      reviewerInstructionDetails: reviewerGuidance.instructionDetails,
      plannerHasConstitution: plannerGuidance.hasConstitution,
      discoveryHasConstitution: discoveryGuidance.hasConstitution,
      builderHasConstitution: builderGuidance.hasConstitution,
      repairHasConstitution: repairGuidance.hasConstitution,
      reviewerHasConstitution: reviewerGuidance.hasConstitution,
      plannerUsedConstitution: plannerGuidance.usedConstitution,
      discoveryUsedConstitution: discoveryGuidance.usedConstitution,
      builderUsedConstitution: builderGuidance.usedConstitution,
      repairUsedConstitution: repairGuidance.usedConstitution,
      reviewerUsedConstitution: reviewerGuidance.usedConstitution,
      plannerGuidanceChars: plannerGuidance.approxChars,
      discoveryGuidanceChars: discoveryGuidance.approxChars,
      builderGuidanceChars: builderGuidance.approxChars,
      repairGuidanceChars: repairGuidance.approxChars,
      reviewerGuidanceChars: reviewerGuidance.approxChars,
    },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "skills.selected",
    data: {
      discovery: summarizeSkillBundle(discoverySkills),
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

  let discoveryExecutionPath: string | undefined;
  let discoveryOutputText: string | undefined;
  let discoveryFileHints: string[] = [];
  let plannerExecutionPath: string | undefined;
  let plannerOutputText: string | undefined;
  const discoveryExecutor = input.discoveryExecutor ?? input.plannerExecutor;
  if (discoveryExecutor) {
    const discoveryModel = resolveModelForRole({
      role: "discovery",
      taskType: runTaskType.id,
      config: loaded.effectiveConfig,
      runModelOverride: input.modelOverrides?.discovery,
    });
    await appendModelLedgerEntry(run.runDir, {
      operationId: `${run.runId}-discovery`,
      role: "discovery",
      taskType: runTaskType.id,
      taskTypeSource: runTaskType.source,
      taskTypeConfidence: runTaskType.confidence,
      requestedModel: discoveryModel.model.model,
      resolvedModel: discoveryModel.model.model,
      provider: discoveryModel.model.provider,
      modelSource: discoveryModel.source,
    });
    const discoveryEvidence = await buildDiscoveryEvidencePacket(executionCwd, input.goal);
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "discovery.evidence_collected",
      data: {
        observedFileCount: discoveryEvidence.observedFiles.length,
        candidateFileCount: discoveryEvidence.candidateFiles.length,
        snippetCount: discoveryEvidence.snippets.length,
        truncated: discoveryEvidence.truncated,
      },
    });
    const discoveryResult = await discoveryExecutor.execute({
      executionId: `${run.runId}-discovery`,
      cwd: executionCwd,
      prompt: buildDiscoveryPrompt(input.goal, discoveryGuidance.text, renderSkillBundleForPrompt(discoverySkills), discoveryEvidence),
      model: discoveryModel.model,
      tools: ["read", "grep", "find", "ls"],
      metadata: {
        role: "discovery",
        runId: run.runId,
        taskType: runTaskType.id,
      },
    });
    discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
    const discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
    if (!discoveryValidation.ok) {
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "discovery.invalid_output",
        data: {
          discoveryExecutionPath,
          reason: discoveryValidation.reason,
        },
      });
      await updateFactoryRunState({
        statePath: run.statePath,
        patch: { status: "FAILED", phase: "discovery-failed" },
      });
      throw new Error(`Discovery failed: ${discoveryValidation.reason}`);
    }
    discoveryOutputText = JSON.stringify(discoveryValidation.discovery, null, 2);
    discoveryFileHints = normalizeDiscoveryFileHints(discoveryValidation.discovery.files ?? []);
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "discovery.executor_completed",
      data: {
        discoveryExecutionPath,
        discoveryStatus: discoveryResult.status,
      },
    });
  }

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
      prompt: buildPlannerPrompt(input.goal, loaded.effectiveConfig, plannerGuidance.text, renderSkillBundleForPrompt(plannerSkills), discoveryOutputText),
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
    const plannerValidation = validatePlannerOutput(plannerOutputText);
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
    runDecisions: await loadRunDecisions(run.runDir),
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
  const implementationChangedFiles = uniqueStrings(taskWorkspacesChangedFiles(implementationRun.taskWorkspaces));
  const verificationFailureClassification = classifyVerificationFailure({
    plan: verificationPlan,
    result: verification,
    changedFiles: implementationChangedFiles,
  });
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
      implementationChangedFiles,
    },
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.completed",
    data: {
      overallStatus: verification.overallStatus,
      failureClassification: verificationFailureClassification as unknown as Record<string, unknown> | undefined,
      implementationChangedFiles,
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

  // Contract-based verification: gather requirements from all sources and run the engine.
  const contractPlan = gatherVerificationRequirements({
    goal: input.goal,
    taskType: runTaskType.id,
    config: loaded.effectiveConfig,
    skills: undefined,
    constitutionAreas: undefined,
    conflictAreas: repoSkillSignals.constitutionAreas,
    workflowId: loaded.effectiveConfig.resolvedWorkflowId,
    commands: loaded.effectiveConfig.commands,
    constitutionConflicts: await loadConstitutionConflicts(projectRoot),
  });
  initializeVerificationProviders({
    executor: input.reviewerExecutor,
    model: loaded.effectiveConfig.models.reviewer,
    goal: input.goal,
  } satisfies ReviewProviderOptions);
  let contractResult = await runVerificationEngine({
    cwd: executionCwd,
    plan: contractPlan,
  });
  verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
    ...verification,
    selectionSource: verificationPlan.selectionSource,
    rationale: verificationPlan.rationale,
    skill: verificationPlan.skill,
    evidence: verificationPlan.evidence,
    failureClassification: verificationFailureClassification,
    contract: buildContractArtifact(contractPlan, contractResult),
  });
  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "verification.contract_completed",
    data: {
      overallStatus: contractResult.overallStatus,
      canComplete: contractResult.canComplete,
      requirementCount: contractPlan.requirements.length,
      results: contractResult.results.map((result) => ({
        requirementId: result.requirementId,
        status: result.status,
        blocking: result.blocking,
        reason: result.reason,
      })),
      createdFrom: contractPlan.createdFrom,
    },
  });

  // If contract verification surfaced a human decision request, raise the gate.
  const pendingDecision = contractResult.results.find((result) => result.decision);
  if (pendingDecision?.decision) {
    await requestHumanDecision({
      controllerInput: input,
      runDir: run.runDir,
      statePath: run.statePath,
      eventsPath: run.eventsPath,
      runId: run.runId,
      request: pendingDecision.decision,
    });
  }

  const repairExecutor = input.repairExecutor;
  const shouldAttemptVerificationRepair = verification.overallStatus === "failed"
    && Boolean(repairExecutor)
    && loaded.effectiveConfig.repair.enabled
    && verificationFailureClassification?.kind === "real code failure";
  if (verification.overallStatus === "failed" && !shouldAttemptVerificationRepair) {
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "repair.skipped",
      data: {
        reason: verificationFailureClassification?.reason ?? "Verification failure is not eligible for repair.",
        failureKind: verificationFailureClassification?.kind,
        implementationChangedFiles,
      },
    });
  }

  if (shouldAttemptVerificationRepair && repairExecutor) {
    for (let attempt = 1; attempt <= loaded.effectiveConfig.repair.maxAttempts; attempt++) {
      await emitProgress(input, {
        runId: run.runId,
        phase: "repair",
        status: "RUNNING",
        message: `Repair attempt ${attempt}`,
      });
      const repairResult = await repairExecutor.execute({
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
      const changedAfterRepair = await gitChangedFiles(executionCwd);
      const recheckFailureClassification = classifyVerificationFailure({
        plan: verificationPlan,
        result: verification,
        changedFiles: uniqueStrings([...implementationChangedFiles, ...changedAfterRepair]),
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

      // Incremental contract re-verification: only re-run requirements affected by changed files.
      contractResult = await runVerificationEngine({
        cwd: executionCwd,
        plan: contractPlan,
        affectedFiles: changedAfterRepair,
      });
      verificationPath = await writePrototypeVerificationArtifact(run.runDir, {
        ...verification,
        selectionSource: verificationPlan.selectionSource,
        rationale: verificationPlan.rationale,
        skill: verificationPlan.skill,
        evidence: verificationPlan.evidence,
        failureClassification: recheckFailureClassification,
        contract: buildContractArtifact(contractPlan, contractResult),
      });
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "verification.contract_recheck",
        data: {
          attempt,
          overallStatus: contractResult.overallStatus,
          canComplete: contractResult.canComplete,
          affectedFiles: changedAfterRepair,
        },
      });

      if (verification.overallStatus !== "failed") {
        break;
      }
    }
  }

  let reviewerExecutionPath: string | undefined;

  // Transition to VERIFIED once command verification passed (or was repaired to pass).
  await movePhase(run.statePath, run.eventsPath, run.runId, input, "verified", "Candidate verified");

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

  // Contract completion gate: the run only proceeds to review/approval if the
  // contract verification can complete. Otherwise it is BLOCKED.
  if (!contractResult.canComplete) {
    const blockedState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "BLOCKED", phase: "verification-blocked" },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.blocked",
      data: {
        overallStatus: contractResult.overallStatus,
        failingRequirements: contractResult.results
          .filter((result) => result.blocking && result.status !== "PASS" && result.status !== "NOT_APPLICABLE")
          .map((result) => ({ requirementId: result.requirementId, status: result.status, reason: result.reason })),
      },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "verification-blocked",
      status: "BLOCKED",
      message: "Contract verification cannot complete; run blocked",
    });
    const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
      runId: run.runId,
      goal: input.goal,
      status: "BLOCKED",
      phase: blockedState.phase,
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
        discoveryExecutionPath,
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
      discoveryExecutionPath,
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
    discoveryExecutionPath,
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
  changedFiles?: string[];
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
  runDecisions?: Array<{ requestId: string; question: string; optionId: string; feedback?: string }>;
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
          runDecisions: input.runDecisions,
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
  runDecisions?: Array<{ requestId: string; question: string; optionId: string; feedback?: string }>;
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
        runDecisions: input.runDecisions,
        useConstitution: input.config.constitution.enabled,
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
      const executeBuilder = async (attempt: "initial" | "no-change-retry", previousResult?: AgentExecutionResult): Promise<{
        result: AgentExecutionResult;
        executionPath: string;
        committedChange: WorkspaceCommitResult;
      }> => {
        const executionId = attempt === "initial"
          ? `${input.runId}-${nodeRole}-${input.task.id}`
          : `${input.runId}-${nodeRole}-${input.task.id}-no-change-retry`;
        const prompt = attempt === "initial"
          ? buildCompiledPrompt(input.goal, compiled)
          : buildNoChangeRetryPrompt(input.goal, compiled, previousResult);
        const result = await executor.execute({
          executionId,
          cwd: workspace.path,
          prompt,
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
            attempt,
          },
        });

        const executionPath = await writePrototypeBuilderExecutionArtifact(input.runDir, {
          taskId: attempt === "initial" ? input.task.id : `${input.task.id}-no-change-retry`,
          workspacePath: workspace.path,
          workspaceBranch: workspace.branch,
          ...result,
        });
        input.builderExecutionPaths.push(executionPath);

        let committedChange: WorkspaceCommitResult = { committed: false, changedFiles: [] };
        if (result.status === "completed") {
          committedChange = await commitWorkspaceChanges(workspace.path, input.task);
        }

        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.executor_completed",
          data: {
            taskId: input.task.id,
            taskStage: input.task.stage,
            attempt,
            builderExecutionPath: executionPath,
            builderStatus: result.status,
            errorMessage: result.errorMessage,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            committed: committedChange.committed,
            changedFiles: committedChange.changedFiles,
          },
        });

        return { result, executionPath, committedChange };
      };

      let builderAttempt = await executeBuilder("initial");

      if (builderAttempt.result.status === "completed" && !builderAttempt.committedChange.committed) {
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.no_changes_retrying",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath: builderAttempt.executionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
            reason: "builder completed without producing file changes; retrying once with explicit implementation instructions",
          },
        });
        builderAttempt = await executeBuilder("no-change-retry", builderAttempt.result);
      }

      const builderResult = builderAttempt.result;
      const builderExecutionPath = builderAttempt.executionPath;
      const committedChange = builderAttempt.committedChange;
      workspace.changedFiles = committedChange.changedFiles;

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
            reason: builderResult.errorMessage ?? `builder executor returned ${builderResult.status}`,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        return { ok: false, task: input.task, workspace };
      }
      if (!committedChange.committed) {
        await updatePrototypeTaskArtifact({
          runDir: input.runDir,
          taskId: input.task.id,
          patch: { status: "failed" },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.no_changes",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            builderExecutionPath,
            workspacePath: workspace.path,
            workspaceBranch: workspace.branch,
          },
        });
        await appendFactoryRunEvent(input.eventsPath, {
          timestamp: new Date().toISOString(),
          type: "task.failed",
          data: {
            taskId: input.task.id,
            stage: input.task.stage,
            title: input.task.title,
            reason: "implementation produced no file changes",
            builderExecutionPath,
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

interface WorkspaceCommitResult {
  committed: boolean;
  changedFiles: string[];
}

async function commitWorkspaceChanges(cwd: string, task: PlannerTask): Promise<WorkspaceCommitResult> {
  try {
    const changedFiles = await readChangedFiles(cwd);
    if (changedFiles.length === 0) {
      return { committed: false, changedFiles };
    }
    await execFileAsync("git", ["add", "-A"], { cwd, windowsHide: true });
    await execFileAsync("git", ["commit", "-m", `Factory task ${task.id}: ${task.title}`], {
      cwd,
      windowsHide: true,
    });
    return { committed: true, changedFiles };
  } catch {
    return { committed: false, changedFiles: [] };
  }
}

async function readChangedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .filter(Boolean);
  } catch {
    return [];
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

function buildContractArtifact(plan: VerificationContractPlan, result: VerificationEngineResult): {
  plan: {
    requirements: Array<{ id: string; type: string; blocking: boolean; description: string; source: string; scope: string }>;
    createdFrom: VerificationContractPlan["createdFrom"];
  };
  results: Array<{ requirementId: string; blocking: boolean; status: string; evidence: Array<{ id: string; kind: string }>; reason?: string }>;
  evidenceStore: VerificationEngineResult["evidence"];
  overallStatus: string;
  canComplete: boolean;
} {
  return {
    plan: {
      requirements: plan.requirements.map((requirement) => ({
        id: requirement.id,
        type: requirement.type,
        blocking: requirement.blocking,
        description: requirement.description,
        source: requirement.source,
        scope: requirement.scope,
      })),
      createdFrom: plan.createdFrom,
    },
    results: result.results.map((item) => ({
      requirementId: item.requirementId,
      blocking: item.blocking,
      status: item.status,
      evidence: item.evidence,
      reason: item.reason,
    })),
    evidenceStore: result.evidence,
    overallStatus: result.overallStatus,
    canComplete: result.canComplete,
  };
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
  if (role === "discovery" || role === "planner" || role === "reviewer" || role === "repair" || role === "builder") {
    return role;
  }
  return "builder";
}

function attachDiscoveryFileHintsToBuildTasks(tasks: PlannerTask[], fileHints: string[]): void {
  const concreteHints = normalizeDiscoveryFileHints(fileHints);
  if (concreteHints.length === 0) {
    return;
  }

  for (const task of tasks) {
    if (!isBuildStage(task.stage) && task.role !== "builder") {
      continue;
    }
    task.context = {
      ...task.context,
      fileHints: uniqueStrings([...(task.context?.fileHints ?? []), ...concreteHints]),
    };
  }
}

function normalizeDiscoveryFileHints(fileHints: string[]): string[] {
  return uniqueStrings(
    fileHints
      .map(normalizeDiscoveryFilePath)
      .filter((file): file is string => Boolean(file)),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function taskWorkspacesChangedFiles(workspaces: TaskWorkspaceSelection[]): string[] {
  return workspaces.flatMap((workspace) => workspace.changedFiles ?? []);
}

function isBuildStage(stage: string): boolean {
  const normalized = stage.toLowerCase();
  return normalized === "build" || normalized === "implementation";
}

function roleTools(role: ModelRole): string[] {
  if (role === "builder" || role === "repair") {
    return ["read", "write", "edit", "bash", "grep", "find", "ls"];
  }
  return ["read", "grep", "find", "ls"];
}

function isExecutableWorkflowNode(task: PlannerTask): boolean {
  // Built-in phases are handled by dedicated controller code, regardless of
  // whether the workflow node is typed as an agent or command.
  const normalized = task.stage.toLowerCase();
  if (RESERVED_PHASE_STAGES.has(normalized)) {
    return false;
  }
  const type = task.type;
  if (type === "command" || type === "task-graph") {
    return true;
  }
  if (type === "approval") {
    return false;
  }
  return true;
}

const RESERVED_PHASE_STAGES = new Set([
  "discover",
  "discovery",
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

function validatePlannerOutput(value: string | undefined): { ok: true } | { ok: false; reason: string } {
  const text = value?.toLowerCase() ?? "";
  if (!text) {
    return { ok: true };
  }
  const broadDiscoveryLanguage = [
    "search for",
    "find where",
    "locate the",
    "identify the relevant file",
    "identify the exact file",
    "find the files",
    "bounded evidence check",
  ];
  const match = broadDiscoveryLanguage.find((term) => text.includes(term));
  if (match) {
    return { ok: false, reason: `Planner delegated broad discovery to Builder: "${match}"` };
  }
  return { ok: true };
}

interface DiscoveryContract {
  status: "complete" | "failed";
  files?: string[];
  evidence?: Array<{ status: "confirmed" | "inferred" | "unknown"; file?: string; finding: string }>;
  unknowns?: string[];
  reason?: string;
}

interface DiscoveryEvidencePacket {
  root: string;
  observedFiles: string[];
  candidateFiles: string[];
  snippets: Array<{
    file: string;
    line: number;
    text: string;
    matched: string;
  }>;
  terms: string[];
  truncated: boolean;
}

async function validateDiscoveryOutput(value: string | undefined, cwd: string, evidencePacket: DiscoveryEvidencePacket): Promise<{ ok: true; discovery: DiscoveryContract } | { ok: false; reason: string }> {
  const text = value?.trim() ?? "";
  if (!text) {
    return { ok: false, reason: "Discovery returned no output" };
  }
  if (/^DISCOVERY_FAILED:/i.test(text)) {
    return { ok: false, reason: text.replace(/^DISCOVERY_FAILED:\s*/i, "").trim() || "Discovery failed" };
  }

  const parsed = parseDiscoveryJson(text);
  if (!parsed) {
    return { ok: false, reason: "Discovery returned invalid structured JSON" };
  }
  if (parsed.status === "failed") {
    return { ok: false, reason: parsed.reason?.trim() || "Discovery failed" };
  }
  if (parsed.status !== "complete") {
    return { ok: false, reason: "Discovery status must be complete or failed" };
  }

  const files = Array.isArray(parsed.files) ? parsed.files : [];
  if (!files.some(isConcreteFile)) {
    return { ok: false, reason: "Discovery did not identify any concrete implementation file" };
  }
  const missingFiles = await findMissingDiscoveryFiles(cwd, files);
  if (missingFiles.length > 0) {
    return { ok: false, reason: `Discovery identified files that do not exist: ${missingFiles.join(", ")}` };
  }
  const unobservedFiles = findUnobservedDiscoveryFiles(files, evidencePacket);
  if (unobservedFiles.length > 0) {
    return { ok: false, reason: `Discovery referenced files not observed by Factory evidence: ${unobservedFiles.join(", ")}` };
  }

  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (!evidence.some((item) => item?.status === "confirmed" && isConcreteFile(item.file) && item.finding?.trim())) {
    return { ok: false, reason: "Discovery did not provide confirmed evidence tied to a concrete file" };
  }
  const evidenceFiles = evidence
    .filter((item) => item?.status === "confirmed" && item.finding?.trim())
    .map((item) => item.file)
    .filter((file): file is string => isConcreteFile(file));
  const missingEvidenceFiles = await findMissingDiscoveryFiles(cwd, evidenceFiles);
  if (missingEvidenceFiles.length > 0) {
    return { ok: false, reason: `Discovery evidence references files that do not exist: ${missingEvidenceFiles.join(", ")}` };
  }
  const unobservedEvidenceFiles = findUnobservedDiscoveryFiles(evidenceFiles, evidencePacket);
  if (unobservedEvidenceFiles.length > 0) {
    return { ok: false, reason: `Discovery evidence references files not observed by Factory evidence: ${unobservedEvidenceFiles.join(", ")}` };
  }

  return { ok: true, discovery: parsed };
}

function findUnobservedDiscoveryFiles(files: string[], evidencePacket: DiscoveryEvidencePacket): string[] {
  const observed = new Set(evidencePacket.observedFiles);
  return [...new Set(files
    .map(normalizeDiscoveryFilePath)
    .filter((file): file is string => Boolean(file))
    .filter((file) => !observed.has(file)))];
}

async function buildDiscoveryEvidencePacket(cwd: string, goal: string): Promise<DiscoveryEvidencePacket> {
  const terms = extractDiscoveryTerms(goal);
  const observedFiles = await collectDiscoveryFiles(cwd);
  const scored = new Map<string, { score: number; snippets: DiscoveryEvidencePacket["snippets"] }>();

  for (const file of observedFiles) {
    const pathScore = scoreDiscoveryPath(file, terms);
    if (pathScore > 0) {
      scored.set(file, { score: pathScore, snippets: [] });
    }
  }

  for (const file of observedFiles) {
    if (!shouldInspectDiscoveryFile(file)) {
      continue;
    }
    const snippets = await collectDiscoverySnippets(path.join(cwd, file), file, terms);
    if (snippets.length === 0) {
      continue;
    }
    const existing = scored.get(file) ?? { score: 0, snippets: [] };
    existing.score += 10 + snippets.length;
    existing.snippets.push(...snippets);
    scored.set(file, existing);
  }

  const candidateFiles = [...scored.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([file]) => file);
  const candidateSet = new Set(candidateFiles);
  const snippets = [...scored.entries()]
    .filter(([file]) => candidateSet.has(file))
    .flatMap(([, value]) => value.snippets)
    .slice(0, 120);

  return {
    root: cwd,
    observedFiles,
    candidateFiles,
    snippets,
    terms,
    truncated: observedFiles.length >= DISCOVERY_MAX_FILES,
  };
}

const DISCOVERY_MAX_FILES = 5000;
const DISCOVERY_MAX_FILE_BYTES = 240_000;

async function collectDiscoveryFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  await walk(cwd, "");
  return files.sort();

  async function walk(current: string, relativeDir: string): Promise<void> {
    if (files.length >= DISCOVERY_MAX_FILES) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!shouldSkipDiscoveryDirectory(entry.name, relativePath)) {
          await walk(path.join(current, entry.name), relativePath);
        }
        continue;
      }
      if (!entry.isFile() || !isConcreteFile(relativePath)) {
        continue;
      }
      files.push(relativePath);
      if (files.length >= DISCOVERY_MAX_FILES) {
        return;
      }
    }
  }
}

function shouldSkipDiscoveryDirectory(name: string, relativePath: string): boolean {
  return name === ".git"
    || name === ".factory"
    || name === ".worktrees"
    || name === "node_modules"
    || name === ".next"
    || name === "dist"
    || name === "build"
    || name === "coverage"
    || relativePath === "vendor/pi-factory";
}

function extractDiscoveryTerms(goal: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "into", "that", "this", "those", "these", "make", "add", "run", "use",
    "using", "update", "remove", "delete", "change", "fix", "create", "show", "hide", "page", "site", "app",
  ]);
  const terms = new Set<string>();
  for (const raw of goal.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 3 || stopwords.has(raw)) {
      continue;
    }
    terms.add(raw);
    if (raw.endsWith("ies") && raw.length > 4) {
      terms.add(`${raw.slice(0, -3)}y`);
    } else if (raw.endsWith("s") && raw.length > 3) {
      terms.add(raw.slice(0, -1));
    }
  }
  return [...terms];
}

function scoreDiscoveryPath(file: string, terms: string[]): number {
  const lower = file.toLowerCase();
  let score = /(^|\/)(package\.json|factory\.yaml|\.factory\/config\.yaml)$/.test(lower) ? 1 : 0;
  for (const term of terms) {
    if (lower.includes(term)) {
      score += lower.split("/").at(-1)?.includes(term) ? 8 : 4;
    }
  }
  return score;
}

function shouldInspectDiscoveryFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|json|md|mdx|yaml|yml|css|scss|html)$/i.test(file);
}

async function collectDiscoverySnippets(
  absolutePath: string,
  relativePath: string,
  terms: string[],
): Promise<DiscoveryEvidencePacket["snippets"]> {
  if (terms.length === 0) {
    return [];
  }
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > DISCOVERY_MAX_FILE_BYTES) {
      return [];
    }
    const raw = await fs.readFile(absolutePath, "utf8");
    if (raw.includes("\u0000")) {
      return [];
    }
    const snippets: DiscoveryEvidencePacket["snippets"] = [];
    const lines = raw.split(/\r?\n/);
    for (let index = 0; index < lines.length && snippets.length < 4; index += 1) {
      const line = lines[index] ?? "";
      const matched = terms.find((term) => line.toLowerCase().includes(term));
      if (!matched) {
        continue;
      }
      snippets.push({
        file: relativePath,
        line: index + 1,
        text: line.trim().slice(0, 220),
        matched,
      });
    }
    return snippets;
  } catch {
    return [];
  }
}

async function findMissingDiscoveryFiles(cwd: string, files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    const normalized = normalizeDiscoveryFilePath(file);
    if (!normalized) {
      continue;
    }
    if (!await fileExists(path.join(cwd, normalized))) {
      missing.push(normalized);
    }
  }
  return [...new Set(missing)];
}

function normalizeDiscoveryFilePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const filePath = value.trim().replace(/`/g, "");
  if (!isConcreteFile(filePath)) {
    return undefined;
  }
  return filePath;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseDiscoveryJson(text: string): DiscoveryContract | undefined {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as DiscoveryContract;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {}
  return undefined;
}

function isConcreteFile(value: string | undefined): boolean {
  if (!value) return false;
  const filePath = value.trim().replace(/`/g, "");
  if (!filePath || filePath.endsWith("/")) return false;
  if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).includes("..")) return false;
  if (/^(src|components|frontend|backend|course files)$/i.test(filePath)) return false;
  if (/^(AGENTS|README|CONSTITUTION)\.md$/i.test(filePath)) return false;
  if (filePath.includes("node_modules/")) return false;
  if (filePath.includes("/AGENTS.md") || filePath.includes("/README.md") || filePath.includes("/CONSTITUTION.md")) return false;
  return /(^|\/)(package\.json|factory\.yaml|\.factory\/config\.yaml)$/.test(filePath)
    || /\.[A-Za-z0-9]+$/.test(filePath);
}

function buildDiscoveryPrompt(
  goal: string,
  constitutionContext?: string,
  skillBundleText?: string,
  evidencePacket?: DiscoveryEvidencePacket,
): string {
  return [
    "Role: Discovery",
    "",
    "Your job is to identify the concrete repository files/components/data/config surfaces needed for a separate Planning phase.",
    "You are in Discovery only. Use the repository evidence packet as authoritative filesystem truth.",
    "",
    "Do not:",
    "- implement anything",
    "- modify files",
    "- write code",
    "- create an implementation plan",
    "- recommend a solution prematurely",
    "- return likely candidates, possible sources, or searches for Builder to run",
    "- invent file paths",
    "- mark a finding confirmed unless it is supported by the evidence packet",
    "- stop after a preamble",
    "",
    "Objective:",
    "- Find the concrete files involved.",
    "- Return evidence from those files.",
    "- Capture only unknowns that remain after read-only inspection.",
    "- Prefer files from candidate_files. You may list another file only if it appears in observed_files.",
    "",
    `User task: ${goal}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    evidencePacket ? `Repository evidence packet (authoritative):\n${renderDiscoveryEvidencePacket(evidencePacket)}` : undefined,
    "",
    "Return JSON only, with this exact shape:",
    "{",
    "  \"status\": \"complete\",",
    "  \"files\": [\"src/path/to/file.ts\"],",
    "  \"evidence\": [",
    "    { \"status\": \"confirmed\", \"file\": \"src/path/to/file.ts\", \"finding\": \"What this file proves\" }",
    "  ],",
    "  \"unknowns\": []",
    "}",
    "",
    "A concrete file is a real file path like src/data/courses.ts, src/components/UpcomingCourses.tsx, package.json, factory.yaml, or .factory/config.yaml.",
    "A directory such as src/, components/, frontend/, backend/, or course files is not a concrete file.",
    "Evidence must include at least one confirmed item tied to a concrete file.",
    "Every file in files[] must appear in observed_files from the repository evidence packet.",
    "Every confirmed evidence file must appear in observed_files from the repository evidence packet.",
    "",
    "If you cannot identify a concrete implementation surface after using the available read-only tools, return exactly:",
    "DISCOVERY_FAILED: Could not identify the implementation surface.",
  ].filter(Boolean).join("\n");
}

function renderDiscoveryEvidencePacket(packet: DiscoveryEvidencePacket): string {
  const observedForPrompt = packet.observedFiles.slice(0, 700);
  return [
    `root: ${packet.root}`,
    `terms: ${packet.terms.join(", ") || "none"}`,
    `observed_file_count: ${packet.observedFiles.length}`,
    packet.truncated ? "observed_files_truncated: true" : "observed_files_truncated: false",
    "candidate_files:",
    ...(packet.candidateFiles.length > 0 ? packet.candidateFiles.map((file) => `- ${file}`) : ["- none"]),
    "matching_snippets:",
    ...(packet.snippets.length > 0
      ? packet.snippets.map((snippet) => `- ${snippet.file}:${snippet.line} [${snippet.matched}] ${snippet.text}`)
      : ["- none"]),
    "observed_files:",
    ...observedForPrompt.map((file) => `- ${file}`),
    packet.observedFiles.length > observedForPrompt.length
      ? `- ... ${packet.observedFiles.length - observedForPrompt.length} more observed files omitted from prompt`
      : undefined,
  ].filter(Boolean).join("\n");
}

function buildPlannerPrompt(
  goal: string,
  config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } },
  constitutionContext?: string,
  skillBundleText?: string,
  discoveryReport?: string,
): string {
  return [
    "You are an expert Principal Software Architect and Lead Project Planner.",
    "Your job is to turn the validated Discovery result and project guidance into a clear execution contract for the Builder.",
    `Task: ${goal}`,
    "Do not write implementation code.",
    "Do not perform broad repository discovery here; Discovery already gathered the evidence.",
    "Produce a concrete, repository-grounded implementation plan and then stop.",
    "",
    `Base branch: ${config.git.baseBranch}`,
    `Approval policy: ${config.approval.finalMerge}`,
    `Repair attempts: ${config.repair.maxAttempts}`,
    skillBundleText ? `Selected skills:\n${skillBundleText}` : undefined,
    constitutionContext ? `Project guidance context:\n${constitutionContext}` : undefined,
    discoveryReport ? `Validated Discovery result (authoritative pre-planning evidence):\n${discoveryReport}` : undefined,
    "",
    "Discovery has already inspected the repository.",
    "Use the supplied Discovery evidence as your repository context.",
    "Do not ask Builder to find, locate, search for, or identify implementation files.",
    "Create the implementation sequence using the concrete files already identified.",
    "A narrow inspection of an identified file is allowed when needed before editing.",
    "",
    "Produce the plan with exactly these sections:",
    "",
    "1. PLANNING DECISIONS",
    "- Restate the outcome in one sentence.",
    "- Name the confirmed files, components, data sources, commands, or config surfaces the Builder should use.",
    "- State the chosen approach and why it fits the existing system.",
    "- Call out any non-negotiable constraints from the user, config, or project guidance.",
    "",
    "2. IMPLEMENTATION SEQUENCE",
    "- Break the work into small, sequential, and testable steps labeled Step 1, Step 2, etc.",
    "- Ensure each step builds logically on the previous one.",
    "- For each step, say exactly what kind of file/component/config change the Builder should make.",
    "- Do not make the first step a broad search, location, or file-identification step.",
    "- A narrow read/inspection step is allowed only for concrete files named by Discovery.",
    "",
    "3. VERIFICATION CONTRACT",
    "- List the exact checks, commands, or manual assertions that should prove the change works.",
    "- Tie each check to the risk or requirement it covers.",
    "- If a configured command is not appropriate, explain why and choose the weakest valid verification that still gives useful signal.",
    "",
    "4. RISKS AND BLOCKERS",
    "- List concrete risks, such as stale content, bad selectors, broken links, unavailable models, invalid commands, dependency issues, or verification gaps.",
    "- Provide a mitigation or fallback for each risk.",
    "- Mark user decisions as blockers only when Builder cannot safely proceed without them.",
    "",
    "Constraints:",
    "- Be specific. Avoid vague phrases like 'likely touchpoints' when Discovery provided concrete evidence.",
    "- For content/UI tasks, name the discovered files/components/data sources that should change.",
    "- Do not claim a file, route, dependency, command, or framework exists unless it is supported by the Discovery result or project guidance context.",
    "- Do not delegate broad discovery to Builder with phrases like 'search for', 'find where', 'locate the', or 'identify the relevant file'.",
    "- Do not broaden scope beyond the requested outcome.",
    "- Do not propose unrelated documentation rewrites or adjacent cleanup unless clearly required.",
    "- Do not repeat the prompt, Discovery Report, or project guidance context.",
    "- Keep the plan concise but operational: the Builder should know where to start, what to change, and how to verify.",
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

function buildNoChangeRetryPrompt(
  goal: string,
  compiled: CompiledContext,
  previousResult?: AgentExecutionResult,
): string {
  const previousOutput = previousResult?.outputText?.trim();
  const previousSummary = previousOutput
    ? `Previous builder output:\n${previousOutput.slice(0, 2000)}`
    : "Previous builder output: (empty)";
  return [
    buildCompiledPrompt(goal, compiled),
    "",
    "Factory implementation retry:",
    "Your previous implementation turn completed without any file changes.",
    previousSummary,
    "",
    "You are still in the Builder role.",
    "Do not stop after saying what you will inspect or change.",
    "Use the available native Pi tools now to edit/write the required files in the current workspace.",
    "If implementation is impossible, return a clear failure reason instead of completing successfully.",
  ].join("\n");
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

async function loadConstitutionConflicts(projectRoot: string): Promise<Array<{ areas: number[]; message: string }>> {
  try {
    const raw = await fs.readFile(path.join(projectRoot, ".factory", "constitution", "facts.json"), "utf8");
    const facts = JSON.parse(raw) as { areas?: Array<{ id?: number; claims?: Array<{ kind?: string; statement?: string }> }> };
    const conflicts = new Map<string, number[]>();
    for (const area of facts.areas ?? []) {
      for (const claim of area.claims ?? []) {
        if (claim.kind === "conflict" && claim.statement) {
          const areas = conflicts.get(claim.statement) ?? [];
          if (typeof area.id === "number" && !areas.includes(area.id)) {
            areas.push(area.id);
          }
          conflicts.set(claim.statement, areas);
        }
      }
    }
    return [...conflicts.entries()].map(([message, areas]) => ({ message, areas }));
  } catch {
    return [];
  }
}

async function loadRunDecisions(runDir: string): Promise<Array<{ requestId: string; question: string; optionId: string; feedback?: string }>> {
  const { readDecisionLedger } = await import("../decisions/index.js");
  const entries = await readDecisionLedger(runDir).catch(() => []);
  const resolutions: Array<{ type: "resolution"; result: { requestId: string; optionId: string; feedback?: string } }> = [];
  const requests = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "request") {
      requests.set(entry.request.id, entry.request.question);
    } else if (entry.type === "resolution") {
      resolutions.push(entry as { type: "resolution"; result: { requestId: string; optionId: string; feedback?: string } });
    }
  }
  return resolutions.map((entry) => ({
    requestId: entry.result.requestId,
    question: requests.get(entry.result.requestId) ?? entry.result.requestId,
    optionId: entry.result.optionId,
    ...(entry.result.feedback ? { feedback: entry.result.feedback } : {}),
  }));
}

async function requestHumanDecision(input: {
  controllerInput: RunFactoryControllerInput;
  runDir: string;
  statePath: string;
  eventsPath: string;
  runId: string;
  request: DecisionRequest;
}): Promise<DecisionResult> {
  // Persist the request first (audit + resume point).
  await appendDecisionLedgerEntry(input.runDir, { type: "request", request: input.request });

  // Pause the run in DECISION_REQUIRED state so a restart knows what it was waiting for.
  await updateFactoryRunState({
    statePath: input.statePath,
    patch: { status: "DECISION_REQUIRED", phase: `decision-${input.request.source.toLowerCase()}` },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "decision.required",
    data: {
      decisionRequestId: input.request.id,
      title: input.request.title,
      question: input.request.question,
      options: input.request.options.map((option) => option.id),
      evidenceRefs: input.request.evidenceRefs ?? [],
      source: input.request.source,
      reason: input.request.reason,
    },
  });
  await emitProgress(input.controllerInput, {
    runId: input.runId,
    phase: `decision-${input.request.source.toLowerCase()}`,
    status: "DECISION_REQUIRED",
    message: `Decision required: ${input.request.title}`,
  });

  // Reuse a persisted resolution if this request was already decided (resume case).
  const pending = await findPendingDecision(input.runDir);
  if (!pending) {
    throw new Error(`Decision request '${input.request.id}' has no pending state; cannot resume.`);
  }

  const decide = input.controllerInput.requestDecision;
  if (!decide) {
    throw new Error(`Decision required ('${input.request.id}') but no requestDecision handler is configured.`);
  }
  const result = await decide(pending);

  // Persist the resolution and resume.
  await appendDecisionLedgerEntry(input.runDir, { type: "resolution", result });
  await updateFactoryRunState({
    statePath: input.statePath,
    patch: { status: "RUNNING", phase: "running" },
  });
  await appendFactoryRunEvent(input.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "decision.resolved",
    data: {
      decisionRequestId: result.requestId,
      optionId: result.optionId,
      feedback: result.feedback,
    },
  });
  await emitProgress(input.controllerInput, {
    runId: input.runId,
    phase: "running",
    status: "RUNNING",
    message: `Decision resolved: ${result.optionId}`,
  });

  return result;
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
