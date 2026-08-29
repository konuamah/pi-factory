// Helper functions for the run controller — extracted from controller-run.ts
// so the phase machine stays focused on orchestration.

import { appendFactoryRunEvent, updateFactoryRunState } from "../runs/store.js";
import { appendRepoLearning } from "../learnings/store.js";
import { resolveModelForRole } from "../models/index.js";
import { gatherVerificationRequirements, initializeVerificationProviders, runVerificationEngine } from "../verification/index.js";
import { runVerificationCommands, type VerificationPlan, type VerificationRunResult } from "./verification.js";
import { classifyVerificationFailure, type VerificationFailureClassification } from "./failure-classification.js";
import { classifyVerificationFailuresWithAI, type ClassificationSource } from "./ai-failure-classifier.js";
import { buildRepairPrompt, buildEnvironmentPrepPrompt, renderSkillBundleForPrompt } from "./prompts.js";
import { gitChangedFiles } from "./verification-planning.js";
import { uniqueStrings } from "./task-utils.js";
import { writePrototypeRepairExecutionArtifact, writePrototypeVerificationArtifact, writePrototypeReviewerExecutionArtifact } from "./artifacts.js";
import { buildContractArtifact, failureSignature } from "./verification-planning.js";
import { emitProgress, requestHumanDecision } from "./phase-plumbing.js";
import { movePhase } from "./phase-plumbing.js";
import { wait } from "./phase-plumbing.js";
import { resolveFactorySkills } from "../skills/index.js";
import { applyWorkflowSkillPolicy } from "./skills.js";
import { slugifyGoal } from "./skills.js";
import { appendModelLedgerEntry } from "../runs/model-ledger.js";
import type { RunFactoryControllerInput, RunFactoryControllerResult, InterviewDecisionRecord } from "./controller.js";
import type { AgentExecutor } from "./interfaces.js";
import type { EffectiveFactoryConfig, ModelSelection, WorkflowStage } from "@factory/schemas";
import type { VerificationContractPlan, VerificationEngineResult } from "../verification/index.js";
import type { ReviewProviderOptions } from "../verification/providers/review.js";
import type { SkillBundleSelection } from "../skills/index.js";
import type { TaskTypeSelection } from "../models/index.js";
import { createFactoryRun } from "../runs/store.js";
import path from "node:path";
import fs from "node:fs/promises";
import type { ModelRole } from "@factory/schemas";
import type { DiscoveryEvidencePacket } from "./discovery-validate.js";

export interface VerificationRepairLoopContext {
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

export interface EnvironmentPreparationContext {
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

export interface RunFailureResultContext {
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
