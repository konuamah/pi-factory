import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadEffectiveConfig } from "../config/loader.js";
import { selectConstitutionContext } from "../constitution/context.js";
import { discoverConstitutionRepository } from "../constitution/discovery.js";
import { compileAgentContext, type CompiledContext } from "../context/compiler.js";
import { createGitWorktree, createSiblingGitWorktree, inspectGitIsolation } from "../git/worktree.js";
import { resolveFileReferences, FileResolutionError } from "./file-resolution.js";
import { getFactorySkill, initializeFactorySkills, resolveFactorySkills, type SkillBundleSelection, type SkillCandidate } from "../skills/index.js";
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
import { buildPlanArtifact, extractImplementationContract, type ImplementationContract, type PlannerTask } from "./planner.js";
import type { CapabilityPolicy, EffectiveFactoryConfig, ModelRole, ModelSelection, WorkflowStage } from "@factory/schemas";
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
import { classifyVerificationFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { classifyVerificationFailuresWithAI, type ClassificationSource } from "./ai-failure-classifier.js";
import { normalizeVerificationCommands, planVerificationExecution, runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { hydrateWorkspaceDependencies, buildDependencyCacheEnv, DependencyHydrationError } from "./dependencies.js";
import { sanitizePlannerOutput, validatePlannerOutput, validatePlannerOutputWithLLM } from "./planner-validate.js";
import { buildDiscoveryEvidencePacket, validateDiscoveryOutput, shouldRetryDiscoveryJsonRepair, buildDiscoveryJsonRepairPrompt, normalizeDiscoveryFilePath, type DiscoveryContract, type DiscoveryEvidencePacket } from "./discovery-validate.js";
import { buildCompiledPrompt, buildNoChangeRetryPrompt, buildIntegrationRepairPrompt, buildRepairPrompt, buildEnvironmentPrepPrompt, buildReviewerPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { applyWorkflowSkillPolicy, resolveNodeSkillBundle, summarizeSkillBundle, collectRuntimeSkillSignals, slugifyGoal } from "./skills.js";
import { readGitConflictFiles, hasGitMergeInProgress, resolveTaskWorkspace, commitWorkspaceChanges, readGitHeadSha, type WorkspaceCommitResult } from "./git-ops.js";
import { uniqueStrings, taskWorkspacesChangedFiles, isBuildStage, roleTools, isExecutableWorkflowNode, findBuiltInWorkflowStage } from "./task-utils.js";
import { movePhase, emitProgress, wait, requestHumanDecision, loadConstitutionConflicts, loadRunDecisions } from "./phase-plumbing.js";
import { runImplementationTasks } from "./implementation.js";
import { runIntegrationPhase, classifyIntegrationFailure } from "./integration-phase.js";
import { runFinalMergePhase } from "./final-merge.js";
import { buildContractArtifact, failureSignature, resolveRunTaskTypeWithPaths, gitChangedFiles, filterVerificationByImpact, getChangedFilesFromBase } from "./verification-planning.js";

export interface InterviewDecisionRecord {
  stage: string;
  role: string;
  question: string;
  optionId: string;
  answer?: string;
  decisionRequestId: string;
}

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
  failureClassifierExecutor?: AgentExecutor;
  onProgress?: (event: FactoryRunProgressEvent) => Promise<void> | void;
  requestPlanApproval?: (input: { runId: string; goal: string; planPath: string; taskCount: number; workflowStages: string[]; summary: string; discoveryText?: string; planText?: string; tasks: PlannerTask[] }) => Promise<PlanApprovalResult>;
  requestApproval?: (input: { runId: string; goal: string; candidateSha?: string; baselineDebt?: Array<{ commandName: string; category: string; reason: string; suggestedAction: string; implicatedFiles?: string[] }>; contractComplete: boolean; verificationStatus?: string }) => Promise<boolean>;
  requestDependencyRemediation?: (candidate: import("./dependencies.js").DependencyHydrationRemediationCandidate) => Promise<boolean>;
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

import { runFactoryControllerInner } from "./controller-run.js";

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

export interface TaskWorkspaceSelection {
  taskId: string;
  path: string;
  mode: "existing" | "created" | "in-place";
  branch?: string;
  shouldIntegrate: boolean;
  changedFiles?: string[];
}

export function resolveNodeRole(task: PlannerTask): ModelRole {
  const role = task.role as ModelRole | undefined;
  if (role === "discovery" || role === "planner" || role === "reviewer" || role === "repair" || role === "builder") {
    return role;
  }
  return "builder";
}

export function attachDiscoveryFileHintsToBuildTasks(tasks: PlannerTask[], fileHints: string[]): void {
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

export function normalizeDiscoveryFileHints(fileHints: string[]): string[] {
  return uniqueStrings(
    fileHints
      .map(normalizeDiscoveryFilePath)
      .filter((file): file is string => Boolean(file)),
  );
}
