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
import { runPlanApprovalPhase } from "./plan-approval-phase.js";
import { runPlanningPhase } from "./planning-phase2.js";
import type { PlannerArtifact } from "./planner.js";
import { runDiscoveryPhase, type DiscoveryPhaseResult } from "./discovery-phase.js";
import { setupControllerRun } from "./controller-setup.js";
import { buildCompletedTasks } from "./landing.js";

export async function runFactoryControllerInner(
  input: RunFactoryControllerInput,
  onWorkspaceReady?: (info: { runDir: string; projectRoot: string; createdWorktreePath?: string; baseBranch: string }) => void,
): Promise<RunFactoryControllerResult> {
  const setup = await setupControllerRun(input, onWorkspaceReady);
  if ("runId" in setup) {
    return setup;
  }
  const loaded = setup.loaded;
  const projectRoot = setup.projectRoot;
  const worktree = setup.worktree;
  const executionCwd = setup.executionCwd;
  const run = setup.run;
  const phases = setup.phases;
  const delayMs = setup.delayMs;
  let builderExecutionPaths = setup.builderExecutionPaths;
  let integrationPath = setup.integrationPath;
  let finalMergePath = setup.finalMergePath;
  let candidateSha = setup.candidateSha;
  let repairExecutionPaths = setup.repairExecutionPaths;
  let runTaskType: TaskTypeSelection;
  let discoveryExecutionPath: string | undefined;
  let discoveryOutputText: string | undefined;
  let discoveryFileHints: string[] = [];
  let plannerExecutionPath: string | undefined;
  let plannerOutputText: string | undefined;
  let interviewContext: string | undefined;
  let interviewExecutionPath: string | undefined;
  let interviewDecisions: InterviewDecisionRecord[] = [];
  let discoveryGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  let plannerGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  let builderGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  let repairGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  let reviewerGuidance: Awaited<ReturnType<typeof selectConstitutionContext>>;
  let repoSkillSignals: { constitutionAreas: number[] };
  let workflowStages: WorkflowStage[];
  let discoverySkills: SkillBundleSelection;
  let plannerSkills: SkillBundleSelection;
  let builderSkills: SkillBundleSelection;
  let repairSkills: SkillBundleSelection;
  let reviewerSkills: SkillBundleSelection;
  const discoveryPhase = await runDiscoveryPhase({
    run,
    input,
    loaded,
    projectRoot,
    executionCwd,
  });
  runTaskType = discoveryPhase.runTaskType;
  discoveryExecutionPath = discoveryPhase.discoveryExecutionPath;
  discoveryOutputText = discoveryPhase.discoveryOutputText;
  discoveryFileHints = discoveryPhase.discoveryFileHints;
  plannerExecutionPath = discoveryPhase.plannerExecutionPath;
  plannerOutputText = discoveryPhase.plannerOutputText;
  interviewContext = discoveryPhase.interviewContext;
  interviewExecutionPath = discoveryPhase.interviewExecutionPath;
  interviewDecisions = discoveryPhase.interviewDecisions;
  discoveryGuidance = discoveryPhase.discoveryGuidance;
  plannerGuidance = discoveryPhase.plannerGuidance;
  builderGuidance = discoveryPhase.builderGuidance;
  repairGuidance = discoveryPhase.repairGuidance;
  reviewerGuidance = discoveryPhase.reviewerGuidance;
  repoSkillSignals = discoveryPhase.repoSkillSignals;
  workflowStages = discoveryPhase.workflowStages;
  discoverySkills = discoveryPhase.discoverySkills;
  plannerSkills = discoveryPhase.plannerSkills;
  builderSkills = discoveryPhase.builderSkills;
  repairSkills = discoveryPhase.repairSkills;
  reviewerSkills = discoveryPhase.reviewerSkills;
  let plan: PlannerArtifact;
  let planPath: string;
  let taskPaths: string[];
  const planningPhase = await runPlanningPhase({
    run,
    input,
    loaded,
    executionCwd,
    worktree,
    delayMs,
    runTaskType,
    repoSkillSignals,
    plannerGuidanceText: plannerGuidance.text ?? "",
    plannerSkills,
    discoveryOutputText,
    interviewContext: interviewContext ?? "",
    discoveryFileHints,
    discoveryExecutionPath,
    interviewExecutionPath: interviewExecutionPath ?? "",
  });
  plannerExecutionPath = planningPhase.plannerExecutionPath;
  plannerOutputText = planningPhase.plannerOutputText;
  planPath = planningPhase.planPath;
  taskPaths = planningPhase.taskPaths;
  plan = planningPhase.plan;
  const planApprovalResult = await runPlanApprovalPhase({
    run,
    input,
    loaded,
    executionCwd,
    worktree,
    phases,
    delayMs,
    plan,
    planPath,
    taskPaths,
    discoveryExecutionPath,
    plannerExecutionPath,
    builderExecutionPaths,
    repairExecutionPaths,
    discoveryOutputText,
    integrationPath,
  });
  if (planApprovalResult) {
    return planApprovalResult;
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
  let verificationPlan: VerificationPlan;
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
  verificationPlan = verificationPhase.verificationPlan;
  verificationFailureClassification = verificationPhase.verificationFailureClassification;
  contractResult = verificationPhase.contractResult;
  const completedTasks = buildCompletedTasks(implementationRun.taskWorkspaces, loaded.effectiveConfig.git.baseBranch);
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
    verificationPlan,
    taskType: runTaskType.id,
    verificationFailureClassification,
    contractResult,
    reviewerGuidanceText: reviewerGuidance.text ?? "",
    reviewerSkills,
    interviewDecisions,
    completedTasks,
  });
  return finalResult;
}
