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
import { hydrateWorkspaceDependencies, buildDependencyCacheEnv, DependencyHydrationError } from "./dependencies.js";
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
import { runImplementationTasks, runIntegrationPhase, runFinalMergePhase, classifyIntegrationFailure } from "./implementation.js";
import { buildContractArtifact, failureSignature, resolveRunTaskTypeWithPaths, gitChangedFiles, filterVerificationByImpact, getChangedFilesFromBase } from "./verification-planning.js";
import { sanitizePlannerOutput, validatePlannerOutput, validatePlannerOutputWithLLM } from "./planner-validate.js";
import { normalizeDiscoveryFileHints, attachDiscoveryFileHintsToBuildTasks } from "./controller.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, InterviewDecisionRecord, FactoryRunProgressEvent, TaskWorkspaceSelection, PlanApprovalResult } from "./controller.js";
import type { AgentExecutor, AgentExecutionResult } from "./interfaces.js";
import type { EffectiveFactoryConfig, ModelRole, ModelSelection, WorkflowStage, CapabilityPolicy } from "@factory/schemas";
import type { AutonomyLevel } from "../capabilities/index.js";
import type { SkillBundleSelection, SkillCandidate } from "../skills/index.js";
import type { PlannerTask, ImplementationContract } from "./planner.js";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";

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
  const builderExecutionPaths: string[] = [];
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
  try {
    await hydrateWorkspaceDependencies({
      workspacePath: executionCwd,
      projectRoot,
      config: loaded.effectiveConfig,
      runId: run.runId,
      phase: "verification",
      onEvent: async (event) => appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: event.type,
        data: event.data,
      }),
      onRemediation: input.requestDependencyRemediation,
      mode: "agent",
    });
  } catch (error) {
    const reason = error instanceof DependencyHydrationError
      ? error.message
      : `Dependency hydration failed: ${error instanceof Error ? error.message : String(error)}`;
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "run.failed",
      data: { reason },
    });
    const failedState = await updateFactoryRunState({
      statePath: run.statePath,
      patch: { status: "FAILED", phase: "verification-failed" },
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
  const { setup: _setupCommand, ...verificationCommands } = loaded.effectiveConfig.commands;
  const normalizedCommands = normalizeVerificationCommands(verificationCommands);
  // Impact-based verification: filter checks to only those affected by changes.
  const changedFiles = await getChangedFilesFromBase(executionCwd, loaded.effectiveConfig.git.baseBranch);
  const impactResult = filterVerificationByImpact(normalizedCommands as Record<string, string>, changedFiles);
  if (impactResult.skipped.length > 0) {
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.impact_filtered",
      data: {
        changedFiles,
        selectedChecks: impactResult.selected,
        skippedChecks: impactResult.skipped,
      },
    });
  }
  const filteredVerificationCommands = impactResult.commands;
  const verificationPlan = await planVerificationExecution({
    cwd: executionCwd,
    goal: input.goal,
    commands: filteredVerificationCommands,
    constitutionContext: repairGuidance.text,
    executor: input.verificationPlannerExecutor,
    model: loaded.effectiveConfig.models.planner,
    runId: run.runId,
    allowDeterministicFallback: !input.verificationPlannerExecutor,
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
    env: loaded.effectiveConfig.dependencies.enabled && loaded.effectiveConfig.dependencies.hydrate !== "never"
      ? await buildDependencyCacheEnv(loaded.effectiveConfig.dependencies.cacheRoot)
      : undefined,
  });
  verification.cwdResolution = verificationPlan.cwdResolution;
  const implementationChangedFiles = uniqueStrings(taskWorkspacesChangedFiles(implementationRun.taskWorkspaces));
  const deterministicClassification = classifyVerificationFailure({
    plan: verificationPlan,
    result: verification,
    changedFiles: implementationChangedFiles,
  });
  // LLM classification over deterministic evidence, with strict guards; falls back silently.
  const aiResult = deterministicClassification
    ? await classifyVerificationFailuresWithAI({
        plan: verificationPlan,
        result: verification,
        changedFiles: implementationChangedFiles,
        deterministic: deterministicClassification,
        executor: input.failureClassifierExecutor ?? input.reviewerExecutor,
        model: loaded.effectiveConfig.models.reviewer,
      })
    : undefined;
  let verificationFailureClassification = aiResult
    ? { ...aiResult, classificationSource: "ai" as ClassificationSource, deterministicClassification }
    : deterministicClassification
      ? { ...deterministicClassification, classificationSource: "deterministic" as ClassificationSource }
      : undefined as VerificationFailureClassification | undefined;
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
    commands: verificationPlan.commands,
    constitutionConflicts: await loadConstitutionConflicts(projectRoot),
  });
  initializeVerificationProviders({
    executor: input.reviewerExecutor,
    model: loaded.effectiveConfig.models.reviewer,
    goal: input.goal,
  } satisfies ReviewProviderOptions);

  // Skip contract requirements for commands already classified baseline-unrelated (ignore).
  // The failure classifier is the authority: a pre-existing repo failure marked ignore
  // should not re-block the contract completion gate.
  const ignoredCommandNames = new Set(
    (verificationFailureClassification?.perCommand ?? [])
      .filter((c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore")
      .map((c) => c.commandName),
  );
  if (ignoredCommandNames.size > 0) {
    contractPlan.requirements = contractPlan.requirements.filter((requirement) => {
      if (requirement.type !== "COMMAND") {
        return true;
      }
      return !ignoredCommandNames.has(requirement.description.replace(/^Run /, "").toLowerCase());
    });
  }

  let contractResult = await runVerificationEngine({
    cwd: verificationPlan.cwd,
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
  const environmentPrepState = await attemptEnvironmentPreparation({
    run,
    input,
    repairExecutor,
    repairModel: loaded.effectiveConfig.models.repair,
    repairEnabled: loaded.effectiveConfig.repair.enabled,
    verificationPlan,
    implementationChangedFiles,
    verification,
    verificationFailureClassification,
  });
  verification = environmentPrepState.verification;
  verificationFailureClassification = environmentPrepState.verificationFailureClassification;
  const shouldAttemptEnvPrep = environmentPrepState.shouldAttemptEnvPrep;
  const repairableFailures = verificationFailureClassification?.perCommand
    .filter((c) => c.category === "real-code-failure" && c.suggestedAction === "repair") ?? [];
  const shouldAttemptVerificationRepair = verification.overallStatus === "failed"
    && Boolean(repairExecutor)
    && loaded.effectiveConfig.repair.enabled
    && repairableFailures.length > 0;
  if (verification.overallStatus === "failed" && !shouldAttemptVerificationRepair && !shouldAttemptEnvPrep) {
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
    const repairState = await runVerificationRepairLoop({
      run,
      input,
      repairConfig: loaded.effectiveConfig.repair,
      repairModel: loaded.effectiveConfig.models.repair,
      repairGuidanceText: repairGuidance.text ?? "",
      repairSkillsBundleText: renderSkillBundleForPrompt(repairSkills),
      verificationPlan,
      contractPlan,
      implementationChangedFiles,
      executionCwd,
      verification,
      verificationFailureClassification,
      verificationPath,
      contractResult,
      repairExecutionPaths,
    });
    verification = repairState.verification;
    verificationFailureClassification = repairState.verificationFailureClassification;
    verificationPath = repairState.verificationPath;
    contractResult = repairState.contractResult;
    repairExecutionPaths = repairState.repairExecutionPaths;
  }

  let reviewerExecutionPath: string | undefined;

  // Baseline-unrelated failures (pre-existing repo issues, not caused by the task)
  // warn and proceed instead of failing the run.
  const allFailuresBaseline = verification.overallStatus === "failed"
    && Boolean(verificationFailureClassification)
    && verificationFailureClassification!.perCommand.length > 0
    && verificationFailureClassification!.perCommand.every(
      (c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore",
    );

  if (verification.overallStatus === "failed" && allFailuresBaseline) {
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.baseline_warning",
      data: {
        reason: verificationFailureClassification?.reason,
        perCommand: verificationFailureClassification?.perCommand,
      },
    });
    await emitProgress(input, {
      runId: run.runId,
      phase: "verification",
      status: "RUNNING",
      message: `Verification warnings (baseline-unrelated): ${verificationFailureClassification?.reason ?? "pre-existing repo issues"}`,
    });
    await appendRepoLearning({
      projectRoot,
      category: "verification-baseline-warning",
      summary: verificationFailureClassification?.reason ?? "Baseline-unrelated verification failure",
      data: {
        perCommand: verificationFailureClassification?.perCommand,
      },
    });
  } else if (verification.overallStatus === "failed") {
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

    return buildRunFailureResult({
      run,
      executionCwd,
      worktree,
      phases,
      planPath,
      taskPaths,
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      summaryPath,
    });
  }

  // Verified: only after all required checks pass.
  await movePhase(run.statePath, run.eventsPath, run.runId, input, "verified", "Candidate verified");

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

    return buildRunFailureResult({
      run,
      executionCwd,
      worktree,
      phases,
      planPath,
      taskPaths,
      plannerExecutionPath,
      builderExecutionPaths,
      integrationPath,
      repairExecutionPaths,
      reviewerExecutionPath,
      verificationPath,
      summaryPath,
    });
  }

  await wait(delayMs);

  await movePhase(run.statePath, run.eventsPath, run.runId, input, "review", "Reviewing verified candidate");
  if (input.reviewerExecutor) {
    const reviewerResult = await input.reviewerExecutor.execute({
      executionId: `${run.runId}-reviewer`,
      cwd: executionCwd,
      prompt: buildReviewerPrompt(input.goal, verification, reviewerGuidance.text, renderSkillBundleForPrompt(reviewerSkills), interviewDecisions),
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

      return buildRunFailureResult({
        run,
        executionCwd,
        worktree,
        phases,
        planPath,
        taskPaths,
        plannerExecutionPath,
        builderExecutionPaths,
        integrationPath,
        repairExecutionPaths,
        reviewerExecutionPath,
        verificationPath,
        summaryPath,
      });
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

  const baselineDebt = (verificationFailureClassification?.perCommand ?? [])
    .filter((c) => c.category === "baseline-unrelated" || c.suggestedAction === "ignore")
    .map((c) => ({
      commandName: c.commandName,
      category: c.category,
      reason: c.reason,
      suggestedAction: c.suggestedAction,
      ...(c.implicatedFiles?.length ? { implicatedFiles: c.implicatedFiles } : {}),
    }));
  const approved = (await input.requestApproval?.({
    runId: run.runId,
    goal: input.goal,
    candidateSha,
    baselineDebt: baselineDebt.length > 0 ? baselineDebt : undefined,
    contractComplete: contractResult.canComplete,
    verificationStatus: verification.overallStatus,
  })) ?? true;
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

    return buildRunFailureResult({
      run,
      executionCwd,
      worktree,
      phases,
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
    });
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

interface VerificationRepairLoopContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  repairConfig: EffectiveFactoryConfig["repair"];
  repairModel: ModelSelection | undefined;
  repairGuidanceText: string;
  repairSkillsBundleText: string | undefined;
  verificationPlan: VerificationPlan;
  contractPlan: VerificationContractPlan;
  implementationChangedFiles: string[];
  executionCwd: string;
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
  verificationPath: string;
  contractResult: VerificationEngineResult;
  repairExecutionPaths: string[];
}

export async function runVerificationRepairLoop(
  context: VerificationRepairLoopContext,
): Promise<Pick<VerificationRepairLoopContext, "verification" | "verificationFailureClassification" | "verificationPath" | "contractResult" | "repairExecutionPaths">> {
  const {
    run,
    input,
    repairConfig,
    repairModel,
    repairGuidanceText,
    repairSkillsBundleText,
    verificationPlan,
    contractPlan,
    implementationChangedFiles,
    executionCwd,
  } = context;
  let {
    verification,
    verificationFailureClassification,
    verificationPath,
    contractResult,
    repairExecutionPaths,
  } = context;
  const repairExecutor = input.repairExecutor;

  // Signature-driven repair: keep going while the failure changes (progress), stop when
  // the same failure signature repeats maxAttempts times (stalled), capped absolutely.
  const absoluteCap = Math.max(repairConfig.maxAttempts, repairConfig.maxTotalAttempts ?? 10);
  let stallCount = 0;
  let lastSignature: string | null = null;
  let attempt = 0;
  while (attempt < absoluteCap) {
    attempt += 1;
    await emitProgress(input, {
      runId: run.runId,
      phase: "repair",
      status: "RUNNING",
      message: `Repair attempt ${attempt}`,
    });
    if (!repairExecutor) break;
    const repairResult = await repairExecutor.execute({
      executionId: `${run.runId}-repair-${attempt}`,
      cwd: verification.cwd,
      prompt: buildRepairPrompt(
        input.goal,
        verification,
        repairGuidanceText,
        repairSkillsBundleText,
        verificationFailureClassification?.suggestedGeneralFix ?? verificationFailureClassification?.rootCause,
      ),
      model: repairModel,
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

    const recheckVerification = await runVerificationCommands({
      cwd: verificationPlan.cwd,
      commands: verificationPlan.commands,
    });
    recheckVerification.cwdResolution = verificationPlan.cwdResolution;
    const changedAfterRepair = await gitChangedFiles(executionCwd);
    const recheckFailureClassification = classifyVerificationFailure({
      plan: verificationPlan,
      result: recheckVerification,
      changedFiles: uniqueStrings([...implementationChangedFiles, ...changedAfterRepair]),
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.recheck_completed",
      data: {
        attempt,
        overallStatus: recheckVerification.overallStatus,
        verificationPath,
      },
    });

    // Incremental contract re-verification: only re-run requirements affected by changed files.
    const recheckContractResult = await runVerificationEngine({
      cwd: verificationPlan.cwd,
      plan: contractPlan,
      affectedFiles: changedAfterRepair,
    });
    const recheckVerificationPath = await writePrototypeVerificationArtifact(run.runDir, {
      ...recheckVerification,
      selectionSource: verificationPlan.selectionSource,
      rationale: verificationPlan.rationale,
      skill: verificationPlan.skill,
      evidence: verificationPlan.evidence,
      failureClassification: recheckFailureClassification,
      contract: buildContractArtifact(contractPlan, recheckContractResult),
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "verification.contract_recheck",
      data: {
        attempt,
        overallStatus: recheckContractResult.overallStatus,
        canComplete: recheckContractResult.canComplete,
        affectedFiles: changedAfterRepair,
      },
    });

    // Commit this attempt's state so the next iteration (and caller) sees it.
    verification = recheckVerification;
    verificationFailureClassification = recheckFailureClassification;
    verificationPath = recheckVerificationPath;
    contractResult = recheckContractResult;

    if (verification.overallStatus !== "failed") {
      break;
    }
    // Stalled detection: same failure signature repeated maxAttempts times.
    const signature = failureSignature(verification);
    if (signature === lastSignature) {
      stallCount += 1;
    } else {
      stallCount = 0;
    }
    lastSignature = signature;
    if (stallCount >= repairConfig.maxAttempts) {
      await appendFactoryRunEvent(run.eventsPath, {
        timestamp: new Date().toISOString(),
        type: "repair.stalled",
        data: { attempt, stallCount, signature },
      });
      break;
    }
  }

  return {
    verification,
    verificationFailureClassification,
    verificationPath,
    contractResult,
    repairExecutionPaths,
  };
}

interface EnvironmentPreparationContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  input: RunFactoryControllerInput;
  repairExecutor: AgentExecutor | undefined;
  repairModel: ModelSelection | undefined;
  repairEnabled: boolean;
  verificationPlan: VerificationPlan;
  implementationChangedFiles: string[];
  verification: VerificationRunResult;
  verificationFailureClassification: VerificationFailureClassification | undefined;
}

export async function attemptEnvironmentPreparation(
  context: EnvironmentPreparationContext,
): Promise<Pick<EnvironmentPreparationContext, "verification" | "verificationFailureClassification"> & { shouldAttemptEnvPrep: boolean }> {
  const {
    run,
    input,
    repairExecutor,
    repairModel,
    repairEnabled,
    verificationPlan,
    implementationChangedFiles,
  } = context;
  let {
    verification,
    verificationFailureClassification,
  } = context;

  const environmentFailures = verificationFailureClassification?.perCommand
    .filter((c) => c.suggestedAction === "prepare-environment") ?? [];
  const shouldAttemptEnvPrep = verification.overallStatus === "failed"
    && Boolean(repairExecutor)
    && repairEnabled
    && environmentFailures.length > 0;
  if (shouldAttemptEnvPrep && repairExecutor) {
    await emitProgress(input, {
      runId: run.runId,
      phase: "environment-preparation",
      status: "RUNNING",
      message: `Preparing environment for: ${environmentFailures.map((f) => f.commandName).join(", ")}`,
    });
    const envResult = await repairExecutor.execute({
      executionId: `${run.runId}-env-prep`,
      cwd: verification.cwd,
      prompt: buildEnvironmentPrepPrompt(verification.cwd, environmentFailures),
      model: repairModel,
      tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
      metadata: { role: "repair", purpose: "environment-preparation", runId: run.runId },
    });
    await appendFactoryRunEvent(run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "environment.prep_completed",
      data: { status: envResult.status },
    });
    if (envResult.status === "completed") {
      verification = await runVerificationCommands({ cwd: verificationPlan.cwd, commands: verificationPlan.commands });
      verification.cwdResolution = verificationPlan.cwdResolution;
      const recheck = classifyVerificationFailure({ plan: verificationPlan, result: verification, changedFiles: implementationChangedFiles });
      verificationFailureClassification = recheck
        ? { ...recheck, classificationSource: "deterministic" as ClassificationSource }
        : undefined;
    }
  }

  return {
    verification,
    verificationFailureClassification,
    shouldAttemptEnvPrep,
  };
}

interface RunFailureResultContext {
  run: Awaited<ReturnType<typeof createFactoryRun>>;
  executionCwd: string;
  worktree: RunFactoryControllerResult["worktree"];
  phases: string[];
  planPath: string;
  taskPaths: string[];
  discoveryExecutionPath?: string;
  plannerExecutionPath?: string;
  builderExecutionPaths: string[];
  integrationPath?: string;
  repairExecutionPaths: string[];
  reviewerExecutionPath?: string;
  verificationPath: string;
  summaryPath: string;
  candidateSha?: string;
  finalMergePath?: string;
}

export function buildRunFailureResult(context: RunFailureResultContext): RunFactoryControllerResult {
  return {
    runId: context.run.runId,
    runDir: context.run.runDir,
    executionCwd: context.executionCwd,
    worktree: context.worktree,
    statePath: context.run.statePath,
    eventsPath: context.run.eventsPath,
    phases: context.phases,
    approved: false,
    planPath: context.planPath,
    taskPaths: context.taskPaths,
    discoveryExecutionPath: context.discoveryExecutionPath,
    plannerExecutionPath: context.plannerExecutionPath,
    builderExecutionPaths: context.builderExecutionPaths,
    integrationPath: context.integrationPath,
    finalMergePath: context.finalMergePath,
    candidateSha: context.candidateSha,
    repairExecutionPaths: context.repairExecutionPaths,
    reviewerExecutionPath: context.reviewerExecutionPath,
    verificationPath: context.verificationPath,
    summaryPath: context.summaryPath,
  };
}

export async function failBuiltInSkillPolicy(input: {
  run: { runId: string; statePath: string; eventsPath: string };
  input: RunFactoryControllerInput;
  phase: string;
  stage: string;
  missingRequired: string[];
}): Promise<void> {
  await appendFactoryRunEvent(input.run.eventsPath, {
    timestamp: new Date().toISOString(),
    type: "task.skill_policy_failed",
    data: {
      stage: input.stage,
      missingRequiredSkills: input.missingRequired,
    },
  });
  await updateFactoryRunState({
    statePath: input.run.statePath,
    patch: { status: "FAILED", phase: input.phase },
  });
  await emitProgress(input.input, {
    runId: input.run.runId,
    phase: input.phase,
    status: "FAILED",
    message: `Missing required workflow skill(s): ${input.missingRequired.join(", ")}`,
  });
}

export async function runInterviewStages(input: {
  stages: WorkflowStage[];
  run: { runId: string; runDir: string; statePath: string; eventsPath: string };
  input: RunFactoryControllerInput;
  executionCwd: string;
  goal: string;
  config: EffectiveFactoryConfig;
  plannerGuidanceText?: string;
  plannerSkills: SkillBundleSelection;
  runTaskType: TaskTypeSelection;
  discoveryOutputText?: string;
}): Promise<{ text?: string; executionPath?: string; decisions?: InterviewDecisionRecord[] }> {
  const answers: string[] = [];
  let lastExecutionPath: string | undefined;
  const structuredDecisions: InterviewDecisionRecord[] = [];
  for (const stage of input.stages) {
    const role = stage.role ?? "planner";
    const executor = executorForRole(input.input, role);
    if (!executor) {
      throw new Error(`Interview stage '${stage.name}' requires a ${role} executor, but none is configured.`);
    }
    const skillPolicy = applyWorkflowSkillPolicy(input.plannerSkills, stage.skills);
    if (!skillPolicy.ok) {
      await failBuiltInSkillPolicy({
        run: input.run,
        input: input.input,
        phase: "interview-failed",
        stage: stage.name,
        missingRequired: skillPolicy.missingRequired,
      });
      throw new Error(`Interview failed: Missing required workflow skill(s): ${skillPolicy.missingRequired.join(", ")}`);
    }
    await movePhase(input.run.statePath, input.run.eventsPath, input.run.runId, input.input, "interview", `Interviewing before planning: ${stage.name}`);
    const model = resolveModelForRole({
      role,
      taskType: input.runTaskType.id,
      config: input.config,
      nodeModel: stage.model,
      runModelOverride: input.input.modelOverrides?.[role],
    });
    await appendModelLedgerEntry(input.run.runDir, {
      operationId: `${input.run.runId}-${role}-${stage.name}`,
      nodeId: stage.name,
      role,
      taskType: input.runTaskType.id,
      taskTypeSource: input.runTaskType.source,
      taskTypeConfidence: input.runTaskType.confidence,
      requestedModel: model.model.model,
      resolvedModel: model.model.model,
      provider: model.model.provider,
      modelSource: model.source,
    });
    const result = await executor.execute({
      executionId: `${input.run.runId}-${role}-${slugifyGoal(stage.name)}`,
      cwd: input.executionCwd,
      prompt: buildInterviewPrompt({
        goal: input.goal,
        stage,
        guidanceText: input.plannerGuidanceText,
        skillBundleText: renderSkillBundleForPrompt(skillPolicy.bundle),
        discoveryReport: input.discoveryOutputText,
      }),
      model: model.model,
      tools: ["read", "grep", "find", "ls"],
      metadata: {
        role,
        runId: input.run.runId,
        taskType: input.runTaskType.id,
        stage: stage.name,
      },
    });
    const artifactPath = path.join(input.run.runDir, `${slugifyGoal(stage.name)}-interview-execution.json`);
    await fs.writeFile(artifactPath, JSON.stringify(result, null, 2), "utf8");
    lastExecutionPath = artifactPath;
    await appendFactoryRunEvent(input.run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "interview.executor_completed",
      data: {
        stage: stage.name,
        role,
        interviewExecutionPath: artifactPath,
        interviewStatus: result.status,
      },
    });
    const output = result.outputText.trim();
    if (!output || /INTERVIEW_COMPLETE/i.test(output)) {
      continue;
    }
    const decision = await requestHumanDecision({
      controllerInput: input.input,
      runDir: input.run.runDir,
      statePath: input.run.statePath,
      eventsPath: input.run.eventsPath,
      runId: input.run.runId,
      request: {
        id: `${input.run.runId}-${slugifyGoal(stage.name)}-interview`,
        title: `Interview: ${stage.name}`,
        question: output,
        context: "Answer the interview questions. Factory will include your answer in the planner prompt before producing the implementation plan.",
        options: [
          {
            id: "answered",
            label: "Use my answer",
            description: "Continue to planning with the feedback/answer provided.",
          },
        ],
        source: "INTERVIEW",
        reason: "USER_PREFERENCE",
      },
    });
    answers.push([
      `Stage: ${stage.name}`,
      `Interview prompt/questions:\n${output}`,
      `Selected option: ${decision.optionId}`,
      decision.feedback ? `User answer:\n${decision.feedback}` : undefined,
    ].filter(Boolean).join("\n"));
    structuredDecisions.push({
      stage: stage.name,
      role,
      question: output,
      optionId: decision.optionId,
      answer: decision.feedback,
      decisionRequestId: decision.requestId,
    });
  }
  // Persist structured interview decisions for downstream stages.
  if (structuredDecisions.length > 0) {
    const artifactPath = path.join(input.run.runDir, "interview-decisions.json");
    await fs.writeFile(artifactPath, JSON.stringify(structuredDecisions, null, 2), "utf8");
    await appendFactoryRunEvent(input.run.eventsPath, {
      timestamp: new Date().toISOString(),
      type: "interview.decisions_written",
      data: { artifactPath, decisionCount: structuredDecisions.length },
    });
  }
  return { text: answers.length > 0 ? answers.join("\n\n") : undefined, executionPath: lastExecutionPath, decisions: structuredDecisions };
}

export function executorForRole(input: RunFactoryControllerInput, role: ModelRole): AgentExecutor | undefined {
  switch (role) {
    case "discovery":
      return input.discoveryExecutor ?? input.plannerExecutor;
    case "planner":
      return input.plannerExecutor;
    case "builder":
      return input.builderExecutor;
    case "reviewer":
      return input.reviewerExecutor;
    case "repair":
      return input.repairExecutor;
  }
}

export function buildInterviewPrompt(input: {
  goal: string;
  stage: WorkflowStage;
  guidanceText?: string;
  skillBundleText?: string;
  discoveryReport?: string;
}): string {
  return [
    "Role: Interview",
    "",
    "Your job is to ask the user the questions needed before Factory plans implementation.",
    "Do not implement code. Do not write the implementation plan.",
    "If no user interview is needed, return exactly: INTERVIEW_COMPLETE",
    "",
    `Task: ${input.goal}`,
    `Interview stage: ${input.stage.name}`,
    input.stage.description ? `Stage description: ${input.stage.description}` : undefined,
    input.skillBundleText ? `Selected skills:\n${input.skillBundleText}` : undefined,
    input.guidanceText ? `Project guidance context:\n${input.guidanceText}` : undefined,
    input.discoveryReport ? `Validated Discovery result:\n${input.discoveryReport}` : undefined,
    "",
    "Ask concise, answerable questions. Prefer one round of high-impact questions.",
    "The user answer will be recorded and passed into the planner.",
  ].filter(Boolean).join("\n");
}

export function buildDiscoveryPrompt(
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

export function renderDiscoveryEvidencePacket(packet: DiscoveryEvidencePacket): string {
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

export function buildPlannerPrompt(
  goal: string,
  config: { git: { baseBranch: string }; approval: { finalMerge: string }; repair: { maxAttempts: number } },
  constitutionContext?: string,
  skillBundleText?: string,
  discoveryReport?: string,
  interviewContext?: string,
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
    interviewContext ? `Interview answers and decisions:\n${interviewContext}` : undefined,
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

