// The run controller phase machine — extracted from controller.ts so that
// file is just the public API surface (types + runFactoryController entry).
// All orchestration logic lives here; sibling modules hold the machinery.

import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFileReferences, FileResolutionError } from "./file-resolution.js";
import { selectConstitutionContext } from "../constitution/index.js";
import { createFactoryRun, appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import { writePrototypeSummaryArtifact, writePrototypeDiscoveryExecutionArtifact, writePrototypePlannerExecutionArtifact, writePrototypeTaskArtifacts, writePrototypePlanArtifact, writePrototypeVerificationArtifact, writePrototypeReviewerExecutionArtifact, writePrototypeRepairExecutionArtifact } from "./artifacts.js";
import { loadEffectiveConfig } from "../config/loader.js";
import { initializeFactorySkills, resolveFactorySkills } from "../skills/index.js";
import { applyWorkflowSkillPolicy, collectRuntimeSkillSignals, resolveNodeSkillBundle, summarizeSkillBundle, slugifyGoal } from "./skills.js";
import { createGitWorktree, inspectGitIsolation } from "../git/worktree.js";
import { hydrateWorkspaceDependencies, DependencyHydrationError } from "./dependencies.js";
import { buildDependencyCacheEnv } from "./dependency-cache.js";
import { buildPlanArtifact, extractImplementationContract } from "./planner.js";
import { resolveModelForRole, classifyTaskType, taskTypeMatchPaths, type TaskTypeSelection } from "../models/index.js";
import { gatherVerificationRequirements, initializeVerificationProviders, runVerificationEngine } from "../verification/index.js";
import { normalizeVerificationCommands, planVerificationExecution, runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { classifyVerificationFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { classifyVerificationFailuresWithAI, type ClassificationSource } from "./ai-failure-classifier.js";
import { validateDiscoveryOutput, buildDiscoveryEvidencePacket, shouldRetryDiscoveryJsonRepair, buildDiscoveryJsonRepairPrompt, normalizeDiscoveryFilePath, type DiscoveryContract, type DiscoveryEvidencePacket } from "./discovery-validate.js";
import { buildCompiledPrompt, buildNoChangeRetryPrompt, buildIntegrationRepairPrompt, buildRepairPrompt, buildEnvironmentPrepPrompt, buildReviewerPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { readGitConflictFiles, hasGitMergeInProgress, resolveTaskWorkspace, commitWorkspaceChanges, readChangedFiles, readGitHeadSha } from "./git-ops.js";
import { uniqueStrings, taskWorkspacesChangedFiles, isBuildStage, roleTools, isExecutableWorkflowNode, findBuiltInWorkflowStage } from "./task-utils.js";
import { movePhase, emitProgress, wait, requestHumanDecision, loadConstitutionConflicts, loadRunDecisions } from "./phase-plumbing.js";
import { runImplementationTasks } from "./implementation.js";
import { runIntegrationPhase, classifyIntegrationFailure } from "./integration-phase.js";
import { runFinalMergePhase } from "./final-merge.js";
import { buildContractArtifact, failureSignature, resolveRunTaskTypeWithPaths, gitChangedFiles, filterVerificationByImpact, getChangedFilesFromBase } from "./verification-planning.js";
import { sanitizePlannerOutput, validatePlannerOutput, validatePlannerOutputWithLLM } from "./planner-validate.js";
import { normalizeDiscoveryFileHints, attachDiscoveryFileHintsToBuildTasks } from "./controller.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, InterviewDecisionRecord, FactoryRunProgressEvent, TaskWorkspaceSelection, PlanApprovalResult } from "./controller.js";
import { runVerificationRepairLoop, attemptEnvironmentPreparation, failBuiltInSkillPolicy, buildRunFailureResult } from "./controller-helpers.js";
import { runInterviewStages, buildDiscoveryPrompt, buildPlannerPrompt } from "./controller-interview.js";
import type { AgentExecutor, AgentExecutionResult } from "./interfaces.js";
import type { EffectiveFactoryConfig, ModelRole, ModelSelection, WorkflowStage, CapabilityPolicy } from "@factory/schemas";
import type { AutonomyLevel } from "../capabilities/index.js";
import type { SkillBundleSelection, SkillCandidate } from "../skills/index.js";
import type { PlannerTask, ImplementationContract } from "./planner.js";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";
import { runFinalPhases } from "./controller-final-phases.js";
import { runVerificationPhase } from "./verification-phase2.js";
import { runImplementationPhase } from "./implementation-phase.js";
import { runControllerIntegration } from "./controller-integration.js";

export async function runFactoryControllerInner(
  input: RunFactoryControllerInput,
  onWorkspaceReady?: (info: { runDir: string; projectRoot: string; createdWorktreePath?: string; baseBranch: string }) => void,
): Promise<RunFactoryControllerResult> {
  const loaded = await loadEffectiveConfig({
    cwd: input.cwd,
    runOverrides: input.workflowId ? { workflowId: input.workflowId } : undefined,
  });
  const root = path.dirname(loaded.sources.projectConfigPath ?? path.join(input.cwd, ".factory", "config.yaml"));
  const projectRoot = path.dirname(root);

  // ── File resolution: handle @-referenced files before worktree creation ──
  let fileResolutionResult: Awaited<ReturnType<typeof resolveFileReferences>> | undefined;
  try {
    fileResolutionResult = await resolveFileReferences({
      cwd: input.cwd,
      goal: input.goal,
      executor: input.discoveryExecutor ?? input.plannerExecutor,
      model: input.modelOverrides?.discovery ?? input.modelOverrides?.planner,
      runId: undefined, // run not created yet
    });
  } catch (error) {
    if (error instanceof FileResolutionError) {
      throw error;
    }
    // Non-fatal: log and proceed — discovery will catch missing files
  }

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
  let builderExecutionPaths: string[] = [];
  let integrationPath: string | undefined;
  let finalMergePath: string | undefined;
  let candidateSha: string | undefined;
  let repairExecutionPaths: string[] = [];

  await appendFactoryRunEvent(run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "run.goal_received",
    data: { goal: input.goal },
  });

  if (fileResolutionResult && fileResolutionResult.status !== "no-references") {
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "file_resolution.completed",
      data: {
        status: fileResolutionResult.status,
        resolutionSource: fileResolutionResult.resolutionSource,
        evidenceCount: fileResolutionResult.evidence.length,
        appliedCount: fileResolutionResult.appliedActions.length,
        blockers: fileResolutionResult.plan?.blockers,
        rationale: fileResolutionResult.rationale,
      },
    });
  }

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

  try {
    await hydrateWorkspaceDependencies({
      workspacePath: executionCwd,
      projectRoot,
      config: loaded.effectiveConfig,
      runId: run.runId,
      phase: "workspace",
      onEvent: async (event) => appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: event.type,
        data: event.data,
      }),
      onRemediation: input.requestDependencyRemediation,
      mode: "agent",
    });
  } catch (error) {
    const failedState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "dependency-hydration-failed" },
    });
    const reason = error instanceof DependencyHydrationError
      ? error.message
      : `Dependency hydration failed: ${error instanceof Error ? error.message : String(error)}`;
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.failed",
      data: { reason },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: failedState.phase,
      status: "FAILED",
      message: reason,
    });
    const summaryPath = await writePrototypeSummaryArtifact(run.runDir, {
      runId: run.runId,
      goal: input.goal,
      status: "FAILED",
      phase: failedState.phase,
      approved: false,
      planPath: path.join(run.runDir, "plan.json"),
      taskPaths: [],
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
      planPath: path.join(run.runDir, "plan.json"),
      taskPaths: [],
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      verificationPath: path.join(run.runDir, "verification.json"),
      summaryPath,
    };
  }

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "discovery", "Discovering relevant system context");

  const useConstitution = loaded.effectiveConfig.constitution.enabled;
  const discoveryGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
  const plannerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "planner", goal: input.goal, useConstitution });
  const builderGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "builder", goal: input.goal, useConstitution });
  const repairGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "repair", goal: input.goal, useConstitution });
  const reviewerGuidance = await selectConstitutionContext({ cwd: projectRoot, role: "reviewer", goal: input.goal, useConstitution });

  await initializeFactorySkills(projectRoot);
  const repoSkillSignals = await collectRuntimeSkillSignals(projectRoot);
  const workflowStages = loaded.effectiveConfig.resolvedWorkflow?.stages ?? [];
  const discoveryStage = findBuiltInWorkflowStage(workflowStages, ["discover", "discovery"]);
  const plannerStage = findBuiltInWorkflowStage(workflowStages, ["plan", "planning"]);
  const interviewStages = workflowStages.filter((stage) => stage.type === "interview");

  let discoverySkills = resolveFactorySkills({
    goal: input.goal,
    stage: "discover",
    taskKinds: ["repo-interpretation", "planning"],
    requiredCapabilities: ["repo-interpretation"],
    availableTools: ["read", "grep", "find", "ls"],
    ...repoSkillSignals,
  });
  let plannerSkills = resolveFactorySkills({
    goal: input.goal,
    stage: "plan",
    taskKinds: ["planning", "repo-interpretation"],
    requiredCapabilities: ["repo-interpretation", "architecture-planning"],
    availableTools: ["read", "grep", "find", "ls"],
    ...repoSkillSignals,
  });

  const discoveryPolicy = applyWorkflowSkillPolicy(discoverySkills, discoveryStage?.skills);
  if (!discoveryPolicy.ok) {
    await failBuiltInSkillPolicy({
      run,
      input,
      phase: "discovery-failed",
      stage: discoveryStage?.name ?? "discover",
      missingRequired: discoveryPolicy.missingRequired,
    });
    throw new Error(`Discovery failed: Missing required workflow skill(s): ${discoveryPolicy.missingRequired.join(", ")}`);
  }
  discoverySkills = discoveryPolicy.bundle;

  const plannerPolicy = applyWorkflowSkillPolicy(plannerSkills, plannerStage?.skills);
  if (!plannerPolicy.ok) {
    await failBuiltInSkillPolicy({
      run,
      input,
      phase: "planning-failed",
      stage: plannerStage?.name ?? "plan",
      missingRequired: plannerPolicy.missingRequired,
    });
    throw new Error(`Planning failed: Missing required workflow skill(s): ${plannerPolicy.missingRequired.join(", ")}`);
  }
  plannerSkills = plannerPolicy.bundle;
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
    let discoveryResult = await discoveryExecutor.execute({
      executionId: `${run.runId}-discovery`,
      cwd: executionCwd,
      prompt: buildDiscoveryPrompt(input.goal, discoveryGuidance.text, renderSkillBundleForPrompt(discoverySkills), discoveryEvidence),
      model: discoveryModel.model,
      tools: ["read", "grep", "find", "ls"],
      limits: loaded.effectiveConfig.runtime.limits,
      metadata: {
        role: "discovery",
        runId: run.runId,
        taskType: runTaskType.id,
      },
    });
    discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
    let discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
    if (discoveryResult.status === "completed" && !discoveryValidation.ok && shouldRetryDiscoveryJsonRepair(discoveryValidation.reason, discoveryResult.outputText)) {
      const invalidDiscoveryExecutionPath = path.join(run.runDir, "discovery-execution-invalid.json");
      await fs.writeFile(invalidDiscoveryExecutionPath, JSON.stringify(discoveryResult, null, 2), "utf8");
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "discovery.json_repair_retrying",
        data: {
          discoveryExecutionPath: invalidDiscoveryExecutionPath,
          reason: discoveryValidation.reason,
        },
      });
      discoveryResult = await discoveryExecutor.execute({
        executionId: `${run.runId}-discovery-json-repair`,
        cwd: executionCwd,
        prompt: buildDiscoveryJsonRepairPrompt(discoveryResult.outputText),
        model: discoveryModel.model,
        tools: [],
        limits: loaded.effectiveConfig.runtime.limits,
        metadata: {
          role: "discovery",
          runId: run.runId,
          taskType: runTaskType.id,
          attempt: "json-repair",
        },
      });
      discoveryExecutionPath = await writePrototypeDiscoveryExecutionArtifact(run.runDir, discoveryResult);
      discoveryValidation = await validateDiscoveryOutput(discoveryResult.outputText, executionCwd, discoveryEvidence);
    }
    if (!discoveryValidation.ok) {
      const reason = discoveryResult.status === "completed"
        ? discoveryValidation.reason
        : discoveryResult.errorMessage?.trim() || `Discovery executor ${discoveryResult.status}`;
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "discovery.invalid_output",
        data: {
          discoveryExecutionPath,
          reason,
          discoveryStatus: discoveryResult.status,
          errorMessage: discoveryResult.errorMessage,
        },
      });
      await updateFactoryRunState({
        statePath: run.statePath,
        patch: { status: "FAILED", phase: "discovery-failed" },
      });
      throw new Error(`Discovery failed: ${reason}`);
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

  const interviewResult = await runInterviewStages({
    stages: interviewStages,
    run,
    input,
    executionCwd,
    goal: input.goal,
    config: loaded.effectiveConfig,
    plannerGuidanceText: plannerGuidance.text,
    plannerSkills,
    runTaskType,
    discoveryOutputText,
  });
  const interviewContext = interviewResult.text;
  const interviewExecutionPath = interviewResult.executionPath;
  const interviewDecisions = interviewResult.decisions ?? [];

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

  let implementationRun: Awaited<ReturnType<typeof runImplementationTasks>>;
  const implementationPhase = await runImplementationPhase({
    run,
    input,
    loaded,
    executionCwd,
    projectRoot,
    worktree,
    phases,
    delayMs,
    plan,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    plannerSkills,
    builderSkills,
    reviewerSkills,
    repairSkills,
    runTaskType,
    discoveryExecutionPath,
    interviewDecisions,
  });
  if ("runId" in implementationPhase) {
    return implementationPhase;
  }
  implementationRun = implementationPhase.implementationRun;
  builderExecutionPaths = implementationPhase.builderExecutionPaths;
  integrationPath = implementationPhase.integrationPath;
  const controllerIntegration = await runControllerIntegration({
    run,
    input,
    loaded,
    executionCwd,
    worktree,
    phases,
    delayMs,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    repairExecutionPaths,
    integrationPath,
    repairGuidanceText: repairGuidance.text ?? "",
    repairSkills,
    implementationRun,
  });
  if ("runId" in controllerIntegration) {
    return controllerIntegration;
  }
  integrationPath = controllerIntegration.integrationPath;
  let verificationPath: string;
  let verification: VerificationRunResult;
  let verificationFailureClassification: VerificationFailureClassification | undefined;
  let contractResult: VerificationEngineResult;
  const verificationPhase = await runVerificationPhase({
    run,
    input,
    loaded,
    executionCwd,
    projectRoot,
    worktree,
    phases,
    delayMs,
    planPath,
    taskPaths,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    discoveryExecutionPath,
    runTaskType,
    repoSkillSignals,
    repairGuidanceText: repairGuidance.text ?? "",
    repairSkills,
    implementationRun,
    interviewDecisions,
  });
  if ("runId" in verificationPhase) {
    return verificationPhase;
  }
  verificationPath = verificationPhase.verificationPath;
  repairExecutionPaths = verificationPhase.repairExecutionPaths;
  verification = verificationPhase.verification;
  verificationFailureClassification = verificationPhase.verificationFailureClassification;
  contractResult = verificationPhase.contractResult;
  const finalResult = await runFinalPhases({
    run,
    input,
    loaded,
    executionCwd,
    worktree,
    phases,
    delayMs,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    integrationPath,
    repairExecutionPaths,
    verificationPath,
    verification,
    verificationFailureClassification,
    contractResult,
    reviewerGuidanceText: reviewerGuidance.text ?? "",
    reviewerSkills,
    interviewDecisions,
  });
  return finalResult;
}